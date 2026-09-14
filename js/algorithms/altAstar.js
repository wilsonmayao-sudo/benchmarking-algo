/**
 * A* with landmark preprocessing — the ALT technique (A*, Landmarks, Triangle inequality).
 *
 * ============================================================================
 *  WHY THIS FILE EXISTS
 *  It is here to answer one question: does preprocessing pay off when a truck makes
 *  MANY stops instead of one trip?
 *
 *  `prepare()` runs ONCE per test case and is not part of the measured search time. On a
 *  single trip that is a small kindness. On a collection round with 12 stops it is the
 *  whole story: one preprocessing pass, then 13 searches that are dramatically cheaper.
 *
 *  This is the mechanism a custom algorithm can adopt. If your `prepare()` is empty there
 *  is nothing to amortise, so adding stops costs both algorithms the same amount and
 *  changes nothing. Put work in `prepare()` and a round starts to look very different.
 * ============================================================================
 *
 * HOW THE LANDMARKS WORK
 *   For a landmark L, the triangle inequality gives two exact bounds on the remaining cost
 *   from v to the goal g:
 *
 *       d(L, g) − d(L, v)  ≤  cost(v → g)      (forward distances from L)
 *       d(v, L) − d(g, L)  ≤  cost(v → g)      (backward distances to L)
 *
 *   Both are true lower bounds, so taking the maximum with the plain straight-line bound
 *   gives a much tighter admissible heuristic — the search stays OPTIMAL but expands far
 *   fewer nodes. The distances d(L, ·) are computed with one Dijkstra per landmark, in each
 *   direction, inside `prepare()`.
 *
 * Cost is still read from the shared cost model, so this optimises exactly the same
 * objective as the baseline. Nothing about traffic, elevation or closures changes.
 */

import { MinHeap } from '../core/heap.js';
import { reconstructPath } from '../core/pathUtils.js';

const DEFAULT_LANDMARKS = 4;
const MIN_NODES_FOR_LANDMARKS = 40;

export const altAstar = {
  id: 'alt',
  name: 'A* + landmarks (ALT)',
  short: 'ALT',
  color: '#a78bfa',
  description:
    'A* with landmark preprocessing. prepare() runs one Dijkstra per landmark in each ' +
    'direction, then the search uses those exact distances to tighten the admissible ' +
    'bound. Still optimal, far fewer expanded nodes — and the preprocessing is paid once ' +
    'for a whole collection round.',

  tunables: [
    {
      id: 'landmarks',
      label: 'Landmarks',
      type: 'range',
      min: 1,
      max: 8,
      step: 1,
      value: DEFAULT_LANDMARKS,
      digits: 0,
      hint:
        'More landmarks = tighter heuristic = fewer nodes expanded, but more preprocessing. ' +
        'On a single trip you pay for that preprocessing; across a collection round with ' +
        'many legs it is amortised. This slider is the trade-off, made visible.',
    },
  ],

  // ------------------------------------------------------------------ prepare
  prepare(graph, costModel, options = {}) {
    const requested = Number.isFinite(options.landmarks) ? options.landmarks : DEFAULT_LANDMARKS;
    const k = Math.max(1, Math.round(requested));

    if (graph.nodeCount < MIN_NODES_FOR_LANDMARKS || graph.edgeCount === 0) {
      return { count: 0, landmarks: new Int32Array(0), fwd: [], bwd: [] };
    }

    const landmarks = selectLandmarks(graph, Math.min(k, graph.nodeCount));
    const fwd = [];
    const bwd = [];
    for (const landmark of landmarks) {
      fwd.push(dijkstraForward(graph, costModel, landmark));
      bwd.push(dijkstraBackward(graph, costModel, landmark));
    }
    return { count: landmarks.length, landmarks, fwd, bwd };
  },

  // -------------------------------------------------------------------- solve
  solve(graph, start, goal, costModel, context) {
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

    // Landmark tables are constant for the whole test case, so the destination's values can
    // be hoisted out of the search loop.
    const L = context ? context.count : 0;
    const fwd = L > 0 ? context.fwd : null;
    const bwd = L > 0 ? context.bwd : null;
    const goalFwd = L > 0 ? new Float64Array(L) : null;
    const goalBwd = L > 0 ? new Float64Array(L) : null;
    for (let k = 0; k < L; k++) {
      goalFwd[k] = fwd[k][goal];
      goalBwd[k] = bwd[k][goal];
    }

    const heap = new MinHeap(Math.max(1024, n));
    gScore[start] = 0;
    discovered[start] = 1;
    nodesExplored = 1;
    heap.push(estimate(start), start);

    let found = false;

    while (heap.size > 0) {
      const u = heap.pop();
      if (closed[u]) continue;
      closed[u] = 1;
      nodesExpanded++;
      expandedOrder.push(u);

      if (u === goal) {
        found = true;
        break;
      }

      const gU = gScore[u];
      for (let a = adjStart[u], end = adjStart[u + 1]; a < end; a++) {
        const c = costModel.costOf(a);
        if (c === Infinity) continue;
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
          heap.push(tentative + estimate(v), v);
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

    /**
     * Tightest admissible lower bound on cost(v → goal): the maximum of the straight-line
     * bound and every landmark triangle bound. Infinite landmark entries mean the landmark
     * cannot reach that node, so the bound is skipped rather than becoming NaN.
     */
    function estimate(v) {
      let best = costModel.heuristic(v, goal);
      for (let k = 0; k < L; k++) {
        const f = goalFwd[k] - fwd[k][v];
        if (Number.isFinite(f) && f > best) best = f;
        const b = bwd[k][v] - goalBwd[k];
        if (Number.isFinite(b) && b > best) best = b;
      }
      return best;
    }
  },
};

// ---------------------------------------------------------------- utilities

/** Farthest-point sampling — landmarks spread out over the map, deterministically. */
function selectLandmarks(graph, k) {
  const n = graph.nodeCount;
  const count = Math.min(k, n);
  const chosen = new Int32Array(count);
  const bestDist = new Float64Array(n).fill(Infinity);
  const inSet = new Uint8Array(n);

  let current = 0;
  for (let i = 0; i < count; i++) {
    chosen[i] = current;
    inSet[current] = 1;

    let farthest = -1;
    let farthestDist = -1;
    for (let v = 0; v < n; v++) {
      if (inSet[v]) continue;
      const dx = graph.x[v] - graph.x[current];
      const dy = graph.y[v] - graph.y[current];
      const d = dx * dx + dy * dy;
      if (d < bestDist[v]) bestDist[v] = d;
      if (bestDist[v] > farthestDist) {
        farthestDist = bestDist[v];
        farthest = v;
      }
    }
    if (farthest < 0) break;
    current = farthest;
  }
  return chosen;
}

/** Cheapest cost from `source` to every node. */
function dijkstraForward(graph, costModel, source) {
  const n = graph.nodeCount;
  const dist = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const heap = new MinHeap(Math.max(1024, n));

  dist[source] = 0;
  heap.push(0, source);

  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    const du = dist[u];
    for (let a = graph.adjStart[u], end = graph.adjStart[u + 1]; a < end; a++) {
      const c = costModel.costOf(a);
      if (c === Infinity) continue;
      const v = graph.adjNeighbor[a];
      const nd = du + c;
      if (nd < dist[v]) {
        dist[v] = nd;
        heap.push(nd, v);
      }
    }
  }
  return dist;
}

/** Cheapest cost from every node *to* `target`, walking the reversed arcs. */
function dijkstraBackward(graph, costModel, target) {
  const n = graph.nodeCount;
  const dist = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const heap = new MinHeap(Math.max(1024, n));

  dist[target] = 0;
  heap.push(0, target);

  while (heap.size > 0) {
    const v = heap.pop();
    if (done[v]) continue;
    done[v] = 1;
    const dv = dist[v];
    for (let i = graph.revStart[v], end = graph.revStart[v + 1]; i < end; i++) {
      const a = graph.revArc[i]; // arc u → v
      const c = costModel.costOf(a);
      if (c === Infinity) continue;
      const u = graph.adjTail[a];
      const nd = dv + c;
      if (nd < dist[u]) {
        dist[u] = nd;
        heap.push(nd, u);
      }
    }
  }
  return dist;
}
