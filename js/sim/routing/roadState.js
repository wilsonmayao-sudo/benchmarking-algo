/**
 * Live road state — the dynamic overlay on top of a static Graph.
 *
 * The Graph itself is never mutated (the rest of the project treats it as read-only).
 * Closures and traffic delays live here instead:
 *
 *   closed[e]      1 = road e is blocked in both directions
 *   multiplier[e]  ≥ 0 factor applied to road e's weight (1 = normal, 2 = twice as slow)
 *
 * The A* weight of a directed arc is
 *
 *   weight(arc) = closed ? Infinity : length × multiplier
 *
 * i.e. "effective metres". ETA = weight / truck speed, so a delay factor of 2 doubles
 * the time a truck needs for that road.
 *
 * `version` is bumped on every change, which lets the router invalidate cached legs.
 */

export class RoadState {
  /** @param {import('../../core/graph.js').Graph} graph */
  constructor(graph) {
    this.graph = graph;
    this.closed = new Uint8Array(graph.edgeCount);
    this.multiplier = new Float64Array(graph.edgeCount).fill(1);
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

  /** A* weight of directed arc `arc` — see header. */
  arcWeight(arc) {
    const e = this.graph.adjEdge[arc];
    return this.closed[e] === 1 ? Infinity : this.graph.edgeLength[e] * this.multiplier[e];
  }

  /**
   * Smallest multiplier on the network, capped at 1. Scaling the straight-line heuristic
   * by this keeps it admissible even if a config sets a "speed-up" factor below 1.
   */
  heuristicScale() {
    let min = 1;
    for (let e = 0; e < this.multiplier.length; e++) {
      if (this.multiplier[e] < min) min = this.multiplier[e];
    }
    return min;
  }
}
