/**
 * Scenario loader — turns a JSON config into a ready-to-simulate "world".
 *
 * Nothing about a scenario is hard-coded in the simulator: the map, depot, bins, trucks
 * and events all come from the config. See `data/scenarios/README.md` for the full
 * schema and `data/scenarios/sample-fleet.json` for a working example.
 *
 * MAP SOURCES (config.map.type)
 *   "explicit"  — nodes [{id,x,y}] and edges [{id?,from,to,length?,oneway?}] in metres
 *   "generated" — the project's seeded road generator (config.map.network)
 *   "geojson"   — a GeoJSON / Overpass / CSV road file, read with the city-map importer
 *
 * NODE REFERENCES (depot, disposal, bin.node, truck.start)
 *   "C3"          node id (explicit maps)
 *   42            node index (any map)
 *   {"at":[fx,fy]} nearest node to a fractional position in the map's bounding box
 *                  (0,0 = bottom-left, 1,1 = top-right) — works on any map
 *
 * EDGE REFERENCES (events)
 *   "C3-D3"       edge id; ids default to "<from>-<to>" and match in either direction
 *   {"from":"C3","to":"D3"}   or   17 (edge index)
 *
 * The loader validates everything up front and throws ONE error listing every problem,
 * so a broken config fails loudly before the simulation starts.
 */

import { Graph } from '../../core/graph.js';
import { mulberry32, randInt, randRange, shuffle } from '../../core/rng.js';
import { generateNetwork } from '../../data/networkGenerator.js';
import { parseCityMap, buildGraphFromMap } from '../../data/cityMapLoader.js';

/** Defaults for every optional setting. Documented in data/scenarios/README.md. */
export const DEFAULT_SETTINGS = {
  heuristic: 'euclidean',      // 'euclidean' | 'manhattan'
  service_time_s: 60,          // time spent emptying one bin
  unload_time_s: 300,          // time spent unloading at the disposal site
  dt_s: 1,                     // simulation tick
  max_time_s: 6 * 3600,        // hard stop
  bin_capacity_kg: 120,        // load of a 100 %-full bin when a bin gives no capacity
  fill_thresholds: { medium: 40, high: 75 }, // % — green < medium ≤ yellow < high ≤ red
  visit_order: 'nearest',      // 'nearest' (greedy re-ordering) | 'given' (config order)
  return_to_depot: true,       // trucks drive back to the depot when their work is done
};

export const DEFAULT_TRUCK = { speed_kph: 25, max_capacity: 1000, current_load: 0 };

const TRUCK_COLORS = ['#38bdf8', '#f472b6', '#a78bfa', '#fb923c', '#2dd4bf', '#facc15', '#f87171', '#4ade80'];

export class ScenarioError extends Error {
  constructor(problems) {
    super(`Scenario config is invalid:\n  • ${problems.join('\n  • ')}`);
    this.problems = problems;
  }
}

/**
 * @param {object} config parsed JSON
 * @param {{readText?:(path:string)=>Promise<string>, overrides?:object}} [io]
 *        readText is needed only for map.type "geojson" (fetch in the browser, fs in Node).
 *        overrides: { noEvents?, noRandomEvents?, truckCount?, seed? } — CLI / UI variants.
 * @returns {Promise<object>} world
 */
export async function loadScenario(config, io = {}) {
  const problems = [];
  const overrides = io.overrides || {};
  if (!config || typeof config !== 'object') throw new ScenarioError(['config is not an object']);

  const settings = {
    ...DEFAULT_SETTINGS,
    ...(config.settings || {}),
    fill_thresholds: { ...DEFAULT_SETTINGS.fill_thresholds, ...((config.settings || {}).fill_thresholds || {}) },
  };
  const seed = (overrides.seed ?? config.seed ?? 1) >>> 0;

  // ---------------------------------------------------------------- map
  const map = await buildMap(config.map, io, problems);
  if (!map) throw new ScenarioError(problems);
  const { graph } = map;
  const refs = makeResolvers(map, problems);

  // ---------------------------------------------------------------- depot / disposal
  const depot = refs.node(config.depot ?? { at: [0.5, 0.5] }, 'depot');
  const disposal = config.disposal !== undefined ? refs.node(config.disposal, 'disposal') : depot;

  // ---------------------------------------------------------------- trucks
  let truckCfgs = Array.isArray(config.trucks) ? config.trucks : [];
  if (truckCfgs.length === 0) problems.push('trucks: at least one truck is required');
  if (Number.isInteger(overrides.truckCount) && overrides.truckCount > 0) {
    truckCfgs = truckCfgs.slice(0, overrides.truckCount);
  }
  const trucks = truckCfgs.map((t, i) => {
    const id = String(t.id ?? `T${i + 1}`);
    const merged = { ...DEFAULT_TRUCK, ...t };
    if (!(merged.speed_kph > 0)) problems.push(`truck ${id}: speed_kph must be > 0`);
    if (!(merged.max_capacity > 0)) problems.push(`truck ${id}: max_capacity must be > 0`);
    return {
      id,
      name: t.name || `Truck ${id.replace(/^T/i, '')}`,
      color: t.color || TRUCK_COLORS[i % TRUCK_COLORS.length],
      start: t.start !== undefined ? refs.node(t.start, `truck ${id}.start`) : depot,
      speed: merged.speed_kph / 3.6, // m/s
      speedKph: merged.speed_kph,
      maxCapacity: merged.max_capacity,
      currentLoad: merged.current_load || 0,
    };
  });
  const truckIds = new Set(trucks.map((t) => t.id));
  if (truckIds.size !== trucks.length) problems.push('trucks: duplicate truck id');

  // ---------------------------------------------------------------- bins
  const bins = buildBins(config.bins, { graph, map, refs, settings, seed, depot, truckIds, problems });

  // ---------------------------------------------------------------- events
  const events = buildEvents(config.events, { graph, refs, seed, problems, overrides });

  if (problems.length > 0) throw new ScenarioError(problems);

  return {
    name: config.name || 'Unnamed scenario',
    description: config.description || '',
    seed,
    graph,
    nodeLabel: map.nodeLabel,
    edgeLabel: map.edgeLabel,
    mapType: map.type,
    depot,
    disposal,
    trucks,
    bins,
    events,
    settings,
    variant: describeVariant(overrides),
  };
}

function describeVariant(o) {
  const parts = [];
  if (o.noEvents) parts.push('no events');
  else if (o.noRandomEvents) parts.push('scheduled events only');
  if (Number.isInteger(o.truckCount)) parts.push(`${o.truckCount} truck${o.truckCount === 1 ? "" : "s"}`);
  if (o.seed !== undefined) parts.push(`seed ${o.seed}`);
  return parts.length ? parts.join(', ') : 'as configured';
}

// ===========================================================================
//  Map
// ===========================================================================

async function buildMap(mapCfg, io, problems) {
  if (!mapCfg || typeof mapCfg !== 'object') {
    problems.push('map: missing (expected { "type": "explicit" | "generated" | "geojson", ... })');
    return null;
  }

  if (mapCfg.type === 'explicit') return buildExplicitMap(mapCfg, problems);

  if (mapCfg.type === 'generated') {
    const graph = generateNetwork({ targetNodes: 400, width: 3000, height: 2000, ...(mapCfg.network || {}) });
    graph.buildAdjacency();
    return finishIndexedMap(graph, 'generated', null);
  }

  if (mapCfg.type === 'geojson') {
    if (!io.readText) { problems.push('map: type "geojson" needs a file reader'); return null; }
    if (!mapCfg.path) { problems.push('map: type "geojson" needs a "path"'); return null; }
    const text = await io.readText(mapCfg.path);
    const { map } = parseCityMap([{ name: mapCfg.path.split('/').pop(), text }]);
    const graph = buildGraphFromMap(map);
    graph.buildAdjacency();
    return finishIndexedMap(graph, 'geojson', map.mainComponent);
  }

  problems.push(`map.type: unknown type "${mapCfg.type}"`);
  return null;
}

/** Hand-written graph: string node ids, optional edge ids, lengths derived from x/y. */
function buildExplicitMap(cfg, problems) {
  const nodes = Array.isArray(cfg.nodes) ? cfg.nodes : [];
  const edges = Array.isArray(cfg.edges) ? cfg.edges : [];
  if (nodes.length < 2) problems.push('map.nodes: need at least two nodes');

  const graph = new Graph(nodes.length, Math.max(16, edges.length + 4));
  const nodeIndex = new Map();
  nodes.forEach((node, i) => {
    const id = String(node.id);
    if (nodeIndex.has(id)) problems.push(`map.nodes: duplicate node id "${id}"`);
    nodeIndex.set(id, i);
    graph.x[i] = Number(node.x);
    graph.y[i] = Number(node.y);
  });

  const edgeIndex = new Map();
  const edgeIds = [];
  for (const edge of edges) {
    const u = nodeIndex.get(String(edge.from));
    const v = nodeIndex.get(String(edge.to));
    if (u === undefined || v === undefined) {
      problems.push(`map.edges: edge ${edge.id ?? `${edge.from}-${edge.to}`} references an unknown node`);
      continue;
    }
    const dx = graph.x[u] - graph.x[v];
    const dy = graph.y[u] - graph.y[v];
    const length = edge.length > 0 ? edge.length : Math.hypot(dx, dy);
    const e = graph.addEdge(u, v, length, 11.1, 0, !!edge.oneway);
    const id = String(edge.id ?? `${edge.from}-${edge.to}`);
    edgeIds[e] = id;
    edgeIndex.set(id, e);
    // Allow "B-A" as well as "A-B" when no explicit id was given.
    edgeIndex.set(`${edge.from}-${edge.to}`, e);
    if (!edge.oneway) edgeIndex.set(`${edge.to}-${edge.from}`, e);
  }
  graph.buildAdjacency();

  const nodeIds = nodes.map((n) => String(n.id));
  return {
    type: 'explicit',
    graph,
    allowed: null,
    nodeIndex,
    edgeIndex,
    nodeLabel: (i) => nodeIds[i] ?? String(i),
    edgeLabel: (e) => edgeIds[e] ?? `#${e}`,
  };
}

/** Generated / imported maps have no names: nodes and edges are referenced by index. */
function finishIndexedMap(graph, type, allowed) {
  return {
    type,
    graph,
    allowed,
    nodeIndex: null,
    edgeIndex: null,
    nodeLabel: (i) => `n${i}`,
    edgeLabel: (e) => `#${e} (n${graph.edgeFrom[e]}-n${graph.edgeTo[e]})`,
  };
}

/** Node / edge reference resolvers (see header for accepted forms). */
function makeResolvers(map, problems) {
  const { graph } = map;
  const b = graph.bounds();

  function nearest(x, y) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < graph.nodeCount; i++) {
      if (map.allowed && map.allowed[i] !== 1) continue;
      const d = (graph.x[i] - x) ** 2 + (graph.y[i] - y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function node(ref, where) {
    if (typeof ref === 'number' && Number.isInteger(ref) && ref >= 0 && ref < graph.nodeCount) return ref;
    if (typeof ref === 'string' && map.nodeIndex && map.nodeIndex.has(ref)) return map.nodeIndex.get(ref);
    if (ref && Array.isArray(ref.at) && ref.at.length === 2) {
      return nearest(b.minX + ref.at[0] * (b.maxX - b.minX), b.minY + ref.at[1] * (b.maxY - b.minY));
    }
    problems.push(`${where}: unknown node reference ${JSON.stringify(ref)}`);
    return 0;
  }

  function edge(ref, where) {
    if (typeof ref === 'number' && Number.isInteger(ref) && ref >= 0 && ref < graph.edgeCount) return ref;
    if (typeof ref === 'string' && map.edgeIndex && map.edgeIndex.has(ref)) return map.edgeIndex.get(ref);
    if (ref && ref.from !== undefined && ref.to !== undefined) {
      const u = node(ref.from, where);
      const v = node(ref.to, where);
      for (let e = 0; e < graph.edgeCount; e++) {
        const a = graph.edgeFrom[e], c = graph.edgeTo[e];
        if ((a === u && c === v) || (a === v && c === u)) return e;
      }
    }
    problems.push(`${where}: unknown edge reference ${JSON.stringify(ref)}`);
    return -1;
  }

  return { node, edge };
}

// ===========================================================================
//  Bins
// ===========================================================================

function buildBins(binsCfg, ctx) {
  const { graph, map, refs, settings, seed, depot, truckIds, problems } = ctx;

  // Random placement: { "random": { count, seed?, fill:[min,max], capacity_kg? } }
  if (binsCfg && !Array.isArray(binsCfg) && binsCfg.random) {
    const r = binsCfg.random;
    const rng = mulberry32((r.seed ?? seed + 11) >>> 0);
    const pool = [];
    for (let i = 0; i < graph.nodeCount; i++) {
      if (i === depot) continue;
      if (map.allowed && map.allowed[i] !== 1) continue;
      if (graph.degree(i) === 0) continue;
      pool.push(i);
    }
    shuffle(rng, pool);
    const [fMin, fMax] = r.fill || [10, 100];
    const count = Math.min(r.count || 15, pool.length);
    return Array.from({ length: count }, (_, k) => makeBin({
      id: `B${k + 1}`,
      node: pool[k],
      fill: Math.round(randRange(rng, fMin, fMax)),
      capacity_kg: r.capacity_kg,
    }, pool[k], settings));
  }

  if (!Array.isArray(binsCfg) || binsCfg.length === 0) {
    problems.push('bins: expected a non-empty array or { "random": { "count": N } }');
    return [];
  }

  const seen = new Set();
  return binsCfg.map((b, i) => {
    const id = String(b.id ?? `B${i + 1}`);
    if (seen.has(id)) problems.push(`bins: duplicate bin id "${id}"`);
    seen.add(id);
    if (b.fill !== undefined && !(b.fill >= 0 && b.fill <= 100)) problems.push(`bin ${id}: fill must be 0–100`);
    if (b.truck !== undefined && !truckIds.has(String(b.truck))) {
      // Not fatal when the CLI trimmed the fleet (truckCount) — the bin is auto-assigned.
      b = { ...b, truck: undefined };
    }
    return makeBin({ ...b, id }, refs.node(b.node, `bin ${id}`), settings);
  });
}

function makeBin(b, node, settings) {
  const capacity = b.capacity_kg ?? settings.bin_capacity_kg;
  const fill = b.fill ?? 50;
  return {
    id: String(b.id),
    name: b.name || `Bin ${String(b.id).replace(/^B/i, '')}`,
    node,
    fill,                         // 0–100 %
    capacityKg: capacity,
    load: (capacity * fill) / 100, // kg added to the truck when collected
    configTruck: b.truck !== undefined ? String(b.truck) : null,
    serviceTime: b.service_time_s ?? settings.service_time_s,
  };
}

// ===========================================================================
//  Events
// ===========================================================================

export const EVENT_TYPES = ['ROAD_CLOSURE', 'ROAD_REOPEN', 'TRAFFIC_DELAY'];

function buildEvents(eventsCfg, ctx) {
  const { graph, refs, seed, problems, overrides } = ctx;
  if (!eventsCfg || overrides.noEvents) return [];

  const out = [];
  const scheduled = Array.isArray(eventsCfg) ? eventsCfg : eventsCfg.scheduled || [];
  scheduled.forEach((ev, i) => {
    const where = `events.scheduled[${i}]`;
    if (!EVENT_TYPES.includes(ev.type)) { problems.push(`${where}: unknown type "${ev.type}"`); return; }
    if (!(ev.time_s >= 0)) { problems.push(`${where}: time_s must be ≥ 0`); return; }
    if (ev.type === 'TRAFFIC_DELAY' && !(ev.factor > 0)) { problems.push(`${where}: TRAFFIC_DELAY needs factor > 0`); return; }
    const edge = refs.edge(ev.edge, where);
    if (edge < 0) return;
    out.push({ time: ev.time_s, type: ev.type, edge, factor: ev.factor, duration: ev.duration_s, source: 'schedule', note: ev.note || '' });
  });

  // Random events are generated up front from a seed, so a "random" run is reproducible.
  const r = !Array.isArray(eventsCfg) && eventsCfg.random;
  if (r && r.enabled !== false && !overrides.noRandomEvents) {
    const rng = mulberry32((r.seed ?? seed + 21) >>> 0);
    const [w0, w1] = r.window_s || [0, 3600];
    const types = r.types || { TRAFFIC_DELAY: 0.6, ROAD_CLOSURE: 0.4 };
    const typeNames = Object.keys(types).filter((t) => EVENT_TYPES.includes(t) && t !== 'ROAD_REOPEN');
    const totalW = typeNames.reduce((s, t) => s + types[t], 0);
    for (let k = 0; k < (r.count || 0); k++) {
      let pickW = rng() * totalW;
      let type = typeNames[0];
      for (const t of typeNames) { pickW -= types[t]; if (pickW <= 0) { type = t; break; } }
      const edge = randInt(rng, graph.edgeCount);
      const time = Math.round(randRange(rng, w0, w1));
      if (type === 'ROAD_CLOSURE') {
        const [d0, d1] = r.closure_duration_s || [300, 1200];
        out.push({ time, type, edge, duration: Math.round(randRange(rng, d0, d1)), source: 'random', note: '' });
      } else {
        const [f0, f1] = r.delay_factor || [1.5, 3];
        const [d0, d1] = r.delay_duration_s || [300, 1200];
        out.push({
          time, type, edge,
          factor: Number(randRange(rng, f0, f1).toFixed(2)),
          duration: Math.round(randRange(rng, d0, d1)),
          source: 'random', note: '',
        });
      }
    }
  }
  return out;
}
