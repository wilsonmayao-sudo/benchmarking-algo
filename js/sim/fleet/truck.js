/**
 * Truck model: runtime state plus the geometry helpers the simulation and the map need.
 *
 * POSITION
 *   A truck is always either AT a node (`arcPos === 0`, or no arcs left) or part-way
 *   along the first arc of its planned route (`arcs[0]`, `arcPos` metres from its tail).
 *
 * REROUTING "FROM WHERE IT IS NOW"
 *   A truck that is part-way along a road finishes that road (it cannot teleport or
 *   reverse mid-block), so a new route is planned from the far end of the current arc —
 *   `rerouteOrigin()`. If the road it is ON closes, it is allowed to finish that road;
 *   closures block *entering* a road. The time left on the current arc is still counted
 *   in the ETA.
 *
 * STATUS (what the truck is physically doing)
 *   idle | driving | servicing | unloading | blocked
 * MODE (why)
 *   collect — working through its bin queue
 *   full    — capacity reached, heading to the disposal site (takes no new bins)
 *   final   — queue finished, heading to disposal / depot
 */

export function createTruckState(cfg) {
  return {
    ...cfg,
    load: cfg.currentLoad,
    node: cfg.start,          // last node reached
    arcs: [],                 // planned directed arcs; arcs[0] may be in progress
    arcPos: 0,                // metres travelled along arcs[0]
    status: 'idle',
    mode: 'collect',
    target: null,             // { kind: 'bin'|'disposal'|'depot', node, binId? }
    queue: [],                // ids of assigned, uncollected bins (target bin included)
    busyUntil: 0,             // end of the current service / unload
    eta: null,                // { nextAt, endAt, label, computedAt }  (absolute sim times)
    // --- per-truck metrics ---
    distance: 0,              // metres driven
    activeTime: 0,            // seconds not idle / blocked
    collected: 0,
    disposalTrips: 0,
    reroutes: 0,
    blockedCount: 0,
    // --- route + trip details ---
    routeId: null,            // area-locked route this truck works on (null = free)
    phase: '',                // route truck: toArea | area | toLandfill | toDepot | done (see routes.js)
    lastStop: -1,             // corner of the last bin it emptied
    holdUntil: 0,             // standing still until then (delay)
    serviceProblem: '',       // why the current stop takes longer ('' = normal)
    trip: null,               // { startedAt, plannedEnd, lastEnd, collected, finishedAt, reason }
    timeline: [],             // [{ time, seq, text }] plain-language events
    pendingEtaCheck: null,    // {binId, predictedAt} — measures ETA accuracy
  };
}

/** The node a new route must start from (see header). */
export function rerouteOrigin(graph, truck) {
  if (truck.arcs.length > 0 && truck.arcPos > 0) return graph.adjNeighbor[truck.arcs[0]];
  return truck.node;
}

/** The in-progress arc that must be kept when rerouting, or null. */
export function lockedArc(truck) {
  return truck.arcs.length > 0 && truck.arcPos > 0 ? truck.arcs[0] : null;
}

/** Does the remaining (not yet entered) part of the route use road `edge`? */
export function routeUsesEdge(graph, truck, edge) {
  const from = lockedArc(truck) !== null ? 1 : 0;
  for (let i = from; i < truck.arcs.length; i++) {
    if (graph.adjEdge[truck.arcs[i]] === edge) return true;
  }
  return false;
}

/** Seconds left on the current route under the live road state (Infinity if it is now blocked). */
export function remainingRouteTime(graph, road, truck) {
  let weight = 0;
  for (let i = 0; i < truck.arcs.length; i++) {
    const a = truck.arcs[i];
    const e = graph.adjEdge[a];
    const mult = road.multiplier[e];
    if (i === 0 && truck.arcPos > 0) {
      // already on this road — finishing it is always allowed
      weight += (graph.edgeLength[e] - truck.arcPos) * mult;
    } else {
      const w = road.arcWeight(a);
      if (w === Infinity) return Infinity;
      weight += w;
    }
  }
  return weight / truck.speed;
}

/** Seconds until the current service / unload ends (0 if not busy). */
export function busyRemaining(truck, now) {
  return truck.status === 'servicing' || truck.status === 'unloading'
    ? Math.max(0, truck.busyUntil - now)
    : 0;
}

/** Interpolated world position (for drawing). */
export function truckXY(graph, truck) {
  if (truck.arcs.length > 0 && truck.arcPos > 0) {
    const a = truck.arcs[0];
    const u = graph.adjTail[a];
    const v = graph.adjNeighbor[a];
    const t = Math.min(1, truck.arcPos / graph.edgeLength[graph.adjEdge[a]]);
    return { x: graph.x[u] + (graph.x[v] - graph.x[u]) * t, y: graph.y[u] + (graph.y[v] - graph.y[u]) * t };
  }
  return { x: graph.x[truck.node], y: graph.y[truck.node] };
}

/** Remaining capacity once every bin already in its queue has been collected. */
export function freeCapacity(truck, binsById) {
  let committed = truck.load;
  for (const id of truck.queue) committed += binsById.get(id).load;
  return truck.maxCapacity - committed;
}
