/**
 * Application controller.
 *
 * Owns the state, registers the algorithms and connects the UI modules together.
 * Adding a new algorithm later is exactly two lines here:
 *     import { myAlgorithm } from './algorithms/myAlgorithm.js';
 *     registerAlgorithm(myAlgorithm);
 */

import { SCENARIOS, CUSTOM_SCENARIO_DEFAULTS, scenarioFromCustom, scenarioFromCityMap } from './data/scenarios.js';
import { buildTestCase, applyWeights } from './data/testCaseBuilder.js';
import { parseCityMap } from './data/cityMapLoader.js';
import { DEFAULT_WEIGHTS } from './core/costModel.js';
import { registerAlgorithm, getAlgorithms, getTunableGroups } from './algorithms/registry.js';
import { astar } from './algorithms/astar.js';
import { customAlgorithm } from './algorithms/customAlgorithm.js';
import { runBenchmark } from './benchmark/runner.js';
import { runRouteBenchmark } from './benchmark/routeRunner.js';
import { initControls } from './ui/controls.js';
import { NetworkView } from './ui/networkView.js';
import { Playback } from './ui/playback.js';
import {
  renderVerdict,
  renderResultsTable,
  renderComparisonTable,
  renderRunsTable,
  renderLegend,
  updateBadges,
} from './ui/resultsView.js';
import { fmtInt, fmtMeters, fmtNum } from './core/format.js';

// ===========================================================================
//  Algorithm registration — custom FIRST so it is the left-hand column everywhere
// ===========================================================================
registerAlgorithm(customAlgorithm);
registerAlgorithm(astar);

const ALGORITHMS = getAlgorithms();
const ALL_IDS = ALGORITHMS.map((algorithm) => algorithm.id);
const CUSTOM_ID = customAlgorithm.id;
const BASELINE_ID = astar.id;

/**
 * Live values of every algorithm's declared tunables, keyed by algorithm id. These are
 * forwarded to prepare()/solve(), so an algorithm can expose its own knobs without the
 * harness knowing anything about them.
 */
const tunableValues = new Map();
for (const group of getTunableGroups()) {
  tunableValues.set(
    group.algorithmId,
    Object.fromEntries(group.tunables.map((tunable) => [tunable.id, tunable.value])),
  );
}

/** Snapshot of the tunable values, keyed by algorithm id. */
function algorithmOptions() {
  const out = {};
  for (const [id, values] of tunableValues) out[id] = { ...values };
  return out;
}

// ===========================================================================
//  State
// ===========================================================================
const state = {
  scenarios: [...SCENARIOS],
  scenario: SCENARIOS[0],
  weights: { ...DEFAULT_WEIGHTS },
  display: { explored: true, closed: true, traffic: true, elevation: true },
  viewMode: 'overlay',
  /** Parsed city map, when the user has imported one. */
  cityMap: null,
  testCase: null,
  run: null,
  busy: false,
};

// ===========================================================================
//  DOM handles
// ===========================================================================
const els = {
  views: document.getElementById('views'),
  verdict: document.getElementById('verdict'),
  resultsTable: document.getElementById('resultsTable'),
  comparisonTable: document.getElementById('comparisonTable'),
  runsTable: document.getElementById('runsTable'),
  legend: document.getElementById('legend'),
  caseSummary: document.getElementById('caseSummary'),
  badgeCustom: document.getElementById('badgeCustom'),
  badgeAstar: document.getElementById('badgeAstar'),
};

const views = {
  overlay: new NetworkView(document.getElementById('canvasOverlay'), { onViewChange: applyViewBox }),
  custom: new NetworkView(document.getElementById('canvasCustom'), { onViewChange: applyViewBox }),
  astar: new NetworkView(document.getElementById('canvasAstar'), { onViewChange: applyViewBox }),
};

/**
 * Zoom / pan is mirrored across every canvas, so side-by-side and overlay views always
 * show the same patch of road. `null` fits the whole network.
 */
function applyViewBox(rect) {
  for (const view of Object.values(views)) view.setViewBox(rect);
  renderVisibleViews();
}

const controls = initControls({
  onScenarioChange(id) {
    const scenario = state.scenarios.find((s) => s.id === id);
    if (scenario) {
      loadScenario(scenario);
      controls.setStatus('Scenario applied', 'ok');
      controls.setProgress(0, `Applied "${scenario.name}". Click "Run benchmark" to test.`);
    }
  },

  onCustomScenario(config) {
    // If the currently active scenario is an imported city map, apply conditions to that map.
    // Otherwise, generate a custom network with the user's requested type, nodes, and conditions.
    const isCityMapActive = !!(state.scenario && state.scenario.cityMap);
    const map = isCityMapActive ? state.cityMap : null;
    const scenario = scenarioFromCustom(config, map);

    // Update scenarios list: replace existing custom scenario or append it
    const existingIdx = state.scenarios.findIndex((s) => s.id === scenario.id);
    if (existingIdx >= 0) {
      state.scenarios[existingIdx] = scenario;
    } else {
      state.scenarios = [...state.scenarios, scenario];
    }

    controls.setScenarioList(state.scenarios, scenario.id);
    loadScenario(scenario);
    applyViewBox(null);

    const netLabel = scenario.network ? `${scenario.network.type} · ${fmtInt(state.testCase.meta.nodeCount)} nodes` : 'imported map';
    controls.setStatus('Custom scenario applied', 'ok');
    controls.setProgress(0, `Applied ${scenario.name} (${netLabel}). Click "Run benchmark" to test.`);
  },

  onCityMap(files) {
    loadCityMap(files);
  },

  onCityMapPath(spec) {
    loadCityMapFromPaths(spec);
  },

  onRun(config) {
    run(config);
  },

  onRouteMode(mode) {
    // Route mode changes what a run means, so previous results no longer describe it.
    clearResults();
    controls.setStatus('Route mode changed', '');
    controls.setProgress(0, mode === 'round'
      ? 'Collection round selected — set the number of pickup points and run the benchmark.'
      : 'Single trip selected — run the benchmark.');
  },

  onTunableChange(algorithmId, tunableId, value) {
    const values = tunableValues.get(algorithmId);
    if (!values || !(tunableId in values)) return;
    values[tunableId] = value;
    // Existing results were measured with the previous setting, so they no longer apply.
    clearResults();
    controls.setStatus('Setting changed', '');
    controls.setProgress(0, 'Algorithm setting changed — run the benchmark again.');
  },

  onPlayToggle() {
    playback.toggle();
  },

  onPlaySpeed(nodesPerSecond) {
    playback.setSpeed(nodesPerSecond);
  },

  onPlaySeek(fraction) {
    playback.seek(fraction);
  },

  onViewMode(mode) {
    state.viewMode = mode;
    applyViewMode();
  },

  onViewReset() {
    applyViewBox(null);
  },

  onDisplay(display) {
    state.display = display;
    for (const view of Object.values(views)) view.setOptions(display);
    renderLegend(els.legend, ALGORITHMS, state.display);
    renderVisibleViews();
  },

  onWeights(weights) {
    state.weights = weights;
    if (!state.testCase) return;
    // Re-cost only; the topology is untouched, so the network stays identical.
    applyWeights(state.testCase, weights);
    clearResults();
    renderVisibleViews();
    controls.setStatus('Weights applied', 'ok');
    controls.setProgress(0, 'Cost model weights applied — click "Run benchmark" to test.');
  },
});

/**
 * Slow-motion replay of the traversal traces. Purely a redraw of data the algorithms
 * already returned — nothing is re-run, so animating cannot disturb the measurements.
 */
const playback = new Playback({
  onReveal(revealById, text, frame) {
    // Dim the road network while a search is running, so the coloured expansion cloud is
    // the brightest thing on screen instead of competing with 11 000 roads.
    const baseAlpha = frame.phase === 'search' ? 0.22 : frame.phase === 'route' ? 0.5 : 1;
    for (const view of Object.values(views)) {
      view.setReveal(revealById);
      view.setBaseAlpha(baseAlpha);
    }
    controls.setPlaybackLabel(text);
    renderVisibleViews();
  },
  onStateChange(state) {
    controls.setPlayback(state);
  },
});

// ===========================================================================
//  City map import
// ===========================================================================

/**
 * Shared tail for every import route (file picker, drag & drop, path fetch).
 * The parsed map is kept in state so the custom-scenario panel can re-apply different
 * traffic / elevation / closure conditions to the same city without re-uploading it.
 */
function applyCityMapFiles(files, label) {
  try {
    const { map, warnings } = parseCityMap(files, {
      name: (label || files[0].name).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '),
    });

    state.cityMap = map;

    const scenario = scenarioFromCityMap(map);
    state.scenarios = [...SCENARIOS, scenario];
    controls.setScenarioList(state.scenarios, scenario.id);

    const notes = warnings.length > 0 ? `  (${warnings.length} note(s) — hover for details)` : '';
    controls.setMapStatus(
      `${map.source}: ${fmtInt(map.nodeCount)} nodes, ${fmtInt(map.edgeCount)} roads` +
      (map.stats.oneway > 0 ? `, ${fmtInt(map.stats.oneway)} one-way` : '') +
      (map.hasElevation ? ', elevations from file' : ', synthetic terrain') +
      notes,
      warnings.length > 0 ? 'pending' : 'ok',
      [...warnings, ...(map.warnings || [])].join('\n'),
    );

    for (const warning of warnings) console.warn('[city map]', warning);

    loadScenario(scenario);
    controls.setCustomValues({ ...CUSTOM_SCENARIO_DEFAULTS, seed: scenario.seed, repeat: scenario.repeat });
  } catch (error) {
    console.error(error);
    controls.setMapStatus(`Could not load the map: ${error.message}`, 'error', error.stack || '');
  }
}

/** Import from the file picker or a drag & drop. */
function loadCityMap(files) {
  if (!files || files.length === 0) return;
  const label = files.length === 1 ? files[0].name : files.map((f) => f.name).join(' + ');
  applyCityMapFiles(files, label);
}

/**
 * Import by fetching a path from the HTTP server the page is served from — a fallback
 * for environments where the native file picker does not open.
 * Comma-separate two paths for a node table + edge table.
 */
async function loadCityMapFromPaths(spec) {
  const parts = String(spec || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    controls.setMapStatus('Type a file name or path first, for example data/mycity.geojson', 'error');
    return;
  }

  try {
    controls.setMapStatus(`Fetching ${parts.join(' + ')}…`, 'pending');
    const files = [];
    for (const part of parts) {
      const url = /^https?:\/\//i.test(part) ? part : encodeURI(part);
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`${part} → HTTP ${response.status} ${response.statusText}`);
      files.push({ name: part.split('/').pop() || part, text: await response.text() });
    }
    controls.setMapLabel(parts.join(' + '));
    applyCityMapFiles(files, parts.join(' + '));
  } catch (error) {
    console.error(error);
    controls.setMapStatus(
      `Could not fetch ${parts.join(' + ')}: ${error.message} — copy the file into the project ` +
      'folder (e.g. data/) and use its path relative to the project root.',
      'error',
    );
  }
}

/**
 * Best-effort listing of the served `data/` folder. Python's http.server, Live Server and
 * most static servers return an HTML directory index, which lets a map be loaded with one
 * click when the native file picker is unavailable.
 */
async function refreshMapFolder() {
  try {
    const response = await fetch('data/', { cache: 'no-store' });
    if (!response.ok) return;
    const html = await response.text();
    const names = [...html.matchAll(/href="([^"?#]+)"/g)]
      .map((match) => decodeURIComponent(match[1]))
      .filter((name) => !name.startsWith('/') && !name.startsWith('..') && !name.endsWith('/'))
      .filter((name) => /\.(geojson|json|csv|tsv|txt|osm)$/i.test(name));
    controls.setFolderFiles(names);
  } catch {
    // No directory listing available — the picker and the path box still work.
  }
}

// ===========================================================================
//  Scenario handling
// ===========================================================================

/** Build a frozen test case for `scenario` and show the network (no routes yet). */
function loadScenario(scenario) {
  if (state.busy) return;

  state.scenario = scenario;
  controls.setScenarioDescription(scenario.description || '');
  controls.setRepeats(scenario.repeat || 5);
  syncNetworkInputs();

  state.testCase = buildTestCase(scenario, state.weights);
  state.run = null;

  for (const view of Object.values(views)) {
    view.setData(state.testCase);
    view.setOptions(state.display);
    view.setViewBox(null);
  }

  clearResults();
  updateCaseSummary();

  // Let the browser settle the layout before the first paint.
  requestAnimationFrame(() => {
    applyViewMode();
    renderVisibleViews();
  });
}

function updateCaseSummary() {
  const meta = state.testCase.meta;
  els.caseSummary.textContent =
    `${fmtInt(meta.nodeCount)} nodes · ${fmtInt(meta.edgeCount)} roads · ` +
    `${fmtInt(meta.closedEdges)} closed · elevation ${fmtMeters(meta.elevationMin)}–${fmtMeters(meta.elevationMax)} · ` +
    `mean traffic ${fmtNum(meta.meanTraffic, 3)}`;
}

/** An imported map supplies its own roads, so the network-shape inputs do not apply. */
function syncNetworkInputs() {
  controls.setNetworkInputsEnabled(!state.scenario.cityMap);
}

// ===========================================================================
//  Benchmark
// ===========================================================================

async function run({ repeats, warmup, mode = 'trip', stopCount }) {
  if (state.busy || !state.testCase) return;

  state.busy = true;
  controls.setBusy(true);
  controls.setStatus('Running', 'running');
  controls.setProgress(0, 'Starting…');

  // Hide stale routes while the new measurement runs.
  for (const view of Object.values(views)) view.setLayers([]);
  renderVisibleViews();

  try {
    const shared = {
      testCase: state.testCase,
      algorithms: ALGORITHMS,
      repeats,
      warmup,
      options: algorithmOptions(),
      onProgress: (fraction, label) => {
        controls.setProgress(fraction, label);
        controls.setStatus(`Running ${Math.round(fraction * 100)}%`, 'running');
      },
    };

    const result = mode === 'round'
      ? await runRouteBenchmark({ ...shared, stopCount })
      : await runBenchmark(shared);

    state.run = result;
    applyLayers();
    renderResults();
    controls.setStatus('Done', 'done');
    controls.setProgress(1, mode === 'round'
      ? `Finished ${repeats} round(s) of ${result.legCount} legs per algorithm.`
      : `Finished ${repeats} repetition(s) per algorithm.`);

    // Replay the search immediately; the scrubber jumps straight to the finished state.
    playback.load(state.run.results);
    playback.play();
  } catch (error) {
    console.error(error);
    controls.setStatus('Error', 'error');
    controls.setProgress(0, `Failed: ${error && error.message ? error.message : error}`);
  } finally {
    state.busy = false;
    controls.setBusy(false);
  }
}

/** Feed the measured routes into the canvases. */
function applyLayers() {
  const results = state.run ? state.run.results : [];
  const isRound = !!state.run && state.run.mode === 'round';

  // A collection round starts at a depot, not at the single-trip origin.
  for (const view of Object.values(views)) {
    if (isRound) view.setEndpoints(state.run.round.depot, -1, 'depot');
    else if (state.testCase) view.setEndpoints(state.testCase.start, state.testCase.goal);
  }

  const build = (ids) =>
    results
      .filter((r) => ids.includes(r.id) && r.path && r.path.length > 1)
      .map((r) => ({
        id: r.id,
        color: r.color,
        path: r.path,
        exploredNodes: r.exploredNodes,
        stops: r.stops || null,
        label: r.short,
      }));

  views.overlay.setLayers(build(ALL_IDS));
  views.custom.setLayers(build([CUSTOM_ID]));
  views.astar.setLayers(build([BASELINE_ID]));

  // Rebuilding the layers drops any reveal state, so put it back.
  playback.refresh();
}

function renderResults() {
  renderVerdict(els.verdict, state.run);
  renderResultsTable(els.resultsTable, state.run);
  renderComparisonTable(els.comparisonTable, state.run);
  renderRunsTable(els.runsTable, state.run);
  if (state.run) {
    updateBadges({ [CUSTOM_ID]: els.badgeCustom, [BASELINE_ID]: els.badgeAstar }, state.run.results);
  }
  renderVisibleViews();
}

function clearResults() {
  state.run = null;
  els.verdict.textContent = 'No benchmark has been run yet for this scenario.';
  els.resultsTable.innerHTML = '';
  els.comparisonTable.innerHTML = '';
  els.runsTable.innerHTML = '';
  els.badgeCustom.textContent = customAlgorithm.name;
  els.badgeAstar.textContent = astar.name;
  for (const view of Object.values(views)) {
    view.setLayers([]);
    if (state.testCase) view.setEndpoints(state.testCase.start, state.testCase.goal);
  }
  playback.clear();
}

// ===========================================================================
//  View modes & resizing
// ===========================================================================

function applyViewMode() {
  els.views.className = `views mode-${state.viewMode}`;
  requestAnimationFrame(renderVisibleViews);
}

function renderVisibleViews() {
  for (const view of Object.values(views)) {
    if (view.canvas.clientWidth > 0 && view.canvas.clientHeight > 0) view.render();
  }
}

let resizeScheduled = false;
function scheduleRender() {
  if (resizeScheduled) return;
  resizeScheduled = true;
  requestAnimationFrame(() => {
    resizeScheduled = false;
    renderVisibleViews();
  });
}

window.addEventListener('resize', scheduleRender);
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(scheduleRender).observe(els.views);
}

// ===========================================================================
//  Boot
// ===========================================================================

controls.setCustomValues(CUSTOM_SCENARIO_DEFAULTS);
controls.setScenarioList(state.scenarios, state.scenario.id);
controls.setStatus('Ready', '');
controls.setTunables(getTunableGroups());
renderLegend(els.legend, ALGORITHMS, state.display);
loadScenario(state.scenario);
refreshMapFolder();
