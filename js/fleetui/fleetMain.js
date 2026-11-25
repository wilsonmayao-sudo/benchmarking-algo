/**
 * Fleet page controller: loads a scenario config, owns the Simulation, drives the
 * animation loop and wires the controls. All simulation logic lives in js/sim/.
 */

import { loadScenario, applyScenarioType, randomRoadEvent } from '../sim/config/scenarioLoader.js';
import { Simulation } from '../sim/simulation.js';
import { toJSON, toCSV } from '../sim/metrics.js';
import { fmtClock } from '../sim/fleet/eta.js';
import { mulberry32 } from '../core/rng.js';
import { FleetMapView } from './mapView.js';
import { FleetEditor } from './editor.js';
import { AreaPanel } from './areaPanel.js';
import {
  renderTruckList, renderLog, renderMetrics, renderTruckTable,
  renderEventTable, renderRunsTable, renderLegend,
} from './panels.js';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,      // parsed JSON
  effectiveConfig: null, // config after scenario-type & seed generation
  sim: null,
  playing: false,
  speed: 30,         // simulated seconds per real second
  carry: 0,          // fractional simulated seconds not yet stepped
  runs: [],          // summaries of finished runs (comparison table / CSV)
  recorded: false,   // current run already added to `runs`
  freshConfig: false, // a new config was just loaded → reset variant controls to its defaults
  syncGeneratorCount: false, // adopt generated random-event count after preset/seed switch
  eventSeed: undefined, // set by "Re-roll"; undefined = the config's own random-event seed
  liveRng: null,     // RNG for "Random event now" (seeded per run → reproducible order)
  initialJumpDone: false,
};

const map = new FleetMapView($('fleetCanvas'));

// Testing areas: zoom to one, show only its fleet.
const areas = new AreaPanel(map, {
  rebuild: () => rebuild().catch(fail),
  onChange: () => { if (state.sim) refreshPanels(); },
  setMode: (mode) => {
    if (mode !== 'none') { editor.host.onModeStart(); editor.closePanel(); }
    editor.setMode(mode);
  },
  readText,
});

// Bins, routes and trip details.
const editor = new FleetEditor(map, {
  rebuild: () => rebuild(),
  onChange: () => refreshPanels(),
  onModeStart: () => { if (map.pickMode) setPicking(false); }, // one map tool at a time
  isPlaying: () => state.playing,
  binFilter: (world) => areas.binFilter(world),
  onMode: (mode) => areas.modeChanged(mode),
  onZoneDrawn: (poly) => areas.addDrawn(poly),
});

// ------------------------------------------------------------------ loading

async function readText(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.text();
}

async function loadConfigFromPath(path) {
  try {
    setStatus('Loading…');
    state.config = JSON.parse(await readText(path));
    state.freshConfig = true;
    await rebuild();
  } catch (err) {
    fail(err);
  }
}

async function loadConfigFromText(text, name) {
  try {
    state.config = JSON.parse(text);
    state.freshConfig = true;
    $('scenarioPath').value = name;
    await rebuild();
  } catch (err) {
    fail(err);
  }
}

/** (Re)create the world + simulation from the config and the variant controls. */
async function rebuild() {
  pause();
  const baseCfg = state.config;
  const truckSel = $('optTrucks');
  const total = (baseCfg.trucks || []).length;
  if (truckSel.options.length !== total) {
    truckSel.innerHTML = Array.from({ length: total }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
    truckSel.value = String(total);
  }
  if (state.freshConfig) {
    state.eventSeed = undefined;
    const keepConfigured = Boolean(baseCfg.bins?.csv || baseCfg.map?.type === 'explicit');
    $('optScenarioType').value = keepConfigured ? 'configured' : 'normal';
    $('optSeed').value = String(baseCfg.seed ?? 20260913);
  }

  const scenarioType = $('optScenarioType').value;
  const rawSeed = Math.round(Number($('optSeed').value));
  const seedVal = Number.isFinite(rawSeed) && rawSeed >= 1
    ? Math.min(99999999, rawSeed)
    : (Number(baseCfg.seed) >= 1 ? Math.round(Number(baseCfg.seed)) : 20260913);
  $('optSeed').value = String(seedVal);

  const cfg = applyScenarioType(baseCfg, scenarioType, seedVal);
  const routingMode = $('optRoutingMode').value;
  cfg.settings = cfg.settings || {};
  if (routingMode === 'static_given') {
    cfg.settings.heuristic = 'euclidean';
    cfg.settings.cost_mode = 'distance';
    cfg.settings.routing_engine = 'legacy';
    cfg.settings.visit_order = 'given';
    cfg.settings.weight_factor = 1.0;
  } else if (routingMode === 'proposed_alt') {
    cfg.settings.heuristic = 'alt';
    cfg.settings.cost_mode = 'time';
    cfg.settings.routing_engine = 'fast';
    cfg.settings.visit_order = 'road2opt';
    cfg.settings.weight_factor = 1.0;
    cfg.settings.cache_paths = true;
  } else if (routingMode === 'proposed_w105') {
    cfg.settings.heuristic = 'alt';
    cfg.settings.cost_mode = 'time';
    cfg.settings.routing_engine = 'fast';
    cfg.settings.visit_order = 'road2opt';
    cfg.settings.weight_factor = 1.05;
    cfg.settings.cache_paths = true;
  }
  state.effectiveConfig = cfg;

  const fromSchedule = Boolean(cfg.bins?.csv);
  if (state.freshConfig || state.syncGeneratorCount) {
    $('optRandomCount').value = String(cfg.events?.random?.count ?? 0);
    $('optDayWrap').hidden = !fromSchedule;
    $('optDay').value = cfg.bins?.day ? String(cfg.bins.day).toLowerCase().slice(0, 3) : 'all';
    if (state.freshConfig) {
      const many = total > 6 || fromSchedule || (Array.isArray(cfg.bins) ? cfg.bins.length : cfg.bins?.random?.count ?? 0) > 40;
      $('optEtaLabels').checked = map.options.etaLabels = !many;
      $('optBinLabels').checked = map.options.binLabels = !many;
    }
    state.freshConfig = false;
    state.syncGeneratorCount = false;
  }

  const overrides = {
    noEvents: !$('optEvents').checked,
    noRandomEvents: !$('optRandom').checked,
  };
  if (scenarioType !== 'configured') {
    overrides.scenarioType = scenarioType;
    overrides.seed = seedVal;
  } else if (seedVal !== (baseCfg.seed ?? 20260913)) {
    overrides.seed = seedVal;
  }
  if (fromSchedule) overrides.binDay = $('optDay').value;
  const n = Number(truckSel.value);
  if (n < total) overrides.truckCount = n;
  const rawCount = Math.round(Number($('optRandomCount').value));
  const count = Number.isFinite(rawCount) ? Math.max(0, Math.min(200, rawCount)) : 0;
  $('optRandomCount').value = String(count);
  if (count !== (cfg.events?.random?.count ?? 0)) overrides.randomEventCount = count;
  if (state.eventSeed !== undefined) overrides.eventSeed = state.eventSeed;

  const world = await loadScenario(cfg, { readText, overrides });
  await areas.prepare(cfg, world);
  editor.limitBins(world); // only the bins shown on the map take part
  state.sim = new Simulation(world);
  state.recorded = false;
  state.carry = 0;
  state.liveRng = mulberry32(((state.eventSeed ?? world.seed) + 101) >>> 0);
  const randomOn = $('optEvents').checked && $('optRandom').checked;
  $('eventSeedInfo').textContent = randomOn
    ? `Seed ${state.eventSeed ?? cfg.events?.random?.seed ?? 'default'}` +
      `${state.eventSeed !== undefined ? ' (re-rolled)' : ''} (same seed reproduces identical events).`
    : 'Random events are off.';
  const sameMap = map.setSimulation(state.sim);
  editor.attach(state.sim); // puts saved bins and routes back
  if (!sameMap) map.resetView(); // frame the bins and routes that were just put back, too
  areas.attach(state.sim);
  renderLegend($('fleetLegend'), state.sim);
  const imp = world.binImport;
  const importLine = imp
    ? ` Schedule import (${imp.file}): ${imp.used} stops placed${imp.filters.day ? ` for ${imp.filters.day}` : ''}, ` +
      `${imp.assignedByArea || 0} given to their area's truck; skipped ${imp.skipped.outsideRoadMap} outside the road map ` +
      `(> ${imp.maxSnapM} m from a mapped road), ${imp.skipped.day} not scheduled that day, ` +
      `${Object.values(imp.skipped.stopType).reduce((s, n) => s + n, 0)} non-collection rows ` +
      `(${Object.entries(imp.skipped.stopType).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'}).`
    : '';
  $('scenarioInfo').textContent =
    `${world.name}: ${world.graph.nodeCount} nodes, ${world.graph.edgeCount} roads, ${world.trucks.length} trucks, ` +
    `${world.bins.length} bins, ${world.events.length} events.${importLine} ${world.description}`;
  $('btnExportJson').disabled = false;
  setStatus('Ready');

  // fleet.html?at=850 opens the run already advanced to t = 850 s (handy for sharing a moment).
  if (!state.initialJumpDone) {
    state.initialJumpDone = true;
    const at = Number(new URLSearchParams(location.search).get('at'));
    if (at > 0) {
      while (state.sim.time < at && !state.sim.finished) state.sim.step();
      if (state.sim.finished) onFinished();
      else setStatus(`Jumped to ${fmtClock(state.sim.time)} — press Play`);
    }
  }
  map.render();
  $('simClock').textContent = fmtClock(state.sim.time);
  refreshPanels(true);
}

function fail(err) {
  console.error(err);
  setStatus('Config error', 'error');
  $('scenarioInfo').textContent = err.message;
}

// ------------------------------------------------------------------ loop

let lastFrame = 0;
let lastPanel = 0;

function frame(ts) {
  const dtReal = lastFrame ? Math.min(0.25, (ts - lastFrame) / 1000) : 0;
  lastFrame = ts;
  const sim = state.sim;
  let stepped = false;

  if (sim && state.playing && !sim.finished) {
    state.carry += dtReal * state.speed;
    const dt = sim.world.settings.dt_s;
    while (state.carry >= dt && !sim.finished) {
      sim.step(dt);
      state.carry -= dt;
      stepped = true;
    }
    if (sim.finished) onFinished();
  }

  if (sim) {
    if (stepped || map.fly || map.glide) {
      map.render();
      $('simClock').textContent = fmtClock(sim.time);
    }
    if (stepped && ts - lastPanel > 250) { refreshPanels(); lastPanel = ts; }
  }
  requestAnimationFrame(frame);
}

function refreshPanels(full = false) {
  const sim = state.sim;
  areas.refresh();
  renderTruckList($('truckList'), sim, map.focus);
  renderLog($('logList'), sim.logEntries, $('logFilter').value, areas.logFilter());
  renderMetrics($('metricsTable'), sim.summary(), state.playing, sim);
  renderTruckTable($('truckTable'), sim);
  editor.refresh();
  renderEventTable($('eventTable'), sim);
  syncOpControls(sim);
  if (full) renderRunsTable($('runsCompareTable'), state.runs);
}

function syncOpControls(sim) {
  const sel = $('optOpTruck');
  if (sel && sel.options.length !== sim.trucks.length) {
    sel.innerHTML = sim.trucks.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
  }
  if ($('btnToggleOffline')) {
    $('btnToggleOffline').textContent = sim.road.offline ? 'Reconnect' : 'Go offline';
  }
  const tid = sel?.value;
  const truck = sim.trucks.find((t) => t.id === tid) || sim.trucks[0];
  if ($('opSimInfo') && truck) {
    $('opSimInfo').textContent = `${truck.name}: ${truck.reportedCapacityPct}% reported · status=${truck.status}` +
      `${sim.road.offline ? ' · Offline (no live traffic)' : ''}` +
      `${sim.offlineSyncQueue.length ? ` · ${sim.offlineSyncQueue.length} queued` : ''}`;
  }
}

function onFinished() {
  pause();
  const sim = state.sim;
  setStatus(`Finished — ${sim.finishReason}`, 'done');
  if (!state.recorded) {
    state.runs.push(sim.summary());
    state.recorded = true;
    $('btnExportCsv').disabled = false;
  }
  map.render();
  $('simClock').textContent = fmtClock(sim.time);
  refreshPanels(true);
}

// ------------------------------------------------------------------ controls

function play() {
  if (!state.sim || state.sim.finished) return;
  state.playing = true;
  $('btnPlay').textContent = $('btnPlay2').textContent = 'Pause';
  setStatus('Running', 'running');
  refreshPanels();
}

function pause() {
  const wasPlaying = state.playing;
  state.playing = false;
  $('btnPlay').textContent = $('btnPlay2').textContent = 'Play';
  if (state.sim && !state.sim.finished) setStatus('Paused');
  if (wasPlaying && state.sim && !state.sim.finished) refreshPanels();
}

function setStatus(text, kind = '') {
  const el = $('fleetStatus');
  el.textContent = text;
  el.className = `pill ${kind}`.trim();
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('btnPlay').addEventListener('click', () => (state.playing ? pause() : play()));
$('btnPlay2').addEventListener('click', () => (state.playing ? pause() : play()));
$('btnStep').addEventListener('click', () => {
  if (!state.sim || state.sim.finished) return;
  pause();
  const end = state.sim.time + 10;
  while (state.sim.time < end - 1e-9 && !state.sim.finished) state.sim.step();
  map.render();
  $('simClock').textContent = fmtClock(state.sim.time);
  if (state.sim.finished) onFinished();
  else refreshPanels();
});
$('btnReset').addEventListener('click', () => state.config && rebuild().catch(fail));
$('btnRunToEnd').addEventListener('click', () => {
  if (!state.sim) return;
  state.sim.run();
  onFinished();
});
$('optSpeed').addEventListener('change', (e) => { state.speed = Number(e.target.value); });
for (const id of ['optDay', 'optEvents', 'optRandom', 'optTrucks', 'optRandomCount', 'optRoutingMode']) {
  $(id).addEventListener('change', () => state.config && rebuild().catch(fail));
}

function activeOpTruck() {
  const sim = state.sim;
  if (!sim || sim.finished) return null;
  const id = $('optOpTruck')?.value;
  return sim.trucks.find((t) => t.id === id) || sim.trucks[0] || null;
}

for (const [id, pct] of [['btnCap25', 25], ['btnCap50', 50], ['btnCap75', 75], ['btnCap100', 100]]) {
  $(id).addEventListener('click', () => {
    const t = activeOpTruck();
    if (!t) return;
    state.sim.world.settings.operational_mode = true;
    state.sim.injectOperationalEvent({ type: 'MANUAL_CAPACITY_REPORT', truckId: t.id, percent: pct });
    map.render();
    refreshPanels();
  });
}

$('btnConfirmUnload').addEventListener('click', () => {
  const t = activeOpTruck();
  if (!t) return;
  state.sim.injectOperationalEvent({ type: 'UNLOAD_CONFIRMED', truckId: t.id });
  map.render();
  refreshPanels();
});

$('btnSimDeviation').addEventListener('click', () => {
  const t = activeOpTruck();
  if (!t) return;
  state.sim.injectOperationalEvent({
    type: 'GPS_DEVIATION',
    truckId: t.id,
    gpsAccuracyM: 12,
    offsetM: 85,
    consecutiveReadings: 3,
  });
  map.render();
  refreshPanels();
});

$('btnToggleOffline').addEventListener('click', () => {
  if (!state.sim || state.sim.finished) return;
  state.sim.injectOperationalEvent({ type: state.sim.road.offline ? 'NETWORK_RECONNECT' : 'NETWORK_DISCONNECT' });
  map.render();
  refreshPanels();
});
for (const id of ['optScenarioType', 'optSeed']) {
  $(id).addEventListener('change', () => {
    if (!state.config) return;
    state.syncGeneratorCount = true;
    state.eventSeed = undefined;
    rebuild().catch(fail);
  });
}
$('btnSeedReroll').addEventListener('click', () => {
  if (!state.config) return;
  $('optSeed').value = String(Math.floor(Math.random() * 89999999) + 10000000);
  state.syncGeneratorCount = true;
  state.eventSeed = undefined;
  rebuild().catch(fail);
});
$('btnReroll').addEventListener('click', () => {
  if (!state.config) return;
  // A fresh seed moves every random event to new roads and times; the seed is shown so a
  // run you like can be reproduced.
  state.eventSeed = Math.floor(Math.random() * 1e9);
  if (!$('optEvents').checked) $('optEvents').checked = true;
  if (!$('optRandom').checked) $('optRandom').checked = true;
  if (Number($('optRandomCount').value) === 0) $('optRandomCount').value = '10';
  rebuild().catch(fail);
});

// ------------------------------------------------------------------ live events

function liveMessage(text, kind = '') {
  const el = $('liveInfo');
  el.textContent = text;
  el.className = `hint ${kind}`;
}

function syncLiveInputs() {
  const type = $('liveType').value;
  $('liveFactorWrap').hidden = type !== 'TRAFFIC_DELAY';
  $('liveDurationWrap').hidden = type === 'CLEAR';
}

/** Place the event chosen in the live bar on road `edge`, at the current simulated time. */
function placeLiveEvent(edge) {
  const sim = state.sim;
  if (!sim || sim.finished) { liveMessage('The run has finished — press Reset to start a new one.', 'err'); return; }
  const type = $('liveType').value;
  const name = sim.world.edgeLabel(edge);

  if (type === 'CLEAR') {
    const applied = sim.clearRoad(edge);
    liveMessage(applied ? `${fmtClock(sim.time)} cleared ${name}` : `${name} is already open with no delay`, applied ? 'ok' : '');
  } else {
    const minutes = Math.max(0, Number($('liveDuration').value) || 0);
    const ev = { type, edge, duration: Math.round(minutes * 60), note: 'added from the map' };
    if (type === 'TRAFFIC_DELAY') {
      ev.factor = Number($('liveFactor').value);
      if (!(ev.factor > 1)) { liveMessage('Delay factor must be above 1 (e.g. 2.5 = 2.5× slower).', 'err'); return; }
    }
    const entry = sim.injectEvent(ev);
    if (!entry) { liveMessage('Could not add that event.', 'err'); return; }
    const who = entry.rerouted.length ? ` · rerouted ${entry.rerouted.join(', ')}` : ' · no truck affected';
    const blocked = entry.blocked.length ? ` · BLOCKED ${entry.blocked.join(', ')}` : '';
    liveMessage(`${fmtClock(sim.time)} ${type === 'ROAD_CLOSURE' ? 'closed' : 'slowed'} ${name}${who}${blocked}`, blocked ? 'err' : 'ok');
  }
  map.render();
  refreshPanels();
}

function setPicking(on) {
  if (on && map.editMode !== 'none') editor.setMode('none');
  map.setPickMode(on);
  $('btnPick').setAttribute('aria-pressed', String(on));
  $('btnPick').textContent = on ? 'Picking (Esc to stop)' : 'Pick road';
  if (on) liveMessage('Click any road on the map. Drag still pans.');
}

map.onRoadPick = placeLiveEvent;
$('liveType').addEventListener('change', syncLiveInputs);
$('btnPick').addEventListener('click', () => setPicking(!map.pickMode));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && map.pickMode) setPicking(false); });

$('btnRandomNow').addEventListener('click', () => {
  const sim = state.sim;
  if (!sim || sim.finished) { liveMessage('The run has finished — press Reset to start a new one.', 'err'); return; }
  const settings = (state.effectiveConfig || state.config).events?.random || {};
  // Prefer a road that is currently normal, so the event visibly changes something.
  let ev = null;
  for (let tries = 0; tries < 20; tries++) {
    ev = randomRoadEvent(state.liveRng, sim.graph, settings, sim.time);
    if (!sim.road.isClosed(ev.edge) && sim.road.multiplier[ev.edge] === 1) break;
  }
  const entry = sim.injectEvent({ ...ev, source: 'random (live)', note: 'random, added while running' });
  if (!entry) { liveMessage('Could not add a random event.', 'err'); return; }
  const what = ev.type === 'ROAD_CLOSURE'
    ? `closed ${entry.edge} for ${Math.round(ev.duration / 60)} min`
    : `slowed ${entry.edge} ×${ev.factor} for ${Math.round(ev.duration / 60)} min`;
  liveMessage(`${fmtClock(sim.time)} random: ${what}${entry.rerouted.length ? ` · rerouted ${entry.rerouted.join(', ')}` : ''}`, 'ok');
  map.render();
  refreshPanels();
});

$('btnFullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('stage').requestFullscreen?.().catch((err) => liveMessage(`Full screen not available: ${err.message}`, 'err'));
});
document.addEventListener('fullscreenchange', () => {
  $('btnFullscreen').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
  map.render();
});
syncLiveInputs();
$('logFilter').addEventListener('change', () => state.sim && refreshPanels());

$('scenarioLoad').addEventListener('click', () => loadConfigFromPath($('scenarioPath').value.trim()));
$('scenarioPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('scenarioLoad').click(); });
$('scenarioFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) loadConfigFromText(await file.text(), file.name);
});

const optionIds = { optBasemap: 'basemap', optPaths: 'paths', optEtaLabels: 'etaLabels', optBinLabels: 'binLabels', optNodeIds: 'nodeIds' };
for (const [id, key] of Object.entries(optionIds)) {
  $(id).addEventListener('change', (e) => { map.options[key] = e.target.checked; map.render(); });
}
$('mapReset').addEventListener('click', () => map.home());

$('btnExportJson').addEventListener('click', () => {
  const sim = state.sim;
  const slug = sim.world.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  download(`${slug}__${sim.world.variant.replace(/[^a-z0-9]+/gi, '-')}.json`, JSON.stringify(toJSON(sim), null, 2), 'application/json');
});
$('btnExportCsv').addEventListener('click', () => download('fleet-runs.csv', toCSV(state.runs), 'text/csv'));

// ------------------------------------------------------------------ start
renderRunsTable($('runsCompareTable'), state.runs);
loadConfigFromPath($('scenarioPath').value);
requestAnimationFrame(frame);
