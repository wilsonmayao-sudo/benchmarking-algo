#!/usr/bin/env node
/**
 * Builds OSM-grounded, street- and subdivision-bounded service polygons for each
 * SWMO collection area in Naga City (`data/naga_schedule_areas.geojson`).
 *
 * Evidence tiers per scheduled collection stop (zero fabricated coordinates):
 *   Tier A: Local OSM streets in `data/Naga_City_boundary_roads.geojson`
 *   Tier B: Live OSM Nominatim / Photon geocoding constrained inside Naga City
 *           and within 350 m of the scheduled barangay + token verification
 *   Tier C: Fallback to the verified CSV stop coordinate (flagged for review)
 *
 * Usage: node tools/build_schedule_areas.mjs [--offline]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = new URL('../', import.meta.url).href;
const readText = async (p) => readFileSync(join(root, p), 'utf8');

const { loadScenario } = await import(R + 'js/sim/config/scenarioLoader.js');
const { parseCsv } = await import(R + 'js/data/cityMapLoader.js');
const { pointInPolygon, polygonArea, selfCrosses } = await import(R + 'js/sim/fleet/routeAreas.js');
const A = await import(R + 'js/fleetui/areas.js');

const OFFLINE = process.argv.includes('--offline');

// ------------------------------------------------------------------ load data
const cfg = JSON.parse(await readText('data/scenarios/naga-swmo-schedule.json'));
const world = await loadScenario(cfg, { readText, overrides: { noEvents: true } });
const { geo } = world;
const toXY = (ll) => A.toXY(geo, ll);
const toLngLat = (xy) => A.toLngLat(geo, xy);

const roadsGeo = JSON.parse(await readText('data/Naga_City_boundary_roads.geojson'));
const bordersGeo = JSON.parse(await readText('data/naga_areas.geojson'));
const borders = A.boundaryZones(bordersGeo, geo);
const cityZone = borders.find((z) => z.kind === 'city');
const brgyZones = borders.filter((z) => z.kind === 'barangay');

const normKey = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

const brgyByKey = new Map(brgyZones.map((z) => [normKey(z.name), z]));

// ------------------------------------------------------------------ geometry helpers
function distSqPointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return (px - ax) * (px - ax) + (py - ay) * (py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx, cy = ay + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

function minDistToPolygon(zone, x, y) {
  if (!zone) return Infinity;
  if (A.inZone(zone, x, y)) return 0;
  let best = Infinity;
  for (const r of zone.rings) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      const d2 = distSqPointToSegment(x, y, a[0], a[1], b[0], b[1]);
      if (d2 < best) best = d2;
    }
  }
  return Math.sqrt(best);
}

function rdpSimplify(pts, tol) {
  if (pts.length <= 4 || tol <= 0) return pts.slice();
  const closed = pts.slice();
  // Use perpendicular distance from line AB
  const keep = new Uint8Array(closed.length);
  keep[0] = 1;
  keep[closed.length - 1] = 1;
  const stack = [[0, closed.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s < 2) continue;
    let maxD2 = 0, idx = -1;
    const [ax, ay] = closed[s], [bx, by] = closed[e];
    for (let i = s + 1; i < e; i++) {
      const d2 = distSqPointToSegment(closed[i][0], closed[i][1], ax, ay, bx, by);
      if (d2 > maxD2) { maxD2 = d2; idx = i; }
    }
    if (maxD2 > tol2 && idx !== -1) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out = [];
  for (let i = 0; i < closed.length; i++) if (keep[i]) out.push(closed[i]);
  return out.length >= 3 ? out : pts.slice();
}

function signedArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return 0.5 * s;
}

function smoothRing(ring) {
  if (ring.length < 6) return ring.slice();
  return ring.map((_, i) => {
    const prev = ring[(i - 1 + ring.length) % ring.length];
    const curr = ring[i];
    const next = ring[(i + 1) % ring.length];
    return [
      0.25 * prev[0] + 0.5 * curr[0] + 0.25 * next[0],
      0.25 * prev[1] + 0.5 * curr[1] + 0.25 * next[1],
    ];
  });
}

function nearCity(x, y, step = 30) {
  return A.inZone(cityZone, x, y) ||
    A.inZone(cityZone, x + step, y) || A.inZone(cityZone, x - step, y) ||
    A.inZone(cityZone, x, y + step) || A.inZone(cityZone, x, y - step);
}

// ------------------------------------------------------------------ Undirected road graph for natural corridors
const { graph: roadGraph, allowed: roadAllowed } = world;
const roadAdj = Array.from({ length: roadGraph.nodeCount }, () => []);
for (let e = 0; e < roadGraph.edgeCount; e++) {
  const u = roadGraph.edgeFrom[e];
  const v = roadGraph.edgeTo[e];
  if (roadAllowed && (!roadAllowed[u] || !roadAllowed[v])) continue;
  const len = roadGraph.edgeLength[e] || Math.hypot(roadGraph.x[v] - roadGraph.x[u], roadGraph.y[v] - roadGraph.y[u]);
  const midX = 0.5 * (roadGraph.x[u] + roadGraph.x[v]);
  const midY = 0.5 * (roadGraph.y[u] + roadGraph.y[v]);
  roadAdj[u].push({ to: v, len, midX, midY });
  roadAdj[v].push({ to: u, len, midX, midY });
}
const allowedNodes = [];
for (let i = 0; i < roadGraph.nodeCount; i++) {
  if ((!roadAllowed || roadAllowed[i]) && roadAdj[i].length > 0) allowedNodes.push(i);
}

function nearestRoadNode(x, y) {
  let best = -1, bestD2 = Infinity;
  for (const i of allowedNodes) {
    const dx = roadGraph.x[i] - x, dy = roadGraph.y[i] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return best;
}

function shortestRoadPath(start, goal, scheduledBrgys) {
  if (start < 0 || goal < 0) return [];
  if (start === goal) return [[roadGraph.x[start], roadGraph.y[start]]];
  const gx = roadGraph.x, gy = roadGraph.y;
  const goalX = gx[goal], goalY = gy[goal];
  const gScore = new Float64Array(roadGraph.nodeCount).fill(Infinity);
  const parent = new Int32Array(roadGraph.nodeCount).fill(-1);
  const closedSet = new Uint8Array(roadGraph.nodeCount);
  const heap = [];
  const push = (node, f) => {
    heap.push({ node, f });
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].f <= heap[i].f) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        let best = i, l = 2 * i + 1, r = 2 * i + 2;
        if (l < heap.length && heap[l].f < heap[best].f) best = l;
        if (r < heap.length && heap[r].f < heap[best].f) best = r;
        if (best === i) break;
        [heap[i], heap[best]] = [heap[best], heap[i]];
        i = best;
      }
    }
    return top;
  };

  gScore[start] = 0;
  push(start, 0.65 * Math.hypot(goalX - gx[start], goalY - gy[start]));
  while (heap.length) {
    const { node: u } = pop();
    if (closedSet[u]) continue;
    closedSet[u] = 1;
    if (u === goal) {
      const pts = [];
      for (let cur = goal; cur !== -1; cur = parent[cur]) pts.push([gx[cur], gy[cur]]);
      pts.reverse();
      return pts;
    }
    for (const edge of roadAdj[u]) {
      const v = edge.to;
      if (closedSet[v]) continue;
      const inBrgy = scheduledBrgys.length > 0 && scheduledBrgys.some((bg) => A.inZone(bg, edge.midX, edge.midY));
      const w = edge.len * (inBrgy ? 0.65 : 1.0);
      const cand = gScore[u] + w;
      if (cand < gScore[v]) {
        gScore[v] = cand;
        parent[v] = u;
        push(v, cand + 0.65 * Math.hypot(goalX - gx[v], goalY - gy[v]));
      }
    }
  }
  return [[gx[start], gy[start]], [goalX, goalY]];
}

// ------------------------------------------------------------------ Tier A index
const ARTERIAL_NAMES = new Set([
  'Maharlika Highway', 'Almeda Highway', 'Almeda Avenue', 'Roxas Avenue',
  'Panganiban Drive', 'Magsaysay Avenue', 'Peñafrancia Avenue',
  'Balatas-Cararayan Road', 'Del Rosario - Cararayan Road', 'Cararayan-San Isidro Road',
  'San Felipe-Pacol-Carolina-Panicuason Road', 'Pacol Road', 'San Isidro - Carolina Road',
  'Mabolo Road', 'Mabolo-Gainza Road', 'Calabanga Road', 'Ninoy and Cory Avenue',
]);

const ALIASES = [
  [/\bgen\.?\s*luna\b/i, ['General Luna Street']],
  [/\be\.?\s*angeles\b|\bangeles\s*st/i, ['Elias Angeles Street']],
  [/\bp\.?\s*burgos\b/i, ['P. Burgos Street']],
  [/\bp\.?\s*diaz\b/i, ['P. Diaz Street']],
  [/\bp\.?\s*santos\b/i, ['Pedro Santos Street', 'Pedro Santos Avenue']],
  [/\bj\.?\s*hernandez\b/i, ['J. Hernandez Avenue']],
  [/\bj\.?\s*miranda\b/i, ['J. Miranda Avenue', 'Juan Miranda Avenue']],
  [/\bvillanueva\b/i, ['M. T. Villanueva Avenue']],
  [/\bapo\s*dr/i, ['Apo Drive']],
  [/\babecdy\b/i, ['Abe Dy Street']],
  [/\bavocado\b/i, ['Abocado Street']],
  [/\bmacopa\b/i, ['Makopa Street']],
  [/\bmanga\b/i, ['Manga Street', 'Mangga Street']],
  [/\bcaimeto\b/i, ['Caimito Street']],
  [/\bsampalok\b/i, ['Sampaloc Street']],
  [/\bsantoja\b|\bsantonja\b/i, ['Santonja Street']],
  [/\bdalia\b/i, ['Dahlia Street']],
  [/\bboning\s*sia\b/i, ['Boning Sia Sr. Street']],
  [/\bninoy\s*cory\b/i, ['Ninoy and Cory Avenue']],
  [/\braul\s*roco\b/i, ['Sen. Raul S. Roco Street']],
  [/\bramon\s*felipe\b/i, ['Ramon Felipe Jr. Street']],
  [/\bp\.?\s*n\.?\s*r\.?\b|\bpb?nr\b|\brelis\b/i, ['PNR Road', 'Railroad Street']],
  [/\bsm\s*(compound|concentrix|city)?\b/i, ['SM City Naga Road']],
  [/\brobinson/i, ['Robinsons Place Naga Road']],
  [/\bscience\s*high/i, ['Naga City Science HS Road']],
  [/\bcity\s*hall\b/i, ['City Hall Loop']],
  [/\bgeneral\s*hospital\b/i, ['Hospital Loop Road', 'Balatas-Cararayan Road']],
  [/\bjolly\s*neighbor/i, ['Jolly Neighbors Street']],
  [/\bvilla\s*francia\b/i, ['Villafrancia Street']],
  [/\bvilla\s*grande\b|\bvgh\b|\br\.?f\.?\s*pula\b/i, ['Villagrande Avenue', 'Villagrande Avenue Extension']],
  [/\bmonte\s*cielo\b/i, ['Avenida de Monte Cielo']],
  [/\bst\.?\s*jude\b/i, ['Saint Jude Drive', 'Saint Jude Street']],
  [/\bdau\s*st/i, ['Dau Street', 'Dao Street']],
  [/\bmarupit\b/i, ['Bagumbayan Marupit Road']],
  [/\bcapilihan\b/i, ['Capilihan Street']],
  [/\bgrand\s*view\b/i, ['Grandview Avenue']],
  [/\bdiversion\b|\broxas\b/i, ['Roxas Avenue']],
  [/\bc-?5\b|\balmeda\b/i, ['Almeda Highway', 'Almeda Avenue']],
  [/\bconcepcion\s*(peque|grande|highway)|con\.?\s*grande\s*highway|\bmaharlika\b/i, ['Maharlika Highway']],
  [/\btarusanan|gainza\b/i, ['Mabolo-Gainza Road']],
  [/\bseton\b/i, ['Seton Road']],
  [/\blcc\s*sabang\b/i, ['LCC Road']],
  [/\bf\.?\s*imperial\b/i, ['M. Imperial Street']],
  [/\bbalatas\s*(main\s*road|road|schools|zone)/i, ['Balatas-Cararayan Road']],
  [/\bcararayan\b/i, ['Balatas-Cararayan Road', 'Del Rosario - Cararayan Road', 'Cararayan-San Isidro Road']],
  [/\bsan\s*felipe\s*main/i, ['San Felipe-Pacol-Carolina-Panicuason Road']],
  [/\bpacol\b/i, ['Pacol Road', 'San Felipe-Pacol-Carolina-Panicuason Road']],
  [/\bcarolina\b/i, ['San Felipe-Pacol-Carolina-Panicuason Road', 'San Isidro - Carolina Road']],
  [/\bpanicuason\b/i, ['San Felipe-Pacol-Carolina-Panicuason Road']],
  [/\bsan\s*isidro\b/i, ['San Isidro - Carolina Road', 'Cararayan-San Isidro Road']],
  [/\bnaga\s*central\b/i, ['Naga Central Road']],
  [/\blong?ban\s*2\b|\blooban\b/i, ['Looban 1']],
  [/\bdel\s*rosario\s*main/i, ['Maharlika Highway', 'Del Rosario Street']],
  [/\bsan\s*miguel\b/i, ['San Miguel Street']],
  [/\bcatmon\b/i, ['Catmon Street', 'Catmon I', 'Catmon II']],
  [/\bplaza\s*quezon\b/i, ['Elias Angeles Street', 'P. Burgos Street']],
  [/\bmabolo\s*(main|up\s*to)/i, ['Mabolo Road', 'Maharlika Highway']],
  [/\btabuc/i, ['Zamora Street', 'Prieto Street', 'PNR Road']],
  [/\bdel\s*pilar\b/i, ['Del Pilar Street']],
  [/\bfelix\s*plazo\b/i, ['Felix Plazo Street']],
  [/\bbarlin\b/i, ['Barlin Street']],
  [/\bdimasalang\b/i, ['Dimasalang Street']],
  [/\bpenafrancia\b/i, ['Peñafrancia Avenue']],
  [/\bpanganiban\b/i, ['Panganiban Drive', 'J. Panganiban Street']],
  [/\bmagsaysay\b/i, ['Magsaysay Avenue']],
  [/\bmayon\b/i, ['Mayon Avenue', 'Mayon Extension']],
  [/\btaal\b/i, ['Taal Avenue']],
  [/\bbonifacio\b/i, ['Bonifacio Street']],
  [/\bpeninsula\b/i, ['Peninsula Street']],
  [/\bkayanga\b/i, ['Kayanga Road', 'Kayangga Street']],
  [/\bgreenfield\b/i, ['Greenland Drive']],
  [/\bsanto\s*st\b/i, ['Santo Niño Street', 'Sto. Niño Street']],
  [/\bsan\s*francisco\b/i, ['San Francisco Street']],
  [/\bcokeville\b/i, ['Cokeville Road']],
  [/\ber\s*luna\b/i, ['General Luna Street']],
  [/\banciano\b/i, ['Crescenciana Anciano Street']],
  [/\bsta\.?\s*cruz\s*(proper|main)|urban\s*sta\.?\s*cruz|\bproper\s*(street|sta\.?\s*cruz)\b/i, ['Santa Cruz Street']],
  [/\bramaida\b/i, ['Aida Street']],
  [/\bvilla\s*corazon\b/i, ['Corazon Road', 'Corazon Street']],
  [/\bbasilica\b/i, ['Basilica Road', 'Basilica Loop']],
  [/\bzone\s*[56]\s*balatas\b/i, ['Balatas-Cararayan Road']],
  [/\bcathedral\b/i, ['Cathedral Street', 'Elias Angeles Street']],
  [/\bcbd\s*(terminal|i|area)|\bbicol\s*central|\bvan\s*terminal/i, ['Ninoy and Cory Avenue', 'Boning Sia Sr. Street']],
  [/\bvilla\s*caceres|\bbigg'?s\s*magsaysay|\bavenue\s*plaza/i, ['Magsaysay Avenue']],
  [/\bdayangdang\b/i, ['Dayangdang Street']],
  [/\btinago\b/i, ['M. Castro Street', 'Blumentritt Street', 'Panganiban Drive']],
  [/\bsabang\b/i, ['Zamora Street', 'LCC Road']],
  [/\bliboton\b/i, ['Acacia Street', 'Molave Street', 'Narra Street']],
  [/\bbagumbayan\b/i, ['Bagumbayan Street']],
  [/\bcalauag\b/i, ['Calauag Street']],
  [/\bigualdad\b/i, ['Igualdad Interior', 'J. Hernandez Avenue']],
  [/\babella\b/i, ['Abella Street']],
  [/\bdinaga\b/i, ['Dinaga Street']],
  [/\bmabolo\b/i, ['Mabolo Road', 'Mabolo-Gainza Road']],
];

const normRoadToken = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\b(street|st\.?|avenue|ave\.?|road|rd\.?|drive|dr\.?|extension|ext\.?|boulevard|blvd\.?|highway|hwy\.?|sr\.?|jr\.?|ii|2|i|1)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

const osmRoadsByName = new Map();
const osmRoadsByNorm = new Map();
for (const f of roadsGeo.features) {
  const name = f.properties?.name?.trim();
  if (!name || !f.geometry?.coordinates?.length) continue;
  const xyPts = f.geometry.coordinates.map(toXY);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of xyPts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const mid = xyPts[Math.floor(xyPts.length / 2)];
  const seg = { name, arterial: ARTERIAL_NAMES.has(name), pts: xyPts, mid, bbox: { minX, maxX, minY, maxY } };
  if (!osmRoadsByName.has(name)) osmRoadsByName.set(name, []);
  osmRoadsByName.get(name).push(seg);
  const k = normRoadToken(name);
  if (k.length >= 4) {
    if (!osmRoadsByNorm.has(k)) osmRoadsByNorm.set(k, new Set());
    osmRoadsByNorm.get(k).add(name);
  }
}

function matchTierA(stop) {
  const cleanLoc = stop.loc.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const ln = normRoadToken(stop.loc);
  const candidateNames = new Set();

  for (const [re, names] of ALIASES) {
    if (re.test(cleanLoc)) {
      for (const nm of names) if (osmRoadsByName.has(nm)) candidateNames.add(nm);
    }
  }
  for (const [k, names] of osmRoadsByNorm.entries()) {
    if (ln.includes(k)) {
      for (const nm of names) candidateNames.add(nm);
    }
  }
  if (candidateNames.size === 0) return null;

  const bz = brgyByKey.get(stop.brgyKey);
  const segments = [];
  const matchedStreets = new Set();

  for (const name of candidateNames) {
    const segs = osmRoadsByName.get(name) || [];
    const near150 = bz
      ? segs.filter((seg) => seg.pts.some(([px, py]) => minDistToPolygon(bz, px, py) <= 150))
      : segs;
    if (near150.length > 0) {
      matchedStreets.add(name);
      segments.push(...near150);
    } else if (bz && !segs.some((s) => s.arterial)) {
      // Unique local street fallback within 300 m of barangay
      const near300 = segs.filter((seg) => seg.pts.some(([px, py]) => minDistToPolygon(bz, px, py) <= 300));
      if (near300.length > 0) {
        matchedStreets.add(name);
        segments.push(...near300);
      }
    }
  }
  return segments.length ? { streets: [...matchedStreets], segments } : null;
}

// ------------------------------------------------------------------ Tier B geocoding
const STOPWORDS = new Set([
  'naga', 'city', 'street', 'road', 'avenue', 'drive', 'subdivision', 'subd', 'village',
  'homes', 'compound', 'main', 'mainline', 'mainroad', 'barangay', 'camarines', 'sur',
  'philippines', 'phase', 'zone', 'pick', 'pickup', 'proceed', 'back', 'left', 'right',
  'straight', 'ahead', 'route', 'going', 'return', 'turn', 'area', 'boundary', 'proper',
  'interior', 'interiors', 'elementary', 'school', 'high', 'national', 'waiting', 'shed',
]);

function distinctiveTokens(text) {
  return normKey(text)
    .split(' ')
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

function cleanPlaceQuery(loc) {
  let q = loc
    .replace(/^(starting point( at)?|proceed( left| right)?( to)?|back( left| right)?( to)?|straight( ahead)?( to)?|go(ing)?( to)?|return( back)?( to)?|up( to)?|pick[\s-]*up|left( back)?( to)?|right( back)?( to)?|u-turn back( to)?|corner)\s+/i, '')
    .replace(/\bsubd\.?\b/gi, 'Subdivision')
    .replace(/\bvill\.?\b/gi, 'Village')
    .replace(/\bcomp\.?\b/gi, 'Compound')
    .replace(/\belem\.?\b/gi, 'Elementary')
    .replace(/\bhs\b/gi, 'High School')
    .replace(/\bbrgy\.?\b/gi, '')
    .replace(/["“”()/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return q;
}

const KNOWN_QUERY_EXPAND = [
  [/\bBMC\b/i, 'Bicol Medical Center'],
  [/\bBFP\b/i, 'Bureau of Fire Protection Naga'],
  [/\bNBI\b/i, 'National Bureau of Investigation'],
  [/\bUSI\b/i, 'Universidad de Santa Isabel'],
  [/\bNCF\b/i, 'Naga College Foundation'],
  [/\bUNC\b/i, 'University of Nueva Caceres'],
  [/\bBISCAST\b/i, 'SEAUTech'],
  [/\bNICC\b/i, 'NICC Doctors Hospital'],
  [/\bNCSAT\b/i, 'Naga College of Science and Technology'],
  [/\bS&R\b/i, 'S&R Membership Shopping Naga'],
  [/\bBCDC\b/i, 'Bicol Central Station Naga'],
  [/\bNCPM\b/i, 'Naga City People Mall'],
  [/\bBJMP\b/i, 'BJMP Naga'],
  [/\bj\.?m\.?r\.?\s*col+e?seum\b/i, 'Jesse M. Robredo Coliseum'],
  [/\bsaint\s*joseph\s*school\b/i, 'Saint Joseph School'],
  [/\bhope\s*christian\s*school\b/i, 'Hope Christian School'],
  [/\bbangko\s*central\b/i, 'Bangko Sentral ng Pilipinas'],
  [/\bsugo\s*hotel\b/i, 'Hotel Sogo'],
  [/\bsan\s*francisco\s*church\b/i, 'Parish of St. Francis of Assisi'],
  [/\bhacienda\s*de\s*naga\b/i, 'Haciendas de Naga'],
  [/\byashano\b/i, 'Yashano Mall'],
  [/\buma\s*residence\b/i, 'Uma Hotel'],
  [/\bcentral\s*i\s*and\s*ii\b/i, 'Naga Central School'],
  [/\bvistanza\b|\benvira\s*deca\b/i, 'Deca Homes Vistansa'],
  [/\bDeca\s*(I|II|III|6)\b/i, 'Deca Homes Naga'],
  [/\bDeca\s*northfield\b/i, 'Deca Homes'],
  [/\bvilla\s*karangahan\b/i, 'Villa Karangahan'],
  [/\bvilla\s*obiedo\b/i, 'Villa Obiedo'],
  [/\bmcdonalds\b/i, "McDonald's"],
  [/\bjollibee\b/i, 'Jollibee'],
  [/\bgawad\s*kalinga\b/i, 'Gawad Kalinga Balatas'],
  [/\boragon\s*statue\b/i, 'Oragon Monument'],
  [/\bsaint\s*peter\s*chapel\b/i, 'St. Peter Chapels'],
  [/\barchdiocese\s*of\s*caceres\b/i, 'Archdiocese of Caceres'],
  [/\bdo[ñn]a\s*conchita\b/i, 'Doña Conchita'],
  [/\bparkview\b/i, 'Parkview'],
  [/\bvilla\s*sorabella\b/i, 'Villa Sorabella'],
  [/\bcamella\b/i, 'Camella'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const geoCache = new Map();

function verifyOsmCandidate(candLat, candLng, candName, origLoc, brgyKey) {
  const [x, y] = toXY([candLng, candLat]);
  if (!A.inZone(cityZone, x, y)) return false;
  const bz = brgyByKey.get(brgyKey);
  if (bz && minDistToPolygon(bz, x, y) > 450) return false;
  const srcTokens = distinctiveTokens(origLoc);
  const dstText = normKey(candName);
  if (srcTokens.length === 0) return false;
  return srcTokens.some((tok) => dstText.includes(tok));
}

async function queryTierB(loc, brgy, brgyKey) {
  let cleaned = cleanPlaceQuery(loc);
  for (const [re, rep] of KNOWN_QUERY_EXPAND) {
    if (re.test(cleaned) || re.test(loc)) cleaned = rep;
  }
  const cacheKey = `${normKey(cleaned)}|${brgyKey}`;
  if (geoCache.has(cacheKey)) return geoCache.get(cacheKey);
  const GENERIC_SKIP = /\b(ending point|request clearing|tambakan|mrf|area\s*\d|muslim side|interiors|city\s*wide)\b/i;
  if (OFFLINE || GENERIC_SKIP.test(loc) || distinctiveTokens(cleaned).length === 0) {
    geoCache.set(cacheKey, null);
    return null;
  }

  let result = null;
  const q = `${cleaned}, Naga`;

  try {
    await sleep(1050);
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&bounded=1&viewbox=123.165,13.680,123.385,13.595&limit=5&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'Accept': 'application/json', 'User-Agent': 'NagaCitySWMOAreaValidator/1.0' },
    });
    if (res.ok) {
      const items = await res.json();
      for (const item of items) {
        const lat = Number(item.lat), lon = Number(item.lon);
        const cname = `${item.name || ''} ${item.display_name || ''}`.trim();
        if (verifyOsmCandidate(lat, lon, cname, `${loc} ${cleaned}`, brgyKey)) {
          let box = null;
          if (Array.isArray(item.boundingbox) && item.boundingbox.length === 4) {
            const [sLat, nLat, wLon, eLon] = item.boundingbox.map(Number);
            const p1 = toXY([wLon, sLat]), p2 = toXY([eLon, nLat]);
            const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
            if (dx > 5 && dy > 5 && dx <= 1200 && dy <= 1200) {
              box = { minX: p1[0] - 25, maxX: p2[0] + 25, minY: p1[1] - 25, maxY: p2[1] + 25 };
            }
          }
          const [x, y] = toXY([lon, lat]);
          result = { source: 'Nominatim', name: item.name || cleaned, lat, lng: lon, x, y, box };
          break;
        }
      }
    }
  } catch { /* ignore */ }

  geoCache.set(cacheKey, result);
  return result;
}

// ------------------------------------------------------------------ Continuous Marching Squares builder
function buildGridRings(segments, boxes, pointBuffers, stopPts, scheduledBrgys) {
  const STEP = 25;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const expandXY = (x, y, pad) => {
    if (x - pad < minX) minX = x - pad;
    if (x + pad > maxX) maxX = x + pad;
    if (y - pad < minY) minY = y - pad;
    if (y + pad > maxY) maxY = y + pad;
  };
  for (const s of segments) for (const [x, y] of s.pts) expandXY(x, y, 750);
  for (const b of boxes) { expandXY(b.minX, b.minY, 750); expandXY(b.maxX, b.maxY, 750); }
  for (const p of pointBuffers) expandXY(p.x, p.y, 750);
  for (const p of stopPts) expandXY(p[0], p[1], 750);

  const x0 = Math.floor(minX / STEP) * STEP - STEP * 2;
  const y0 = Math.floor(minY / STEP) * STEP - STEP * 2;
  const cols = Math.ceil((maxX - x0) / STEP) + 4;
  const rows = Math.ceil((maxY - y0) / STEP) + 4;

  const cellX = (cc) => x0 + (cc + 0.5) * STEP;
  const cellY = (rr) => y0 + (rr + 0.5) * STEP;
  const makeGrid = () => Array.from({ length: rows }, () => new Uint8Array(cols));
  const occ = makeGrid();

  const markCircle = (grid, cx, cy, r, clipCity = false) => {
    const r2 = r * r;
    const cMin = Math.max(2, Math.floor((cx - r - x0) / STEP));
    const cMax = Math.min(cols - 3, Math.ceil((cx + r - x0) / STEP));
    const rMin = Math.max(2, Math.floor((cy - r - y0) / STEP));
    const rMax = Math.min(rows - 3, Math.ceil((cy + r - y0) / STEP));
    for (let rr = rMin; rr <= rMax; rr++) {
      const py = cellY(rr);
      for (let cc = cMin; cc <= cMax; cc++) {
        const px = cellX(cc);
        const dx = px - cx, dy = py - cy;
        if (dx * dx + dy * dy <= r2 && (!clipCity || A.inZone(cityZone, px, py))) grid[rr][cc] = 1;
      }
    }
  };

  const markSegment = (grid, ax, ay, bx, by, r, clipCity = false) => {
    const r2 = r * r;
    const cMin = Math.max(2, Math.floor((Math.min(ax, bx) - r - x0) / STEP));
    const cMax = Math.min(cols - 3, Math.ceil((Math.max(ax, bx) + r - x0) / STEP));
    const rMin = Math.max(2, Math.floor((Math.min(ay, by) - r - y0) / STEP));
    const rMax = Math.min(rows - 3, Math.ceil((Math.max(ay, by) + r - y0) / STEP));
    for (let rr = rMin; rr <= rMax; rr++) {
      const py = cellY(rr);
      for (let cc = cMin; cc <= cMax; cc++) {
        if (grid[rr][cc]) continue;
        const px = cellX(cc);
        if (distSqPointToSegment(px, py, ax, ay, bx, by) <= r2 && (!clipCity || A.inZone(cityZone, px, py))) {
          grid[rr][cc] = 1;
        }
      }
    }
  };

  const labelComponents = (grid) => {
    const seen = Array.from({ length: rows }, () => new Uint8Array(cols));
    const comps = [];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let rr = 2; rr < rows - 2; rr++) {
      for (let cc = 2; cc < cols - 2; cc++) {
        if (!grid[rr][cc] || seen[rr][cc]) continue;
        const queue = [[rr, cc]];
        seen[rr][cc] = 1;
        const cells = [];
        for (let qi = 0; qi < queue.length; qi++) {
          const [r, c] = queue[qi];
          cells.push([r, c]);
          for (const [dr, dc] of dirs) {
            const nr = r + dr, nc = c + dc;
            if (nr >= 2 && nr < rows - 2 && nc >= 2 && nc < cols - 2 && grid[nr][nc] && !seen[nr][nc]) {
              seen[nr][nc] = 1;
              queue.push([nr, nc]);
            }
          }
        }
        const cellKeys = new Set(cells.map(([r, c]) => r * cols + c));
        const hasStops = stopPts.some(([sx, sy]) => {
          const sr = Math.round((sy - y0) / STEP - 0.5);
          const sc = Math.round((sx - x0) / STEP - 0.5);
          for (let dr = -4; dr <= 4; dr++) {
            for (let dc = -4; dc <= 4; dc++) {
              if (cellKeys.has((sr + dr) * cols + (sc + dc))) return true;
            }
          }
          return false;
        });
        const anchors = [];
        const stride = Math.max(1, Math.floor(cells.length / 36));
        for (let i = 0; i < cells.length; i += stride) anchors.push([cellX(cells[i][1]), cellY(cells[i][0])]);
        comps.push({ cells, cellKeys, hasStops, anchors });
      }
    }
    comps.sort((a, b) => b.cells.length - a.cells.length);
    return comps;
  };

  const fillInteriorHoles = (grid) => {
    const ext = Array.from({ length: rows }, () => new Uint8Array(cols));
    const queue = [];
    for (let cc = 0; cc < cols; cc++) {
      if (!grid[0][cc]) { ext[0][cc] = 1; queue.push([0, cc]); }
      if (!grid[rows - 1][cc] && !ext[rows - 1][cc]) { ext[rows - 1][cc] = 1; queue.push([rows - 1, cc]); }
    }
    for (let rr = 0; rr < rows; rr++) {
      if (!grid[rr][0] && !ext[rr][0]) { ext[rr][0] = 1; queue.push([rr, 0]); }
      if (!grid[rr][cols - 1] && !ext[rr][cols - 1]) { ext[rr][cols - 1] = 1; queue.push([rr, cols - 1]); }
    }
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let qi = 0; qi < queue.length; qi++) {
      const [r, c] = queue[qi];
      for (const [dr, dc] of dirs) {
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !ext[nr][nc] && !grid[nr][nc]) {
          ext[nr][nc] = 1;
          queue.push([nr, nc]);
        }
      }
    }
    for (let rr = 1; rr < rows - 1; rr++) {
      for (let cc = 1; cc < cols - 1; cc++) {
        if (!grid[rr][cc] && !ext[rr][cc]) grid[rr][cc] = 1;
      }
    }
  };

  // 1. Initial rasterization of OSM streets, verified places, and scheduled stops (clipped to Naga City)
  for (const seg of segments) {
    const width = seg.arterial ? 85 : 65;
    for (let i = 1; i < seg.pts.length; i++) {
      markSegment(occ, seg.pts[i - 1][0], seg.pts[i - 1][1], seg.pts[i][0], seg.pts[i][1], width, true);
    }
  }
  for (const b of boxes) {
    const cMin = Math.max(2, Math.floor((b.minX - x0) / STEP));
    const cMax = Math.min(cols - 3, Math.ceil((b.maxX - x0) / STEP));
    const rMin = Math.max(2, Math.floor((b.minY - y0) / STEP));
    const rMax = Math.min(rows - 3, Math.ceil((b.maxY - y0) / STEP));
    for (let rr = rMin; rr <= rMax; rr++) {
      const py = cellY(rr);
      for (let cc = cMin; cc <= cMax; cc++) {
        if (A.inZone(cityZone, cellX(cc), py)) occ[rr][cc] = 1;
      }
    }
  }
  for (const p of pointBuffers) markCircle(occ, p.x, p.y, 110, true);
  for (const [sx, sy] of stopPts) markCircle(occ, sx, sy, 95, true);

  // 2. Prune detached zero-stop noise fragments (> 150 m from stop-bearing cores)
  const initialComps = labelComponents(occ);
  const coreComps = initialComps.filter((c) => c.hasStops);
  if (coreComps.length > 0) {
    for (const c of initialComps) {
      if (c.hasStops) continue;
      let nearCore = false;
      for (const a of c.anchors) {
        for (const core of coreComps) {
          for (const b of core.anchors) {
            if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 150) { nearCore = true; break; }
          }
          if (nearCore) break;
        }
        if (nearCore) break;
      }
      if (!nearCore) for (const [r, col] of c.cells) occ[r][col] = 0;
    }
  }

  // 3. Connect remaining components along real OSM roads (Prim MST)
  const compsToJoin = labelComponents(occ);
  if (compsToJoin.length > 1) {
    const joined = [compsToJoin[0]];
    const remaining = compsToJoin.slice(1);
    while (remaining.length > 0) {
      let bestRemIdx = -1, bestDist = Infinity, bestA = null, bestB = null;
      for (let ri = 0; ri < remaining.length; ri++) {
        const rc = remaining[ri];
        for (const jc of joined) {
          for (const pA of jc.anchors) {
            for (const pB of rc.anchors) {
              const d = Math.hypot(pA[0] - pB[0], pA[1] - pB[1]);
              if (d < bestDist) { bestDist = d; bestRemIdx = ri; bestA = pA; bestB = pB; }
            }
          }
        }
      }
      const nextComp = remaining.splice(bestRemIdx, 1)[0];
      const nA = nearestRoadNode(bestA[0], bestA[1]);
      const nB = nearestRoadNode(bestB[0], bestB[1]);
      const pathPts = shortestRoadPath(nA, nB, scheduledBrgys);
      const poly = [bestA, ...pathPts, bestB];
      for (let i = 1; i < poly.length; i++) {
        markSegment(occ, poly[i - 1][0], poly[i - 1][1], poly[i][0], poly[i][1], 85, true);
      }
      joined.push(nextComp);
    }
  }

  // 4. Circular morphological closing (r = 2 cells = 50 m)
  const dil = makeGrid();
  for (let rr = 2; rr < rows - 2; rr++) {
    for (let cc = 2; cc < cols - 2; cc++) {
      let hit = false;
      for (let dr = -2; dr <= 2 && !hit; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          if (dr * dr + dc * dc <= 4 && occ[rr + dr][cc + dc]) { hit = true; break; }
        }
      }
      if (hit) dil[rr][cc] = 1;
    }
  }
  const closed = makeGrid();
  for (let rr = 2; rr < rows - 2; rr++) {
    for (let cc = 2; cc < cols - 2; cc++) {
      let all = true;
      for (let dr = -2; dr <= 2 && all; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          if (dr * dr + dc * dc <= 4 && !dil[rr + dr][cc + dc]) { all = false; break; }
        }
      }
      if (all) closed[rr][cc] = 1;
    }
  }

  // 5. Clip to Naga City, guarantee stop circles, resolve diagonal saddles, and merge any residual islands
  for (let rr = 2; rr < rows - 2; rr++) {
    const py = cellY(rr);
    for (let cc = 2; cc < cols - 2; cc++) {
      if (closed[rr][cc] && !A.inZone(cityZone, cellX(cc), py)) closed[rr][cc] = 0;
    }
  }
  for (const [sx, sy] of stopPts) markCircle(closed, sx, sy, 95, true);

  const healSaddles = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (let rr = 1; rr < rows - 2; rr++) {
        for (let cc = 1; cc < cols - 2; cc++) {
          const bl = closed[rr][cc], br = closed[rr][cc + 1];
          const tl = closed[rr + 1][cc], tr = closed[rr + 1][cc + 1];
          if (bl && tr && !br && !tl) { closed[rr][cc + 1] = 1; changed = true; }
          else if (br && tl && !bl && !tr) { closed[rr][cc] = 1; changed = true; }
        }
      }
    }
  };

  fillInteriorHoles(closed);
  healSaddles();

  const finalComps = labelComponents(closed);
  if (finalComps.length > 1) {
    const main = finalComps[0];
    for (const frag of finalComps.slice(1)) {
      if (!frag.hasStops) {
        for (const [r, c] of frag.cells) closed[r][c] = 0;
      } else {
        let bestD = Infinity, p1 = main.anchors[0], p2 = frag.anchors[0];
        for (const a of main.anchors) {
          for (const b of frag.anchors) {
            const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
            if (d < bestD) { bestD = d; p1 = a; p2 = b; }
          }
        }
        markSegment(closed, p1[0], p1[1], p2[0], p2[1], 95, true);
      }
    }
    fillInteriorHoles(closed);
    healSaddles();
  }

  // Marching Squares on cell corners: corner (c, r) samples closed[r][c]
  // Cell (c, r) has BL=(c,r), BR=(c+1,r), TR=(c+1,r+1), TL=(c,r+1)
  const edgesOut = new Map();
  const addEdge = (a, b) => {
    // Allow multiple outgoing edges only shouldn't occur, so key cleanly
    if (!edgesOut.has(a)) edgesOut.set(a, []);
    edgesOut.get(a).push(b);
  };
  const keyN = (c, r) => `${c},${r + 1},H`;
  const keyS = (c, r) => `${c},${r},H`;
  const keyE = (c, r) => `${c + 1},${r},V`;
  const keyW = (c, r) => `${c},${r},V`;

  for (let rr = 0; rr < rows - 1; rr++) {
    for (let cc = 0; cc < cols - 1; cc++) {
      const bl = closed[rr][cc] ? 1 : 0;
      const br = closed[rr][cc + 1] ? 2 : 0;
      const tr = closed[rr + 1][cc + 1] ? 4 : 0;
      const tl = closed[rr + 1][cc] ? 8 : 0;
      const mask = tl | tr | br | bl;
      if (mask === 0 || mask === 15) continue;
      const N = keyN(cc, rr), S = keyS(cc, rr), E = keyE(cc, rr), W = keyW(cc, rr);
      switch (mask) {
        case 1:  addEdge(S, W); break;
        case 2:  addEdge(E, S); break;
        case 3:  addEdge(E, W); break;
        case 4:  addEdge(N, E); break;
        case 5:  addEdge(S, W); addEdge(N, E); break;
        case 6:  addEdge(N, S); break;
        case 7:  addEdge(N, W); break;
        case 8:  addEdge(W, N); break;
        case 9:  addEdge(S, N); break;
        case 10: addEdge(W, N); addEdge(E, S); break;
        case 11: addEdge(E, N); break;
        case 12: addEdge(W, E); break;
        case 13: addEdge(S, E); break;
        case 14: addEdge(W, S); break;
      }
    }
  }

  const keyToXY = (k) => {
    const [cs, rs, dir] = k.split(',');
    const c = Number(cs), r = Number(rs);
    return dir === 'H'
      ? [x0 + (c + 1.0) * STEP, y0 + (r + 0.5) * STEP]
      : [x0 + (c + 0.5) * STEP, y0 + (r + 1.0) * STEP];
  };

  const loops = [];
  for (const [startKey, list] of edgesOut.entries()) {
    while (list.length) {
      const next = list.pop();
      const ringKeys = [startKey, next];
      let cur = next;
      let guard = 0;
      while (cur !== startKey && guard++ < 100000) {
        const nxtList = edgesOut.get(cur);
        if (!nxtList || nxtList.length === 0) break;
        cur = nxtList.pop();
        if (cur !== startKey) ringKeys.push(cur);
      }
      if (ringKeys.length >= 4) loops.push(ringKeys.map(keyToXY));
    }
  }

  // Keep only outer CCW ring (signedArea > 0), smooth slightly, and simplify safely
  const ccwLoops = loops.filter((rawRing) => signedArea(rawRing) > 0).sort((a, b) => polygonArea(b) - polygonArea(a));
  const outRings = [];
  for (const rawRing of ccwLoops.slice(0, 1)) {
    const sm = smoothRing(rawRing);
    const candidates = [
      rdpSimplify(sm, 16),
      rdpSimplify(sm, 10),
      rdpSimplify(sm, 6),
      rdpSimplify(rawRing, 14),
      rdpSimplify(rawRing, 6),
      rawRing,
    ];
    let chosen = rawRing;
    for (const cand of candidates) {
      if (cand.length < 3 || selfCrosses(cand)) continue;
      if (!cand.every(([px, py]) => nearCity(px, py))) continue;
      if (stopPts.every(([sx, sy]) => pointInPolygon(sx, sy, cand))) {
        chosen = cand;
        break;
      }
    }
    outRings.push(chosen);
  }
  return outRings;
}

// ------------------------------------------------------------------ process 17 areas
const [head, ...rows] = parseCsv(await readText('data/collection_schedules.csv'));
const idx = Object.fromEntries(head.map((h, i) => [h.trim().toLowerCase(), i]));
const get = (r, k) => (idx[k] === undefined ? '' : String(r[idx[k]] ?? '').trim());

const stopsByArea = new Map();
for (const r of rows) {
  if (/^(false|f|0|no)$/i.test(get(r, 'is_active'))) continue;
  const code = get(r, 'area_code');
  const type = get(r, 'stop_type').toLowerCase();
  const lat = Number(get(r, 'latitude')), lng = Number(get(r, 'longitude'));
  if (!code || type !== 'collection' || !lat || !lng) continue;
  const [x, y] = toXY([lng, lat]);
  if (!stopsByArea.has(code)) stopsByArea.set(code, []);
  stopsByArea.get(code).push({
    code,
    name: get(r, 'area_name') || code,
    loc: get(r, 'location_name'),
    brgy: get(r, 'barangay'),
    brgyKey: normKey(get(r, 'barangay')),
    lat, lng, x, y,
  });
}

console.log(`Generating accurate polygons (OFFLINE=${OFFLINE}) across ${stopsByArea.size} schedule areas...`);

const allFeatures = [];
let globalTotal = 0, globalGrounded = 0;

for (const [code, list] of [...stopsByArea.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
  const segMap = new Map();
  const boxes = [];
  const pointBuffers = [];
  const matchedStreets = new Set();
  const matchedPlaces = new Set();
  const unverifiedLocs = new Set();
  const brgySet = new Set();
  let tierA = 0, tierB = 0, tierC = 0;

  for (const s of list) {
    if (s.brgy) brgySet.add(s.brgy);
    globalTotal++;

    const hitA = matchTierA(s);
    if (hitA) {
      tierA++;
      globalGrounded++;
      for (const st of hitA.streets) matchedStreets.add(st);
      for (const seg of hitA.segments) {
        const sk = `${seg.name}:${seg.mid[0].toFixed(1)},${seg.mid[1].toFixed(1)}`;
        segMap.set(sk, seg);
      }
      continue;
    }

    const hitB = await queryTierB(s.loc, s.brgy, s.brgyKey);
    if (hitB) {
      tierB++;
      globalGrounded++;
      matchedPlaces.add(`${hitB.name} (${hitB.source})`);
      if (hitB.box) boxes.push(hitB.box);
      else pointBuffers.push({ x: hitB.x, y: hitB.y });
      continue;
    }

    tierC++;
    unverifiedLocs.add(`${s.loc} (${s.brgy})`);
  }

  const scheduledBrgys = [...brgySet].map((b) => brgyByKey.get(normKey(b))).filter(Boolean);
  const stopPts = list.map((s) => [s.x, s.y]);
  const rings = buildGridRings([...segMap.values()], boxes, pointBuffers, stopPts, scheduledBrgys);
  const zoneObj = A.makeZone({ id: `schedule:${code}`, kind: 'schedule', code, name: code }, rings);

  // Measure barangay precision (% of polygon sample points inside scheduled barangays)
  let sampleInZone = 0, sampleInScheduledBrgy = 0;
  const b = zoneObj.bbox;
  for (let i = 0; i < 24; i++) {
    for (let j = 0; j < 24; j++) {
      const px = b.minX + ((i + 0.5) / 24) * (b.maxX - b.minX);
      const py = b.minY + ((j + 0.5) / 24) * (b.maxY - b.minY);
      if (!A.inZone(zoneObj, px, py)) continue;
      sampleInZone++;
      if (scheduledBrgys.some((bg) => A.inZone(bg, px, py))) sampleInScheduledBrgy++;
    }
  }
  const brgyPrecPct = sampleInZone ? Math.round((100 * sampleInScheduledBrgy) / sampleInZone) : 100;
  const accPct = Math.round((100 * (tierA + tierB)) / list.length);
  const totalAreaM2 = rings.reduce((s, r) => s + polygonArea(r), 0);

  // Convert [x,y] CCW rings to closed [lng,lat] GeoJSON rings
  const geoRings = rings.map((r) => {
    const ll = r.map((pt) => {
      const [lng, lat] = toLngLat(pt);
      return [Number(lng.toFixed(6)), Number(lat.toFixed(6))];
    });
    if (ll[0][0] !== ll[ll.length - 1][0] || ll[0][1] !== ll[ll.length - 1][1]) ll.push(ll[0]);
    return ll;
  });

  const geometry = geoRings.length === 1
    ? { type: 'Polygon', coordinates: geoRings }
    : { type: 'MultiPolygon', coordinates: geoRings.map((r) => [r]) };

  const feat = {
    type: 'Feature',
    properties: {
      kind: 'schedule',
      code,
      name: code,
      area_label: list[0].name,
      barangays: [...brgySet],
      stop_count: list.length,
      tier_a_roads: tierA,
      tier_b_osm_places: tierB,
      tier_c_unverified: tierC,
      accuracy_pct: accPct,
      barangay_precision_pct: brgyPrecPct,
      area_km2: Number((totalAreaM2 / 1e6).toFixed(3)),
      ring_count: geoRings.length,
      needs_verification: accPct < 80 || tierC > 0,
      matched_streets: [...matchedStreets].sort(),
      matched_places: [...matchedPlaces].sort(),
      unverified_locations: [...unverifiedLocs].sort(),
    },
    geometry,
  };
  allFeatures.push(feat);

  console.log(
    `${code.padEnd(15)} stops=${String(list.length).padStart(2)} A=${String(tierA).padStart(2)} B=${String(tierB).padStart(2)} C=${String(tierC).padStart(2)} ` +
    `acc=${String(accPct).padStart(3)}% brgyPrec=${String(brgyPrecPct).padStart(3)}% rings=${String(geoRings.length).padStart(2)} area=${feat.properties.area_km2.toFixed(2)}km2`
  );
}

// ------------------------------------------------------------------ Before vs After comparison
const legacyZones = A.scheduleZones(A.readStops(await readText('data/collection_schedules.csv'), geo), world.trucks);
const newZones = A.boundaryZones({ type: 'FeatureCollection', features: allFeatures }, geo);

const measureZones = (zoneList) => {
  let sumKm2 = 0, sumOv = 0;
  for (const z of zoneList) {
    const areaKm2 = z.rings.reduce((s, r) => s + polygonArea(r), 0) / 1e6;
    sumKm2 += areaKm2;
    let inPts = 0, ovPts = 0;
    const b = z.bbox;
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 20; j++) {
        const px = b.minX + ((i + 0.5) / 20) * (b.maxX - b.minX);
        const py = b.minY + ((j + 0.5) / 20) * (b.maxY - b.minY);
        if (!A.inZone(z, px, py)) continue;
        inPts++;
        if (zoneList.some((o) => o !== z && A.inZone(o, px, py))) ovPts++;
      }
    }
    sumOv += inPts ? (100 * ovPts) / inPts : 0;
  }
  return { totalKm2: sumKm2, meanKm2: sumKm2 / zoneList.length, meanOvPct: sumOv / zoneList.length };
};

const before = measureZones(legacyZones);
const after = measureZones(newZones);
const overallAcc = Number(((100 * globalGrounded) / globalTotal).toFixed(1));

const collection = {
  type: 'FeatureCollection',
  name: 'Naga City SWMO Schedule Areas (OSM Street & Subdivision Grounded)',
  attribution: 'Schedule stops: Naga City SWMO; Streets & places: OpenStreetMap contributors (ODbL); Boundaries: NAMRIA/PSA.',
  validation: {
    overall_osm_accuracy_pct: overallAcc,
    grounded_stops: globalGrounded,
    total_stops: globalTotal,
    before_total_km2: Number(before.totalKm2.toFixed(2)),
    after_total_km2: Number(after.totalKm2.toFixed(2)),
    before_mean_overlap_pct: Number(before.meanOvPct.toFixed(1)),
    after_mean_overlap_pct: Number(after.meanOvPct.toFixed(1)),
  },
  features: allFeatures,
};

const outPath = join(root, 'data/naga_schedule_areas.geojson');
writeFileSync(outPath, JSON.stringify(collection, null, 2));

console.log('\n=== SUMMARY METRICS ===');
console.log(`Overall OSM grounding accuracy: ${globalGrounded}/${globalTotal} (${overallAcc}%)`);
console.log(`Total footprint: ${before.totalKm2.toFixed(2)} km2 (legacy convex hulls) -> ${after.totalKm2.toFixed(2)} km2 (street/subdivision bounded)`);
console.log(`Mean pairwise overlap: ${before.meanOvPct.toFixed(1)}% -> ${after.meanOvPct.toFixed(1)}%`);
console.log(`Wrote ${outPath}`);
