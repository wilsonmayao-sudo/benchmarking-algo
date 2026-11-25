/**
 * Live road state — the dynamic overlay on top of a static Graph.
 *
 * The Graph itself is never mutated (the rest of the project treats it as read-only).
 * Closures and traffic delays live here instead:
 *
 *   closed[e]      1 = road e is blocked in both directions
 *   multiplier[e]  ≥ 0 factor applied to road e's weight (1 = normal, 2 = twice as slow)
 *   liveSpeedMs[e] optional Mapbox/live speed (m/s) overriding free-flow speed
 *
 * Supported cost modes:
 *   'distance' (legacy default):
 *     weight(arc) = closed ? Infinity : length * (offline ? 1 : multiplier)
 *   'time' (unified travel-time + elevation + closure cost model):
 *     weight(arc) = closed ? Infinity
 *                 : length / effectiveSpeed(e) + climbWeight * max(0, dz) + descentWeight * max(0, -dz)
 *
 * `version` is bumped on every change, which lets the router invalidate cached legs and paths.
 */

export class RoadState {
  /**
   * @param {import('../../core/graph.js').Graph} graph
   * @param {{costMode?:'distance'|'time', climbWeight?:number, descentWeight?:number}} [options]
   */
  constructor(graph, options = {}) {
    this.graph = graph;
    this.costMode = options.costMode === 'time' ? 'time' : 'distance';
    this.climbWeight = Number.isFinite(options.climbWeight) ? Math.max(0, options.climbWeight) : 0.5;
    this.descentWeight = Number.isFinite(options.descentWeight) ? Math.max(0, options.descentWeight) : 0.15;

    this.closed = new Uint8Array(graph.edgeCount);
    this.multiplier = new Float64Array(graph.edgeCount).fill(1);
    this.liveSpeedMs = new Float64Array(graph.edgeCount).fill(NaN);
    this.offline = false;
    this.trafficStatus = 'normal'; // 'normal' | 'congested' | 'missing' | 'stale' | 'offline'
    this.trafficUpdatedAt = 0;

    let maxV = 0;
    for (let e = 0; e < graph.edgeCount; e++) {
      const s = graph.edgeSpeedLimit[e];
      if (s > maxV) maxV = s;
    }
    this.maxFreeFlowSpeed = maxV > 0 ? maxV : 16.7;
    this.version = 0;
  }

  isClosed(edge) {
    return this.closed[edge] === 1;
  }

  close(edge) {
    if (this.closed[edge] === 1) return false;
    this.closed[edge] = 1;
    this.version++;
    return true;
  }

  reopen(edge) {
    if (this.closed[edge] === 0) return false;
    this.closed[edge] = 0;
    this.version++;
    return true;
  }

  /** Multiply road `edge`'s weight by `factor` (stacking). Returns the new multiplier. */
  applyDelay(edge, factor) {
    this.multiplier[edge] *= factor;
    // Undoing a delay by 1/factor can leave 0.9999999; snap back to exactly 1.
    if (Math.abs(this.multiplier[edge] - 1) < 1e-9) this.multiplier[edge] = 1;
    this.version++;
    return this.multiplier[edge];
  }

  /** Set a live speed observation (m/s) for an edge (NaN clears it). */
  setLiveSpeed(edge, speedMs) {
    const next = Number.isFinite(speedMs) && speedMs > 0 ? speedMs : NaN;
    if (Object.is(this.liveSpeedMs[edge], next) || (Number.isNaN(next) && Number.isNaN(this.liveSpeedMs[edge]))) {
      return false;
    }
    this.liveSpeedMs[edge] = next;
    this.version++;
    return true;
  }

  clearLiveSpeeds() {
    let changed = false;
    for (let e = 0; e < this.liveSpeedMs.length; e++) {
      if (!Number.isNaN(this.liveSpeedMs[e])) {
        this.liveSpeedMs[e] = NaN;
        changed = true;
      }
    }
    if (changed) this.version++;
    return changed;
  }

  setOffline(flag) {
    const next = Boolean(flag);
    if (this.offline === next) return false;
    this.offline = next;
    this.trafficStatus = next ? 'offline' : 'normal';
    this.version++;
    return true;
  }

  setTrafficStatus(status, updatedAt = this.trafficUpdatedAt) {
    if (this.trafficStatus === status && this.trafficUpdatedAt === updatedAt) return false;
    this.trafficStatus = status;
    this.trafficUpdatedAt = updatedAt;
    this.version++;
    return true;
  }

  /** Effective speed (m/s) along edge `e` under live traffic / offline state. */
  effectiveSpeed(edge) {
    const free = this.graph.edgeSpeedLimit[edge] > 0 ? this.graph.edgeSpeedLimit[edge] : 11.1;
    if (this.offline) return free;
    const obs = this.liveSpeedMs[edge];
    const base = Number.isFinite(obs) && obs > 0 ? obs : free;
    const mult = this.multiplier[edge] > 0 ? this.multiplier[edge] : 1;
    return base / mult;
  }

  /** Free-flow (baseline open-road) weight used for admissible ALT preprocessing. */
  freeFlowArcWeight(arc) {
    const g = this.graph;
    const e = g.adjEdge[arc];
    const len = g.edgeLength[e];
    if (this.costMode !== 'time') return len;
    const free = g.edgeSpeedLimit[e] > 0 ? g.edgeSpeedLimit[e] : 11.1;
    let cost = len / free;
    if (g.elevation) {
      const dz = g.elevation[g.adjNeighbor[arc]] - g.elevation[g.adjTail[arc]];
      if (dz > 0) cost += this.climbWeight * dz;
      else if (dz < 0) cost += this.descentWeight * (-dz);
    }
    return cost;
  }

  /** Generalized routing cost of directed arc `arc` (Infinity if closed). */
  arcWeight(arc) {
    const g = this.graph;
    const e = g.adjEdge[arc];
    if (this.closed[e] === 1) return Infinity;
    const len = g.edgeLength[e];
    if (this.costMode !== 'time') {
      return len * (this.offline ? 1 : this.multiplier[e]);
    }
    const v = this.effectiveSpeed(e);
    let cost = v > 0 ? len / v : Infinity;
    if (g.elevation && cost < Infinity) {
      const dz = g.elevation[g.adjNeighbor[arc]] - g.elevation[g.adjTail[arc]];
      if (dz > 0) cost += this.climbWeight * dz;
      else if (dz < 0) cost += this.descentWeight * (-dz);
    }
    return cost;
  }

  /** Physical driving travel time in seconds along directed arc `arc` (Infinity if closed). */
  arcTime(arc, truckSpeed = 11.1) {
    const g = this.graph;
    const e = g.adjEdge[arc];
    if (this.closed[e] === 1) return Infinity;
    const len = g.edgeLength[e];
    if (this.costMode === 'time') {
      const v = this.effectiveSpeed(e);
      return v > 0 ? len / v : Infinity;
    }
    const mult = this.offline ? 1 : this.multiplier[e];
    return (len * mult) / truckSpeed;
  }

  /**
   * Admissible straight-line multiplier for Euclidean/Manhattan heuristics.
   * - In 'distance' mode: min(1, min_e multiplier[e])
   * - In 'time' mode: 1 / maxEffectiveSpeed across open edges (since climb/descent >= 0)
   */
  heuristicScale() {
    if (this.costMode !== 'time') {
      if (this.offline) return 1;
      let min = 1;
      for (let e = 0; e < this.multiplier.length; e++) {
        if (this.multiplier[e] < min) min = this.multiplier[e];
      }
      return min;
    }
    let maxSpeed = this.maxFreeFlowSpeed;
    for (let e = 0; e < this.graph.edgeCount; e++) {
      if (this.closed[e] === 1) continue;
      const v = this.effectiveSpeed(e);
      if (Number.isFinite(v) && v > maxSpeed) maxSpeed = v;
    }
    return maxSpeed > 0 ? 1 / maxSpeed : 0;
  }

  /**
   * Smallest ratio freeFlowCost(a) / liveCost(a) -> lower bound scaling for static ALT landmarks.
   * Equals 1.0 whenever live traffic only slows roads down (or is offline), keeping ALT 100% admissible.
   */
  minSpeedRatio() {
    if (this.offline) return 1;
    let minRatio = 1;
    if (this.costMode !== 'time') {
      for (let e = 0; e < this.multiplier.length; e++) {
        if (this.multiplier[e] < minRatio) minRatio = this.multiplier[e];
      }
      return minRatio;
    }
    for (let e = 0; e < this.graph.edgeCount; e++) {
      if (this.closed[e] === 1) continue;
      const free = this.graph.edgeSpeedLimit[e] > 0 ? this.graph.edgeSpeedLimit[e] : 11.1;
      const eff = this.effectiveSpeed(e);
      if (eff > free) {
        const r = free / eff;
        if (r < minRatio) minRatio = r;
      }
    }
    return minRatio;
  }
}
