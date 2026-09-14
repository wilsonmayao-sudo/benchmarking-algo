/**
 * Benchmark harness.
 *
 * ── What is measured ─────────────────────────────────────────────────────────
 *   The timer wraps ONLY the algorithm's `solve()` call. Everything else — building
 *   the test case, JSON-free networking, painting, progress updates — happens outside
 *   the timed region, so the numbers reflect search performance and nothing else.
 *
 * ── Fairness rules enforced here ─────────────────────────────────────────────
 *   1. One frozen test case object, shared by reference with every algorithm.
 *   2. `prepare()` (preprocessing) is timed separately and reported as "Prep (ms)".
 *   3. A discarded warm-up run per algorithm lets the JIT settle.
 *   4. The execution order is reversed on every other repetition, so a systematic
 *      "first algorithm is penalised" bias cannot creep in.
 *   5. The harness — not the algorithm — re-walks each returned path, verifies it
 *      arc by arc, and computes distance / cost / travel time. Identical accounting
 *      for everyone.
 *   6. The graph is fingerprinted before and after the run; if an algorithm mutated
 *      its inputs, the run is flagged.
 */

import { summarize } from '../core/metrics.js';
import { evaluatePath } from '../core/pathUtils.js';
import { pctChange, ratio } from '../core/format.js';
import { BASELINE_ID } from '../algorithms/registry.js';

/** Let the browser paint progress bars between timed runs. */
const yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Shared empty object, so an algorithm with no tunables allocates nothing. */
const EMPTY_OPTIONS = Object.freeze({});

/**
 * @param {object} opts
 * @param {object} opts.testCase              from `buildTestCase()`
 * @param {Array<object>} opts.algorithms     registered algorithm objects
 * @param {number} [opts.repeats=5]           measured repetitions per algorithm
 * @param {number} [opts.warmup=1]            discarded warm-up runs per algorithm
 * @param {Object<string,object>} [opts.options] per-algorithm tunable values, keyed by
 *                                            algorithm id, forwarded to prepare()/solve()
 * @param {(fraction:number, label:string) => void} [opts.onProgress]
 * @returns {Promise<object>} aggregate results
 */
export async function runBenchmark({
  testCase,
  algorithms,
  repeats = 5,
  warmup = 1,
  options = {},
  onProgress = () => {},
}) {
  const { graph, start, goal } = testCase;
  const reps = Math.max(1, Math.floor(repeats));
  const warmups = Math.max(0, Math.floor(warmup));
  const optionsFor = (alg) => options[alg.id] || EMPTY_OPTIONS;
  const fingerprintBefore = graphFingerprint(graph);

  // ---- 1. preprocessing (untimed) -----------------------------------------
  const contexts = new Map();
  for (const alg of algorithms) {
    let context = null;
    let prepMs = 0;
    if (typeof alg.prepare === 'function') {
      const t0 = performance.now();
      context = alg.prepare(graph, testCase.costModel, optionsFor(alg));
      prepMs = performance.now() - t0;
    }
    contexts.set(alg.id, { context, prepMs });
  }

  // ---- 2. warm-up (discarded) ---------------------------------------------
  const totalSteps = reps * algorithms.length;
  let step = 0;
  for (let w = 0; w < warmups; w++) {
    for (const alg of algorithms) {
      alg.solve(graph, start, goal, testCase.costModel, contexts.get(alg.id).context, optionsFor(alg));
    }
    onProgress(0, `Warming up (${w + 1}/${warmups})`);
    await yieldToUi();
  }

  // ---- 3. measured runs ---------------------------------------------------
  /** @type {Map<string, Array<object>>} */
  const runs = new Map(algorithms.map((a) => [a.id, []]));

  for (let r = 0; r < reps; r++) {
    // Alternate direction each repetition to cancel ordering bias.
    const order = r % 2 === 0 ? algorithms : [...algorithms].reverse();

    for (const alg of order) {
      const { context } = contexts.get(alg.id);
      const t0 = performance.now();
      const result = alg.solve(graph, start, goal, testCase.costModel, context, optionsFor(alg));
      const ms = performance.now() - t0;

      runs.get(alg.id).push({ ms, result });
      step++;
      onProgress(step / totalSteps, `${alg.name} · repetition ${r + 1}/${reps}`);
      await yieldToUi();
    }
  }

  // ---- 4. independent verification & measurement of every returned path ----
  const results = algorithms.map((alg) => {
    const entries = runs.get(alg.id);
    const representative = entries[0];
    const { prepMs } = contexts.get(alg.id);

    const evaluated = entries.map((entry) => {
      const hasPath = entry.result && entry.result.path && entry.result.path.length > 0;
      const ev = evaluatePath(graph, testCase.costModel, hasPath ? entry.result.path : null, start, goal);
      return { ...ev, found: !!(entry.result && entry.result.found) };
    });

    const repEval = evaluated[0];
    const repResult = representative.result || {};

    const allFound = evaluated.every((e) => e.found);
    const allValid = evaluated.every((e) => e.valid);
    const anyFound = evaluated.some((e) => e.found);

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
      valid: allValid,
      validPath: repEval.valid,
      reason: repEval.reason || '',

      path: repEval.valid ? representative.result.path : null,
      exploredNodes: repResult.exploredNodes || null,

      time: summarize(entries.map((e) => e.ms)),
      nodesExplored: summarize(entries.map((e) => (e.result ? e.result.nodesExplored : NaN))),
      nodesExpanded: summarize(entries.map((e) => (e.result ? e.result.nodesExpanded : NaN))),
      arcsRelaxed: summarize(entries.map((e) => (e.result ? e.result.arcsRelaxed : NaN))),

      distance: summarize(evaluated.map((e) => e.distance)),
      cost: summarize(evaluated.map((e) => e.cost)),
      travelTime: summarize(evaluated.map((e) => e.time)),

      repDistance: repEval.distance,
      repCost: repEval.cost,
      repTravelTime: repEval.time,

      /** True when every repetition produced the same route cost. */
      deterministic: isConstant(evaluated.map((e) => e.cost)),

      runs: entries.map((entry, i) => ({
        index: i + 1,
        ms: entry.ms,
        found: evaluated[i].found,
        valid: evaluated[i].valid,
        nodesExplored: entry.result ? entry.result.nodesExplored : NaN,
        nodesExpanded: entry.result ? entry.result.nodesExpanded : NaN,
        arcsRelaxed: entry.result ? entry.result.arcsRelaxed : NaN,
        distance: evaluated[i].distance,
        cost: evaluated[i].cost,
        travelTime: evaluated[i].time,
      })),
    };
  });

  // ---- 5. fairness guard --------------------------------------------------
  const fingerprintAfter = graphFingerprint(graph);
  const mutated = !fingerprintsMatch(fingerprintBefore, fingerprintAfter);

  onProgress(1, 'Done');

  return {
    testCase,
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
//  Comparison against the baseline
// ===========================================================================

/**
 * Express every algorithm as a delta against the baseline (standard A*).
 * Negative percentages mean "less than the baseline"; lower is better for all
 * metrics except `speedup`, where higher is better.
 */
export function compareResults(results, baselineId = BASELINE_ID) {
  const baseline = results.find((r) => r.id === baselineId) || null;

  const rows = results.map((r) => {
    const isBaseline = !!baseline && r.id === baseline.id;
    if (!baseline || isBaseline) {
      return {
        id: r.id, name: r.name, color: r.color, isBaseline,
        comparable: false,
        timeDeltaPct: NaN, speedup: NaN, exploredDeltaPct: NaN,
        expandedDeltaPct: NaN, arcsDeltaPct: NaN,
        costDeltaPct: NaN, distanceDeltaPct: NaN,
        sameRoute: isBaseline, betterRoute: false,
      };
    }

    const comparable =
      Number.isFinite(r.time.avg) &&
      Number.isFinite(baseline.time.avg) &&
      Number.isFinite(r.cost.avg) &&
      Number.isFinite(baseline.cost.avg);

    const sameRoute = samePath(r.path, baseline.path);
    const costDeltaPct = pctChange(r.cost.avg, baseline.cost.avg);

    return {
      id: r.id,
      name: r.name,
      color: r.color,
      isBaseline: false,
      comparable,
      timeDeltaPct: pctChange(r.time.avg, baseline.time.avg),
      speedup: ratio(baseline.time.avg, r.time.avg),
      exploredDeltaPct: pctChange(r.nodesExplored.avg, baseline.nodesExplored.avg),
      expandedDeltaPct: pctChange(r.nodesExpanded.avg, baseline.nodesExpanded.avg),
      arcsDeltaPct: pctChange(r.arcsRelaxed.avg, baseline.arcsRelaxed.avg),
      costDeltaPct,
      distanceDeltaPct: pctChange(r.distance.avg, baseline.distance.avg),
      sameRoute,
      // With an admissible heuristic, A* is optimal — a negative cost delta means
      // the other algorithm found a genuinely cheaper route (weighted / suboptimal
      // search, or a relaxed optimality guarantee).
      betterRoute: Number.isFinite(costDeltaPct) && costDeltaPct < -1e-6,
    };
  });

  return {
    baselineId: baseline ? baseline.id : null,
    baselineName: baseline ? baseline.name : null,
    rows,
  };
}

// ===========================================================================
//  Helpers
// ===========================================================================

function samePath(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isConstant(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return true;
  const first = finite[0];
  return finite.every((v) => Math.abs(v - first) < 1e-9);
}

/** Cheap signature of the mutable parts of the graph. */
export function graphFingerprint(graph) {
  let traffic = 0;
  let closed = 0;
  let elevation = 0;
  for (let e = 0; e < graph.edgeCount; e++) {
    traffic += graph.edgeTraffic[e];
    if (graph.edgeClosed[e] === 1) closed++;
  }
  for (let i = 0; i < graph.nodeCount; i++) elevation += graph.elevation[i];
  return { traffic, closed, elevation };
}

export function fingerprintsMatch(a, b) {
  const close = (x, y) => Math.abs(x - y) < 1e-6;
  return close(a.traffic, b.traffic) && a.closed === b.closed && close(a.elevation, b.elevation);
}
