/**
 * Cost model — the single definition of "how expensive is it to drive this road".
 *
 * Traffic, topography and closures are all folded into ONE generalized cost here, and
 * both algorithms read that same cost. This is what makes the comparison fair: neither
 * algorithm can see, or invent, a cheaper interpretation of the road network.
 *
 *   cost(u→v) =  timeWeight   * ( length / (speedLimit * traffic) )     [congestion]
 *              + distWeight   * length                                  [distance]
 *              + climbWeight  * max(0, elev[v] - elev[u])              [uphill effort]
 *              + descentWeight* max(0, elev[u] - elev[v])              [braking / wear]
 *
 * A closed road has cost Infinity, so it is simply never traversable.
 *
 * HEURISTIC
 *   h(v, goal) = euclid(v, goal) * ( distWeight + timeWeight / maxSpeed )
 * where maxSpeed is the highest *effective* speed of any road. Every term above is
 * non-negative and monotone in travelled distance, therefore h is a true lower bound
 * (admissible) and consistent — so plain A* stays optimal at weight 1.
 */

export const DEFAULT_WEIGHTS = {
  time: 1.0,
  distance: 0.0,
  climb: 0.5,
  descent: 0.15,
};

export class CostModel {
  /**
   * @param {import('./graph.js').Graph} graph  graph with adjacency already built
   * @param {Partial<typeof DEFAULT_WEIGHTS>} [weights]
   */
  constructor(graph, weights = {}) {
    this.graph = graph;
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };

    const total = graph.arcCount;
    this.cost = new Float64Array(total); // generalized cost per arc
    this.time = new Float64Array(total); // seconds per arc (Infinity if closed)
    this.maxSpeed = 0;
    this.build();
  }

  /** Recompute every arc cost. Must be called after any change to the graph. */
  build() {
    const g = this.graph;
    const { time: wT, distance: wD, climb: wC, descent: wX } = this.weights;
    const total = g.arcCount;
    let maxSpeed = 0;

    for (let a = 0; a < total; a++) {
      const e = g.adjEdge[a];
      if (g.edgeClosed[e] === 1) {
        this.cost[a] = Infinity;
        this.time[a] = Infinity;
        continue;
      }
      const u = g.adjTail[a];
      const v = g.adjNeighbor[a];

      const speed = g.edgeSpeedLimit[e] * g.edgeTraffic[e]; // effective m/s
      const len = g.edgeLength[e];
      const t = len / speed;

      const delta = g.elevation[v] - g.elevation[u];
      const climb = delta > 0 ? delta : 0;
      const descent = delta < 0 ? -delta : 0;

      this.time[a] = t;
      this.cost[a] = wT * t + wD * len + wC * climb + wX * descent;

      if (speed > maxSpeed) maxSpeed = speed;
    }

    this.maxSpeed = maxSpeed;
    // Cheapest possible cost per travelled metre (no climbing, best road, no traffic).
    this.costPerMetreLowerBound =
      maxSpeed > 0 ? wD + wT / maxSpeed : wD;
  }

  /** Generalized cost of traversing arc `a` (Infinity when the road is closed). */
  costOf(a) {
    return this.cost[a];
  }

  /** Travel time in seconds for arc `a`. */
  timeOf(a) {
    return this.time[a];
  }

  /** Admissible, consistent lower bound on the remaining cost from `a` to `b`. */
  heuristic(a, b) {
    const g = this.graph;
    const dx = g.x[a] - g.x[b];
    const dy = g.y[a] - g.y[b];
    return Math.sqrt(dx * dx + dy * dy) * this.costPerMetreLowerBound;
  }

  /** Straight-line distance in metres. */
  euclidean(a, b) {
    const g = this.graph;
    const dx = g.x[a] - g.x[b];
    const dy = g.y[a] - g.y[b];
    return Math.sqrt(dx * dx + dy * dy);
  }
}
