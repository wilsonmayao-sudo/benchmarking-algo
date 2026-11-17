/**
 * Fleet simulation engine — garbage trucks collecting bins on a road network with
 * dynamic road events.
 *
 * The engine is pure logic: no DOM, no timers. The browser UI calls `step()` from an
 * animation loop; the Node CLI calls `run()` to completion. Both produce identical
 * results for the same config (everything random is seeded).
 *
 * ONE TICK (`step(dt)`)
 *   1. apply every event due at the current time   → handleEvent()
 *        road state changes, affected trucks reroute (A* from where they are), trucks
 *        with no route are flagged BLOCKED, and the event is logged with the rerouted /
 *        blocked trucks
 *   2. advance every truck by dt seconds            → advance()
 *        drive along arcs, arrive, service a bin, unload at the disposal site
 *   3. check whether the run is over                → checkFinished()
 *
 * DECISIONS (`planNext`) happen whenever a truck has to choose where to go next:
 *   next bin would overflow  → handoff remaining bins, drive to disposal (mode "full")
 *   queue empty              → unload if carrying load, then return to depot, then idle
 *   otherwise                → A* to the next bin
 *
 * Module map
 *   routing/astar.js      reusable A* (+ Euclidean / Manhattan heuristics)
 *   routing/roadState.js  closures + delay multipliers (graph itself is never mutated)
 *   routing/router.js     A* with statistics + leg cache
 *   events/eventSystem.js event queue + how each event changes the road state
 *   fleet/truck.js        truck state + geometry
 *   fleet/bins.js         bin state + colour status
 *   fleet/dispatcher.js   assignment, capacity handoff, pending queue
 *   fleet/eta.js          ETA to next stop / end of route
 *   metrics.js            run summary + CSV / JSON export
 */

import { RoadState } from './routing/roadState.js';
import { Router } from './routing/router.js';
import { EventQueue, applyRoadEvent } from './events/eventSystem.js';
import { createTruckState, rerouteOrigin, lockedArc, routeUsesEdge } from './fleet/truck.js';
import { createBinState } from './fleet/bins.js';
import { initialAssignment, handoff, assignPending } from './fleet/dispatcher.js';
import { computeEta, plannedOrder, fmtClock } from './fleet/eta.js';
import { summarize } from './metrics.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Simulation {
  /** @param {object} world output of loadScenario() */
  constructor(world) {
    this.world = world;
    this.graph = world.graph;
    this.road = new RoadState(world.graph);
    this.router = new Router(world.graph, this.road, { heuristic: world.settings.heuristic });
    this.events = new EventQueue(world.events);

    this.bins = world.bins.map(createBinState);
    this.binsById = new Map(this.bins.map((b) => [b.id, b]));
    this.trucks = world.trucks.map(createTruckState);
    this.pending = [];       // bin ids waiting for a truck

    this.time = 0;
    this.finished = false;
    this.finishReason = '';
    this.lastActiveTime = 0; // makespan: when the last truck stopped working

    this.logEntries = [];    // everything, in order — shown in the UI log
    this.eventLog = [];      // one entry per road event (timestamp, edge, rerouted trucks)
    this.metrics = {
      reroutes: 0,           // reroutes caused by road events
      reassignments: 0,      // bins moved to another truck (handoff or pending → truck)
      blockedIncidents: 0,   // times a truck was flagged blocked
      eventsApplied: 0,
      etaRecalcs: 0,
      etaErrors: [],         // |actual − predicted| arrival at a bin, seconds
      wallMs: 0,
    };
    this.listeners = new Set();

    const t0 = now();
    this.log('info', `Scenario "${world.name}" — ${this.trucks.length} trucks, ${this.bins.length} bins, ` +
      `${world.events.length} events (${world.variant})`);
    initialAssignment(this);
    for (const truck of this.trucks) {
      if (truck.queue.length > 0) this.planNext(truck);
    }
    this.refreshAllEta('initial plan');
    this.metrics.wallMs += now() - t0;
  }

  // =======================================================================
  //  Public API
  // =======================================================================

  /** Advance the simulation by `dt` seconds (default: settings.dt_s). */
  step(dt = this.world.settings.dt_s) {
    if (this.finished) return;
    const t0 = now();

    for (const ev of this.events.popDue(this.time)) this.handleEvent(ev);
    for (const truck of this.trucks) this.advance(truck, this.time, dt);
    this.time += dt;
    this.checkFinished();

    this.metrics.wallMs += now() - t0;
  }

  /** Run to completion (used by the CLI and tests). */
  run() {
    while (!this.finished) this.step();
    return this.summary();
  }

  summary() {
    return summarize(this);
  }

  /** Append to the run log. kind: info | event | handoff | pending | warning | assign | collect */
  log(kind, text, data = null) {
    const entry = { time: this.time, clock: fmtClock(this.time), kind, text, data };
    this.logEntries.push(entry);
    for (const fn of this.listeners) fn(entry);
  }

  onLog(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // =======================================================================
  //  Road events
  // =======================================================================

  handleEvent(ev) {
    const { graph } = this;
    const result = applyRoadEvent(ev, this.road, this.events);
    const edgeName = this.world.edgeLabel(ev.edge);
    const rerouted = [];
    const blocked = [];
    const unblocked = [];
    this.metrics.eventsApplied++;

    if (result.changed) {
      // Which trucks must re-plan?
      //  • closure / extra delay: only trucks whose remaining route uses the road
      //  • reopen / delay cleared: every driving truck (a shorter route may exist now)
      const improving = ev.type === 'ROAD_REOPEN' || (ev.type === 'TRAFFIC_DELAY' && ev.factor < 1);

      for (const truck of this.trucks) {
        if (truck.status === 'blocked') continue; // handled below
        if (truck.status !== 'driving' || !truck.target) continue;
        if (!improving && !routeUsesEdge(graph, truck, ev.edge)) continue;

        const outcome = this.replan(truck, ev.type === 'ROAD_CLOSURE' ? 'closure' : 'event');
        if (outcome === 'rerouted') rerouted.push(truck.name);
        if (outcome === 'blocked') blocked.push(truck.name);
      }

      // Blocked trucks retry after ANY road change.
      for (const truck of this.trucks) {
        if (truck.status !== 'blocked' || blocked.includes(truck.name)) continue;
        if (this.tryUnblock(truck)) unblocked.push(truck.name);
      }

      // A road change can make a pending bin reachable.
      this.wakeTrucks(assignPending(this));
      this.refreshAllEta(`${ev.type} on ${edgeName}`);
    }

    const entry = {
      time: ev.time,
      clock: fmtClock(ev.time),
      type: ev.type,
      edge: edgeName,
      edgeIndex: ev.edge,
      source: ev.source,
      description: result.description + (ev.note ? ` (${ev.note})` : ''),
      rerouted,
      blocked,
      unblocked,
    };
    this.eventLog.push(entry);

    const parts = [`${ev.type} ${edgeName}: ${entry.description}`];
    parts.push(rerouted.length ? `rerouted ${rerouted.join(', ')}` : 'no truck rerouted');
    if (blocked.length) parts.push(`BLOCKED ${blocked.join(', ')}`);
    if (unblocked.length) parts.push(`unblocked ${unblocked.join(', ')}`);
    this.log('event', parts.join(' · '), entry);
  }

  /**
   * Re-run A* from where the truck is now to its current target.
   * @returns {'same'|'rerouted'|'blocked'}
   */
  replan(truck, why) {
    const origin = rerouteOrigin(this.graph, truck);
    const locked = lockedArc(truck);
    const res = this.router.findPath(origin, truck.target.node, 'reroute');

    if (res.found) {
      const arcs = locked !== null ? [locked, ...res.arcs] : res.arcs;
      const changed = arcs.length !== truck.arcs.length || arcs.some((a, i) => a !== truck.arcs[i]);
      truck.arcs = arcs;
      if (!changed) return 'same';
      truck.reroutes++;
      this.metrics.reroutes++;
      return 'rerouted';
    }

    // Target unreachable. For a bin, try the rest of the queue before giving up.
    if (truck.target.kind === 'bin' && this.routeToReachableBin(truck, truck.target.binId, 'reroute')) {
      truck.reroutes++;
      this.metrics.reroutes++;
      return 'rerouted';
    }
    this.block(truck, `no route to ${this.targetName(truck.target)} (${why})`);
    return 'blocked';
  }

  /** A blocked truck tries again. Returns true if it found a route. */
  tryUnblock(truck) {
    truck.status = 'driving';            // provisional; planNext() re-blocks if needed
    const wasQuiet = truck._quietBlock;
    truck._quietBlock = true;            // do not double-count / re-log the same blockage
    this.planNext(truck);
    truck._quietBlock = wasQuiet;
    // (The event log line that triggered this lists the truck under "unblocked".)
    return truck.status !== 'blocked';
  }

  block(truck, reason) {
    const locked = lockedArc(truck);
    truck.arcs = locked !== null ? [locked] : []; // finish the road it is on, then wait
    const alreadyBlocked = truck._quietBlock;
    truck.status = 'blocked';
    truck.pendingEtaCheck = null;
    if (!alreadyBlocked) {
      truck.blockedCount++;
      this.metrics.blockedIncidents++;
      this.log('warning', `⚠ ${truck.name} BLOCKED: ${reason}. Waiting for a road to reopen.`, { truck: truck.id });
    }
  }

  // =======================================================================
  //  Decisions
  // =======================================================================

  /** Choose the truck's next target and route to it (see header). */
  planNext(truck) {
    const s = this.world.settings;

    if (truck.mode === 'full') {
      this.routeTo(truck, { kind: 'disposal', node: this.world.disposal }, 'route');
      return;
    }

    if (truck.queue.length > 0) {
      truck.mode = 'collect';
      const from = rerouteOrigin(this.graph, truck);
      const order = plannedOrder(this.graph, truck.queue, this.binsById, from, s.visit_order);
      const next = this.binsById.get(order[0]);

      // Capacity check: full, or the next bin would overflow → hand off and unload.
      if (truck.load >= truck.maxCapacity || truck.load + next.load > truck.maxCapacity) {
        const why = truck.load >= truck.maxCapacity ? 'full' : `full (${Math.round(truck.load)}/${truck.maxCapacity} kg, next bin ${Math.round(next.load)} kg)`;
        truck.mode = 'full';
        const remaining = truck.queue.slice();
        const touched = handoff(this, truck, remaining, why);
        this.routeTo(truck, { kind: 'disposal', node: this.world.disposal }, 'route');
        this.wakeTrucks(touched);
        return;
      }

      if (!this.routeToBin(truck, next.id, 'route')) {
        if (!this.routeToReachableBin(truck, next.id, 'route')) {
          this.block(truck, `no route to ${next.name} or any other assigned bin`);
        }
      }
      return;
    }

    // Queue empty: unload if needed, then go home, then idle.
    // (If the truck is already at the disposal site the route is empty and it unloads
    //  on arrival straight away.)
    const at = rerouteOrigin(this.graph, truck);
    if (truck.load > 0) {
      truck.mode = 'final';
      this.routeTo(truck, { kind: 'disposal', node: this.world.disposal }, 'route');
    } else if (s.return_to_depot && at !== this.world.depot) {
      truck.mode = 'final';
      this.routeTo(truck, { kind: 'depot', node: this.world.depot }, 'route');
    } else {
      this.goIdle(truck);
    }
  }

  routeToBin(truck, binId, purpose) {
    const bin = this.binsById.get(binId);
    return this.routeTo(truck, { kind: 'bin', node: bin.node, binId }, purpose, true);
  }

  /** Target `skipId` is unreachable — visit another queued bin that fits, if any is reachable. */
  routeToReachableBin(truck, skipId, purpose) {
    const from = rerouteOrigin(this.graph, truck);
    const order = plannedOrder(this.graph, truck.queue.filter((id) => id !== skipId), this.binsById, from,
      this.world.settings.visit_order);
    for (const id of order) {
      const bin = this.binsById.get(id);
      if (truck.load + bin.load > truck.maxCapacity) continue;
      if (this.routeToBin(truck, id, purpose)) {
        this.log('warning', `${this.binsById.get(skipId).name} is unreachable for ${truck.name} — visiting ${bin.name} first`);
        return true;
      }
    }
    return false;
  }

  /**
   * A* from where the truck is to `target`. On success the truck drives there.
   * @param {boolean} [quiet] true: on failure return false instead of blocking the truck
   */
  routeTo(truck, target, purpose, quiet = false) {
    const origin = rerouteOrigin(this.graph, truck);
    const locked = lockedArc(truck);
    const res = this.router.findPath(origin, target.node, purpose);
    if (!res.found) {
      if (!quiet) this.block(truck, `no route to ${this.targetName(target)}`);
      return false;
    }
    const isNewLeg = !truck.target || truck.target.node !== target.node || truck.target.kind !== target.kind;
    truck.target = target;
    truck.arcs = locked !== null ? [locked, ...res.arcs] : res.arcs;
    truck.status = 'driving';
    if (isNewLeg) truck.pendingEtaCheck = null;
    return true;
  }

  goIdle(truck) {
    truck.status = 'idle';
    truck.mode = 'collect';
    truck.target = null;
    truck.arcs = [];
    // A truck that frees up takes pending bins first.
    const touched = assignPending(this);
    if (touched.includes(truck.id)) this.planNext(truck);
    this.wakeTrucks(touched.filter((id) => id !== truck.id));
  }

  /** Trucks that just received bins: idle / finishing trucks start working immediately. */
  wakeTrucks(ids) {
    for (const id of ids) {
      const truck = this.trucks.find((t) => t.id === id);
      if (truck.status === 'idle' || (truck.status === 'driving' && truck.mode === 'final')) {
        truck.mode = 'collect';
        this.planNext(truck);
      }
      this.refreshEta(truck);
    }
  }

  // =======================================================================
  //  Movement
  // =======================================================================

  /** Move / service / unload `truck` for the tick [t0, t0 + dt). */
  advance(truck, t0, dt) {
    const { graph, road } = this;
    const tEnd = t0 + dt;
    let clock = t0;
    const wasActive = truck.status !== 'idle' && !(truck.status === 'blocked' && truck.arcs.length === 0);

    for (let guard = 0; clock < tEnd && guard < 10000; guard++) {
      if (truck.status === 'servicing' || truck.status === 'unloading') {
        if (truck.busyUntil > tEnd) break;
        clock = Math.max(clock, truck.busyUntil);
        if (truck.status === 'servicing') this.finishService(truck, clock);
        else this.finishUnloading(truck, clock);
        continue;
      }

      const moving = truck.status === 'driving' || (truck.status === 'blocked' && truck.arcs.length > 0);
      if (!moving) break;

      if (truck.arcs.length === 0) {
        if (truck.status === 'blocked') break;
        this.arrive(truck, clock);
        continue;
      }

      // Drive along arcs[0]. Speed along a road = truck speed / delay multiplier, so the
      // time to cross it equals weight / speed — the same quantity the ETA uses.
      const a = truck.arcs[0];
      const e = graph.adjEdge[a];
      const len = graph.edgeLength[e];
      const v = truck.speed / road.multiplier[e];
      const left = len - truck.arcPos;
      const need = left / v;
      if (need <= tEnd - clock) {
        clock += need;
        truck.distance += left;
        truck.node = graph.adjNeighbor[a];
        truck.arcs.shift();
        truck.arcPos = 0;
      } else {
        const d = (tEnd - clock) * v;
        truck.arcPos += d;
        truck.distance += d;
        clock = tEnd;
      }
    }

    if (wasActive) {
      truck.activeTime += dt;
      this.lastActiveTime = tEnd;
    }
  }

  arrive(truck, clock) {
    const target = truck.target;
    truck.node = target.node;
    if (target.kind === 'bin') {
      const bin = this.binsById.get(target.binId);
      if (truck.pendingEtaCheck && truck.pendingEtaCheck.binId === bin.id) {
        this.metrics.etaErrors.push(Math.abs(clock - truck.pendingEtaCheck.predictedAt));
      }
      truck.pendingEtaCheck = null;
      truck.status = 'servicing';
      truck.busyUntil = clock + bin.serviceTime;
    } else if (target.kind === 'disposal') {
      this.startUnloading(truck, clock);
    } else {
      this.planNext(truck); // depot → idle (or new work)
      this.refreshEta(truck);
    }
  }

  startUnloading(truck, clock) {
    truck.status = 'unloading';
    truck.busyUntil = clock + this.world.settings.unload_time_s;
    truck.target = { kind: 'disposal', node: this.world.disposal };
  }

  finishService(truck, clock) {
    const bin = this.binsById.get(truck.target.binId);
    bin.state = 'collected';
    bin.collectedBy = truck.id;
    bin.collectedAt = clock;
    bin.fillAtPickup = bin.fill;
    bin.fill = 0;
    truck.load += bin.load;
    truck.collected++;
    truck.queue = truck.queue.filter((id) => id !== bin.id);
    truck.status = 'driving';
    truck.target = null;
    this.log('collect', `${truck.name} collected ${bin.name} (+${Math.round(bin.load)} kg, load ` +
      `${Math.round(truck.load)}/${truck.maxCapacity} kg)`);
    this.planNext(truck);
    this.refreshEta(truck);
  }

  finishUnloading(truck, clock) {
    const unloaded = truck.load;
    truck.load = 0;
    truck.disposalTrips++;
    truck.mode = 'collect';
    truck.status = 'driving';
    this.log('info', `${truck.name} unloaded ${Math.round(unloaded)} kg at the disposal site — capacity free`);
    // A truck that frees up takes pending bins.
    const touched = assignPending(this);
    this.planNext(truck);
    this.wakeTrucks(touched.filter((id) => id !== truck.id));
    this.refreshEta(truck);
  }

  // =======================================================================
  //  ETA + end of run
  // =======================================================================

  refreshEta(truck) {
    truck.eta = computeEta(this, truck);
    this.metrics.etaRecalcs++;
    // Remember the first prediction for this leg to measure ETA accuracy on arrival.
    if (!truck.pendingEtaCheck && truck.status === 'driving' && truck.target && truck.target.kind === 'bin') {
      truck.pendingEtaCheck = { binId: truck.target.binId, predictedAt: truck.eta.nextAt };
    }
  }

  refreshAllEta() {
    for (const truck of this.trucks) this.refreshEta(truck);
  }

  checkFinished() {
    const settled = this.trucks.every((t) => t.status === 'idle' || (t.status === 'blocked' && t.arcs.length === 0));
    const anyBlocked = this.trucks.some((t) => t.status === 'blocked');
    if (settled && (this.events.size === 0 || (!anyBlocked && this.pending.length === 0))) {
      this.finish(anyBlocked ? 'remaining trucks blocked, no more events' : 'all trucks back at the depot');
    } else if (this.time >= this.world.settings.max_time_s) {
      this.finish('time limit reached');
    }
  }

  finish(reason) {
    this.finished = true;
    this.finishReason = reason;
    const missed = [];
    for (const bin of this.bins) {
      if (bin.state !== 'collected') {
        bin.state = 'missed';
        missed.push(bin.name);
      }
    }
    if (missed.length) this.log('warning', `⚠ ${missed.length} bin(s) not collected: ${missed.join(', ')}`);
    this.log('info', `Run finished at ${fmtClock(this.time)} — ${reason}`);
  }

  targetName(target) {
    if (!target) return 'nothing';
    if (target.kind === 'bin') return this.binsById.get(target.binId).name;
    return target.kind === 'disposal' ? 'the disposal site' : 'the depot';
  }
}
