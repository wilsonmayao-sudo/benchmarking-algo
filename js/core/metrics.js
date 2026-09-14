/**
 * Statistical aggregation for benchmark runs.
 */

/**
 * @param {number[]} values
 * @returns {{count:number, avg:number, min:number, max:number, median:number, stddev:number, values:number[]}}
 *          Non-finite entries (failed runs) are ignored; if nothing is finite every
 *          statistic is NaN, which the UI renders as an em dash.
 */
export function summarize(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) {
    return { count: 0, avg: NaN, min: NaN, max: NaN, median: NaN, stddev: NaN, values };
  }

  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of finite) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const avg = sum / finite.length;

  let variance = 0;
  for (const v of finite) variance += (v - avg) * (v - avg);
  variance /= finite.length;

  const sorted = [...finite].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];

  return {
    count: finite.length,
    avg,
    min,
    max,
    median,
    stddev: Math.sqrt(variance),
    values,
  };
}
