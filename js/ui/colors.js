/**
 * Shared colour palette and ramps.
 *
 * Kept in one place so the canvases and the HTML legend can never drift apart.
 */

export const UI = {
  background: '#0f172a',
  edge: '#243244',
  edgeArterial: '#33455c',
  closedEdge: '#7f1d1d',
  node: '#1e2b3c',
  start: '#22c55e',
  goal: '#ef4444',
  stop: '#f59e0b',
  markerRing: '#e6edf3',
  text: '#8b9bb0',
  labelBg: 'rgba(15, 23, 42, 0.88)',
};

const TRAFFIC_STOPS = [
  [0.0, [34, 197, 94]],   // free flow — green
  [0.5, [234, 179, 8]],   // busy — amber
  [1.0, [239, 68, 68]],   // congested — red
];

const ELEVATION_STOPS = [
  [0.0, [29, 78, 216]],   // low — deep blue
  [0.25, [14, 165, 233]], // sky
  [0.5, [34, 197, 94]],   // green valley
  [0.72, [161, 98, 7]],   // brown slope
  [1.0, [231, 229, 228]], // white peak
];

/** Lowest traffic multiplier produced by the generator. */
export const MIN_TRAFFIC = 0.12;

/** Colour for a road given its traffic multiplier (1 = free flow). */
export function trafficColor(factor) {
  const t = clamp01((1 - factor) / (1 - MIN_TRAFFIC));
  return rampColor(TRAFFIC_STOPS, t);
}

/** Colour for an elevation ratio in [0, 1]. */
export function elevationColor(t) {
  return rampColor(ELEVATION_STOPS, clamp01(t));
}

/** CSS gradient string for the legend swatches. */
export function rampCss(stops) {
  const parts = stops.map(([pos, rgb]) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]}) ${Math.round(pos * 100)}%`);
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

export const trafficRampCss = () => rampCss(TRAFFIC_STOPS);
export const elevationRampCss = () => rampCss(ELEVATION_STOPS);

/** Same colour with an alpha channel. */
export function withAlpha(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const int = parseInt(full, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function rampColor(stops, t) {
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i];
    const [p1, c1] = stops[i + 1];
    if (t <= p1) {
      const local = p1 === p0 ? 0 : (t - p0) / (p1 - p0);
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * local);
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * local);
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * local);
      return `rgb(${r}, ${g}, ${b})`;
    }
  }
  const last = stops[stops.length - 1][1];
  return `rgb(${last[0]}, ${last[1]}, ${last[2]})`;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
