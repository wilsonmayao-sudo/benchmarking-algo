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

export function summarize(sim) {
  const r = sim.router.summary();
  const collected = sim.bins.filter((b) => b.state === 'collected').length;
  const errs = sim.metrics.etaErrors;
  const byPurpose = r.byPurpose;

  return {
    scenario: sim.world.name,
    variant: sim.world.variant,
    seed: sim.world.seed,
    heuristic: sim.world.settings.heuristic,
    trucks: sim.trucks.length,
    bins: sim.bins.length,
    events: sim.world.events.length,
    finished: sim.finished,
    finishReason: sim.finishReason,

    totalDistanceM: round(sim.trucks.reduce((s, t) => s + t.distance, 0), 1),
    makespanS: round(sim.lastActiveTime, 1),
    totalTruckTimeS: round(sim.trucks.reduce((s, t) => s + t.activeTime, 0), 1),

    astarCalls: r.astarCalls,
    astarAvgMs: round(r.astarAvgMs, 4),
    astarTotalMs: round(r.astarTotalMs, 3),
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

    eventsApplied: sim.metrics.eventsApplied,
    reroutes: sim.metrics.reroutes,
    blockedIncidents: sim.metrics.blockedIncidents,
    reassignments: sim.metrics.reassignments,
    binsCollected: collected,
    binsMissed: sim.bins.length - collected,
    disposalTrips: sim.trucks.reduce((s, t) => s + t.disposalTrips, 0),

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

/** Full run export: config summary, metrics, per-truck, per-bin, event log, run log. */
export function toJSON(sim) {
  return {
    exportedAt: new Date().toISOString(),
    summary: summarize(sim),
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
