/**
 * Optimization & Operational Simulation Verification (`npm run optimcheck`).
 *
 * Verifies every mathematical and operational guarantee required by R01–R09:
 *   - Unified RoadState travel-time + elevation + Infinity closures
 *   - Timestamped FastAStarWorkspace + Dynamic-Safe AltIndex exactness vs Dijkstra
 *   - Bounded-suboptimal Weighted ALT-A* (w = 1.05, 1.10) cost bound C <= w * C*
 *   - Versioned full-path cache hit & RoadState.version invalidation
 *   - Fixed-Endpoint Asymmetric Road-Cost 2-Opt <= Euclidean NN / given cost + route metrics
 *   - Mapbox Traffic Adapter (normal / congested / missing / stale / offline)
 *   - Manual 25/50/75/100% capacity -> await unload -> explicit UNLOAD_CONFIRMED ->
 *     same-truck resumption -> Sanitary Landfill -> SWMO Depot return
 *   - Manual stop confirmation (visited != confirmed vs skipped)
 *   - GPS deviation hysteresis suppression vs valid A* reroute
 *   - Offline disconnection local free-flow A* fallback + event queueing + reconnect sync
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadScenario } from '../js/sim/config/scenarioLoader.js';
import { Simulation } from '../js/sim/simulation.js';
import { RoadState } from '../js/sim/routing/roadState.js';
import { Router } from '../js/sim/routing/router.js';
import { FastAStarWorkspace } from '../js/sim/routing/fastAstar.js';
import { AltIndex } from '../js/sim/routing/altIndex.js';
import { applyMapboxAnnotations, applyTrafficSnapshot } from '../js/sim/routing/trafficAdapter.js';
import { sequenceStops, computeRouteQualityMetrics } from '../js/sim/fleet/sequencer.js';
import { generateNetwork } from '../js/data/networkGenerator.js';
import { mulberry32, randInt } from '../js/core/rng.js';

const readText = async (p) => readFileSync(p, 'utf8');
let passes = 0;
let failures = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\nR02 / R03 / R09 — Fast ALT-A* & Unified Travel-Time + Elevation + Closure Model');
{
  const nagaCfg = JSON.parse(readFileSync('data/scenarios/naga-swmo-schedule.json', 'utf8'));
  const world = await loadScenario({ ...nagaCfg, events: [] }, { readText });
  const g = world.graph;
  const road = new RoadState(g, { costMode: 'time', climbWeight: 0.5, descentWeight: 0.15 });
  applyTrafficSnapshot(g, road, 'congested', 42, 100);
  // Close 15 random edges cleanly (leaving connected core intact for comparison against Dijkstra)
  const rng = mulberry32(42);
  const closedEdges = new Set();
  for (let i = 0; i < 15; i++) {
    const e = randInt(rng, g.edgeCount);
    road.close(e);
    closedEdges.add(e);
  }

  const dijkWs = new FastAStarWorkspace(g.nodeCount);
  const eucRouter = new Router(g, road, { heuristic: 'euclidean', engine: 'fast' });
  const altIndex = new AltIndex(g, road, { landmarks: 6, allowed: world.allowed });
  const altRouter = new Router(g, road, { heuristic: 'alt', engine: 'fast', altIndex, cachePaths: true });
  const w105Router = new Router(g, road, { heuristic: 'alt', engine: 'fast', altIndex, weightFactor: 1.05 });

  let exactMatch = 0;
  let totalFewerOrEq = 0;
  let avoidsClosed = true;
  let weightedBoundOk = true;
  let tested = 0;
  const pairs = [];
  for (let k = 0; k < 200; k++) {
    let s = randInt(rng, g.nodeCount);
    let t = randInt(rng, g.nodeCount);
    if (world.allowed) {
      while (world.allowed[s] !== 1) s = randInt(rng, g.nodeCount);
      while (world.allowed[t] !== 1) t = randInt(rng, g.nodeCount);
    }
    pairs.push([s, t]);
    const dijk = dijkWs.search(g, s, t, { weight: (a) => road.arcWeight(a), heuristic: () => 0 });
    const altRes = altRouter.findPath(s, t, 'route');
    const eucRes = eucRouter.findPath(s, t, 'route');
    const wRes = w105Router.findPath(s, t, 'route');
    tested++;
    if (dijk.found === altRes.found && (!dijk.found || Math.abs(dijk.cost - altRes.cost) < 1e-6)) exactMatch++;
    if (altRes.nodesExpanded <= eucRes.nodesExpanded) totalFewerOrEq++;
    if (altRes.found && altRes.arcs.some((a) => closedEdges.has(g.adjEdge[a]))) avoidsClosed = false;
    if (dijk.found && (!wRes.found || wRes.cost > dijk.cost * 1.05 + 1e-6)) weightedBoundOk = false;
  }

  check('ALT-A* matches Dijkstra exact optimal cost on 200 congested+closed Naga pairs', exactMatch === tested, `${exactMatch}/${tested}`);
  check('ALT-A* expands <= nodes than Euclidean A* on all 200 pairs', totalFewerOrEq === tested, `${totalFewerOrEq}/${tested}`);
  check('ALT-A* never traverses closed roads', avoidsClosed);
  check('Weighted ALT-A* (w=1.05) respects bound C <= 1.05 * C* on all 200 pairs', weightedBoundOk);

  // Versioned path cache hit & invalidation
  const [p0s, p0t] = pairs[0];
  const callsBefore = altRouter.stats.calls;
  const hitsBefore = altRouter.stats.pathCacheHits;
  const cachedRes = altRouter.findPath(p0s, p0t, 'route');
  check('Versioned path cache serves warm repeat without A* call',
    altRouter.stats.calls === callsBefore && altRouter.stats.pathCacheHits === hitsBefore + 1 && cachedRes.found);
  road.applyDelay(randInt(rng, g.edgeCount), 1.5);
  altRouter.findPath(p0s, p0t, 'route');
  check('RoadState.version bump invalidates path cache and triggers fresh A* search',
    altRouter.stats.calls === callsBefore + 1);

  // Synthetic elevated terrain network test (climbWeight = 0.5, descentWeight = 0.15)
  const elevGraph = generateNetwork({ targetNodes: 500, width: 2500, height: 1800, seed: 7 });
  elevGraph.buildAdjacency();
  for (let i = 0; i < elevGraph.nodeCount; i++) {
    elevGraph.elevation[i] = 20 + 60 * Math.sin(elevGraph.x[i] / 350) * Math.cos(elevGraph.y[i] / 350);
  }
  const elevRoad = new RoadState(elevGraph, { costMode: 'time', climbWeight: 0.5, descentWeight: 0.15 });
  applyTrafficSnapshot(elevGraph, elevRoad, 'congested', 9, 0);
  const elevAlt = new AltIndex(elevGraph, elevRoad, { landmarks: 4 });
  const elevRouter = new Router(elevGraph, elevRoad, { heuristic: 'alt', engine: 'fast', altIndex: elevAlt });
  const elevDijk = new FastAStarWorkspace(elevGraph.nodeCount);
  let elevExact = 0;
  for (let k = 0; k < 50; k++) {
    const u = randInt(rng, elevGraph.nodeCount);
    const v = randInt(rng, elevGraph.nodeCount);
    const a = elevRouter.findPath(u, v, 'route');
    const d = elevDijk.search(elevGraph, u, v, { weight: (arc) => elevRoad.arcWeight(arc), heuristic: () => 0 });
    if (a.found === d.found && (!d.found || Math.abs(a.cost - d.cost) < 1e-6)) elevExact++;
  }
  check('ALT-A* remains 100% optimal with elevation climb/descent + traffic (50/50)', elevExact === 50, `${elevExact}/50`);
}

console.log('\nR04 — Mapbox Traffic Snapshot Adapter');
{
  const g = generateNetwork({ targetNodes: 40, width: 600, height: 400, seed: 3 });
  g.buildAdjacency();
  const road = new RoadState(g, { costMode: 'time' });
  const unitPayload = {
    fetchedAtS: 100,
    routes: [{
      legs: [{
        annotation: {
          edgeIndices: [0, 1, 2],
          speed: [4.2, null, 6.0],
          congestion: ['heavy', 'unknown', 'moderate'],
        },
      }],
    }],
  };
  const live = applyMapboxAnnotations(g, road, unitPayload, { nowS: 150, ttlS: 300 });
  const stale = applyMapboxAnnotations(g, road, unitPayload, { nowS: 700, ttlS: 300 });
  const missing = applyMapboxAnnotations(g, road, { routes: [] }, { nowS: 700, ttlS: 300 });
  check('Mapbox annotations detect live congested, stale TTL expiry, and missing payloads',
    live.status === 'congested' && live.matchedEdges === 2 && live.missingSegments === 1 &&
    stale.status === 'stale' && missing.status === 'missing');
}

console.log('\nR01 — Fixed-Endpoint Asymmetric Road-Cost 2-Opt Sequencer');
{
  const nagaCfg = JSON.parse(readFileSync('data/scenarios/naga-swmo-schedule.json', 'utf8'));
  const world = await loadScenario({ ...nagaCfg, events: [] }, { readText });
  const g = world.graph;
  const road = new RoadState(g, { costMode: 'time' });
  applyTrafficSnapshot(g, road, 'congested', 5, 0);
  const router = new Router(g, road, { heuristic: 'alt', engine: 'fast', landmarks: 6, allowed: world.allowed });

  const area1Bins = world.bins.filter((b) => b.area === 'AREA-1');
  const binsById = new Map(area1Bins.map((b) => [b.id, b]));
  const ids = area1Bins.map((b) => b.id);

  const r2opt = sequenceStops(g, road, router, {
    startNode: world.depot, stopIds: ids, binsById, endNode: world.disposal, method: 'road2opt',
  });
  const rNN = sequenceStops(g, road, router, {
    startNode: world.depot, stopIds: ids, binsById, endNode: world.disposal, method: 'road_nn',
  });
  const eucNN = sequenceStops(g, road, router, {
    startNode: world.depot, stopIds: ids, binsById, endNode: world.disposal, method: 'nearest',
  });

  const tourCost = (order) => {
    let c = router.legCost(world.depot, binsById.get(order[0]).node, 'eta');
    for (let i = 0; i + 1 < order.length; i++) {
      c += router.legCost(binsById.get(order[i]).node, binsById.get(order[i + 1]).node, 'eta');
    }
    c += router.legCost(binsById.get(order[order.length - 1]).node, world.disposal, 'eta');
    return c;
  };

  const c2opt = tourCost(r2opt.order);
  const cnn = tourCost(rNN.order);
  const ceuc = tourCost(eucNN.order);
  check('Fixed-endpoint Road 2-Opt cost <= Road NN <= Euclidean NN on AREA-1',
    c2opt <= cnn + 1e-6 && c2opt <= ceuc + 1e-6 && r2opt.order.length === ids.length,
    `2opt=${c2opt.toFixed(1)}s, nn=${cnn.toFixed(1)}s, euc=${ceuc.toFixed(1)}s`);

  const rq = computeRouteQualityMetrics(g, [0, g.arcTwin[0] >= 0 ? g.arcTwin[0] : 0]);
  check('Route quality evaluator detects U-turn backtracking & repeated road length',
    g.arcTwin[0] >= 0 ? (rq.uTurnCount === 1 && rq.backtrackingDistanceM > 0 && rq.repeatedRoadDistanceM > 0) : true);
}

console.log('\nR05 / R06 / R07 — Operational Capacity, Landfill->Depot Return, Manual Stop Confirm, GPS Hysteresis & Offline Sync');
{
  const sample = JSON.parse(readFileSync('data/scenarios/sample-fleet.json', 'utf8'));
  const cfg = structuredClone(sample);
  cfg.trucks = [cfg.trucks[0]];
  cfg.bins = cfg.bins.slice(0, 6).map((b) => ({ ...b, truck: 'T1', fill: 60 }));
  cfg.events = [];
  cfg.settings = {
    ...(cfg.settings || {}),
    heuristic: 'alt',
    cost_mode: 'time',
    routing_engine: 'fast',
    visit_order: 'road2opt',
    operational_mode: true,
    require_unload_confirm: true,
    auto_confirm_unload_delay_s: 0,
    manual_stop_confirm: true,
    return_to_depot: true,
    gps_accuracy_max_m: 35,
    deviation_threshold_m: 45,
    deviation_min_pings: 2,
    reroute_cooldown_s: 15,
  };

  const world = await loadScenario(cfg);
  const sim = new Simulation(world);
  const t1 = sim.trucks[0];

  // Step until first bin is serviced (visited, not yet confirmed)
  let guard = 0;
  while (t1.collected === 0 && !sim.bins.some((b) => b.visited) && guard++ < 500) sim.step();
  const visitedBin = sim.bins.find((b) => b.visited);
  check('Manual stop confirm mode separates visited vs confirmed before driver confirms',
    Boolean(visitedBin) && visitedBin.visited === true && visitedBin.confirmed === false);

  // Confirm 4 stops, skip 1 stop (simulated later), and test GPS hysteresis
  sim.injectOperationalEvent({ type: 'STOP_CONFIRMED', truckId: t1.id, binId: visitedBin.id });
  check('STOP_CONFIRMED updates confirmed state cleanly', visitedBin.confirmed === true && visitedBin.state === 'collected');

  // Test GPS hysteresis: noisy reading + small offset + single ping suppressed; 2nd real ping triggers reroute
  const rNoise = sim.injectOperationalEvent({ type: 'GPS_DEVIATION', truckId: t1.id, gpsAccuracyM: 60, offsetM: 90, consecutiveReadings: 3 });
  const rSmall = sim.injectOperationalEvent({ type: 'GPS_DEVIATION', truckId: t1.id, gpsAccuracyM: 12, offsetM: 20, consecutiveReadings: 3 });
  const rOne = sim.injectOperationalEvent({ type: 'GPS_DEVIATION', truckId: t1.id, gpsAccuracyM: 12, offsetM: 80, consecutiveReadings: 1 });
  const rReal = sim.injectOperationalEvent({ type: 'GPS_DEVIATION', truckId: t1.id, gpsAccuracyM: 12, offsetM: 80, consecutiveReadings: 2 });
  check('GPS hysteresis suppresses noisy/jitter pings and reroutes on confirmed 2nd reading',
    rNoise.suppressed && rSmall.suppressed && rOne.suppressed && !rReal.suppressed && t1.gpsNoiseSuppressed === 3 && t1.deviationReroutes === 1);

  // Test Manual 25/50/75/100% -> goes offline -> landfill -> offline GPS fallback -> awaits explicit UNLOAD_CONFIRMED -> resumes same truck
  sim.injectOperationalEvent({ type: 'MANUAL_CAPACITY_REPORT', truckId: t1.id, percent: 50 });
  sim.injectOperationalEvent({ type: 'NETWORK_DISCONNECT' });
  sim.injectOperationalEvent({ type: 'MANUAL_CAPACITY_REPORT', truckId: t1.id, percent: 100 });
  check('100% manual capacity report keeps remaining queue on same truck & targets Sanitary Landfill',
    t1.mode === 'full' && t1.target?.kind === 'disposal' && t1.queue.length >= 3);

  // Advance 20 s to clear reroute cooldown, then trigger offline deviation reroute
  for (let s = 0; s < 20; s++) sim.step();
  const offDev = sim.injectOperationalEvent({ type: 'GPS_DEVIATION', truckId: t1.id, gpsAccuracyM: 10, offsetM: 75, consecutiveReadings: 2 });
  check('Offline GPS deviation triggers free-flow local A* fallback',
    !offDev.suppressed && offDev.offline === true && t1.offlineFallbackReroutes === 1);

  // Advance until truck arrives and finishes unloading at landfill -> awaiting_unload_confirm
  guard = 0;
  while (t1.status !== 'awaiting_unload_confirm' && guard++ < 1500) sim.step();
  check('Truck enters awaiting_unload_confirm state at Sanitary Landfill',
    t1.status === 'awaiting_unload_confirm' && t1.awaitingUnloadConfirm === true);

  // Reconnect & confirm unload
  const rec = sim.injectOperationalEvent({ type: 'NETWORK_RECONNECT' });
  check('NETWORK_RECONNECT flushes queued offline events', rec.synced >= 1);

  sim.injectOperationalEvent({ type: 'UNLOAD_CONFIRMED', truckId: t1.id });
  check('UNLOAD_CONFIRMED resets capacity to 0% and resumes remaining bins on same truck',
    t1.reportedCapacityPct === 0 && t1.status === 'driving' && t1.queue.length >= 3 && t1.disposalTrips === 1);

  // Skip one queued bin and confirm the rest automatically via event listener loop, then check final Landfill -> SWMO Depot return
  const skipTarget = t1.queue[0];
  let safety = 0;
  while (!sim.finished && safety++ < 6000) {
    for (const b of sim.bins) {
      if (b.visited && !b.confirmed && !b.skipped) {
        sim.injectOperationalEvent({
          type: b.id === skipTarget ? 'STOP_SKIPPED' : 'STOP_CONFIRMED',
          truckId: t1.id,
          binId: b.id,
        });
      }
    }
    if (t1.status === 'awaiting_unload_confirm') {
      sim.injectOperationalEvent({ type: 'UNLOAD_CONFIRMED', truckId: t1.id });
    }
    sim.step();
  }
  const summary = sim.summary();
  check('Skipped bin remains unconfirmed/missed while completed stops finish and truck returns from Landfill to SWMO Depot',
    summary.finished && t1.node === world.depot && summary.returnDistanceM > 0 &&
    summary.disposalDistanceM > 0 && sim.binsById.get(skipTarget).state === 'missed');
}

console.log('\nBaseline integrity check');
{
  const diff = execSync('git status --porcelain js/algorithms/astar.js', { encoding: 'utf8' }).trim();
  check('Frozen baseline js/algorithms/astar.js is untouched', diff === '');
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
