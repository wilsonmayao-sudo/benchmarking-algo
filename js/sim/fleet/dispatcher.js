/**
 * Dispatcher — who collects which bin.
 *
 *   initialAssignment()  bins with a "truck" in the config go to that truck as-is (the
 *                        config is authoritative, even if it overloads the truck — that
 *                        is exactly what triggers a handoff later). Every other bin is
 *                        assigned to the best truck (below).
 *
 *   handoff(full, bins)  a truck is full / its next bin would overflow it: each of its
 *                        remaining bins is moved to the best OTHER truck. A bin no truck
 *                        can take goes to the pending queue.
 *
 *   assignPending()      called whenever a truck frees up (finished unloading, went idle,
 *                        got unblocked) or a road event may have made a bin reachable.
 *
 * "BEST TRUCK" for a bin
 *   candidates : not blocked, not on a full-truck disposal run, and with enough FREE
 *                capacity (max − load − loads of bins already queued) for this bin
 *   choice     : lowest ETA to the bin = time left in current service/leg-in-progress
 *                + A* cost from the truck's reroute origin to the bin / truck speed
 *   ties       : config order of trucks (deterministic)
 */

import { rerouteOrigin, freeCapacity, busyRemaining } from './truck.js';

/** Can this truck accept new bins at all right now? */
export function isAvailable(truck) {
  return truck.status !== 'blocked' && truck.mode !== 'full';
}

/**
 * Best truck for `bin`, or null.
 * @returns {{truck:object, eta:number}|null}
 */
export function bestTruckFor(sim, bin, excludeId = null) {
  const { graph, router, binsById } = sim;
  let best = null;
  for (const truck of sim.trucks) {
    if (truck.id === excludeId || !isAvailable(truck)) continue;
    if (freeCapacity(truck, binsById) < bin.load) continue;

    const origin = rerouteOrigin(graph, truck);
    let lead = busyRemaining(truck, sim.time);
    if (truck.arcs.length > 0 && truck.arcPos > 0) {
      const e = graph.adjEdge[truck.arcs[0]];
      lead += ((graph.edgeLength[e] - truck.arcPos) * sim.road.multiplier[e]) / truck.speed;
    }
    const res = router.findPath(origin, bin.node, 'assign');
    if (!res.found) continue;
    const eta = lead + res.cost / truck.speed;
    if (!best || eta < best.eta) best = { truck, eta };
  }
  return best;
}

/** Give `bin` to `truck` (bookkeeping only — the truck picks it up on its next decision). */
export function giveBin(sim, bin, truck, reason) {
  bin.state = 'assigned';
  bin.truckId = truck.id;
  bin.history.push({ time: sim.time, truckId: truck.id, reason });
  if (!truck.queue.includes(bin.id)) truck.queue.push(bin.id);
}

function toPending(sim, bin, reason) {
  bin.state = 'pending';
  bin.truckId = null;
  bin.history.push({ time: sim.time, truckId: null, reason });
  if (!sim.pending.includes(bin.id)) sim.pending.push(bin.id);
}

/** t = 0: apply config assignments, auto-assign the rest. */
export function initialAssignment(sim) {
  const byId = new Map(sim.trucks.map((t) => [t.id, t]));
  const auto = [];
  for (const bin of sim.bins) {
    const truck = bin.configTruck ? byId.get(bin.configTruck) : null;
    if (truck) giveBin(sim, bin, truck, 'config');
    else auto.push(bin);
  }
  for (const bin of auto) {
    const best = bestTruckFor(sim, bin);
    if (best) {
      giveBin(sim, bin, best.truck, 'auto-assign');
      sim.log('assign', `${bin.name} auto-assigned to ${best.truck.name} (ETA ${Math.round(best.eta)} s)`);
    } else {
      toPending(sim, bin, 'no truck with capacity');
      sim.log('pending', `${bin.name} → pending queue (no truck has capacity / a route)`);
    }
  }
}

/**
 * Move `binIds` away from `fromTruck` (which is full). Logs one line per receiving truck,
 * e.g. "Truck 1 full → Bins 7, 9 reassigned to Truck 3".
 * @returns {string[]} trucks that received work (ids)
 */
export function handoff(sim, fromTruck, binIds, why) {
  const received = new Map(); // truckId → [bin names]
  const pendingNames = [];

  for (const id of binIds) {
    const bin = sim.binsById.get(id);
    fromTruck.queue = fromTruck.queue.filter((q) => q !== id);
    const best = bestTruckFor(sim, bin, fromTruck.id);
    if (best) {
      giveBin(sim, bin, best.truck, `handoff from ${fromTruck.id}`);
      sim.metrics.reassignments++;
      if (!received.has(best.truck.id)) received.set(best.truck.id, []);
      received.get(best.truck.id).push(bin.name);
    } else {
      toPending(sim, bin, `handoff from ${fromTruck.id}: no truck available`);
      pendingNames.push(bin.name);
    }
  }

  for (const [truckId, names] of received) {
    const to = sim.trucks.find((t) => t.id === truckId);
    sim.log('handoff', `${fromTruck.name} ${why} → ${joinBins(names)} reassigned to ${to.name}`,
      { from: fromTruck.id, to: truckId, bins: names });
  }
  if (pendingNames.length > 0) {
    sim.log('pending', `${fromTruck.name} ${why} → ${joinBins(pendingNames)} queued as pending (no truck with enough capacity)`,
      { from: fromTruck.id, bins: pendingNames });
  }
  return [...received.keys()];
}

/**
 * Try to place every pending bin on an available truck.
 * @returns {string[]} ids of trucks that received work
 */
export function assignPending(sim) {
  if (sim.pending.length === 0) return [];
  const touched = new Set();
  for (const id of sim.pending.slice()) {
    const bin = sim.binsById.get(id);
    const best = bestTruckFor(sim, bin);
    if (!best) continue;
    sim.pending = sim.pending.filter((p) => p !== id);
    // Only a change of truck counts as a reassignment (a bin can go pending and come
    // back to the same truck once it has unloaded). A bin that was pending from the
    // start is a first assignment, not a reassignment.
    const previous = [...bin.history].reverse().find((h) => h.truckId !== null);
    giveBin(sim, bin, best.truck, 'from pending queue');
    if (previous && previous.truckId !== best.truck.id) sim.metrics.reassignments++;
    touched.add(best.truck.id);
    sim.log('handoff', `Pending ${bin.name} assigned to ${best.truck.name}`, { to: best.truck.id, bins: [bin.name] });
  }
  return [...touched];
}

/** "Bin 7" / "Bins 7, 9" */
function joinBins(names) {
  if (names.length === 1) return names[0];
  return `Bins ${names.map((n) => n.replace(/^Bin\s*/i, '')).join(', ')}`;
}
