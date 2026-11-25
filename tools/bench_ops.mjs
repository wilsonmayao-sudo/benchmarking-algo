/**
 * Multi-Algorithm Operational & Pathfinding Benchmark Suite (`npm run bench:ops`).
 *
 * Compares across actual SWMO datasets and synthetic Naga/terrain datasets:
 *   B1: Static Distance A* + Schedule Order (`cost_mode='distance', heuristic='euclidean', visit_order='given'`)
 *   B2: Dynamic A* + Euclidean NN         (`cost_mode='distance', heuristic='euclidean', visit_order='nearest'`)
 *   P1: Traffic+Elev ALT-A* + Road 2-Opt (`cost_mode='time', heuristic='alt', routing_engine='fast', visit_order='road2opt', weight_factor=1.0`)
 *   P2a: Weighted ALT-A* w=1.05 (`R09`)   (`weight_factor=1.05`)
 *   P2b: Weighted ALT-A* w=1.10 (`R09`)   (`weight_factor=1.10`)
 *
 * Writes verified quantitative results to `docs/benchmark_results.json`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadScenario } from '../js/sim/config/scenarioLoader.js';
import { Simulation } from '../js/sim/simulation.js';
import { timingSummary } from '../js/sim/metrics.js';
import { RoadState } from '../js/sim/routing/roadState.js';
import { Router } from '../js/sim/routing/router.js';
import { FastAStarWorkspace } from '../js/sim/routing/fastAstar.js';
import { AltIndex } from '../js/sim/routing/altIndex.js';
import { applyTrafficSnapshot } from '../js/sim/routing/trafficAdapter.js';
import { generateNetwork } from '../js/data/networkGenerator.js';
import { mulberry32, randInt } from '../js/core/rng.js';
import { ROAD_CLASS } from '../js/core/graph.js';

const textCache = new Map();
const readText = async (p) => {
  if (!textCache.has(p)) textCache.set(p, readFileSync(p, 'utf8'));
  return textCache.get(p);
};
const mapCache = new Map();
const loadIo = { readText, mapCache };

function statsOf(values) {
  const arr = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  const n = arr.length;
  if (n === 0) return { n: 0, mean: 0, median: 0, min: 0, max: 0, sd: 0 };
  const mean = arr.reduce((s, v) => s + v, 0) / n;
  const median = n % 2 ? arr[(n - 1) / 2] : 0.5 * (arr[n / 2 - 1] + arr[n / 2]);
  const variance = n > 1 ? arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  return {
    n,
    mean: round(mean, 4),
    median: round(median, 4),
    min: round(arr[0], 4),
    max: round(arr[n - 1], 4),
    sd: round(Math.sqrt(variance), 4),
  };
}

function round(v, d = 3) {
  if (!Number.isFinite(v)) return v;
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function pctDiff(baseline, proposed) {
  if (!(baseline > 0)) return 0;
  return round(((baseline - proposed) / baseline) * 100, 2);
}

console.log('=== Loading Naga City Road Network & SWMO Schedule Config ===');
const baseSwmo = JSON.parse(readFileSync('data/scenarios/naga-swmo-schedule.json', 'utf8'));
const cleanWorld = await loadScenario({ ...baseSwmo, events: [] }, loadIo);
const g = cleanWorld.graph;

const inventory = {
  nagaNodes: g.nodeCount,
  nagaEdges: g.edgeCount,
  nagaArcs: g.arcCount,
  nagaOneWayEdges: Array.from(g.edgeDirected).reduce((s, x) => s + x, 0),
  nagaHasElevation: Boolean(cleanWorld.binImport && g.elevation.some((v) => v !== 0)),
  swmoCsvTotalRows: cleanWorld.binImport?.rows ?? 0,
  swmoCsvMappedStops: cleanWorld.bins.length,
  swmoCsvSkippedOutsideMap: cleanWorld.binImport?.skipped?.outsideRoadMap ?? 0,
  swmoCsvSkippedNonCollection: cleanWorld.binImport?.skipped?.stopType ?? {},
  trucksCount: cleanWorld.trucks.length,
  distinctScheduleAreas: [...new Set(cleanWorld.bins.map((b) => b.area).filter(Boolean))].sort(),
};

console.log(`Naga graph: ${inventory.nagaNodes} nodes, ${inventory.nagaEdges} edges (${inventory.nagaOneWayEdges} one-way), SWMO mapped stops: ${inventory.swmoCsvMappedStops}`);

// =========================================================================
//  EXPERIMENT 1: Core O-D Pathfinding Audit (200 random pairs)
// =========================================================================
console.log('\n--- Experiment 1: Core O-D Pathfinding Audit (200 pairs) ---');
const rng = mulberry32(20261126);
const mainNodes = [];
for (let i = 0; i < g.nodeCount; i++) {
  if (!cleanWorld.allowed || cleanWorld.allowed[i] === 1) mainNodes.push(i);
}
const odPairs = [];
for (let k = 0; k < 200; k++) {
  const s = mainNodes[randInt(rng, mainNodes.length)];
  let t = mainNodes[randInt(rng, mainNodes.length)];
  if (t === s) t = mainNodes[(randInt(rng, mainNodes.length - 1) + 1) % mainNodes.length];
  odPairs.push([s, t]);
}

function runOdAudit(label, graph, allowedMask, profile) {
  const road = new RoadState(graph, { costMode: 'time', climbWeight: 0.5, descentWeight: 0.15 });
  applyTrafficSnapshot(graph, road, profile, 42, 0);
  if (profile === 'congested') {
    const crng = mulberry32(88);
    for (let i = 0; i < 20; i++) road.close(randInt(crng, graph.edgeCount));
  }

  const dijkWs = new FastAStarWorkspace(graph.nodeCount);
  const legDistWs = new FastAStarWorkspace(graph.nodeCount);
  const staticRouter = new Router(graph, new RoadState(graph, { costMode: 'distance' }), { heuristic: 'euclidean', engine: 'fast' });
  const dynEucRouter = new Router(graph, road, { heuristic: 'euclidean', engine: 'fast' });
  const alt4 = new AltIndex(graph, road, { landmarks: 4, allowed: allowedMask });
  const alt6 = new AltIndex(graph, road, { landmarks: 6, allowed: allowedMask });
  const alt8 = new AltIndex(graph, road, { landmarks: 8, allowed: allowedMask });
  const rAlt4 = new Router(graph, road, { heuristic: 'alt', engine: 'fast', altIndex: alt4 });
  const rAlt6 = new Router(graph, road, { heuristic: 'alt', engine: 'fast', altIndex: alt6 });
  const rAlt8 = new Router(graph, road, { heuristic: 'alt', engine: 'fast', altIndex: alt8 });
  const rW105 = new Router(graph, road, { heuristic: 'alt', engine: 'fast', altIndex: alt6, weightFactor: 1.05 });
  const rW110 = new Router(graph, road, { heuristic: 'alt', engine: 'fast', altIndex: alt6, weightFactor: 1.10 });

  const dijkCosts = [];
  const exactChecks = { alt4: 0, alt6: 0, alt8: 0, validPairs: 0 };
  const ratiosW105 = [];
  const ratiosW110 = [];
  const staticCostsUnderLive = [];
  const optimalLiveCosts = [];

  for (const [s, t] of odPairs) {
    const u = allowedMask ? s : s % graph.nodeCount;
    const v = allowedMask ? t : t % graph.nodeCount;
    const d = dijkWs.search(graph, u, v, { weight: (a) => road.arcWeight(a), heuristic: () => 0 });
    const sr = staticRouter.findPath(u, v, 'route');
    const er = dynEucRouter.findPath(u, v, 'route');
    const a4 = rAlt4.findPath(u, v, 'route');
    const a6 = rAlt6.findPath(u, v, 'route');
    const a8 = rAlt8.findPath(u, v, 'route');
    const w5 = rW105.findPath(u, v, 'route');
    const w10 = rW110.findPath(u, v, 'route');

    if (d.found) {
      exactChecks.validPairs++;
      if (a4.found && Math.abs(a4.cost - d.cost) < 1e-6) exactChecks.alt4++;
      if (a6.found && Math.abs(a6.cost - d.cost) < 1e-6) exactChecks.alt6++;
      if (a8.found && Math.abs(a8.cost - d.cost) < 1e-6) exactChecks.alt8++;
      if (w5.found) ratiosW105.push(w5.cost / d.cost);
      if (w10.found) ratiosW110.push(w10.cost / d.cost);

      // Evaluate Static A*'s chosen path under actual live cost
      if (sr.found && !sr.arcs.some((a) => road.arcWeight(a) === Infinity)) {
        const liveCostStatic = sr.arcs.reduce((sum, a) => sum + road.arcWeight(a), 0);
        staticCostsUnderLive.push(liveCostStatic);
        optimalLiveCosts.push(d.cost);
      }
      dijkCosts.push(d.cost);
    }
  }
  void legDistWs;

  const pack = (name, r, extra = {}) => {
    const sm = r.summary();
    return {
      algorithm: name,
      calls: sm.astarCalls,
      avgExpanded: round(sm.nodesExpandedAvg, 2),
      minExpanded: sm.nodesExpandedMin,
      maxExpanded: sm.nodesExpandedMax,
      avgMs: round(sm.astarAvgMs, 4),
      coldAvgMs: round(sm.coldAvgMs, 4),
      warmAvgMs: round(sm.warmAvgMs, 4),
      prepMs: round(sm.altPrepMs, 2),
      memoryKB: round(sm.memoryBytes / 1024, 1),
      ...extra,
    };
  };

  return {
    label,
    validPairs: exactChecks.validPairs,
    exactOptimalMatches: exactChecks,
    staticPathSuboptimalityMeanRatio: optimalLiveCosts.length
      ? round(staticCostsUnderLive.reduce((s, c, i) => s + c / optimalLiveCosts[i], 0) / optimalLiveCosts.length, 4)
      : 1,
    algorithms: [
      pack('Dynamic Euclidean A*', dynEucRouter),
      pack('Proposed ALT-A* (k=4)', rAlt4),
      pack('Proposed ALT-A* (k=6)', rAlt6),
      pack('Proposed ALT-A* (k=8)', rAlt8),
      pack('Weighted ALT-A* (k=6, w=1.05)', rW105, { costRatio: statsOf(ratiosW105) }),
      pack('Weighted ALT-A* (k=6, w=1.10)', rW110, { costRatio: statsOf(ratiosW110) }),
    ],
  };
}

const exp1 = {
  nagaNormal: runOdAudit('Naga OSM (Normal Daytime Traffic)', g, cleanWorld.allowed, 'normal'),
  nagaCongested: runOdAudit('Naga OSM (Peak Congestion + 20 Closures)', g, cleanWorld.allowed, 'congested'),
};

// Also audit elevated synthetic road network to prove climb/descent elevation behavior
const elevGraph = generateNetwork({ targetNodes: 2000, width: 4000, height: 3000, seed: 19 });
elevGraph.buildAdjacency();
for (let i = 0; i < elevGraph.nodeCount; i++) {
  elevGraph.elevation[i] = 35 + 45 * Math.sin(elevGraph.x[i] / 550) * Math.cos(elevGraph.y[i] / 480);
}
exp1.syntheticElevated = runOdAudit('Synthetic Elevated Grid (2000 nodes, 0-80m elev)', elevGraph, null, 'congested');
console.log('Exp 1 Naga Congested ALT-6 avgExpanded:', exp1.nagaCongested.algorithms[2].avgExpanded, 'vs Euclidean:', exp1.nagaCongested.algorithms[0].avgExpanded);

// =========================================================================
//  Shared Fleet Runner Helper
// =========================================================================
const MODES = [
  { id: 'B1', label: 'Baseline 1 (Static Dist A* + Schedule Order)', settings: { cost_mode: 'distance', heuristic: 'euclidean', routing_engine: 'legacy', visit_order: 'given', weight_factor: 1.0 } },
  { id: 'B2', label: 'Baseline 2 (Dynamic A* + Euclidean NN)', settings: { cost_mode: 'distance', heuristic: 'euclidean', routing_engine: 'legacy', visit_order: 'nearest', weight_factor: 1.0 } },
  { id: 'P1', label: 'Proposed (Traffic+Elev ALT-A* + Road 2-Opt)', settings: { cost_mode: 'time', heuristic: 'alt', routing_engine: 'fast', visit_order: 'road2opt', weight_factor: 1.0, cache_paths: true, alt_landmarks: 6 } },
  { id: 'P2', label: 'Weighted ALT-A* (w=1.05) + Road 2-Opt', settings: { cost_mode: 'time', heuristic: 'alt', routing_engine: 'fast', visit_order: 'road2opt', weight_factor: 1.05, cache_paths: true, alt_landmarks: 6 } },
];

// Build one reusable AltIndex per map when evaluating many runs on the same Naga graph to report true amortized cost
const sharedAltRoad = new RoadState(g, { costMode: 'time', climbWeight: 0.5, descentWeight: 0.15 });
const sharedNagaAlt = new AltIndex(g, sharedAltRoad, { landmarks: 6, allowed: cleanWorld.allowed });

async function runMode(cfg, mode, { trafficProfile = 'normal', operationalEvents = [], attachSharedAlt = false } = {}) {
  const c = structuredClone(cfg);
  c.settings = { ...(c.settings || {}), ...mode.settings };
  const world = await loadScenario(c, loadIo);
  if (attachSharedAlt && mode.settings.heuristic === 'alt') world.altIndex = sharedNagaAlt;

  const sim = new Simulation(world);
  if (trafficProfile && trafficProfile !== 'none') {
    applyTrafficSnapshot(world.graph, sim.road, trafficProfile, world.seed, 0);
  }
  for (const ev of operationalEvents) sim.events.push(ev);
  sim.run();

  const summary = sim.summary();
  const timings = timingSummary(sim);
  return { mode: mode.id, label: mode.label, ...summary, ...timings };
}

// =========================================================================
//  EXPERIMENT 2A: All 17 Schedule Areas (Actual SWMO Dataset, Congested)
// =========================================================================
console.log('\n--- Experiment 2A: Actual SWMO Schedule Areas (17 areas, congested traffic) ---');
const areaRows = [];
for (const areaCode of inventory.distinctScheduleAreas) {
  const truckForArea = baseSwmo.trucks.find((t) => (t.areas || []).map((a) => a.toUpperCase()).includes(areaCode))
    || baseSwmo.trucks[0];
  const areaCfg = {
    ...baseSwmo,
    name: `${areaCode}`,
    trucks: [truckForArea],
    bins: { ...baseSwmo.bins, areas: [areaCode], assign_by_area: false },
    events: [],
  };
  const b2 = await runMode(areaCfg, MODES[1], { trafficProfile: 'congested' });
  const p1 = await runMode(areaCfg, MODES[2], { trafficProfile: 'congested', attachSharedAlt: true });
  areaRows.push({
    area: areaCode,
    stops: p1.bins,
    b2DistKm: round(b2.totalDistanceM / 1000, 2),
    p1DistKm: round(p1.totalDistanceM / 1000, 2),
    distSavedPct: pctDiff(b2.totalDistanceM, p1.totalDistanceM),
    b2ExpandedAvg: b2.nodesExpandedAvg,
    p1ExpandedAvg: p1.nodesExpandedAvg,
    b2RepeatedKm: round(b2.repeatedRoadDistanceM / 1000, 2),
    p1RepeatedKm: round(p1.repeatedRoadDistanceM / 1000, 2),
    p1MakespanS: p1.makespanS,
    p1CoveragePct: p1.confirmedCoveragePct,
  });
  console.log(`  ${areaCode}: ${p1.bins} stops | B2=${round(b2.totalDistanceM / 1000, 2)}km -> P1=${round(p1.totalDistanceM / 1000, 2)}km (${pctDiff(b2.totalDistanceM, p1.totalDistanceM)}%)`);
}
console.log(`Evaluated ${areaRows.length} schedule areas; mean dist reduction P1 vs B2: ${statsOf(areaRows.map((r) => r.distSavedPct)).mean}%`);

// =========================================================================
//  EXPERIMENT 2B: Full 14-Truck Naga SWMO Citywide Shift Across Operational Scenarios
// =========================================================================
console.log('\n--- Experiment 2B: Full 14-Truck SWMO Citywide Scenarios ---');

// 1. Normal daytime traffic (all 163 mapped stops, 14 trucks)
const cityNormal = [];
for (const m of MODES) cityNormal.push(await runMode(baseSwmo, m, { trafficProfile: 'normal', attachSharedAlt: true }));

// 2. Peak Congestion + 12 Dynamic Road Closures/Delays
const cityPeak = [];
for (const m of MODES) cityPeak.push(await runMode(baseSwmo, m, { trafficProfile: 'congested', attachSharedAlt: true }));

// 3. Simulated Operational Mode: Manual 25/50/75/100% capacity, Landfill Unload Confirm -> Same-Truck Resume -> SWMO Depot Return
const opCfg = structuredClone(baseSwmo);
opCfg.settings = {
  ...opCfg.settings,
  operational_mode: true,
  require_unload_confirm: true,
  auto_confirm_unload_delay_s: 300,
};
// Trigger realistic mid-shift 25/50/75/100% reports on heavy routes (AREA-8 / AREA-4 / AREA-1)
const opEvents = [
  { time: 300, type: 'MANUAL_CAPACITY_REPORT', truckId: 'TRK-16', percent: 50, source: 'driver' },
  { time: 600, type: 'MANUAL_CAPACITY_REPORT', truckId: 'TRK-16', percent: 75, source: 'driver' },
  { time: 900, type: 'MANUAL_CAPACITY_REPORT', truckId: 'TRK-16', percent: 100, source: 'driver' },
  { time: 450, type: 'MANUAL_CAPACITY_REPORT', truckId: 'TRK-10', percent: 50, source: 'driver' },
  { time: 1100, type: 'MANUAL_CAPACITY_REPORT', truckId: 'TRK-10', percent: 100, source: 'driver' },
  { time: 500, type: 'MANUAL_CAPACITY_REPORT', truckId: 'TRK-01', percent: 25, source: 'driver' },
  { time: 800, type: 'MANUAL_CAPACITY_REPORT', truckId: 'TRK-01', percent: 75, source: 'driver' },
];
const opMultitrip = await runMode(opCfg, MODES[2], { trafficProfile: 'congested', operationalEvents: opEvents, attachSharedAlt: true });

// 4. GPS Deviation & Hysteresis Stress Test (noisy single/inaccurate pings + real off-route pings)
const devEvents = [
  ...opEvents,
  { time: 400, type: 'GPS_DEVIATION', truckId: 'TRK-16', gpsAccuracyM: 65, offsetM: 90, consecutiveReadings: 3, source: 'gps' }, // suppressed accuracy
  { time: 420, type: 'GPS_DEVIATION', truckId: 'TRK-16', gpsAccuracyM: 10, offsetM: 25, consecutiveReadings: 3, source: 'gps' }, // suppressed jitter
  { time: 440, type: 'GPS_DEVIATION', truckId: 'TRK-16', gpsAccuracyM: 10, offsetM: 85, consecutiveReadings: 1, source: 'gps' }, // suppressed streak=1
  { time: 460, type: 'GPS_DEVIATION', truckId: 'TRK-16', gpsAccuracyM: 10, offsetM: 85, consecutiveReadings: 2, source: 'gps' }, // valid reroute
  { time: 750, type: 'GPS_DEVIATION', truckId: 'TRK-14', gpsAccuracyM: 14, offsetM: 95, consecutiveReadings: 2, source: 'gps' }, // valid reroute
];
const opDeviation = await runMode(opCfg, MODES[2], { trafficProfile: 'congested', operationalEvents: devEvents, attachSharedAlt: true });

// 5. Offline Disconnection Window + Free-Flow Fallback + Reconnect Event Sync
const offEvents = [
  { time: 500, type: 'NETWORK_DISCONNECT', duration: 900, source: 'network' },
  { time: 700, type: 'MANUAL_CAPACITY_REPORT', truckId: 'TRK-16', percent: 100, source: 'driver' },
  { time: 850, type: 'GPS_DEVIATION', truckId: 'TRK-16', gpsAccuracyM: 12, offsetM: 80, consecutiveReadings: 2, source: 'gps' },
  { time: 950, type: 'GPS_DEVIATION', truckId: 'TRK-10', gpsAccuracyM: 15, offsetM: 70, consecutiveReadings: 2, source: 'gps' },
];
const opOffline = await runMode(opCfg, MODES[2], { trafficProfile: 'congested', operationalEvents: offEvents, attachSharedAlt: true });

// 6. Traffic Feed Degradation (Missing vs Stale)
const opMissingTraffic = await runMode(baseSwmo, MODES[2], { trafficProfile: 'missing', attachSharedAlt: true });
const opStaleTraffic = await runMode(baseSwmo, MODES[2], { trafficProfile: 'stale', attachSharedAlt: true });

// =========================================================================
//  EXPERIMENT 3: Synthetic Naga Multi-Seed Statistical Benchmark (5 seeds)
// =========================================================================
console.log('\n--- Experiment 3: Synthetic Naga 5-Seed Statistical Benchmark ---');
const synthSeeds = [101, 202, 303, 404, 505];
const synthTemplate = JSON.parse(readFileSync('data/scenarios/naga-14-trucks.json', 'utf8'));
const synthRuns = { B1: [], B2: [], P1: [], P2: [] };

for (const seed of synthSeeds) {
  const sc = structuredClone(synthTemplate);
  sc.seed = seed;
  sc.bins = { random: { count: 75, seed: seed + 17, fill: [35, 95] } };
  sc.events = {
    random: {
      enabled: true, seed: seed + 29, count: 12, window_s: [60, 2400],
      types: { TRAFFIC_DELAY: 0.65, ROAD_CLOSURE: 0.35 },
      delay_factor: [1.8, 3.2], delay_duration_s: [300, 900], closure_duration_s: [300, 900],
    },
  };
  for (const m of MODES) {
    const res = await runMode(sc, m, { trafficProfile: 'congested', attachSharedAlt: true });
    synthRuns[m.id].push(res);
  }
}

const synthStats = {};
for (const m of MODES) {
  const arr = synthRuns[m.id];
  synthStats[m.id] = {
    label: m.label,
    totalDistanceKm: statsOf(arr.map((r) => r.totalDistanceM / 1000)),
    repeatedRoadKm: statsOf(arr.map((r) => r.repeatedRoadDistanceM / 1000)),
    backtrackingM: statsOf(arr.map((r) => r.backtrackingDistanceM)),
    makespanMin: statsOf(arr.map((r) => r.makespanS / 60)),
    astarCalls: statsOf(arr.map((r) => r.astarCalls)),
    nodesExpandedAvg: statsOf(arr.map((r) => r.nodesExpandedAvg)),
    astarAvgMs: statsOf(arr.map((r) => r.astarAvgMs)),
    memoryKB: statsOf(arr.map((r) => r.memoryBytes / 1024)),
    coveragePct: statsOf(arr.map((r) => r.confirmedCoveragePct)),
  };
}

const p1VsB2 = {
  distanceReductionPct: pctDiff(synthStats.B2.totalDistanceKm.mean, synthStats.P1.totalDistanceKm.mean),
  repeatedRoadReductionPct: pctDiff(synthStats.B2.repeatedRoadKm.mean, synthStats.P1.repeatedRoadKm.mean),
  backtrackingReductionPct: pctDiff(synthStats.B2.backtrackingM.mean, synthStats.P1.backtrackingM.mean),
  nodesExpandedReductionPct: pctDiff(synthStats.B2.nodesExpandedAvg.mean, synthStats.P1.nodesExpandedAvg.mean),
  astarAvgMsSpeedupPct: pctDiff(synthStats.B2.astarAvgMs.mean, synthStats.P1.astarAvgMs.mean),
};

const output = {
  generatedAt: new Date().toISOString(),
  inventory,
  experiment1_pathfindingAudit: exp1,
  experiment2a_swmo17Areas: {
    areas: areaRows,
    distanceReductionPctSummary: statsOf(areaRows.map((r) => r.distSavedPct)),
    nodesReductionPctSummary: statsOf(areaRows.map((r) => pctDiff(r.b2ExpandedAvg, r.p1ExpandedAvg))),
  },
  experiment2b_swmoCitywide: {
    normalTraffic: cityNormal,
    peakCongestionAndClosures: cityPeak,
    operationalScenarios: {
      multitripManualCapacity: opMultitrip,
      gpsDeviationHysteresis: opDeviation,
      offlineFallbackAndSync: opOffline,
      missingTraffic: opMissingTraffic,
      staleTraffic: opStaleTraffic,
    },
  },
  experiment3_syntheticMultiSeed: {
    seeds: synthSeeds,
    statsByMode: synthStats,
    p1VsB2Improvements: p1VsB2,
  },
};

mkdirSync('docs', { recursive: true });
writeFileSync('docs/benchmark_results.json', JSON.stringify(output, null, 2) + '\n', 'utf8');
console.log('\nSaved benchmark results to docs/benchmark_results.json');
console.log('Synthetic 5-seed P1 vs B2 improvements:', JSON.stringify(p1VsB2));
