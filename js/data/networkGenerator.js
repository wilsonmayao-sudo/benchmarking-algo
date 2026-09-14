/**
 * Road-network generation.
 *
 * Produces a realistic-enough road network for solid-waste-collection routing:
 *   • topology     — jittered city grid, or an irregular "random" network
 *   • connectivity — Kruskal over candidate links guarantees every node is reachable
 *   • road classes — the longest roads become arterials (faster, less likely to be closed)
 *   • topography   — smooth gaussian hills + a linear trend, normalised to a peak-to-peak range
 *   • traffic      — per-road congestion factor plus urban congestion hotspots
 *   • closures     — weighted sampling that prefers closing minor roads
 *
 * Everything is driven by a seed, so a scenario can be reproduced exactly.
 */

import { Graph, ROAD_CLASS } from '../core/graph.js';
import { DSU } from '../core/dsu.js';
import { mulberry32, randInt, weightedSampleWithoutReplacement } from '../core/rng.js';

/** 40 km/h — residential collection streets. */
export const LOCAL_SPEED = 11.1;
/** 60 km/h — arterial roads. */
export const ARTERIAL_SPEED = 16.7;

export const DEFAULT_NETWORK = {
  type: 'grid',
  targetNodes: 6000,
  width: 6000,
  height: 4200,
  arterialRatio: 0.2,
  extraEdgeRatio: 0.1,
  jitter: 0.26,
  linkProbability: 0.88,
  seed: 1,
};

// ===========================================================================
//  Topology
// ===========================================================================

/**
 * @param {Partial<typeof DEFAULT_NETWORK>} options
 * @returns {Graph} a graph with positions, road classes and speed limits.
 *          `buildAdjacency()` still has to be called after elevation/traffic/closures.
 */
export function generateNetwork(options = {}) {
  const cfg = { ...DEFAULT_NETWORK, ...options };
  const rng = mulberry32(cfg.seed >>> 0 || 1);

  const layout = cfg.type === 'random' ? randomLayout(cfg, rng) : gridLayout(cfg, rng);
  return assemble(cfg, rng, layout);
}

/** Jittered rows × columns; every node has a well defined street address. */
function gridLayout(cfg, rng) {
  const cols = Math.max(2, Math.round(Math.sqrt(cfg.targetNodes * (cfg.width / cfg.height))));
  const rows = Math.max(2, Math.ceil(cfg.targetNodes / cols));
  const n = cols * rows;

  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const sx = cols > 1 ? cfg.width / (cols - 1) : cfg.width;
  const sy = rows > 1 ? cfg.height / (rows - 1) : cfg.height;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      xs[i] = clamp(c * sx + (rng() - 0.5) * sx * cfg.jitter, 0, cfg.width);
      ys[i] = clamp(r * sy + (rng() - 0.5) * sy * cfg.jitter, 0, cfg.height);
    }
  }

  // Candidate links: every horizontal and vertical neighbour.
  const cu = [];
  const cv = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (c + 1 < cols) { cu.push(i); cv.push(i + 1); }
      if (r + 1 < rows) { cu.push(i); cv.push(i + cols); }
    }
  }

  return {
    n, xs, ys,
    cu: Int32Array.from(cu),
    cv: Int32Array.from(cv),
    allOpen: false,
    shortcutRadius: Math.max(sx, sy) * 1.8,
  };
}

/** Irregular layout built by Poisson-style rejection sampling + k-nearest links. */
function randomLayout(cfg, rng) {
  const n = Math.max(8, cfg.targetNodes | 0);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);

  const minDist = Math.sqrt((cfg.width * cfg.height) / n) * 0.62;
  const cell = minDist;
  const gw = Math.max(1, Math.ceil(cfg.width / cell));
  const gh = Math.max(1, Math.ceil(cfg.height / cell));
  const occupied = new Int32Array(gw * gh).fill(-1);

  let placed = 0;
  let guard = n * 40;
  while (placed < n && guard-- > 0) {
    const x = rng() * cfg.width;
    const y = rng() * cfg.height;
    if (tooClose(xs, ys, placed, x, y, minDist, occupied, gw, gh, cell)) continue;
    xs[placed] = x;
    ys[placed] = y;
    occupied[cellIndex(x, y, gw, gh, cell)] = placed;
    placed++;
  }
  // Fallback: relax the spacing rule if the sampler could not fill the map.
  while (placed < n) {
    xs[placed] = rng() * cfg.width;
    ys[placed] = rng() * cfg.height;
    placed++;
  }

  // k-nearest-neighbour candidate links.
  const grid = buildSpatialGrid(xs, ys, n, cell, gw, gh);
  const k = 3;
  const seen = new Set();
  const cu = [];
  const cv = [];
  for (let i = 0; i < n; i++) {
    for (const j of kNearest(grid, xs, ys, i, k)) {
      if (i === j) continue;
      const key = i < j ? i * n + j : j * n + i;
      if (seen.has(key)) continue;
      seen.add(key);
      cu.push(i);
      cv.push(j);
    }
  }

  return {
    n, xs, ys,
    cu: Int32Array.from(cu),
    cv: Int32Array.from(cv),
    allOpen: true, // irregular networks keep every candidate link
    shortcutRadius: minDist * 3,
  };
}

/** Kruskal MST for connectivity, then the open links, then shortcuts. */
function assemble(cfg, rng, layout) {
  const { n, xs, ys, cu, cv } = layout;
  const nc = cu.length;

  const graph = new Graph(n, Math.max(32, n * 3));

  const clen = new Float64Array(nc);
  const open = new Uint8Array(nc);
  for (let i = 0; i < nc; i++) {
    const dx = xs[cu[i]] - xs[cv[i]];
    const dy = ys[cu[i]] - ys[cv[i]];
    clen[i] = Math.hypot(dx, dy);
    open[i] = layout.allOpen || rng() < cfg.linkProbability ? 1 : 0;
  }

  const dsu = new DSU(n);
  const order = Array.from({ length: nc }, (_, i) => i).sort((a, b) => clen[a] - clen[b]);
  const used = new Uint8Array(nc);
  let mstEdges = 0;
  for (const i of order) {
    if (dsu.union(cu[i], cv[i])) {
      used[i] = 1;
      mstEdges++;
    }
  }

  for (let i = 0; i < nc; i++) {
    const take = used[i] === 1 || open[i] === 1;
    if (!take) continue;
    graph.addEdge(cu[i], cv[i], clen[i], 0, ROAD_CLASS.LOCAL);
  }

  // A few extra short links so the network has loops instead of a pure tree.
  const existing = new Set();
  for (let e = 0; e < graph.edgeCount; e++) existing.add(edgeKey(graph.edgeFrom[e], graph.edgeTo[e], n));

  const targetExtra = Math.floor(cfg.extraEdgeRatio * Math.max(mstEdges, 1) * 2);
  const radius = layout.shortcutRadius;
  let extra = 0;
  let attempts = targetExtra * 40 + 100;
  while (extra < targetExtra && attempts-- > 0) {
    const a = randInt(rng, n);
    const b = randInt(rng, n);
    if (a === b) continue;
    const dx = xs[a] - xs[b];
    const dy = ys[a] - ys[b];
    const len = Math.hypot(dx, dy);
    if (len > radius || len < 1e-6) continue;
    const key = edgeKey(a, b, n);
    if (existing.has(key)) continue;
    existing.add(key);
    graph.addEdge(a, b, len, 0, ROAD_CLASS.LOCAL);
    extra++;
  }

  assignRoadClasses(graph, cfg.arterialRatio);

  for (let i = 0; i < n; i++) {
    graph.x[i] = xs[i];
    graph.y[i] = ys[i];
  }

  return graph;
}

/**
 * The longest `ratio` fraction of roads become arterials. Sorting by length gives a
 * deterministic, realistic trunk hierarchy without any extra bookkeeping.
 */
function assignRoadClasses(graph, arterialRatio) {
  const m = graph.edgeCount;
  if (m === 0) return;
  const ids = Array.from({ length: m }, (_, e) => e);
  ids.sort((a, b) => graph.edgeLength[b] - graph.edgeLength[a]);

  const arterialCount = Math.min(m, Math.max(0, Math.round(m * clamp(arterialRatio, 0, 1))));
  for (let i = 0; i < m; i++) {
    const e = ids[i];
    const isArterial = i < arterialCount;
    graph.edgeClass[e] = isArterial ? ROAD_CLASS.ARTERIAL : ROAD_CLASS.LOCAL;
    graph.edgeSpeedLimit[e] = isArterial ? ARTERIAL_SPEED : LOCAL_SPEED;
  }
}

// ===========================================================================
//  Topography
// ===========================================================================

export const DEFAULT_ELEVATION = { amplitude: 25, hills: 4, trend: 0.35, seed: 2 };

/**
 * Smooth terrain: a gentle linear slope plus gaussian hills, normalised so the
 * peak-to-peak difference equals `amplitude` metres.
 */
export function applyElevation(graph, options = {}) {
  const cfg = { ...DEFAULT_ELEVATION, ...options };
  const n = graph.nodeCount;
  if (n === 0) return graph;

  if (!(cfg.amplitude > 0)) {
    graph.elevation.fill(0);
    return graph;
  }

  const rng = mulberry32(cfg.seed >>> 0 || 2);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (graph.x[i] < minX) minX = graph.x[i];
    if (graph.x[i] > maxX) maxX = graph.x[i];
    if (graph.y[i] < minY) minY = graph.y[i];
    if (graph.y[i] > maxY) maxY = graph.y[i];
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const diag = Math.hypot(w, h);

  const hillCount = Math.max(0, cfg.hills | 0);
  const hx = new Float64Array(hillCount);
  const hy = new Float64Array(hillCount);
  const hh = new Float64Array(hillCount);
  const hs = new Float64Array(hillCount);
  for (let k = 0; k < hillCount; k++) {
    hx[k] = minX + rng() * w;
    hy[k] = minY + rng() * h;
    hh[k] = 0.35 + rng() * 0.65;
    hs[k] = diag * (0.06 + rng() * 0.16);
  }
  const trend = clamp(cfg.trend, -1, 1);

  const raw = new Float64Array(n);
  let rawMin = Infinity;
  let rawMax = -Infinity;

  for (let i = 0; i < n; i++) {
    const x = graph.x[i];
    const y = graph.y[i];
    let value = trend * (((x - minX) / w) * 0.6 + ((y - minY) / h) * 0.4);
    for (let k = 0; k < hillCount; k++) {
      const dx = x - hx[k];
      const dy = y - hy[k];
      const s = hs[k];
      value += hh[k] * Math.exp(-(dx * dx + dy * dy) / (2 * s * s));
    }
    raw[i] = value;
    if (value < rawMin) rawMin = value;
    if (value > rawMax) rawMax = value;
  }

  const span = rawMax - rawMin;
  const scale = span > 1e-9 ? cfg.amplitude / span : 0;
  for (let i = 0; i < n; i++) graph.elevation[i] = (raw[i] - rawMin) * scale;

  return graph;
}

// ===========================================================================
//  Traffic
// ===========================================================================

export const DEFAULT_TRAFFIC = { level: 0.05, hotspots: 2, radius: 0.22, seed: 3 };

/** Minimum speed multiplier — even the worst jam still creeps forward. */
export const MIN_TRAFFIC_FACTOR = 0.12;

/**
 * Writes a speed multiplier in [MIN_TRAFFIC_FACTOR, 1] on every road.
 * 1 = free flow. Hotspots model busy collection zones (markets, schools, dumps).
 */
export function applyTraffic(graph, options = {}) {
  const cfg = { ...DEFAULT_TRAFFIC, ...options };
  const m = graph.edgeCount;
  if (m === 0) return graph;

  const level = clamp(cfg.level, 0, 1);
  const rng = mulberry32(cfg.seed >>> 0 || 3);

  if (level <= 0) {
    graph.edgeTraffic.fill(1);
    return graph;
  }

  for (let e = 0; e < m; e++) {
    graph.edgeTraffic[e] = 1 - level * (0.55 + 0.45 * rng());
  }

  const hotspots = Math.max(0, cfg.hotspots | 0);
  if (hotspots > 0) {
    const n = graph.nodeCount;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      if (graph.x[i] < minX) minX = graph.x[i];
      if (graph.x[i] > maxX) maxX = graph.x[i];
      if (graph.y[i] < minY) minY = graph.y[i];
      if (graph.y[i] > maxY) maxY = graph.y[i];
    }
    const radius = clamp(cfg.radius, 0.02, 1) * Math.hypot(maxX - minX, maxY - minY);

    for (let k = 0; k < hotspots; k++) {
      const c = randInt(rng, n);
      const cx = graph.x[c];
      const cy = graph.y[c];
      for (let e = 0; e < m; e++) {
        const u = graph.edgeFrom[e];
        const v = graph.edgeTo[e];
        const d = Math.min(Math.hypot(graph.x[u] - cx, graph.y[u] - cy), Math.hypot(graph.x[v] - cx, graph.y[v] - cy));
        if (d >= radius) continue;
        const influence = 1 - d / radius; // strongest at the centre
        graph.edgeTraffic[e] *= 1 - 0.5 * level * influence;
      }
    }
  }

  for (let e = 0; e < m; e++) {
    graph.edgeTraffic[e] = clamp(graph.edgeTraffic[e], MIN_TRAFFIC_FACTOR, 1);
  }

  return graph;
}

// ===========================================================================
//  Road closures
// ===========================================================================

export const DEFAULT_CLOSURES = { count: 0, maxFraction: 0.25, seed: 4 };

/**
 * Closes `count` roads, preferring minor streets over arterials (roadworks and
 * collection-truck staging happen on residential roads far more often).
 */
export function applyClosures(graph, options = {}) {
  const cfg = { ...DEFAULT_CLOSURES, ...options };
  graph.edgeClosed.fill(0);

  const m = graph.edgeCount;
  if (m === 0) return graph;

  const limit = Math.floor(m * clamp(cfg.maxFraction, 0, 0.9));
  const count = Math.min(Math.max(0, cfg.count | 0), limit);
  if (count === 0) return graph;

  const rng = mulberry32(cfg.seed >>> 0 || 4);
  const weights = new Float64Array(m);
  for (let e = 0; e < m; e++) {
    weights[e] = graph.edgeClass[e] === ROAD_CLASS.ARTERIAL ? 0.35 : 1;
  }

  for (const e of weightedSampleWithoutReplacement(rng, weights, count)) {
    graph.edgeClosed[e] = 1;
  }

  return graph;
}

// ===========================================================================
//  Helpers
// ===========================================================================

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function edgeKey(u, v, n) {
  return u < v ? u * n + v : v * n + u;
}

function cellIndex(x, y, gw, gh, cell) {
  const c = Math.min(gw - 1, Math.max(0, Math.floor(x / cell)));
  const r = Math.min(gh - 1, Math.max(0, Math.floor(y / cell)));
  return r * gw + c;
}

/** Uniform-grid neighbour test, avoids an O(n²) rejection scan. */
function tooClose(xs, ys, placed, x, y, minDist, occupied, gw, gh, cell) {
  const c = Math.min(gw - 1, Math.max(0, Math.floor(x / cell)));
  const r = Math.min(gh - 1, Math.max(0, Math.floor(y / cell)));
  const d2 = minDist * minDist;
  for (let rr = Math.max(0, r - 1); rr <= Math.min(gh - 1, r + 1); rr++) {
    for (let cc = Math.max(0, c - 1); cc <= Math.min(gw - 1, c + 1); cc++) {
      const idx = occupied[rr * gw + cc];
      if (idx < 0) continue;
      const dx = xs[idx] - x;
      const dy = ys[idx] - y;
      if (dx * dx + dy * dy < d2) return true;
    }
  }
  return false;
}

/** CSR-style uniform grid over node positions. */
function buildSpatialGrid(xs, ys, n, cell, gw, gh) {
  const counts = new Int32Array(gw * gh);
  const gx = new Int32Array(n);
  const gy = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const c = Math.min(gw - 1, Math.max(0, Math.floor(xs[i] / cell)));
    const r = Math.min(gh - 1, Math.max(0, Math.floor(ys[i] / cell)));
    gx[i] = c;
    gy[i] = r;
    counts[r * gw + c]++;
  }
  const start = new Int32Array(gw * gh + 1);
  for (let i = 0; i < gw * gh; i++) start[i + 1] = start[i] + counts[i];
  const cursor = start.slice(0, gw * gh);
  const items = new Int32Array(n);
  for (let i = 0; i < n; i++) items[cursor[gy[i] * gw + gx[i]]++] = i;
  return { gw, gh, start, items, cell };
}

/** Approximate k-nearest lookup by expanding rings of grid cells. */
function kNearest(grid, xs, ys, i, k) {
  const { gw, gh, start, items, cell } = grid;
  const x = xs[i];
  const y = ys[i];
  const c = Math.min(gw - 1, Math.max(0, Math.floor(x / cell)));
  const r = Math.min(gh - 1, Math.max(0, Math.floor(y / cell)));

  const found = [];
  const maxRing = Math.max(gw, gh);

  for (let ring = 0; ring <= maxRing; ring++) {
    for (let rr = r - ring; rr <= r + ring; rr++) {
      if (rr < 0 || rr >= gh) continue;
      for (let cc = c - ring; cc <= c + ring; cc++) {
        if (cc < 0 || cc >= gw) continue;
        // only the perimeter of the ring is new
        const onPerimeter = Math.abs(rr - r) === ring || Math.abs(cc - c) === ring;
        if (!onPerimeter) continue;
        for (let p = start[rr * gw + cc], end = start[rr * gw + cc + 1]; p < end; p++) {
          const j = items[p];
          if (j !== i) found.push(j);
        }
      }
    }
    if (found.length >= k + 4) break; // ring far enough to trust the nearest-k
  }

  found.sort((a, b) => {
    const da = (xs[a] - x) ** 2 + (ys[a] - y) ** 2;
    const db = (xs[b] - x) ** 2 + (ys[b] - y) ** 2;
    return da - db;
  });
  return found.slice(0, k);
}
