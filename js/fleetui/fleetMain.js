/**
 * Fleet page controller: loads a scenario config, owns the Simulation, drives the
 * animation loop and wires the controls. All simulation logic lives in js/sim/.
 */

import { loadScenario, randomRoadEvent } from '../sim/config/scenarioLoader.js';
import { Simulation } from '../sim/simulation.js';
import { toJSON, toCSV } from '../sim/metrics.js';
import { fmtClock } from '../sim/fleet/eta.js';
import { mulberry32 } from '../core/rng.js';
import { FleetMapView } from './mapView.js';
import {
  renderTruckList, renderLog, renderMetrics, renderTruckTable,
  renderEventTable, renderRunsTable, renderLegend,
} from './panels.js';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,      // parsed JSON
  sim: null,
  playing: false,
  speed: 30,         // simulated seconds per real second
  carry: 0,          // fractional simulated seconds not yet stepped
  runs: [],          // summaries of finished runs (comparison table / CSV)
  recorded: false,   // current run already added to `runs`
  freshConfig: false, // a new config was just loaded → reset variant controls to its defaults
  eventSeed: undefined, // set by "Re-roll"; undefined = the config's own random-event seed
  liveRng: null,     // RNG for "Random event now" (seeded per run → reproducible order)
};

const map = new FleetMapView($('fleetCanvas'));

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
  const cfg = state.config;
  const truckSel = $('optTrucks');
  const total = (cfg.trucks || []).length;
  if (truckSel.options.length !== total) {
    truckSel.innerHTML = Array.from({ length: total }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
    truckSel.value = String(total);
  }
  if (state.freshConfig) {
    // New scenario: take its own random-event count, and keep crowded maps readable.
    state.freshConfig = false;
    state.eventSeed = undefined;
    $('optRandomCount').value = String(cfg.events?.random?.count ?? 0);
    const fromSchedule = Boolean(cfg.bins?.csv);
    const many = total > 6 || fromSchedule || (Array.isArray(cfg.bins) ? cfg.bins.length : cfg.bins?.random?.count ?? 0) > 40;
    $('optEtaLabels').checked = map.options.etaLabels = !many;
    $('optBinLabels').checked = map.options.binLabels = !many;
    // "Schedule day" only applies to stops imported from the collection schedule CSV.
    $('optDayWrap').hidden = !fromSchedule;
    $('optDay').value = cfg.bins?.day ? String(cfg.bins.day).toLowerCase().slice(0, 3) : 'all';
  }
  const overrides = {
    noEvents: !$('optEvents').checked,
    noRandomEvents: !$('optRandom').checked,
  };
  if (cfg.bins?.csv) overrides.binDay = $('optDay').value;
  const n = Number(truckSel.value);
  if (n < total) overrides.truckCount = n;
  const count = Number($('optRandomCount').value);
  if (Number.isInteger(count) && count >= 0 && count !== (cfg.events?.random?.count ?? 0)) overrides.randomEventCount = count;
  if (state.eventSeed !== undefined) overrides.eventSeed = state.eventSeed;

  const world = await loadScenario(cfg, { readText, overrides });
  state.sim = new Simulation(world);
  state.recorded = false;
  state.carry = 0;
  state.liveRng = mulberry32(((state.eventSeed ?? world.seed) + 101) >>> 0);
  const randomOn = $('optEvents').checked && $('optRandom').checked;
  $('eventSeedInfo').textContent = randomOn
    ? `Random-event seed: ${state.eventSeed ?? cfg.events?.random?.seed ?? 'scenario default'}` +
      `${state.eventSeed !== undefined ? ' (re-rolled)' : ''} — the same seed always gives the same events.`
    : 'Random events are off.';
  map.setSimulation(state.sim);
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
  setStatus('Ready — press Play');

  // fleet.html?at=850 opens the run already advanced to t = 850 s (handy for sharing a moment).
  const at = Number(new URLSearchParams(location.search).get('at'));
  if (at > 0) {
    while (state.sim.time < at && !state.sim.finished) state.sim.step();
    if (state.sim.finished) onFinished();
    else setStatus(`Jumped to ${fmtClock(state.sim.time)} — press Play`);
  }
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

  if (sim && state.playing && !sim.finished) {
    state.carry += dtReal * state.speed;
    const dt = sim.world.settings.dt_s;
    while (state.carry >= dt && !sim.finished) {
      sim.step(dt);
      state.carry -= dt;
    }
    if (sim.finished) onFinished();
  }

  if (sim) {
    map.render();
    $('simClock').textContent = fmtClock(sim.time);
    if (ts - lastPanel > 250) { refreshPanels(); lastPanel = ts; }
  }
  requestAnimationFrame(frame);
}

function refreshPanels(full = false) {
  const sim = state.sim;
  renderTruckList($('truckList'), sim);
  renderLog($('logList'), sim.logEntries, $('logFilter').value);
  renderMetrics($('metricsTable'), sim.summary());
  renderTruckTable($('truckTable'), sim);
  renderEventTable($('eventTable'), sim);
  if (full) renderRunsTable($('runsCompareTable'), state.runs);
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
  refreshPanels(true);
}

// ------------------------------------------------------------------ controls

function play() {
  if (!state.sim || state.sim.finished) return;
  state.playing = true;
  $('btnPlay').innerHTML = $('btnPlay2').innerHTML = '&#10074;&#10074; Pause';
  setStatus('Running', 'running');
}

function pause() {
  state.playing = false;
  $('btnPlay').innerHTML = $('btnPlay2').innerHTML = '&#9654; Play';
  if (state.sim && !state.sim.finished) setStatus('Paused');
}

function setStatus(text, kind = '') {
  const el = $('fleetStatus');
  el.textContent = text;
  el.className = `pill ${kind}`;
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
  for (let i = 0; i < 10 && !state.sim.finished; i++) state.sim.step();
  if (state.sim.finished) onFinished();
  refreshPanels();
});
$('btnReset').addEventListener('click', () => state.config && rebuild().catch(fail));
$('btnRunToEnd').addEventListener('click', () => {
  if (!state.sim) return;
  state.sim.run();
  onFinished();
});
$('optSpeed').addEventListener('change', (e) => { state.speed = Number(e.target.value); });
for (const id of ['optDay', 'optEvents', 'optRandom', 'optTrucks', 'optRandomCount']) {
  $(id).addEventListener('change', () => state.config && rebuild().catch(fail));
}
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
  refreshPanels();
}

function setPicking(on) {
  map.setPickMode(on);
  $('btnPick').setAttribute('aria-pressed', String(on));
  $('btnPick').innerHTML = on ? '&#10003; Picking — click roads (Esc to stop)' : '&#128433; Click a road';
  if (on) liveMessage('Click any road on the map. Drag still pans.');
}

map.onRoadPick = placeLiveEvent;
$('liveType').addEventListener('change', syncLiveInputs);
$('btnPick').addEventListener('click', () => setPicking(!map.pickMode));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && map.pickMode) setPicking(false); });

$('btnRandomNow').addEventListener('click', () => {
  const sim = state.sim;
  if (!sim || sim.finished) { liveMessage('The run has finished — press Reset to start a new one.', 'err'); return; }
  const settings = state.config.events?.random || {};
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
  refreshPanels();
});

$('btnFullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('stage').requestFullscreen?.().catch((err) => liveMessage(`Full screen not available: ${err.message}`, 'err'));
});
document.addEventListener('fullscreenchange', () => {
  $('btnFullscreen').innerHTML = document.fullscreenElement ? '&#x2715; Exit full screen' : '&#x26F6; Full screen';
  map.render();
});
syncLiveInputs();
$('logFilter').addEventListener('change', () => state.sim && refreshPanels());

$('scenarioLoad').addEventListener('click', () => loadConfigFromPath($('scenarioPath').value.trim()));
$('scenarioPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('scenarioLoad').click(); });
$('scenarioFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) loadConfigFromText(await file.text(), file.name);
});

const optionIds = { optBasemap: 'basemap', optPaths: 'paths', optEtaLabels: 'etaLabels', optBinLabels: 'binLabels', optNodeIds: 'nodeIds' };
for (const [id, key] of Object.entries(optionIds)) {
  $(id).addEventListener('change', (e) => { map.options[key] = e.target.checked; map.render(); });
}
$('mapReset').addEventListener('click', () => map.resetView());

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
