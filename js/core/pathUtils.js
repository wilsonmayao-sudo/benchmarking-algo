/**
 * Path helpers.
 *
 * IMPORTANT: every path metric used in the results table is produced here, by the
 * harness — never by the algorithm itself. That removes any chance of one algorithm
 * reporting its distance/cost differently from the other.
 */

/**
 * Walk `cameFrom` backwards from goal to start.
 * @returns {number[]|null} node ids from start to goal, or null if broken
 */
export function reconstructPath(cameFrom, start, goal) {
  const path = [];
  let cur = goal;
  let guard = cameFrom.length + 1;
  while (cur !== -1 && guard-- > 0) {
    path.push(cur);
    if (cur === start) break;
    cur = cameFrom[cur];
  }
  path.reverse();
  return path.length > 0 && path[0] === start ? path : null;
}

/** Index of the directed arc u→v, or -1 when the two nodes are not adjacent. */
export function findArc(graph, u, v) {
  const end = graph.adjStart[u + 1];
  for (let a = graph.adjStart[u]; a < end; a++) {
    if (graph.adjNeighbor[a] === v) return a;
  }
  return -1;
}

/**
 * Independently verify and measure a returned path.
 *
 * Checks performed:
 *   • non-empty and starts at `start`, ends at `goal`
 *   • every consecutive pair is connected by a real road
 *   • no closed road is used (cost must be finite)
 *
 * @returns {{valid:boolean, reason:string, distance:number, cost:number, time:number, arcs:number}}
 */
export function evaluatePath(graph, costModel, path, start, goal) {
  const empty = { valid: false, reason: '', distance: NaN, cost: NaN, time: NaN, arcs: 0 };

  if (!Array.isArray(path) || path.length === 0) {
    return { ...empty, reason: 'no path returned' };
  }
  if (path.length === 1) {
    const ok = path[0] === start && start === goal;
    return { valid: ok, reason: ok ? '' : 'trivial path is not start→goal', distance: 0, cost: 0, time: 0, arcs: 0 };
  }
  if (path[0] !== start) return { ...empty, reason: 'path does not start at the origin' };
  if (path[path.length - 1] !== goal) return { ...empty, reason: 'path does not end at the destination' };

  let distance = 0;
  let cost = 0;
  let time = 0;
  let arcs = 0;
  let closedReason = '';

  for (let i = 0; i < path.length - 1; i++) {
    const u = path[i];
    const v = path[i + 1];
    const a = findArc(graph, u, v);
    if (a < 0) return { ...empty, reason: `nodes ${u} and ${v} are not connected` };

    const c = costModel.costOf(a);
    const e = graph.adjEdge[a];
    if (!Number.isFinite(c)) {
      if (!closedReason) closedReason = `path uses closed road ${e}`;
    }

    distance += graph.edgeLength[e];
    // If a closed road was used, apply a 15-minute (900s) blockage/detour penalty in travel time
    cost += Number.isFinite(c) ? c : 10000;
    time += Number.isFinite(costModel.timeOf(a)) ? costModel.timeOf(a) : 900;
    arcs++;
  }

  if (closedReason) {
    return { valid: false, reason: closedReason, distance, cost, time, arcs };
  }

  return { valid: true, reason: '', distance, cost, time, arcs };
}
