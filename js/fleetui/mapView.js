/**
 * Fleet map — canvas renderer for the simulation state.
 *
 * Layers, bottom to top
 *   roads        gray; DELAYED roads orange with a "×2.5" tag; CLOSED roads red dashed + ✕
 *   paths        each truck's remaining planned route in its colour
 *   depot / disposal
 *   bins         square coloured by status (green / yellow / red / gray), labelled with
 *                id + fill %, and a tag in the colour of the truck it is assigned to
 *   trucks       numbered disc; BLOCKED trucks get a red ring and "!"
 *   ETA labels   "Truck 2 → Bin 14: ETA 4 min 30 s" next to each truck
 *
 * Reads the simulation, never writes to it. Zoom (wheel) and pan (drag) are view-only.
 */

import { binColor } from '../sim/fleet/bins.js';
import { truckXY } from '../sim/fleet/truck.js';
import { fmtDuration } from '../sim/fleet/eta.js';

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
    this.options = { paths: true, etaLabels: true, binLabels: true, nodeIds: false };
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this._bindInteraction();
    new ResizeObserver(() => this.render()).observe(canvas);
  }

  setSimulation(sim) {
    this.sim = sim;
    this.resetView();
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
    c.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.pan.x += e.clientX - drag.x;
      this.pan.y += e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
      this.render();
    });
    c.addEventListener('pointerup', () => { drag = null; });
    c.addEventListener('dblclick', () => this.resetView());
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
    this._drawRoads(ctx);
    if (this.options.paths) this._drawPaths(ctx);
    this._drawSites(ctx);
    this._drawBins(ctx);
    this._drawTrucks(ctx);
  }

  _drawRoads(ctx) {
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
    ctx.strokeStyle = COLORS.road;
    ctx.lineWidth = dense ? 1 : 4;
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
      const off = (i - 1) * 3; // small offset so overlapping routes stay distinguishable
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

  _drawSites(ctx) {
    const { graph, world } = this.sim;
    const { tx, ty } = this;
    const site = (node, label, color) => {
      const x = tx(graph.x[node]), y = ty(graph.y[node]);
      ctx.fillStyle = color;
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y - 13); ctx.lineTo(x + 12, y); ctx.lineTo(x, y + 13); ctx.lineTo(x - 12, y); ctx.closePath();
      ctx.fill(); ctx.stroke();
      this._tag(ctx, label, x, y + 24, color);
    };
    if (world.disposal !== world.depot) site(world.disposal, 'DISPOSAL', COLORS.disposal);
    site(world.depot, world.disposal === world.depot ? 'DEPOT / DISPOSAL' : 'DEPOT', COLORS.depot);
  }

  _drawBins(ctx) {
    const { graph, world, trucks } = this.sim;
    const { tx, ty } = this;
    const th = world.settings.fill_thresholds;
    const truckById = new Map(trucks.map((t) => [t.id, t]));

    for (const bin of this.sim.bins) {
      const x = tx(graph.x[bin.node]), y = ty(graph.y[bin.node]);
      const s = 9;
      ctx.fillStyle = binColor(bin, th);
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(x - s, y - s, 2 * s, 2 * s, 3);
      ctx.fill();
      ctx.stroke();

      // assigned truck: ring in the truck's colour
      const owner = bin.state === 'assigned' ? truckById.get(bin.truckId) : null;
      if (owner) {
        ctx.strokeStyle = owner.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(x - s - 4, y - s - 4, 2 * s + 8, 2 * s + 8, 5);
        ctx.stroke();
      }
      if (bin.state === 'collected') {
        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 12px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('✓', x, y + 1);
      }

      if (this.options.binLabels) {
        const fill = bin.state === 'collected' ? `${bin.fillAtPickup}% → 0%` : `${Math.round(bin.fill)}%`;
        this._tag(ctx, `${bin.id} · ${fill}`, x, y - 22, COLORS.text);
        const who = bin.state === 'collected' ? `done by ${truckById.get(bin.collectedBy)?.name.replace('Truck ', 'T') ?? '?'}`
          : bin.state === 'pending' ? 'PENDING'
          : bin.state === 'missed' ? 'MISSED'
          : owner ? owner.name.replace('Truck ', 'T') : '';
        if (who) this._tag(ctx, who, x, y + 22, owner ? owner.color : bin.state === 'pending' ? '#eab308' : COLORS.textDim);
      }
    }
  }

  _drawTrucks(ctx) {
    const { graph } = this.sim;
    const { tx, ty } = this;
    const nowT = this.sim.time;

    // Group trucks standing at the same spot so their labels stack instead of overlapping.
    const stack = new Map();
    this.sim.trucks.forEach((truck) => {
      const p = truckXY(graph, truck);
      const x = tx(p.x), y = ty(p.y);
      const key = `${Math.round(x / 6)},${Math.round(y / 6)}`;
      const k = stack.get(key) || 0;
      stack.set(key, k + 1);
      const dx = k * 9;

      ctx.beginPath();
      ctx.arc(x + dx, y, 11, 0, Math.PI * 2);
      ctx.fillStyle = truck.color;
      ctx.fill();
      ctx.lineWidth = truck.status === 'blocked' ? 4 : 2;
      ctx.strokeStyle = truck.status === 'blocked' ? '#ef4444' : '#0f172a';
      ctx.stroke();
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 12px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(truck.status === 'blocked' ? '!' : truck.name.replace(/\D+/g, '') || 'T', x + dx, y + 1);

      if (this.options.etaLabels) {
        const lines = etaLines(truck, nowT);
        this._labelBox(ctx, lines, x + dx + 16, y - 10 + k * 40, truck.status === 'blocked' ? '#ef4444' : truck.color);
      }
    });
  }

  // --------------------------------------------------------------- helpers

  _tag(ctx, text, x, y, color) {
    ctx.font = '11px "Segoe UI", sans-serif';
    const w = ctx.measureText(text).width + 8;
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
