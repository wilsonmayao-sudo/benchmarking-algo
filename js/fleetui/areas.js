/**
 * Testing areas — geometry and fleet filtering. Pure functions: no DOM, no map drawing.
 *
 * A zone is { id, kind, name, rings, bbox, code? }; rings are [x, y] outlines in map metres
 * (even-odd rule, so holes and several parts work).
 *   schedule   one per area_code of the collection schedule: outline around its collection
 *              stops (the schedule has no official boundary)
 *   barangay | district | city   from the scenario's boundary file
 *   custom     drawn by the user, kept in lat/lng
 */

import { parseCsv } from '../data/cityMapLoader.js';
import { parseDays } from '../sim/config/scenarioLoader.js';
import { pointInPolygon, polygonArea } from '../sim/fleet/routeAreas.js';
import { truckXY } from '../sim/fleet/truck.js';

/** Metres added around a schedule area's outermost stops. */
const STOP_MARGIN = 150;

export function makeZone(props, rings) {
  const pts = rings.flat();
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return {
    ...props, rings,
    size: rings.reduce((s, r) => Math.max(s, polygonArea(r)), 0),
    bbox: { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) },
  };
}

export function inZone(zone, x, y) {
  const b = zone.bbox;
  if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) return false;
  let inside = false;
  for (const r of zone.rings) if (pointInPolygon(x, y, r)) inside = !inside;
  return inside;
}

/** Smallest zone containing the point (schedule areas overlap). */
export function zoneAt(zones, x, y) {
  let best = null;
  for (const z of zones) if ((!best || z.size < best.size) && inZone(z, x, y)) best = z;
  return best;
}

export const toXY = (geo, [lng, lat]) => (geo ? [(lng - geo.minLon) * geo.mPerLon, (lat - geo.minLat) * geo.mPerLat] : [lng, lat]);
export const toLngLat = (geo, [x, y]) => (geo ? [x / geo.mPerLon + geo.minLon, y / geo.mPerLat + geo.minLat] : [x, y]);

/** Counter-clockwise convex hull (monotone chain). */
export function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (list) => {
    const h = [];
    for (const c of list) {
      while (h.length > 1) {
        const a = h[h.length - 2], b = h[h.length - 1];
        if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0) break;
        h.pop();
      }
      h.push(c);
    }
    h.pop();
    return h;
  };
  return [...half(p), ...half(p.slice().reverse())];
}

/** Schedule rows with coordinates, as { x, y, area, order, name, type, days }. */
export function readStops(text, geo) {
  const [head, ...rows] = parseCsv(text);
  const at = Object.fromEntries(head.map((h, i) => [h.trim().toLowerCase(), i]));
  const get = (r, k) => (at[k] === undefined ? '' : String(r[at[k]] ?? '').trim());
  const stops = [];
  for (const r of rows) {
    const lat = Number(get(r, 'latitude')), lng = Number(get(r, 'longitude'));
    if (!lat || !lng || /^(false|f|0|no)$/i.test(get(r, 'is_active'))) continue;
    const [x, y] = toXY(geo, [lng, lat]);
    stops.push({ x, y, area: get(r, 'area_code'), order: get(r, 'stop_order'), name: get(r, 'location_name'),
      type: get(r, 'stop_type').toLowerCase(), days: parseDays(get(r, 'days_of_week')) });
  }
  return stops;
}

export function scheduleZones(stops, trucks) {
  const byArea = new Map();
  for (const s of stops) {
    if (!s.area || s.type !== 'collection') continue; // the shared landfill / start rows would stretch every area
    if (!byArea.has(s.area)) byArea.set(s.area, []);
    byArea.get(s.area).push(s);
  }
  return [...byArea.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([code, list]) => {
    const ring = [];
    for (const s of list) {
      for (let k = 0; k < 16; k++) ring.push([s.x + STOP_MARGIN * Math.cos((k * Math.PI) / 8), s.y + STOP_MARGIN * Math.sin((k * Math.PI) / 8)]);
    }
    const owners = trucks.filter((t) => coversArea(t, code)).map((t) => t.id);
    return makeZone({ id: `schedule:${code}`, kind: 'schedule', code, name: code, note: owners.join(', ') }, [convexHull(ring)]);
  });
}

export function boundaryZones(json, geo) {
  return json.features.filter((f) => /Polygon$/.test(f.geometry?.type || '')).map((f) => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const { kind, name, psgc } = f.properties;
    return makeZone({ id: `${kind}:${psgc || name}`, kind, name }, polys.flat().map((r) => r.map((p) => toXY(geo, p))));
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function coversArea(truck, code) {
  return truck.areas.some((a) => a.trim().toUpperCase() === code.toUpperCase());
}

/** A schedule area owns its own stops; everything else goes by position. */
export function binInZone(zone, bin, x = bin.x, y = bin.y) {
  return zone.kind === 'schedule' && bin.area ? bin.area.toUpperCase() === zone.code.toUpperCase() : inZone(zone, x, y);
}

export function stopsInZone(zone, stops, day) {
  return stops.filter((s) => (day === 'all' || s.days.includes(day)) &&
    (zone.kind === 'schedule' ? s.area === zone.code : inZone(zone, s.x, s.y)));
}

/**
 * Who works in the zone right now.
 * A truck counts when it is inside (parked at the depot does not count), has bins left to
 * collect there, or is the truck the schedule gives that area to.
 * @returns {{trucks:Set<string>, here:Set<string>, bins:Set<string>}}
 */
export function fleetIn(sim, zone) {
  const trucks = new Set(), here = new Set(), bins = new Set();
  for (const b of sim.bins) {
    if (!binInZone(zone, b)) continue;
    bins.add(b.id);
    if (b.state === 'collected' || b.state === 'missed') continue;
    if (b.truckId) trucks.add(b.truckId);
    for (const id of sim.routes.get(b.routeId)?.truckIds || []) trucks.add(id);
  }
  for (const t of sim.trucks) {
    if (zone.kind === 'schedule' && coversArea(t, zone.code)) trucks.add(t.id);
    if (t.node === sim.world.depot && t.arcPos === 0) continue;
    const p = truckXY(sim.graph, t);
    if (inZone(zone, p.x, p.y)) { here.add(t.id); trucks.add(t.id); }
  }
  return { trucks, here, bins };
}
