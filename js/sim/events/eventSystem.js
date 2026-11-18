/**
 * Event system — dynamic road events during the simulation.
 *
 * EVENT TYPES
 *   ROAD_CLOSURE   edge becomes impassable. With `duration` a matching ROAD_REOPEN is
 *                  scheduled automatically at time + duration.
 *   ROAD_REOPEN    edge becomes passable again.
 *   TRAFFIC_DELAY  edge weight is multiplied by `factor`. With `duration` an "end of
 *                  delay" event (factor 1/factor) is scheduled, restoring the old weight.
 *
 * Events come from the scenario config — a fixed schedule and/or seeded random
 * generation (see scenarioLoader.js). Both end up in one time-ordered queue here, so
 * the simulation does not care where an event came from.
 *
 * This module only changes the ROAD STATE. Deciding which trucks must reroute is the
 * simulation's job (it knows where every truck is) — that keeps the two concerns apart.
 */

export class EventQueue {
  /** @param {Array<object>} events from the loader: {time,type,edge,factor?,duration?,source,note} */
  constructor(events = []) {
    this._queue = [];
    this._seq = 0;
    for (const ev of events) this.push(ev);
  }

  /** Insert keeping the queue sorted by time, then by insertion order (stable). */
  push(ev) {
    const item = { ...ev, seq: this._seq++ };
    let i = this._queue.length;
    while (i > 0 && (this._queue[i - 1].time > item.time ||
      (this._queue[i - 1].time === item.time && this._queue[i - 1].seq > item.seq))) i--;
    this._queue.splice(i, 0, item);
  }

  /** Remove and return every event whose time ≤ `time`. */
  popDue(time) {
    let k = 0;
    while (k < this._queue.length && this._queue[k].time <= time) k++;
    return this._queue.splice(0, k);
  }

  get size() { return this._queue.length; }

  /** Upcoming events (read-only copy) — shown in the UI timeline. */
  upcoming() { return this._queue.slice(); }

  /** Drop queued events matching `pred`. Returns how many were removed. */
  removeWhere(pred) {
    const before = this._queue.length;
    this._queue = this._queue.filter((ev) => !pred(ev));
    return before - this._queue.length;
  }
}

/**
 * Apply one event to the road state and schedule any follow-up event.
 *
 * @param {object} ev
 * @param {import('../routing/roadState.js').RoadState} road
 * @param {EventQueue} queue
 * @returns {{changed:boolean, description:string}}
 */
export function applyRoadEvent(ev, road, queue) {
  switch (ev.type) {
    case 'ROAD_CLOSURE': {
      const changed = road.close(ev.edge);
      if (changed && ev.duration > 0) {
        queue.push({ time: ev.time + ev.duration, type: 'ROAD_REOPEN', edge: ev.edge, source: 'auto', note: 'closure expired' });
      }
      return {
        changed,
        description: changed
          ? `road closed${ev.duration > 0 ? ` for ${Math.round(ev.duration / 60)} min` : ''}`
          : 'road was already closed',
      };
    }

    case 'ROAD_REOPEN': {
      const changed = road.reopen(ev.edge);
      return { changed, description: changed ? 'road reopened' : 'road was already open' };
    }

    case 'TRAFFIC_DELAY': {
      const m = road.applyDelay(ev.edge, ev.factor);
      if (ev.duration > 0 && !ev.isEnd) {
        queue.push({
          time: ev.time + ev.duration,
          type: 'TRAFFIC_DELAY',
          edge: ev.edge,
          factor: 1 / ev.factor,
          isEnd: true,
          source: 'auto',
          note: '', // the description already says "delay cleared"
        });
      }
      return {
        changed: true,
        description: ev.isEnd
          ? `delay cleared (weight ×${m.toFixed(2)})`
          : `traffic delay ×${ev.factor} (weight now ×${m.toFixed(2)})`,
      };
    }

    default:
      return { changed: false, description: `ignored unknown event type ${ev.type}` };
  }
}
