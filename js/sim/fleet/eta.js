/**
 * ETA calculation.
 *
 *   ETA to next stop  = time left in the current service/unload
 *                     + remaining A* path cost of the current leg / truck speed
 *
 *   ETA to route end  = ETA to next stop
 *                     + service time at that bin
 *                     + Σ over the remaining queue (in the order the truck will visit):
 *                         A* leg cost / speed + bin service time
 *                     + final legs: → disposal (+ unload time) if carrying load, → depot
 *
 * Path cost is in "effective metres" (length × delay multiplier), so cost / speed is
 * seconds. The look-ahead respects capacity exactly as the truck will: if the next bin
 * would overflow, the projected route goes to the disposal site at that point (the rest
 * would be handed off).
 *
 * ETAs are stored as ABSOLUTE simulation times (nextAt / endAt), so the UI can count
 * them down every frame without recomputing; they are recomputed whenever a path
 * changes (reroute, closure, delay, new assignment) — see Simulation.refreshEta().
 */

import { busyRemaining, remainingRouteTime } from './truck.js';
import { entryNode, routeOrder, routerFor, stopTime } from './routes.js';
import { sequenceStops } from './sequencer.js';

/**
 * Order in which a truck will visit its queue, starting from node `from`.
 * Supports:
 *   - 'given': preserve assigned order
 *   - 'nearest': legacy Euclidean Nearest Neighbor
 *   - 'road_nn': road-cost Nearest Neighbor via Router/RoadState
 *   - 'road2opt': Fixed-Endpoint Asymmetric Road-Cost 2-Opt (`R01`)
 */
export function plannedOrder(graph, queue, binsById, from, visitOrder, ctx = null) {
  if (visitOrder === 'given') return queue.slice();
  if ((visitOrder === 'road_nn' || visitOrder === 'road2opt') && ctx && ctx.road) {
    const cacheKey = `${visitOrder}#${from}#${ctx.endNode ?? -1}#${ctx.road.version}#${queue.join(',')}`;
    if (!ctx._orderCache) ctx._orderCache = new Map();
    if (ctx._orderCache.has(cacheKey)) return ctx._orderCache.get(cacheKey).slice();

    const seq = sequenceStops(graph, ctx.road, ctx.router || null, {
      startNode: from,
      stopIds: queue,
      binsById,
      endNode: ctx.endNode ?? -1,
      method: visitOrder,
    });
    if (typeof ctx.onSeqTiming === 'function') ctx.onSeqTiming(seq.ms);
    ctx._orderCache.set(cacheKey, seq.order);
    return seq.order.slice();
  }

  const left = queue.slice();
  const order = [];
  let cur = from;
  while (left.length > 0) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < left.length; i++) {
      const n = binsById.get(left[i]).node;
      const d = (graph.x[n] - graph.x[cur]) ** 2 + (graph.y[n] - graph.y[cur]) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    const id = left.splice(best, 1)[0];
    order.push(id);
    cur = binsById.get(id).node;
  }
  return order;
}

/** Drive seconds between two nodes for ETA look-ahead under either 'distance' or 'time' cost mode. */
function legSeconds(graph, road, router, from, to, truckSpeed, purpose = 'eta') {
  if (from === to) return 0;
  if (road.costMode === 'time') {
    const hasElev = Boolean(graph.elevation) && (road.climbWeight > 0 || road.descentWeight > 0);
    if (!hasElev) return router.legCost(from, to, purpose);
    const res = router.findPath(from, to, purpose);
    if (!res.found) return Infinity;
    let sec = 0;
    for (let i = 0; i < res.arcs.length; i++) {
      sec += road.arcTime(res.arcs[i], truckSpeed);
    }
    return sec;
  }
  return router.legCost(from, to, purpose) / truckSpeed;
}

/**
 * @param {object} sim  the Simulation (graph, road, router, binsById, world settings)
 * @param {object} truck
 * @returns {{nextAt:number, endAt:number, label:string, targetName:string, computedAt:number}|null}
 */
export function computeEta(sim, truck) {
  const { graph, road, binsById, world } = sim;
  const router = routerFor(sim, truck);
  const now = sim.time;
  const s = world.settings;

  if (truck.status === 'blocked') {
    return { nextAt: Infinity, endAt: Infinity, label: 'BLOCKED — no route', targetName: '', computedAt: now };
  }
  if (truck.status === 'idle' || !truck.target) {
    return { nextAt: now, endAt: now, label: 'idle at depot', targetName: '', computedAt: now };
  }
  if (truck.status === 'awaiting_unload_confirm') {
    return {
      nextAt: now,
      endAt: now + s.unload_time_s,
      label: `${truck.name} · awaiting unload confirmation`,
      targetName: 'Landfill',
      computedAt: now,
    };
  }

  // ---- current leg ----
  let t = now + busyRemaining(truck, now);
  if (truck.status === 'driving' && truck.holdUntil > now) t += truck.holdUntil - now;
  if (truck.status === 'driving') t += remainingRouteTime(graph, road, truck);
  const target = truck.target;
  const nextAt = t;
  const targetName = target.kind === 'bin' ? binsById.get(target.binId).name
    : target.kind === 'entry' ? sim.routes.get(truck.routeId)?.name ?? 'Route area'
    : target.kind === 'stop' ? 'End of route'
    : target.kind === 'disposal' ? 'Landfill' : 'Depot';

  // ---- look-ahead to the end of the route ----
  let end = nextAt;
  let load = truck.load;
  let at = target.node;
  const legTime = (from, to) => legSeconds(graph, road, router, from, to, truck.speed, 'eta');

  if (truck.routeId) {
    // Route truck (trip: see routes.js): → area, about 2 min per stop on roads inside it, landfill
    // when full and at the end, then back to the depot.
    const route = sim.routes.get(truck.routeId);
    const legBy = (r, from, to) => legSeconds(graph, road, r, from, to, truck.speed, 'eta');
    const drive = (to) => { // on any road; a leg that is closed right now is left out
      const leg = legBy(sim.router, at, to);
      if (leg === Infinity) return false;
      end += leg;
      at = to;
      return true;
    };
    let lastStop = truck.lastStop; // corner of the last bin, as Simulation keeps it
    const unload = () => {
      if (drive(world.disposal)) end += s.unload_time_s;
      load = 0;
      lastStop = -1;
    };

    if (target.kind === 'bin') {
      if (truck.status !== 'servicing') end += stopTime(at, lastStop);
      load += binsById.get(target.binId).load;
      lastStop = at;
    } else if (target.kind === 'disposal') {
      if (truck.status !== 'unloading') end += s.unload_time_s;
      load = 0;
      lastStop = -1;
    }

    let rest = routeOrder(sim, truck, truck.queue.filter((id) => id !== target.binId), at);
    while (rest.length > 0) {
      const b = binsById.get(rest[0]);
      if (b.load > truck.maxCapacity) { rest.shift(); continue; } // never fits: skipped
      if (load + b.load > truck.maxCapacity) {
        unload();
        rest = routeOrder(sim, truck, rest, at); // from here on it plans from the landfill
        continue;
      }
      if (!route.area.inCore[at]) {
        const entry = entryNode(sim, route, at);
        if (entry < 0 || !drive(entry)) break;
        rest = routeOrder(sim, truck, rest, at); // … and from where it drives in
        continue;
      }
      rest.shift();
      const leg = legBy(route.router, at, b.node);
      if (leg === Infinity) continue; // waits for a road to reopen
      end += leg + stopTime(b.node, lastStop);
      lastStop = b.node;
      load += b.load;
      at = b.node;
    }
    if (load > 0) unload();
    if (s.return_to_depot) drive(world.depot);
    return { nextAt, endAt: end, targetName, label: `${truck.name} → ${targetName}`, computedAt: now };
  }

  if (target.kind === 'bin') {
    const bin = binsById.get(target.binId);
    // the truck is already committed to the target bin (it was checked to fit)
    if (truck.status !== 'servicing') end += bin.serviceTime;
    load += bin.load;
    const rest = truck.queue.filter((id) => id !== target.binId);
    const seqCtx = { road, router, endNode: world.disposal, _orderCache: sim._orderCache };
    for (const id of plannedOrder(graph, rest, binsById, at, s.visit_order, seqCtx)) {
      const b = binsById.get(id);
      if (!s.operational_mode && load + b.load > truck.maxCapacity) break; // will be handed off at this point
      end += legTime(at, b.node) + b.serviceTime;
      load += b.load;
      at = b.node;
    }
  } else if (target.kind === 'disposal') {
    end += truck.status === 'unloading' ? 0 : s.unload_time_s;
    load = 0;
  }

  // final trip: unload if carrying anything (or if manual capacity reported > 0), then back to the depot
  if (target.kind !== 'disposal' && (load > 0 || truck.reportedCapacityPct > 0)) {
    end += legTime(at, world.disposal) + s.unload_time_s;
    at = world.disposal;
  }
  if (s.return_to_depot && target.kind !== 'depot') end += legTime(at, world.depot);

  return {
    nextAt,
    endAt: end,
    targetName,
    label: `${truck.name} → ${targetName}`,
    computedAt: now,
  };
}

/** "4 min 30 s" style duration (the format asked for in the UI). */
export function fmtDuration(seconds) {
  if (seconds === Infinity) return 'unreachable';
  if (!Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${r} s`;
  return `${r} s`;
}

/** Simulation clock as hh:mm:ss. */
export function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
