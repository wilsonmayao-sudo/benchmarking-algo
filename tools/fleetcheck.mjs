/**
 * Fleet simulation self-check — run with `npm run fleetcheck` (part of `npm run check`).
 *
 * Asserts that every feature actually works, headlessly, on the sample scenario plus a
 * few purpose-built edge cases:
 *   A*         optimal (matches Dijkstra), heuristic admissible, never uses a closed road
 *   events     closures reroute trucks, unreachable targets block (no crash), reopen unblocks
 *   capacity   no truck ever exceeds max_capacity, handoff + pending queue happen
 *   ETA        computed for every truck, recomputed on events, label format
 *   metrics    every required metric present, CSV/JSON export, deterministic runs
 *   config     generated and GeoJSON maps load with random bins / random events
 */

import { readFileSync } from 'node:fs';
import { loadScenario } from '../js/sim/config/scenarioLoader.js';
import { Simulation } from '../js/sim/simulation.js';
import { astarSearch, euclideanHeuristic } from '../js/sim/routing/astar.js';
import { RoadState } from '../js/sim/routing/roadState.js';
import { toCSV, toJSON } from '../js/sim/metrics.js';
import { fmtDuration } from '../js/sim/fleet/eta.js';
import { etaLines } from '../js/fleetui/mapView.js';
import { mulberry32, randInt } from '../js/core/rng.js';

let failures = 0;
let passes = 0;
function check(name, ok, detail = '') {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sample = JSON.parse(readFileSync('data/scenarios/sample-fleet.json', 'utf8'));
const readText = async (p) => readFileSync(p, 'utf8');

/** Run a sim to the end while checking per-tick invariants. */
function runChecked(sim) {
  const lastArc = new Map();
  let overCapacity = null;
  let closedEntry = null;
  while (!sim.finished) {
    sim.step();
    for (const t of sim.trucks) {
      if (t.load > t.maxCapacity + 1e-9 && !overCapacity) overCapacity = `${t.name} ${t.load}/${t.maxCapacity} at ${sim.time}s`;
      const a = t.arcs.length > 0 && t.arcPos > 0 ? t.arcs[0] : -1;
      if (a >= 0 && a !== lastArc.get(t.id) && sim.road.isClosed(sim.graph.adjEdge[a]) && !closedEntry) {
        closedEntry = `${t.name} entered closed road ${sim.world.edgeLabel(sim.graph.adjEdge[a])} at ${sim.time}s`;
      }
      lastArc.set(t.id, a);
    }
  }
  return { overCapacity, closedEntry };
}

// ===========================================================================
console.log('\nA* (js/sim/routing/astar.js)');
{
  const world = await loadScenario(sample);
  const g = world.graph;
  const road = new RoadState(g);
  road.close(0);
  road.applyDelay(5, 3);
  const weight = (a) => road.arcWeight(a);
  const h = euclideanHeuristic(g, road.heuristicScale());
  const zero = () => 0; // A* with h = 0 is Dijkstra → ground truth
  const rng = mulberry32(99);
  let optimal = true, admissible = true, avoidsClosed = true, fewer = 0;
  for (let k = 0; k < 200; k++) {
    const s = randInt(rng, g.nodeCount), t = randInt(rng, g.nodeCount);
    const a = astarSearch(g, s, t, { weight, heuristic: h });
    const d = astarSearch(g, s, t, { weight, heuristic: zero });
    if (a.found !== d.found || (a.found && Math.abs(a.cost - d.cost) > 1e-6)) optimal = false;
    if (d.found && h(s, t) > d.cost + 1e-9) admissible = false;
    if (a.found && a.arcs.some((arc) => g.adjEdge[arc] === 0)) avoidsClosed = false;
    if (a.nodesExpanded <= d.nodesExpanded) fewer++;
  }
  check('returns the same optimal cost as Dijkstra on 200 random pairs', optimal);
  check('Euclidean heuristic never overestimates (admissible)', admissible);
  check('never routes over a closed road', avoidsClosed);
  check('expands no more nodes than Dijkstra', fewer === 200, `${fewer}/200`);
  const iso = astarSearch(g, 0, 0, { weight, heuristic: h });
  check('start === goal returns a trivial path', iso.found && iso.path.length === 1);
}

// ===========================================================================
console.log('\nSample scenario (data/scenarios/sample-fleet.json)');
const world = await loadScenario(sample);
check('has ≥ 3 trucks, ≥ 15 bins, ≥ 2 scheduled closures',
  world.trucks.length >= 3 && world.bins.length >= 15 &&
  world.events.filter((e) => e.type === 'ROAD_CLOSURE' && e.source === 'schedule').length >= 2);

const sim = new Simulation(world);
check('every truck has an ETA after the initial plan', sim.trucks.every((t) => t.eta && Number.isFinite(t.eta.nextAt)));
const recalcsBefore = sim.metrics.etaRecalcs;
const { overCapacity, closedEntry } = runChecked(sim);
const s = sim.summary();

check('all 15 bins collected', s.binsCollected === 15 && s.binsMissed === 0, `${s.binsCollected}/${s.bins}`);
check('no truck ever exceeds max_capacity', !overCapacity, overCapacity || '');
check('no truck ever enters a closed road', !closedEntry, closedEntry || '');
check('road closures were applied and logged with timestamp + edge',
  sim.eventLog.filter((e) => e.type === 'ROAD_CLOSURE').length >= 2 &&
  sim.eventLog.every((e) => typeof e.clock === 'string' && e.edge && Array.isArray(e.rerouted)));
check('a closure rerouted at least one truck',
  sim.eventLog.some((e) => e.type === 'ROAD_CLOSURE' && e.rerouted.length > 0));
check('reroutes caused by events are counted', s.reroutes >= 1, `reroutes = ${s.reroutes}`);
check('a truck with no route is flagged BLOCKED (warning, no crash)',
  s.blockedIncidents >= 1 && sim.logEntries.some((e) => e.kind === 'warning' && /BLOCKED/.test(e.text)));
check('a reopen unblocks the trapped truck', sim.eventLog.some((e) => e.type === 'ROAD_REOPEN' && e.unblocked.length > 0));
check('capacity handoff logged as "Truck X full → … reassigned to Truck Y"',
  sim.logEntries.some((e) => e.kind === 'handoff' && /^Truck \d full.*→ .* reassigned to Truck \d/.test(e.text)));
check('a bin went to the pending queue and was later assigned',
  sim.logEntries.some((e) => e.kind === 'pending') && sim.logEntries.some((e) => /^Pending .* assigned to/.test(e.text)));
check('bin reassignments counted', s.reassignments >= 1, `reassignments = ${s.reassignments}`);
check('ETA recalculated during the run (events, reroutes, assignments)', sim.metrics.etaRecalcs > recalcsBefore + 10);
check('every A* call recorded with time and nodes expanded',
  s.astarCalls === sim.router.stats.samples.length && s.astarCalls > 0 && s.nodesExpandedAvg > 0 && s.astarAvgMs >= 0);
const required = ['totalDistanceM', 'makespanS', 'astarCalls', 'astarAvgMs', 'nodesExpandedAvg', 'reroutes',
  'reassignments', 'binsCollected', 'binsMissed'];
check('summary has every required metric', required.every((k) => Number.isFinite(s[k])),
  required.filter((k) => !Number.isFinite(s[k])).join(', '));

// ETA label format
const t0 = new Simulation(world).trucks[0];
check('ETA label reads "Truck 1 → Bin N: ETA x min y s"', /^Truck 1 → Bin \d+: ETA (\d+ min )?\d+ s$/.test(etaLines(t0, 0)[0]), etaLines(t0, 0)[0]);
check('fmtDuration(270) === "4 min 30 s"', fmtDuration(270) === '4 min 30 s');

// Export
const csv = toCSV([s, s]);
check('CSV export: header + one row per run', csv.trim().split('\n').length === 3 && csv.startsWith('scenario,'));
const json = JSON.parse(JSON.stringify(toJSON(sim)));
check('JSON export round-trips with summary, trucks, bins, eventLog',
  json.summary.binsCollected === 15 && json.trucks.length === 3 && json.bins.length === 15 && json.eventLog.length > 0);

// Determinism
const again = new Simulation(await loadScenario(sample)).run();
const strip = ({ astarAvgMs, astarTotalMs, simWallMs, ...rest }) => rest;
check('two runs of the same config are identical (excluding wall-clock timings)',
  JSON.stringify(strip(again)) === JSON.stringify(strip(s)));

// ===========================================================================
console.log('\nVariants and edge cases');
{
  const base = new Simulation(await loadScenario(sample, { overrides: { noEvents: true } })).run();
  check('"no events" variant: 0 events, 0 reroutes, 0 blocked', base.eventsApplied === 0 && base.reroutes === 0 && base.blockedIncidents === 0);
  const two = new Simulation(await loadScenario(sample, { overrides: { truckCount: 2 } })).run();
  check('"2 trucks" variant runs and reports 2 trucks', two.trucks === 2 && two.finished);
}
{
  // Permanent closure isolating the cul-de-sac before anyone gets there → bin missed, run ends.
  const cfg = structuredClone(sample);
  cfg.events = { scheduled: [{ time_s: 0, type: 'ROAD_CLOSURE', edge: 'H4-P1' }] };
  const sm = new Simulation(await loadScenario(cfg));
  const r = sm.run();
  check('permanently unreachable bin: run finishes, bin counted as missed, no exception',
    r.finished && r.binsMissed === 1 && sm.bins.find((b) => b.id === 'B10').state === 'missed');
}
{
  // Bin heavier than any truck → pending forever → missed (not an infinite loop).
  const cfg = structuredClone(sample);
  cfg.events = [];
  cfg.bins.push({ id: 'B99', node: 'D4', fill: 100, capacity_kg: 5000 });
  const r = new Simulation(await loadScenario(cfg)).run();
  check('bin no truck can carry ends as missed', r.finished && r.binsMissed === 1);
}
{
  const cfg = {
    name: 'generated', seed: 5,
    map: { type: 'generated', network: { type: 'grid', targetNodes: 600 } },
    depot: { at: [0.5, 0.5] },
    trucks: [{ id: 'T1', max_capacity: 600 }, { id: 'T2', max_capacity: 600 }, { id: 'T3', max_capacity: 600 }],
    bins: { random: { count: 20, fill: [20, 100] } },
    events: { random: { enabled: true, count: 6, window_s: [0, 1800], types: { ROAD_CLOSURE: 0.5, TRAFFIC_DELAY: 0.5 } } },
  };
  const r = new Simulation(await loadScenario(cfg)).run();
  check('generated map + random bins + random events', r.finished && r.bins === 20 && r.events === 6, JSON.stringify({ c: r.binsCollected, f: r.finishReason }));
}
{
  const cfg = {
    name: 'naga', seed: 3,
    map: { type: 'geojson', path: 'data/Naga_City_roads.geojson' },
    depot: { at: [0.5, 0.5] },
    trucks: [{ id: 'T1' }, { id: 'T2' }],
    bins: { random: { count: 10 } },
    events: { random: { enabled: true, count: 3, window_s: [0, 900] } },
  };
  const r = new Simulation(await loadScenario(cfg, { readText })).run();
  check('GeoJSON city map loads and runs', r.finished && r.bins === 10, JSON.stringify({ c: r.binsCollected, f: r.finishReason }));
}
{
  let msg = '';
  try { await loadScenario({ map: { type: 'explicit', nodes: [], edges: [] }, trucks: [], bins: [] }); } catch (e) { msg = e.message; }
  check('invalid config fails with a readable list of problems', /Scenario config is invalid/.test(msg) && /trucks/.test(msg));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
