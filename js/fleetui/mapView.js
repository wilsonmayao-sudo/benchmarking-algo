/**
 * Fleet map — canvas renderer for the simulation state.
 *
 * Layers, bottom to top
 *   street map   OpenStreetMap tiles (imported lat/lng maps only, same tiles as the
 *                WebApp's Live Monitoring fallback map) — needs internet, else skipped
 *   roads        simulation road network; DELAYED orange "×2.5", CLOSED red dashed + ✕
 *   paths        each truck's remaining planned route in its colour
 *   depot / disposal   white round markers with warehouse / landfill icons + name
 *   bins         trash-bin icon on a tile coloured by status (green / yellow / red / gray),
 *                ring + tag in the colour of the truck it is assigned to
 *   trucks       truck icon in a white disc with the truck's colour, number badge, and an
 *                ETA chip underneath ("→ Bin 14 · 4 min 30 s"); BLOCKED trucks turn red
 *   ETA details  optional 2-line box: "Truck 2 → Bin 14: ETA 4 min 30 s" + route end, load
 *
 * Icons are the same Lucide line icons the WebApp map markers use.
 * Reads the simulation, never writes to it. Zoom (wheel) and pan (drag) are view-only.
 */

import { binColor } from '../sim/fleet/bins.js';
import { truckXY } from '../sim/fleet/truck.js';
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
    this.options = { paths: true, etaLabels: true, binLabels: true, nodeIds: false, basemap: true };
    this.tiles = new Map(); // "z/x/y" → { img, ok }
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    /** Road-picking mode: when set, a click (not a drag) on a road calls onRoadPick(edge). */
    this.pickMode = false;
    this.onRoadPick = null;
    this.hoverEdge = -1;
    this._bindInteraction();
    new ResizeObserver(() => this.render()).observe(canvas);
  }

  setSimulation(sim) {
    this.sim = sim;
    this.hoverEdge = -1;
    this.resetView();
  }

  setPickMode(on) {
    this.pickMode = on;
    this.hoverEdge = -1;
    this.canvas.classList.toggle('picking', on);
    this.render();
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

  resetView() {
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.render();
  }

  // ------------------------------------------------------------- transform

  _fit() {
    const { graph } = this.sim;
    const b = graph.bounds();
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const pad = 70;
    const spanX = Math.max(1, b.maxX - b.minX);
    const spanY = Math.max(1, b.maxY - b.minY);
    const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY) * this.zoom;
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
      // zoom about the cursor
      this.pan.x = mx - (mx - this.pan.x) * f;
      this.pan.y = my - (my - this.pan.y) * f;
      this.zoom *= f;
      this.render();
    }, { passive: false });

    let drag = null;
    c.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) {
        if (this.pickMode) {
          const hit = this.edgeAt(e.clientX, e.clientY);
          if (hit !== this.hoverEdge) { this.hoverEdge = hit; this.render(); }
        }
        return;
      }
      this.pan.x += e.clientX - drag.x;
      this.pan.y += e.clientY - drag.y;
      drag = { ...drag, x: e.clientX, y: e.clientY };
      this.render();
    });
    c.addEventListener('pointerup', (e) => {
      // A click (moved < 5 px) in pick mode places an event; anything longer was a pan.
      const isClick = drag && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5;
      drag = null;
      if (isClick && this.pickMode && this.onRoadPick) {
        const hit = this.edgeAt(e.clientX, e.clientY);
        if (hit >= 0) this.onRoadPick(hit);
      }
    });
    c.addEventListener('pointerleave', () => {
      if (this.hoverEdge !== -1) { this.hoverEdge = -1; this.render(); }
    });
    c.addEventListener('dblclick', () => { if (!this.pickMode) this.resetView(); });
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
    if (!this.sim) return;

    this._fit();
    const street = this.options.basemap && this.sim.world.geo;
    if (street) this._drawBasemap(ctx, w, h, dpr);
    this._drawRoads(ctx, street);
    if (this.options.paths) this._drawPaths(ctx);
    this._drawSites(ctx);
    this._drawBins(ctx);
    this._drawTrucks(ctx);
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
    ctx.beginPath();
    for (let e = 0; e < graph.edgeCount; e++) {
      if (road.closed[e] || road.multiplier[e] !== 1) continue;
      const u = graph.edgeFrom[e], v = graph.edgeTo[e];
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
      if (truck.arcs.length === 0) return;
      const off = ((i % 5) - 2) * 2; // small, bounded offset so overlapping routes stay distinguishable
      const p = truckXY(graph, truck);
      ctx.beginPath();
      ctx.moveTo(tx(p.x) + off, ty(p.y) + off);
      for (const a of truck.arcs) {
        const v = graph.adjNeighbor[a];
        ctx.lineTo(tx(graph.x[v]) + off, ty(graph.y[v]) + off);
      }
      ctx.strokeStyle = truck.color;
      ctx.globalAlpha = 0.75;
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
    const site = (node, kind, label) => {
      const x = tx(graph.x[node]), y = ty(graph.y[node]);
      // outer emerald halo = facility (as on the WebApp map)
      ctx.beginPath();
      ctx.arc(x, y, 21, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(5, 150, 105, 0.55)';
      ctx.lineWidth = 3;
      ctx.stroke();
      this._marker(ctx, kind, x, y, 16, '#059669', '#065f46', 3);
      this._tag(ctx, label, x, y + 32, '#6ee7b7');
    };
    if (world.disposal !== world.depot) site(world.disposal, 'landfill', world.disposalName || 'DISPOSAL');
    site(world.depot, 'depot', world.disposal === world.depot
      ? `${world.depotName || 'DEPOT'} / DISPOSAL`
      : world.depotName || 'DEPOT');
  }

  _drawBins(ctx) {
    const { graph, world, trucks } = this.sim;
    const { tx, ty } = this;
    const th = world.settings.fill_thresholds;
    const truckById = new Map(trucks.map((t) => [t.id, t]));

    for (const bin of this.sim.bins) {
      const x = tx(graph.x[bin.node]), y = ty(graph.y[bin.node]);
      const s = 11;
      // tile coloured by status, with a trash-bin icon so bins never look like trucks
      ctx.fillStyle = binColor(bin, th);
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.5;
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

      if (this.options.binLabels) {
        const fill = bin.state === 'collected' ? `${bin.fillAtPickup}% → 0%` : `${Math.round(bin.fill)}%`;
        this._tag(ctx, `${bin.id} · ${fill}`, x, y - 25, COLORS.text);
        const who = bin.state === 'collected' ? `done by ${truckById.get(bin.collectedBy)?.name.replace('Truck ', 'T') ?? '?'}`
          : bin.state === 'pending' ? 'PENDING'
          : bin.state === 'missed' ? 'MISSED'
          : owner ? owner.name.replace('Truck ', 'T') : '';
        if (who) this._tag(ctx, who, x, y + 25, owner ? owner.color : bin.state === 'pending' ? '#eab308' : COLORS.textDim);
      }
    }
  }

  _drawTrucks(ctx) {
    const { graph } = this.sim;
    const { tx, ty } = this;
    const nowT = this.sim.time;

    // Group trucks standing at the same spot so they sit side by side instead of on top.
    const stack = new Map();
    this.sim.trucks.forEach((truck) => {
      const p = truckXY(graph, truck);
      const y = ty(p.y);
      const key = `${Math.round(tx(p.x) / 8)},${Math.round(y / 8)}`;
      const k = stack.get(key) || 0;
      stack.set(key, k + 1);
      const x = tx(p.x) + k * 34;
      const blocked = truck.status === 'blocked';
      const accent = blocked ? '#ef4444' : truck.color;

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

      // ETA chip under the truck — always shown
      this._chip(ctx, etaShort(truck, nowT), x, y + 27, accent);

      // optional detailed ETA box to the right
      if (this.options.etaLabels) {
        this._labelBox(ctx, etaLines(truck, nowT), x + 24, y - 16 + k * 40, accent);
      }
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
