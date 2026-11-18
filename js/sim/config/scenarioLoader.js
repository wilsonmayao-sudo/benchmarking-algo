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
import { parseCityMap, buildGraphFromMap, parseCsv } from '../../data/cityMapLoader.js';

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

const TRUCK_COLORS = [
  '#38bdf8', '#f472b6', '#a78bfa', '#fb923c', '#2dd4bf', '#facc15', '#f87171',
  '#4ade80', '#60a5fa', '#e879f9', '#fbbf24', '#34d399', '#c084fc', '#fda4af',
];

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
 *        overrides: { noEvents?, noRandomEvents?, truckCount?, seed?, randomEventCount?, eventSeed? }
 *        — CLI / UI variants. randomEventCount / eventSeed replace events.random.count / .seed.
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
  // Optional display names, e.g. "depot": {"lat":…, "lng":…, "name":"SWMO Motorpool"}.
  const depotName = (config.depot && config.depot.name) || 'DEPOT';
  const disposalName = (config.disposal && config.disposal.name) || 'DISPOSAL';

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
      areas: Array.isArray(t.areas) ? t.areas.map(String) : [], // schedule areas this truck covers
    };
  });
  const truckIds = new Set(trucks.map((t) => t.id));
  if (truckIds.size !== trucks.length) problems.push('trucks: duplicate truck id');
  // area_code → truck id, from each truck's "areas" (used to assign schedule stops)
  const areaTruck = new Map();
  for (const t of trucks) {
    for (const a of t.areas) {
      const key = a.trim().toUpperCase();
      if (areaTruck.has(key)) problems.push(`trucks: area ${a} is given to both ${areaTruck.get(key)} and ${t.id}`);
      else areaTruck.set(key, t.id);
    }
  }

  // ---------------------------------------------------------------- bins
  // Bins from an exported EcoLoop table (collection_schedules / bins CSV): read the file first.
  let csvRows = null;
  if (config.bins && !Array.isArray(config.bins) && config.bins.csv) {
    if (!io.readText) problems.push('bins.csv: needs a file reader');
    else {
      try { csvRows = parseCsv(await io.readText(config.bins.csv)); }
      catch (err) { problems.push(`bins.csv: could not read ${config.bins.csv} (${err.message})`); }
    }
  }
  const binImport = { report: null };
  const binsCfg = config.bins && config.bins.csv && overrides.binDay !== undefined
    ? { ...config.bins, day: overrides.binDay === 'all' ? undefined : overrides.binDay } // UI "Schedule day"
    : config.bins;
  const bins = buildBins(binsCfg, { graph, map, refs, settings, seed, depot, disposal, truckIds, problems, csvRows, binImport, areaTruck });

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
    geo: map.geo || null, // lat/lng projection (imported maps only) — used for the street-map layer
    depot,
    disposal,
    depotName,
    disposalName,
    binImport: binImport.report, // what the CSV import kept / skipped (null for other bin sources)
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
  if (!o.noEvents && !o.noRandomEvents && Number.isInteger(o.randomEventCount)) {
    parts.push(`${o.randomEventCount} random event${o.randomEventCount === 1 ? '' : 's'}`);
  }
  if (!o.noEvents && !o.noRandomEvents && o.eventSeed !== undefined) parts.push(`event seed ${o.eventSeed}`);
  if (o.seed !== undefined) parts.push(`seed ${o.seed}`);
  if (o.binDay !== undefined) parts.push(o.binDay === 'all' ? 'all schedule days' : `${o.binDay} schedule`);
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
    let text = await io.readText(mapCfg.path);
    if (Array.isArray(mapCfg.connectors) && mapCfg.connectors.length > 0) {
      text = addConnectorRoads(text, mapCfg.connectors, problems);
    }
    const { map } = parseCityMap([{ name: mapCfg.path.split('/').pop(), text }]);
    const graph = buildGraphFromMap(map);
    graph.buildAdjacency();
    return { ...finishIndexedMap(graph, 'geojson', map.mainComponent), geo: map.geo };
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

/**
 * Connector roads for places outside the road file (e.g. a landfill beyond the city map).
 * Each connector { "to": [lng, lat], "name"?, "maxspeed"? } becomes a straight GeoJSON
 * LineString from the nearest existing road vertex to `to`. Its length is the straight-line
 * distance, so it UNDER-estimates the real road distance — say so wherever results are used.
 */
function addConnectorRoads(text, connectors, problems) {
  let json;
  try { json = JSON.parse(text); } catch { problems.push('map.connectors: only GeoJSON road files support connectors'); return text; }
  if (!Array.isArray(json.features)) { problems.push('map.connectors: only GeoJSON road files support connectors'); return text; }

  const vertices = [];
  for (const f of json.features) {
    const g = f && f.geometry;
    if (!g) continue;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines) for (const c of line) vertices.push(c);
  }

  connectors.forEach((c, i) => {
    if (!Array.isArray(c.to) || c.to.length < 2 || !c.to.every(Number.isFinite)) {
      problems.push(`map.connectors[${i}]: "to" must be [lng, lat]`);
      return;
    }
    const [lng, lat] = c.to;
    const k = Math.cos((lat * Math.PI) / 180);
    let best = null;
    let bestD = Infinity;
    for (const v of vertices) {
      const d = ((v[0] - lng) * k) ** 2 + (v[1] - lat) ** 2;
      if (d < bestD) { bestD = d; best = v; }
    }
    if (!best) { problems.push(`map.connectors[${i}]: the road file has no vertices`); return; }
    json.features.push({
      type: 'Feature',
      properties: { name: c.name || 'connector', highway: 'primary', ...(c.maxspeed ? { maxspeed: String(c.maxspeed) } : {}) },
      geometry: { type: 'LineString', coordinates: [[best[0], best[1]], [lng, lat]] },
    });
  });
  return JSON.stringify(json);
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
    // {"lat":13.62,"lng":123.19} → nearest node; imported (GeoJSON / OSM / CSV) maps only.
    if (ref && Number.isFinite(ref.lat) && Number.isFinite(ref.lng)) {
      if (!map.geo) {
        problems.push(`${where}: lat/lng references need an imported map (map.type "geojson")`);
        return 0;
      }
      const g = map.geo;
      return nearest((ref.lng - g.minLon) * g.mPerLon, (ref.lat - g.minLat) * g.mPerLat);
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
  const { graph, map, refs, settings, seed, depot, disposal, truckIds, problems } = ctx;

  // Real stops: { "csv": "data/collection_schedules.csv", "day"?, "areas"?, ... }
  if (binsCfg && !Array.isArray(binsCfg) && binsCfg.csv) {
    if (!ctx.csvRows) return [];
    return buildBinsFromCsv(ctx.csvRows, binsCfg, ctx);
  }

  // Random placement: { "random": { count, seed?, fill:[min,max], capacity_kg? } }
  if (binsCfg && !Array.isArray(binsCfg) && binsCfg.random) {
    const r = binsCfg.random;
    const rng = mulberry32((r.seed ?? seed + 11) >>> 0);
    const pool = [];
    for (let i = 0; i < graph.nodeCount; i++) {
      if (i === depot || i === disposal) continue; // no bins at the depot or the landfill
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

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** "{Monday,Wednesday}" / '["Mon","Wed"]' / "Mon, Wed" → ['mon', 'wed'] (first 3 letters). */
function parseDays(value) {
  if (!value) return [];
  return String(value)
    .replace(/[{}[\]"]/g, '')
    .split(/[,;/|]+/)
    .map((d) => d.trim().toLowerCase().slice(0, 3))
    .filter(Boolean);
}

/**
 * Bins from a CSV exported from the EcoLoop database — either `collection_schedules`
 * (location_name, area_code, stop_order, stop_type, days_of_week, latitude, longitude, …)
 * or `bins` (code, location, area_code, schedule_days, capacity_percent, latitude, longitude, …).
 * Column names are matched case-insensitively; only latitude + longitude are required.
 *
 * Options (all optional):
 *   day         "Monday" — keep stops scheduled that day (days_of_week / schedule_days)
 *   areas       ["A1","B2"] — keep these area_code values
 *   stop_types  ["collection"] — keep these stop_type values (rows without one are kept)
 *   max_snap_m  300 — a stop farther than this from the nearest mapped road is skipped
 *                (the Naga road file covers the city centre only)
 *   fill        [30, 100] — fill % range for rows without capacity_percent (seeded random)
 *   seed        RNG seed for those fill values
 *
 * Every skipped row is counted by reason in world.binImport, so nothing disappears silently.
 */
function buildBinsFromCsv(rows, cfg, ctx) {
  const { graph, map, settings, seed, problems } = ctx;
  if (!map.geo) { problems.push('bins.csv: needs an imported map (map.type "geojson") to place lat/lng stops'); return []; }
  if (rows.length < 2) { problems.push(`bins.csv: ${cfg.csv} has no data rows`); return []; }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const c = {
    lat: col('latitude', 'lat'),
    lng: col('longitude', 'lng', 'lon'),
    name: col('location_name', 'location', 'name'),
    code: col('code', 'bin_code'),
    area: col('area_code', 'area'),
    order: col('stop_order'),
    type: col('stop_type'),
    days: col('days_of_week', 'schedule_days', 'days'),
    fill: col('capacity_percent', 'fill', 'fill_percent'),
    active: col('is_active'),
    barangay: col('barangay'),
  };
  if (c.lat < 0 || c.lng < 0) { problems.push(`bins.csv: ${cfg.csv} needs "latitude" and "longitude" columns`); return []; }

  const day = cfg.day ? String(cfg.day).trim().toLowerCase().slice(0, 3) : null;
  if (day && !DAY_NAMES.some((d) => d.startsWith(day))) problems.push(`bins.day: "${cfg.day}" is not a day of the week`);
  const areas = Array.isArray(cfg.areas) ? new Set(cfg.areas.map((a) => String(a).trim().toUpperCase())) : null;
  const stopTypes = new Set((cfg.stop_types || ['collection']).map((t) => String(t).trim().toLowerCase()));
  const maxSnap = cfg.max_snap_m ?? 300;
  const [fMin, fMax] = cfg.fill || [30, 100];
  const rng = mulberry32((cfg.seed ?? seed + 13) >>> 0);
  const g = map.geo;

  const report = {
    file: cfg.csv, rows: rows.length - 1, used: 0, fillFromFile: 0,
    skipped: { inactive: 0, stopType: {}, day: 0, area: 0, noCoordinates: 0, outsideRoadMap: 0 },
    maxSnapM: maxSnap, filters: { day: cfg.day || null, areas: cfg.areas || null },
  };
  const cell = (r, i) => (i >= 0 && r[i] !== undefined ? String(r[i]).trim() : '');
  const usedIds = new Set();
  const bins = [];

  for (const r of rows.slice(1)) {
    if (c.active >= 0 && /^(false|f|0|no)$/i.test(cell(r, c.active))) { report.skipped.inactive++; continue; }
    const type = cell(r, c.type).toLowerCase();
    if (type && !stopTypes.has(type)) { report.skipped.stopType[type] = (report.skipped.stopType[type] || 0) + 1; continue; }
    if (day && !parseDays(cell(r, c.days)).includes(day)) { report.skipped.day++; continue; }
    const area = cell(r, c.area);
    if (areas && !areas.has(area.toUpperCase())) { report.skipped.area++; continue; }
    const lat = Number(cell(r, c.lat));
    const lng = Number(cell(r, c.lng));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || cell(r, c.lat) === '' || (Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6)) {
      report.skipped.noCoordinates++; continue;
    }

    // nearest node in the main road component
    const x = (lng - g.minLon) * g.mPerLon;
    const y = (lat - g.minLat) * g.mPerLat;
    let node = -1;
    let best = Infinity;
    for (let i = 0; i < graph.nodeCount; i++) {
      if (map.allowed && map.allowed[i] !== 1) continue;
      if (i === ctx.depot || i === ctx.disposal) continue;
      const d = (graph.x[i] - x) ** 2 + (graph.y[i] - y) ** 2;
      if (d < best) { best = d; node = i; }
    }
    if (node < 0 || Math.sqrt(best) > maxSnap) { report.skipped.outsideRoadMap++; continue; }

    // id: bin code, else area + stop order, else running number — always unique
    let id = cell(r, c.code) || (area && cell(r, c.order) ? `${area}-${cell(r, c.order)}` : `B${bins.length + 1}`);
    for (let k = 2; usedIds.has(id); k++) id = `${id.replace(/~\d+$/, '')}~${k}`;
    usedIds.add(id);

    const fileFill = Number(cell(r, c.fill));
    const hasFill = cell(r, c.fill) !== '' && Number.isFinite(fileFill);
    if (hasFill) report.fillFromFile++;
    const label = cell(r, c.name) || cell(r, c.barangay) || id;
    // The truck covering this stop's area collects it (trucks[].areas); otherwise the
    // dispatcher auto-assigns it to the truck with the lowest ETA.
    const owner = cfg.assign_by_area !== false ? ctx.areaTruck?.get(area.toUpperCase()) : undefined;
    if (owner) report.assignedByArea = (report.assignedByArea || 0) + 1;
    bins.push(makeBin({
      id,
      name: label.length > 40 ? `${label.slice(0, 39)}…` : label,
      fill: hasFill ? Math.max(0, Math.min(100, Math.round(fileFill))) : Math.round(randRange(rng, fMin, fMax)),
      capacity_kg: cfg.capacity_kg,
      truck: owner,
      area: area || null,
    }, node, settings));
  }

  report.used = bins.length;
  ctx.binImport.report = report;
  if (bins.length === 0) {
    problems.push(`bins.csv: no usable stops in ${cfg.csv} after filters (${JSON.stringify(report.skipped)})`);
  }
  return bins;
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
    area: b.area ?? null,          // schedule area_code (CSV-imported bins only)
  };
}

// ===========================================================================
//  Events
// ===========================================================================

export const EVENT_TYPES = ['ROAD_CLOSURE', 'ROAD_REOPEN', 'TRAFFIC_DELAY'];

export const DEFAULT_RANDOM_EVENTS = {
  window_s: [0, 3600],
  types: { TRAFFIC_DELAY: 0.6, ROAD_CLOSURE: 0.4 },
  closure_duration_s: [300, 1200],
  delay_factor: [1.5, 3],
  delay_duration_s: [300, 1200],
};

/**
 * One random road event on a uniformly random road (`r` = events.random settings).
 * `time` is a number, or a function drawn after the type and road (the loader's original
 * draw order, so existing seeds keep producing the same events).
 * Shared by the loader (pre-generated events) and the UI's "random event now" button.
 */
export function randomRoadEvent(rng, graph, r, time) {
  const types = r.types || DEFAULT_RANDOM_EVENTS.types;
  const typeNames = Object.keys(types).filter((t) => EVENT_TYPES.includes(t) && t !== 'ROAD_REOPEN');
  const totalW = typeNames.reduce((s, t) => s + types[t], 0);
  let pickW = rng() * totalW;
  let type = typeNames[0];
  for (const t of typeNames) { pickW -= types[t]; if (pickW <= 0) { type = t; break; } }
  const edge = randInt(rng, graph.edgeCount);
  const at = typeof time === 'function' ? time() : time;
  if (type === 'ROAD_CLOSURE') {
    const [d0, d1] = r.closure_duration_s || DEFAULT_RANDOM_EVENTS.closure_duration_s;
    return { time: at, type, edge, duration: Math.round(randRange(rng, d0, d1)), source: 'random', note: '' };
  }
  const [f0, f1] = r.delay_factor || DEFAULT_RANDOM_EVENTS.delay_factor;
  const [d0, d1] = r.delay_duration_s || DEFAULT_RANDOM_EVENTS.delay_duration_s;
  return {
    time: at, type, edge,
    factor: Number(randRange(rng, f0, f1).toFixed(2)),
    duration: Math.round(randRange(rng, d0, d1)),
    source: 'random', note: '',
  };
}

function buildEvents(eventsCfg, ctx) {
  const { graph, refs, seed, problems, overrides } = ctx;
  const wantsRandom = Number.isInteger(overrides.randomEventCount) && overrides.randomEventCount > 0;
  if (overrides.noEvents || (!eventsCfg && !wantsRandom)) return [];
  eventsCfg = eventsCfg || {};

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
  const r = (!Array.isArray(eventsCfg) && eventsCfg.random) || (wantsRandom ? {} : null);
  if (r && (r.enabled !== false || wantsRandom) && !overrides.noRandomEvents) {
    const rng = mulberry32((overrides.eventSeed ?? r.seed ?? seed + 21) >>> 0);
    const [w0, w1] = r.window_s || DEFAULT_RANDOM_EVENTS.window_s;
    const count = Number.isInteger(overrides.randomEventCount) ? overrides.randomEventCount : (r.count || 0);
    for (let k = 0; k < count; k++) {
      out.push(randomRoadEvent(rng, graph, r, () => Math.round(randRange(rng, w0, w1))));
    }
  }
  return out;
}
