/**
 * Real-life incidents for the fleet simulation.
 *
 * Three groups:
 *   road   — becomes a ROAD_CLOSURE or TRAFFIC_DELAY on one road (the existing road-event
 *            machinery does the rerouting); `cause` keeps the real-life reason for the UI.
 *   bin    — something wrong at a collection stop: the bin is gone, access is blocked,
 *            it is damaged, or it is overflowing (heavier + slower to empty).
 *   truck  — the truck itself stops for a while: breakdown or flat tire.
 *
 * Random incidents are placed when they happen, next to the trucks that are working at that
 * moment (see Simulation#edgeNearTrucks / #binNearTrucks / #truckNearWork), so every event
 * shows up where it matters instead of on some far corner of the city.
 */

export const INCIDENTS = {
  // ------------------------------------------------------------- road
  ROAD_ACCIDENT:   { group: 'road', type: 'ROAD_CLOSURE', label: 'Road accident', short: 'Accident', icon: '💥', duration: [600, 1800] },
  FLOODED_ROAD:    { group: 'road', type: 'ROAD_CLOSURE', label: 'Flooded road', short: 'Flood', icon: '🌊', duration: [1800, 5400] },
  STALLED_VEHICLE: { group: 'road', type: 'ROAD_CLOSURE', label: 'Stalled vehicle', short: 'Stalled vehicle', icon: '🚙', duration: [300, 900] },
  PROCESSION:      { group: 'road', type: 'ROAD_CLOSURE', label: 'Procession / fiesta', short: 'Procession', icon: '🎉', duration: [900, 2700] },
  ROAD_WORKS:      { group: 'road', type: 'TRAFFIC_DELAY', label: 'Road works', short: 'Road works', icon: '🚧', factor: [1.8, 3], duration: [1800, 7200] },
  HEAVY_TRAFFIC:   { group: 'road', type: 'TRAFFIC_DELAY', label: 'Heavy traffic', short: 'Traffic', icon: '🚗', factor: [1.5, 3], duration: [300, 1200] },
  HEAVY_RAIN:      { group: 'road', type: 'TRAFFIC_DELAY', label: 'Heavy rain', short: 'Rain', icon: '🌧️', factor: [1.3, 1.8], duration: [900, 2700] },
  // -------------------------------------------------------------- bin
  BIN_MISSING:     { group: 'bin', label: 'Bin missing', short: 'Missing', icon: '❓' },
  BIN_BLOCKED:     { group: 'bin', label: 'Bin access blocked', short: 'Blocked', icon: '⛔', extra: [300, 900] },
  BIN_DAMAGED:     { group: 'bin', label: 'Damaged bin', short: 'Damaged', icon: '🛠️', extra: [180, 480] },
  BIN_OVERFLOW:    { group: 'bin', label: 'Overflowing bin', short: 'Overflowing', icon: '🗑️', extra: [120, 300], factor: [1.3, 1.8] },
  // ------------------------------------------------------------ truck
  TRUCK_BREAKDOWN: { group: 'truck', label: 'Truck breakdown', short: 'Breakdown', icon: '🔧', duration: [900, 2400] },
  FLAT_TIRE:       { group: 'truck', label: 'Flat tire', short: 'Flat tire', icon: '🛞', duration: [600, 1200] },
};

/** Default mix for random events when a scenario does not list its own `types`. */
export const DEFAULT_INCIDENT_MIX = {
  HEAVY_TRAFFIC: 0.18,
  ROAD_ACCIDENT: 0.12,
  ROAD_WORKS: 0.07,
  STALLED_VEHICLE: 0.08,
  FLOODED_ROAD: 0.05,
  HEAVY_RAIN: 0.05,
  PROCESSION: 0.04,
  BIN_BLOCKED: 0.1,
  BIN_DAMAGED: 0.06,
  BIN_OVERFLOW: 0.09,
  BIN_MISSING: 0.06,
  TRUCK_BREAKDOWN: 0.04,
  FLAT_TIRE: 0.06,
};

export const isIncident = (type) => Object.prototype.hasOwnProperty.call(INCIDENTS, type);
/** Bin and truck incidents are not road events: they have no road of their own. */
export const isStopIncident = (type) => isIncident(type) && INCIDENTS[type].group !== 'road';

/** Human label for an event (road events keep their cause). */
export function incidentLabel(ev) {
  const spec = INCIDENTS[ev.cause] || INCIDENTS[ev.type];
  if (spec) return spec.label;
  if (ev.type === 'ROAD_CLOSURE') return 'Road closure';
  if (ev.type === 'ROAD_REOPEN') return 'Road reopened';
  if (ev.type === 'TRAFFIC_DELAY') return ev.isEnd ? 'Delay cleared' : 'Traffic delay';
  return ev.type;
}

export function incidentIcon(ev) {
  const spec = INCIDENTS[ev.cause] || INCIDENTS[ev.type];
  return spec ? spec.icon : '';
}

const mid = ([a, b]) => (a + b) / 2;

/**
 * Turn an incident kind into a simulation event. `draw(range)` returns a value inside the
 * range (seeded random, or the middle for scheduled/manual events).
 */
export function incidentEvent(kind, { time, edge = -1, draw = mid, pick = 0.5, source = 'manual', note = '', near = true, extra = {} } = {}) {
  const spec = INCIDENTS[kind];
  const base = { time, cause: kind, source, note, pick, near };
  if (spec.group === 'road') {
    const ev = { ...base, type: spec.type, edge, duration: Math.round(draw(spec.duration)) };
    if (spec.type === 'TRAFFIC_DELAY') ev.factor = Number(draw(spec.factor).toFixed(2));
    return { ...ev, ...extra };
  }
  const ev = { ...base, type: kind };
  if (spec.extra) ev.extra = Math.round(draw(spec.extra));
  if (spec.factor) ev.factor = Number(draw(spec.factor).toFixed(2));
  if (spec.duration) ev.duration = Math.round(draw(spec.duration));
  return { ...ev, ...extra };
}
