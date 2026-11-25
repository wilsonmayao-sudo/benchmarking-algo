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

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABEL = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

export function formatAreaLabel(code) {
  return String(code || '').replace(/^(AREA)-/i, '$1 ').replace(/-/g, ' ').trim();
}

export function compareAreaCodes(a, b) {
  const ma = /^AREA-(\d+)(.*)$/i.exec(String(a || ''));
  const mb = /^AREA-(\d+)(.*)$/i.exec(String(b || ''));
  if (ma && mb) {
    const diff = Number(ma[1]) - Number(mb[1]);
    return diff !== 0 ? diff : ma[2].localeCompare(mb[2], undefined, { numeric: true });
  }
  if (ma) return -1;
  if (mb) return 1;
  return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true });
}

/** Schedule rows with coordinates, as { x, y, area, order, name, type, days, ... }. */
export function readStops(text, geo) {
  const [head, ...rows] = parseCsv(text);
  const at = Object.fromEntries(head.map((h, i) => [h.trim().toLowerCase(), i]));
  const get = (r, k) => (at[k] === undefined ? '' : String(r[at[k]] ?? '').trim());
  const stops = [];
  for (const r of rows) {
    const lat = Number(get(r, 'latitude')), lng = Number(get(r, 'longitude'));
    if (!lat || !lng || /^(false|f|0|no)$/i.test(get(r, 'is_active'))) continue;
    const [x, y] = toXY(geo, [lng, lat]);
    stops.push({
      x, y,
      area: get(r, 'area_code'),
      areaName: get(r, 'area_name'),
      shift: get(r, 'shift_label'),
      order: get(r, 'stop_order'),
      name: get(r, 'location_name'),
      type: get(r, 'stop_type').toLowerCase(),
      barangay: get(r, 'barangay'),
      time: get(r, 'scheduled_time'),
      waste: get(r, 'waste_category'),
      days: parseDays(get(r, 'days_of_week')),
    });
  }
  return stops;
}

export function scheduleZones(stops, trucks, precomputed = null) {
  const byCode = new Map();
  if (Array.isArray(precomputed)) {
    for (const z of precomputed) if (z && z.code) byCode.set(z.code.toUpperCase(), z);
  }
  const byArea = new Map();
  const metaByArea = new Map();
  for (const s of stops) {
    if (!s.area) continue;
    if (!metaByArea.has(s.area)) metaByArea.set(s.area, []);
    metaByArea.get(s.area).push(s);
    if (s.type !== 'collection') continue; // the shared landfill / start rows would stretch every area
    if (!byArea.has(s.area)) byArea.set(s.area, []);
    byArea.get(s.area).push(s);
  }
  const allCodes = new Set(byArea.keys());
  for (const preset of byCode.values()) {
    const c = preset.code || preset.name;
    if (c && Array.isArray(preset.rings) && preset.rings.length > 0 && !allCodes.has(c)) {
      allCodes.add(c);
    }
  }
  return [...allCodes].sort(compareAreaCodes).map((code) => {
    const list = byArea.get(code) || [];
    const allRows = metaByArea.get(code) || list;
    const owners = trucks.filter((t) => coversArea(t, code)).map((t) => t.id);
    const preset = byCode.get(code.toUpperCase());

    const areaLabel = allRows.find((s) => s.areaName)?.areaName || preset?.area_label || formatAreaLabel(code);
    const shifts = [...new Set(allRows.map((s) => s.shift).filter(Boolean))];
    const daySet = new Set(allRows.flatMap((s) => s.days || []));
    const days = DAY_ORDER.filter((d) => daySet.has(d)).map((d) => DAY_LABEL[d]);
    const waste = allRows.find((s) => s.waste)?.waste || '';
    const stopBarangays = [...new Set(allRows.map((s) => s.barangay).filter(Boolean))];
    const barangays = Array.isArray(preset?.barangays) && preset.barangays.length > 0 ? preset.barangays : stopBarangays;
    const matchedStreets = Array.isArray(preset?.matched_streets) ? preset.matched_streets : [];
    const matchedPlaces = Array.isArray(preset?.matched_places) ? preset.matched_places : [];
    const locations = list
      .slice()
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
      .map((s) => ({ order: s.order, name: s.name, barangay: s.barangay, time: s.time }));

    let rings;
    if (preset && Array.isArray(preset.rings) && preset.rings.length > 0) {
      rings = preset.rings;
    } else {
      const ring = [];
      for (const s of list) {
        for (let k = 0; k < 16; k++) ring.push([s.x + STOP_MARGIN * Math.cos((k * Math.PI) / 8), s.y + STOP_MARGIN * Math.sin((k * Math.PI) / 8)]);
      }
      rings = [convexHull(ring)];
    }
    const areaKm2 = preset?.area_km2 ?? Number((rings.reduce((s, r) => s + polygonArea(r), 0) / 1e6).toFixed(3));
    return makeZone({
      id: `schedule:${code}`,
      kind: 'schedule',
      code,
      name: code,
      displayName: formatAreaLabel(code),
      note: owners.join(', '),
      areaLabel,
      shift: shifts.join(' · '),
      days,
      waste,
      barangays,
      matchedStreets,
      matchedPlaces,
      locations,
      areaKm2,
      accuracy_pct: preset?.accuracy_pct,
      barangay_precision_pct: preset?.barangay_precision_pct,
      needs_verification: preset?.needs_verification,
      unverified_locations: preset?.unverified_locations,
    }, rings);
  });
}

export function boundaryZones(json, geo) {
  return json.features.filter((f) => /Polygon$/.test(f.geometry?.type || '')).map((f) => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const p = f.properties || {};
    const {
      kind, name, psgc, code, accuracy_pct, barangay_precision_pct, needs_verification,
      unverified_locations, area_label, barangays, area_km2, matched_streets, matched_places,
    } = p;
    const id = kind === 'schedule' ? `schedule:${code || name}` : `${kind}:${psgc || name}`;
    const props = { id, kind, name: name || code };
    if (code !== undefined) props.code = code;
    if (accuracy_pct !== undefined) props.accuracy_pct = accuracy_pct;
    if (barangay_precision_pct !== undefined) props.barangay_precision_pct = barangay_precision_pct;
    if (needs_verification !== undefined) props.needs_verification = needs_verification;
    if (unverified_locations !== undefined) props.unverified_locations = unverified_locations;
    if (area_label !== undefined) props.area_label = area_label;
    if (barangays !== undefined) props.barangays = barangays;
    if (area_km2 !== undefined) props.area_km2 = area_km2;
    if (matched_streets !== undefined) props.matched_streets = matched_streets;
    if (matched_places !== undefined) props.matched_places = matched_places;
    const rings = polys.flat().map((r) => {
      const pts = r.map((pt) => toXY(geo, pt));
      if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) {
        pts.pop();
      }
      return pts;
    });
    return makeZone(props, rings);
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
