/**
 * Bin model helpers.
 *
 * A bin's lifecycle:   pending → assigned → collected
 *                                      ↘ missed   (still uncollected when the run ends)
 * A bin may move between trucks while "assigned" (handoff) or drop back to "pending"
 * when no truck has room for it.
 *
 * Colour status (for the map) is derived from the fill level:
 *   fill <  medium            → 'low'    (green)
 *   medium ≤ fill < high      → 'medium' (yellow)
 *   fill ≥ high               → 'full'   (red — needs pickup)
 *   collected                 → 'collected' (gray)
 */

export const BIN_STATUS_COLORS = {
  low: '#22c55e',
  medium: '#eab308',
  full: '#ef4444',
  collected: '#6b7280',
  missed: '#6b7280',
};

/** Create the runtime state for a bin from its loaded config. */
export function createBinState(cfg) {
  return {
    ...cfg,
    state: 'pending',        // pending | assigned | collected | missed
    truckId: null,           // truck currently responsible for the bin
    history: [],             // [{time, truckId, reason}] — every (re)assignment
    collectedBy: null,
    collectedAt: null,
    fillAtPickup: null,
    visited: false,
    confirmed: false,
    skipped: false,
  };
}

/**
 * The `limit` most urgent bins (highest fill level first; ties keep list order).
 * A bin emptied during the run keeps its place, so the map does not swap bins while trucks work.
 * Bins in `pinned` (a Set of ids) are shown on top of the limit.
 */
export function visibleBins(bins, limit, pinned = null) {
  if (!(limit < bins.length)) return bins;
  const sorted = bins.slice().sort((a, b) => (b.fillAtPickup ?? b.fill) - (a.fillAtPickup ?? a.fill)); // stable sort
  const shown = sorted.slice(0, limit);
  if (pinned && pinned.size) for (const b of sorted.slice(limit)) if (pinned.has(b.id)) shown.push(b);
  return shown;
}

/** Visual status used for colour-coding (see header). */
export function binStatus(bin, thresholds) {
  if (bin.state === 'collected') return 'collected';
  if (bin.state === 'missed') return 'missed';
  if (bin.fill >= thresholds.high) return 'full';
  if (bin.fill >= thresholds.medium) return 'medium';
  return 'low';
}

export function binColor(bin, thresholds) {
  return BIN_STATUS_COLORS[binStatus(bin, thresholds)];
}
