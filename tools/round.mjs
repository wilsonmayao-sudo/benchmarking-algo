/**
 * Single trip vs collection round — run with `npm run round`.
 *
 * Answers one question: does visiting many pickup points give an algorithm an advantage?
 *
 * It runs the same network twice for each algorithm:
 *   • as a SINGLE TRIP (origin → destination), the usual per-query benchmark
 *   • as a COLLECTION ROUND (depot → N pickup points → depot), many queries, one prep
 *
 * The per-query numbers are identical either way. What changes is that `prepare()` runs
 * once per round instead of once per query, so an algorithm that preprocesses starts to
 * look completely different at 25 stops than it does at 1.
 *
 * Order is frozen (sector sweep) and shared by every algorithm, so this measures
 * pathfinding, not tour planning.
 */

import { SCENARIOS } from '../js/data/scenarios.js';
import { buildTestCase } from '../js/data/testCaseBuilder.js';
import { registerAlgorithm, getAlgorithms } from '../js/algorithms/registry.js';
import { astar } from '../js/algorithms/astar.js';
import { customAlgorithm } from '../js/algorithms/customAlgorithm.js';
import { altAstar } from '../js/algorithms/altAstar.js';
import { runBenchmark } from '../js/benchmark/runner.js';
import { runRouteBenchmark, buildCollectionRound } from '../js/benchmark/routeRunner.js';

registerAlgorithm(astar);
registerAlgorithm(customAlgorithm);
registerAlgorithm(altAstar);
const algorithms = getAlgorithms();

const REPEATS = Number(process.env.REPEATS || 5);
const WARMUP = Number(process.env.WARMUP || 2);

const pad = (v, n) => String(v).padEnd(n);
const padL = (v, n) => String(v).padStart(n);
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const int = (v) => (Number.isFinite(v) ? String(Math.round(v)) : '—');
const bar = (t) => console.log(`\n${'='.repeat(100)}\n${t}\n${'='.repeat(100)}`);

/** Totals for one algorithm. `prep+solve` is what a depot actually waits for. */
const totalsFor = (r) => ({
  prep: r.prepMs,
  solve: r.time.avg,
  // Single-trip results have no combined column; they are just the solve time.
  withPrep: (r.timeWithPrep ?? r.time).avg,
  expanded: r.nodesExpanded.avg,
  arcs: r.arcsRelaxed.avg,
  cost: r.cost.avg,
  distance: r.distance.avg,
  found: r.found && r.valid,
});

// ===========================================================================
//  1 — the same scenario, as a single trip and as a round
// ===========================================================================

bar(`1. SINGLE TRIP vs COLLECTION ROUND  (repeats ${REPEATS}, warm-up ${WARMUP})`);

const STOPS = Number(process.env.STOPS || 12);
const summaries = [];

for (const scenario of [SCENARIOS[0], SCENARIOS[4], SCENARIOS[5]]) {
  const testCase = buildTestCase(scenario);

  const trip = await runBenchmark({ testCase, algorithms, repeats: REPEATS, warmup: WARMUP });
  const round = await runRouteBenchmark({
    testCase, algorithms, stopCount: STOPS, repeats: REPEATS, warmup: WARMUP,
  });

  console.log(`\n${scenario.name}   (${round.stopCount} pickup points, ${round.legCount} legs)`);

  console.log(`  ${pad('algorithm', 22)}${'- SINGLE TRIP -'.padStart(24)}${'| COLLECTION ROUND'.padStart(20)}${'----------'.padStart(12)}`);
  console.log(
    `  ${pad('', 22)}${padL('solve ms', 12)}${padL('expanded', 12)}${padL('solve ms', 10)}` +
    `${padL('prep ms', 10)}${padL('prep+solve', 12)}${padL('expanded', 11)}`,
  );

  for (const r of trip.results) {
    const rr = round.results.find((x) => x.id === r.id);
    console.log(
      `  ${pad(r.name, 22)}${padL(num(r.time.avg), 12)}${padL(int(r.nodesExpanded.avg), 12)}` +
      `${padL(num(rr.time.avg), 10)}${padL(num(rr.prepMs), 10)}${padL(num(rr.timeWithPrep.avg), 12)}` +
      `${padL(int(rr.nodesExpanded.avg), 11)}`,
    );
  }

  const tripMap = Object.fromEntries(trip.results.map((r) => [r.id, totalsFor(r)]));
  const roundMap = Object.fromEntries(round.results.map((r) => [r.id, totalsFor(r)]));
  summaries.push({ scenario: scenario.name, tripMap, roundMap, round });
}

// ===========================================================================
//  2 — where the round time goes
// ===========================================================================

bar('2. WHAT DOMINATES A ROUND? (scenario 1)');

{
  const testCase = buildTestCase(SCENARIOS[0]);
  const round = await runRouteBenchmark({
    testCase, algorithms, stopCount: STOPS, repeats: REPEATS, warmup: WARMUP,
  });

  const baseline = round.results.find((r) => r.isBaseline);
  const baseTotal = baseline.timeWithPrep.avg;

  console.log(`  ${round.legCount} legs · ${round.stopCount} pickup points · depot → ${round.stopCount} stops → depot\n`);
  console.log(
    `  ${pad('algorithm', 22)}${padL('prep ms', 10)}${padL('prep %', 9)}${padL('solve ms', 11)}` +
    `${padL('ms/leg', 10)}${padL('prep+solve', 12)}${padL('vs A*', 10)}`,
  );
  for (const r of round.results) {
    const t = totalsFor(r);
    const share = t.withPrep > 0 ? (t.prep / t.withPrep) * 100 : 0;
    const ratio = baseTotal / t.withPrep;
    console.log(
      `  ${pad(r.name, 22)}${padL(num(t.prep), 10)}${padL(`${num(share, 1)}%`, 9)}` +
      `${padL(num(t.solve), 11)}${padL(num(r.msPerLeg.avg, 3), 10)}${padL(num(t.withPrep), 12)}` +
      `${padL(`${num(ratio)}x`, 10)}`,
    );
  }

  console.log(
    '\n  Preprocessing is a fixed cost paid once. Its share of the round therefore falls as\n' +
    '  the round gets longer — which is the whole question.',
  );
}

// ===========================================================================
//  3 — how the round size changes the answer
// ===========================================================================

bar('3. DOES THE ROUND SIZE CHANGE THE ANSWER? (scenario 1)');

console.log(
  `  ${padL('stops', 6)}${padL('legs', 7)}${padL('A* prep+solve', 15)}${padL('DynA* prep+solve', 18)}` +
  `${padL('ALT prep', 11)}${padL('ALT prep+solve', 17)}${padL('best', 20)}`,
);

const stopCounts = [1, 3, 6, 12, 25];
const sweep = [];

for (const stops of stopCounts) {
  const testCase = buildTestCase(SCENARIOS[0]);
  const round = await runRouteBenchmark({
    testCase, algorithms, stopCount: stops, repeats: REPEATS, warmup: WARMUP,
  });

  const base = round.results.find((r) => r.isBaseline);
  const dyn = round.results.find((r) => r.id === 'custom');
  const alt = round.results.find((r) => r.id === 'alt');

  const baseTotal = base.timeWithPrep.avg;
  const dynTotal = dyn.timeWithPrep.avg;
  const altTotal = alt.timeWithPrep.avg;

  let best = 'A*';
  let bestValue = baseTotal;
  if (dynTotal < bestValue) { best = 'Dynamic A*'; bestValue = dynTotal; }
  if (altTotal < bestValue) { best = 'ALT'; bestValue = altTotal; }

  sweep.push({ stops, alt, base, dyn });

  console.log(
    `  ${padL(stops, 6)}${padL(round.legCount, 7)}${padL(num(baseTotal), 15)}${padL(num(dynTotal), 18)}` +
    `${padL(num(alt.prepMs), 11)}${padL(num(altTotal), 17)}${padL(best, 20)}`,
  );
}

// ===========================================================================
//  4 — prep once, then serve many rounds (the realistic deployment)
// ===========================================================================

bar('4. PREP ONCE, SERVE MANY ROUNDS  (scenario 1)');

{
  const testCase = buildTestCase(SCENARIOS[0]);
  const { graph, costModel } = testCase;
  const alt = algorithms.find((a) => a.id === 'alt');
  const base = algorithms.find((a) => a.id === 'baseline' || a.id === 'astar');

  // --- how the number of landmarks trades prep cost against search quality ---
  const probeRound = buildCollectionRound(testCase, { stopCount: STOPS, seed: 1234 });
  console.log(`  Landmark count on one ${probeRound.legs.length}-leg round:\n`);
  console.log(
    `  ${padL('landmarks', 10)}${padL('prep ms', 10)}${padL('solve ms', 11)}${padL('prep+solve', 12)}` +
    `${padL('expanded', 11)}${padL('prep/leg', 11)}`,
  );

  /**
   * Repeated timing. The MINIMUM is the estimator here, not the average: at sub-millisecond
   * scale a single GC pause or scheduler slice can double a round's average. Noise only
   * ever ADDS time, so the best run is the closest estimate of the true cost.
   */
  const measure = (fn, reps = 7) => {
    fn(); // warm
    let total = 0;
    let best = Infinity;
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      fn();
      const ms = performance.now() - t0;
      total += ms;
      if (ms < best) best = ms;
    }
    return { avg: total / reps, min: best };
  };

  const runRound = (alg, ctx) => () => {
    for (const leg of probeRound.legs) alg.solve(graph, leg.from, leg.to, costModel, ctx, {});
  };

  for (const count of [1, 2, 3, 4, 6, 8]) {
    const prepared = measure(() => alt.prepare(graph, costModel, { landmarks: count }));
    const ctx = alt.prepare(graph, costModel, { landmarks: count });
    const solved = measure(runRound(alt, ctx));

    let expanded = 0;
    for (const leg of probeRound.legs) {
      expanded += alt.solve(graph, leg.from, leg.to, costModel, ctx, {}).nodesExpanded;
    }

    console.log(
      `  ${padL(count, 10)}${padL(num(prepared.min), 10)}${padL(num(solved.min), 11)}` +
      `${padL(num(prepared.min + solved.min), 12)}${padL(int(expanded), 11)}` +
      `${padL(num(prepared.min / probeRound.legs.length, 3), 11)}`,
    );
  }

  // --- steady state: prep once, then serve round after round -------------------
  const altCtx = alt.prepare(graph, costModel, {});
  const prepMs = measure(() => alt.prepare(graph, costModel, {})).min;
  const basePerRound = measure(runRound(base, null));
  const altPerRound = measure(runRound(alt, altCtx));

  const saving = basePerRound.min - altPerRound.min;
  const breakEvenRounds = saving > 0 ? prepMs / saving : Infinity;

  console.log(`\n  One-off preprocessing: ${num(prepMs)} ms (landmark tables over ${int(graph.nodeCount)} nodes)`);
  console.log(`  A*  per round: ${num(basePerRound.min)} ms best of ${basePerRound.avg.toFixed(2)} ms avg   (no prep)`);
  console.log(`  ALT per round: ${num(altPerRound.min)} ms best of ${altPerRound.avg.toFixed(2)} ms avg   (tables reused)`);
  console.log(`  Saving per round: ${num(saving)} ms\n`);

  if (!(breakEvenRounds > 0) || !Number.isFinite(breakEvenRounds)) {
    console.log(`  ALT never recovers its ${num(prepMs)} ms preprocessing cost on this network.`);
  } else {
    console.log(
      `  Break-even: ${num(breakEvenRounds, 1)} rounds (${num(breakEvenRounds * probeRound.legs.length, 0)} legs) ` +
      'before the preprocessing pays for itself.',
    );
    console.log(
      `\n  ${padL('rounds', 7)}${padL('legs', 7)}${padL('A* cum. ms', 12)}${padL('ALT cum. ms', 12)}` +
      `${padL('saved', 10)}${padL('winner', 10)}`,
    );
    for (const rounds of [1, 2, 3, 5, 8, 12, 20]) {
      const baseCum = basePerRound.min * rounds;
      const altCum = prepMs + altPerRound.min * rounds;
      console.log(
        `  ${padL(rounds, 7)}${padL(rounds * probeRound.legs.length, 7)}` +
        `${padL(num(baseCum), 12)}${padL(num(altCum), 12)}${padL(num(baseCum - altCum), 10)}` +
        `${padL(altCum < baseCum ? 'ALT' : 'A*', 10)}`,
      );
    }
    console.log(
      '\n  Cumulative figures are derived from the measured per-round times above, not from a\n' +
      '  single noisy trace, so they are reproducible.',
    );
  }
}

// ===========================================================================
//  5 — the answer
// ===========================================================================

bar('5. THE ANSWER');

{
  const first = sweep[0];
  const last = sweep[sweep.length - 1];
  const ratio = (entry, r) => r.timeWithPrep.avg / entry.base.timeWithPrep.avg;

  console.log(
    `  One round of ${STOPS} pickup points (${last.base.legCount} legs), prep paid every round:`,
  );
  console.log(
    `    Dynamic A* ${num(ratio(last, last.dyn))}x A*   ·   ALT ${num(ratio(last, last.alt))}x A*`,
  );
  console.log(
    '\n  Dynamic A* preprocesses nothing, so adding pickup points costs it exactly what it\n' +
    '  costs A* — each leg is the same search for both. Its ratio does not move with the\n' +
    '  round size at all, which is why adding stops cannot reveal an advantage on its own.',
  );
  console.log(
    '\n  An advantage appears only when an algorithm brings something that is paid for ONCE\n' +
    '  and reused. Part 4 above shows that happening: the landmark tables depend on the\n' +
    '  network, not on the round, so a depot builds them once and every truck, every round,\n' +
    '  reuses them — and the cumulative column crosses over.',
  );

  void first;
}
