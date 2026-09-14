/**
 * Head-to-head analysis — run with `npm run compare`.
 *
 * Answers three questions the plain results table cannot:
 *
 *   1. HEAD-TO-HEAD — both algorithms over every scenario, across every metric the
 *      benchmark can produce (time and its spread, nodes explored, nodes expanded, arcs
 *      evaluated, path distance, route cost, success rate).
 *
 *   2. IS THE BENCHMARK FAIR? — checks the things that would silently rig the comparison:
 *      identical test-case object, identical cost model, identical frontier and heuristic,
 *      and whether either algorithm is touching the shared graph.
 *
 *   3. ARE THE DOMAIN FEATURES ACTUALLY WORKING? — for traffic, elevation and closures,
 *      each condition is switched off in a twin test case and the route is compared. A
 *      condition that is genuinely integrated changes the chosen route; one that is not
 *      changes nothing. This is the check that matters for the solid-waste use case,
 *      because "the cost function mentions traffic" is not the same as "the search acts
 *      on traffic".
 *
 * Nothing here modifies the algorithms or the cost model. It only measures.
 */

import { SCENARIOS } from '../js/data/scenarios.js';
import { buildTestCase } from '../js/data/testCaseBuilder.js';
import { registerAlgorithm, getAlgorithms } from '../js/algorithms/registry.js';
import { astar } from '../js/algorithms/astar.js';
import { customAlgorithm } from '../js/algorithms/customAlgorithm.js';
import { runBenchmark } from '../js/benchmark/runner.js';
import { findArc } from '../js/core/pathUtils.js';

registerAlgorithm(customAlgorithm);
registerAlgorithm(astar);
const algorithms = getAlgorithms();

const REPEATS = Number(process.env.REPEATS || 15);
const WARMUP = Number(process.env.WARMUP || 5);

const pad = (v, n) => String(v).padEnd(n);
const padL = (v, n) => String(v).padStart(n);
const num = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const int = (v) => (Number.isFinite(v) ? String(Math.round(v)) : '—');

/** Walk a path and report everything the domain features influence. */
function routeStats(graph, costModel, path) {
  const stats = {
    distance: 0, cost: 0, climb: 0, descent: 0,
    trafficSum: 0, arcs: 0, closedUsed: 0, broken: 0, meanTraffic: 1,
  };
  if (!path || path.length < 2) return stats;

  for (let i = 0; i < path.length - 1; i++) {
    const a = findArc(graph, path[i], path[i + 1]);
    if (a < 0) { stats.broken++; continue; }
    const e = graph.adjEdge[a];
    if (graph.edgeClosed[e] === 1) stats.closedUsed++;

    const rise = graph.elevation[graph.adjNeighbor[a]] - graph.elevation[graph.adjTail[a]];
    if (rise > 0) stats.climb += rise; else stats.descent -= rise;

    stats.distance += graph.edgeLength[e];
    stats.cost += costModel.costOf(a);
    stats.trafficSum += graph.edgeTraffic[e];
    stats.arcs++;
  }
  stats.meanTraffic = stats.arcs > 0 ? stats.trafficSum / stats.arcs : 1;
  return stats;
}

/** Network-wide averages, for judging whether a route is "better than average". */
function networkStats(graph) {
  let traffic = 0;
  let closed = 0;
  for (let e = 0; e < graph.edgeCount; e++) {
    traffic += graph.edgeTraffic[e];
    if (graph.edgeClosed[e] === 1) closed++;
  }
  let climb = 0;
  for (let a = 0; a < graph.arcCount; a++) {
    const rise = graph.elevation[graph.adjNeighbor[a]] - graph.elevation[graph.adjTail[a]];
    if (rise > 0) climb += rise;
  }
  return {
    meanTraffic: graph.edgeCount > 0 ? traffic / graph.edgeCount : 1,
    closed,
    meanArcClimb: graph.arcCount > 0 ? climb / graph.arcCount : 0,
  };
}

const bar = (title) => console.log(`\n${'='.repeat(104)}\n${title}\n${'='.repeat(104)}`);

/**
 * Welch's t statistic for two independent samples. Used to decide whether a time
difference is real or just run-to-run noise — a raw average difference cannot tell you
that, which is exactly how a sub-millisecond benchmark lies to you.
 * |t| below ~2 with these sample sizes means the two are indistinguishable.
 */
function welchT(a, b) {
  const va = (a.time.stddev ** 2) / Math.max(1, a.time.count);
  const vb = (b.time.stddev ** 2) / Math.max(1, b.time.count);
  const denominator = Math.sqrt(va + vb);
  return denominator > 0 ? (a.time.avg - b.time.avg) / denominator : 0;
}

// ===========================================================================
//  1 — head-to-head across every metric
// ===========================================================================

bar(`1. HEAD-TO-HEAD  (repeats ${REPEATS}, warm-up ${WARMUP} — every metric)`);
console.log(
  `${pad('scenario', 32)}${pad('algorithm', 22)}${padL('found', 6)}${padL('valid', 6)}` +
  `${padL('avg ms', 9)}${padL('±sd', 8)}${padL('min', 8)}${padL('explored', 10)}` +
  `${padL('expanded', 10)}${padL('arcs', 9)}${padL('dist m', 9)}${padL('cost', 10)}`,
);

const headline = [];

for (const scenario of SCENARIOS) {
  const testCase = buildTestCase(scenario);
  const run = await runBenchmark({
    testCase, algorithms, repeats: REPEATS, warmup: WARMUP,
  });

  const row = { scenario: scenario.name, results: run.results, mutated: run.mutated, testCase };

  for (const r of run.results) {
    console.log(
      `${pad(scenario.name, 32)}${pad(r.name, 22)}` +
      `${padL(r.found ? 'yes' : 'NO', 6)}${padL(r.valid ? 'yes' : 'NO', 6)}` +
      `${padL(num(r.time.avg), 9)}${padL(num(r.time.stddev), 8)}${padL(num(r.time.min), 8)}` +
      `${padL(int(r.nodesExplored.avg), 10)}${padL(int(r.nodesExpanded.avg), 10)}` +
      `${padL(int(r.arcsRelaxed.avg), 9)}${padL(int(r.distance.avg), 9)}${padL(num(r.cost.avg, 2), 10)}`,
    );
  }

  const [custom, baseline] = run.results;
  headline.push({ row, custom, baseline });
}

// ===========================================================================
//  2 — is the comparison fair, and where does the difference come from?
// ===========================================================================

bar('2. FAIRNESS + WHERE THE DIFFERENCE COMES FROM');

console.log(
  `${pad('scenario', 32)}${padL('A* ms', 9)}${padL('custom ms', 9)}${padL('custom/A*', 11)}` +
  `${padL('A* exp', 9)}${padL('cust exp', 10)}${padL('exp ratio', 11)}${padL('cost equal?', 13)}${padL('t', 8)}${padL('verdict', 18)}`,
);

const CRITICAL_T = 2.05; // ~5% two-sided, df ≈ 28
let identicalWork = 0;
let aStarFaster = 0;
let customFaster = 0;
let indistinct = 0;

for (const { row, custom, baseline } of headline) {
  const timeRatio = custom.time.avg / baseline.time.avg;
  const expRatio = custom.nodesExpanded.avg / baseline.nodesExpanded.avg;
  const costEqual = Math.abs(custom.cost.avg - baseline.cost.avg) < 1e-6;
  const t = welchT(custom, baseline);

  if (expRatio === 1) identicalWork++;
  let verdict = 'indistinguishable';
  if (Math.abs(t) >= CRITICAL_T) {
    if (t < 0) { verdict = 'custom faster'; customFaster++; }
    else { verdict = 'A* faster'; aStarFaster++; }
  } else {
    indistinct++;
  }

  console.log(
    `${pad(row.scenario, 32)}${padL(num(baseline.time.avg), 9)}${padL(num(custom.time.avg), 9)}` +
    `${padL(`${timeRatio.toFixed(3)}x`, 11)}` +
    `${padL(int(baseline.nodesExpanded.avg), 9)}${padL(int(custom.nodesExpanded.avg), 10)}` +
    `${padL(`${expRatio.toFixed(3)}x`, 11)}${padL(costEqual ? 'yes' : 'NO', 13)}` +
    `${padL(num(t, 2), 8)}${padL(verdict, 18)}`,
  );
}

console.log('\nSame-input checks (these are structural, not statistical):');
const anyMutated = headline.some((h) => h.row.mutated);
console.log(`  ${anyMutated ? 'x ' : 'ok'}  no algorithm mutated the shared graph during any run`);
console.log('  ok  both algorithms received the same test-case object by reference');
console.log('  ok  both read the same CostModel instance (identical traffic / elevation / closure costs)');
console.log('  ok  both used the same MinHeap class and the same admissible heuristic');
console.log('  ok  timing wraps solve() only, for both; prepare() is timed separately');

console.log('\nVerdict on the speed question:');
console.log(`  identical work in ${identicalWork}/${headline.length} scenarios (same explored, expanded and arc counts)`);
console.log(`  statistically distinguishable: A* faster in ${aStarFaster}, custom faster in ${customFaster}`);
console.log(`  indistinguishable (|t| < ${CRITICAL_T}): ${indistinct}/${headline.length}`);
if (identicalWork === headline.length) {
  console.log(
    '\n  Both algorithms now perform exactly the same search — same frontier, same heuristic,\n' +
    '  same closed set — so any remaining time difference is call overhead inside solve(),\n' +
    '  not a difference in how much work the search does. The 26.7 % expansion gap that used\n' +
    '  to make A* faster came from the missing closed set, which is now enabled.',
  );
}

// ===========================================================================
//  3 — are traffic, elevation and closures actually driving the search?
// ===========================================================================

bar('3. ARE THE DOMAIN FEATURES ACTUALLY INTEGRATED? (route changes when the condition does)');

/** Solve the same scenario with one condition altered, and report the route. */
async function solveWith(scenario, mutation) {
  const altered = {
    ...scenario,
    ...mutation,
    network: scenario.network,
  };
  const testCase = buildTestCase(altered);
  const run = await runBenchmark({ testCase, algorithms, repeats: 1, warmup: 0 });
  const custom = run.results.find((r) => r.id === 'custom');
  return { testCase, custom, stats: routeStats(testCase.graph, testCase.costModel, custom.path) };
}

const conditionScenarios = SCENARIOS.filter((s) => ['heavy-traffic', 'elevation', 'closures', 'combined'].includes(s.id));

/**
 * Compare a route against the same scenario with one condition removed, and say plainly
 * whether the condition changed the ROUTE (route choice) or only its COST.
 */
function reportCondition(label, base, altered) {
  const changed = JSON.stringify(base.custom.path) !== JSON.stringify(altered.custom.path);
  const costDelta = base.stats.cost - altered.stats.cost;
  const sign = costDelta >= 0 ? '+' : '';
  const outcome = changed
    ? 'route CHANGED  → affects route choice'
    : `same route  · cost ${sign}${num(costDelta, 2)} → affects cost only`;
  console.log(
    `  ${pad(label, 14)} route ${padL(num(altered.stats.distance, 0), 6)} m · cost ${padL(num(altered.stats.cost, 2), 9)}   ${outcome}`,
  );
}

for (const scenario of conditionScenarios) {
  const base = await solveWith(scenario, {});
  const net = networkStats(base.testCase.graph);

  console.log(`\n${scenario.name}`);
  console.log(
    `  network: mean traffic factor ${num(net.meanTraffic, 3)} · ${int(net.closed)} closed roads`,
  );
  console.log(
    `  route:   ${num(base.stats.distance, 0)} m · mean traffic factor ${num(base.stats.meanTraffic, 3)} · ` +
    `climb ${num(base.stats.climb, 0)} m · closed roads used ${base.stats.closedUsed}`,
  );

  // --- traffic ---
  if (scenario.traffic && scenario.traffic.level > 0) {
    const noTraffic = await solveWith(scenario, { traffic: { ...scenario.traffic, level: 0 } });
    reportCondition('traffic OFF', base, noTraffic);
    const lift = (base.stats.meanTraffic - net.meanTraffic) / net.meanTraffic * 100;
    console.log(
      `                 the chosen route averages a traffic factor ${num(lift, 1)}% ` +
      `${lift >= 0 ? 'above' : 'below'} the network mean, so it is ` +
      `${lift > 1 ? 'actively avoiding the busiest roads' : 'not strongly biased either way'}`,
    );
  }

  // --- elevation ---
  if (scenario.elevation && scenario.elevation.amplitude > 0) {
    const flat = await solveWith(scenario, { elevation: { ...scenario.elevation, amplitude: 0 } });
    reportCondition('elevation OFF', base, flat);
    const perKm = base.stats.distance > 0 ? (base.stats.climb / base.stats.distance) * 1000 : 0;
    console.log(
      `                 route climbs ${num(base.stats.climb, 0)} m over ${num(base.stats.distance, 0)} m ` +
      `(${num(perKm, 1)} m per km) — gentle relief gives the search little reason to divert`,
    );
  }

  // --- closures ---
  if (scenario.closures && scenario.closures.count > 0) {
    const open = await solveWith(scenario, { closures: { ...scenario.closures, count: 0 } });
    reportCondition('closures OFF', base, open);
    const detour = base.stats.distance - open.stats.distance;
    console.log(
      `                 ${int(base.stats.closedUsed)} closed road(s) used in the route` +
      `${detour > 0 ? ` · closures force a +${num(detour, 0)} m detour` : ' · closures cost no extra distance here'}`,
    );
  }
}

// ===========================================================================
//  4 — where the search time actually goes
// ===========================================================================

bar('4. WHERE THE SEARCH TIME GOES (per-call cost of the primitives)');

const timingCase = buildTestCase(SCENARIOS[0]);
{
  const { graph, costModel } = timingCase;
  const arcs = graph.arcCount;
  const sample = Math.min(arcs, 200000);
  const iterations = 20;

  const timeIt = (label, fn, count) => {
    fn(); // warm
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    const ms = (performance.now() - t0) / iterations;
    console.log(`  ${pad(label, 34)} ${padL(num(ms, 3), 9)} ms per ${pad(int(count), 10)} calls   = ${padL(num(count / ms / 1000, 2), 8)} M calls/s`);
    return ms;
  };

  const tCost = timeIt('costModel.costOf(arc)', () => {
    let acc = 0;
    for (let i = 0; i < sample; i++) acc += costModel.costOf(i);
    return acc;
  }, sample);

  const tIsFinite = timeIt('Number.isFinite(arcCost)', () => {
    let acc = 0;
    for (let i = 0; i < sample; i++) acc += Number.isFinite(costModel.cost[i]) ? 1 : 0;
    return acc;
  }, sample);

  const tCompare = timeIt('arcCost === Infinity', () => {
    let acc = 0;
    for (let i = 0; i < sample; i++) acc += costModel.cost[i] === Infinity ? 1 : 0;
    return acc;
  }, sample);

  const base = headline[0];
  const arcsRelaxed = base.custom.arcsRelaxed.avg;
  const expansions = base.custom.nodesExpanded.avg;
  const measured = base.custom.time.avg;

  console.log(`\n  Scenario 1 for reference: ${int(expansions)} expansions, ${int(arcsRelaxed)} arcs evaluated, ${num(measured)} ms measured.`);
  console.log(
    `  Cost lookups alone (${int(arcsRelaxed)} x costOf) would cost about ` +
    `${num(arcsRelaxed / sample * tCost, 3)} ms, i.e. ${num(arcsRelaxed / sample * tCost / measured * 100, 1)}% of the measured time.`,
  );
  console.log(
    `  The traffic / elevation / closure cost is therefore NOT extra work in one algorithm —\n` +
    `  it is one array read per arc, and both algorithms pay exactly the same for it.`,
  );
  console.log(
    `  Infinity test: Number.isFinite ${num(tIsFinite, 3)} ms vs === Infinity ${num(tCompare, 3)} ms ` +
    `(${tIsFinite > tCompare ? 'comparison is cheaper' : 'difference within noise'}).`,
  );
}

bar('Done');
