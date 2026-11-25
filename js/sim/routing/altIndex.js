/**
 * Dynamic-Safe ALT Landmark Index (`R02`).
 *
 * Precomputes forward and backward shortest-path potentials from K landmarks
 * using free-flow baseline weights (`road.freeFlowArcWeight`).
 *
 * ADMISSIBILITY PROOF UNDER DYNAMIC TRAFFIC & CLOSURES:
 *   Whenever live traffic only slows roads down or closes them:
 *     liveCost(a) >= freeFlowCost(a)   for every directed arc a
 *   Therefore the true shortest path cost C*(v -> g) satisfies:
 *     C*(v -> g) >= C_free*(v -> g) >= max( d_free(L, g) - d_free(L, v),
 *                                           d_free(v, L) - d_free(g, L) )
 *   Consequently, the landmark tables NEVER need rebuilding on congestion spikes or
 *   road closures. If an artificial configuration speeds an edge above free-flow
 *   (`minSpeedRatio < 1`), scaling the ALT bound by `minSpeedRatio` preserves
 *   strict admissibility and consistency.
 */

import { MinHeap } from '../../core/heap.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class AltIndex {
  /**
   * @param {import('../../core/graph.js').Graph} graph
   * @param {import('./roadState.js').RoadState} road
   * @param {{landmarks?:number, seedNode?:number, allowed?:Uint8Array|null}} [options]
   */
  constructor(graph, road, options = {}) {
    const t0 = now();
    const kReq = Number.isFinite(options.landmarks) ? Math.round(options.landmarks) : 6;
    const k = Math.max(1, Math.min(8, kReq));

    this.graph = graph;
    this.costMode = road.costMode;
    this.climbWeight = road.climbWeight;
    this.descentWeight = road.descentWeight;

    const candidates = findMainComponent(graph, options.seedNode, options.allowed || null);
    this.landmarks = selectFarthestLandmarks(graph, k, candidates);
    this.count = this.landmarks.length;

    const weightFn = (arc) => road.freeFlowArcWeight(arc);
    this.fwd = new Array(this.count);
    this.bwd = new Array(this.count);

    for (let i = 0; i < this.count; i++) {
      const lm = this.landmarks[i];
      this.fwd[i] = runDijkstra(graph, lm, weightFn, false);
      this.bwd[i] = runDijkstra(graph, lm, weightFn, true);
    }

    this.buildMs = now() - t0;
    this.memoryBytes = this.count * 2 * graph.nodeCount * 8;
  }

  /**
   * Return an admissible & consistent heuristic `(node, goal) -> lowerBound`
   * combining `baseHeuristic` with the ALT triangle inequality bounds.
   * Note: Hoists goal lookup lazily per goal when queried repeatedly.
   *
   * @param {(a:number, b:number)=>number} baseHeuristic
   * @param {number} minScale
   */
  makeHeuristic(baseHeuristic, minScale = 1) {
    const L = this.count;
    const fwd = this.fwd;
    const bwd = this.bwd;
    if (L === 0) return baseHeuristic;

    let cachedGoal = -1;
    const goalFwd = new Float64Array(L);
    const goalBwd = new Float64Array(L);

    return (v, goal) => {
      if (goal !== cachedGoal) {
        cachedGoal = goal;
        for (let k = 0; k < L; k++) {
          goalFwd[k] = fwd[k][goal];
          goalBwd[k] = bwd[k][goal];
        }
      }
      let best = baseHeuristic(v, goal);
      let altBest = 0;
      for (let k = 0; k < L; k++) {
        const fg = goalFwd[k];
        const fv = fwd[k][v];
        if (Number.isFinite(fg) && Number.isFinite(fv)) {
          const d = fg - fv;
          if (d > altBest) altBest = d;
        }
        const bv = bwd[k][v];
        const bg = goalBwd[k];
        if (Number.isFinite(bv) && Number.isFinite(bg)) {
          const d = bv - bg;
          if (d > altBest) altBest = d;
        }
      }
      const scaledAlt = altBest * minScale;
      return scaledAlt > best ? scaledAlt : best;
    };
  }
}

/** Identify nodes in the main weakly connected component (or caller-provided allowed mask). */
function findMainComponent(graph, seedNode = -1, allowed = null) {
  const n = graph.nodeCount;
  if (allowed) {
    const list = [];
    for (let i = 0; i < n; i++) if (allowed[i] === 1) list.push(i);
    if (list.length > 0) return list;
  }

  // Pick a high-degree node near seedNode or node 0 to stay inside the main road network
  let root = Number.isInteger(seedNode) && seedNode >= 0 && seedNode < n ? seedNode : -1;
  if (root < 0) {
    let bestDeg = -1;
    for (let i = 0; i < n; i++) {
      const deg = graph.adjStart[i + 1] - graph.adjStart[i];
      if (deg > bestDeg) { bestDeg = deg; root = i; }
    }
  }
  if (root < 0) return [];

  const seen = new Uint8Array(n);
  const stack = [root];
  seen[root] = 1;
  const list = [];
  while (stack.length > 0) {
    const u = stack.pop();
    list.push(u);
    for (let a = graph.adjStart[u]; a < graph.adjStart[u + 1]; a++) {
      const v = graph.adjNeighbor[a];
      if (!seen[v]) { seen[v] = 1; stack.push(v); }
    }
    for (let i = graph.revStart[u]; i < graph.revStart[u + 1]; i++) {
      const a = graph.revArc[i];
      const v = graph.adjTail[a];
      if (!seen[v]) { seen[v] = 1; stack.push(v); }
    }
  }
  return list;
}

/** Deterministic farthest-point sampling inside `candidates`. */
function selectFarthestLandmarks(graph, k, candidates) {
  const m = candidates.length;
  if (m === 0) return new Int32Array(0);
  const count = Math.min(k, m);
  const chosen = new Int32Array(count);
  const minDistSq = new Float64Array(m).fill(Infinity);
  const used = new Uint8Array(m);

  // Start from the candidate furthest from centroid so landmarks lie on perimeter
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < m; i++) {
    const node = candidates[i];
    cx += graph.x[node];
    cy += graph.y[node];
  }
  cx /= m;
  cy /= m;

  let firstIdx = 0;
  let firstDist = -1;
  for (let i = 0; i < m; i++) {
    const node = candidates[i];
    const d = (graph.x[node] - cx) ** 2 + (graph.y[node] - cy) ** 2;
    if (d > firstDist) { firstDist = d; firstIdx = i; }
  }

  let curIdx = firstIdx;
  for (let s = 0; s < count; s++) {
    const lm = candidates[curIdx];
    chosen[s] = lm;
    used[curIdx] = 1;

    let nextIdx = -1;
    let nextDist = -1;
    const lx = graph.x[lm];
    const ly = graph.y[lm];
    for (let i = 0; i < m; i++) {
      if (used[i]) continue;
      const node = candidates[i];
      const d = (graph.x[node] - lx) ** 2 + (graph.y[node] - ly) ** 2;
      if (d < minDistSq[i]) minDistSq[i] = d;
      if (minDistSq[i] > nextDist) {
        nextDist = minDistSq[i];
        nextIdx = i;
      }
    }
    if (nextIdx < 0) return chosen.slice(0, s + 1);
    curIdx = nextIdx;
  }

  return chosen;
}

function runDijkstra(graph, root, weightFn, reverse) {
  const n = graph.nodeCount;
  const dist = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const heap = new MinHeap(Math.min(Math.max(256, n), 16384));

  dist[root] = 0;
  heap.push(0, root);

  const adjStart = graph.adjStart;
  const adjNeighbor = graph.adjNeighbor;
  const revStart = graph.revStart;
  const revArc = graph.revArc;
  const adjTail = graph.adjTail;

  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    const du = dist[u];

    if (!reverse) {
      for (let a = adjStart[u], end = adjStart[u + 1]; a < end; a++) {
        const w = weightFn(a);
        if (w === Infinity) continue;
        const v = adjNeighbor[a];
        if (done[v]) continue;
        const nd = du + w;
        if (nd < dist[v]) {
          dist[v] = nd;
          heap.push(nd, v);
        }
      }
    } else {
      for (let i = revStart[u], end = revStart[u + 1]; i < end; i++) {
        const a = revArc[i];
        const w = weightFn(a);
        if (w === Infinity) continue;
        const tail = adjTail[a];
        if (done[tail]) continue;
        const nd = du + w;
        if (nd < dist[tail]) {
          dist[tail] = nd;
          heap.push(nd, tail);
        }
      }
    }
  }

  return dist;
}
