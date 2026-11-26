/**
 * Router — the only place the simulator calls A*.
 *
 * Responsibilities
 *   • bind `astarSearch` to the live RoadState (weights) and the configured heuristic
 *   • record benchmark statistics for EVERY search: count, wall time, nodes expanded,
 *     broken down by purpose ('route' | 'reroute' | 'eta' | 'assign')
 *   • cache leg costs for look-ahead ETA (bin → bin). A cached leg is reused only while
 *     the road state is unchanged (RoadState.version), and a cache hit is NOT counted as
 *     an A* call — the metrics report cache hits separately, so nothing is hidden.
 */

import { astarSearch, makeHeuristic } from './astar.js';

export const PURPOSES = ['route', 'reroute', 'eta', 'assign'];

export class Router {
  /**
   * @param {import('../../core/graph.js').Graph} graph
   * @param {import('./roadState.js').RoadState} roadState
   * @param {{heuristic?:'euclidean'|'manhattan'}} [options]
   */
  constructor(graph, roadState, options = {}) {
    this.graph = graph;
    this.road = roadState;
    this.heuristicName = options.heuristic || 'euclidean';
    this.weight = (arc) => roadState.arcWeight(arc);

    this._heuristic = null;
    this._heuristicVersion = -1;
    this._cache = new Map();
    this._cacheVersion = -1;

    this.stats = {
      calls: 0,
      totalMs: 0,
      totalExpanded: 0,
      minExpanded: Infinity,
      maxExpanded: 0,
      failed: 0,
      cacheHits: 0,
      byPurpose: Object.fromEntries(PURPOSES.map((p) => [p, { calls: 0, ms: 0, expanded: 0 }])),
      /** per-search samples: [purpose, nodesExpanded, ms] — exported for later analysis */
      samples: [],
    };
  }

  /** Heuristic is rebuilt only when the road state changed (its scale may have moved). */
  _h() {
    if (this._heuristicVersion !== this.road.version) {
      this._heuristic = makeHeuristic(this.heuristicName, this.graph, this.road.heuristicScale());
      this._heuristicVersion = this.road.version;
    }
    return this._heuristic;
  }

  /**
   * Run A* from `start` to `goal`, recording statistics.
   * @param {string} purpose one of PURPOSES
   */
  findPath(start, goal, purpose = 'route') {
    const result = astarSearch(this.graph, start, goal, { weight: this.weight, heuristic: this._h() });

    const s = this.stats;
    s.calls++;
    s.totalMs += result.ms;
    s.totalExpanded += result.nodesExpanded;
    if (result.nodesExpanded < s.minExpanded) s.minExpanded = result.nodesExpanded;
    if (result.nodesExpanded > s.maxExpanded) s.maxExpanded = result.nodesExpanded;
    if (!result.found) s.failed++;
    const p = s.byPurpose[purpose] || (s.byPurpose[purpose] = { calls: 0, ms: 0, expanded: 0 });
    p.calls++;
    p.ms += result.ms;
    p.expanded += result.nodesExpanded;
    s.samples.push([purpose, result.nodesExpanded, Number(result.ms.toFixed(4))]);

    // A fresh search is also a valid cache entry for the current road state.
    this._remember(start, goal, result.cost);
    return result;
  }

  /**
   * Cost of the cheapest route (Infinity if none). Uses the leg cache when possible —
   * intended for look-ahead ETA where only the cost, not the path, is needed.
   */
  legCost(start, goal, purpose = 'eta') {
    this._syncCache();
    const key = start * 4294967296 + goal; // unique numeric key per ordered pair
    if (this._cache.has(key)) {
      this.stats.cacheHits++;
      return this._cache.get(key);
    }
    return this.findPath(start, goal, purpose).cost;
  }

  _remember(start, goal, cost) {
    this._syncCache();
    this._cache.set(start * 4294967296 + goal, cost);
  }

  _syncCache() {
    if (this._cacheVersion !== this.road.version) {
      this._cache.clear();
      this._cacheVersion = this.road.version;
    }
  }

  /** Summary numbers for the metrics panel / export. */
  summary() {
    const s = this.stats;
    return {
      astarCalls: s.calls,
      astarTotalMs: s.totalMs,
      astarAvgMs: s.calls ? s.totalMs / s.calls : 0,
      nodesExpandedTotal: s.totalExpanded,
      nodesExpandedAvg: s.calls ? s.totalExpanded / s.calls : 0,
      nodesExpandedMin: s.calls ? s.minExpanded : 0,
      nodesExpandedMax: s.maxExpanded,
      astarFailed: s.failed,
      legCacheHits: s.cacheHits,
      byPurpose: s.byPurpose,
    };
  }
}
