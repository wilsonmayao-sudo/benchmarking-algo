/**
 * Benchmark metrics + export.
 *
 * `summarize(sim)` produces one flat record per run so that different scenarios
 * (no events vs. closures, 2 vs. 4 trucks, …) can be compared row by row:
 *
 *   distance / time   totalDistanceM, makespanS (time the last truck stopped working),
 *                     totalTruckTimeS (sum of each truck's working time)
 *   A*                astarCalls, astarAvgMs, nodesExpandedAvg/Min/Max/Total,
 *                     per purpose: route / reroute / eta / assign, legCacheHits
 *   events            eventsApplied, reroutes (caused by events), blockedIncidents
 *   fleet             reassignments, binsCollected, binsMissed, disposalTrips
 *   ETA quality       etaMaeS — mean |actual − predicted| arrival at a bin, measured
 *                     against the prediction made when the truck set off on that leg
 *
 * Export: `toJSON(sim)` (everything, incl. logs and per-search samples) and
 * `toCSV(records)` (one row per run — append rows from several runs into one file).
 */

import { computeRouteQualityMetrics } from './fleet/sequencer.js';

export function summarize(sim) {
  const r = sim.router.summary();
  const collected = sim.bins.filter((b) => b.state === 'collected').length;
  const confirmed = sim.bins.filter((b) => b.confirmed || b.state === 'collected').length;
  const visited = sim.bins.filter((b) => b.visited || b.state === 'collected').length;
  const unreachableStops = sim.bins.filter((b) => b.unreachable).length;
  const errs = sim.metrics.etaErrors;
  const byPurpose = r.byPurpose;

  let collectionDistanceM = 0;
  let disposalDistanceM = 0;
  let returnDistanceM = 0;
  let drivingTimeS = 0;
  let repeatedRoadDistanceM = 0;
  let uniqueRoadDistanceM = 0;
  let backtrackingDistanceM = 0;
  let uTurnCount = 0;
  let deviationReroutes = 0;
  let gpsNoiseSuppressed = 0;
  let offlineFallbackReroutes = 0;

  for (const t of sim.trucks) {
    collectionDistanceM += t.collectionDistanceM || 0;
    disposalDistanceM += t.disposalDistanceM || 0;
    returnDistanceM += t.returnDistanceM || 0;
    drivingTimeS += t.drivingTimeS || 0;
    deviationReroutes += t.deviationReroutes || 0;
    gpsNoiseSuppressed += t.gpsNoiseSuppressed || 0;
    offlineFallbackReroutes += t.offlineFallbackReroutes || 0;
    const rq = computeRouteQualityMetrics(sim.graph, t.traversedArcs);
    repeatedRoadDistanceM += rq.repeatedRoadDistanceM;
    uniqueRoadDistanceM += rq.uniqueRoadDistanceM;
    backtrackingDistanceM += rq.backtrackingDistanceM;
    uTurnCount += rq.uTurnCount;
  }

  const totalDistanceM = sim.trucks.reduce((s, t) => s + t.distance, 0);
  const repeatedRoadRatio = totalDistanceM > 0 ? repeatedRoadDistanceM / totalDistanceM : 0;
  const totalStops = sim.bins.length;
  const plannedCoveragePct = totalStops > 0 ? (visited / totalStops) * 100 : 100;
  const confirmedCoveragePct = totalStops > 0 ? (confirmed / totalStops) * 100 : 100;

  return {
    scenario: sim.world.name,
    variant: sim.world.variant,
    seed: sim.world.seed,
    heuristic: sim.world.settings.heuristic,
    costMode: sim.road.costMode,
    visitOrder: sim.world.settings.visit_order,
    weightFactor: sim.router.weightFactor,
    trucks: sim.trucks.length,
    bins: sim.bins.length,
    events: sim.world.events.length,
    finished: sim.finished,
    finishReason: sim.finishReason,

    totalDistanceM: round(totalDistanceM, 1),
    collectionDistanceM: round(collectionDistanceM, 1),
    disposalDistanceM: round(disposalDistanceM, 1),
    returnDistanceM: round(returnDistanceM, 1),
    makespanS: round(sim.lastActiveTime, 1),
    totalTruckTimeS: round(sim.trucks.reduce((s, t) => s + t.activeTime, 0), 1),
    estimatedTravelTimeS: round(drivingTimeS, 1),

    uniqueRoadDistanceM: round(uniqueRoadDistanceM, 1),
    repeatedRoadDistanceM: round(repeatedRoadDistanceM, 1),
    repeatedRoadRatio: round(repeatedRoadRatio, 4),
    backtrackingDistanceM: round(backtrackingDistanceM, 1),
    uTurnCount,

    astarCalls: r.astarCalls,
    astarAvgMs: round(r.astarAvgMs, 4),
    astarTotalMs: round(r.astarTotalMs, 3),
    memoryBytes: r.memoryBytes,
    nodesExpandedAvg: round(r.nodesExpandedAvg, 2),
    nodesExpandedMin: r.nodesExpandedMin,
    nodesExpandedMax: r.nodesExpandedMax,
    nodesExpandedTotal: r.nodesExpandedTotal,
    astarFailed: r.astarFailed,
    astarRouteCalls: byPurpose.route.calls,
    astarRerouteCalls: byPurpose.reroute.calls,
    astarEtaCalls: byPurpose.eta.calls,
    astarAssignCalls: byPurpose.assign.calls,
    legCacheHits: r.legCacheHits,
    pathCacheHits: r.pathCacheHits,

    eventsApplied: sim.metrics.eventsApplied,
    reroutes: sim.metrics.reroutes,
    blockedIncidents: sim.metrics.blockedIncidents,
    reassignments: sim.metrics.reassignments,
    binsCollected: collected,
    binsMissed: sim.bins.length - collected,
    binsConfirmed: confirmed,
    unreachableStops,
    plannedCoveragePct: round(plannedCoveragePct, 2),
    confirmedCoveragePct: round(confirmedCoveragePct, 2),
    disposalTrips: sim.trucks.reduce((s, t) => s + t.disposalTrips, 0),

    deviationReroutes,
    gpsNoiseSuppressed,
    offlineFallbackReroutes,
    offlineQueuedEvents: sim.offlineSyncQueue ? sim.offlineSyncQueue.length : 0,
    offlineSyncedEvents: sim.metrics.offlineSyncedEvents || 0,
    manualCapacityEvents: sim.metrics.manualCapacityEvents || 0,
    unloadConfirmations: sim.metrics.unloadConfirmations || 0,

    etaRecalcs: sim.metrics.etaRecalcs,
    etaMaeS: errs.length ? round(errs.reduce((s, x) => s + x, 0) / errs.length, 2) : 0,
    simWallMs: round(sim.metrics.wallMs, 2),
  };
}

/** Per-truck breakdown (shown in the UI and included in the JSON export). */
export function truckRows(sim) {
  return sim.trucks.map((t) => ({
    truck: t.name,
    id: t.id,
    distanceM: round(t.distance, 1),
    workingTimeS: round(t.activeTime, 1),
    binsCollected: t.collected,
    load: round(t.load, 1),
    maxCapacity: t.maxCapacity,
    disposalTrips: t.disposalTrips,
    reroutes: t.reroutes,
    blockedCount: t.blockedCount,
    status: t.status,
  }));
}

/** Non-deterministic wall-clock timing breakdown (kept separate from summarize() determinism check). */
export function timingSummary(sim) {
  const r = sim.router.summary();
  return {
    astarAvgMs: round(r.astarAvgMs, 4),
    astarTotalMs: round(r.astarTotalMs, 3),
    coldAvgMs: round(r.coldAvgMs, 4),
    warmAvgMs: round(r.warmAvgMs, 4),
    altPrepMs: round(r.altPrepMs, 3),
    sequencingTotalMs: round(sim.metrics.sequencingTotalMs || 0, 3),
    simWallMs: round(sim.metrics.wallMs, 2),
  };
}

/** Full run export: config summary, metrics, per-truck, per-bin, event log, run log. */
export function toJSON(sim) {
  return {
    exportedAt: new Date().toISOString(),
    summary: summarize(sim),
    timings: timingSummary(sim),
    trucks: truckRows(sim),
    bins: sim.bins.map((b) => ({
      id: b.id, name: b.name, node: sim.world.nodeLabel(b.node), state: b.state,
      fillAtPickup: b.fillAtPickup, loadKg: round(b.load, 1),
      collectedBy: b.collectedBy, collectedAtS: b.collectedAt === null ? null : round(b.collectedAt, 1),
      assignmentHistory: b.history.map((h) => ({ ...h, time: round(h.time, 1) })),
    })),
    eventLog: sim.eventLog.map(({ edgeIndex, ...rest }) => rest),
    log: sim.logEntries.map(({ data, ...rest }) => rest),
    astarSearches: sim.router.stats.samples.map(([purpose, expanded, ms]) => ({ purpose, nodesExpanded: expanded, ms })),
  };
}

/** Records (objects with the same flat shape) → CSV text. */
export function toCSV(records) {
  if (records.length === 0) return '';
  const columns = [];
  for (const rec of records) for (const k of Object.keys(rec)) if (!columns.includes(k)) columns.push(k);
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...records.map((rec) => columns.map((c) => cell(rec[c])).join(','))].join('\n') + '\n';
}

function round(x, digits) {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
