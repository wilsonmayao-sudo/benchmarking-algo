/**
 * Route areas — geometry of a truck route locked to a polygon. Pure functions, no state.
 *
 * Polygons are arrays of [x, y] in map metres. A road belongs to an area only when the
 * WHOLE road is inside (both ends inside and no crossing of the boundary), so a truck that
 * uses only these roads can never be outside the area, not even half-way along a road.
 */

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const orient = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
const within = (a, b, p) =>
  Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) &&
  Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);

/** Do segments ab and cd meet? Touching counts. */
export function segmentsMeet(a, b, c, d) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && within(a, b, c)) || (o2 === 0 && within(a, b, d)) ||
    (o3 === 0 && within(c, d, a)) || (o4 === 0 && within(c, d, b));
}

/** Does the outline cross itself? */
export function selfCrosses(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // neighbours share a corner
      if (segmentsMeet(poly[i], poly[i + 1], poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** Do two areas share any ground? (Touching outlines count as overlapping.) */
export function polygonsOverlap(p, q) {
  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < q.length; j++) {
      if (segmentsMeet(p[i], p[(i + 1) % p.length], q[j], q[(j + 1) % q.length])) return true;
    }
  }
  return pointInPolygon(p[0][0], p[0][1], q) || pointInPolygon(q[0][0], q[0][1], p);
}

export function polygonArea(poly) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return Math.abs(s) / 2;
}

/**
 * Roads and road corners a truck may use inside `poly`.
 *
 * `core` is the set of corners that can all reach each other without leaving the area
 * (one-way streets included). Trucks start in it and stop only at its corners, so a truck
 * can never drive into a spot it could only leave by crossing the boundary.
 * The connected part with the most bins wins; size breaks ties.
 *
 * @param {Uint8Array|null} [allowed] 1 = corner trucks can drive to and come back from (null = all)
 * @returns {{edgeOk:Uint8Array, inCore:Uint8Array, core:number[]}}
 */
export function buildArea(graph, poly, bins = [], allowed = null) {
  const n = graph.nodeCount;
  const nodeIn = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if ((!allowed || allowed[i] === 1) && pointInPolygon(graph.x[i], graph.y[i], poly)) nodeIn[i] = 1;
  }

  const edgeOk = new Uint8Array(graph.edgeCount);
  for (let e = 0; e < graph.edgeCount; e++) {
    const u = graph.edgeFrom[e], v = graph.edgeTo[e];
    if (!nodeIn[u] || !nodeIn[v]) continue;
    const a = [graph.x[u], graph.y[u]], b = [graph.x[v], graph.y[v]];
    let ok = 1;
    for (let i = 0; ok && i < poly.length; i++) if (segmentsMeet(a, b, poly[i], poly[(i + 1) % poly.length])) ok = 0;
    edgeOk[e] = ok;
  }

  // Strongly connected components (Kosaraju, iterative).
  const order = [];
  const seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (!nodeIn[s] || seen[s]) continue;
    seen[s] = 1;
    const stack = [[s, graph.adjStart[s]]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top[1] < graph.adjStart[top[0] + 1]) {
        const a = top[1]++;
        const v = graph.adjNeighbor[a];
        if (edgeOk[graph.adjEdge[a]] && !seen[v]) { seen[v] = 1; stack.push([v, graph.adjStart[v]]); }
      } else { order.push(top[0]); stack.pop(); }
    }
  }
  const comp = new Int32Array(n).fill(-1);
  const groups = [];
  for (let k = order.length - 1; k >= 0; k--) {
    if (comp[order[k]] >= 0) continue;
    const id = groups.length;
    const group = [];
    const stack = [order[k]];
    comp[order[k]] = id;
    while (stack.length) {
      const v = stack.pop();
      group.push(v);
      for (let r = graph.revStart[v]; r < graph.revStart[v + 1]; r++) {
        const a = graph.revArc[r];
        const u = graph.adjTail[a];
        if (edgeOk[graph.adjEdge[a]] && comp[u] < 0) { comp[u] = id; stack.push(u); }
      }
    }
    groups.push(group);
  }
  const binCount = new Array(groups.length).fill(0);
  for (const b of bins) if (comp[b.homeNode] >= 0) binCount[comp[b.homeNode]]++;
  let best = -1;
  groups.forEach((g, i) => {
    if (g.length < 2) return;
    if (best < 0 || binCount[i] > binCount[best] || (binCount[i] === binCount[best] && g.length > groups[best].length)) best = i;
  });
  const inCore = new Uint8Array(n);
  const core = best >= 0 ? groups[best] : [];
  for (const v of core) inCore[v] = 1;
  return { edgeOk, inCore, core };
}

/** Nearest node to (x, y) among `nodes`, as { node, dist }. */
export function nearestOf(graph, nodes, x, y) {
  let node = -1;
  let best = Infinity;
  for (const i of nodes) {
    const d = (graph.x[i] - x) ** 2 + (graph.y[i] - y) ** 2;
    if (d < best) { best = d; node = i; }
  }
  return { node, dist: Math.sqrt(best) };
}
