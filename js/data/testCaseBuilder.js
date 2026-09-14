/**
 * Scenario → frozen test case.
 *
 * A test case is built ONCE per benchmark run and then handed to every algorithm by
 * reference. That single object is the definition of "fair": same graph, same start,
 * same destination, same traffic factors, same elevation profile, same closures,
 * same cost model. No algorithm ever receives its own copy or its own variant.
 */

import { CostModel, DEFAULT_WEIGHTS } from '../core/costModel.js';
import { mulberry32, randInt } from '../core/rng.js';
import {
  generateNetwork,
  applyElevation,
  applyTraffic,
  applyClosures,
} from './networkGenerator.js';
import { buildGraphFromMap } from './cityMapLoader.js';
import { ROAD_CLASS } from '../core/graph.js';

/**
 * @param {object} scenario a scenario from `scenarios.js`. When it carries a `cityMap`
 *                          the imported road network is used instead of a generated one.
 * @param {Partial<typeof DEFAULT_WEIGHTS>} [weights]
 * @returns {{graph, costModel, start, goal, meta, scenario}}
 */
export function buildTestCase(scenario, weights = DEFAULT_WEIGHTS) {
  const seed = scenario.seed >>> 0 || 1;
  const cityMap = scenario.cityMap || null;

  // Distinct sub-seeds so that changing one condition leaves the others untouched.
  // An imported map is rebuilt from scratch every time, so nothing leaks between runs.
  const graph = cityMap
    ? buildGraphFromMap(cityMap)
    : generateNetwork({ ...scenario.network, seed: seed + 1 });

  // Real elevations from the file win; otherwise terrain is synthesised.
  if (!cityMap || !cityMap.hasElevation) {
    applyElevation(graph, { ...scenario.elevation, seed: seed + 2 });
  }
  applyTraffic(graph, { ...scenario.traffic, seed: seed + 3 });
  applyClosures(graph, { ...scenario.closures, seed: seed + 4 });

  graph.buildAdjacency();

  const costModel = new CostModel(graph, weights);

  // Imported maps are not always fully connected; keep both endpoints inside the largest
  // component so the benchmark always has a route to find. `allowed` is also reused by the
  // collection-round runner, which needs pickup points from the same component.
  const allowed = cityMap ? cityMap.mainComponent : null;
  const { start, goal } = pickEndpoints(graph, seed + 5, { allowed });

  return { graph, costModel, start, goal, allowed, meta: describe(graph, scenario), scenario };
}

/** Swap the weights without regenerating the network (cheap re-cost). */
export function applyWeights(testCase, weights) {
  testCase.costModel = new CostModel(testCase.graph, weights);
  return testCase;
}

/**
 * Pick an origin and a destination that are as far apart as the network allows, so the
 * search cannot be solved with a two-hop route.
 *
 * `override.allowed` is an optional Uint8Array mask (1 = usable). Imported city maps use
 * it to restrict both endpoints to the largest connected component.
 */
export function pickEndpoints(graph, seed, override = {}) {
  const n = graph.nodeCount;
  const rng = mulberry32(seed >>> 0 || 5);

  let pool = null;
  if (override.allowed) {
    const list = [];
    for (let i = 0; i < n; i++) if (override.allowed[i] === 1) list.push(i);
    if (list.length > 1) pool = list;
  }
  const draw = () => (pool ? pool[randInt(rng, pool.length)] : randInt(rng, n));

  let start = Number.isInteger(override.start) ? override.start : draw();
  let goal = Number.isInteger(override.goal) ? override.goal : -1;
  let farthest = -1;

  if (goal < 0) {
    const samples = Math.min(400, n);
    for (let i = 0; i < samples; i++) {
      const c = draw();
      const dx = graph.x[c] - graph.x[start];
      const dy = graph.y[c] - graph.y[start];
      const d = dx * dx + dy * dy;
      if (d > farthest) {
        farthest = d;
        goal = c;
      }
    }
    if (goal === start) goal = pool && pool.length > 1 ? pool[(pool.indexOf(start) + 1) % pool.length] : (start + 1) % n;
  }

  return { start, goal };
}

/** Summary numbers shown above the canvases and in the results header. */
function describe(graph, scenario) {
  const bounds = graph.bounds();
  const m = graph.edgeCount;

  let closed = 0;
  let arterials = 0;
  let oneway = 0;
  let trafficSum = 0;
  for (let e = 0; e < m; e++) {
    if (graph.edgeClosed[e] === 1) closed++;
    if (graph.edgeClass[e] === ROAD_CLASS.ARTERIAL) arterials++;
    if (graph.edgeDirected[e] === 1) oneway++;
    trafficSum += graph.edgeTraffic[e];
  }

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    isCityMap: !!scenario.cityMap,
    mapSource: scenario.cityMap ? scenario.cityMap.source : 'generated',
    nodeCount: graph.nodeCount,
    edgeCount: m,
    arcCount: graph.arcCount,
    closedEdges: closed,
    arterialCount: arterials,
    onewayEdges: oneway,
    meanTraffic: m > 0 ? trafficSum / m : 1,
    elevationMin: bounds.minE,
    elevationMax: bounds.maxE,
    elevationRange: bounds.maxE - bounds.minE,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  };
}
