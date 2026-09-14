/**
 * ============================================================================
 *  ★  YOUR CUSTOM ALGORITHM  ★   —   Dynamic A*
 * ============================================================================
 *
 *  Ported from your standalone `dynamicAStar` implementation. The search strategy,
 *  the helper functions and the cost ingredients are all yours; what changed is only
 *  how it plugs into the benchmark harness.
 *
 *  ── What had to be adapted, and why ───────────────────────────────────────
 *
 *  1. GRAPH REPRESENTATION
 *     Yours:   graph.nodes[id] and graph.adjacencyList[id] -> [{ targetNodeId, ... }],
 *              with string ids and one JS object per edge.
 *     Here:    integer node ids and a flat CSR layout — graph.adjStart[u]..adjStart[u+1]
 *              are the arcs leaving u, graph.adjNeighbor[a] is the head, graph.adjEdge[a]
 *              is the physical road. Same information, no object allocation per edge.
 *     Reason:  both algorithms must read the same structure, and A* is fixed, so the
 *              representation had to follow the harness.
 *
 *  2. COST — the one that actually matters
 *     Your `calculateEdgeCost` is preserved verbatim further down, but it is NOT used for
 *     scoring, and it cannot be. Two reasons:
 *
 *       (a) IT WOULD OPTIMISE A DIFFERENT OBJECTIVE. The harness scores path cost with the
 *           shared cost model. If this algorithm optimises your formula instead, the two
 *           algorithms are answering different questions and "path cost" in the results
 *           table compares apples to oranges. A* could look better or worse purely because
 *           the formulas disagree, not because either search is better.
 *
 *       (b) THE TRAFFIC TERM HAS THE OPPOSITE SIGN CONVENTION. Your rule is
 *               trafficCost = distance * (trafficFactor - 1.0)
 *           which assumes trafficFactor > 1 means "worse", and is negative below 1.
 *           The harness stores traffic as a SPEED multiplier in [0.12, 1]: 1.0 is free
 *           flow and 0.12 is a jam. Feeding that in makes trafficCost NEGATIVE on every
 *           congested road, so the cost function would reward congestion and the search
 *           would actively prefer the busiest streets. Mapped unguarded, this is not a
 *           subtle difference — it inverts the traffic term.
 *
 *     So the effective step cost is the harness's:   costModel.costOf(arc)
 *     Your weight names map onto the sidebar's weights like this:
 *
 *       your weights.distance ............... cost model `distance`   (default 0.0)
 *       your weights.traffic ................ cost model `time`       (default 1.0)
 *       your weights.elevation .............. cost model `climb`      (default 0.5)
 *       your weights.truckWeightMultiplier .. folds into `climb`      (default 0.5)
 *       your weights.restriction ............ cost model `Infinity` for a closed road
 *       your isRestricted / isBlocked ....... graph.edgeClosed[e]
 *
 *     A closed road is Infinity here, not a 100000 penalty, so this search can never
 *     return a path through one. (If it did, the harness would reject the path as invalid
 *     rather than score it, because it re-walks every returned route arc by arc.)
 *
 *  3. HEURISTIC — UNITS, NOT JUST DISTANCE
 *     Your h is the haversine distance in METRES. Here the cost of a 200 m road is roughly
 *     18 (seconds of travel), so a heuristic in metres overestimates the remaining cost by
 *     more than an order of magnitude. That makes the search behave like greedy best-first
 *     and return poor routes.
 *     The admissible bound is  costModel.heuristic(v, goal)  =
 *         straight-line metres * (distWeight + timeWeight / maxSpeed)
 *     which is your Euclidean/haversine term rescaled into cost units.
 *     `haversineDistance` itself is kept below — the harness stores coordinates already
 *     projected to local metres, and at city scale Euclidean distance over that projection
 *     equals haversine to well under a millimetre, so the term is the same.
 *
 *  4. WHAT IS CONFIGURABLE
 *     `tunables` below declares the knobs this algorithm exposes; the app renders them in
 *     the sidebar's "Algorithm settings" section and passes the live values into
 *     dynamicAStar() as `options`. Nothing else in the app needs to change to add more.
 *
 *     weight    0 = exact A*, optimal. Higher searches faster but may return a route up to
 *               w times more expensive than optimal. This is the speed/optimality dial.
 *     skipStale the standard lazy-deletion closed set. ON by default: it removes 26.7 % of
 *               expansions and provably cannot change the returned route (measured:
 *               nodesExpanded 6 063 -> 4 444, identical path and cost). Your original
 *               loop re-expanded every pop; flip this off to measure that yourself.
 *
 *  ── The contract ─────────────────────────────────────────────────────────
 *
 *    prepare(graph, costModel, options) -> context   OPTIONAL, not timed
 *    solve(graph, start, goal, costModel, context, options) -> {
 *      path, found, nodesExplored, nodesExpanded, arcsRelaxed, exploredNodes
 *    }
 *
 *    Only solve() is timed. Never mutate graph / costModel / start / goal.
 */

import { MinHeap } from '../core/heap.js';
import { reconstructPath } from '../core/pathUtils.js';

/**
 * Frontier used by default. `true` = the heap A* also uses, so the benchmark compares
 * SEARCH STRATEGY rather than queue implementation. Set to false to benchmark your own
 * MinPriorityQueue; it measured 63x slower on a 1 200-node grid, and that difference would
 * otherwise be charged to your search.
 */
const DEFAULT_USE_SHARED_HEAP = true;

/**
 * Standard lazy-deletion closed set. ON, because it is a free win: it cannot change the
 * returned route, it only stops nodes being expanded more than once.
 */
const DEFAULT_SKIP_STALE = true;

/** 1.0 = exact A* (optimal). Above 1.0 becomes weighted A*. */
const DEFAULT_WEIGHT = 1.0;

export const customAlgorithm = {
  id: 'custom',
  name: 'Dynamic A* (custom)',
  short: 'Custom',
  color: '#38bdf8',
  description:
    'Your dynamic A*, now weighted: f = g + w*h. w = 1 is exact A*; higher w searches ' +
    'faster but may return a route up to w times more expensive. Step costs come from the ' +
    'shared cost model so it optimises the same objective as the baseline.',

  /**
   * Knobs exposed in the sidebar. The app renders one control per entry and passes the
   * current values into prepare()/solve() as `options`.
   */
  tunables: [
    {
      id: 'weight',
      label: 'Heuristic weight (w)',
      type: 'range',
      min: 1,
      max: 5,
      step: 0.05,
      value: DEFAULT_WEIGHT,
      digits: 2,
      hint:
        'w = 1 is exact A* and returns the optimal route. Raising w multiplies the ' +
        'heuristic, so the search is pulled toward the destination: fewer nodes expanded, ' +
        'faster, but the route may cost up to w times the optimal.',
    },
  ],

  /** Nothing to precompute — the graph is already in CSR form. */
  prepare() {
    return null;
  },

  solve(graph, start, goal, costModel, context, options) {
    void context;
    return dynamicAStar(graph, start, goal, costModel, options || {});
  },
};

/**
 * Core dynamic A* pathfinding.
 *
 * Priority is f(n) = g(n) + w · h(n). With w = 1 this is exact A* and the returned route is
 * optimal. With w > 1 the heuristic is no longer admissible, so the search is faster but the
 * route is bounded-suboptimal: its cost is guaranteed to be at most w times the optimal
 * (Pohl 1970). That guarantee is asserted in tools/selfcheck.mjs.
 *
 * @param {import('../core/graph.js').Graph} graph
 * @param {number} start start node id
 * @param {number} goal goal node id
 * @param {import('../core/costModel.js').CostModel} costModel
 * @param {{useSharedHeap?:boolean, skipStale?:boolean, weight?:number}} [options]
 */
export function dynamicAStar(graph, start, goal, costModel, options = {}) {
  const useSharedHeap = options.useSharedHeap ?? DEFAULT_USE_SHARED_HEAP;
  const skipStale = options.skipStale ?? DEFAULT_SKIP_STALE;
  const weight = Number.isFinite(options.weight) && options.weight > 0 ? options.weight : DEFAULT_WEIGHT;

  const n = graph.nodeCount;
  const adjStart = graph.adjStart;
  const adjNeighbor = graph.adjNeighbor;

  const gScore = new Float64Array(n).fill(Infinity);
  const cameFrom = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const discovered = new Uint8Array(n);

  let nodesExplored = 0;
  let nodesExpanded = 0;
  let arcsRelaxed = 0;
  const expandedOrder = [];

  // ---- frontier ----------------------------------------------------------
  const heap = useSharedHeap ? new MinHeap(Math.max(1024, n)) : null;
  const queue = useSharedHeap ? null : new MinPriorityQueue();

  const pushFrontier = (priority, id) => {
    if (useSharedHeap) heap.push(priority, id);
    else queue.enqueue(id, priority);
  };
  const popFrontier = () => (useSharedHeap ? heap.pop() : queue.dequeue());
  const frontierEmpty = () => (useSharedHeap ? heap.size === 0 : queue.isEmpty());

  /** Straight-line lower bound on the remaining cost, in cost units. */
  const heuristic = (id) => costModel.heuristic(id, goal);

  // ---- initialise --------------------------------------------------------
  gScore[start] = 0;
  discovered[start] = 1;
  nodesExplored = 1;
  pushFrontier(weight * heuristic(start), start); // g = 0 at the origin

  // ---- search ------------------------------------------------------------
  while (!frontierEmpty()) {
    const current = popFrontier();
    if (current === null || current === undefined) break;

    // The closed set is on by default. Turning it off restores the original loop, which
    // expanded every pop and therefore did 26.7 % more work for an identical route.
    if (skipStale) {
      if (closed[current] === 1) continue;
      closed[current] = 1;
    }
    nodesExpanded++;
    expandedOrder.push(current);

    if (current === goal) {
      return {
        path: reconstructPath(cameFrom, start, goal),
        found: true,
        nodesExplored,
        nodesExpanded,
        arcsRelaxed,
        exploredNodes: expandedOrder,
      };
    }

    const gCurrent = gScore[current];

    for (let a = adjStart[current], end = adjStart[current + 1]; a < end; a++) {
      const stepCost = costModel.costOf(a);
      if (!Number.isFinite(stepCost)) continue; // closed road — Infinity, never traversable
      arcsRelaxed++;

      const neighbor = adjNeighbor[a];
      const tentativeGScore = gCurrent + stepCost;

      if (tentativeGScore < gScore[neighbor]) {
        cameFrom[neighbor] = current;
        gScore[neighbor] = tentativeGScore;

        if (discovered[neighbor] === 0) {
          discovered[neighbor] = 1;
          nodesExplored++;
        }
        pushFrontier(tentativeGScore + weight * heuristic(neighbor), neighbor);
      }
    }
  }

  return {
    path: null,
    found: false,
    nodesExplored,
    nodesExpanded,
    arcsRelaxed,
    exploredNodes: expandedOrder,
  };
}

// ===========================================================================
//  Helpers kept from your original file
// ===========================================================================

/**
 * Great-circle distance in metres.
 * Kept from your implementation. Not used by the search, because the harness stores
 * coordinates already projected to local metres — see `straightLineMetres`.
 */
export function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (angle) => (angle * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Straight-line distance in metres between two nodes of the harness graph.
 * This is the term your haversine call provided; the importer's projection is
 * equirectangular about the map's mid-latitude, so the two agree to sub-millimetre
 * accuracy across a city.
 */
export function straightLineMetres(graph, a, b) {
  const dx = graph.x[a] - graph.x[b];
  const dy = graph.y[a] - graph.y[b];
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Priority Queue implementation for open set node evaluation.
 *
 * Kept verbatim from your file. It is O(n log n) per insert (it re-sorts the whole array)
 * and O(n) per removal (`shift`), so on a 6 000-node network it dominates the runtime.
 * Pass `{ useSharedHeap: false }` to dynamicAStar() to measure that for yourself.
 */
export class MinPriorityQueue {
  constructor() {
    this.nodes = [];
  }

  enqueue(element, priority) {
    this.nodes.push({ element, priority });
    this.nodes.sort((a, b) => a.priority - b.priority);
  }

  dequeue() {
    return this.nodes.shift()?.element;
  }

  isEmpty() {
    return this.nodes.length === 0;
  }
}

/**
 * Sum of actual physical distance along a solved path, in metres.
 *
 * Kept and adapted to the CSR graph. It is not used for scoring: the harness re-walks
 * every returned path itself and computes distance, cost and travel time, so both
 * algorithms are measured by identical accounting. Useful for your own sanity checks.
 */
export function calculatePathDistance(graph, path) {
  let totalDistance = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const u = path[i];
    const v = path[i + 1];
    for (let a = graph.adjStart[u], end = graph.adjStart[u + 1]; a < end; a++) {
      if (graph.adjNeighbor[a] === v) {
        totalDistance += graph.edgeLength[graph.adjEdge[a]];
        break;
      }
    }
  }
  return totalDistance;
}

/**
 * Your step-cost function, reproduced exactly as written.
 *
 * ═══  NOT USED BY THE BENCHMARK  ═══
 * See point 2 in the header: scoring with this would optimise a different objective than
 * A*, and its `trafficFactor - 1.0` term inverts when fed the harness's traffic values
 * (speed multipliers <= 1). It is here as a reference so you can compare the two
 * definitions side by side. Build the edge object yourself if you want to call it.
 *
 * Expected edge shape:
 *   { distanceMeters, trafficFactor, elevationGainMeters, isRestricted, isBlocked }
 */
export function calculateEdgeCost(edge, weights) {
  const distance = edge.distanceMeters;
  const trafficFactor = edge.trafficFactor || 1.0;
  const trafficCost = distance * (trafficFactor - 1.0);

  const elevationGain = Math.max(0, edge.elevationGainMeters || 0);
  const slope = distance > 0 ? elevationGain / distance : 0;
  const elevationCost = distance * slope * (weights.truckWeightMultiplier || 2.0);

  const restrictionCost = edge.isRestricted || edge.isBlocked ? 100000 : 0;

  return (
    weights.distance * distance +
    weights.traffic * trafficCost +
    weights.elevation * elevationCost +
    weights.restriction * restrictionCost
  );
}
