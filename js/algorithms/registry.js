/**
 * Algorithm registry.
 *
 * The benchmark harness never imports a concrete algorithm directly — it asks the
 * registry for whatever is registered. Adding a third algorithm later is one file plus
 * one `registerAlgorithm()` call in `main.js`.
 */

const registry = new Map();

/** Id of the algorithm every result is compared against. */
export const BASELINE_ID = 'astar';

/**
 * Register (or replace) an algorithm. See `customAlgorithm.js` for the full contract.
 * @param {{id:string, name:string, solve:Function}} algorithm
 */
export function registerAlgorithm(algorithm) {
  if (!algorithm || typeof algorithm.id !== 'string' || typeof algorithm.solve !== 'function') {
    throw new Error('registerAlgorithm: an algorithm needs at least { id, name, solve }');
  }
  registry.set(algorithm.id, algorithm);
  return algorithm;
}

/** All registered algorithms, in registration order. */
export function getAlgorithms() {
  return [...registry.values()];
}

export function getAlgorithm(id) {
  return registry.get(id);
}

/**
 * Algorithms that expose tunable settings, for the sidebar to render.
 * An algorithm declares `tunables: [{ id, label, type, min, max, step, value, hint }]`
 * and the values are forwarded to its prepare()/solve() as `options`.
 */
export function getTunableGroups() {
  return [...registry.values()]
    .filter((algorithm) => Array.isArray(algorithm.tunables) && algorithm.tunables.length > 0)
    .map((algorithm) => ({
      algorithmId: algorithm.id,
      algorithmName: algorithm.name,
      tunables: algorithm.tunables,
    }));
}
