/**
 * Trip details in plain words: status, next stop, progress, delay, times and events for
 * one truck (or a whole route). Reads the simulation, never changes it.
 *
 *   Delay = actual (or currently expected) finish − planned finish
 */

/** The simulated day starts at 8:00 AM. */
export const START_CLOCK_S = 8 * 3600;

/** 12-hour clock time, e.g. 9:46 AM. */
export function fmtTime(simSeconds) {
  if (!Number.isFinite(simSeconds)) return 'not known yet';
  const min = Math.floor((START_CLOCK_S + simSeconds) / 60);
  const h = Math.floor(min / 60) % 24;
  return `${h % 12 || 12}:${String(min % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "4 min", "1 hr 5 min", "less than 1 min". */
export function fmtMin(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 1) return 'less than 1 min';
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** Seconds late (0 = on time, or not known yet). */
export function lateness(truck) {
  const late = truck.trip ? truck.trip.lastEnd - truck.trip.plannedEnd : 0;
  return late > 0 ? late : 0;
}

const LATE_S = 60; // under a minute counts as on time

/** The four parts of a route truck's trip, in order (see routes.js). */
export const TRIP_STEPS = ['Go to area', 'Collect bins', 'Landfill', 'Back to depot'];
const STEP_OF = { toArea: 0, area: 1, toLandfill: 2, toDepot: 3, done: TRIP_STEPS.length };

export function truckDetails(sim, truck) {
  const t = truck.trip;
  const now = sim.time;
  const idle = truck.status === 'idle' || sim.finished;
  const late = lateness(truck);
  const held = truck.holdUntil > now && truck.status === 'driving';
  const problem = (truck.status === 'servicing' || truck.status === 'unloading') && truck.serviceProblem;

  let status = 'On the way';
  if (idle) status = 'Finished';
  else if (truck.status === 'blocked' || held || problem) status = 'Delayed';
  else if (truck.status === 'servicing') status = 'Collecting';
  else if (late >= LATE_S) status = 'Delayed';

  let next = !t ? 'No stops to make' : truck.node === sim.world.depot ? 'No more stops — parked at the depot' : 'No more stops';
  if (!idle && truck.eta) {
    const name = targetName(sim, truck);
    const at = truck.eta.nextAt;
    const clock = `(${fmtTime(at)})`;
    if (truck.status === 'blocked') next = `${name} — waiting, cannot get there yet`;
    else if (truck.status === 'servicing') next = `${name} — collecting now, done in ${fmtMin(at - now)} ${clock}`;
    else if (truck.status === 'unloading') next = `${name} — unloading, done in ${fmtMin(at - now)} ${clock}`;
    else next = `${name} — arriving in ${fmtMin(at - now)} ${clock}`;
  }

  const done = t ? t.collected : 0;
  return {
    status,
    next,
    nextAt: idle || !truck.eta ? Infinity : truck.eta.nextAt,
    done,
    total: done + truck.queue.length,
    step: truck.routeId && t ? STEP_OF[truck.phase] ?? 0 : null, // index in TRIP_STEPS; past the end = all done
    late,
    delay: truck.status === 'blocked' ? `Stopped — ${t?.reason || 'road closed'}`
      : late >= LATE_S ? `Running ${fmtMin(late)} late${t.reason ? ` — ${t.reason}` : ''}` : '',
    startedAt: t ? t.startedAt : null,
    endAt: t ? (t.finishedAt ?? (truck.status === 'blocked' ? Infinity : t.lastEnd)) : null,
    finished: status === 'Finished',
    events: truck.timeline.slice().reverse(),
  };
}

function targetName(sim, truck) {
  const target = truck.target;
  if (!target) return 'Next stop';
  if (target.kind === 'bin') return sim.binsById.get(target.binId)?.name || 'Next stop';
  if (target.kind === 'entry') return sim.routes.get(truck.routeId)?.name || 'Route area';
  if (target.kind === 'stop') return 'End of route';
  return target.kind === 'disposal' ? 'Landfill' : 'Depot';
}

export function routeDetails(sim, route) {
  const trucks = route.truckIds.map((id) => sim.trucks.find((t) => t.id === id)).filter(Boolean);
  const all = trucks.map((t) => ({ t, d: truckDetails(sim, t) }));
  const bins = sim.bins.filter((b) => b.routeId === route.id);
  const active = all.filter((x) => !x.d.finished);
  const has = (s) => active.some((x) => x.d.status === s);
  const soonest = active.slice().sort((a, b) => a.d.nextAt - b.d.nextAt)[0];
  const worst = all.slice().sort((a, b) => b.d.late - a.d.late)[0];
  const stuck = all.find((x) => x.t.status === 'blocked');
  const starts = all.map((x) => x.d.startedAt).filter((x) => x !== null);
  const ends = all.map((x) => x.d.endAt).filter((x) => x !== null);
  const steps = all.map((x) => x.d.step).filter((x) => x !== null);
  return {
    step: steps.length ? Math.min(...steps) : null, // the truck that has the most left to do
    status: active.length === 0 ? 'Finished' : has('Delayed') ? 'Delayed' : has('Collecting') ? 'Collecting' : 'On the way',
    next: soonest ? soonest.d.next : all.length ? all[0].d.next : 'No truck assigned',
    done: bins.filter((b) => b.state === 'collected').length,
    total: bins.length,
    delay: (stuck || worst)?.d.delay || '',
    startedAt: starts.length ? Math.min(...starts) : null,
    endAt: ends.length ? Math.max(...ends) : null,
    finished: active.length === 0,
    events: all.flatMap(({ t }) => t.timeline.map((e) => ({ ...e, text: trucks.length > 1 ? `${t.name}: ${e.text}` : e.text })))
      .sort((a, b) => b.time - a.time || b.seq - a.seq),
  };
}
