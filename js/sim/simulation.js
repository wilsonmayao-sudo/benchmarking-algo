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
 *   fleet/routes.js       bin edits + truck routes locked to an area (strict)
 *   fleet/trip.js         plain-language trip details (status, next stop, delay, events)
 *   metrics.js            run summary + CSV / JSON export
 */

import { RoadState } from './routing/roadState.js';
import { Router } from './routing/router.js';
import { EventQueue, applyRoadEvent, isOperationalEvent } from './events/eventSystem.js';
import { createTruckState, rerouteOrigin, lockedArc, routeUsesEdge } from './fleet/truck.js';
import { createBinState } from './fleet/bins.js';
import { initialAssignment, handoff, assignPending } from './fleet/dispatcher.js';
import { computeEta, plannedOrder, fmtClock } from './fleet/eta.js';
import { summarize } from './metrics.js';
import { mulberry32 } from '../core/rng.js';
import {
  routerFor, arcAllowed, note, planNextOnRoute, blockedReason, delayAfterPickup, delayAtBin, delayAtLandfill,
  OUTSIDE_MSG, routeOrder, stopTime,
} from './fleet/routes.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Simulation {
  /** @param {object} world output of loadScenario() */
  constructor(world) {
    this.world = world;
    this.graph = world.graph;
    const st = world.settings;
    this.road = new RoadState(world.graph, {
      costMode: st.cost_mode || 'distance',
      climbWeight: st.climb_weight ?? 0.5,
      descentWeight: st.descent_weight ?? 0.15,
    });
    this.router = new Router(world.graph, this.road, {
      heuristic: st.heuristic,
      engine: st.routing_engine || (st.heuristic === 'alt' ? 'fast' : 'legacy'),
      weightFactor: st.weight_factor ?? 1.0,
      landmarks: st.alt_landmarks ?? 6,
      altIndex: world.altIndex || null,
      cachePaths: Boolean(st.cache_paths),
      allowed: world.allowed || null,
    });
    this.events = new EventQueue(world.events);
    this._orderCache = new Map();
    this.offlineSyncQueue = [];

    this.bins = world.bins.map(createBinState);
    for (const b of this.bins) {
      b.x = this.graph.x[b.node];
      b.y = this.graph.y[b.node];
      b.homeNode = b.node;   // nearest corner; `node` may move to a corner inside its route area
      b.type = b.type || 'General';
      b.routeId = null;      // null = Unassigned (not in any route area)
    }
    this.binsById = new Map(this.bins.map((b) => [b.id, b]));
    this.trucks = world.trucks.map(createTruckState);
    this.pending = [];       // bin ids waiting for a truck

    this.routes = new Map(); // id → { id, name, color, truckIds, poly, area, router }
    this.truckDelays = true; // random delays for trucks on a route
    this.delayRng = mulberry32((world.seed + 977) >>> 0);
    this.noteSeq = 0;
    this.editing = false;    // an edit is running: work changed, so the plan moves with it
    this.inRoadEvent = false;

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
      sequencingTotalMs: 0,
      offlineSyncedEvents: 0,
      manualCapacityEvents: 0,
      unloadConfirmations: 0,
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

  /**
   * Apply a road event right now, while the run is in progress (UI "live events").
   * @param {{type:string, edge:number, factor?:number, duration?:number, note?:string, source?:string}} ev
   * @returns {object|null} the event-log entry, or null if the run is already finished / invalid
   */
  injectEvent(ev) {
    if (this.finished) return null;
    if (isOperationalEvent(ev)) return this.injectOperationalEvent(ev);
    if (!Number.isInteger(ev.edge) || ev.edge < 0 || ev.edge >= this.graph.edgeCount) return null;
    if (ev.type === 'TRAFFIC_DELAY' && !(ev.factor > 0)) return null;
    const full = { note: '', source: 'manual', ...ev, time: this.time };
    this.world.events.push(full); // keeps summary().events in step with what was applied
    const t0 = now();
    this.handleEvent(full);
    this.metrics.wallMs += now() - t0;
    return this.eventLog[this.eventLog.length - 1];
  }

  /** Inject an operational / driver / field event immediately at `this.time`. */
  injectOperationalEvent(ev) {
    if (this.finished || !isOperationalEvent(ev)) return null;
    const full = { note: '', source: 'manual', ...ev, time: this.time };
    this.world.events.push(full);
    const t0 = now();
    const res = this.handleOperationalEvent(full);
    this.metrics.wallMs += now() - t0;
    return res;
  }

  /**
   * Return a road to normal right now: reopen it and/or cancel its delay. Queued automatic
   * follow-ups for that road (closure expiry, "delay cleared") are dropped first, otherwise
   * an old "delay cleared" would later divide the weight again and make the road faster
   * than normal.
   * @returns {number} number of events applied (0 = the road was already normal)
   */
  clearRoad(edge, source = 'manual') {
    if (this.finished || !Number.isInteger(edge) || edge < 0 || edge >= this.graph.edgeCount) return 0;
    this.events.removeWhere((ev) => ev.edge === edge && ev.source === 'auto');
    let applied = 0;
    if (this.road.isClosed(edge)) {
      this.injectEvent({ type: 'ROAD_REOPEN', edge, source, note: 'cleared from the map' });
      applied++;
    }
    const m = this.road.multiplier[edge];
    if (m !== 1) {
      this.injectEvent({ type: 'TRAFFIC_DELAY', edge, factor: 1 / m, isEnd: true, source, note: 'cleared from the map' });
      applied++;
    }
    return applied;
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
    if (isOperationalEvent(ev)) {
      this.handleOperationalEvent(ev);
      return;
    }
    const { graph } = this;
    const result = applyRoadEvent(ev, this.road, this.events);
    const edgeName = this.world.edgeLabel(ev.edge);
    const rerouted = [];
    const blocked = [];
    const unblocked = [];
    this.metrics.eventsApplied++;

    if (result.changed) {
      this.inRoadEvent = true; // ETA changes from here on are delays, not changes of plan
      const endBefore = this.trucks.map((t) => (t.trip && t.status !== 'idle' ? t.trip.lastEnd : null));
      const cause = ev.type === 'ROAD_CLOSURE' ? 'road closed' : 'heavy traffic';
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
      this.inRoadEvent = false;
      this.trucks.forEach((truck, i) => {
        if (endBefore[i] === null || truck.status === 'blocked') return;
        const extra = truck.trip.lastEnd - endBefore[i];
        if (extra < 60) return;
        truck.trip.reason = cause;
        note(this, truck, `Delayed ${Math.round(extra / 60)} min: ${cause}`);
      });
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
    if (truck.target.kind === 'entry') { // on the way to its area: another way in may be better now
      const before = truck.arcs.slice();
      this.planNext(truck);
      if (truck.status === 'blocked') return 'blocked';
      if (truck.arcs.length === before.length && truck.arcs.every((a, i) => a === before[i])) return 'same';
      truck.reroutes++;
      this.metrics.reroutes++;
      return 'rerouted';
    }
    const origin = rerouteOrigin(this.graph, truck);
    const locked = lockedArc(truck);
    const res = routerFor(this, truck).findPath(origin, truck.target.node, 'reroute');

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
      const why = truck.routeId ? blockedReason(this, truck) : 'Stopped: road closed';
      if (truck.trip) truck.trip.reason = why.replace('Stopped: ', '');
      note(this, truck, why);
      if (why === OUTSIDE_MSG) this.log('warning', `${truck.name} — ${OUTSIDE_MSG}`);
      this.log('warning', `⚠ ${truck.name} BLOCKED: ${reason}. Waiting for a road to reopen.`, { truck: truck.id });
    }
  }

  // =======================================================================
  //  Decisions
  // =======================================================================

  /** Choose the truck's next target and route to it (see header). */
  planNext(truck) {
    if (truck.routeId) { planNextOnRoute(this, truck); return; }
    const s = this.world.settings;

    if (truck.status === 'awaiting_unload_confirm' || truck.awaitingUnloadConfirm) return;

    if (truck.mode === 'full' || (s.operational_mode && truck.reportedCapacityPct >= 100)) {
      truck.mode = 'full';
      this.routeTo(truck, { kind: 'disposal', node: this.world.disposal }, 'route');
      return;
    }

    if (truck.queue.length > 0) {
      truck.mode = 'collect';
      const from = rerouteOrigin(this.graph, truck);
      const seqCtx = {
        road: this.road,
        router: this.router,
        endNode: this.world.disposal,
        _orderCache: this._orderCache,
        onSeqTiming: (ms) => { this.metrics.sequencingTotalMs += ms; },
      };
      const order = plannedOrder(this.graph, truck.queue, this.binsById, from, s.visit_order, seqCtx);
      const next = this.binsById.get(order[0]);

      // In legacy mode: capacity overflow triggers cross-truck handoff.
      // In operational_mode: manual 25/50/75/100% reports trigger disposal without cross-truck handoff.
      if (!s.operational_mode && (truck.load >= truck.maxCapacity || truck.load + next.load > truck.maxCapacity)) {
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

    // Queue empty: unload at Sanitary Landfill if carrying load (or non-zero manual capacity),
    // then return to SWMO Office/Depot to park and end the shift.
    const at = rerouteOrigin(this.graph, truck);
    const midRoad = lockedArc(truck) !== null; // finish that road first, a truck never stops (or jumps) on it
    if (truck.load > 0 || (s.operational_mode && truck.reportedCapacityPct > 0)) {
      truck.mode = 'final';
      this.routeTo(truck, { kind: 'disposal', node: this.world.disposal }, 'route');
    } else if (s.return_to_depot && (at !== this.world.depot || midRoad)) {
      truck.mode = 'final';
      this.routeTo(truck, { kind: 'depot', node: this.world.depot }, 'route');
    } else if (midRoad) {
      this.routeTo(truck, { kind: 'stop', node: at }, 'route');
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
    const others = truck.queue.filter((id) => id !== skipId);
    const seqCtx = {
      road: this.road,
      router: this.router,
      endNode: this.world.disposal,
      _orderCache: this._orderCache,
      onSeqTiming: (ms) => { this.metrics.sequencingTotalMs += ms; },
    };
    const order = truck.routeId ? routeOrder(this, truck, others, from)
      : plannedOrder(this.graph, others, this.binsById, from, this.world.settings.visit_order, seqCtx);
    for (const id of order) {
      const bin = this.binsById.get(id);
      if (!this.world.settings.operational_mode && truck.load + bin.load > truck.maxCapacity) continue;
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
    const res = routerFor(this, truck).findPath(origin, target.node, purpose);
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

      // Waiting out a delay (heavy traffic, …): stand still.
      if (truck.holdUntil > clock && truck.arcPos === 0) {
        if (truck.holdUntil >= tEnd) break;
        clock = truck.holdUntil;
        continue;
      }

      if (truck.arcs.length === 0) {
        if (truck.status === 'blocked') break;
        this.arrive(truck, clock);
        continue;
      }

      // STRICT RULE: never enter a road outside the truck's route area.
      if (truck.arcPos === 0 && !arcAllowed(this, truck, truck.arcs[0])) {
        truck.arcs = [];
        this.log('warning', `${truck.name} — ${OUTSIDE_MSG}`);
        note(this, truck, OUTSIDE_MSG);
        this.planNext(truck);
        this.refreshEta(truck);
        if (truck.status === 'blocked') break;
        continue;
      }

      // Drive along arcs[0] using active costMode (distance-multiplier vs live speed + offline fallback).
      const a = truck.arcs[0];
      const e = graph.adjEdge[a];
      const len = graph.edgeLength[e];
      const v = road.costMode === 'time'
        ? road.effectiveSpeed(e)
        : truck.speed / (road.offline ? 1 : road.multiplier[e]);
      const left = len - truck.arcPos;
      const need = left / v;
      const kind = truck.target?.kind;
      if (need <= tEnd - clock) {
        clock += need;
        truck.distance += left;
        truck.drivingTimeS += need;
        if (kind === 'disposal') truck.disposalDistanceM += left;
        else if (kind === 'depot' || kind === 'stop') truck.returnDistanceM += left;
        else truck.collectionDistanceM += left;
        truck.traversedArcs.push(a);
        truck.node = graph.adjNeighbor[a];
        truck.arcs.shift();
        truck.arcPos = 0;
      } else {
        const dtStep = tEnd - clock;
        const d = dtStep * v;
        truck.arcPos += d;
        truck.distance += d;
        truck.drivingTimeS += dtStep;
        if (kind === 'disposal') truck.disposalDistanceM += d;
        else if (kind === 'depot' || kind === 'stop') truck.returnDistanceM += d;
        else truck.collectionDistanceM += d;
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
    if (truck.node !== target.node) { // never jump: if it is not really there yet, drive there
      this.planNext(truck);
      this.refreshEta(truck);
      return;
    }
    if (target.kind === 'bin') {
      const bin = this.binsById.get(target.binId);
      // STRICT RULE: never collect a bin of another route (or, on a route, a bin of none).
      if (bin.routeId !== truck.routeId) {
        this.log('warning', `${truck.name} — ${OUTSIDE_MSG}: ${bin.name}`);
        note(this, truck, `${OUTSIDE_MSG} (${bin.name})`);
        truck.queue = truck.queue.filter((id) => id !== bin.id);
        if (bin.truckId === truck.id) { bin.truckId = null; bin.state = 'pending'; }
        truck.target = null;
        this.planNext(truck);
        this.refreshEta(truck);
        return;
      }
      if (truck.pendingEtaCheck && truck.pendingEtaCheck.binId === bin.id) {
        this.metrics.etaErrors.push(Math.abs(clock - truck.pendingEtaCheck.predictedAt));
      }
      truck.pendingEtaCheck = null;
      truck.status = 'servicing';
      truck.busyUntil = clock + (truck.routeId ? stopTime(bin.node, truck.lastStop) + delayAtBin(this, truck, bin) : bin.serviceTime);
      if (truck.routeId) this.refreshEta(truck);
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
    if (truck.routeId) {
      truck.busyUntil += delayAtLandfill(this, truck);
      this.refreshEta(truck);
    }
  }

  finishService(truck, clock) {
    const bin = this.binsById.get(truck.target.binId);
    const s = this.world.settings;
    bin.visited = true;
    if (s.operational_mode && s.manual_stop_confirm) {
      // Wait for explicit STOP_CONFIRMED / STOP_SKIPPED event while keeping bin visited != confirmed
      bin.state = 'assigned';
      if (this.road.offline) {
        this.offlineSyncQueue.push({ time: clock, type: 'STOP_CONFIRMED', truckId: truck.id, binId: bin.id });
      }
    } else {
      bin.confirmed = true;
      bin.state = 'collected';
      bin.collectedBy = truck.id;
      bin.collectedAt = clock;
      bin.fillAtPickup = bin.fill;
      bin.fill = 0;
      truck.load += bin.load;
      truck.collected++;
      if (truck.trip) truck.trip.collected++;
      if (this.road.offline) {
        this.offlineSyncQueue.push({ time: clock, type: 'STOP_CONFIRMED', truckId: truck.id, binId: bin.id });
      }
    }
    truck.lastStop = bin.node;
    note(this, truck, `Picked up ${bin.name}`);
    truck.serviceProblem = '';
    truck.queue = truck.queue.filter((id) => id !== bin.id);
    truck.status = 'driving';
    truck.target = null;
    this.log('collect', `${truck.name} collected ${bin.name} (+${Math.round(bin.load)} kg, load ` +
      `${Math.round(truck.load)}/${truck.maxCapacity} kg)`);
    if (truck.routeId) delayAfterPickup(this, truck);
    this.planNext(truck);
    this.refreshEta(truck);
  }

  finishUnloading(truck, clock) {
    const s = this.world.settings;
    if (s.operational_mode && s.require_unload_confirm) {
      truck.status = 'awaiting_unload_confirm';
      truck.awaitingUnloadConfirm = true;
      note(this, truck, 'At Sanitary Landfill — awaiting explicit unload confirmation');
      this.log('info', `${truck.name} arrived at landfill — awaiting unload confirmation`);
      if (s.auto_confirm_unload_delay_s > 0) {
        const hasPending = this.events.upcoming().some((e) => e.type === 'UNLOAD_CONFIRMED' && e.truckId === truck.id);
        if (!hasPending) {
          this.events.push({
            time: clock + s.auto_confirm_unload_delay_s,
            type: 'UNLOAD_CONFIRMED',
            truckId: truck.id,
            source: 'auto',
            note: 'driver unload confirmation',
          });
        }
      }
      this.refreshEta(truck);
      return;
    }

    const unloaded = truck.load;
    truck.load = 0;
    truck.reportedCapacityPct = 0;
    truck.awaitingUnloadConfirm = false;
    truck.lastStop = -1; // coming back to the same place is a new stop
    truck.disposalTrips++;
    if (s.operational_mode) this.metrics.unloadConfirmations++;
    truck.mode = 'collect';
    truck.status = 'driving';
    truck.serviceProblem = '';
    this.log('info', `${truck.name} unloaded ${Math.round(unloaded)} kg at the disposal site — capacity free`);
    note(this, truck, 'Unloaded at the landfill');
    // A truck that frees up takes pending bins (when not running strict manual-split operational mode).
    const touched = s.operational_mode ? [] : assignPending(this);
    this.planNext(truck);
    this.wakeTrucks(touched.filter((id) => id !== truck.id));
    this.refreshEta(truck);
  }

  /**
   * Handle operational field events (`R05`, `R06`, `R07`):
   *   MANUAL_CAPACITY_REPORT, UNLOAD_CONFIRMED, STOP_CONFIRMED, STOP_SKIPPED,
   *   GPS_DEVIATION, NETWORK_DISCONNECT, NETWORK_RECONNECT
   */
  handleOperationalEvent(ev) {
    const s = this.world.settings;
    this.metrics.eventsApplied++;
    const truck = ev.truckId ? this.trucks.find((t) => t.id === ev.truckId) : null;

    switch (ev.type) {
      case 'MANUAL_CAPACITY_REPORT': {
        if (!truck) return null;
        const pct = Number(ev.percent);
        if (![25, 50, 75, 100].includes(pct)) return null;
        truck.reportedCapacityPct = pct;
        this.metrics.manualCapacityEvents++;
        const offlineNote = this.road.offline ? ' [Offline — queued for sync]' : '';
        if (this.road.offline) this.offlineSyncQueue.push({ time: this.time, ...ev });
        note(this, truck, `Capacity reported: ${pct}%${offlineNote}`);
        this.log('info', `${truck.name} manual capacity reported ${pct}%${offlineNote}`);

        if (pct >= 100 && truck.status !== 'unloading' && truck.status !== 'awaiting_unload_confirm') {
          truck.mode = 'full';
          this.log('handoff', `${truck.name} reported 100% full — routing to Sanitary Landfill (${truck.queue.length} stops held for same truck)`);
          this.planNext(truck);
          this.refreshEta(truck);
        }
        return { type: ev.type, truckId: truck.id, percent: pct, offline: this.road.offline };
      }

      case 'UNLOAD_CONFIRMED': {
        if (!truck) return null;
        const unloaded = truck.load;
        truck.load = 0;
        truck.reportedCapacityPct = 0;
        truck.awaitingUnloadConfirm = false;
        truck.lastStop = -1;
        truck.disposalTrips++;
        this.metrics.unloadConfirmations++;
        truck.mode = 'collect';
        truck.status = 'driving';
        truck.target = null;
        if (this.road.offline) this.offlineSyncQueue.push({ time: this.time, ...ev });
        const offlineNote = this.road.offline ? ' [Offline — queued for sync]' : '';
        this.log('info', `${truck.name} UNLOAD CONFIRMED (reset to 0%, unloaded ${Math.round(unloaded)} kg) — ${truck.queue.length} stops left${offlineNote}`);
        note(this, truck, `Unload confirmed (0%): ${truck.queue.length ? 'resuming stops' : 'returning to SWMO Depot'}`);
        this.planNext(truck);
        this.refreshEta(truck);
        return { type: ev.type, truckId: truck.id, remainingStops: truck.queue.length };
      }

      case 'STOP_CONFIRMED': {
        const bin = ev.binId ? this.binsById.get(ev.binId) : null;
        if (!bin) return null;
        bin.visited = true;
        bin.confirmed = true;
        bin.state = 'collected';
        bin.collectedBy = ev.truckId || bin.collectedBy;
        bin.collectedAt = this.time;
        if (this.road.offline) this.offlineSyncQueue.push({ time: this.time, ...ev });
        this.log('collect', `Driver confirmed collection at ${bin.name}`);
        return { type: ev.type, binId: bin.id };
      }

      case 'STOP_SKIPPED': {
        const bin = ev.binId ? this.binsById.get(ev.binId) : null;
        if (!bin) return null;
        bin.visited = true;
        bin.confirmed = false;
        bin.skipped = true;
        bin.state = 'missed';
        if (this.road.offline) this.offlineSyncQueue.push({ time: this.time, ...ev });
        this.log('warning', `Driver skipped ${bin.name} (visited without collection)`);
        return { type: ev.type, binId: bin.id };
      }

      case 'GPS_DEVIATION': {
        if (!truck || !truck.target || truck.status === 'idle' || truck.status === 'awaiting_unload_confirm') return null;
        const acc = Number.isFinite(ev.gpsAccuracyM) ? ev.gpsAccuracyM : 10;
        const offM = Number.isFinite(ev.offsetM) ? ev.offsetM : 80;
        const readings = Number.isFinite(ev.consecutiveReadings) ? ev.consecutiveReadings : ++truck.consecutiveOffRoute;
        const cooldownOk = (this.time - truck.lastDeviationRerouteAt) >= (s.reroute_cooldown_s ?? 15);
        const minPings = s.deviation_min_pings ?? 2;
        const maxAcc = s.gps_accuracy_max_m ?? 35;
        const threshM = s.deviation_threshold_m ?? 45;

        if (acc > maxAcc || offM < threshM || readings < minPings || !cooldownOk) {
          truck.gpsNoiseSuppressed++;
          this.log('info', `${truck.name} GPS reading suppressed by hysteresis (acc=${acc}m, offset=${offM}m, streak=${readings})`);
          return { type: ev.type, truckId: truck.id, suppressed: true };
        }

        // Valid deviation confirmed: snap to nearest road node (explicit `node` or nearby off-route node) and reroute via A*
        let snapNode = Number.isInteger(ev.node) && ev.node >= 0 && ev.node < this.graph.nodeCount
          ? ev.node
          : pickDeviationNode(this.graph, truck.node, this.world.allowed, offM);
        if (snapNode >= 0) {
          truck.node = snapNode;
          truck.arcs = [];
          truck.arcPos = 0;
        }
        truck.consecutiveOffRoute = 0;
        truck.lastDeviationRerouteAt = this.time;
        const res = routerFor(this, truck).findPath(truck.node, truck.target.node, 'reroute');
        if (res.found) {
          truck.arcs = res.arcs;
          truck.reroutes++;
          truck.deviationReroutes++;
          this.metrics.reroutes++;
          if (this.road.offline) {
            truck.offlineFallbackReroutes++;
            this.log('warning', `${truck.name} GPS deviation rerouted via local free-flow A* (Offline — no live traffic)`);
          } else {
            this.log('event', `${truck.name} GPS deviation (${offM}m off-route) — dynamic A* reroute executed`);
          }
          this.refreshEta(truck);
          return { type: ev.type, truckId: truck.id, suppressed: false, offline: this.road.offline, arcs: res.arcs.length };
        }
        return { type: ev.type, truckId: truck.id, suppressed: false, blocked: true };
      }

      case 'NETWORK_DISCONNECT': {
        this.road.setOffline(true);
        if (ev.duration > 0) {
          this.events.push({ time: this.time + ev.duration, type: 'NETWORK_RECONNECT', source: 'auto', note: 'connectivity restored' });
        }
        this.log('warning', 'Offline — no live traffic; using cached routes and local free-flow A* fallback');
        this.refreshAllEta();
        return { type: ev.type, offline: true };
      }

      case 'NETWORK_RECONNECT': {
        this.road.setOffline(false);
        const synced = this.offlineSyncQueue.length;
        this.metrics.offlineSyncedEvents += synced;
        this.offlineSyncQueue = [];
        this.log('info', `Connectivity restored — synced ${synced} queued offline event(s) and resumed live traffic`);
        for (const t of this.trucks) {
          if (t.status === 'driving' && t.target) this.replan(t, 'reconnect');
        }
        this.refreshAllEta();
        return { type: ev.type, synced };
      }

      default:
        return null;
    }
  }

  // =======================================================================
  //  ETA + end of run
  // =======================================================================

  refreshEta(truck) {
    truck.eta = computeEta(this, truck);
    this.trackTrip(truck);
    this.metrics.etaRecalcs++;
    // Remember the first prediction for this leg to measure ETA accuracy on arrival.
    if (!truck.pendingEtaCheck && truck.status === 'driving' && truck.target && truck.target.kind === 'bin') {
      truck.pendingEtaCheck = { binId: truck.target.binId, predictedAt: truck.eta.nextAt };
    }
  }

  /**
   * Keep the truck's trip (planned vs. expected finish) in step with its ETA. A route truck's
   * plan is fixed when it starts and moves only when its work is edited. Other trucks get new
   * work from the dispatcher all the time, so for them only road events count as delay.
   */
  trackTrip(truck) {
    const end = truck.eta.endAt;
    const idle = truck.status === 'idle';
    const t = truck.trip;
    const going = truck.routeId && truck.phase === 'toArea' ? `: driving to ${this.routes.get(truck.routeId).name}` : '';
    if (!t) {
      if (idle || truck.queue.length === 0) return;
      truck.trip = { startedAt: this.time, plannedEnd: end, lastEnd: end, collected: 0, finishedAt: null, reason: '' };
      note(this, truck, `Route started${going}`);
      return;
    }
    if (idle && t.finishedAt !== null) return;
    if (!Number.isFinite(end)) return; // blocked: not known yet
    if (!Number.isFinite(t.plannedEnd)) t.plannedEnd = t.lastEnd = end; // was blocked when it started
    if (idle) {
      t.finishedAt = this.time;
      note(this, truck, `Route finished${truck.node === this.world.depot ? ': back at the depot' : ''}`);
    } else if (t.finishedAt !== null) {
      t.finishedAt = null;
      note(this, truck, `New bins to collect${going}`);
    }
    if (this.editing || (!truck.routeId && !this.inRoadEvent)) t.plannedEnd += end - t.lastEnd;
    t.lastEnd = end;
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

/** Deterministic off-route node selector near `fromNode` when explicit deviation node is omitted. */
function pickDeviationNode(graph, fromNode, allowed, targetOffsetM = 80) {
  let best = -1;
  let bestDiff = Infinity;
  const fx = graph.x[fromNode];
  const fy = graph.y[fromNode];
  for (let i = 0; i < graph.nodeCount; i++) {
    if (i === fromNode) continue;
    if (allowed && allowed[i] !== 1) continue;
    const d = Math.hypot(graph.x[i] - fx, graph.y[i] - fy);
    if (d < 20 || d > Math.max(250, targetOffsetM * 3)) continue;
    const diff = Math.abs(d - targetOffsetM);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return best >= 0 ? best : fromNode;
}
