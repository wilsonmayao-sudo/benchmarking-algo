/**
 * Mapbox Traffic Snapshot & Congestion Adapter (`R04`).
 *
 * Translates Mapbox Directions v5 `annotation` payloads (`speed`, `duration`,
 * `congestion`, `distance`) or deterministic traffic profiles into `RoadState`
 * overlays while cleanly handling normal, congested, missing, stale, and
 * offline states without fabricating live telemetry.
 */

import { ROAD_CLASS } from '../../core/graph.js';
import { mulberry32 } from '../../core/rng.js';

export const CONGESTION_MULTIPLIERS = {
  low: 1.0,
  moderate: 1.35,
  heavy: 2.0,
  severe: 3.2,
};

/**
 * Parse a Mapbox Directions v5 response (with `routes[0].legs[].annotation`)
 * and map segment congestion/speeds onto the nearest graph edges.
 *
 * @param {import('../../core/graph.js').Graph} graph
 * @param {import('./roadState.js').RoadState} road
 * @param {object} payload Mapbox API response or snapshot `{ fetchedAtS, geo, routes }`
 * @param {{nowS?:number, ttlS?:number, geo?:{minLat:number,minLon:number,mPerLat:number,mPerLon:number}, maxMatchDistM?:number}} [opts]
 */
export function applyMapboxAnnotations(graph, road, payload, opts = {}) {
  const nowS = opts.nowS ?? 0;
  const ttlS = opts.ttlS ?? 300;
  const maxMatchDistM = opts.maxMatchDistM ?? 60;
  const geo = opts.geo || payload?.geo || null;

  if (!payload || !Array.isArray(payload.routes) || payload.routes.length === 0) {
    road.clearLiveSpeeds();
    road.setTrafficStatus('missing', nowS);
    return { status: 'missing', matchedEdges: 0, missingSegments: 0, stale: false, updatedAt: nowS };
  }

  const fetchedAtS = Number.isFinite(payload.fetchedAtS) ? payload.fetchedAtS : nowS;
  const stale = nowS - fetchedAtS > ttlS;

  const route = payload.routes[0];
  const legs = Array.isArray(route.legs) ? route.legs : [];
  let matchedEdges = 0;
  let missingSegments = 0;
  let congestedSegments = 0;

  // Build midpoint index of edges in graph metres for nearest-edge matching
  const midX = new Float64Array(graph.edgeCount);
  const midY = new Float64Array(graph.edgeCount);
  for (let e = 0; e < graph.edgeCount; e++) {
    const u = graph.edgeFrom[e];
    const v = graph.edgeTo[e];
    midX[e] = 0.5 * (graph.x[u] + graph.x[v]);
    midY[e] = 0.5 * (graph.y[u] + graph.y[v]);
  }

  const maxDistSq = maxMatchDistM * maxMatchDistM;

  for (const leg of legs) {
    const ann = leg.annotation || {};
    const speeds = Array.isArray(ann.speed) ? ann.speed : [];
    const congestion = Array.isArray(ann.congestion) ? ann.congestion : [];
    const coords = Array.isArray(leg.coordinates)
      ? leg.coordinates
      : (Array.isArray(ann.coordinates) ? ann.coordinates : []);

    const count = Math.max(speeds.length, congestion.length);
    for (let i = 0; i < count; i++) {
      let edge = Array.isArray(ann.edgeIndices) && Number.isInteger(ann.edgeIndices[i])
        ? ann.edgeIndices[i]
        : -1;

      if (edge < 0 && coords.length > i + 1 && geo) {
        const mx = 0.5 * ((coords[i][0] - geo.minLon) * geo.mPerLon + (coords[i + 1][0] - geo.minLon) * geo.mPerLon);
        const my = 0.5 * ((coords[i][1] - geo.minLat) * geo.mPerLat + (coords[i + 1][1] - geo.minLat) * geo.mPerLat);
        let bestD = maxDistSq;
        for (let e = 0; e < graph.edgeCount; e++) {
          const d = (midX[e] - mx) ** 2 + (midY[e] - my) ** 2;
          if (d <= bestD) { bestD = d; edge = e; }
        }
      }
      if (edge < 0 || edge >= graph.edgeCount) continue;

      const rawSpeed = speeds[i];
      const rawCong = congestion[i];
      const freeSpeed = graph.edgeSpeedLimit[edge] > 0 ? graph.edgeSpeedLimit[edge] : 11.1;

      if (stale) {
        // Stale snapshot: blend toward free-flow by 50% and clear unverified drops
        if (Number.isFinite(rawSpeed) && rawSpeed > 0) {
          const clamped = Math.min(freeSpeed, rawSpeed);
          road.setLiveSpeed(edge, 0.5 * (clamped + freeSpeed));
          matchedEdges++;
        } else {
          missingSegments++;
        }
        continue;
      }

      if (Number.isFinite(rawSpeed) && rawSpeed > 0) {
        const effective = Math.min(freeSpeed, Math.max(1.5, rawSpeed));
        road.setLiveSpeed(edge, effective);
        if (effective < freeSpeed * 0.85) congestedSegments++;
        matchedEdges++;
      } else if (typeof rawCong === 'string' && CONGESTION_MULTIPLIERS[rawCong] !== undefined) {
        const mult = CONGESTION_MULTIPLIERS[rawCong];
        road.setLiveSpeed(edge, freeSpeed / mult);
        if (mult > 1.1) congestedSegments++;
        matchedEdges++;
      } else {
        missingSegments++;
      }
    }
  }

  let status = 'normal';
  if (stale) status = 'stale';
  else if (matchedEdges === 0 && missingSegments > 0) status = 'missing';
  else if (congestedSegments > 0) status = 'congested';

  road.setTrafficStatus(status, fetchedAtS);
  return { status, matchedEdges, missingSegments, congestedSegments, stale, updatedAt: fetchedAtS };
}

/**
 * Apply a reproducible traffic scenario profile to `RoadState` for benchmarking.
 * Profiles: 'normal' | 'congested' | 'missing' | 'stale' | 'offline'
 */
export function applyTrafficSnapshot(graph, road, profile = 'normal', seed = 1, nowS = 0) {
  road.clearLiveSpeeds();
  road.setOffline(profile === 'offline');

  if (profile === 'offline') {
    road.setTrafficStatus('offline', nowS);
    return { status: 'offline', affectedEdges: 0 };
  }
  if (profile === 'missing') {
    road.setTrafficStatus('missing', nowS);
    return { status: 'missing', affectedEdges: 0 };
  }

  const rng = mulberry32((seed >>> 0) || 1);
  let affected = 0;

  for (let e = 0; e < graph.edgeCount; e++) {
    const isArterial = graph.edgeClass[e] === ROAD_CLASS.ARTERIAL;
    const free = graph.edgeSpeedLimit[e] > 0 ? graph.edgeSpeedLimit[e] : 11.1;

    if (profile === 'congested') {
      // Heavy urban arterial congestion (moderate–severe), milder local slowdowns
      const roll = rng();
      if (isArterial && roll < 0.65) {
        const mult = roll < 0.25 ? CONGESTION_MULTIPLIERS.severe : CONGESTION_MULTIPLIERS.heavy;
        road.setLiveSpeed(e, free / mult);
        affected++;
      } else if (!isArterial && roll < 0.22) {
        road.setLiveSpeed(e, free / CONGESTION_MULTIPLIERS.moderate);
        affected++;
      }
    } else if (profile === 'stale') {
      // Stale snapshot (15 min old): partial arterial slowdowns blended toward free-flow
      const roll = rng();
      if (isArterial && roll < 0.35) {
        const mult = 1.45;
        road.setLiveSpeed(e, free / mult);
        affected++;
      }
    } else {
      // 'normal': light realistic daytime slowdowns on 15% of arterials
      const roll = rng();
      if (isArterial && roll < 0.15) {
        road.setLiveSpeed(e, free / CONGESTION_MULTIPLIERS.moderate);
        affected++;
      }
    }
  }

  const status = profile === 'stale' ? 'stale' : profile === 'congested' ? 'congested' : 'normal';
  road.setTrafficStatus(status, profile === 'stale' ? nowS - 900 : nowS);
  return { status, affectedEdges: affected };
}
