/**
 * Collection-round benchmark.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * A solid waste truck does not make one trip. It leaves a depot, visits many pickup
 * points, and returns. That changes what a benchmark should measure, and it changes
 * whether preprocessing is worth anything.
 *
 * On a single trip, `prepare()` is a cost you pay for one search. On a round with
 * `n` stops it is a cost you pay ONCE for `n + 1` searches. This runner measures both,
 * and reports them separately:
 *
 *     solve only   — the sum of all legs, which is what a per-query benchmark shows
 *     prep + solve — what a depot actually waits for, which is the honest total
 *
 * If an algorithm has an empty `prepare()` there is nothing to amortise, so adding stops
 * costs it exactly as much as it costs everyone else. That is the point of the comparison.
 *
 * ── What is held identical ───────────────────────────────────────────────────
 *   • the same test case (network, traffic, elevation, closures) by reference
 *   • the same depot, the same pickup points, and the same visiting order for every
 *     algorithm — route ORDER is a separate optimisation layer and is deliberately frozen
 *     here so this measures pathfinding, not tour planning
 *   • the same per-algorithm options, frontier and cost model
 */

import { summarize } from '../core/metrics.js';
import { evaluatePath } from '../core/pathUtils.js';
import { mulberry32, randInt } from '../core/rng.js';
import { compareResults, graphFingerprint, fingerprintsMatch } from './runner.js';
import { BASELINE_ID } from '../algorithms/registry.js';

const yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));

export const DEFAULT_STOP_COUNT = 12;

/**
 * Build a realistic collection round: a depot near the centre of the pickup area, stops
 * spread over the map, visited in a single angular sweep — the sector routing that real
 * collection vehicles use.
 *
 * Deterministic for a given seed, and shared by every algorithm.
 *
 * @param {object} testCase
 * @param {{stopCount?:number, seed?:number, allowed?:Uint8Array|null}} [options]
 * @returns {{depot:number, stops:number[], sequence:number[], legs:Array<{from:number,to:number}>}}
 */
export function buildCollectionRound(testCase, options = {}) {
  const { graph } = testCase;
  const stopCount = Math.max(1, Math.round(options.stopCount ?? DEFAULT_STOP_COUNT));
  const rng = mulberry32((options.seed ?? 909) >>> 0 || 909);
  const allowed = options.allowed || null;

  const pool = [];
  for (let i = 0; i < graph.nodeCount; i++) {
    if (!allowed || allowed[i] === 1) pool.push(i);
  }
  if (pool.length < 2) throw new Error('The network has too few usable nodes for a collection round.');

  const wanted = Math.min(stopCount, pool.length - 1);

  // Farthest-point sampling: pickup points spread over the service area instead of
  // clustering in one corner, which is what a random draw would give.
  const stops = [];
  const chosen = new Uint8Array(graph.nodeCount);
  const bestDist = new Float64Array(graph.nodeCount).fill(Infinity);
  let current = pool[randInt(rng, pool.length)];

  for (let i = 0; i < wanted; i++) {
    stops.push(current);
    chosen[current] = 1;

    let farthest = -1;
    let farthestDist = -1;
    for (const v of pool) {
      if (chosen[v] === 1) continue;
      const dx = graph.x[v] - graph.x[current];
      const dy = graph.y[v] - graph.y[current];
      const d = dx * dx + dy * dy;
      if (d < bestDist[v]) bestDist[v] = d;
      if (bestDist[v] > farthestDist) {
        farthestDist = bestDist[v];
        farthest = v;
      }
    }
    if (farthest < 0) break;
    current = farthest;
  }

  // Depot: the usable node nearest the centroid of the stops, so a real truck yard sits
  // inside the collection area. Falls back to a stop when the network is tiny.
  let cx = 0;
  let cy = 0;
  for (const stop of stops) {
    cx += graph.x[stop];
    cy += graph.y[stop];
  }
  cx /= stops.length;
  cy /= stops.length;

  let depot = stops[0];
  let bestDepot = Infinity;
  for (const v of pool) {
    if (chosen[v] === 1) continue;
    const d = (graph.x[v] - cx) ** 2 + (graph.y[v] - cy) ** 2;
    if (d < bestDepot) {
      bestDepot = d;
      depot = v;
    }
  }

  // Sector sweep: visit the stops in angular order around the depot.
  const angle = (node) => Math.atan2(graph.y[node] - cy, graph.x[node] - cx);
  const ordered = stops.slice().sort((a, b) => angle(a) - angle(b));

  const sequence = [depot, ...ordered, depot];
  const legs = [];
  for (let i = 0; i + 1 < sequence.length; i++) {
    legs.push({ from: sequence[i], to: sequence[i + 1] });
  }

  return { depot, stops: ordered, sequence, legs, seed: options.seed ?? 909 };
}

/**
 * Run a collection-round benchmark.
 *
 * @param {object} opts
 * @param {object} opts.testCase
 * @param {Array<object>} opts.algorithms
 * @param {number} [opts.stopCount]
 * @param {number} [opts.repeats]
 * @param {number} [opts.warmup]
 * @param {Object<string,object>} [opts.options]
 * @param {(fraction:number, label:string)=>void} [opts.onProgress]
 */
export async function runRouteBenchmark({
  testCase,
  algorithms,
  stopCount = DEFAULT_STOP_COUNT,
  repeats = 5,
  warmup = 1,
  options = {},
  onProgress = () => {},
}) {
  const { graph, costModel } = testCase;
  const reps = Math.max(1, Math.floor(repeats));
  const warmups = Math.max(0, Math.floor(warmup));
  const optionsFor = (alg) => options[alg.id] || {};
  const fingerprintBefore = graphFingerprint(graph);

  const round = buildCollectionRound(testCase, { stopCount, allowed: testCase.allowed });
  const legCount = round.legs.length;

  // ---- 1. preprocessing — once for the whole round -------------------------
  const contexts = new Map();
  for (const alg of algorithms) {
    let context = null;
    let prepMs = 0;
    if (typeof alg.prepare === 'function') {
      const t0 = performance.now();
      context = alg.prepare(graph, costModel, optionsFor(alg));
      prepMs = performance.now() - t0;
    }
    contexts.set(alg.id, { context, prepMs });
  }

  /** Drive every leg of the round; the timer covers all of them. */
  const driveRound = (alg) => {
    const { context } = contexts.get(alg.id);
    const opts = optionsFor(alg);
    const legs = [];
    let found = true;

    const t0 = performance.now();
    for (const leg of round.legs) {
      const result = alg.solve(graph, leg.from, leg.to, costModel, context, opts);
      legs.push(result);
      if (!result || !result.found || !result.path) found = false;
    }
    return { ms: performance.now() - t0, legs, found };
  };

  // ---- 2. warm-up ---------------------------------------------------------
  const totalSteps = reps * algorithms.length;
  let step = 0;
  for (let w = 0; w < warmups; w++) {
    for (const alg of algorithms) driveRound(alg);
    onProgress(0, `Warming up (${w + 1}/${warmups})`);
    await yieldToUi();
  }

  // ---- 3. measured rounds -------------------------------------------------
  const runs = new Map(algorithms.map((a) => [a.id, []]));

  for (let r = 0; r < reps; r++) {
    const order = r % 2 === 0 ? algorithms : [...algorithms].reverse();
    for (const alg of order) {
      runs.get(alg.id).push(driveRound(alg));
      step++;
      onProgress(step / totalSteps, `${alg.name} · round ${r + 1}/${reps}`);
      await yieldToUi();
    }
  }

  // ---- 4. verify and total every leg -------------------------------------
  const results = algorithms.map((alg) => {
    const entries = runs.get(alg.id);
    const representative = entries[0];
    const { prepMs } = contexts.get(alg.id);

    // Every leg is verified independently, exactly as a single trip would be.
    const perRunLegEvals = entries.map((entry) => entry.legs.map((legResult, i) => {
      const leg = round.legs[i];
      const hasPath = legResult && legResult.path && legResult.path.length > 0;
      return evaluatePath(graph, costModel, hasPath ? legResult.path : null, leg.from, leg.to);
    }));

    const roundTotals = perRunLegEvals.map(sumLegEvals);
    const repTotals = roundTotals[0];
    const repEvals = perRunLegEvals[0];

    const roundTimes = entries.map((entry) => entry.ms);
    const allFound = entries.every((entry) => entry.found);
    const anyFound = entries.some((entry) => entry.legs.some((leg) => leg && leg.found));

    const sum = (pick) => summarize(entries.map((entry) =>
      entry.legs.reduce((acc, leg) => acc + (leg ? pick(leg) : 0), 0)));

    const failingLeg = repEvals.findIndex((e) => !e.valid);

    return {
      id: alg.id,
      name: alg.name,
      short: alg.short || alg.name,
      color: alg.color || '#8b9bb0',
      description: alg.description || '',
      isBaseline: alg.id === BASELINE_ID,

      prepMs,

      found: anyFound,
      allRunsFound: allFound,
      valid: repTotals.valid,
      validPath: repTotals.valid,
      reason: failingLeg >= 0 ? `leg ${failingLeg + 1}: ${repEvals[failingLeg].reason}` : '',

      // The whole round as one polyline, for the canvas and the playback.
      path: concatLegPaths(representative.legs.map((leg) => (leg ? leg.path : null))),
      exploredNodes: concatLegPaths(representative.legs.map((leg) => (leg ? leg.exploredNodes : null))),
      stops: round.stops,
      depot: round.depot,

      // Solve-only totals, comparable with the single-trip columns.
      time: summarize(roundTimes),
      /** What the depot actually waits for: preprocessing once, then every leg. */
      timeWithPrep: summarize(roundTimes.map((ms) => ms + prepMs)),
      msPerLeg: summarize(roundTimes.map((ms) => ms / legCount)),

      nodesExplored: sum((leg) => leg.nodesExplored),
      nodesExpanded: sum((leg) => leg.nodesExpanded),
      arcsRelaxed: sum((leg) => leg.arcsRelaxed),

      distance: summarize(roundTotals.map((t) => t.distance)),
      cost: summarize(roundTotals.map((t) => t.cost)),
      travelTime: summarize(roundTotals.map((t) => t.travelTime)),

      repDistance: repTotals.distance,
      repCost: repTotals.cost,
      repTravelTime: repTotals.travelTime,

      deterministic: isConstant(roundTotals.map((t) => t.cost)),

      legCount,
      /** Average cost of one leg, for comparing against single-trip numbers. */
      meanLegCost: repTotals.cost / legCount,

      runs: entries.map((entry, i) => ({
        index: i + 1,
        ms: entry.ms,
        found: entry.found,
        valid: roundTotals[i].valid,
        nodesExplored: entry.legs.reduce((acc, leg) => acc + (leg ? leg.nodesExplored : 0), 0),
        nodesExpanded: entry.legs.reduce((acc, leg) => acc + (leg ? leg.nodesExpanded : 0), 0),
        arcsRelaxed: entry.legs.reduce((acc, leg) => acc + (leg ? leg.arcsRelaxed : 0), 0),
        distance: roundTotals[i].distance,
        cost: roundTotals[i].cost,
        travelTime: roundTotals[i].travelTime,
        legs: legCount,
      })),
    };
  });

  const fingerprintAfter = graphFingerprint(graph);
  const mutated = !fingerprintsMatch(fingerprintBefore, fingerprintAfter);

  onProgress(1, 'Done');

  return {
    mode: 'round',
    testCase,
    round,
    stopCount: round.stops.length,
    legCount,
    repetitions: reps,
    warmup: warmups,
    results,
    comparison: compareResults(results, BASELINE_ID),
    mutated,
    warnings: mutated
      ? ['A registered algorithm modified the shared graph. Results for that run are not trustworthy.']
      : [],
  };
}

// ===========================================================================
//  Helpers
// ===========================================================================

function sumLegEvals(evals) {
  let distance = 0;
  let cost = 0;
  let travelTime = 0;
  let valid = true;
  for (const e of evals) {
    if (!e.valid) { valid = false; continue; }
    distance += e.distance;
    cost += e.cost;
    travelTime += e.time;
  }
  return { distance, cost, travelTime, valid };
}

/**
 * Join per-leg paths (or expansion traces) into one list, dropping the duplicated junction
 * node so the whole round reads as a single continuous polyline.
 */
function concatLegPaths(paths) {
  const out = [];
  for (const path of paths) {
    if (!path || path.length === 0) continue;
    const from = out.length > 0 && out[out.length - 1] === path[0] ? 1 : 0;
    for (let i = from; i < path.length; i++) out.push(path[i]);
  }
  return out;
}

function isConstant(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return true;
  const first = finite[0];
  return finite.every((v) => Math.abs(v - first) < 1e-9);
}
