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
  };
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
