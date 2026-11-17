/**
 * Fleet page controller: loads a scenario config, owns the Simulation, drives the
 * animation loop and wires the controls. All simulation logic lives in js/sim/.
 */

import { loadScenario } from '../sim/config/scenarioLoader.js';
import { Simulation } from '../sim/simulation.js';
import { toJSON, toCSV } from '../sim/metrics.js';
import { fmtClock } from '../sim/fleet/eta.js';
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
    await rebuild();
  } catch (err) {
    fail(err);
  }
}

async function loadConfigFromText(text, name) {
  try {
    state.config = JSON.parse(text);
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
  const overrides = {
    noEvents: !$('optEvents').checked,
    noRandomEvents: !$('optRandom').checked,
  };
  const n = Number(truckSel.value);
  if (n < total) overrides.truckCount = n;

  const world = await loadScenario(cfg, { readText, overrides });
  state.sim = new Simulation(world);
  state.recorded = false;
  state.carry = 0;
  map.setSimulation(state.sim);
  renderLegend($('fleetLegend'), state.sim);
  $('scenarioInfo').textContent =
    `${world.name}: ${world.graph.nodeCount} nodes, ${world.graph.edgeCount} roads, ${world.trucks.length} trucks, ` +
    `${world.bins.length} bins, ${world.events.length} events. ${world.description}`;
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
  $('btnPlay').innerHTML = '&#10074;&#10074; Pause';
  setStatus('Running', 'running');
}

function pause() {
  state.playing = false;
  $('btnPlay').innerHTML = '&#9654; Play';
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
for (const id of ['optEvents', 'optRandom', 'optTrucks']) {
  $(id).addEventListener('change', () => state.config && rebuild().catch(fail));
}
$('logFilter').addEventListener('change', () => state.sim && refreshPanels());

$('scenarioLoad').addEventListener('click', () => loadConfigFromPath($('scenarioPath').value.trim()));
$('scenarioPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('scenarioLoad').click(); });
$('scenarioFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) loadConfigFromText(await file.text(), file.name);
});

const optionIds = { optPaths: 'paths', optEtaLabels: 'etaLabels', optBinLabels: 'binLabels', optNodeIds: 'nodeIds' };
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
