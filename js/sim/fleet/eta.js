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

import { busyRemaining, remainingRouteTime, keepsOwnBins } from './truck.js';
import { entryNode, routeOrder, routerFor, stopTime } from './routes.js';

/**
 * Order in which a truck will visit its queue, starting from node `from`.
 * Must match Simulation.pickNextBin() so the projection is what the truck really does.
 */
export function plannedOrder(graph, queue, binsById, from, visitOrder) {
  if (visitOrder === 'given') return queue.slice();
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
  const legTime = (from, to) => (from === to ? 0 : router.legCost(from, to, 'eta') / truck.speed);

  if (truck.routeId) {
    // Route truck (trip: see routes.js): → area, about 2 min per stop on roads inside it, landfill
    // when full and at the end, then back to the depot.
    const route = sim.routes.get(truck.routeId);
    const legBy = (r, from, to) => (from === to ? 0 : r.legCost(from, to, 'eta') / truck.speed);
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

  // A standstill that starts after the current stop (breakdown while emptying a bin, …).
  if (truck.status !== 'driving' && truck.holdUntil > end) end = truck.holdUntil;

  const keeps = keepsOwnBins(truck, s);
  const open = (id) => binsById.get(id).state !== 'missed'; // a missing bin is skipped
  // The rest of the queue, in the order the truck will drive it (the same greedy order
  // Simulation#planNext uses), with landfill trips whenever the next bin would not fit.
  const collectRest = (ids) => {
    let order = plannedOrder(graph, ids.filter(open), binsById, at, s.visit_order);
    while (order.length > 0) {
      const b = binsById.get(order[0]);
      if (load + b.load > truck.maxCapacity) {
        if (!keeps || b.load > truck.maxCapacity || load === 0) break; // handed off at this point
        end += legTime(at, world.disposal) + s.unload_time_s; // unload, then back for the rest
        at = world.disposal;
        load = 0;
        order = plannedOrder(graph, order, binsById, at, s.visit_order);
        continue;
      }
      order.shift();
      end += legTime(at, b.node) + b.serviceTime + (b.extraTime || 0);
      load += b.load;
      at = b.node;
    }
  };

  if (target.kind === 'bin') {
    const bin = binsById.get(target.binId);
    if (bin.state !== 'missed') {
      // the truck is already committed to the target bin (it was checked to fit)
      if (truck.status !== 'servicing') end += bin.serviceTime + (bin.extraTime || 0);
      load += bin.load;
    }
    collectRest(truck.queue.filter((id) => id !== target.binId));
  } else if (target.kind === 'disposal') {
    end += truck.status === 'unloading' ? 0 : s.unload_time_s;
    load = 0;
    collectRest(truck.queue); // an area truck comes back for the bins it kept
  }

  // final trip: unload if carrying anything, then back to the depot
  if (load > 0) {
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
