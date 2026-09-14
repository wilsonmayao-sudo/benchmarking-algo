/**
 * Deterministic pseudo-random number generator.
 *
 * Every scenario stage (network, elevation, traffic, closures, endpoints) gets its own
 * seed derived from the scenario seed, so that changing one condition does not perturb
 * the others. That keeps scenario comparison controlled and lets both algorithms be
 * fed byte-identical inputs on every run.
 */

/**
 * mulberry32 — small, fast, good enough for scenario generation.
 * @param {number} seed
 * @returns {() => number} generator returning floats in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, n). */
export function randInt(rng, n) {
  return Math.min(n - 1, Math.floor(rng() * n));
}

/** Float in [min, max). */
export function randRange(rng, min, max) {
  return min + rng() * (max - min);
}

/** Pick one element. */
export function pick(rng, arr) {
  return arr[randInt(rng, arr.length)];
}

/** Fisher–Yates shuffle (in place). */
export function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/**
 * Weighted sampling without replacement (Efraimidis–Spirakis).
 * Returns the `k` indices with the largest keys rng^(1/weight).
 *
 * @param {() => number} rng
 * @param {number[]} weights  per-index weight, must be > 0
 * @param {number} k
 * @returns {number[]} selected indices
 */
export function weightedSampleWithoutReplacement(rng, weights, k) {
  const n = weights.length;
  const count = Math.max(0, Math.min(k, n));
  const keys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = weights[i] > 0 ? weights[i] : 1e-9;
    keys[i] = Math.pow(rng(), 1 / w);
  }
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => keys[b] - keys[a]);
  return idx.slice(0, count);
}
