/** Number formatting helpers shared by every view. */

const DASH = '\u2014';

export function fmtMs(x, digits = 3) {
  return Number.isFinite(x) ? x.toFixed(digits) : DASH;
}

export function fmtNum(x, digits = 2) {
  return Number.isFinite(x) ? x.toFixed(digits) : DASH;
}

export function fmtInt(x) {
  return Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : DASH;
}

export function fmtMeters(x) {
  if (!Number.isFinite(x)) return DASH;
  return x >= 1000 ? `${(x / 1000).toFixed(2)} km` : `${x.toFixed(0)} m`;
}

export function fmtSeconds(x) {
  if (!Number.isFinite(x)) return DASH;
  if (x < 60) return `${x.toFixed(1)} s`;
  const m = Math.floor(x / 60);
  const s = Math.round(x - m * 60);
  return `${m}m ${s}s`;
}

/** Signed percentage, e.g. "+12.4%". */
export function fmtDeltaPct(x, digits = 1) {
  if (!Number.isFinite(x)) return DASH;
  const sign = x > 0 ? '+' : '';
  return `${sign}${x.toFixed(digits)}%`;
}

/** Percentage change of `value` relative to `base`, in percent. */
export function pctChange(value, base) {
  if (!Number.isFinite(value) || !Number.isFinite(base) || base === 0) return NaN;
  return ((value - base) / base) * 100;
}

/** Speed-up factor: base / value. */
export function ratio(base, value) {
  if (!Number.isFinite(base) || !Number.isFinite(value) || value === 0) return NaN;
  return base / value;
}

/** CSS class describing whether a change is good or bad. `lowerIsBetter` flips the meaning. */
export function deltaClass(deltaPct, lowerIsBetter = true) {
  if (!Number.isFinite(deltaPct) || Math.abs(deltaPct) < 0.05) return 'flat';
  const better = lowerIsBetter ? deltaPct < 0 : deltaPct > 0;
  return better ? 'up' : 'down';
}
