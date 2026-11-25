/**
 * Fixed-Endpoint Road-Cost Stop Sequencer & Route Quality Evaluator (`R01`).
 *
 * Replaces geometry-only Euclidean Nearest Neighbor / angular sweeps with:
 *   1. Bounded single-source Dijkstra road-cost matrix construction M[u][v]
 *   2. Road-cost Nearest Neighbor seeding
 *   3. Exact Fixed-Endpoint Asymmetric 2-Opt refinement optimizing:
 *        C(start -> s_0 -> ... -> s_{m-1} -> endNode)
 *      across directed / one-way streets in Naga City.
 *   4. Physical route quality metrics: unique road km, repeated road km,
 *      backtracking (immediate u -> v -> u arc reversals), and U-turn count.
 */

import { FastAStarWorkspace } from '../routing/fastAstar.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const INF_PENALTY = 1e15;

/**
 * Compute all-pairs shortest-path cost matrix over `uniqueNodes` using `k`
 * bounded single-source Dijkstras instead of k^2 separate A* calls.
 *
 * @param {import('../../core/graph.js').Graph} graph
 * @param {import('../routing/roadState.js').RoadState} road
 * @param {import('../routing/router.js').Router|null} router
 * @param {number[]} uniqueNodes
 * @returns {{nodeToIdx:Map<number,number>, matrix:Float64Array, stride:number, nodesExpanded:number, ms:number}}
 */
export function buildCostMatrix(graph, road, router, uniqueNodes) {
  const t0 = now();
  const stride = uniqueNodes.length;
  const nodeToIdx = new Map();
  uniqueNodes.forEach((n, idx) => nodeToIdx.set(n, idx));

  const matrix = new Float64Array(stride * stride).fill(Infinity);
  const weight = router ? router.weight : (arc) => road.arcWeight(arc);
  const ws = (router && router.workspace) ? router.workspace : new FastAStarWorkspace(graph.nodeCount);
  let nodesExpanded = 0;

  // Incremental row memoization keyed to RoadState.version so receding-horizon
  // calls (planNext + computeEta + stop-by-stop suffix) never re-run identical Dijkstras.
  if (!road._seqMatrixCache || road._seqMatrixVersion !== road.version || road._seqMatrixCostMode !== road.costMode) {
    road._seqMatrixCache = new Map();
    road._seqMatrixVersion = road.version;
    road._seqMatrixCostMode = road.costMode;
  }
  const cache = road._seqMatrixCache;

  for (let i = 0; i < stride; i++) {
    const src = uniqueNodes[i];
    let rowMap = cache.get(src);
    if (!rowMap) {
      rowMap = new Map();
      cache.set(src, rowMap);
    }
    const missing = [];
    for (let j = 0; j < stride; j++) {
      const dst = uniqueNodes[j];
      if (i !== j && !rowMap.has(dst)) missing.push(dst);
    }
    if (missing.length > 0) {
      const res = ws.computeDistances(graph, src, missing, { weight });
      nodesExpanded += res.nodesExpanded;
      for (const [dst, cost] of res.costs) rowMap.set(dst, cost);
    }
    const rowOffset = i * stride;
    for (let j = 0; j < stride; j++) {
      matrix[rowOffset + j] = i === j ? 0 : (rowMap.get(uniqueNodes[j]) ?? Infinity);
    }
  }

  return { nodeToIdx, matrix, stride, nodesExpanded, ms: now() - t0 };
}

/**
 * Sequence stops (`stopIds`) from `startNode` towards fixed `endNode` (Landfill or Depot).
 *
 * @param {import('../../core/graph.js').Graph} graph
 * @param {import('../routing/roadState.js').RoadState} road
 * @param {import('../routing/router.js').Router|null} router
 * @param {{
 *   startNode: number,
 *   stopIds: string[],
 *   binsById: Map<string, object>,
 *   endNode?: number,
 *   method?: 'given'|'nearest'|'road_nn'|'road2opt'
 * }} opts
 */
export function sequenceStops(graph, road, router, {
  startNode,
  stopIds,
  binsById,
  endNode = -1,
  method = 'road2opt',
}) {
  const t0 = now();
  if (!stopIds || stopIds.length === 0) {
    return { order: [], unreachableIds: [], matrixCost: 0, improvedPasses: 0, nodesExpanded: 0, ms: 0 };
  }
  if (method === 'given') {
    return { order: stopIds.slice(), unreachableIds: [], matrixCost: NaN, improvedPasses: 0, nodesExpanded: 0, ms: now() - t0 };
  }
  if (method === 'nearest') {
    const left = stopIds.slice();
    const order = [];
    let cur = startNode;
    while (left.length > 0) {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < left.length; i++) {
        const n = binsById.get(left[i]).node;
        const d = (graph.x[n] - graph.x[cur]) ** 2 + (graph.y[n] - graph.y[cur]) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      const id = left.splice(best, 1)[0];
      order.push(id);
      cur = binsById.get(id).node;
    }
    return { order, unreachableIds: [], matrixCost: NaN, improvedPasses: 0, nodesExpanded: 0, ms: now() - t0 };
  }

  // Unique nodes needed for road-cost matrix
  const uniqueSet = new Set([startNode]);
  for (const id of stopIds) uniqueSet.add(binsById.get(id).node);
  if (endNode >= 0) uniqueSet.add(endNode);
  const uniqueNodes = [...uniqueSet];

  const { nodeToIdx, matrix, stride, nodesExpanded } = buildCostMatrix(graph, road, router, uniqueNodes);
  const idxOf = (node) => nodeToIdx.get(node);
  const dist = (uIdx, vIdx) => {
    const c = matrix[uIdx * stride + vIdx];
    return Number.isFinite(c) ? c : INF_PENALTY;
  };

  const startIdx = idxOf(startNode);
  const endIdx = endNode >= 0 ? idxOf(endNode) : -1;

  // Partition stops by reachability from startNode so unreachable stops stay in denominator metrics
  const reachable = [];
  const unreachableIds = [];
  for (const id of stopIds) {
    const nIdx = idxOf(binsById.get(id).node);
    if (Number.isFinite(matrix[startIdx * stride + nIdx])) {
      reachable.push({ id, nIdx });
    } else {
      unreachableIds.push(id);
    }
  }

  if (reachable.length === 0) {
    return {
      order: stopIds.slice(),
      unreachableIds,
      matrixCost: Infinity,
      improvedPasses: 0,
      nodesExpanded,
      ms: now() - t0,
    };
  }

  // Step 1: Road-cost Nearest Neighbor
  const tour = [];
  const remaining = reachable.slice();
  let curIdx = startIdx;
  while (remaining.length > 0) {
    let bestPos = 0;
    let bestCost = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = dist(curIdx, remaining[i].nIdx);
      if (c < bestCost) { bestCost = c; bestPos = i; }
    }
    const picked = remaining.splice(bestPos, 1)[0];
    tour.push(picked);
    curIdx = picked.nIdx;
  }

  const tourCost = (arr) => {
    let total = dist(startIdx, arr[0].nIdx);
    for (let k = 0; k + 1 < arr.length; k++) {
      total += dist(arr[k].nIdx, arr[k + 1].nIdx);
    }
    if (endIdx >= 0) total += dist(arr[arr.length - 1].nIdx, endIdx);
    return total;
  };

  let bestCost = tourCost(tour);
  let improvedPasses = 0;

  // Step 2: Fixed-Endpoint Asymmetric 2-Opt refinement
  if (method === 'road2opt' && tour.length >= 2) {
    const m = tour.length;
    for (let pass = 0; pass < 64; pass++) {
      let improved = false;
      for (let i = 0; i < m - 1; i++) {
        for (let j = i + 1; j < m; j++) {
          // Reverse segment [i..j] in-place temporarily to evaluate exact asymmetric directed cost
          reverseSlice(tour, i, j);
          const candidateCost = tourCost(tour);
          if (candidateCost < bestCost - 1e-6) {
            bestCost = candidateCost;
            improved = true;
          } else {
            reverseSlice(tour, i, j);
          }
        }
      }
      if (!improved) break;
      improvedPasses++;
    }
  }

  // Append unreachableIds at the tail so callers never silently drop required stops
  const order = [...tour.map((s) => s.id), ...unreachableIds];
  return {
    order,
    unreachableIds,
    matrixCost: bestCost >= INF_PENALTY ? Infinity : bestCost,
    improvedPasses,
    nodesExpanded,
    ms: now() - t0,
  };
}

function reverseSlice(arr, i, j) {
  while (i < j) {
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
    i++;
    j--;
  }
}

/**
 * Compute operational route geometry quality metrics along traversed arcs:
 *   - totalDistanceM       sum of physical edge lengths traversed
 *   - uniqueRoadDistanceM  sum of physical lengths of distinct edges visited at least once
 *   - repeatedRoadDistanceM totalDistanceM - uniqueRoadDistanceM
 *   - repeatedRoadRatio    repeatedRoadDistanceM / totalDistanceM
 *   - backtrackingDistanceM sum of edge lengths of immediate u -> v -> u reversals
 *   - uTurnCount           count of immediate arc reversals (u -> v followed by v -> u)
 *
 * @param {import('../../core/graph.js').Graph} graph
 * @param {number[]} traversedArcs
 */
export function computeRouteQualityMetrics(graph, traversedArcs) {
  if (!traversedArcs || traversedArcs.length === 0) {
    return {
      totalDistanceM: 0,
      uniqueRoadDistanceM: 0,
      repeatedRoadDistanceM: 0,
      repeatedRoadRatio: 0,
      backtrackingDistanceM: 0,
      uTurnCount: 0,
    };
  }

  let totalDistanceM = 0;
  let uniqueRoadDistanceM = 0;
  let backtrackingDistanceM = 0;
  let uTurnCount = 0;
  const visitedEdges = new Uint8Array(graph.edgeCount);

  let prevTail = -1;
  let prevHead = -1;
  let prevEdge = -1;

  for (let i = 0; i < traversedArcs.length; i++) {
    const a = traversedArcs[i];
    const e = graph.adjEdge[a];
    const len = graph.edgeLength[e];
    totalDistanceM += len;

    if (visitedEdges[e] === 0) {
      visitedEdges[e] = 1;
      uniqueRoadDistanceM += len;
    }

    const tail = graph.adjTail[a];
    const head = graph.adjNeighbor[a];
    if (i > 0 && tail === prevHead && head === prevTail && e === prevEdge) {
      uTurnCount++;
      backtrackingDistanceM += len;
    }
    prevTail = tail;
    prevHead = head;
    prevEdge = e;
  }

  const repeatedRoadDistanceM = Math.max(0, totalDistanceM - uniqueRoadDistanceM);
  const repeatedRoadRatio = totalDistanceM > 0 ? repeatedRoadDistanceM / totalDistanceM : 0;

  return {
    totalDistanceM,
    uniqueRoadDistanceM,
    repeatedRoadDistanceM,
    repeatedRoadRatio,
    backtrackingDistanceM,
    uTurnCount,
  };
}
