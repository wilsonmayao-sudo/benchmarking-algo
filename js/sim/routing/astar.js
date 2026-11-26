/**
 * Reusable A* search for the fleet simulator.
 *
 * WHY A SECOND A*?
 *   `js/algorithms/astar.js` is the frozen benchmark baseline and deliberately ignores
 *   closures (it costs every road by its physical length). A truck simulator must respect
 *   live road state, so this module is a separate, general-purpose A* that takes the edge
 *   weight and the heuristic as *functions*. Nothing in here knows about trucks, bins or
 *   events — it can be reused by any caller that has a `Graph`.
 *
 * CONTRACT
 *   astarSearch(graph, start, goal, { weight, heuristic })
 *     weight(arc)          → non-negative cost of traversing directed arc `arc`
 *                            (Infinity = impassable, e.g. a closed road)
 *     heuristic(node, goal)→ lower bound on the remaining cost (must be admissible,
 *                            i.e. never larger than the true cheapest remaining cost)
 *
 *   Returns { found, path, arcs, cost, nodesExpanded, nodesExplored, ms }
 *     path  : node ids start … goal   (null when no route exists)
 *     arcs  : directed arc ids along the path (path.length - 1 entries)
 *     cost  : sum of weight(arc) along the path
 *     ms    : wall-clock time spent in the search (performance.now)
 *
 * With an admissible + consistent heuristic the first time the goal is popped its cost is
 * optimal, so a closed set (lazy deletion) is safe.
 */

import { MinHeap } from '../../core/heap.js';

/** Monotonic clock that exists both in browsers and in Node ≥ 16. */
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * @param {import('../../core/graph.js').Graph} graph  graph with adjacency built
 * @param {number} start
 * @param {number} goal
 * @param {{weight:(arc:number)=>number, heuristic:(node:number, goal:number)=>number}} fns
 */
export function astarSearch(graph, start, goal, { weight, heuristic }) {
  const t0 = now();
  const n = graph.nodeCount;

  // Trivial case — already there. Still counts as one (cheap) search.
  if (start === goal) {
    return { found: true, path: [start], arcs: [], cost: 0, nodesExpanded: 0, nodesExplored: 1, ms: now() - t0 };
  }

  const gScore = new Float64Array(n).fill(Infinity);
  const viaArc = new Int32Array(n).fill(-1); // arc used to reach each node (for path rebuild)
  const closed = new Uint8Array(n);
  const heap = new MinHeap(64);

  let nodesExpanded = 0;
  let nodesExplored = 1;

  gScore[start] = 0;
  heap.push(heuristic(start, goal), start);

  let found = false;
  while (heap.size > 0) {
    const u = heap.pop();
    if (closed[u]) continue; // stale duplicate (lazy deletion)
    closed[u] = 1;
    nodesExpanded++;

    if (u === goal) { found = true; break; }

    const gU = gScore[u];
    for (let a = graph.adjStart[u], end = graph.adjStart[u + 1]; a < end; a++) {
      const w = weight(a);
      if (w === Infinity) continue; // closed road: never traversable
      const v = graph.adjNeighbor[a];
      if (closed[v]) continue;
      const tentative = gU + w;
      if (tentative < gScore[v]) {
        if (gScore[v] === Infinity) nodesExplored++;
        gScore[v] = tentative;
        viaArc[v] = a;
        heap.push(tentative + heuristic(v, goal), v);
      }
    }
  }

  let path = null;
  let arcs = null;
  if (found) {
    // Walk the arcs backwards from the goal.
    arcs = [];
    let cur = goal;
    while (cur !== start) {
      const a = viaArc[cur];
      arcs.push(a);
      cur = graph.adjTail[a];
    }
    arcs.reverse();
    path = [start, ...arcs.map((a) => graph.adjNeighbor[a])];
  }

  return {
    found,
    path,
    arcs,
    cost: found ? gScore[goal] : Infinity,
    nodesExpanded,
    nodesExplored,
    ms: now() - t0,
  };
}

// ===========================================================================
//  Heuristics
// ===========================================================================

/**
 * Straight-line (Euclidean) distance × `scale`.
 * Admissible whenever every arc weight ≥ scale × its length — which holds when
 * weight = length × multiplier and scale = the smallest multiplier on the network.
 */
export function euclideanHeuristic(graph, scale = 1) {
  return (a, b) => {
    const dx = graph.x[a] - graph.x[b];
    const dy = graph.y[a] - graph.y[b];
    return Math.sqrt(dx * dx + dy * dy) * scale;
  };
}

/**
 * Manhattan (|dx| + |dy|) distance × `scale`.
 * ⚠ Only admissible when roads are axis-aligned (a perfect grid). On diagonal roads it
 * can overestimate, and A* then loses its optimality guarantee. Euclidean is the default.
 */
export function manhattanHeuristic(graph, scale = 1) {
  return (a, b) => (Math.abs(graph.x[a] - graph.x[b]) + Math.abs(graph.y[a] - graph.y[b])) * scale;
}

/** Factory used by the router: name from the scenario config → heuristic function. */
export function makeHeuristic(name, graph, scale) {
  if (name === 'manhattan') return manhattanHeuristic(graph, scale);
  return euclideanHeuristic(graph, scale);
}
