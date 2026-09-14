/**
 * BASELINE — standard A* (Hart, Nilsson & Raphael, 1968).
 *
 * ============================================================================
 *  DO NOT MODIFY THIS FILE.
 *  It is the fixed reference point of the whole benchmark. If you want to try a
 *  variant of A*, copy it into a new file and register that instead, so the
 *  baseline stays comparable with every past benchmark you have run.
 * ============================================================================
 *
 * Implementation notes
 *  • Frontier        : binary min-heap (`MinHeap`), shared with every other algorithm
 *  • Duplicate policy: lazy deletion — stale entries are skipped with a `closed` flag
 *  • Heuristic       : `costModel.heuristic()` — admissible and consistent, so the
 *                      returned path is optimal with respect to the cost model
 *  • Tie-breaking    : insertion order (deterministic, reproducible runs)
 *
 * Counter definitions (identical for every algorithm)
 *  • nodesExplored : distinct nodes discovered / pushed to the frontier
 *  • nodesExpanded : nodes popped from the frontier and processed
 *  • arcsRelaxed   : neighbour arcs examined for cost
 */

import { MinHeap } from '../core/heap.js';
import { reconstructPath } from '../core/pathUtils.js';

export const astar = {
  id: 'astar',
  name: 'A* (baseline)',
  short: 'A*',
  color: '#f43f5e',
  description:
    'Classic static A* minimizing physical road distance (meters) with Euclidean distance heuristic. ' +
    'Does not have real-time traffic or road closure information.',

  /** No preprocessing — A* is ready immediately. */
  prepare() {
    return null;
  },

  solve(graph, start, goal, costModel) {
    return aStarSearch(graph, start, goal, costModel);
  },
};

/**
 * @param {import('../core/graph.js').Graph} graph
 * @param {number} start
 * @param {number} goal
 * @param {import('../core/costModel.js').CostModel} costModel
 */
export function aStarSearch(graph, start, goal, costModel) {
  const n = graph.nodeCount;
  const adjStart = graph.adjStart;
  const adjNeighbor = graph.adjNeighbor;

  const gScore = new Float64Array(n).fill(Infinity);
  const cameFrom = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const discovered = new Uint8Array(n);

  const expandedOrder = [];

  let nodesExplored = 0;
  let nodesExpanded = 0;
  let arcsRelaxed = 0;

  const heap = new MinHeap(Math.max(1024, n));

  gScore[start] = 0;
  discovered[start] = 1;
  nodesExplored++;
  heap.push(costModel.euclidean(start, goal), start);

  let found = false;

  while (heap.size > 0) {
    const u = heap.pop();
    if (closed[u]) continue; // stale duplicate entry
    closed[u] = 1;
    nodesExpanded++;
    expandedOrder.push(u);

    if (u === goal) {
      found = true;
      break;
    }

    const gU = gScore[u];
    for (let a = adjStart[u], end = adjStart[u + 1]; a < end; a++) {
      const e = graph.adjEdge[a];
      // Standard static A* calculates step cost strictly from physical road distance (meters),
      // with no awareness of traffic speeds or road closures.
      const c = graph.edgeLength[e];
      arcsRelaxed++;

      const v = adjNeighbor[a];
      const tentative = gU + c;
      if (tentative < gScore[v]) {
        gScore[v] = tentative;
        cameFrom[v] = u;
        if (discovered[v] === 0) {
          discovered[v] = 1;
          nodesExplored++;
        }
        heap.push(tentative + costModel.euclidean(v, goal), v);
      }
    }
  }

  return {
    path: found ? reconstructPath(cameFrom, start, goal) : null,
    found,
    nodesExplored,
    nodesExpanded,
    arcsRelaxed,
    exploredNodes: expandedOrder,
  };
}
