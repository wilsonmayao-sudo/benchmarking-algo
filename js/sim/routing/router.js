/**
 * Router — the only place the simulator calls A*.
 *
 * Responsibilities
 *   • bind A* (legacy per-search or reusable timestamped + ALT workspace) to the live RoadState
 *   • record benchmark statistics for EVERY search: count, wall time (cold/warm), nodes expanded,
 *     broken down by purpose ('route' | 'reroute' | 'eta' | 'assign'), plus memory overhead
 *   • cache leg costs (and optional full paths when `cachePaths: true`) keyed to `RoadState.version`.
 *     Cache hits are NOT counted as A* calls — they are reported separately.
 */

import { astarSearch, makeHeuristic } from './astar.js';
import { FastAStarWorkspace } from './fastAstar.js';
import { AltIndex } from './altIndex.js';

export const PURPOSES = ['route', 'reroute', 'eta', 'assign'];

export class Router {
  /**
   * @param {import('../../core/graph.js').Graph} graph
   * @param {import('./roadState.js').RoadState} roadState
   * @param {{
   *   heuristic?: 'euclidean'|'manhattan'|'alt',
   *   engine?: 'legacy'|'fast',
   *   weightFactor?: number,
   *   landmarks?: number,
   *   altIndex?: AltIndex|null,
   *   cachePaths?: boolean,
   *   allowed?: Uint8Array|null,
   * }} [options]
   */
  constructor(graph, roadState, options = {}) {
    this.graph = graph;
    this.road = roadState;
    this.heuristicName = options.heuristic || 'euclidean';
    this.engine = options.engine || (this.heuristicName === 'alt' ? 'fast' : 'legacy');
    this.weightFactor = Number.isFinite(options.weightFactor) && options.weightFactor >= 1
      ? options.weightFactor
      : 1.0;
    this.cachePaths = Boolean(options.cachePaths);
    this.weight = (arc) => roadState.arcWeight(arc);

    this.workspace = this.engine === 'fast' ? new FastAStarWorkspace(graph.nodeCount) : null;
    this.alt = null;
    if (this.heuristicName === 'alt') {
      this.alt = options.altIndex || new AltIndex(graph, roadState, {
        landmarks: options.landmarks ?? 6,
        allowed: options.allowed || null,
      });
    }

    this._heuristic = null;
    this._heuristicVersion = -1;
    this._cache = new Map();
    this._pathCache = new Map();
    this._cacheVersion = -1;

    this.stats = {
      calls: 0,
      totalMs: 0,
      coldCalls: 0,
      coldMs: 0,
      warmCalls: 0,
      warmMs: 0,
      totalExpanded: 0,
      minExpanded: Infinity,
      maxExpanded: 0,
      failed: 0,
      cacheHits: 0,
      pathCacheHits: 0,
      offlineFallbacks: 0,
      byPurpose: Object.fromEntries(PURPOSES.map((p) => [p, { calls: 0, ms: 0, expanded: 0 }])),
      /** per-search samples: [purpose, nodesExpanded, ms] — exported for later analysis */
      samples: [],
    };
  }

  /** Heuristic is rebuilt only when the road state changed (its scale may have moved). */
  _h() {
    if (this._heuristicVersion !== this.road.version) {
      const base = makeHeuristic(
        this.heuristicName === 'manhattan' ? 'manhattan' : 'euclidean',
        this.graph,
        this.road.heuristicScale(),
      );
      if (this.heuristicName === 'alt' && this.alt) {
        const minScale = typeof this.road.minSpeedRatio === 'function' ? this.road.minSpeedRatio() : 1;
        this._heuristic = this.alt.makeHeuristic(base, minScale);
      } else {
        this._heuristic = base;
      }
      this._heuristicVersion = this.road.version;
    }
    return this._heuristic;
  }

  /**
   * Run A* from `start` to `goal`, recording statistics.
   * @param {string} purpose one of PURPOSES
   */
  findPath(start, goal, purpose = 'route') {
    if (this.cachePaths) {
      this._syncCache();
      const key = start * 4294967296 + goal;
      const cached = this._pathCache.get(key);
      if (cached) {
        this.stats.cacheHits++;
        this.stats.pathCacheHits++;
        return {
          ...cached,
          path: cached.path ? cached.path.slice() : null,
          arcs: cached.arcs ? cached.arcs.slice() : null,
        };
      }
    }

    const result = this.workspace
      ? this.workspace.search(this.graph, start, goal, {
        weight: this.weight,
        heuristic: this._h(),
        weightFactor: this.weightFactor,
      })
      : astarSearch(this.graph, start, goal, {
        weight: this.weight,
        heuristic: this._h(),
      });

    const s = this.stats;
    s.calls++;
    s.totalMs += result.ms;
    if (s.calls <= 5) { s.coldCalls++; s.coldMs += result.ms; }
    else { s.warmCalls++; s.warmMs += result.ms; }
    if (this.road.offline) s.offlineFallbacks++;

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
    this._remember(start, goal, result);
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

  /** Fast single-source distance lookup helper for stop sequencing. */
  distancesFrom(start, targetNodes) {
    if (this.workspace) {
      return this.workspace.computeDistances(this.graph, start, targetNodes, { weight: this.weight });
    }
    const ws = new FastAStarWorkspace(this.graph.nodeCount);
    return ws.computeDistances(this.graph, start, targetNodes, { weight: this.weight });
  }

  _remember(start, goal, result) {
    this._syncCache();
    const key = start * 4294967296 + goal;
    this._cache.set(key, result.cost);
    if (this.cachePaths) {
      this._pathCache.set(key, {
        ...result,
        path: result.path ? result.path.slice() : null,
        arcs: result.arcs ? result.arcs.slice() : null,
      });
    }
  }

  _syncCache() {
    if (this._cacheVersion !== this.road.version) {
      this._cache.clear();
      this._pathCache.clear();
      this._cacheVersion = this.road.version;
    }
  }

  /** Summary numbers for the metrics panel / export. */
  summary() {
    const s = this.stats;
    const wsBytes = this.workspace ? this.workspace.memoryBytes : 0;
    const altBytes = this.alt ? this.alt.memoryBytes : 0;
    return {
      astarCalls: s.calls,
      astarTotalMs: s.totalMs,
      astarAvgMs: s.calls ? s.totalMs / s.calls : 0,
      coldAvgMs: s.coldCalls ? s.coldMs / s.coldCalls : 0,
      warmAvgMs: s.warmCalls ? s.warmMs / s.warmCalls : 0,
      nodesExpandedTotal: s.totalExpanded,
      nodesExpandedAvg: s.calls ? s.totalExpanded / s.calls : 0,
      nodesExpandedMin: s.calls ? s.minExpanded : 0,
      nodesExpandedMax: s.maxExpanded,
      astarFailed: s.failed,
      legCacheHits: s.cacheHits,
      pathCacheHits: s.pathCacheHits,
      offlineFallbacks: s.offlineFallbacks,
      altPrepMs: this.alt ? this.alt.buildMs : 0,
      altMemoryBytes: altBytes,
      workspaceMemoryBytes: wsBytes,
      memoryBytes: wsBytes + altBytes,
      byPurpose: s.byPurpose,
    };
  }
}
