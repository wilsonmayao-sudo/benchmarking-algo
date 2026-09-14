/**
 * Road-network graph.
 *
 * Stored with flat typed arrays and a CSR (compressed sparse row) adjacency so that the
 * inner loops of the search algorithms touch as few objects as possible.
 *
 * ROADS ARE DIRECTED PER-EDGE
 *   Most roads are two-way: one road record produces two directed *arcs*, because cost
 *   is direction dependent (climbing costs more than descending). A one-way street
 *   (real city maps are full of them) is flagged with `edgeDirected` and produces a
 *   single arc, so it can only be driven in the `from → to` direction.
 *
 * ARC vs EDGE
 *   arc index a  → a single directed traversal  (0 <= a < graph.arcCount)
 *   edge index e → the physical road            (graph.adjEdge[a] recovers it)
 *
 * Per-arc arrays produced by `buildAdjacency()`:
 *   adjStart[u] .. adjStart[u+1]  →  the arcs leaving node u
 *   adjTail[a]     origin node of arc a
 *   adjNeighbor[a] head node of arc a
 *   adjEdge[a]     physical edge a belongs to
 *   arcTwin[a]     the arc in the opposite direction, or -1 for a one-way road
 *   revStart / revArc → arcs *entering* a node (used for backwards search / preprocessing)
 *
 * The graph is treated as read-only by algorithms. All scenario conditions (traffic,
 * elevation, closures) are written into it once, before the benchmark starts.
 */

export const ROAD_CLASS = { LOCAL: 0, ARTERIAL: 1 };

export class Graph {
  /**
   * @param {number} nodeCount
   * @param {number} [edgeCapacity]
   */
  constructor(nodeCount, edgeCapacity = Math.max(16, nodeCount * 4)) {
    this.nodeCount = nodeCount;
    this.edgeCount = 0;

    // ---- nodes ----
    this.x = new Float64Array(nodeCount);
    this.y = new Float64Array(nodeCount);
    this.elevation = new Float64Array(nodeCount);

    // ---- edges ----
    this._cap = edgeCapacity;
    this.edgeFrom = new Int32Array(edgeCapacity);
    this.edgeTo = new Int32Array(edgeCapacity);
    this.edgeLength = new Float64Array(edgeCapacity);
    this.edgeSpeedLimit = new Float64Array(edgeCapacity); // m/s (free flow)
    this.edgeTraffic = new Float64Array(edgeCapacity);    // speed multiplier in (0, 1]
    this.edgeClosed = new Uint8Array(edgeCapacity);
    this.edgeClass = new Uint8Array(edgeCapacity);
    this.edgeDirected = new Uint8Array(edgeCapacity); // 1 = one-way (from → to only)

    // ---- CSR, filled by buildAdjacency() ----
    this.arcCount = 0;
    this.adjStart = null;
    this.adjTail = null;
    this.adjNeighbor = null;
    this.adjEdge = null;
    this.arcTwin = null;
    this.revStart = null;
    this.revArc = null;
  }

  /**
   * Add a road. Call `buildAdjacency()` once all edges exist.
   * @param {boolean} [directed] true for a one-way road (from → to only)
   * @returns {number} edge id
   */
  addEdge(from, to, length, speedLimit, roadClass = ROAD_CLASS.LOCAL, directed = false) {
    if (from === to) throw new Error('addEdge: self loops are not allowed');
    if (this.edgeCount === this._cap) this._growEdges();
    const e = this.edgeCount++;
    this.edgeFrom[e] = from;
    this.edgeTo[e] = to;
    this.edgeLength[e] = length;
    this.edgeSpeedLimit[e] = speedLimit;
    this.edgeTraffic[e] = 1;
    this.edgeClosed[e] = 0;
    this.edgeClass[e] = roadClass;
    this.edgeDirected[e] = directed ? 1 : 0;
    return e;
  }

  /** Number of roads incident to a node. */
  degree(u) {
    return this.adjStart === null ? 0 : this.adjStart[u + 1] - this.adjStart[u];
  }

  /**
   * Build the CSR adjacency (plus the reverse adjacency). Must be called after every
   * edge has been added and before any CostModel or algorithm runs.
   */
  buildAdjacency() {
    const n = this.nodeCount;
    const m = this.edgeCount;

    // Count out-arcs per node first so the CSR can be sized exactly.
    let total = 0;
    const adjStart = new Int32Array(n + 1);
    for (let e = 0; e < m; e++) {
      adjStart[this.edgeFrom[e] + 1]++;
      total++;
      if (this.edgeDirected[e] === 0) {
        adjStart[this.edgeTo[e] + 1]++;
        total++;
      }
    }
    for (let i = 0; i < n; i++) adjStart[i + 1] += adjStart[i];

    const cursor = new Int32Array(n);
    for (let i = 0; i < n; i++) cursor[i] = adjStart[i];

    const adjTail = new Int32Array(total);
    const adjNeighbor = new Int32Array(total);
    const adjEdge = new Int32Array(total);
    const arcTwin = new Int32Array(total).fill(-1);

    for (let e = 0; e < m; e++) {
      const u = this.edgeFrom[e];
      const v = this.edgeTo[e];
      const p = cursor[u]++;
      adjTail[p] = u; adjNeighbor[p] = v; adjEdge[p] = e;
      if (this.edgeDirected[e] === 0) {
        const q = cursor[v]++;
        adjTail[q] = v; adjNeighbor[q] = u; adjEdge[q] = e;
        arcTwin[p] = q;
        arcTwin[q] = p;
      }
    }

    // reverse adjacency: revArc[v] lists every arc whose head is v
    const revStart = new Int32Array(n + 1);
    for (let p = 0; p < total; p++) revStart[adjNeighbor[p] + 1]++;
    for (let i = 0; i < n; i++) revStart[i + 1] += revStart[i];

    const revCursor = new Int32Array(n);
    for (let i = 0; i < n; i++) revCursor[i] = revStart[i];

    const revArc = new Int32Array(total);
    for (let p = 0; p < total; p++) revArc[revCursor[adjNeighbor[p]]++] = p;

    this.arcCount = total;
    this.adjStart = adjStart;
    this.adjTail = adjTail;
    this.adjNeighbor = adjNeighbor;
    this.adjEdge = adjEdge;
    this.arcTwin = arcTwin;
    this.revStart = revStart;
    this.revArc = revArc;
  }

  /** Spatial bounding box plus elevation range. */
  bounds() {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minE = Infinity, maxE = -Infinity;
    for (let i = 0; i < this.nodeCount; i++) {
      const x = this.x[i], y = this.y[i], e = this.elevation[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (e < minE) minE = e;
      if (e > maxE) maxE = e;
    }
    if (!Number.isFinite(minX)) { minX = maxX = minY = maxY = 0; }
    if (!Number.isFinite(minE)) { minE = maxE = 0; }
    return { minX, maxX, minY, maxY, minE, maxE };
  }

  _growEdges() {
    const cap = this._cap * 2;
    const g = (src, Ctor) => { const a = new Ctor(cap); a.set(src); return a; };
    this.edgeFrom = g(this.edgeFrom, Int32Array);
    this.edgeTo = g(this.edgeTo, Int32Array);
    this.edgeLength = g(this.edgeLength, Float64Array);
    this.edgeSpeedLimit = g(this.edgeSpeedLimit, Float64Array);
    this.edgeTraffic = g(this.edgeTraffic, Float64Array);
    this.edgeClosed = g(this.edgeClosed, Uint8Array);
    this.edgeClass = g(this.edgeClass, Uint8Array);
    this.edgeDirected = g(this.edgeDirected, Uint8Array);
    this._cap = cap;
  }
}
