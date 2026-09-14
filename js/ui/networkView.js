/**
 * Canvas renderer for the road network and the search results.
 *
 * Draw order (bottom → top):
 *   1. roads, coloured by traffic level            (closed roads dashed, drawn last)
 *   2. nodes, shaded by elevation
 *   3. expanded nodes of each visible algorithm, in three tiers
 *   4. the resulting routes
 *   5. origin / destination markers
 *
 * MAKING THE SEARCH READABLE
 *   A 6 000-node network squeezed into 700 px puts every node well under a pixel, so a
 *   uniform cloud of dots tells you nothing. Three things fix that:
 *     • while a playback is mid-flight the road network is dimmed, so the coloured
 *       search cloud is the brightest thing on screen;
 *     • the expansions are drawn in tiers — a broad faint cloud for settled nodes, a
 *       bright band for the recent wavefront, and a ringed marker on the very last node
 *       expanded, which is the point you can follow growing across the map;
 *     • scroll to zoom and drag to pan, so a dense network can actually be inspected.
 *
 * Two overlapping routes are drawn with a halo: the wider line underneath stays visible
 * around the narrower one, so identical routes read as a two-tone line while divergent
 * routes separate clearly.
 */

import { UI, trafficColor, elevationColor, withAlpha, MIN_TRAFFIC } from './colors.js';

const PAD = 10;
const NODE_RADIUS = 1.5;

/** Expanded-node tiers. */
const SETTLED_RADIUS = 2.3;
const FRONTIER_RADIUS = 3.2;
const CURRENT_RADIUS = 4.6;
/** How many of the most recent expansions count as "the wavefront". */
const FRONTIER_TAIL = 90;

/** Route stroking: a wide halo with a brighter core on top. */
const ROUTE_HALO_WIDTH = 7;
const ROUTE_CORE_WIDTH = 3.2;

/** Zoom limits, as a fraction / multiple of the whole network's extent. */
const MIN_SPAN_FRACTION = 0.01;
const MAX_SPAN_MULTIPLE = 4;

/** Number of colour bins used when drawing traffic-coloured roads. */
const TRAFFIC_BUCKETS = 10;

/** Bin index for a traffic multiplier (1 = free flow, MIN_TRAFFIC = jammed). */
function trafficBucket(factor) {
  const t = (1 - factor) / (1 - MIN_TRAFFIC);
  const b = Math.floor(t * TRAFFIC_BUCKETS);
  return b < 0 ? 0 : b >= TRAFFIC_BUCKETS ? TRAFFIC_BUCKETS - 1 : b;
}

/** Representative traffic multiplier of a bin, used to pick its colour. */
function bucketCentreFactor(bin) {
  return 1 - ((bin + 0.5) / TRAFFIC_BUCKETS) * (1 - MIN_TRAFFIC);
}

/** A route needs at least two revealed vertices before it can be stroked. */
function layoutHasDrawablePath(layer) {
  if (!layer.path || layer.path.length < 2) return false;
  if (layer.revealedPath === undefined) return true;
  return layer.revealedPath >= 2;
}

// ===========================================================================
//  Pure view-transform maths
//
//  Kept as free functions rather than private methods so they can be verified headlessly
//  (see tools/selfcheck.mjs). Zoom/pan bugs are invisible until you interact with the
//  canvas, which is exactly the wrong time to discover them.
// ===========================================================================

/**
 * Fit a world rectangle into a `cssW × cssH` box, preserving aspect ratio.
 * Screen y is flipped so that larger world y is higher on screen.
 * @returns {{scale:number, ox:number, oy:number}}
 */
export function computeTransform(rect, cssW, cssH) {
  const spanX = Math.max(1e-6, rect.x1 - rect.x0);
  const spanY = Math.max(1e-6, rect.y1 - rect.y0);
  const availW = Math.max(1, cssW - PAD * 2);
  const availH = Math.max(1, cssH - PAD * 2);

  const scale = Math.min(availW / spanX, availH / spanY);
  return {
    scale,
    ox: PAD + (availW - spanX * scale) / 2 - rect.x0 * scale,
    oy: PAD + (availH - spanY * scale) / 2 + rect.y1 * scale,
  };
}

/** Canvas-relative screen point → world coordinates. */
export function screenToWorld(t, screenX, screenY) {
  return { x: (screenX - t.ox) / t.scale, y: (t.oy - screenY) / t.scale };
}

/** Scale a rectangle about a fixed world point. */
export function zoomRect(rect, worldX, worldY, factor) {
  return {
    x0: worldX - (worldX - rect.x0) / factor,
    x1: worldX + (rect.x1 - worldX) / factor,
    y0: worldY - (worldY - rect.y0) / factor,
    y1: worldY + (rect.y1 - worldY) / factor,
  };
}

/** Shift a rectangle by a screen-space delta. */
export function panRect(rect, scale, dxScreen, dyScreen) {
  const dx = dxScreen / scale;
  const dy = dyScreen / scale;
  // screen y grows downwards while world y grows upwards
  return { x0: rect.x0 - dx, x1: rect.x1 - dx, y0: rect.y0 + dy, y1: rect.y1 + dy };
}

/** Clamp zoom to a sane band around the full network extent, keeping the centre. */
export function clampRect(rect, bounds, minFraction = MIN_SPAN_FRACTION, maxMultiple = MAX_SPAN_MULTIPLE) {
  const fullW = Math.max(1e-6, bounds.maxX - bounds.minX);
  const fullH = Math.max(1e-6, bounds.maxY - bounds.minY);

  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  const w = Math.min(fullW * maxMultiple, Math.max(fullW * minFraction, rect.x1 - rect.x0));
  const h = Math.min(fullH * maxMultiple, Math.max(fullH * minFraction, rect.y1 - rect.y0));

  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
}

export class NetworkView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onViewChange?:(rect:object|null)=>void}} [options]
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.graph = null;
    this.start = -1;
    this.goal = -1;
    this.layers = [];
    this.options = { explored: true, closed: true, traffic: true, elevation: true };
    this._cssW = 1;
    this._cssH = 1;
    this._dpr = 1;
    /** Opacity of the cached road network; lowered during playback to make the search pop. */
    this._baseAlpha = 1;
    /** World-space rectangle on show, or null to fit the whole network. */
    this._viewBox = null;
    this._onViewChange = options.onViewChange || (() => {});

    // The road network and node dots never change once a scenario is loaded, so they are
    // painted once into an offscreen canvas and blitted each frame. Without this, the
    // slow-motion playback would redraw ~11 000 roads 60 times a second.
    this._base = document.createElement('canvas');
    this._baseCtx = this._base.getContext('2d');
    this._baseDirty = true;

    this._attachInteraction();
  }

  /** Point the view at a test case (roads + endpoints). Clears previous layers. */
  setData(testCase) {
    this.graph = testCase ? testCase.graph : null;
    this.start = testCase ? testCase.start : -1;
    this.goal = testCase ? testCase.goal : -1;
    this.startLabel = 'origin';
    this.goalLabel = 'destination';
    this.layers = [];
    this._bounds = null;
    this._viewBox = null; // a new network starts fitted
    this._baseDirty = true;
  }

  /**
   * Move the endpoint markers. Pass -1 to hide one. Used because a collection round starts
   * at a depot rather than the single-trip origin.
   */
  setEndpoints(start, goal, startLabel = 'origin', goalLabel = 'destination') {
    this.start = start;
    this.goal = goal;
    this.startLabel = startLabel;
    this.goalLabel = goalLabel;
  }

  /**
   * @param {Array<{id:string,color:string,path:number[]|null,exploredNodes:number[]|null,label:string}>} layers
   */
  setLayers(layers) {
    this.layers = layers || [];
  }

  setOptions(options) {
    Object.assign(this.options, options);
    this._baseDirty = true;
  }

  /**
   * Reveal only part of each layer, for the slow-motion playback.
   * @param {Map<string, {revealedNodes:number, revealedPath:number}>} revealById
   */
  setReveal(revealById) {
    for (const layer of this.layers) {
      const reveal = revealById.get(layer.id);
      layer.revealedNodes = reveal ? reveal.revealedNodes : undefined;
      layer.revealedPath = reveal ? reveal.revealedPath : undefined;
    }
  }

  /** Show every layer in full again. */
  clearReveal() {
    for (const layer of this.layers) {
      layer.revealedNodes = undefined;
      layer.revealedPath = undefined;
    }
  }

  /** Dim the cached road network so the search overlay stands out. 1 = normal. */
  setBaseAlpha(alpha) {
    const value = Math.max(0, Math.min(1, alpha));
    if (Math.abs(value - this._baseAlpha) < 0.01) return;
    this._baseAlpha = value;
  }

  /** Show a world-space rectangle, or null to fit everything. */
  setViewBox(rect) {
    this._viewBox = rect ? { ...rect } : null;
    this._baseDirty = true;
  }

  resetView() {
    this.setViewBox(null);
  }

  // ------------------------------------------------------ zoom & pan input

  _attachInteraction() {
    const canvas = this.canvas;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    canvas.style.cursor = 'grab';

    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      // Trackpad/notch scrolling both land here; 1.0015^deltaY is a comfortable rate.
      const factor = Math.pow(1.0015, -event.deltaY);
      this._onViewChange(this._zoomRect(event.clientX, event.clientY, factor));
    }, { passive: false });

    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      this._onViewChange(this._panRect(dx, dy));
    });

    const endDrag = (event) => {
      if (!dragging) return;
      dragging = false;
      if (canvas.hasPointerCapture && canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      canvas.style.cursor = 'grab';
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener('dblclick', () => this._onViewChange(null));
  }

  /** Zoom by `factor` while keeping the world point under the cursor fixed. */
  _zoomRect(clientX, clientY, factor) {
    if (!this.graph || !this._t) return this._viewBox;
    const box = this.canvas.getBoundingClientRect();
    const world = screenToWorld(this._t, clientX - box.left, clientY - box.top);
    const view = this._viewBox || this._fullRect();
    return clampRect(zoomRect(view, world.x, world.y, factor), this._bounds);
  }

  /** Shift the view by a screen-space delta. */
  _panRect(dxScreen, dyScreen) {
    if (!this.graph || !this._t) return this._viewBox;
    const view = this._viewBox || this._fullRect();
    return clampRect(panRect(view, this._t.scale, dxScreen, dyScreen), this._bounds);
  }

  _fullRect() {
    if (!this._bounds && this.graph) this._bounds = this.graph.bounds();
    const b = this._bounds;
    return { x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY };
  }

  /** Size the backing store to the CSS box (HiDPI aware) and redraw. */
  render() {
    const ctx = this.ctx;
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Resizing the backing store clears it and reallocates, so only do it on change —
    // otherwise every animation frame would pay for it.
    const deviceW = Math.round(w * dpr);
    const deviceH = Math.round(h * dpr);
    if (this.canvas.width !== deviceW || this.canvas.height !== deviceH) {
      this.canvas.width = deviceW;
      this.canvas.height = deviceH;
    }
    this._cssW = w;
    this._cssH = h;
    this._dpr = dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (!this.graph) {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = UI.background;
      ctx.fillRect(0, 0, w, h);
      return;
    }

    this._computeTransform();
    this._drawBase();
    this._drawExpanded();
    this._drawRoutes();
    this._drawStops();
    this._drawEndpoints();
  }

  /** Pickup points of a collection round, drawn over the routes so they stay visible. */
  _drawStops() {
    const g = this.graph;
    const ctx = this.ctx;

    for (const layer of this.layers) {
      if (!layer.stops || layer.stops.length === 0) continue;
      ctx.beginPath();
      for (const node of layer.stops) {
        const x = this._sx(g.x[node]);
        const y = this._sy(g.y[node]);
        ctx.moveTo(x + 3.4, y);
        ctx.arc(x, y, 3.4, 0, Math.PI * 2);
      }
      ctx.fillStyle = UI.stop;
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = UI.markerRing;
      ctx.stroke();
    }
  }

  /** Blit the cached road network, repainting it only when something changed. */
  _drawBase() {
    const w = this._cssW;
    const h = this._cssH;
    const dpr = this._dpr;

    if (this._base.width !== Math.round(w * dpr) || this._base.height !== Math.round(h * dpr)) {
      this._base.width = Math.round(w * dpr);
      this._base.height = Math.round(h * dpr);
      this._baseDirty = true;
    }

    if (this._baseDirty) {
      const bctx = this._baseCtx;
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.clearRect(0, 0, w, h);
      bctx.fillStyle = UI.background;
      bctx.fillRect(0, 0, w, h);
      this._drawRoads(bctx);
      this._drawNodes(bctx);
      this._baseDirty = false;
    }

    if (this._baseAlpha >= 1) {
      this.ctx.drawImage(this._base, 0, 0, w, h);
    } else {
      this.ctx.save();
      this.ctx.globalAlpha = this._baseAlpha;
      this.ctx.drawImage(this._base, 0, 0, w, h);
      this.ctx.restore();
    }
  }

  // -------------------------------------------------------------- transform

  _computeTransform() {
    if (!this._bounds) this._bounds = this.graph.bounds();
    this._t = computeTransform(this._viewBox || this._fullRect(), this._cssW, this._cssH);
  }

  _sx(x) {
    return this._t.ox + x * this._t.scale;
  }

  _sy(y) {
    return this._t.oy - y * this._t.scale;
  }

  // ------------------------------------------------------------------ roads

  _drawRoads(ctx) {
    const g = this.graph;

    ctx.lineCap = 'round';
    ctx.lineWidth = 1;

    // Open roads first; closed ones are drawn dashed afterwards.
    if (this.options.traffic) {
      // Roads are binned into a handful of colour buckets, so the renderer issues
      // ~10 strokes instead of one per road. Visually identical, far faster on
      // networks with tens of thousands of roads.
      const buckets = [];
      for (let b = 0; b < TRAFFIC_BUCKETS; b++) buckets.push([]);

      for (let e = 0; e < g.edgeCount; e++) {
        if (g.edgeClosed[e] === 1) continue;
        const u = g.edgeFrom[e];
        const v = g.edgeTo[e];
        buckets[trafficBucket(g.edgeTraffic[e])].push(
          this._sx(g.x[u]), this._sy(g.y[u]),
          this._sx(g.x[v]), this._sy(g.y[v]),
        );
      }

      for (let b = 0; b < TRAFFIC_BUCKETS; b++) {
        const coords = buckets[b];
        if (coords.length === 0) continue;
        ctx.strokeStyle = trafficColor(bucketCentreFactor(b));
        ctx.beginPath();
        for (let i = 0; i < coords.length; i += 4) {
          ctx.moveTo(coords[i], coords[i + 1]);
          ctx.lineTo(coords[i + 2], coords[i + 3]);
        }
        ctx.stroke();
      }
    } else {
      // Minor roads, then arterials on top of them.
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass === 0 ? UI.edge : UI.edgeArterial;
        ctx.beginPath();
        for (let e = 0; e < g.edgeCount; e++) {
          if (g.edgeClosed[e] === 1) continue;
          if ((g.edgeClass[e] === 1 ? 1 : 0) !== pass) continue;
          const u = g.edgeFrom[e];
          const v = g.edgeTo[e];
          ctx.moveTo(this._sx(g.x[u]), this._sy(g.y[u]));
          ctx.lineTo(this._sx(g.x[v]), this._sy(g.y[v]));
        }
        ctx.stroke();
      }
    }

    // closed roads, dashed and dark so they read as "not available"
    if (this.options.closed) {
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = UI.closedEdge;
      ctx.beginPath();
      for (let e = 0; e < g.edgeCount; e++) {
        if (g.edgeClosed[e] !== 1) continue;
        const u = g.edgeFrom[e];
        const v = g.edgeTo[e];
        ctx.moveTo(this._sx(g.x[u]), this._sy(g.y[u]));
        ctx.lineTo(this._sx(g.x[v]), this._sy(g.y[v]));
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  // ------------------------------------------------------------------ nodes

  _drawNodes(ctx) {
    const g = this.graph;
    const { minE, maxE } = this._bounds;
    const elevSpan = Math.max(1e-9, maxE - minE);

    if (this.options.elevation) {
      let lastColor = null;
      for (let i = 0; i < g.nodeCount; i++) {
        const color = elevationColor((g.elevation[i] - minE) / elevSpan);
        if (color !== lastColor) {
          ctx.fillStyle = color;
          lastColor = color;
        }
        ctx.beginPath();
        ctx.arc(this._sx(g.x[i]), this._sy(g.y[i]), NODE_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = UI.node;
      ctx.beginPath();
      for (let i = 0; i < g.nodeCount; i++) {
        ctx.moveTo(this._sx(g.x[i]) + NODE_RADIUS, this._sy(g.y[i]));
        ctx.arc(this._sx(g.x[i]), this._sy(g.y[i]), NODE_RADIUS, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }

  // ------------------------------------------------------- expanded frontier

  _drawExpanded() {
    if (!this.options.explored) return;
    const g = this.graph;
    const ctx = this.ctx;

    for (const layer of this.layers) {
      const nodes = layer.exploredNodes;
      if (!nodes || nodes.length === 0) continue;

      // During playback only the first `revealedNodes` expansions are shown.
      const count = layer.revealedNodes === undefined
        ? nodes.length
        : Math.min(layer.revealedNodes, nodes.length);
      if (count <= 0) continue;

      // A search that is still running gets the tiered treatment: a broad settled cloud,
      // a bright wavefront, and a marker on the node expanded most recently.
      const running = count < nodes.length;
      const settledEnd = running ? Math.max(0, count - FRONTIER_TAIL) : count;

      if (settledEnd > 0) {
        ctx.fillStyle = withAlpha(layer.color, running ? 0.42 : 0.34);
        ctx.beginPath();
        this._dotPath(nodes, 0, settledEnd, running ? SETTLED_RADIUS : 2.1);
        ctx.fill();
      }

      if (!running) continue;

      ctx.fillStyle = withAlpha(layer.color, 0.95);
      ctx.beginPath();
      this._dotPath(nodes, settledEnd, count, FRONTIER_RADIUS);
      ctx.fill();

      // The single most recently expanded node — the point to follow across the map.
      const head = nodes[count - 1];
      const hx = this._sx(g.x[head]);
      const hy = this._sy(g.y[head]);
      ctx.beginPath();
      ctx.arc(hx, hy, CURRENT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(layer.color, 0.9);
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = UI.markerRing;
      ctx.stroke();
    }
  }

  /** Append the dots for nodes[from..to) at `radius` to the current path. */
  _dotPath(nodes, from, to, radius) {
    const g = this.graph;
    const ctx = this.ctx;
    for (let k = from; k < to; k++) {
      const i = nodes[k];
      const x = this._sx(g.x[i]);
      const y = this._sy(g.y[i]);
      ctx.moveTo(x + radius, y);
      ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
  }

  // ----------------------------------------------------------------- routes

  _drawRoutes() {
    const g = this.graph;
    const ctx = this.ctx;

    // During playback the route is drawn progressively, vertex by vertex.
    const withPaths = this.layers
      .filter((layer) => layoutHasDrawablePath(layer))
      .map((layer) => ({
        color: layer.color,
        path: layer.revealedPath === undefined
          ? layer.path
          : layer.path.slice(0, Math.min(layer.revealedPath, layer.path.length)),
      }));

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Wide halo first, then the thinner line on top of it.
    for (let pass = 0; pass < 2; pass++) {
      ctx.lineWidth = pass === 0 ? ROUTE_HALO_WIDTH : ROUTE_CORE_WIDTH;
      ctx.globalAlpha = pass === 0 ? 0.55 : 1;
      for (const layer of withPaths) {
        ctx.strokeStyle = layer.color;
        ctx.beginPath();
        const path = layer.path;
        ctx.moveTo(this._sx(g.x[path[0]]), this._sy(g.y[path[0]]));
        for (let i = 1; i < path.length; i++) {
          ctx.lineTo(this._sx(g.x[path[i]]), this._sy(g.y[path[i]]));
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------- endpoints

  _drawEndpoints() {
    const g = this.graph;
    const ctx = this.ctx;
    if (!g || (this.start < 0 && this.goal < 0)) return;

    const mark = (node, fill, label) => {
      const x = this._sx(g.x[node]);
      const y = this._sy(g.y[node]);
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = UI.markerRing;
      ctx.stroke();

      ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
      const w = ctx.measureText(label).width + 10;
      ctx.fillStyle = UI.labelBg;
      ctx.fillRect(x + 9, y - 9, w, 16);
      ctx.fillStyle = UI.markerRing;
      ctx.fillText(label, x + 14, y + 3);
    };

    if (this.start >= 0) mark(this.start, UI.start, `S · ${this.startLabel}`);
    if (this.goal >= 0) mark(this.goal, UI.goal, `G · ${this.goalLabel}`);
  }
}
