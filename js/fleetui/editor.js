/**
 * Fleet page editor: bin limit, add / move / edit / delete bins, draw routes, trip details.
 *
 * The user's bins and routes are kept in localStorage (one set per scenario) and put back
 * on every reset or page refresh. All rules live in js/sim/fleet/routes.js.
 */

import { saveRoute, removeRoute, addBin, moveBin, updateBin, deleteBin, areaProblem, binSpotProblem, routeAt, binsInside, numberOf } from '../sim/fleet/routes.js';
import { truckDetails, routeDetails, fmtTime, TRIP_STEPS } from '../sim/fleet/trip.js';
import { visibleBins } from '../sim/fleet/bins.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LIMIT_KEY = 'ecoloop.fleet.binLimit';
const DELAY_KEY = 'ecoloop.fleet.truckDelays';
const EDIT_KEY = 'ecoloop.fleet.edits:';
const TYPES = ['General', 'Recyclable', 'Organic'];
const ROUTE_COLORS = ['#2563eb', '#db2777', '#7c3aed', '#ea580c', '#0d9488', '#ca8a04'];
const STATUS = {
  'On the way': { icon: '', cls: 'way' },
  Collecting: { icon: '', cls: 'collect' },
  Delayed: { icon: '', cls: 'late' },
  Finished: { icon: '', cls: 'done' },
};

function readStore(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: not remembered */ }
}

/** One time only: remove the routes saved before landfill trips existed. Bins are kept. */
function clearOldRoutes() {
  const flag = 'ecoloop.fleet.routesCleared.1';
  if (readStore(flag, false)) return;
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(EDIT_KEY)) continue;
    const saved = readStore(key, null);
    if (saved && Array.isArray(saved.routes)) writeStore(key, { ...saved, routes: [] });
  }
  writeStore(flag, true);
}

const emptyEdits = () => ({ added: [], changed: {}, deleted: [], routes: [] });

export class FleetEditor {
  /**
   * @param {object} map FleetMapView
   * @param {{rebuild:()=>Promise<void>, onChange:()=>void, onModeStart:()=>void, isPlaying:()=>boolean}} host
   */
  constructor(map, host) {
    this.map = map;
    this.host = host;
    this.sim = null;
    this.edits = emptyEdits();
    this.panel = null;      // what the side panel shows: {kind, id?, ...}
    this.redrawId = null;   // route being redrawn
    this.lastHtml = '';

    const rawLimit = readStore(LIMIT_KEY, 'all');
    const parsedLimit = rawLimit === 'all' ? Infinity : Number(rawLimit);
    this.limit = parsedLimit === Infinity || (Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 100)
      ? parsedLimit
      : Infinity;
    $('binLimit').value = this.limit === Infinity ? 'all' : String(this.limit);
    clearOldRoutes();
    $('optTruckDelays').checked = readStore(DELAY_KEY, true) !== false;
    map.getVisibleBins = () => (map.sim ? map.sim.bins : []);
    this._bind();
  }

  // ------------------------------------------------------------- lifecycle

  _loadEdits(world) {
    this.key = EDIT_KEY + world.name;
    const raw = readStore(this.key, null) || {};
    this.edits = {
      added: Array.isArray(raw.added) ? raw.added : [],
      changed: raw.changed && typeof raw.changed === 'object' ? raw.changed : {},
      deleted: Array.isArray(raw.deleted) ? raw.deleted : [],
      routes: Array.isArray(raw.routes) ? raw.routes : [],
    };
  }

  /**
   * Keep only the fullest bins in the run, so no truck ever collects a bin without a pin on
   * the map. Bins the user added come on top and are always there.
   */
  limitBins(world) {
    this._loadEdits(world);
    const { changed, deleted } = this.edits;
    const gone = new Set(deleted);
    // Testing area with "Run only this area's bins": the others do not take part.
    this.areaTest = this.host.binFilter?.(world) || null;
    const left = world.bins.filter((b) => !gone.has(b.id) && (!this.areaTest || this.areaTest({ ...b, ...changed[b.id] })));
    const ranked = visibleBins(left.map((b) => ({ id: b.id, fill: changed[b.id]?.fill ?? b.fill })), this.limit);
    const keep = new Set(ranked.map((b) => b.id));
    this.hiddenCount = left.length - keep.size;
    world.bins = left.filter((b) => keep.has(b.id));
    if (this.hiddenCount) world.variant += `, ${keep.size} fullest bins`;
  }

  /** A new simulation was built: put the saved bins and routes back. */
  attach(sim) {
    this.sim = sim;
    sim.truckDelays = $('optTruckDelays').checked;
    const skipped = [];
    const attempt = (what, fn) => {
      try { const r = fn(); if (r && !r.ok) skipped.push(what); } catch (err) { console.warn(what, err); skipped.push(what); }
    };
    const { added, changed, deleted, routes } = this.edits;
    for (const id of deleted) attempt(id, () => { deleteBin(sim, id); });
    for (const [id, c] of Object.entries(changed)) {
      if (!sim.binsById.has(id)) continue; // not collected on this schedule day
      attempt(id, () => { updateBin(sim, id, c); });
      if (Number.isFinite(c.x)) attempt(id, () => moveBin(sim, id, c.x, c.y));
    }
    for (const b of added) if (!this.areaTest || this.areaTest(b)) attempt(b.name, () => addBin(sim, b));
    for (const r of routes) attempt(r.name, () => saveRoute(sim, r));
    const parts = [];
    if (added.length + deleted.length + Object.keys(changed).length) parts.push('edited bins');
    if (routes.length) parts.push(`${routes.length} custom route${routes.length === 1 ? '' : 's'}`);
    if (parts.length) sim.world.variant += ` + ${parts.join(', ')}`; // keeps run comparisons honest
    if (skipped.length) this.say(`Could not put back: ${skipped.join(', ')}.`, 'err');
    this.setMode('none');
    const p = this.panel;
    if (p && ((p.kind === 'truck' && !sim.trucks.some((t) => t.id === p.id)) || (p.kind === 'route' && !sim.routes.has(p.id)) ||
      !['truck', 'route'].includes(p.kind))) this.closePanel();
    this.refresh();
  }

  _save() {
    writeStore(this.key, this.edits);
    this.host.onChange();
    this.refresh();
    this.map.render();
  }

  /** Apply an edit live; a finished run starts again so the edit can take effect. */
  async _apply(fn, record) {
    const finished = this.sim.finished;
    if (!finished) {
      const res = fn(this.sim);
      if (res && !res.ok) return res;
      record(res);
      this._save();
      return res || { ok: true };
    }
    record();
    writeStore(this.key, this.edits);
    await this.host.rebuild();
    this.say('The run had finished, so it was restarted with your change.', 'ok');
    return { ok: true };
  }

  say(text, kind = '', undo = null) {
    const el = $('editInfo');
    el.textContent = text;
    el.className = `hint ${kind}`;
    $('btnUndoMove').hidden = !undo;
    this.undo = undo;
  }

  // ----------------------------------------------------------------- modes

  setMode(mode) {
    this.map.setEditMode(mode);
    this.host.onMode?.(mode);
    $('btnAddBin').setAttribute('aria-pressed', String(mode === 'addBin'));
    $('btnAddBin').textContent = mode === 'addBin' ? 'Click map (Esc to stop)' : 'Add bin';
    $('btnCreateRoute').setAttribute('aria-pressed', String(mode === 'draw'));
    $('drawTools').hidden = mode !== 'draw' && mode !== 'drawZone';
    if (mode !== 'draw') this.redrawId = null;
  }

  _startDraw(redrawId = null) {
    this.host.onModeStart();
    this.closePanel();
    this.setMode('draw');
    this.redrawId = redrawId;
    this.say('Click the corners of the area on the map. Click the first corner again, or press Finish, to close it.');
  }

  _finishDraw() {
    const poly = this.map.draft.slice();
    if (this.map.editMode === 'drawZone') { // a testing area, not a route
      const wrong = this.host.onZoneDrawn(poly);
      if (wrong) this.say(`⚠ ${wrong}`, 'err'); else { this.setMode('none'); this.say('Testing area saved.', 'ok'); }
      return;
    }
    const problem = areaProblem(this.sim, poly, this.redrawId);
    if (problem) { this.say(`⚠ ${problem}`, 'err'); return; }
    if (this.redrawId) {
      const route = this.sim.routes.get(this.redrawId);
      const id = this.redrawId;
      this.setMode('none');
      this._storeRoute({ id, name: route.name, color: route.color, truckIds: route.truckIds, poly, excluded: route.excluded, order: route.order })
        .then((ok) => { if (ok) this.openPanel({ kind: 'route', id }); });
      return;
    }
    this.setMode('none');
    this.map.draftPreview = poly;
    this.map.render();
    const n = this.sim.routes.size;
    this.openPanel({ kind: 'routeForm', poly, name: `Route ${n + 1}`, color: ROUTE_COLORS[n % ROUTE_COLORS.length], truckIds: [] });
  }

  async _storeRoute(def) {
    const res = await this._apply((sim) => saveRoute(sim, def), () => {
      const i = this.edits.routes.findIndex((r) => r.id === def.id);
      if (i >= 0) this.edits.routes[i] = def; else this.edits.routes.push(def);
    });
    if (!res.ok) { this.say(`⚠ ${res.message}`, 'err'); return false; }
    const count = this.sim.bins.filter((b) => b.routeId === def.id).length;
    const lost = this.sim.bins.filter((b) => b.routeId === def.id && b.unreachable).length;
    const coming = this.sim.trucks.filter((t) => t.routeId === def.id && t.phase === 'toArea').length;
    this.say(`${def.name} saved: ${count} bin${count === 1 ? '' : 's'} on this route.` +
      (coming ? ` ${coming === 1 ? 'The truck drives' : `${coming} trucks drive`} there${this.host.isPlaying() ? ' now' : ' when you press Play'}.` : '') +
      (lost ? ` ${lost} cannot be reached by a road inside the area.` : ''), lost ? 'err' : 'ok');
    return true;
  }

  // ---------------------------------------------------------------- events

  _bind() {
    const { map } = this;
    $('binLimit').addEventListener('change', (e) => {
      this.limit = e.target.value === 'all' ? Infinity : Number(e.target.value);
      writeStore(LIMIT_KEY, e.target.value);
      if (this.sim) this.host.rebuild().then(() => this.say(`Now using ${this.sim.bins.length} bins. The run starts again.`, 'ok'));
    });
    $('optTruckDelays').addEventListener('change', (e) => {
      writeStore(DELAY_KEY, e.target.checked);
      if (this.sim) this.sim.truckDelays = e.target.checked;
    });
    $('btnAddBin').addEventListener('click', () => {
      const on = map.editMode !== 'addBin';
      this.host.onModeStart();
      this.setMode(on ? 'addBin' : 'none');
      this.say(on ? 'Click the map where the new bin should go.' : '');
    });
    $('btnCreateRoute').addEventListener('click', () => {
      if (map.editMode === 'draw') { this.setMode('none'); this.say(''); } else if (this.sim) this._startDraw();
    });
    $('btnDrawFinish').addEventListener('click', () => this._finishDraw());
    $('btnDrawUndo').addEventListener('click', () => { map.draft.pop(); map.render(); this.say(''); });
    $('btnDrawCancel').addEventListener('click', () => { this.setMode('none'); this.say('Drawing cancelled.'); });
    $('btnUndoMove').addEventListener('click', () => { const u = this.undo; this.say(''); if (u) u(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (map.editMode !== 'none') { this.setMode('none'); this.say(''); } else if (this.panel) this.closePanel();
    });

    map.onAddBin = (x, y) => {
      const problem = binSpotProblem(this.sim, x, y);
      if (problem) { this.say(`⚠ ${problem}`, 'err'); return; }
      this.setMode('none');
      map.newBinSpot = { x, y };
      this.openPanel({ kind: 'binForm', x, y, name: this._nextName(), type: 'General', capacityKg: this.sim.world.settings.bin_capacity_kg, fill: 50 });
    };
    map.onCloseDraft = () => this._finishDraw();
    map.onPickTruck = (id) => this.openPanel({ kind: 'truck', id });
    map.onPickBin = (id) => {
      const spot = map.binsAtSpot(this.sim.binsById.get(id));
      if (this.panel?.kind === 'routeForm') this._toggleBins(spot.map((b) => b.id));
      else if (spot.length > 1) this.openPanel({ kind: 'spot', ids: spot.map((b) => b.id) });
      else this.openPanel({ kind: 'binForm', id });
    };
    map.onPickRoute = (id) => this.openPanel({ kind: 'route', id });
    map.onMoveBin = (id, x, y) => this._move(id, x, y, true);

    // Cards and lists are redrawn live, so remember what was pressed at pointer-down.
    let pressed = null;
    for (const el of [$('truckList'), $('routeList')]) {
      el.addEventListener('pointerdown', (e) => {
        const c = e.target.closest('[data-truck],[data-route]');
        pressed = c ? { ...c.dataset } : null;
      });
      el.addEventListener('click', (e) => {
        const c = e.detail === 0 ? e.target.closest('[data-truck],[data-route]')?.dataset : pressed; // 0 = keyboard
        if (c?.truck) this.openPanel({ kind: 'truck', id: c.truck });
        else if (c?.route) this.openPanel({ kind: 'route', id: c.route });
      });
    }
    $('sideClose').addEventListener('click', () => this.closePanel());
    $('sideFoot').addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) this._action(b.dataset.act); });
    $('sideBody').addEventListener('submit', (e) => { e.preventDefault(); this._action('save'); });
    $('sideBody').addEventListener('click', (e) => {
      const b = e.target.closest('[data-bin]');
      if (b) { this.openPanel({ kind: 'binForm', id: b.dataset.bin, back: this.panel }); return; }
      const pickAll = e.target.closest('[data-pick]');
      if (pickAll && this.panel?.kind === 'routeForm') {
        this.panel.selected = pickAll.dataset.pick === 'all' ? this.panel.bins.map((x) => x.id) : [];
        this._syncPicks();
        return;
      }
      const t = e.target.closest('[data-truck]');
      if (t) this.openPanel({ kind: 'truck', id: t.dataset.truck });
    });
  }

  // ------------------------------------------------- choosing a route's bins

  _toggleBins(ids) {
    const p = this.panel;
    const mine = ids.filter((id) => p.bins.some((b) => b.id === id));
    if (!mine.length) { this.say('That bin is outside this area.', 'err'); return; }
    const allOn = mine.every((id) => p.selected.includes(id));
    p.selected = allOn ? p.selected.filter((id) => !mine.includes(id)) : [...p.selected, ...mine.filter((id) => !p.selected.includes(id))];
    this._syncPicks();
  }

  /** Selected ids in visit order: as ticked, or the list's shortest-way order. */
  _pickedIds() {
    const p = this.panel;
    return p.ownOrder ? p.selected : p.bins.map((b) => b.id).filter((id) => p.selected.includes(id));
  }

  /** Show ticks and numbers 1, 2, 3 … in the list and on the map. */
  _syncPicks() {
    const p = this.panel;
    const nums = new Map(this._pickedIds().map((id, i) => [id, i + 1]));
    for (const row of $('sideBody').querySelectorAll('.pick-row')) {
      const box = row.querySelector('input');
      box.checked = nums.has(box.value);
      row.querySelector('.pick-no').textContent = nums.get(box.value) ?? '–';
    }
    const c = $('sideBody').querySelector('.pick-count');
    if (c) c.textContent = `${nums.size} of ${p.bins.length} bins selected`;
    this.map.pickNumbers = nums;
    this.map.render();
  }

  _nextName() {
    const names = new Set(this.sim.bins.map((b) => b.name));
    let n = this.sim.bins.length + 1;
    while (names.has(`Bin #${n}`)) n++;
    return `Bin #${n}`;
  }

  async _move(id, x, y, canUndo) {
    const bin = this.sim.binsById.get(id);
    const from = { x: bin.x, y: bin.y };
    if (this.sim.finished) { // check first: a finished run is rebuilt from the saved edits
      const problem = binSpotProblem(this.sim, x, y);
      if (problem) { this.say(`⚠ ${problem} ${bin.name} was not moved.`, 'err'); this.map.render(); return; }
    }
    const res = await this._apply((sim) => moveBin(sim, id, x, y), (r) => this._record(id, r ? { x: r.bin.x, y: r.bin.y } : { x, y }));
    if (!res.ok) { this.say(`⚠ ${res.message} ${bin.name} was not moved.`, 'err'); this.map.render(); return; }
    const route = this.sim.routes.get(this.sim.binsById.get(id)?.routeId);
    this.say(canUndo ? `Moved ${bin.name} — ${route ? `in ${route.name}` : 'Unassigned'}.` : `Put ${bin.name} back.`, 'ok',
      canUndo ? () => this._move(id, from.x, from.y, false) : null);
  }

  _record(id, change) {
    const own = this.edits.added.find((b) => b.id === id);
    if (own) Object.assign(own, change);
    else this.edits.changed[id] = { ...(this.edits.changed[id] || {}), ...change };
  }

  // ----------------------------------------------------------------- panel

  openPanel(panel) {
    if (panel.kind !== 'routeForm' || !panel.poly) this.map.draftPreview = null;
    if (panel.kind !== 'binForm' || panel.id) this.map.newBinSpot = null;
    this.map.pickNumbers = null;
    this.map.highlight = new Set(panel.kind === 'truck' ? [panel.id]
      : panel.kind === 'route' ? this.sim.routes.get(panel.id)?.truckIds : []);
    this.panel = panel;
    this.lastHtml = '';
    $('sidePanel').hidden = false;
    $('sideBody').scrollTop = 0;
    this._renderPanel(true);
    this.map.render();
  }

  closePanel() {
    this.panel = null;
    this.map.highlight = new Set();
    this.map.pickNumbers = null;
    this.map.draftPreview = null;
    this.map.newBinSpot = null;
    $('sidePanel').hidden = true;
    this.map.render();
  }

  /** Called by the page a few times per second. */
  refresh() {
    const { sim } = this;
    if (!sim) return;
    const shown = sim.bins.length;
    const own = sim.bins.filter((b) => b.custom).length;
    $('binCount').textContent = `Showing ${shown} of ${shown + (this.hiddenCount || 0)} bins${own ? ` (${shown - own} fullest + ${own} you added)` : ''}`;
    const un = sim.bins.filter((b) => !b.routeId).length;
    const html = [...sim.routes.values()].map((r) => {
      const d = routeDetails(sim, r);
      return `<button type="button" class="route-card" data-route="${esc(r.id)}" style="--route:${esc(r.color)}">
        <span class="r-name">${esc(r.name)}</span><span>${STATUS[d.status].icon} ${d.status}</span>
        <span class="r-sub">${d.done} of ${d.total} bins collected</span></button>`;
    }).join('') + `<p class="hint">${sim.routes.size ? `${un} bin${un === 1 ? '' : 's'} Unassigned (grey outline).` : 'No routes yet. Use “Create Route” above the map.'}</p>`;
    if (html !== this.routeHtml) { $('routeList').innerHTML = html; this.routeHtml = html; }
    this._renderPanel();
  }

  _renderPanel(first = false) {
    const p = this.panel;
    if (!p) return;
    if (p.kind === 'truck') this._renderTruck(p, first);
    else if (p.kind === 'route') this._renderRoute(p, first);
    else if (first && p.kind === 'binForm') this._renderBinForm(p);
    else if (first && p.kind === 'routeForm') this._renderRouteForm(p);
    else if (first && p.kind === 'spot') this._renderSpot(p);
  }

  _foot(buttons) {
    $('sideFoot').innerHTML = buttons.map(([act, label, cls = '']) => `<button type="button" data-act="${act}" class="${cls}">${label}</button>`).join('');
  }

  _live(html) {
    if (html === this.lastHtml) return;
    const body = $('sideBody');
    const events = body.querySelector('.d-events');
    const top = body.scrollTop;
    const evTop = events ? events.scrollTop : 0;
    body.innerHTML = html;
    body.scrollTop = top;
    const now = body.querySelector('.d-events');
    if (now) now.scrollTop = evTop;
    this.lastHtml = html;
  }

  _details(d) {
    const s = STATUS[d.status];
    const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
    return `
      <div class="d-status ${s.cls}">${d.status}</div>
      <div class="d-row"><div class="d-label">Next stop</div><div class="d-big">${esc(d.next).replace(/ (AM|PM)/g, '&nbsp;$1')}</div></div>
      <div class="d-row"><div class="d-label">Progress</div><div class="d-big">${d.done} of ${d.total} bins collected</div>
        <div class="d-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Bins collected"><div style="width:${pct}%"></div></div>${this._steps(d.step)}</div>
      ${d.delay ? `<div class="d-row d-delay">${esc(d.delay)}</div>` : ''}
      <div class="d-row"><div class="d-label">Times</div><div class="d-mid">${d.startedAt === null ? 'Not started'
    : `Started ${fmtTime(d.startedAt)} · ${d.finished ? 'Finished' : 'Expected finish'} ${fmtTime(d.endAt)}`}</div></div>
      <div class="d-row"><div class="d-label">Events</div><ul class="d-events" tabindex="0" aria-label="Events, newest first">${d.events.length
    ? d.events.map((e) => `<li><b>${fmtTime(e.time)}</b> — ${esc(e.text)}</li>`).join('') : '<li>Nothing yet</li>'}</ul></div>`;
  }

  /** Where a route truck is in its trip: area → bins → landfill → depot (sign + word, never color alone). */
  _steps(step) {
    if (step === null || step === undefined) return '';
    return `<ol class="d-steps" aria-label="Parts of the trip">${TRIP_STEPS.map((name, i) => {
      const state = i < step ? 'done' : i === step ? 'now' : 'todo';
      return `<li class="${state}"${state === 'now' ? ' aria-current="step"' : ''}><span aria-hidden="true">${{ done: '✓', now: '▶', todo: '○' }[state]}</span>${name}</li>`;
    }).join('')}</ol>`;
  }

  _renderTruck(p, first) {
    const truck = this.sim.trucks.find((t) => t.id === p.id);
    if (!truck) { this.closePanel(); return; }
    const route = truck.routeId ? this.sim.routes.get(truck.routeId) : null;
    $('sideTitle').textContent = truck.name;
    $('sideSub').textContent = route ? `Collects only inside ${route.name}` : 'Not on a custom route';
    if (first) this._foot([]);
    this._live(this._details(truckDetails(this.sim, truck)));
  }

  _renderRoute(p, first) {
    const route = this.sim.routes.get(p.id);
    if (!route) { this.closePanel(); return; }
    const trucks = route.truckIds.map((id) => this.sim.trucks.find((t) => t.id === id)).filter(Boolean);
    $('sideTitle').textContent = route.name;
    $('sideSub').textContent = trucks.length ? `${trucks.length} truck${trucks.length === 1 ? '' : 's'}: ${trucks.map((t) => t.name).join(', ')}` : 'No truck assigned';
    if (first) this._foot([['edit', 'Edit'], ['redraw', 'Redraw area'], ['delete', 'Delete', 'danger']]);
    this._live(this._details(routeDetails(this.sim, route)));
  }

  _renderBinForm(p) {
    const bin = p.id ? this.sim.binsById.get(p.id) : null;
    if (p.id && !bin) { this.closePanel(); return; }
    const v = bin || p;
    const route = bin ? this.sim.routes.get(bin.routeId) : routeAt(this.sim, p.x, p.y);
    $('sideTitle').textContent = bin ? bin.name : 'New bin';
    $('sideSub').textContent = route ? `In ${route.name}${bin?.unreachable ? ' — no road inside the area reaches it' : ''}` : 'Unassigned (not in any route)';
    $('sideBody').innerHTML = `<form id="binForm" class="side-form">
      <label>Bin name<input name="name" type="text" maxlength="60" required value="${esc(v.name)}" /></label>
      <label>Type<select name="type">${TYPES.map((t) => `<option${t === v.type ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>Capacity (kg)<input name="capacityKg" type="number" min="1" max="5000" step="1" required value="${Math.round(v.capacityKg)}" /></label>
      <label>Current fill level (%)<input name="fill" type="number" min="0" max="100" step="1" required value="${Math.round(v.fill)}" /></label>
      ${bin ? '<p class="hint">Tip: drag the bin on the map to move it.</p>' : ''}
      <button type="submit" class="primary-inline">${bin ? 'Save changes' : 'Add bin'}</button></form>`;
    const area = bin ? routeAt(this.sim, bin.x, bin.y) : null;
    const swap = area ? [bin.routeId ? ['takeOut', 'Take out of route'] : ['putIn', 'Add to route']] : [];
    this._foot(bin ? [...(p.back ? [['back', '← Back']] : []), ...swap, ['deleteBin', 'Delete bin', 'danger']] : [['cancel', 'Cancel']]);
    if (!bin) $('sideBody').querySelector('input').select();
  }

  /** Several bins on one point: pick one. */
  _renderSpot(p) {
    const bins = p.ids.map((id) => this.sim.binsById.get(id)).filter(Boolean);
    $('sideTitle').textContent = `${bins.length} bins at this place`;
    $('sideSub').textContent = 'They stand on the same point. Choose one to edit or move.';
    $('sideBody').innerHTML = `<div class="pick-list tall">${bins.map((b, i) => {
      const r = this.sim.routes.get(b.routeId);
      return `<button type="button" class="spot-row" data-bin="${esc(b.id)}"><span class="pick-no">${r ? numberOf(r, b.id) : i + 1}</span>
        <span class="pick-name">${esc(b.name)}</span><span class="pick-fill">${b.state === 'collected' ? 'Done' : `${Math.round(b.fill)}%`}</span></button>`;
    }).join('')}</div>`;
    this._foot([]);
  }

  _renderRouteForm(p) {
    const saved = p.id ? this.sim.routes.get(p.id) : null;
    const poly = p.poly || saved.poly;
    p.bins = binsInside(this.sim, poly);
    if (saved) p.bins.sort((a, b) => (saved.numbers.get(a.id) ?? 1e9) - (saved.numbers.get(b.id) ?? 1e9));
    p.selected = p.bins.filter((b) => !saved || b.routeId === saved.id).map((b) => b.id);
    p.ownOrder = Boolean(saved?.order);
    const spots = new Set(p.bins.map((b) => `${Math.round(b.x)},${Math.round(b.y)}`)).size;
    const facts = [];
    if (spots < p.bins.length) facts.push(`${p.bins.length} bins stand on ${spots} point${spots === 1 ? '' : 's'} of the map, so they overlap.`);
    const usedBy = new Map();
    for (const r of this.sim.routes.values()) if (r.id !== p.id) for (const t of r.truckIds) usedBy.set(t, r.name);
    $('sideTitle').textContent = p.id ? 'Edit route' : 'New route';
    $('sideSub').textContent = 'Trucks drive here from the depot, collect only inside this area, unload at the landfill and return to the depot.';
    $('sideBody').innerHTML = `<form class="side-form">
      <label>Route name<input name="name" type="text" maxlength="40" required value="${esc(p.name)}" /></label>
      <label>Color<input name="color" type="color" value="${esc(p.color)}" /></label>
      <fieldset><legend>Trucks (choose one or more)</legend>${this.sim.trucks.map((t) => `
        <label class="check"><input type="checkbox" name="truck" value="${esc(t.id)}" ${p.truckIds.includes(t.id) ? 'checked' : ''} ${usedBy.has(t.id) ? 'disabled' : ''} />
        ${esc(t.name)}${usedBy.has(t.id) ? ` — on ${esc(usedBy.get(t.id))}` : ''}</label>`).join('')}</fieldset>
      ${p.bins.length ? `<fieldset class="pick-set"><legend>Bins on this route</legend>
        <div class="pick-head"><strong class="pick-count" aria-live="polite"></strong>
          <button type="button" class="small" data-pick="all">All</button><button type="button" class="small" data-pick="none">None</button></div>
        ${facts.length ? `<p class="hint">${facts.join(' ')}</p>` : ''}
        <p class="hint">Tick bins here, or click them on the map.</p>
        <div class="pick-list">${p.bins.map((b) => `<label class="pick-row"><input type="checkbox" name="bin" value="${esc(b.id)}" />
          <span class="pick-no"></span><span class="pick-name">${esc(b.name)}</span>
          <span class="pick-fill">${b.state === 'collected' ? 'Done' : `${Math.round(b.fill)}%`}</span></label>`).join('')}</div>
        <label class="pick-order">Visit them in
          <select name="order"><option value="nearest">the shortest way</option><option value="own" ${p.ownOrder ? 'selected' : ''}>the order I select: 1, 2, 3 …</option></select></label>
      </fieldset>` : '<p class="hint">No shown bins inside this area. Bins you add inside it will join this route.</p>'}
      <p class="side-err" role="alert"></p>
      <button type="submit" class="primary-inline">Save route</button></form>`;
    this._foot([['cancel', 'Cancel']]);
    const body = $('sideBody');
    for (const box of body.querySelectorAll('[name=bin]')) box.addEventListener('change', () => this._toggleBins([box.value]));
    body.querySelector('[name=order]')?.addEventListener('change', (e) => { p.ownOrder = e.target.value === 'own'; this._syncPicks(); });
    this._syncPicks();
  }

  async _action(act) {
    const p = this.panel;
    if (!p || !this.sim) return;
    const form = $('sideBody').querySelector('form');
    if (act === 'cancel') { if (p.kind === 'routeForm' && p.id) this.openPanel({ kind: 'route', id: p.id }); else this.closePanel(); return; }

    if (p.kind === 'route') {
      const route = this.sim.routes.get(p.id);
      if (act === 'edit') this.openPanel({ kind: 'routeForm', id: p.id, name: route.name, color: route.color, truckIds: route.truckIds });
      else if (act === 'redraw') this._startDraw(p.id);
      else if (act === 'delete' && confirm(`Delete ${route.name}? Its bins become Unassigned.`)) {
        this.closePanel();
        await this._apply((sim) => { removeRoute(sim, p.id); }, () => { this.edits.routes = this.edits.routes.filter((r) => r.id !== p.id); });
        this.say(`Deleted ${route.name}.`, 'ok');
      }
      return;
    }

    if (p.kind === 'routeForm' && act === 'save') {
      const data = new FormData(form);
      const name = String(data.get('name')).trim();
      const truckIds = data.getAll('truck').map(String);
      const err = !name ? 'Please give the route a name.' : truckIds.length === 0 ? 'Please choose at least one truck.'
        : p.bins.length && !p.selected.length ? 'Please select at least one bin.' : '';
      if (err) { form.querySelector('.side-err').textContent = err; return; }
      const id = p.id || `R${Date.now().toString(36)}`;
      const ok = await this._storeRoute({ id, name, color: String(data.get('color')), truckIds, poly: p.poly || this.sim.routes.get(id).poly,
        excluded: p.bins.map((b) => b.id).filter((b) => !p.selected.includes(b)), order: p.ownOrder ? p.selected.slice() : null });
      if (ok) this.openPanel({ kind: 'route', id }); else form.querySelector('.side-err').textContent = $('editInfo').textContent;
      return;
    }

    if (p.kind === 'binForm' && act === 'save') {
      const data = new FormData(form);
      const values = {
        name: String(data.get('name')).trim(),
        type: String(data.get('type')),
        capacityKg: Math.min(5000, Math.max(1, Number(data.get('capacityKg')) || 1)),
        fill: Math.min(100, Math.max(0, Number(data.get('fill')) || 0)),
      };
      if (!values.name) return;
      if (p.id) {
        const bin = this.sim.binsById.get(p.id);
        // Keep the exact fill when the rounded number in the form was not touched.
        if (values.fill === Math.round(bin.fill)) delete values.fill;
        await this._apply((sim) => updateBin(sim, p.id, values), () => this._record(p.id, values));
        this.closePanel();
        this.say(`Saved ${values.name}.`, 'ok');
      } else {
        const bin = { id: `U${Date.now().toString(36)}`, x: p.x, y: p.y, ...values };
        const res = await this._apply((sim) => addBin(sim, bin),
          (r) => this.edits.added.push(r ? { ...bin, x: r.bin.x, y: r.bin.y } : bin));
        if (!res.ok) { this.say(`⚠ ${res.message}`, 'err'); return; }
        this.closePanel();
        const route = this.sim.routes.get(this.sim.binsById.get(bin.id)?.routeId);
        this.say(`Added ${bin.name} — ${route ? `joined ${route.name}` : 'Unassigned'}.`, 'ok');
        this.refresh();
      }
      return;
    }

    if (act === 'back') { this.openPanel(p.back); return; }

    if (act === 'takeOut' || act === 'putIn') {
      const bin = this.sim.binsById.get(p.id);
      const r = routeAt(this.sim, bin.x, bin.y);
      const excluded = r.excluded.filter((id) => id !== p.id);
      const order = r.order ? r.order.filter((id) => id !== p.id) : null;
      if (act === 'takeOut') excluded.push(p.id); else order?.push(p.id);
      const ok = await this._storeRoute({ id: r.id, name: r.name, color: r.color, truckIds: r.truckIds, poly: r.poly, excluded, order });
      if (ok) this.openPanel(p);
      return;
    }

    if (act === 'deleteBin') {
      const bin = this.sim.binsById.get(p.id);
      if (!confirm(`Delete ${bin.name}?`)) return;
      this.closePanel();
      await this._apply((sim) => { deleteBin(sim, p.id); }, () => {
        const own = this.edits.added.findIndex((b) => b.id === p.id);
        if (own >= 0) this.edits.added.splice(own, 1);
        else { delete this.edits.changed[p.id]; this.edits.deleted.push(p.id); }
      });
      this.say(`Deleted ${bin.name}.`, 'ok');
    }
  }
}
