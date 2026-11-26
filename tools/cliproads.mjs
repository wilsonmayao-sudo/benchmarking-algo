// Clip an Overpass road download to a boundary polygon.
//   node tools/cliproads.mjs <overpass.json> <boundary.json> <out.geojson> [paths-out.geojson]
// The Overpass query must be `way["highway"](bbox); out tags geom;`.
// Drivable roads go to <out>; footways, steps etc. go to [paths-out].
import { readFileSync, writeFileSync } from 'node:fs';

const [osmFile, boundaryFile, outFile, pathsFile] = process.argv.slice(2);
if (!outFile) {
  console.error('usage: node tools/cliproads.mjs <overpass.json> <boundary.json> <out.geojson> [paths-out.geojson]');
  process.exit(1);
}
const osm = JSON.parse(readFileSync(osmFile, 'utf8'));
const boundary = JSON.parse(readFileSync(boundaryFile, 'utf8'));

// All rings together, even-odd rule: handles holes and MultiPolygons.
const rings = boundary.features.flatMap(({ geometry: g }) =>
  g.type === 'MultiPolygon' ? g.coordinates.flat() : g.coordinates);
const sides = rings.flatMap((r) => r.slice(1).map((p, i) => [r[i][0], r[i][1], p[0], p[1]]));

const inside = (x, y) => {
  let c = false;
  for (const [x1, y1, x2, y2] of sides) {
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) c = !c;
  }
  return c;
};
const round = (v) => Math.round(v * 1e7) / 1e7;

// Split every segment where it crosses the boundary; keep the pieces whose middle is inside.
function clip(line) {
  const parts = [];
  let cur = null;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1];
    const [bx, by] = line[i];
    const ts = [0, 1];
    for (const [x1, y1, x2, y2] of sides) {
      const den = (bx - ax) * (y2 - y1) - (by - ay) * (x2 - x1);
      if (den === 0) continue;
      const t = ((x1 - ax) * (y2 - y1) - (y1 - ay) * (x2 - x1)) / den;
      const u = ((x1 - ax) * (by - ay) - (y1 - ay) * (bx - ax)) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
    ts.sort((a, b) => a - b);
    const at = (t) => (t === 0 ? [ax, ay] : t === 1 ? [bx, by] : [round(ax + t * (bx - ax)), round(ay + t * (by - ay))]);
    for (let k = 1; k < ts.length; k++) {
      if (ts[k] === ts[k - 1]) continue;
      const m = (ts[k] + ts[k - 1]) / 2;
      if (inside(ax + m * (bx - ax), ay + m * (by - ay))) {
        if (!cur) parts.push((cur = [at(ts[k - 1])]));
        cur.push(at(ts[k]));
      } else cur = null;
    }
  }
  return parts;
}

// Not drivable: same list as js/data/cityMapLoader.js.
const NOT_DRIVABLE = new Set(['footway', 'path', 'steps', 'cycleway', 'pedestrian', 'bridleway', 'corridor',
  'construction', 'proposed', 'bus_guideway', 'raceway', 'platform', 'escape', 'elevator', 'escalator', 'via_ferrata']);
const KEEP = ['highway', 'name', 'ref', 'oneway', 'maxspeed', 'surface', 'junction', 'bridge', 'lanes', 'access', 'service', 'tracktype'];

const roads = [];
const paths = [];
for (const w of osm.elements) {
  if (w.type !== 'way' || !w.geometry || !w.tags?.highway || w.tags.area === 'yes') continue;
  const properties = { osm_id: w.id };
  for (const k of KEEP) if (w.tags[k] !== undefined) properties[k] = w.tags[k];
  for (const coordinates of clip(w.geometry.map((p) => [p.lon, p.lat]))) {
    (NOT_DRIVABLE.has(w.tags.highway) ? paths : roads)
      .push({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates } });
  }
}

const save = (file, name, features) => {
  const head = {
    type: 'FeatureCollection', name,
    attribution: '© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)',
    osm_timestamp: osm.osm3s?.timestamp_osm_base,
  };
  writeFileSync(file, JSON.stringify({ ...head, features }));
  const km = features.reduce((s, f) => s + f.geometry.coordinates.reduce((d, p, i, a) => (i
    ? d + Math.hypot((p[0] - a[i - 1][0]) * Math.cos((p[1] * Math.PI) / 180), p[1] - a[i - 1][1]) * 111.32 : 0), 0), 0);
  console.log(`${file}: ${features.length} pieces, ${km.toFixed(1)} km`);
};
save(outFile, 'Roads inside the boundary', roads);
if (pathsFile) save(pathsFile, 'Non-drivable ways inside the boundary', paths);
