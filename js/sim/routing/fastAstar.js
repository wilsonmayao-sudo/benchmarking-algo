/**
 * Timestamped Reusable Typed-Array A* & Bounded Dijkstra Workspace (`R02`, `R09`).
 *
 * Eliminates per-search O(V) typed-array initialization (`fill(Infinity)`, `new Uint8Array`)
 * by assigning an incrementing 32-bit epoch `stamp` to every search. A node is untouched in
 * the current query whenever `seenStamp[v] !== stamp` — resetting the workspace is O(1).
 *
 * Supports:
 *   - Optimal search (`weightFactor = 1.0`) with any admissible heuristic
 *   - Bounded-suboptimal Weighted A* (`weightFactor > 1.0`) (`R09`)
 *   - Single-source multi-target bounded Dijkstra (`computeDistances`) for stop sequencing (`R01`)
 */

import { MinHeap } from '../../core/heap.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class FastAStarWorkspace {
  /** @param {number} nodeCount */
  constructor(nodeCount) {
    this.nodeCount = nodeCount;
    this.gScore = new Float64Array(nodeCount);
    this.viaArc = new Int32Array(nodeCount);
    this.seenStamp = new Uint32Array(nodeCount);
    this.closedStamp = new Uint32Array(nodeCount);
    this.stamp = 0;
    this.heap = new MinHeap(Math.min(Math.max(256, nodeCount), 16384));
  }

  /** Exact typed-array footprint of this reusable workspace in bytes. */
  get memoryBytes() {
    return (
      this.gScore.byteLength +
      this.viaArc.byteLength +
      this.seenStamp.byteLength +
      this.closedStamp.byteLength +
      this.heap._keys.byteLength +
      this.heap._vals.byteLength +
      this.heap._seq.byteLength
    );
  }

  _nextStamp() {
    if (this.stamp >= 0xfffffffe) {
      this.seenStamp.fill(0);
      this.closedStamp.fill(0);
      this.stamp = 0;
    }
    this.stamp++;
    return this.stamp;
  }

  /**
   * Run A* from `start` to `goal` using pre-allocated timestamped arrays.
   *
   * @param {import('../../core/graph.js').Graph} graph
   * @param {number} start
   * @param {number} goal
   * @param {{weight:(arc:number)=>number, heuristic:(node:number, goal:number)=>number, weightFactor?:number}} opts
   */
  search(graph, start, goal, { weight, heuristic, weightFactor = 1.0 }) {
    const t0 = now();
    if (start === goal) {
      return {
        found: true,
        path: [start],
        arcs: [],
        cost: 0,
        nodesExpanded: 0,
        nodesExplored: 1,
        ms: now() - t0,
      };
    }

    const s = this._nextStamp();
    const { gScore, viaArc, seenStamp, closedStamp, heap } = this;
    heap.clear();

    const adjStart = graph.adjStart;
    const adjNeighbor = graph.adjNeighbor;
    const wf = Number.isFinite(weightFactor) && weightFactor >= 1 ? weightFactor : 1.0;

    gScore[start] = 0;
    viaArc[start] = -1;
    seenStamp[start] = s;

    let nodesExpanded = 0;
    let nodesExplored = 1;
    heap.push(wf * heuristic(start, goal), start);

    let found = false;
    while (heap.size > 0) {
      const u = heap.pop();
      if (closedStamp[u] === s) continue;
      closedStamp[u] = s;
      nodesExpanded++;

      if (u === goal) {
        found = true;
        break;
      }

      const gU = gScore[u];
      for (let a = adjStart[u], end = adjStart[u + 1]; a < end; a++) {
        const w = weight(a);
        if (w === Infinity) continue;
        const v = adjNeighbor[a];
        if (closedStamp[v] === s) continue;
        const tentative = gU + w;
        const unseen = seenStamp[v] !== s;
        if (unseen || tentative < gScore[v]) {
          if (unseen) {
            seenStamp[v] = s;
            nodesExplored++;
          }
          gScore[v] = tentative;
          viaArc[v] = a;
          heap.push(tentative + wf * heuristic(v, goal), v);
        }
      }
    }

    let path = null;
    let arcs = null;
    if (found) {
      arcs = [];
      let cur = goal;
      while (cur !== start) {
        const a = viaArc[cur];
        arcs.push(a);
        cur = graph.adjTail[a];
      }
      arcs.reverse();
      path = new Array(arcs.length + 1);
      path[0] = start;
      for (let i = 0; i < arcs.length; i++) path[i + 1] = adjNeighbor[arcs[i]];
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

  /**
   * Single-source multi-target Dijkstra: settles `targetNodes` cleanly in one pass
   * and terminates immediately once all targets are settled.
   *
   * @param {import('../../core/graph.js').Graph} graph
   * @param {number} start
   * @param {number[]} targetNodes
   * @param {{weight:(arc:number)=>number}} opts
   * @returns {{costs:Map<number, number>, nodesExpanded:number, ms:number}}
   */
  computeDistances(graph, start, targetNodes, { weight }) {
    const t0 = now();
    const costs = new Map();
    const pending = new Set(targetNodes);
    if (pending.has(start)) {
      costs.set(start, 0);
      pending.delete(start);
    }
    if (pending.size === 0) {
      return { costs, nodesExpanded: 0, ms: now() - t0 };
    }

    const s = this._nextStamp();
    const { gScore, seenStamp, closedStamp, heap } = this;
    heap.clear();

    const adjStart = graph.adjStart;
    const adjNeighbor = graph.adjNeighbor;

    gScore[start] = 0;
    seenStamp[start] = s;
    heap.push(0, start);

    let nodesExpanded = 0;
    while (heap.size > 0 && pending.size > 0) {
      const u = heap.pop();
      if (closedStamp[u] === s) continue;
      closedStamp[u] = s;
      nodesExpanded++;

      if (pending.has(u)) {
        costs.set(u, gScore[u]);
        pending.delete(u);
        if (pending.size === 0) break;
      }

      const gU = gScore[u];
      for (let a = adjStart[u], end = adjStart[u + 1]; a < end; a++) {
        const w = weight(a);
        if (w === Infinity) continue;
        const v = adjNeighbor[a];
        if (closedStamp[v] === s) continue;
        const tentative = gU + w;
        if (seenStamp[v] !== s || tentative < gScore[v]) {
          seenStamp[v] = s;
          gScore[v] = tentative;
          heap.push(tentative, v);
        }
      }
    }

    for (const remaining of pending) costs.set(remaining, Infinity);
    return { costs, nodesExpanded, ms: now() - t0 };
  }
}
