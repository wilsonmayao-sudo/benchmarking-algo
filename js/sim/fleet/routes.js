/**
 * Bin edits and area-locked truck routes, applied to a running simulation.
 *
 * A ROUTE TRUCK'S TRIP (truck.phase) — every metre is driven, a truck is never moved by hand
 *   toArea      depot (or wherever it is) → first road corner of its area
 *   area        collecting, STRICT (below)
 *   toLandfill  all bins collected, or the next bin does not fit → landfill, unload
 *               (with bins left it then goes back: toArea)
 *   toDepot     empty → depot
 *   done        parked; new bins on its route send it out again
 *
 * STRICT RULE — while collecting, a truck only drives on roads that are completely inside its
 * area and only collects that route's bins. It is enforced three times:
 *   1. planning   its private Router sees every other road as impassable
 *   2. driving    Simulation.advance() refuses to enter a road outside the area
 *   3. collecting Simulation.arrive() refuses a bin of another route (or of none)
 * On the other parts of the trip it may use any road, but it never collects anything.
 *
 * Trucks and bins without a route keep using the normal dispatcher.
 */

import { MinHeap } from '../../core/heap.js';
import { Router } from '../routing/router.js';
import { astarSearch } from '../routing/astar.js';
import { lockedArc, rerouteOrigin } from './truck.js';
import { giveBin, assignPending } from './dispatcher.js';
import { plannedOrder } from './eta.js';
import { buildArea, nearestOf, pointInPolygon, polygonArea, polygonsOverlap, selfCrosses } from './routeAreas.js';

export const ROUTE_SERVICE_S = 120; // a route truck stops about 2 minutes at each place
export const SAME_SPOT_S = 15;      // every further bin standing at the same place
export const MAX_ROAD_DIST_M = 300; // a bin farther than this from a road cannot be served
export const OUTSIDE_MSG = 'Stopped: location is outside the route area';

const serviceable = (b) => b.state !== 'collected' && b.state !== 'missed';
const routeTrucks = (sim, route) => route.truckIds.map((id) => sim.trucks.find((t) => t.id === id)).filter(Boolean);

/** Is the truck on the strict part of its trip (only roads inside its area)? */
export const isConfined = (truck) => Boolean(truck.routeId) && truck.phase === 'area';

export function routerFor(sim, truck) {
  return isConfined(truck) ? sim.routes.get(truck.routeId).router : sim.router;
}

/** May this truck drive on `arc` right now? */
export function arcAllowed(sim, truck, arc) {
  return !isConfined(truck) || sim.routes.get(truck.routeId).area.edgeOk[sim.graph.adjEdge[arc]] === 1;
}

/** First node satisfying `isGoal` that is reached by road from `start` (Dijkstra), or -1. */
function firstReached(graph, start, weight, isGoal) {
  const dist = new Float64Array(graph.nodeCount).fill(Infinity);
  const done = new Uint8Array(graph.nodeCount);
  const heap = new MinHeap(64);
  dist[start] = 0;
  heap.push(0, start);
  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u]) continue;
    if (isGoal(u)) return u;
    done[u] = 1;
    for (let a = graph.adjStart[u]; a < graph.adjStart[u + 1]; a++) {
      const w = weight(a);
      const v = graph.adjNeighbor[a];
      if (w === Infinity || done[v] || dist[u] + w >= dist[v]) continue;
      dist[v] = dist[u] + w;
      heap.push(dist[v], v);
    }
  }
  return -1;
}

/**
 * Where a truck at `from` drives into the area: the first corner of it that is reached by road
 * with the closures and delays of this moment. -1 = no open road leads there.
 */
export function entryNode(sim, route, from) {
  const { inCore } = route.area;
  if (inCore[from]) return from;
  if (route.entryVersion !== sim.road.version) {
    route.entries = new Map();
    route.entryVersion = sim.road.version;
  }
  if (!route.entries.has(from)) {
    route.entries.set(from, firstReached(sim.graph, from, (a) => sim.road.arcWeight(a), (n) => inCore[n] === 1));
  }
  return route.entries.get(from);
}

/** Seconds a route truck needs at `node` when its previous stop was at `prevNode`. */
export const stopTime = (node, prevNode) => (node === prevNode ? SAME_SPOT_S : ROUTE_SERVICE_S);

/** Visit order of bins on a route: the user's own order, or nearest-next-bin. */
export function routeOrder(sim, truck, ids, from) {
  const route = sim.routes.get(truck.routeId);
  if (!route.order) return plannedOrder(sim.graph, ids, sim.binsById, from, 'nearest');
  return ids.slice().sort((a, b) => numberOf(route, a) - numberOf(route, b));
}

/** Stop number of a bin on its route (bins added later go to the end). */
export function numberOf(route, id) {
  if (!route.numbers.has(id)) route.numbers.set(id, Math.max(0, ...route.numbers.values()) + 1);
  return route.numbers.get(id);
}

/** Bins standing inside an outline, in nearest-next order from the corner closest to the depot. */
export function binsInside(sim, poly) {
  const inside = sim.bins.filter((b) => pointInPolygon(b.x, b.y, poly));
  return plannedOrder(sim.graph, inside.map((b) => b.id), sim.binsById, sim.world.depot, 'nearest').map((id) => sim.binsById.get(id));
}

/** Add a line to a truck's timeline. */
export function note(sim, truck, text) {
  truck.timeline.push({ time: sim.time, seq: sim.noteSeq++, text });
}

// ===========================================================================
//  Edit transaction
// ===========================================================================

/**
 * Run an edit, then let every affected truck plan again. The planned finish moves with the
 * amount of work, so adding or removing a bin is not reported as a delay.
 */
function commit(sim, edit) {
  const dirty = new Set();
  sim.editing = true;
  edit(dirty);
  sim.wakeTrucks(assignPending(sim).filter((id) => ![...dirty].some((t) => t.id === id)));
  for (const truck of dirty) {
    // Busy trucks plan by themselves when they are done at their stop.
    if (truck.status === 'unloading' || truck.status === 'servicing') continue;
    truck.status = 'driving';
    sim.planNext(truck);
  }
  for (const truck of sim.trucks) sim.refreshEta(truck);
  sim.editing = false;
}

/** Take an uncollected bin away from its truck. */
function release(sim, bin, dirty) {
  const truck = bin.truckId ? sim.trucks.find((t) => t.id === bin.truckId) : null;
  sim.pending = sim.pending.filter((id) => id !== bin.id);
  if (truck) {
    truck.queue = truck.queue.filter((id) => id !== bin.id);
    if (truck.target?.binId === bin.id) dropTarget(truck, dirty);
  }
  bin.truckId = null;
  bin.state = 'pending';
}

function dropTarget(truck, dirty) {
  dirty.add(truck);
  if (truck.status === 'unloading') return;
  const locked = lockedArc(truck);
  truck.arcs = locked !== null ? [locked] : [];
  truck.target = null;
  truck.pendingEtaCheck = null;
  truck.serviceProblem = '';
  if (truck.status === 'servicing') truck.status = 'driving';
}

/**
 * 1 = road corner a truck can drive to from the depot AND come back from, one-way streets
 * included (closures come and go, so they do not count). Kept with the world.
 */
function drivable(sim) {
  const { graph, world } = sim;
  if (world._drivable) return world._drivable;
  const sweep = (forward) => {
    const seen = new Uint8Array(graph.nodeCount);
    const stack = [world.depot];
    seen[world.depot] = 1;
    while (stack.length) {
      const u = stack.pop();
      const first = forward ? graph.adjStart[u] : graph.revStart[u];
      const last = forward ? graph.adjStart[u + 1] : graph.revStart[u + 1];
      for (let k = first; k < last; k++) {
        const v = forward ? graph.adjNeighbor[k] : graph.adjTail[graph.revArc[k]];
        if (!seen[v]) { seen[v] = 1; stack.push(v); }
      }
    }
    return seen;
  };
  const there = sweep(true);
  const back = sweep(false);
  return (world._drivable = there.map((v, i) => (v && back[i] ? 1 : 0)));
}

/** Road corners new bins may use. */
function mainNodes(sim) {
  if (!sim._mainNodes) {
    const ok = drivable(sim);
    sim._mainNodes = [];
    for (let i = 0; i < ok.length; i++) if (ok[i] === 1) sim._mainNodes.push(i);
  }
  return sim._mainNodes;
}

/** Corner where a truck stops for a bin at (x, y): inside the route's area when it has one. */
function accessNode(sim, x, y, routeId, homeNode = -1) {
  const area = routeId ? sim.routes.get(routeId).area : null;
  if (homeNode >= 0 && (!area || area.inCore[homeNode])) return homeNode;
  // Outside every area, a corner inside an area would put the bin on the wrong side of the line.
  const free = () => (sim.routes.size ? mainNodes(sim).filter((i) => !routeAt(sim, sim.graph.x[i], sim.graph.y[i])) : mainNodes(sim));
  const near = nearestOf(sim.graph, area ? area.core : free(), x, y);
  return near.dist <= MAX_ROAD_DIST_M ? near.node : -1;
}

/** The pin always stands exactly where the truck stops. */
function putPin(sim, bin, node) {
  bin.node = node;
  bin.x = sim.graph.x[node];
  bin.y = sim.graph.y[node];
}

export function routeAt(sim, x, y) {
  for (const r of sim.routes.values()) if (pointInPolygon(x, y, r.poly)) return r;
  return null;
}

/** Route a bin at (x, y) belongs to: the area it is in, unless the user left it out. */
function routeFor(sim, x, y, id) {
  const r = routeAt(sim, x, y);
  return r && !r.excluded.includes(id) ? r.id : null;
}

/** The least busy truck that can carry the bin (any truck when none can: it will skip the bin). */
function carrier(trucks, bin) {
  const able = trucks.filter((t) => t.maxCapacity >= bin.load);
  return (able.length ? able : trucks).reduce((a, b) => (b.queue.length < a.queue.length ? b : a));
}

/** Put a bin (position and route already set, no truck) to work. */
function place(sim, bin, dirty) {
  const node = accessNode(sim, bin.x, bin.y, bin.routeId, bin.homeNode);
  putPin(sim, bin, node >= 0 ? node : bin.homeNode);
  bin.unreachable = node < 0;
  if (!serviceable(bin)) return;
  if (!bin.routeId) {
    if (!sim.pending.includes(bin.id)) sim.pending.push(bin.id);
    return;
  }
  const trucks = routeTrucks(sim, sim.routes.get(bin.routeId));
  if (trucks.length === 0) return;
  if (bin.unreachable) {
    note(sim, trucks[0], `${OUTSIDE_MSG} (${bin.name})`);
    sim.log('warning', `${trucks[0].name} — ${OUTSIDE_MSG}: ${bin.name} has no road inside the area`);
    return;
  }
  const truck = carrier(trucks, bin);
  giveBin(sim, bin, truck, 'route');
  dirty.add(truck);
}

// ===========================================================================
//  Bins
// ===========================================================================

/** @returns {string} '' when a bin can stand at (x, y), otherwise the reason it cannot. */
export function binSpotProblem(sim, x, y) {
  const route = routeAt(sim, x, y);
  if (accessNode(sim, x, y, route?.id ?? null) >= 0) return '';
  return route ? `Too far from a road inside ${route.name}.` : 'Too far from a road. Please pick a spot near a road.';
}

/** cfg: { id, name, type, x, y, fill, capacityKg } */
export function addBin(sim, cfg) {
  const problem = binSpotProblem(sim, cfg.x, cfg.y);
  if (problem) return { ok: false, message: problem };
  const homeNode = accessNode(sim, cfg.x, cfg.y, routeAt(sim, cfg.x, cfg.y)?.id ?? null);
  const bin = {
    id: cfg.id, name: cfg.name, type: cfg.type || 'General', x: cfg.x, y: cfg.y, homeNode, node: homeNode,
    fill: cfg.fill, capacityKg: cfg.capacityKg, load: (cfg.capacityKg * cfg.fill) / 100,
    configTruck: null, serviceTime: sim.world.settings.service_time_s, area: null, custom: true,
    state: 'pending', truckId: null, history: [], collectedBy: null, collectedAt: null, fillAtPickup: null,
    routeId: routeFor(sim, cfg.x, cfg.y, cfg.id), unreachable: false,
  };
  sim.bins.push(bin);
  sim.binsById.set(bin.id, bin);
  commit(sim, (dirty) => place(sim, bin, dirty));
  return { ok: true, bin };
}

export function moveBin(sim, id, x, y) {
  const bin = sim.binsById.get(id);
  const problem = binSpotProblem(sim, x, y);
  if (problem) return { ok: false, message: problem };
  commit(sim, (dirty) => {
    const routeId = routeFor(sim, x, y, id);
    const owner = serviceable(bin) && bin.truckId ? sim.trucks.find((t) => t.id === bin.truckId) : null;
    const keep = owner && routeId === bin.routeId;
    if (serviceable(bin) && !keep) release(sim, bin, dirty);
    bin.homeNode = accessNode(sim, x, y, routeAt(sim, x, y)?.id ?? null);
    bin.routeId = routeId;
    if (keep) {
      putPin(sim, bin, bin.homeNode);
      if (owner.target?.binId === bin.id) dropTarget(owner, dirty);
    } else place(sim, bin, dirty);
  });
  return { ok: true, bin };
}

export function updateBin(sim, id, { name, type, capacityKg, fill }) {
  const bin = sim.binsById.get(id);
  commit(sim, (dirty) => {
    if (name !== undefined) bin.name = name;
    if (type !== undefined) bin.type = type;
    if (capacityKg !== undefined) bin.capacityKg = capacityKg;
    if (fill !== undefined) bin.fill = fill;
    if (serviceable(bin)) {
      bin.load = (bin.capacityKg * bin.fill) / 100;
      const owner = bin.truckId ? sim.trucks.find((t) => t.id === bin.truckId) : null;
      const emptying = owner && owner.status === 'servicing' && owner.target.binId === id;
      if (owner && bin.routeId && bin.load > owner.maxCapacity && !emptying) { // too heavy now: another truck of the route?
        release(sim, bin, dirty);
        place(sim, bin, dirty);
      } else if (owner && owner.status === 'driving' && owner.mode === 'collect') dirty.add(owner); // it may no longer fit
      else if (!owner) { release(sim, bin, dirty); place(sim, bin, dirty); }
    } else if (bin.fill > 0) { // filled up again → needs another pickup
      bin.load = (bin.capacityKg * bin.fill) / 100;
      bin.state = 'pending';
      bin.truckId = bin.collectedBy = bin.collectedAt = bin.fillAtPickup = null;
      place(sim, bin, dirty);
    }
  });
  return { ok: true, bin };
}

export function deleteBin(sim, id) {
  const bin = sim.binsById.get(id);
  if (!bin) return;
  commit(sim, (dirty) => {
    if (serviceable(bin)) release(sim, bin, dirty);
    sim.bins = sim.bins.filter((b) => b.id !== id);
    sim.binsById.delete(id);
  });
}

// ===========================================================================
//  Routes
// ===========================================================================

/** Is this outline usable? @returns {string} '' or a warning in plain words. */
export function areaProblem(sim, poly, ignoreId = null) {
  if (poly.length < 3) return 'Click at least 3 corners to make an area.';
  if (selfCrosses(poly)) return 'The outline crosses itself. Please draw a simple shape.';
  if (polygonArea(poly) < 1) return 'This area is too small. Please draw it larger.';
  for (const r of sim.routes.values()) {
    if (r.id !== ignoreId && polygonsOverlap(poly, r.poly)) return `This area overlaps "${r.name}". Routes cannot overlap, so it was not saved.`;
  }
  return roadProblem(sim, buildArea(sim.graph, poly, sim.bins.filter((b) => pointInPolygon(b.x, b.y, poly)), drivable(sim)));
}

/** Can trucks drive in the area and get to it? (buildArea() only uses corners they can reach.) */
function roadProblem(sim, { core }) {
  return core.length < 2 ? 'There is no road trucks can use fully inside this area. Please draw it larger.' : '';
}

/**
 * Create a route, or change the one with the same id.
 * def: { id, name, color, truckIds, poly,
 *        excluded?: bin ids inside the area that are NOT part of the route,
 *        order?:    bin ids in the order to visit them (null = shortest way) }
 */
export function saveRoute(sim, def) {
  const problem = areaProblem(sim, def.poly, def.id);
  if (problem) return { ok: false, message: problem };
  const known = new Set(sim.trucks.map((t) => t.id));
  const truckIds = def.truckIds.filter((id) => known.has(id));
  for (const r of sim.routes.values()) {
    if (r.id !== def.id && r.truckIds.some((id) => truckIds.includes(id))) {
      return { ok: false, message: `A chosen truck already works on "${r.name}".` };
    }
  }
  const old = sim.routes.get(def.id);
  const excluded = Array.isArray(def.excluded) ? def.excluded : [];
  const order = Array.isArray(def.order) ? def.order : null;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (old && same(old.poly, def.poly) && same(old.truckIds, truckIds) && same(old.excluded, excluded) && same(old.order, order)) { // rename / recolour only
    old.name = def.name;
    old.color = def.color;
    return { ok: true, route: old };
  }

  const left = new Set(excluded);
  const inside = binsInside(sim, def.poly).filter((b) => !left.has(b.id));
  const area = buildArea(sim.graph, def.poly, inside, drivable(sim));
  const noRoad = roadProblem(sim, area);
  if (noRoad) return { ok: false, message: noRoad };

  commit(sim, (dirty) => {
    const insideSet = new Set(inside);
    const router = new Router(sim.graph, sim.road, { heuristic: sim.world.settings.heuristic });
    router.weight = (arc) => (area.edgeOk[sim.graph.adjEdge[arc]] ? sim.road.arcWeight(arc) : Infinity);
    router.stats = sim.router.stats; // one set of search statistics for the whole run
    const route = { id: def.id, name: def.name, color: def.color, poly: def.poly, truckIds, excluded, order, numbers: new Map(), area, router };
    if (order) inside.sort((a, b) => (order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(b.id) + 1 || 1e9));
    inside.forEach((b, i) => route.numbers.set(b.id, i + 1));

    // Let go of everything that changes hands.
    for (const bin of sim.bins) {
      if (serviceable(bin) && (bin.routeId === def.id || insideSet.has(bin))) release(sim, bin, dirty);
    }
    const loose = new Set();
    for (const truck of routeTrucks(sim, route)) {
      for (const id of truck.queue.slice()) {
        const bin = sim.binsById.get(id);
        release(sim, bin, dirty);
        loose.add(bin);
      }
    }
    for (const id of old ? old.truckIds : []) {
      if (!truckIds.includes(id)) detach(sim.trucks.find((t) => t.id === id), dirty);
    }

    sim.routes.set(def.id, route);
    for (const bin of sim.bins) {
      if (insideSet.has(bin)) bin.routeId = def.id;
      else if (bin.routeId === def.id) { bin.routeId = null; loose.add(bin); }
    }
    for (const truck of routeTrucks(sim, route)) attach(truck, route, dirty);
    for (const bin of loose) if (!bin.routeId) place(sim, bin, dirty);
    distribute(sim, route, inside, dirty);
    sim.log('info', `${old ? 'Changed' : 'Created'} ${route.name}: ${inside.length} bins, ` +
      `${routeTrucks(sim, route).map((t) => t.name).join(', ') || 'no truck'}`);
  });
  return { ok: true, route: sim.routes.get(def.id) };
}

export function removeRoute(sim, id) {
  const route = sim.routes.get(id);
  if (!route) return;
  commit(sim, (dirty) => {
    const mine = sim.bins.filter((b) => b.routeId === id);
    for (const bin of mine) if (serviceable(bin)) release(sim, bin, dirty);
    for (const truck of routeTrucks(sim, route)) detach(truck, dirty);
    sim.routes.delete(id);
    for (const bin of mine) { bin.routeId = null; place(sim, bin, dirty); }
    sim.log('info', `Deleted ${route.name}`);
  });
}

/** Put a truck on a route. It stays where it is; planNextOnRoute() then drives it to the area. */
function attach(truck, route, dirty) {
  const isNew = truck.routeId !== route.id;
  dropTarget(truck, dirty); // a truck that is unloading finishes that first
  truck.routeId = route.id;
  truck.mode = 'collect';
  if (isNew) {
    truck.phase = truck.status === 'unloading' ? 'toLandfill' : '';
    resetTrip(truck);
  }
}

/** Take a truck off its route. It stays where it is and goes on as a normal truck. */
function detach(truck, dirty) {
  if (!truck) return; // not in this fleet variant
  dropTarget(truck, dirty);
  truck.routeId = null;
  truck.phase = '';
  truck.mode = 'collect';
  resetTrip(truck);
}

function resetTrip(truck) {
  truck.trip = null;
  truck.timeline = [];
  truck.holdUntil = 0;
}

/** Share the bins between the route's trucks: equal slices going round the area. */
function distribute(sim, route, bins, dirty) {
  if (bins.length === 0) return;
  const trucks = routeTrucks(sim, route);
  const cx = bins.reduce((s, b) => s + b.x, 0) / bins.length;
  const cy = bins.reduce((s, b) => s + b.y, 0) / bins.length;
  const ready = [];
  for (const bin of bins) {
    const node = accessNode(sim, bin.x, bin.y, route.id, bin.homeNode);
    if (node < 0 || trucks.length === 0 || !serviceable(bin)) place(sim, bin, dirty);
    else { putPin(sim, bin, node); bin.unreachable = false; ready.push(bin); }
  }
  if (!route.order) ready.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  ready.forEach((bin, i) => {
    const truck = trucks[Math.floor((i * trucks.length) / ready.length)];
    giveBin(sim, bin, truck.maxCapacity >= bin.load ? truck : carrier(trucks, bin), 'route');
  });
}

// ===========================================================================
//  Route truck decisions
// ===========================================================================

/** Start a part of the trip; `text` goes on the timeline once, when the part begins. */
function setPhase(sim, truck, phase, text = '') {
  if (truck.phase === phase) return;
  truck.phase = phase;
  if (text) note(sim, truck, text);
}

/** Simulation.planNext() for a truck on a route (see the trip in the header). */
export function planNextOnRoute(sim, truck) {
  const { graph, world } = sim;
  const route = sim.routes.get(truck.routeId);
  const from = rerouteOrigin(graph, truck);
  const locked = lockedArc(truck);

  for (const id of truck.queue.slice()) { // a bin no trip could ever carry
    const bin = sim.binsById.get(id);
    if (bin.load <= truck.maxCapacity) continue;
    truck.queue = truck.queue.filter((q) => q !== id);
    bin.state = 'pending';
    bin.truckId = null;
    note(sim, truck, `Skipped ${bin.name}: too heavy for this truck`);
  }

  if (truck.queue.length === 0) { goHome(sim, truck, from, locked); return; }

  const next = sim.binsById.get(routeOrder(sim, truck, truck.queue, from)[0]);
  if (truck.load + next.load > truck.maxCapacity) {
    truck.mode = 'full';
    setPhase(sim, truck, 'toLandfill', 'Truck full: going to the landfill');
    sim.routeTo(truck, { kind: 'disposal', node: world.disposal }, 'route');
    return;
  }

  truck.mode = 'collect';
  const inside = route.area.inCore[from] === 1 && (locked === null || route.area.edgeOk[graph.adjEdge[locked]] === 1);
  if (!inside) {
    // Drive to the area; nothing is collected on the way.
    const onTrip = truck.trip && truck.trip.finishedAt === null; // otherwise trackTrip() writes the line
    setPhase(sim, truck, 'toArea', onTrip ? `Driving to ${route.name}` : '');
    const entry = entryNode(sim, route, from);
    if (entry < 0) sim.block(truck, `no open road to ${route.name}`);
    else sim.routeTo(truck, { kind: 'entry', node: entry }, 'route');
    return;
  }
  setPhase(sim, truck, 'area', truck.phase === 'toArea' ? `Reached ${route.name}` : '');
  if (sim.routeToBin(truck, next.id, 'route') || sim.routeToReachableBin(truck, next.id, 'route')) return;
  sim.block(truck, `no road inside the route area to ${next.name}`);
}

/** No bins left: clear out at the landfill, then drive back to the depot and park. */
function goHome(sim, truck, from, locked) {
  const { world } = sim;
  if (truck.load > 0) {
    truck.mode = 'final';
    setPhase(sim, truck, 'toLandfill', 'All bins collected: going to the landfill');
    sim.routeTo(truck, { kind: 'disposal', node: world.disposal }, 'route');
  } else if (world.settings.return_to_depot && (from !== world.depot || locked !== null)) {
    truck.mode = 'final';
    setPhase(sim, truck, 'toDepot', 'Going back to the depot');
    sim.routeTo(truck, { kind: 'depot', node: world.depot }, 'route');
  } else if (locked !== null) { // trucks do not return in this scenario: finish the road, then stop
    sim.routeTo(truck, { kind: 'stop', node: from }, 'route');
  } else {
    truck.phase = 'done';
    truck.mode = 'collect';
    truck.status = 'idle';
    truck.target = null;
    truck.arcs = [];
  }
}

/** Why is a route truck stuck? */
export function blockedReason(sim, truck) {
  if (!isConfined(truck)) return 'Stopped: road closed';
  const goal = truck.target?.node ?? sim.binsById.get(truck.queue[0])?.node;
  if (goal === undefined) return OUTSIDE_MSG;
  const open = sim.router.legCost(rerouteOrigin(sim.graph, truck), goal, 'route') < Infinity;
  return open ? OUTSIDE_MSG : 'Stopped: road closed';
}

/** Occasional demo delays for route trucks (own seeded RNG; normal trucks are untouched). */
export function delayAfterPickup(sim, truck) {
  if (!sim.truckDelays || truck.queue.length === 0) return;
  if (truck.queue.some((id) => sim.binsById.get(id).node === truck.node)) return; // still busy at this place
  if (sim.delayRng() >= 0.07) return;
  hold(sim, truck, 60 * (3 + Math.floor(sim.delayRng() * 5)), 'heavy traffic');
}

/** Extra seconds at the landfill: a full truck sometimes has to wait in line. */
export function delayAtLandfill(sim, truck) {
  if (!sim.truckDelays || sim.delayRng() >= 0.15) return 0;
  const min = 2 + Math.floor(sim.delayRng() * 5);
  truck.serviceProblem = 'line at the landfill';
  if (truck.trip) truck.trip.reason = 'line at the landfill';
  note(sim, truck, `Delayed ${min} min: truck full, waiting in line at the landfill`);
  return min * 60;
}

export function hold(sim, truck, seconds, reason) {
  truck.holdUntil = Math.max(truck.holdUntil, sim.time) + seconds;
  if (truck.trip) truck.trip.reason = reason;
  note(sim, truck, `Delayed ${Math.round(seconds / 60)} min: ${reason}`);
}

/** Extra seconds at a bin that is blocked (0 most of the time). */
export function delayAtBin(sim, truck, bin) {
  if (!sim.truckDelays || truck.lastStop === bin.node || sim.delayRng() >= 0.05) return 0;
  const min = 2 + Math.floor(sim.delayRng() * 3);
  truck.serviceProblem = 'blocked bin';
  if (truck.trip) truck.trip.reason = 'blocked bin';
  note(sim, truck, `Delayed ${min} min: ${bin.name} was blocked`);
  return min * 60;
}

/** The rest of a route truck's way after its current stop, as arcs (for the map). */
export function remainingPath(sim, truck) {
  let at = truck.target ? truck.target.node : truck.node;
  const rest = truck.queue.filter((id) => id !== truck.target?.binId);
  const route = sim.routes.get(truck.routeId);
  const key = `${at}#${rest.map((id) => `${id}@${sim.binsById.get(id).node}`).join('|')}#${sim.road.version}`;
  if (truck._pathKey === key && truck._pathRoute === route) return truck._path;
  truck._pathRoute = route;
  const { weight } = route.router;
  const arcs = [];
  if (rest.length) {
    const entry = entryNode(sim, route, at); // from the landfill it first drives back in
    if (entry >= 0) at = entry;
  }
  const heuristic = route.router._h();
  for (const id of routeOrder(sim, truck, rest, at)) {
    const goal = sim.binsById.get(id).node;
    // Drawing only, so it bypasses the router's search statistics.
    const res = astarSearch(sim.graph, at, goal, { weight, heuristic });
    if (!res.found) continue;
    arcs.push(...res.arcs);
    at = goal;
  }
  truck._pathKey = key;
  return (truck._path = arcs);
}
