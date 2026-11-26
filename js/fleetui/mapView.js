/**
 * Fleet map — canvas renderer for the simulation state.
 *
 * Layers, bottom to top
 *   street map   OpenStreetMap tiles (imported lat/lng maps only, same tiles as the
 *                WebApp's Live Monitoring fallback map) — needs internet, else skipped
 *   roads        simulation road network; DELAYED orange "×2.5", CLOSED red dashed + ✕
 *   testing area the selected area (see areaPanel.js): everything around it is darkened; trucks,
 *                paths and bins that do not belong to it are dimmed or hidden
 *   paths        each truck's remaining planned route in its colour
 *   depot / disposal   white round markers with warehouse / landfill icons + name
 *   bins         trash-bin icon on a tile coloured by status (green / yellow / red / gray),
 *                ring + tag in the colour of the truck it is assigned to
 *   trucks       parked at the depot: numbered dots in a block next to it; otherwise drawn exactly
 *                where they are: truck icon in a white disc with the truck's colour, number badge, and an
 *                ETA chip underneath ("→ Bin 14 · 4 min 30 s"); BLOCKED trucks turn red
 *   ETA details  optional 2-line box: "Truck 2 → Bin 14: ETA 4 min 30 s" + route end, load
 *
 * Icons are the same Lucide line icons the WebApp map markers use.
 * Reads the simulation, never writes to it. Zoom (wheel) and pan (drag) are view-only.
 */

import { binColor } from '../sim/fleet/bins.js';
import { truckXY } from '../sim/fleet/truck.js';
import { numberOf, remainingPath } from '../sim/fleet/routes.js';
import { pointInPolygon } from '../sim/fleet/routeAreas.js';
import { fmtDuration } from '../sim/fleet/eta.js';

/** Lucide icon paths (24×24), identical to the WebApp LiveFleetMap markers. */
export const ICON_PATHS = {
  truck: [
    'M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2', 'M15 18H9',
    'M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14',
    'M15 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M5 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
  ],
  bin: [
    'M3 6h18', 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6', 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2',
    'M10 11v6', 'M14 11v6',
  ],
  landfill: [
    'M7 19H4.815a1.83 1.83 0 0 1-1.57-.881 1.785 1.785 0 0 1-.004-1.784L7.196 9.5',
    'M11 19h8.203a1.83 1.83 0 0 0 1.556-.89 1.784 1.784 0 0 0 0-1.775l-1.226-2.12', 'm14 16-3 3 3 3',
    'M8.293 13.596 7.196 9.5 3.1 10.598', 'm9.344 5.811 1.093-1.892A1.83 1.83 0 0 1 11.985 3a1.784 1.784 0 0 1 1.546.888l3.943 6.843',
    'm13.378 9.633 4.096 1.098 1.097-4.096',
  ],
  depot: [
    'M22 8.35V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8.35A2 2 0 0 1 3.26 6.5l8-3.2a2 2 0 0 1 1.48 0l8 3.2A2 2 0 0 1 22 8.35Z',
    'M6 18h12', 'M6 14h12', 'M6 10h12v12H6z',
  ],
};
let iconCache = null;
function icon(kind) {
  if (!iconCache) {
    iconCache = {};
    for (const [k, paths] of Object.entries(ICON_PATHS)) iconCache[k] = paths.map((d) => new Path2D(d));
  }
  return iconCache[kind];
}

/** OpenStreetMap standard tiles — usage policy: light use with attribution. */
const TILE_URL = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const TILE_CACHE_MAX = 400;

const DIMMED = 0.22; // opacity of what is outside the selected testing area
const FLY_MS = 650;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const COLORS = {
  road: '#3b4a61',
  roadClosed: '#ef4444',
  roadDelayed: '#fb923c',
  text: '#e2e8f0',
  textDim: '#94a3b8',
  labelBg: 'rgba(15, 23, 42, 0.88)',
  depot: '#e2e8f0',
  disposal: '#a3a3a3',
};

export class FleetMapView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sim = null;
    this.options = { paths: true, etaLabels: true, binLabels: true, nodeIds: false, basemap: true, borders: true };
    this.tiles = new Map(); // "z/x/y" → { img, ok }
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    /** Road-picking mode: when set, a click (not a drag) on a road calls onRoadPick(edge). */
    this.pickMode = false;
    this.onRoadPick = null;
    this.hoverEdge = -1;
    /** Editing (see editor.js): 'none' | 'addBin' (click = new bin) | 'draw' (click = corner). */
    this.editMode = 'none';
    this.draft = [];            // corners of the area being drawn, map metres
    this.draftPreview = null;   // finished outline while its form is open
    this.newBinSpot = null;     // where the new bin will stand while its form is open
    this.pickNumbers = null;    // Map bin id → number while bins are being chosen for a route
    this.dragBin = null;        // { id, x, y } while a bin is being dragged
    this.highlight = new Set(); // truck ids whose details are open
    this.getVisibleBins = () => this.sim.bins;
    this.onAddBin = this.onCloseDraft = this.onPickTruck = this.onPickBin = this.onPickRoute = this.onMoveBin = null;
    /** Testing areas (see areaPanel.js): outlines to show, and the selected one with its fleet. */
    this.zones = [];
    this.focus = null;          // { zone, outside: 'dim'|'hide', trucks, here, bins, stops }
    this.hoverZone = null;
    this.onPickZone = this.zoneAt = null;
    this.fly = null;            // running camera move
    this.glide = null;          // wheel zoom still to be applied
    this._bindInteraction();
    new ResizeObserver(() => this.render()).observe(canvas);
  }

  /**
   * Show a (re)started run. The same map keeps its zoom and position.
   * @returns {boolean} true when it is the map that was already shown
   */
  setSimulation(sim) {
    const same = Boolean(this.sim) && this.sim.world.name === sim.world.name &&
      this.sim.graph.nodeCount === sim.graph.nodeCount;
    this.sim = sim;
    this.hoverEdge = -1;
    this.dragBin = null;
    if (same) this.render(); else this.resetView();
    return same;
  }

  setPickMode(on) {
    this.pickMode = on;
    this.hoverEdge = -1;
    this.canvas.classList.toggle('picking', on);
    this.render();
  }

  setEditMode(mode) {
    this.editMode = mode;
    this.draft = [];
    this.hoverZone = null;
    this.canvas.classList.toggle('editing', mode !== 'none');
    this.render();
  }

  /** Canvas pixel position of a pointer event. */
  _local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  }

  truckAt(px, py) {
    for (let i = (this._truckSpots || []).length - 1; i >= 0; i--) {
      const s = this._truckSpots[i];
      if (Math.hypot(px - s.x, py - s.y) < s.r) return s.id;
    }
    return null;
  }

  /** Closest visible bin under the pointer. */
  binAt(px, py, r = 15) {
    if (!this.sim || !this.tx) return null;
    let best = null;
    let bestD = r;
    for (const b of this.getVisibleBins()) {
      if (this._binAlpha(b) === 0) continue;
      const d = Math.hypot(this.tx(b.x) - px, this.ty(b.y) - py);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  /** All visible bins standing on the same point as `bin`. */
  binsAtSpot(bin) {
    return this.getVisibleBins().filter((b) => Math.hypot(b.x - bin.x, b.y - bin.y) < 1);
  }

  _click(e) {
    const { px, py } = this._local(e);
    const x = this.wx(px), y = this.wy(py);
    if (this.editMode === 'addBin') { this.onAddBin?.(x, y); return; }
    if (this.editMode === 'pickZone') { this.onPickZone?.(x, y); return; }
    if (this.editMode === 'draw' || this.editMode === 'drawZone') {
      const first = this.draft[0];
      const last = this.draft[this.draft.length - 1];
      const near = (p, d) => p && Math.hypot(this.tx(p[0]) - px, this.ty(p[1]) - py) < d;
      if (this.draft.length >= 3 && near(first, 14)) this.onCloseDraft?.();
      else if (!near(last, 5)) { this.draft.push([x, y]); this.render(); }
      return;
    }
    const truck = this.pickNumbers ? null : this.truckAt(px, py);
    if (truck !== null) { this.onPickTruck?.(truck); return; }
    const bin = this.binAt(px, py);
    if (bin) { this.onPickBin?.(bin.id); return; }
    if (this.pickNumbers) return;
    for (const r of this.sim.routes.values()) {
      if (pointInPolygon(x, y, r.poly)) { this.onPickRoute?.(r.id); return; }
    }
  }

  /** Nearest road to a client-space point within `maxPx` screen pixels, or -1. */
  edgeAt(clientX, clientY, maxPx = 10) {
    if (!this.sim || !this.tx) return -1;
    const r = this.canvas.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    const { graph } = this.sim;
    let best = -1;
    let bestD = maxPx * maxPx;
    for (let e = 0; e < graph.edgeCount; e++) {
      const u = graph.edgeFrom[e], v = graph.edgeTo[e];
      const x1 = this.tx(graph.x[u]), y1 = this.ty(graph.y[u]);
      const x2 = this.tx(graph.x[v]), y2 = this.ty(graph.y[v]);
      const dx = x2 - x1, dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
      const d = (px - x1 - t * dx) ** 2 + (py - y1 - t * dy) ** 2;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  // --------------------------------------------------------------- camera

  /** Move smoothly to `bounds` (map metres), or to the whole fleet (null). */
  flyTo(bounds, animate = true) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!this.sim || w < 50 || h < 50) return;
    this.glide = null;
    this._fit();
    const from = { x: this.wx(w / 2), y: this.wy(h / 2), s: this.scale };
    if (!bounds) this.homeBounds = null; // bins or routes may have moved
    this._fit();
    const b = bounds || this.homeBounds;
    const pad = Math.min(60, w * 0.08, h * 0.12);
    const s = bounds
      ? Math.min(3, (w - 2 * pad) / Math.max(1, b.maxX - b.minX), (h - 2 * pad) / Math.max(1, b.maxY - b.minY))
      : this._base;
    this._camera(from.x, from.y, from.s);
    this.fly = {
      from, to: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, s }, home: !bounds,
      start: performance.now(), ms: animate && !reducedMotion() ? FLY_MS : 0,
    };
    this.render();
  }

  /** Back to the selected testing area, or to the whole fleet. */
  home() { this.flyTo(this.focus ? this.focus.zone.bbox : null); }

  /** Zoom about the middle of the map (the + and − buttons). */
  zoomBy(f) { if (this.sim) this._glideZoom(0, 0, f); }

  _glideZoom(mx, my, f) {
    this.fly = null;
    this.glide = { mx, my, left: (this.glide?.left || 0) + Math.log(f), at: this.glide?.at ?? performance.now() };
    this.render();
  }

  _camera(x, y, s) {
    const b = this.homeBounds;
    this.zoom = s / this._base;
    this.pan = { x: -(x - (b.minX + b.maxX) / 2) * s, y: (y - (b.minY + b.maxY) / 2) * s };
  }

  /** Zoom about a point given relative to the canvas centre, within sensible limits. */
  _zoomAbout(mx, my, f) {
    const base = this._base || 1;
    const most = Math.max(8, base * 30), least = base * 0.15;
    f = Math.min(Math.max(f, Math.min(1, least / this.scale)), Math.max(1, most / this.scale));
    this.pan.x = mx - (mx - this.pan.x) * f;
    this.pan.y = my - (my - this.pan.y) * f;
    this.zoom *= f;
  }

  /** One step of a running camera move. @returns {boolean} the view changed */
  _advance() {
    const now = performance.now();
    if (this.fly) {
      const { from, to, start, ms, home } = this.fly;
      const k = ms ? Math.min(1, (now - start) / ms) : 1;
      if (k === 1) {
        this.fly = null;
        if (home) { this.zoom = 1; this.pan = { x: 0, y: 0 }; } else this._camera(to.x, to.y, to.s);
        return true;
      }
      const t = k * k * (3 - 2 * k);
      const s = from.s * (to.s / from.s) ** t;
      // same fixed point while zooming, so the target does not swing across the screen
      const u = Math.abs(Math.log(to.s / from.s)) < 0.02 ? t : (1 / from.s - 1 / s) / (1 / from.s - 1 / to.s);
      this._camera(from.x + (to.x - from.x) * u, from.y + (to.y - from.y) * u, s);
      return true;
    }
    if (this.glide) {
      const g = this.glide;
      const k = reducedMotion() ? 1 : 1 - Math.exp(-(now - g.at) / 70);
      g.at = now;
      const part = Math.abs(g.left) < 0.004 ? g.left : g.left * k;
      g.left -= part;
      this._zoomAbout(g.mx, g.my, Math.exp(part));
      if (g.left === 0) this.glide = null;
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------- testing area

  /** Opacity of a truck / bin: 1 = belongs to the selected area (or none is selected), 0 = hidden. */
  _truckAlpha(t) {
    if (!this.focus || this.focus.trucks.has(t.id) || this.highlight.has(t.id)) return 1;
    return this.focus.outside === 'hide' ? 0 : DIMMED;
  }

  _binAlpha(b) {
    if (!this.focus || this.focus.bins.has(b.id) || this.pickNumbers?.has(b.id)) return 1;
    return this.focus.outside === 'hide' ? 0 : DIMMED;
  }

  _zonePath(ctx, zone) {
    for (const r of zone.rings) {
      r.forEach(([x, y], i) => (i ? ctx.lineTo(this.tx(x), this.ty(y)) : ctx.moveTo(this.tx(x), this.ty(y))));
      ctx.closePath();
    }
  }

  /** Area outlines; the selected one stays clear while everything around it is darkened. */
  _drawZones(ctx, w, h) {
    const { focus } = this;
    const sel = focus?.zone;
    if (sel) {
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      this._zonePath(ctx, sel);
      ctx.fillStyle = focus.outside === 'hide' ? 'rgba(15, 23, 42, 0.62)' : 'rgba(15, 23, 42, 0.42)';
      ctx.fill('evenodd');
    }
    if (this.options.borders) {
      for (const z of this.zones) {
        if (z === sel) continue;
        const hover = z === this.hoverZone;
        ctx.beginPath();
        this._zonePath(ctx, z);
        if (hover) { ctx.fillStyle = 'rgba(6, 182, 212, 0.25)'; ctx.fill('evenodd'); }
        ctx.strokeStyle = sel ? 'rgba(226, 232, 240, 0.65)' : 'rgba(14, 116, 144, 0.9)';
        ctx.lineWidth = hover ? 3 : 1.5;
        ctx.setLineDash([7, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
        const b = z.bbox;
        // schedule areas overlap, so their names would cover each other
        if (hover || (z.kind !== 'schedule' && (b.maxX - b.minX) * this.scale > 70)) {
          const x = this.tx((b.minX + b.maxX) / 2), y = this.ty((b.minY + b.maxY) / 2);
          if (x > 0 && x < w && y > 0 && y < h) this._tag(ctx, z.name, x, y, '#a5f3fc'); // labels stick to the edge otherwise
        }
      }
    }
    if (!sel) return;
    ctx.beginPath();
    this._zonePath(ctx, sel);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.strokeStyle = '#0891b2';
    ctx.lineWidth = 4;
    ctx.stroke();
    this._drawStops(ctx, focus.stops);
    const top = sel.rings.flat().reduce((a, b) => (b[1] > a[1] ? b : a));
    this._tag(ctx, sel.name, this.tx(top[0]), Math.min(h - 12, Math.max(12, this.ty(top[1]) - 14)), '#67e8f9');
  }

  /** Checkpoints of the selected area: every schedule stop, numbered; "×4" = several on one point. */
  _drawStops(ctx, stops) {
    const spots = new Map();
    for (const s of stops) {
      const key = `${Math.round(s.x)},${Math.round(s.y)}`;
      if (!spots.has(key)) spots.set(key, []);
      spots.get(key).push(s);
    }
    ctx.font = 'bold 10px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const list of spots.values()) {
      const x = this.tx(list[0].x), y = this.ty(list[0].y);
      const text = list.length > 1 ? `×${list.length}` : list[0].order || '•';
      const r = Math.max(9, ctx.measureText(text).width / 2 + 5);
      ctx.beginPath();
      ctx.roundRect(x - r, y - 9, 2 * r, 18, 9);
      ctx.fillStyle = list.some((s) => s.type === 'collection') ? '#0e7490' : '#64748b';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, x, y + 0.5);
    }
  }

  resetView() {
    this.fly = this.glide = null;
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.homeBounds = null; // worked out again on the next render
    this.render();
  }

  /**
   * What the un-zoomed view shows. City road files reach far beyond the bins, so there it is
   * the bins, depot, landfill and routes; other maps are shown whole.
   */
  _homeBounds() {
    const { graph, world, bins, trucks, routes } = this.sim;
    if (!world.geo) return graph.bounds();
    const pts = [world.depot, world.disposal, ...trucks.map((t) => t.start)].map((n) => [graph.x[n], graph.y[n]]);
    for (const b of bins) pts.push([b.x, b.y]);
    for (const r of routes.values()) pts.push(...r.poly);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }

  // ------------------------------------------------------------- transform

  _fit() {
    const b = this.homeBounds || (this.homeBounds = this._homeBounds());
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const pad = Math.min(70, w * 0.06);
    const least = this.sim.world.geo ? 2000 : 1; // a few close bins on a city map: still show 2 km
    const spanX = Math.max(least, b.maxX - b.minX);
    const spanY = Math.max(least, b.maxY - b.minY);
    const base = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
    // The map got another size (details opened, full screen): a view the user has zoomed or moved
    // keeps its scale; an untouched view is fitted again.
    const touched = this.zoom !== 1 || this.pan.x !== 0 || this.pan.y !== 0;
    if (touched && this._base && this._base !== base) this.zoom *= this._base / base;
    this._base = base;
    const scale = base * this.zoom;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    // y grows upwards in the world, downwards on screen
    this.tx = (x) => w / 2 + (x - cx) * scale + this.pan.x;
    this.ty = (y) => h / 2 - (y - cy) * scale + this.pan.y;
    // inverse (screen → world), used to find which street-map tiles are visible
    this.wx = (sx) => (sx - w / 2 - this.pan.x) / scale + cx;
    this.wy = (sy) => (h / 2 + this.pan.y - sy) / scale + cy;
    this.scale = scale;
  }

  _bindInteraction() {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      if (!this.sim) return;
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const r = c.getBoundingClientRect();
      const mx = e.clientX - r.left - c.clientWidth / 2;
      const my = e.clientY - r.top - c.clientHeight / 2;
      this._glideZoom(mx, my, f);
    }, { passive: false });

    const touches = new Map(); // two fingers = pinch zoom (phones)
    let pinch = 0;
    let pinched = false;

    let drag = null;
    c.addEventListener('pointerdown', (e) => {
      touches.set(e.pointerId, e);
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        pinch = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        pinched = true;
        drag = null;
        this.dragBin = null;
        return;
      }
      pinched = false;
      const { px, py } = this._local(e);
      // Pressing on a bin may become a drag of that bin; a truck on top of it goes first.
      const bin = this.sim && !this.pickMode && !this.pickNumbers && this.editMode === 'none' && this.truckAt(px, py) === null ? this.binAt(px, py) : null;
      drag = { bin: bin?.id ?? null, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, e);
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const r = c.getBoundingClientRect();
        if (pinch > 0 && d > 0) {
          this.fly = this.glide = null;
          this._zoomAbout((a.clientX + b.clientX) / 2 - r.left - c.clientWidth / 2, (a.clientY + b.clientY) / 2 - r.top - c.clientHeight / 2, d / pinch);
          this.render();
        }
        pinch = d;
        return;
      }
      if (!drag) {
        if (this.pickMode) {
          const hit = this.edgeAt(e.clientX, e.clientY);
          if (hit !== this.hoverEdge) { this.hoverEdge = hit; this.render(); }
        } else if (this.editMode === 'pickZone' && this.sim) {
          const { px, py } = this._local(e);
          const hit = this.zoneAt?.(this.wx(px), this.wy(py)) || null;
          if (hit !== this.hoverZone) { this.hoverZone = hit; this.render(); }
        }
        return;
      }
      if (drag.bin !== null && this.sim.binsById.has(drag.bin)) {
        if (!this.dragBin && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
        const { px, py } = this._local(e);
        this.dragBin = { id: drag.bin, x: this.wx(px), y: this.wy(py) };
        this.render();
        return;
      }
      this.fly = this.glide = null;
      this.pan.x += e.clientX - drag.x;
      this.pan.y += e.clientY - drag.y;
      drag = { ...drag, x: e.clientX, y: e.clientY };
      this.render();
    });
    const forget = (e) => { touches.delete(e.pointerId); };
    c.addEventListener('pointercancel', (e) => { forget(e); drag = null; this.dragBin = null; this.render(); });
    c.addEventListener('pointerup', (e) => {
      forget(e);
      // A click (moved < 5 px) in pick mode places an event; anything longer was a pan.
      const isClick = drag && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5;
      drag = null;
      if (this.dragBin) {
        const d = this.dragBin;
        this.dragBin = null;
        if (this.sim.binsById.has(d.id)) this.onMoveBin?.(d.id, d.x, d.y);
        return;
      }
      if (isClick && !pinched && this.sim && !this.pickMode) { this._click(e); return; }
      if (isClick && this.pickMode && this.onRoadPick) {
        const hit = this.edgeAt(e.clientX, e.clientY);
        if (hit >= 0) this.onRoadPick(hit);
      }
    });
    c.addEventListener('pointerleave', () => {
      if (this.hoverEdge !== -1) { this.hoverEdge = -1; this.render(); }
    });
    c.addEventListener('dblclick', (e) => {
      if (this.editMode === 'draw' || this.editMode === 'drawZone') { if (this.draft.length >= 3) this.onCloseDraft?.(); return; }
      const { px, py } = this._local(e);
      if (!this.pickMode && this.editMode === 'none' && this.truckAt(px, py) === null && !this.binAt(px, py)) this.home();
    });
  }

  // ---------------------------------------------------------------- render

  render() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.sim || w < 50 || h < 50) return;

    this._fit();
    if (this._advance()) this._fit();
    const street = this.options.basemap && this.sim.world.geo;
    if (street) this._drawBasemap(ctx, w, h, dpr);
    this._drawRoads(ctx, street);
    this._drawZones(ctx, w, h);
    this._drawAreas(ctx);
    if (this.options.paths) this._drawPaths(ctx);
    this._drawSites(ctx);
    this._drawBins(ctx);
    this._drawTrucks(ctx);
    this._drawSpotBadges(ctx);
    this._drawDraft(ctx);
    if (this.pickMode && this.hoverEdge >= 0) this._drawHover(ctx);
    if (street) this._drawAttribution(ctx, w, h);
  }

  // ------------------------------------------------------------ street map

  /**
   * Draw OpenStreetMap tiles under the simulation. Tiles are Web-Mercator; each tile's
   * corner lat/lng is projected with the map's own equirectangular projection, which
   * matches to well under a metre across a city-sized area.
   */
  _drawBasemap(ctx, w, h, dpr) {
    const g = this.sim.world.geo;
    const toLng = (x) => x / g.mPerLon + g.minLon;
    const toLat = (y) => y / g.mPerLat + g.minLat;
    const west = toLng(this.wx(0)), east = toLng(this.wx(w));
    const north = toLat(this.wy(0)), south = toLat(this.wy(h));
    const midLat = (north + south) / 2;

    // Zoom where one tile pixel ≈ one device pixel (OSM: 156 543 m/px at z0 on the equator).
    const z = Math.max(3, Math.min(19, Math.round(Math.log2(156543.03 * Math.cos((midLat * Math.PI) / 180) * this.scale * dpr))));
    const n = 2 ** z;
    const tileX = (lng) => Math.floor(((lng + 180) / 360) * n);
    const tileY = (lat) => {
      const r = (lat * Math.PI) / 180;
      return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
    };
    const lngOf = (x) => (x / n) * 360 - 180;
    const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
    const sx = (lng) => this.tx((lng - g.minLon) * g.mPerLon);
    const sy = (lat) => this.ty((lat - g.minLat) * g.mPerLat);

    const x0 = tileX(west), x1 = tileX(east), y0 = tileY(north), y1 = tileY(south);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 300) return; // zoomed far out — don't request hundreds of tiles

    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(0, 0, w, h);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const tile = this._tile(z, tx, ty);
        if (!tile.ok) continue;
        const left = Math.floor(sx(lngOf(tx))), right = Math.ceil(sx(lngOf(tx + 1)));
        const top = Math.floor(sy(latOf(ty))), bottom = Math.ceil(sy(latOf(ty + 1)));
        ctx.drawImage(tile.img, left, top, right - left, bottom - top);
      }
    }
    // A light veil keeps the simulation layers readable on top of the busy street map.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.fillRect(0, 0, w, h);
  }

  _tile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (!t) {
      if (this.tiles.size >= TILE_CACHE_MAX) this.tiles.delete(this.tiles.keys().next().value);
      t = { img: new Image(), ok: false };
      t.img.onload = () => { t.ok = true; this.render(); };
      t.img.onerror = () => { t.failed = true; }; // offline: the plain road network still draws
      t.img.src = TILE_URL(z, x, y);
      this.tiles.set(key, t);
    }
    return t;
  }

  _drawAttribution(ctx, w, h) {
    const text = '© OpenStreetMap contributors';
    ctx.font = '11px "Segoe UI", sans-serif';
    const tw = ctx.measureText(text).width + 10;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillRect(w - tw, h - 18, tw, 18);
    ctx.fillStyle = '#334155';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w - 5, h - 9);
  }

  // ----------------------------------------------------------- route areas

  _outline(ctx, poly, close = true) {
    ctx.beginPath();
    poly.forEach(([x, y], i) => (i ? ctx.lineTo(this.tx(x), this.ty(y)) : ctx.moveTo(this.tx(x), this.ty(y))));
    if (close) ctx.closePath();
  }

  _drawAreas(ctx) {
    for (const r of this.sim.routes.values()) {
      this._outline(ctx, r.poly);
      ctx.fillStyle = r.color;
      ctx.globalAlpha = 0.2;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 3;
      ctx.stroke();
      const top = r.poly.reduce((a, b) => (b[1] > a[1] ? b : a));
      this._tag(ctx, r.name, this.tx(top[0]), this.ty(top[1]) - 12, '#ffffff');
    }
  }

  _drawDraft(ctx) {
    const poly = this.draftPreview || this.draft;
    if (poly.length) {
      this._outline(ctx, poly, Boolean(this.draftPreview));
      if (poly.length > 2) { ctx.fillStyle = 'rgba(253, 224, 71, 0.25)'; ctx.fill(); }
      ctx.strokeStyle = '#a16207';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      poly.forEach(([x, y], i) => {
        ctx.beginPath();
        ctx.arc(this.tx(x), this.ty(y), i === 0 ? 8 : 5, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#fde047' : '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 2;
        ctx.stroke();
      });
    }
    if (this.newBinSpot) {
      const x = this.tx(this.newBinSpot.x), y = this.ty(this.newBinSpot.y);
      this._marker(ctx, 'bin', x, y, 14, '#ca8a04', '#0f172a', 4);
      this._tag(ctx, 'new bin', x, y - 26, '#fde047');
    }
  }

  // ----------------------------------------------------------------- icons

  /** Lucide icon `kind` centred at (x, y), `size` px, stroked in `color`. */
  _icon(ctx, kind, x, y, size, color, lineWidth = 2.1) {
    const s = size / 24;
    ctx.save();
    ctx.translate(x - size / 2, y - size / 2);
    ctx.scale(s, s);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const p of icon(kind)) ctx.stroke(p);
    ctx.restore();
  }

  /** White round marker with a coloured ring and an icon inside (WebApp marker style). */
  _marker(ctx, kind, x, y, r, ring, iconColor, ringWidth = 3) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(15, 23, 42, 0.45)';
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = ringWidth;
    ctx.strokeStyle = ring;
    ctx.stroke();
    this._icon(ctx, kind, x, y, r * 1.15, iconColor);
  }

  /** Highlight the road under the cursor while picking a road for a live event. */
  _drawHover(ctx) {
    const { graph, world, road } = this.sim;
    const e = this.hoverEdge;
    const u = graph.edgeFrom[e], v = graph.edgeTo[e];
    const x1 = this.tx(graph.x[u]), y1 = this.ty(graph.y[u]);
    const x2 = this.tx(graph.x[v]), y2 = this.ty(graph.y[v]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = '#fde047';
    ctx.lineWidth = 8;
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.globalAlpha = 1;
    const state = road.closed[e] ? 'closed' : road.multiplier[e] !== 1 ? `×${road.multiplier[e].toFixed(1)}` : 'open';
    this._tag(ctx, `${world.edgeLabel(e)} · ${Math.round(graph.edgeLength[e])} m · ${state}`, (x1 + x2) / 2, (y1 + y2) / 2 - 16, '#fde047');
  }

  _drawRoads(ctx, onStreetMap = false) {
    const { graph, road, world } = this.sim;
    const { tx, ty } = this;
    const dense = graph.edgeCount > 3000;

    // 1. normal roads in one stroke
    // (zoomed in: skip roads that are completely off the screen)
    const west = this.wx(-5), east = this.wx(this.canvas.clientWidth + 5);
    const south = this.wy(this.canvas.clientHeight + 5), north = this.wy(-5);
    const gx = graph.x, gy = graph.y;
    ctx.beginPath();
    for (let e = 0; e < graph.edgeCount; e++) {
      if (road.closed[e] || road.multiplier[e] !== 1) continue;
      const u = graph.edgeFrom[e], v = graph.edgeTo[e];
      if ((gx[u] < west && gx[v] < west) || (gx[u] > east && gx[v] > east) ||
        (gy[u] < south && gy[v] < south) || (gy[u] > north && gy[v] > north)) continue;
      ctx.moveTo(tx(graph.x[u]), ty(graph.y[u]));
      ctx.lineTo(tx(graph.x[v]), ty(graph.y[v]));
    }
    // On the street map the network is a faint blue overlay (the tiles already show streets);
    // it still matters because it shows exactly which roads the simulation can use.
    ctx.strokeStyle = onStreetMap ? 'rgba(30, 64, 175, 0.30)' : COLORS.road;
    ctx.lineWidth = onStreetMap ? 2 : dense ? 1 : 4;
    ctx.lineCap = 'round';
    ctx.stroke();

    // 2. delayed + closed roads, individually, with a tag
    for (let e = 0; e < graph.edgeCount; e++) {
      const closed = road.closed[e] === 1;
      const m = road.multiplier[e];
      if (!closed && m === 1) continue;
      const u = graph.edgeFrom[e], v = graph.edgeTo[e];
      const x1 = tx(graph.x[u]), y1 = ty(graph.y[u]), x2 = tx(graph.x[v]), y2 = ty(graph.y[v]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.setLineDash(closed ? [8, 6] : []);
      ctx.strokeStyle = closed ? COLORS.roadClosed : COLORS.roadDelayed;
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.setLineDash([]);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      this._tag(ctx, closed ? `✕ ${world.edgeLabel(e)}` : `×${m.toFixed(1)}`, mx, my - 12,
        closed ? COLORS.roadClosed : COLORS.roadDelayed);
    }

    if (this.options.nodeIds && !dense) {
      ctx.font = '10px "Segoe UI", sans-serif';
      ctx.fillStyle = COLORS.textDim;
      ctx.textAlign = 'left';
      for (let i = 0; i < graph.nodeCount; i++) ctx.fillText(world.nodeLabel(i), tx(graph.x[i]) + 4, ty(graph.y[i]) + 12);
    }
  }

  _drawPaths(ctx) {
    const { graph } = this.sim;
    const { tx, ty } = this;
    this.sim.trucks.forEach((truck, i) => {
      if (truck.arcs.length === 0 && !truck.routeId) return;
      const alpha = this._truckAlpha(truck);
      if (alpha === 0) return;
      const off = ((i % 5) - 2) * 2; // small, bounded offset so overlapping routes stay distinguishable
      const p = truckXY(graph, truck);
      // Route trucks: every later stop as a thinner dashed line.
      if (truck.routeId) {
        const later = remainingPath(this.sim, truck);
        if (later.length) {
          const s = graph.adjTail[later[0]];
          ctx.beginPath();
          ctx.moveTo(tx(graph.x[s]) + off, ty(graph.y[s]) + off);
          for (const a of later) ctx.lineTo(tx(graph.x[graph.adjNeighbor[a]]) + off, ty(graph.y[graph.adjNeighbor[a]]) + off);
          ctx.strokeStyle = truck.color;
          ctx.globalAlpha = alpha;
          ctx.lineWidth = 2.5;
          ctx.setLineDash([6, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      }
      if (truck.arcs.length === 0) return;
      ctx.beginPath();
      ctx.moveTo(tx(p.x) + off, ty(p.y) + off);
      for (const a of truck.arcs) {
        const v = graph.adjNeighbor[a];
        ctx.lineTo(tx(graph.x[v]) + off, ty(graph.y[v]) + off);
      }
      ctx.strokeStyle = truck.color;
      ctx.globalAlpha = 0.75 * alpha;
      ctx.lineWidth = 3;
      ctx.setLineDash(truck.status === 'blocked' ? [4, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    });
  }

  /** Depot (warehouse icon) and disposal site (landfill icon), WebApp "facility" style. */
  _drawSites(ctx) {
    const { graph, world } = this.sim;
    const { tx, ty } = this;
    const site = (node, kind, label, labelDy) => {
      const x = tx(graph.x[node]), y = ty(graph.y[node]);
      // outer emerald halo = facility (as on the WebApp map)
      ctx.beginPath();
      ctx.arc(x, y, 21, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(5, 150, 105, 0.55)';
      ctx.lineWidth = 3;
      ctx.stroke();
      this._marker(ctx, kind, x, y, 16, '#059669', '#065f46', 3);
      this._tag(ctx, label, x, y + labelDy, '#6ee7b7');
    };
    if (world.disposal !== world.depot) site(world.disposal, 'landfill', world.disposalName || 'DISPOSAL', -32); // name above, the depot's below
    site(world.depot, 'depot', world.disposal === world.depot
      ? `${world.depotName || 'DEPOT'} / DISPOSAL`
      : world.depotName || 'DEPOT', 32);
  }

  _drawBins(ctx) {
    const { world, trucks } = this.sim;
    const { tx, ty } = this;
    const th = world.settings.fill_thresholds;
    const truckById = new Map(trucks.map((t) => [t.id, t]));

    // Bins on the same point are drawn on top of each other: count and number them.
    const spots = new Map();
    for (const bin of this.getVisibleBins()) {
      if (this._binAlpha(bin) < 1) continue;
      const key = `${Math.round(bin.x)},${Math.round(bin.y)}`;
      if (!spots.has(key)) spots.set(key, []);
      spots.get(key).push(bin);
    }
    this._spots = [...spots.values()];
    for (const bin of this.getVisibleBins()) {
      const alpha = this._binAlpha(bin);
      if (alpha === 0) continue;
      ctx.globalAlpha = alpha;
      const moved = this.dragBin?.id === bin.id ? this.dragBin : bin;
      const x = tx(moved.x), y = ty(moved.y);
      const route = bin.routeId ? this.sim.routes.get(bin.routeId) : null;
      const s = 11;
      // tile coloured by status, with a trash-bin icon so bins never look like trucks
      ctx.fillStyle = binColor(bin, th);
      // outline: the route's colour, or grey = Unassigned (not in any route)
      ctx.strokeStyle = route ? route.color : '#9ca3af';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(x - s, y - s, 2 * s, 2 * s, 5);
      ctx.fill();
      ctx.stroke();
      this._icon(ctx, 'bin', x, y, 16, '#0f172a', 2.3);

      // assigned truck: ring in the truck's colour
      const owner = bin.state === 'assigned' ? truckById.get(bin.truckId) : null;
      if (owner) {
        ctx.strokeStyle = owner.color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.roundRect(x - s - 4, y - s - 4, 2 * s + 8, 2 * s + 8, 7);
        ctx.stroke();
      }
      if (bin.state === 'collected') {
        ctx.beginPath();
        ctx.arc(x + s, y - s, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#16a34a';
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('✓', x + s, y - s + 0.5);
      }

      if (this.options.binLabels && alpha === 1) {
        const fill = bin.state === 'collected' ? `${bin.fillAtPickup}% → 0%` : `${Math.round(bin.fill)}%`;
        this._tag(ctx, `${bin.custom ? bin.name : bin.id} · ${fill}`, x, y - 25, COLORS.text);
        const who = bin.state === 'collected' ? `done by ${truckById.get(bin.collectedBy)?.name.replace('Truck ', 'T') ?? '?'}`
          : bin.state === 'pending' ? 'PENDING'
          : bin.state === 'missed' ? 'MISSED'
          : owner ? owner.name.replace('Truck ', 'T') : '';
        if (!route && bin.state !== 'collected') this._tag(ctx, 'Unassigned', x, y + 42, COLORS.textDim);
        if (who) this._tag(ctx, who, x, y + 25, owner ? owner.color : bin.state === 'pending' ? '#eab308' : COLORS.textDim);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** "3", "1–27" (stop numbers on a route) or "×27" (several bins on one point). */
  _drawSpotBadges(ctx) {
    const { tx, ty } = this;
    for (const list of this._spots || []) {
      const live = list.filter((b) => this.dragBin?.id !== b.id);
      if (!live.length) continue;
      const nums = live.map((b) => {
        if (this.pickNumbers) return this.pickNumbers.get(b.id);
        const r = b.routeId && this.sim.routes.get(b.routeId);
        return r ? numberOf(r, b.id) : undefined;
      }).filter((n) => n !== undefined).sort((a, b) => a - b);
      let text = live.length > 1 ? `×${live.length}` : '';
      if (nums.length === 1) text = live.length > 1 ? `${nums[0]} · ×${live.length}` : String(nums[0]);
      else if (nums.length) text = nums[nums.length - 1] - nums[0] === nums.length - 1 ? `${nums[0]}–${nums[nums.length - 1]}` : `${nums.length} stops`;
      if (!text) continue;
      const x = tx(live[0].x) - 11, y = ty(live[0].y) - 12;
      ctx.font = 'bold 12px "Segoe UI", sans-serif';
      const w = Math.max(18, ctx.measureText(text).width + 10);
      ctx.fillStyle = nums.length ? '#1d4ed8' : '#334155';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - 9, w, 18, 9);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y + 0.5);
    }
  }

  _drawTrucks(ctx) {
    const { graph, world, trucks } = this.sim;
    const { tx, ty } = this;
    const nowT = this.sim.time;
    this._truckSpots = []; // where each truck was drawn, for clicks

    const isParked = (t) => t.node === world.depot && t.arcPos === 0 && (t.status === 'idle' || t.status === 'driving');
    const shown = trucks.filter((t) => this._truckAlpha(t) > 0);
    this._drawParked(ctx, shown.filter(isParked));

    // Every other truck is drawn where it really is. Trucks on the same spot get a few pixels
    // of shift and their labels go below each other, so none of them seems to jump.
    // The truck whose details are open comes last, on top of the others.
    const seen = [];
    const open = (t) => this.highlight.has(t.id);
    const order = (t) => (open(t) ? 2 : this._truckAlpha(t) < 1 ? 0 : 1); // dimmed trucks go underneath
    const moving = shown.filter((t) => !isParked(t)).sort((a, b) => order(a) - order(b));
    moving.forEach((truck) => {
      const p = truckXY(graph, truck);
      const px = tx(p.x), py = ty(p.y);
      const k = seen.filter((s) => Math.hypot(s.x - px, s.y - py) < 14).length;
      seen.push({ x: px, y: py });
      const x = px + Math.min(k, 3) * 7, y = py - Math.min(k, 3) * 7;
      this._truckSpots.push({ id: truck.id, x, y, r: 20 });
      const blocked = truck.status === 'blocked';
      const accent = blocked ? '#ef4444' : truck.color;
      if (open(truck)) this._halo(ctx, x, y, 23);
      const alpha = this._truckAlpha(truck);
      ctx.globalAlpha = alpha;

      // truck icon in a white disc with a ring in the truck's colour
      this._marker(ctx, 'truck', x, y, 15, accent, '#0f172a', 4);

      // number badge (top-right), "!" when blocked
      ctx.beginPath();
      ctx.arc(x + 12, y - 12, 8, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 10px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(blocked ? '!' : truckNumber(truck), x + 12, y - 11.5);
      ctx.globalAlpha = 1;
      if (alpha < 1) return; // outside the selected area: no labels

      // ETA chip under the truck; while one truck or route is open, the others only show their name
      const brief = this.highlight.size > 0 && !open(truck);
      if (k < 4) this._chip(ctx, brief ? truckTag(truck) : etaShort(truck, nowT), px, py + 27 + k * 19, accent);

      // optional detailed ETA box to the right
      if (this.options.etaLabels) {
        this._labelBox(ctx, etaLines(truck, nowT), x + 24, y - 16 + k * 40, accent);
      }
    });
  }

  /** Yellow ring around the truck whose details are open. */
  _halo(ctx, x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /** Trucks waiting at the depot: numbered dots in a tidy block next to it. */
  _drawParked(ctx, parked) {
    if (parked.length === 0) return;
    const { graph, world } = this.sim;
    const step = 22;
    const cols = Math.min(7, parked.length);
    const rows = Math.ceil(parked.length / cols);
    const x = this.tx(graph.x[world.depot]);
    const y = this.ty(graph.y[world.depot]);
    const h = rows * step + 8;
    const top = y + 46 + h < this.canvas.clientHeight ? y + 46 : y - 30 - h; // below the depot's name, or above it
    const left = x - (cols * step) / 2;
    ctx.fillStyle = COLORS.labelBg;
    ctx.beginPath();
    ctx.roundRect(left - 5, top, cols * step + 10, h, 7);
    ctx.fill();
    parked.forEach((truck, i) => {
      const cx = left + (i % cols) * step + step / 2;
      const cy = top + 4 + Math.floor(i / cols) * step + step / 2;
      this._truckSpots.push({ id: truck.id, x: cx, y: cy, r: 11 });
      if (this.highlight.has(truck.id)) this._halo(ctx, cx, cy, 11);
      ctx.globalAlpha = this._truckAlpha(truck);
      ctx.beginPath();
      ctx.arc(cx, cy, 9, 0, Math.PI * 2);
      ctx.fillStyle = truck.color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 10px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(truckNumber(truck), cx, cy + 0.5);
      ctx.globalAlpha = 1;
    });
  }

  /** Small centred label with a coloured left bar (the truck ETA chip). */
  _chip(ctx, text, x, y, color) {
    ctx.font = '600 11px "Segoe UI", sans-serif';
    const w = ctx.measureText(text).width + 14;
    const left = x - w / 2;
    ctx.fillStyle = COLORS.labelBg;
    ctx.beginPath();
    ctx.roundRect(left, y - 9, w, 18, 4);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillRect(left, y - 9, 3, 18);
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 1.5, y);
  }

  // --------------------------------------------------------------- helpers

  _tag(ctx, text, x, y, color) {
    ctx.font = '11px "Segoe UI", sans-serif';
    const w = ctx.measureText(text).width + 8;
    // keep the whole label inside the canvas (e.g. the landfill name at the map's edge)
    const cw = this.canvas.clientWidth;
    if (w < cw) x = Math.min(cw - w / 2 - 2, Math.max(w / 2 + 2, x));
    ctx.fillStyle = COLORS.labelBg;
    ctx.fillRect(x - w / 2, y - 8, w, 16);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  _labelBox(ctx, lines, x, y, color) {
    ctx.font = '11.5px "Segoe UI", sans-serif';
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
    const h = lines.length * 15 + 6;
    // Flip to the left of the truck when the box would run off the right edge.
    if (x + w > this.canvas.clientWidth - 4) x = Math.max(4, x - w - 32);
    ctx.fillStyle = COLORS.labelBg;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 3, h);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => {
      ctx.fillStyle = i === 0 ? COLORS.text : COLORS.textDim;
      ctx.fillText(l, x + 7, y + 4 + i * 15);
    });
  }
}

/** Text for a truck's ETA label / card, e.g. "Truck 2 → Bin 14: ETA 4 min 30 s". */
export function etaLines(truck, now) {
  const eta = truck.eta;
  const load = `${Math.round(truck.load)}/${truck.maxCapacity} kg`;
  if (truck.status === 'blocked') return [`${truck.name}: BLOCKED — no route`, `waiting for a reopen · ${load}`];
  if (!eta || truck.status === 'idle') return [`${truck.name}: idle`, load];
  const verb = truck.status === 'servicing' ? 'emptying' : truck.status === 'unloading' ? 'unloading' : 'ETA';
  return [
    `${truck.name} → ${eta.targetName}: ${verb} ${fmtDuration(eta.nextAt - now)}`,
    `route end ${fmtDuration(eta.endAt - now)} · ${load}${truck.mode === 'full' ? ' · FULL' : ''}`,
  ];
}

/** Number shown in the truck badge: digits of the truck id (TRK-08 → 8, T3 → 3). */
export function truckNumber(truck) {
  const n = parseInt(String(truck.id).replace(/\D+/g, ''), 10);
  return Number.isFinite(n) ? String(n) : 'T';
}

/** Short truck tag for chips: "T2" for "Truck 2", otherwise the truck id (e.g. "TRK-08"). */
function truckTag(truck) {
  return /^Truck\s*\d+$/i.test(truck.name) ? truck.name.replace(/^Truck\s*/i, 'T') : String(truck.id);
}

/** One-line ETA for the chip under each truck, e.g. "T2 → Bin 14 · 4 min 30 s". */
export function etaShort(truck, now) {
  const tag = truckTag(truck);
  const eta = truck.eta;
  if (truck.status === 'blocked') return `${tag} · BLOCKED`;
  if (!eta || truck.status === 'idle') return `${tag} · idle`;
  let target = eta.targetName.replace(/^the /, '');
  if (target.length > 28) target = `${target.slice(0, 27)}…`; // long schedule stop names

  const verb = truck.status === 'servicing' ? 'emptying ' : truck.status === 'unloading' ? 'unloading ' : '';
  return `${tag} → ${target} · ${verb}${fmtDuration(eta.nextAt - now)}`;
}
