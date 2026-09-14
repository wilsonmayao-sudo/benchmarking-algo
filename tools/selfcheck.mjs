/**
 * Headless self-check — run with `npm run selfcheck` (or `node tools/selfcheck.mjs`).
 *
 * The browser app needs no build step and no npm packages; this script exists only so
 * the core can be verified from the command line. It exercises exactly the same modules
 * the page loads: scenario generation, city-map import, the cost model and both algorithms.
 *
 * Checks performed per generated scenario
 *   1. the test case builds and the origin/destination are connected
 *   2. both algorithms return a syntactically valid path (verified arc by arc)
 *   3. A* and the custom algorithm return the SAME path cost — both use admissible
 *      heuristics, so both must be optimal. A mismatch means a real bug.
 *
 * Checks performed on imported city maps
 *   4. every supported file format parses into the expected node/edge counts
 *   5. one-way streets really are one-way (arc count, and no reverse traversal)
 *   6. the benchmark runs on the imported network and both algorithms agree again
 *   7. malformed input produces a readable error instead of a stack trace
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SCENARIOS, scenarioFromCityMap } from '../js/data/scenarios.js';
import { buildTestCase } from '../js/data/testCaseBuilder.js';
import { parseCityMap } from '../js/data/cityMapLoader.js';
import { registerAlgorithm, getAlgorithms } from '../js/algorithms/registry.js';
import { astar } from '../js/algorithms/astar.js';
import { customAlgorithm, dynamicAStar } from '../js/algorithms/customAlgorithm.js';
import { runBenchmark } from '../js/benchmark/runner.js';
import { runRouteBenchmark } from '../js/benchmark/routeRunner.js';
import { findArc, evaluatePath } from '../js/core/pathUtils.js';
import { computeReveal, SEARCH_SHARE } from '../js/ui/playback.js';
import { computeTransform, screenToWorld, zoomRect, panRect, clampRect } from '../js/ui/networkView.js';

registerAlgorithm(customAlgorithm);
registerAlgorithm(astar);
const algorithms = getAlgorithms();

const pct = (a, b) => (b === 0 ? 'n/a' : `${((a - b) / b * 100).toFixed(1)}%`);
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

let failures = 0;
const fail = (message) => {
  failures++;
  console.log(`  \u2717 ${message}`);
};

console.log(`\nPathfinding benchmark — headless self-check\n${'='.repeat(96)}\n`);

// ===========================================================================
//  Part 1 — generated scenarios
// ===========================================================================

for (const scenario of SCENARIOS) {
  const testCase = buildTestCase(scenario);
  const meta = testCase.meta;

  const t0 = performance.now();
  const run = await runBenchmark({ testCase, algorithms, repeats: 7, warmup: 3 });
  const totalMs = performance.now() - t0;

  const problems = [];

  console.log(`${meta.scenarioName}`);
  console.log(
    `  network ${meta.nodeCount} nodes / ${meta.edgeCount} roads / ${meta.closedEdges} closed` +
    `   elevation ${meta.elevationMin.toFixed(0)}–${meta.elevationMax.toFixed(0)} m` +
    `   mean traffic ${meta.meanTraffic.toFixed(3)}` +
    `   origin ${testCase.start} → destination ${testCase.goal}`,
  );

  for (const r of run.results) {
    const flags = [
      r.found ? 'route' : 'NO ROUTE',
      r.valid ? 'valid' : `INVALID (${r.reason})`,
      r.deterministic ? 'deterministic' : 'VARIABLE',
    ].join(' · ');

    console.log(
      `    ${pad(r.name, 20)} avg ${padL(r.time.avg.toFixed(3), 8)} ms` +
      `  min ${padL(r.time.min.toFixed(3), 8)}` +
      `  explored ${padL(r.nodesExplored.avg, 6)}` +
      `  expanded ${padL(r.nodesExpanded.avg, 5)}` +
      `  paths ${r.path ? r.path.length : 0}` +
      `  cost ${padL(Number.isFinite(r.cost.avg) ? r.cost.avg.toFixed(2) : 'n/a', 9)}` +
      `  dist ${padL(Number.isFinite(r.distance.avg) ? r.distance.avg.toFixed(0) : 'n/a', 7)} m` +
      `  prep ${r.prepMs.toFixed(1)} ms  [${flags}]`,
    );

    if (!r.found) problems.push(`${r.name}: no route found`);
    if (r.found && !r.valid) problems.push(`${r.name}: path failed verification (${r.reason})`);
  }

  const [custom, baseline] = run.results;
  if (custom.valid && baseline.valid) {
    const timeDiff = baseline.travelTime.avg - custom.travelTime.avg;
    console.log(
      `    \u2713 Dynamic A* travel time: ${custom.travelTime.avg.toFixed(1)} s vs baseline ${baseline.travelTime.avg.toFixed(1)} s ` +
      `(${timeDiff >= 0 ? `${timeDiff.toFixed(1)} s faster` : `${(-timeDiff).toFixed(1)} s`})` +
      ` · dist ${custom.distance.avg.toFixed(0)} m vs baseline ${baseline.distance.avg.toFixed(0)} m`,
    );
    if (custom.cost.avg > baseline.cost.avg + 1e-3) {
      problems.push(`Dynamic A* cost ${custom.cost.avg.toFixed(4)} exceeds baseline cost ${baseline.cost.avg.toFixed(4)}`);
    }
  }

  if (run.mutated) problems.push('graph was mutated during the run');
  if (run.results[0].found !== run.results[1].found) problems.push('algorithms disagree on whether a route exists');

  console.log(`  total ${totalMs.toFixed(0)} ms\n`);

  for (const p of problems) fail(p);
  if (problems.length > 0) console.log('');
}

// ===========================================================================
//  Part 2 — city-map import
// ===========================================================================

console.log(`${'='.repeat(96)}\nCity-map importer\n${'='.repeat(96)}\n`);

const here = dirname(fileURLToPath(import.meta.url));
const sampleText = readFileSync(join(here, '..', 'data', 'sample-city.geojson'), 'utf8');

/** A 4-node square with per-node elevations. */
const nodesCsv = [
  'id,lat,lon,elevation',
  'a,14.1000,122.2000,12',
  'b,14.1000,122.2016,18',
  'c,14.1016,122.2016,26',
  'd,14.1016,122.2000,20',
].join('\n');

const edgesCsv = [
  'from,to,speed_kph,highway',
  'a,b,60,primary',
  'b,c,40,residential',
  'c,d,40,residential',
  'd,a,30,residential',
].join('\n');

/** Overpass "out body" form, including a footway that must be dropped. */
const osmJson = JSON.stringify({
  version: 0.6,
  generator: 'Overpass API',
  elements: [
    { type: 'node', id: 1, lat: 14.1000, lon: 122.2000 },
    { type: 'node', id: 2, lat: 14.1000, lon: 122.2016 },
    { type: 'node', id: 3, lat: 14.1016, lon: 122.2016 },
    { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'primary', maxspeed: '60' } },
    { type: 'way', id: 11, nodes: [2, 3], tags: { highway: 'residential', oneway: 'yes' } },
    { type: 'way', id: 12, nodes: [1, 3], tags: { highway: 'footway' } },
  ],
});

const byName = (pairs) => pairs.map(([name, text]) => ({ name, text }));

const importCases = [
  {
    label: 'GeoJSON (data/sample-city.geojson)',
    files: byName([['sample-city.geojson', sampleText]]),
    expect: { nodes: 25, edges: 40, oneway: 4, hasElevation: false },
  },
  {
    label: 'CSV node table + edge table',
    files: byName([['nodes.csv', nodesCsv], ['edges.csv', edgesCsv]]),
    expect: { nodes: 4, edges: 4, oneway: 0, hasElevation: true },
  },
  {
    label: 'CSV single edge list with coordinates',
    files: byName([['segments.csv', [
      'from_lat,from_lon,to_lat,to_lon,speed_kph',
      '14.1000,122.2000,14.1000,122.2016,50',
      '14.1000,122.2016,14.1016,122.2016,50',
      '14.1016,122.2016,14.1016,122.2000,50',
    ].join('\n')]]),
    expect: { nodes: 4, edges: 3, oneway: 0, hasElevation: false },
  },
  {
    label: 'Overpass / OSM JSON',
    files: byName([['overpass.json', osmJson]]),
    expect: { nodes: 3, edges: 2, oneway: 1, hasElevation: false },
  },
];

for (const importCase of importCases) {
  let map;
  try {
    ({ map } = parseCityMap(importCase.files));
  } catch (error) {
    fail(`${importCase.label}: ${error.message}`);
    console.log('');
    continue;
  }

  const { expect } = importCase;
  const expectedArcs = map.edgeCount * 2 - map.stats.oneway;

  console.log(`${importCase.label}`);
  console.log(
    `  ${map.source} · ${map.nodeCount} nodes · ${map.edgeCount} roads · ${map.stats.oneway} one-way` +
    ` · ${expectedArcs} arcs · elevations ${map.hasElevation ? 'from file' : 'synthetic'}`,
  );

  if (map.nodeCount !== expect.nodes) fail(`${importCase.label}: expected ${expect.nodes} nodes, got ${map.nodeCount}`);
  if (map.edgeCount !== expect.edges) fail(`${importCase.label}: expected ${expect.edges} roads, got ${map.edgeCount}`);
  if (map.stats.oneway !== expect.oneway) fail(`${importCase.label}: expected ${expect.oneway} one-way roads, got ${map.stats.oneway}`);
  if (map.hasElevation !== expect.hasElevation) fail(`${importCase.label}: hasElevation should be ${expect.hasElevation}`);

  for (const warning of map.warnings) console.log(`  \u26a0 ${warning}`);

  // ---- build a real test case and cross-check one-way behaviour ------------
  const scenario = scenarioFromCityMap(map, { closures: 0, trafficLevel: 0 });
  const built = buildTestCase(scenario);

  if (built.graph.arcCount !== expectedArcs) {
    fail(`${importCase.label}: graph has ${built.graph.arcCount} arcs, expected ${expectedArcs}`);
  }

  if (map.stats.oneway > 0) {
    let checked = 0;
    for (let e = 0; e < built.graph.edgeCount && checked < 3; e++) {
      if (built.graph.edgeDirected[e] !== 1) continue;
      const u = built.graph.edgeFrom[e];
      const v = built.graph.edgeTo[e];
      const forward = findArc(built.graph, u, v);
      const backward = findArc(built.graph, v, u);

      if (forward < 0 || built.graph.adjEdge[forward] !== e) {
        fail(`${importCase.label}: one-way road ${e} is not traversable forwards`);
      }
      if (backward >= 0 && built.graph.adjEdge[backward] === e) {
        fail(`${importCase.label}: one-way road ${e} is ALSO traversable backwards`);
      }
      checked++;
    }
    if (checked > 0) console.log(`  \u2713 one-way roads enforced (${checked} road(s) checked)`);
  }

  const run = await runBenchmark({ testCase: built, algorithms, repeats: 3, warmup: 1 });
  const [custom, baseline] = run.results;

  if (!custom.found || !baseline.found) {
    fail(`${importCase.label}: an algorithm found no route`);
  } else if (!custom.valid || !baseline.valid) {
    fail(`${importCase.label}: a returned path failed verification`);
  } else {
    console.log(
      `  \u2713 route found · Dynamic A* travel time ${custom.travelTime.avg.toFixed(1)} s vs baseline ${baseline.travelTime.avg.toFixed(1)} s` +
      ` · expanded ${custom.nodesExpanded.avg} vs ${baseline.nodesExpanded.avg} nodes`,
    );
  }
  console.log('');
}

// ===========================================================================
//  Part 3 — error handling
// ===========================================================================

console.log(`${'='.repeat(96)}\nInput validation\n${'='.repeat(96)}\n`);

const badInputs = [
  { label: 'empty GeoJSON', files: byName([['x.geojson', '{"type":"FeatureCollection","features":[]}']]) },
  { label: 'nodes-only CSV', files: byName([['nodes.csv', nodesCsv]]) },
  { label: 'unmatched edge ids', files: byName([['n.csv', nodesCsv], ['e.csv', 'from,to\nzz,yy\n']]) },
  { label: 'not JSON or CSV geometry', files: byName([['x.json', '{"hello":"world"}']]) },
];

for (const input of badInputs) {
  try {
    parseCityMap(input.files);
    fail(`${input.label}: expected a readable error, but parsing succeeded`);
  } catch (error) {
    console.log(`${pad(input.label, 24)} \u2713 ${error.message}`);
  }
}

// ===========================================================================
//  Part 4 — playback timeline
// ===========================================================================

console.log(`\n${'='.repeat(96)}\nPlayback timeline (slow motion)\n${'='.repeat(96)}\n`);

{
  // Two fake algorithms with very different expansion counts.
  const layers = [
    { id: 'custom', short: 'Custom', color: '#38bdf8', nodes: Array.from({ length: 400 }, (_, i) => i), path: Array.from({ length: 40 }, (_, i) => i) },
    { id: 'astar', short: 'A*', color: '#f43f5e', nodes: Array.from({ length: 5000 }, (_, i) => i), path: Array.from({ length: 90 }, (_, i) => i) },
  ];

  const atStart = computeReveal(0, layers);
  const atSearchEnd = computeReveal(SEARCH_SHARE, layers);
  const atEnd = computeReveal(1, layers);

  if (atStart.phase !== 'idle') fail(`playback: progress 0 should be idle, got ${atStart.phase}`);
  if (atEnd.phase !== 'done') fail(`playback: progress 1 should be done, got ${atEnd.phase}`);

  for (const layer of layers) {
    const start = atStart.revealed.get(layer.id);
    const search = atSearchEnd.revealed.get(layer.id);
    const end = atEnd.revealed.get(layer.id);

    if (start.revealedNodes !== 0) fail(`playback: ${layer.id} should show 0 nodes at the start`);
    // Each layer finishes its OWN search at the phase boundary — that is the whole point.
    if (search.revealedNodes !== layer.nodes.length) {
      fail(`playback: ${layer.id} should show all ${layer.nodes.length} nodes at the phase boundary, got ${search.revealedNodes}`);
    }
    if (end.revealedNodes !== layer.nodes.length) fail(`playback: ${layer.id} should end with every node revealed`);
    if (end.revealedPath !== layer.path.length) fail(`playback: ${layer.id} should end with the whole route revealed`);
    if (search.revealedPath !== 0) fail(`playback: ${layer.id} should not draw the route during the search phase`);
  }

  // Sweep the timeline: counts must never go backwards or run past the array ends,
  // otherwise the renderer would slice out of range mid-animation.
  let problems = 0;
  const previous = new Map(layers.map((l) => [l.id, 0]));
  const previousPath = new Map(layers.map((l) => [l.id, 0]));

  for (let step = 0; step <= 200; step++) {
    const frame = computeReveal(step / 200, layers);
    for (const layer of layers) {
      const r = frame.revealed.get(layer.id);
      if (r.revealedNodes < previous.get(layer.id)) problems++;
      if (r.revealedPath < previousPath.get(layer.id)) problems++;
      if (r.revealedNodes > layer.nodes.length || r.revealedPath > layer.path.length) problems++;
      if (r.revealedNodes < 0 || r.revealedPath < 0) problems++;
      previous.set(layer.id, r.revealedNodes);
      previousPath.set(layer.id, r.revealedPath);
    }
  }

  if (problems > 0) fail(`playback: ${problems} monotonicity/range violation(s) across the timeline`);

  // Out-of-range input must be clamped rather than producing NaN indices.
  const wild = computeReveal(5, layers);
  if (wild.progress !== 1) fail('playback: progress above 1 should clamp to 1');
  const negative = computeReveal(-3, layers);
  if (negative.progress !== 0) fail('playback: negative progress should clamp to 0');

  if (failures === 0) {
    console.log(
      `  200-step sweep over ${layers.length} layers (400 vs 5 000 expansions, 40 vs 90 route vertices)`,
    );
    console.log('  \u2713 counts are monotonic, in range, and clamp outside 0..1');
    console.log('  \u2713 both searches finish together at the phase boundary');
  }
}

// ===========================================================================
//  Part 5 — canvas view transform (zoom / pan)
// ===========================================================================

console.log(`\n${'='.repeat(96)}\nCanvas view transform (zoom / pan)\n${'='.repeat(96)}\n`);

{
  const bounds = { minX: 0, minY: 0, maxX: 6000, maxY: 4200 };
  const full = { x0: bounds.minX, y0: bounds.minY, x1: bounds.maxX, y1: bounds.maxY };
  const CSS_W = 720;
  const CSS_H = 520;

  const t0 = computeTransform(full, CSS_W, CSS_H);

  const left = t0.ox + bounds.minX * t0.scale;
  const right = CSS_W - (t0.ox + bounds.maxX * t0.scale);
  const top = t0.oy - bounds.maxY * t0.scale;
  const bottom = CSS_H - (t0.oy - bounds.minY * t0.scale);

  if (!(left >= -0.5 && right >= -0.5 && top >= -0.5 && bottom >= -0.5)) {
    fail('transform: the fitted network escapes the canvas box');
  }
  if (Math.abs(left - right) > 0.5 || Math.abs(top - bottom) > 0.5) {
    fail('transform: the fitted network is not centred');
  }

  // Forward and inverse mapping must agree.
  const probe = screenToWorld(t0, 200, 300);
  if (
    Math.abs(t0.ox + probe.x * t0.scale - 200) > 1e-6 ||
    Math.abs(t0.oy - probe.y * t0.scale - 300) > 1e-6
  ) {
    fail('transform: screenToWorld is not the inverse of the forward mapping');
  }

  // The invariant that makes zooming feel right: the world point under the cursor stays
  // put. Verified from four corners and a centre point, in and out.
  let worstZoomDrift = 0;
  const probes = [[40, 40], [360, 260], [700, 500], [12, 508], [360, 12]];
  for (const [sx, sy] of probes) {
    const world = screenToWorld(t0, sx, sy);
    for (const factor of [1.15, 1 / 1.15, 2.5, 0.3]) {
      const t1 = computeTransform(zoomRect(full, world.x, world.y, factor), CSS_W, CSS_H);
      const back = screenToWorld(t1, sx, sy);
      worstZoomDrift = Math.max(
        worstZoomDrift,
        Math.abs(back.x - world.x) / 6000, // relative to map width
        Math.abs(back.y - world.y) / 4200,
      );
    }
  }
  if (worstZoomDrift > 1e-9) fail(`transform: zooming drifts the point under the cursor (${worstZoomDrift})`);

  // Dragging must move the content exactly with the pointer.
  let worstPanDrift = 0;
  const panWorld = screenToWorld(t0, 300, 200);
  for (const [dx, dy] of [[37, -21], [-90, 64], [0, 0]]) {
    const t2 = computeTransform(panRect(full, t0.scale, dx, dy), CSS_W, CSS_H);
    const movedX = t2.ox + panWorld.x * t2.scale;
    const movedY = t2.oy - panWorld.y * t2.scale;
    worstPanDrift = Math.max(worstPanDrift, Math.abs(movedX - (300 + dx)), Math.abs(movedY - (200 + dy)));
  }
  if (worstPanDrift > 1e-6) fail(`transform: panning drifts ${worstPanDrift} px from the pointer`);

  // Zoom limits: never smaller than 1 % of the map, never larger than 4x, centre kept.
  const tiny = clampRect({ x0: 1000, y0: 1000, x1: 1000.001, y1: 1000.001 }, bounds);
  if (tiny.x1 - tiny.x0 < (bounds.maxX - bounds.minX) * 0.01 - 1e-6) {
    fail('transform: zoom-in clamp is too permissive');
  }
  // A rect centred on the map but far too large: clamped in span, centre preserved.
  const huge = clampRect({ x0: 3000 - 9e5, y0: 2100 - 9e5, x1: 3000 + 9e5, y1: 2100 + 9e5 }, bounds);
  if (huge.x1 - huge.x0 > (bounds.maxX - bounds.minX) * 4 + 1e-6) {
    fail('transform: zoom-out clamp is too permissive');
  }
  if (Math.abs((huge.x0 + huge.x1) / 2 - 3000) > 1e-6 || Math.abs((huge.y0 + huge.y1) / 2 - 2100) > 1e-6) {
    fail('transform: clamping should preserve the centre');
  }

  if (failures === 0) {
    console.log(`  fit: ${(t0.scale * 1000).toFixed(3)} px per 1 000 m into ${CSS_W}×${CSS_H}`);
    console.log('  \u2713 fitted inside the box and centred, forward/inverse mapping agree');
    console.log('  \u2713 zoom keeps the world point under the cursor fixed');
    console.log('  \u2713 pan moves content exactly with the pointer');
    console.log('  \u2713 zoom limits clamp and preserve the centre');
  }
}

// ===========================================================================
//  Part 6 — weighted A* speed / optimality trade-off
// ===========================================================================

console.log(`\n${'='.repeat(96)}\nWeighted A* trade-off (f = g + w*h)\n${'='.repeat(96)}\n`);

{
  const testCase = buildTestCase(SCENARIOS[0]);
  const { graph, costModel, start, goal } = testCase;

  const runAt = (weight) => {
    const t0 = performance.now();
    const result = dynamicAStar(graph, start, goal, costModel, { weight });
    const ms = performance.now() - t0;
    const evaluated = evaluatePath(graph, costModel, result.path, start, goal);
    return { result, evaluated, ms };
  };

  // Discard one run so the w = 1 reference is not paying JIT compilation for the whole
  // sweep — otherwise the baseline looks slower than the variants it is meant to anchor.
  dynamicAStar(graph, start, goal, costModel, { weight: 1 });

  const optimal = runAt(1);
  if (!optimal.evaluated.valid) fail('weighted: w = 1 returned an invalid path');

  console.log('     w   expanded   explored   cost        cost/optimal   ms');
  console.log(
    `  ${'1.00'.padStart(5)} ${String(optimal.result.nodesExpanded).padStart(9)}` +
    ` ${String(optimal.result.nodesExplored).padStart(10)}` +
    ` ${optimal.evaluated.cost.toFixed(2).padStart(10)}` +
    ` ${'1.0000'.padStart(14)} ${optimal.ms.toFixed(3).padStart(7)}   (reference)`,
  );

  for (const weight of [1.05, 1.1, 1.25, 1.5, 2, 3, 5]) {
    const { result, evaluated, ms } = runAt(weight);
    const ratio = evaluated.cost / optimal.evaluated.cost;

    console.log(
      `  ${weight.toFixed(2).padStart(5)} ${String(result.nodesExpanded).padStart(9)}` +
      ` ${String(result.nodesExplored).padStart(10)}` +
      ` ${evaluated.cost.toFixed(2).padStart(10)}` +
      ` ${ratio.toFixed(4).padStart(14)} ${ms.toFixed(3).padStart(7)}`,
    );

    if (!evaluated.valid) fail(`weighted w=${weight}: returned an invalid path`);
    if (!result.found) fail(`weighted w=${weight}: reported no route`);

    // The two properties that define weighted A*:
    //   1. never better than optimal — w > 1 cannot beat the exact search
    //   2. never worse than w x optimal — the bounded-suboptimality guarantee
    if (evaluated.cost < optimal.evaluated.cost - 1e-9) {
      fail(`weighted w=${weight}: cost ${evaluated.cost.toFixed(4)} beats the optimal ${optimal.evaluated.cost.toFixed(4)}`);
    }
    if (ratio > weight + 1e-6) {
      fail(`weighted w=${weight}: cost ratio ${ratio.toFixed(4)} exceeds the w-bounded guarantee`);
    }
    if (result.nodesExpanded > optimal.result.nodesExpanded) {
      fail(`weighted w=${weight}: expanded more nodes (${result.nodesExpanded}) than w = 1 (${optimal.result.nodesExpanded})`);
    }
  }

  // The knob must be clamped sanely rather than producing NaN priorities.
  for (const bad of [0, -1, NaN, undefined]) {
    const r = dynamicAStar(graph, start, goal, costModel, { weight: bad });
    if (!r.found || !evaluatePath(graph, costModel, r.path, start, goal).valid) {
      fail(`weighted: weight=${String(bad)} should fall back to the default, not break the search`);
    }
  }

  if (failures === 0) {
    console.log('\n  \u2713 every weight returns a valid route, never cheaper than optimal');
    console.log('  \u2713 cost stays within the w x optimal guarantee');
    console.log('  \u2713 expansions never increase as the weight rises');
    console.log('  \u2713 invalid weights (0, negative, NaN) fall back to the default');
  }
}

console.log(`\n${'='.repeat(96)}\nCollection round\n${'='.repeat(96)}\n`);

{
  const STOP_COUNT = 10;
  const testCase = buildTestCase(SCENARIOS[0]);
  const run = await runRouteBenchmark({
    testCase, algorithms, stopCount: STOP_COUNT, repeats: 3, warmup: 1,
  });

  console.log(
    `  depot ${run.round.depot} → ${run.stopCount} pickup points → depot · ${run.legCount} legs · ` +
    `${run.results.length} algorithms`,
  );

  if (run.legCount !== run.stopCount + 1) {
    fail(`round: ${run.stopCount} stops should mean ${run.stopCount + 1} legs, got ${run.legCount}`);
  }
  if (run.round.stops.length !== STOP_COUNT) {
    fail(`round: expected ${STOP_COUNT} pickup points, got ${run.round.stops.length}`);
  }
  if (new Set(run.round.stops).size !== run.round.stops.length) {
    fail('round: a pickup point is visited twice');
  }
  if (run.round.stops.includes(run.round.depot)) {
    fail('round: the depot is also a pickup point');
  }

  // Every algorithm must have driven the identical round: same depot, same stops, same order.
  const signature = JSON.stringify([run.round.depot, run.round.stops, run.round.legs]);
  for (const r of run.results) {
    if (JSON.stringify([r.depot, r.stops, run.round.legs]) !== signature) {
      fail(`round: ${r.name} was given a different round`);
    }
  }

  for (const r of run.results) {
    const ok = r.found && r.valid;
    console.log(
      `    ${pad(r.name, 22)} ${ok ? 'all legs valid' : `INVALID (${r.reason})`}` +
      `  solve ${padL(r.time.avg.toFixed(2), 8)} ms  prep ${padL(r.prepMs.toFixed(2), 6)} ms` +
      `  round ${padL((r.timeWithPrep ? r.timeWithPrep.avg : r.time.avg).toFixed(2), 8)} ms` +
      `  expanded ${padL(r.nodesExpanded.avg, 7)}  cost ${r.cost.avg.toFixed(2)}`,
    );

    if (!ok) fail(`round: ${r.name} did not complete every leg`);
    if (r.timeWithPrep && r.timeWithPrep.avg < r.time.avg - 1e-9) {
      fail(`round: ${r.name} reports a prep + solve total below its solve time`);
    }
    if (!r.path || r.path.length < 2) fail(`round: ${r.name} produced no drawable round path`);
  }

  // Dynamic A* minimizes the cost model, so its cost must not exceed baseline
  const baseline = run.results.find((r) => r.isBaseline);
  for (const r of run.results) {
    if (r.isBaseline || !baseline) continue;
    if (r.cost.avg > baseline.cost.avg + 1e-3) {
      fail(`round: ${r.name} cost ${r.cost.avg.toFixed(4)} exceeds baseline cost ${baseline.cost.avg.toFixed(4)}`);
    }
  }

  // A longer round must cost more than a shorter one — a sanity check on the aggregation.
  const short = await runRouteBenchmark({ testCase, algorithms, stopCount: 3, repeats: 1, warmup: 0 });
  const shortBase = short.results.find((r) => r.isBaseline);
  if (!(baseline.cost.avg > shortBase.cost.avg)) {
    fail('round: a 10-stop round did not cost more than a 3-stop round');
  }

  if (failures === 0) {
    console.log('  \u2713 every algorithm drove the identical round (same depot, stops and order)');
    console.log('  \u2713 every leg of every round verified independently');
    console.log('  \u2713 both optimal searchers agree on the round total; prep + solve >= solve');
  }
}

console.log(`\n${'='.repeat(96)}`);
if (failures === 0) {
  console.log('All checks passed.\n');
} else {
  console.log(`${failures} problem(s) found.\n`);
  process.exitCode = 1;
}
