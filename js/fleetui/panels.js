/**
 * DOM panels for the fleet page: truck/ETA cards, run log, metrics, event log, run
 * comparison, legend. Pure rendering — reads the simulation, never changes it.
 */

import { ICON_PATHS } from './mapView.js';
import { BIN_STATUS_COLORS } from '../sim/fleet/bins.js';
import { truckRows } from '../sim/metrics.js';
import { fmtDuration } from '../sim/fleet/eta.js';
import { INCIDENTS, incidentLabel, incidentIcon } from '../sim/events/incidents.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
const nextAt = (t) => (t.eta && Number.isFinite(t.eta.nextAt) ? t.eta.nextAt : Infinity);

/** Which group a truck's card goes in: working now, waiting at the depot, or finished. */
function groupOf(t) {
  if (t.status !== 'idle') return 'active';
  return t.trip && t.trip.finishedAt !== null && t.trip.finishedAt !== undefined ? 'done' : 'idle';
}

function truckCard(t, sim, rank, dim) {
  const pct = Math.min(100, (t.load / t.maxCapacity) * 100);
  const eta = t.eta;
  const group = groupOf(t);
  let what, when = '', sub;
  const repair = t.incident && t.incident.until > sim.time && t.status !== 'idle';
  if (repair) { what = `${t.incident.icon} ${t.incident.label}`; when = fmtDuration(t.incident.until - sim.time); sub = `back on the road in ${when} · ${t.collected} collected`; }
  else if (t.status === 'blocked') { what = 'No route — waiting for a reopen'; sub = `${t.collected} collected`; }
  else if (group === 'done') { what = 'Trip finished'; sub = `${t.collected} collected`; }
  else if (!eta || t.status === 'idle') { what = 'Waiting at the depot'; sub = `${t.collected} collected`; }
  else {
    const verb = t.status === 'servicing' ? 'Emptying' : t.status === 'unloading' ? 'Unloading at' : 'To';
    const directions = /^(to|proceed|straight|left|right|turn|head|continue|go)\s/i.test(eta.targetName);
    what = verb === 'To' && directions ? eta.targetName : `${verb} ${eta.targetName}`;
    when = fmtDuration(eta.nextAt - sim.time);
    sub = `route ends in ${fmtDuration(eta.endAt - sim.time)} · ${t.collected} collected`;
  }
  const status = group === 'done' ? 'done' : repair ? 'repair' : t.mode === 'full' ? 'full' : t.status;
  const tip = `Show trip details${t.queue.length ? `
Next stops: ${t.queue.join(', ')}` : ''}`;
  return `
    <div class="truck-card s-${status}${t.status === 'blocked' ? ' blocked' : ''}${dim ? ' outside' : ''}" data-truck="${esc(t.id)}" title="${esc(tip)}" style="--truck:${t.color}">
      <div class="t-head">${rank ? `<span class="t-rank">${rank}</span>` : ''}<span class="t-name">${esc(t.name)}</span><span class="t-status">${esc(status)}</span></div>
      <div class="t-eta"><span class="t-what">${esc(what)}</span>${when ? `<b>${esc(when)}</b>` : ''}</div>
      <div class="t-sub">${esc(sub)}</div>
      <div class="t-load"><div class="loadbar ${pct >= 100 ? 'over' : ''}"><div style="width:${pct}%"></div></div><span>${Math.round(t.load)} / ${t.maxCapacity} kg</span></div>
    </div>`;
}

/**
 * Truck & ETA cards. Active trucks always come first — blocked ones on top, then the
 * soonest arrival (or by name) — followed by trucks waiting at the depot and finished ones.
 * opts: { sort: 'eta' | 'name', showIdle: boolean, summaryEl: HTMLElement }
 */
export function renderTruckList(el, sim, focus = null, opts = {}) {
  const { sort = 'eta', showIdle = true, summaryEl = null } = opts;
  const inArea = (t) => !focus || focus.trucks.has(t.id);
  const visible = sim.trucks.filter((t) => inArea(t) || !focus || focus.outside !== 'hide');
  const order = sort === 'name'
    ? (a, b) => (inArea(b) - inArea(a)) || byName(a, b)
    : (a, b) => (inArea(b) - inArea(a)) || ((b.status === 'blocked') - (a.status === 'blocked')) || (nextAt(a) - nextAt(b)) || byName(a, b);
  const groups = { active: [], idle: [], done: [] };
  for (const t of visible) groups[groupOf(t)].push(t);
  for (const g of Object.values(groups)) g.sort(order);

  const section = (key, title, list, ranked) => list.length === 0 ? '' :
    `<h4 class="t-group g-${key}">${title}<span>${list.length}</span></h4>` +
    list.map((t, i) => truckCard(t, sim, ranked ? i + 1 : 0, !inArea(t))).join('');
  let html = section('active', 'On the road', groups.active, true);
  if (showIdle) html += section('idle', 'Waiting at the depot', groups.idle, false) + section('done', 'Finished', groups.done, false);
  if (!html) html = `<p class="hint">${visible.length ? 'No truck is on the road right now.' : 'No truck is working in this area.'}</p>`;
  if (html !== el._html) { el.innerHTML = html; el._html = html; } // unchanged cards stay clickable

  if (summaryEl) {
    const blocked = groups.active.filter((t) => t.status === 'blocked').length;
    const collected = visible.reduce((n, t) => n + t.collected, 0);
    const chip = (cls, label, n) => `<span class="eta-chip ${cls}"><b>${n}</b> ${label}</span>`;
    const s = chip('c-active', 'on the road', groups.active.length) +
      (blocked ? chip('c-blocked', 'blocked', blocked) : '') +
      chip('c-idle', 'waiting', groups.idle.length) +
      chip('c-done', 'finished', groups.done.length) +
      chip('c-bins', 'bins collected', collected);
    if (s !== summaryEl._html) { summaryEl.innerHTML = s; summaryEl._html = s; }
  }
}

const IMPORTANT = new Set(['event', 'handoff', 'pending', 'warning', 'info']);

export function renderLog(el, entries, filter, inArea = null) {
  const rows = entries.filter((e) => (!inArea || inArea(e)) && (filter === 'all' || (filter === 'event' ? e.kind === 'event' : IMPORTANT.has(e.kind))));
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  el.innerHTML = rows.map((e) =>
    `<div class="log-row k-${e.kind}"><span class="lt">${e.clock}</span><span class="lk">${e.kind}</span><span class="lx">${esc(e.text)}</span></div>`,
  ).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

export function renderMetrics(table, s) {
  const rows = [
    ['Bins collected / missed', `${s.binsCollected} / ${s.binsMissed}`],
    ['Total distance', `${(s.totalDistanceM / 1000).toFixed(2)} km`],
    ['Total time (makespan)', fmtDuration(s.makespanS)],
    ['Sum of truck working time', fmtDuration(s.totalTruckTimeS)],
    ['A* calls', s.astarCalls],
    ['  route / reroute / ETA / assign', `${s.astarRouteCalls} / ${s.astarRerouteCalls} / ${s.astarEtaCalls} / ${s.astarAssignCalls}`],
    ['Avg A* time', `${s.astarAvgMs.toFixed(4)} ms`],
    ['Nodes expanded / search (avg, min–max)', `${s.nodesExpandedAvg} (${s.nodesExpandedMin}–${s.nodesExpandedMax})`],
    ['Leg-cache hits (not A* calls)', s.legCacheHits],
    ['Road events applied', s.eventsApplied],
    ['Reroutes caused by events', s.reroutes],
    ['Blocked incidents', s.blockedIncidents],
    ['Bin reassignments', s.reassignments],
    ['Disposal trips', s.disposalTrips],
    ['ETA mean absolute error', `${s.etaMaeS} s`],
    ['Status', s.finished ? `finished — ${s.finishReason}` : 'running'],
  ];
  table.innerHTML = `<tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody>`;
}

export function renderTruckTable(table, sim) {
  const rows = truckRows(sim);
  table.innerHTML = `
    <thead><tr><th>Truck</th><th>Status</th><th>Distance</th><th>Working time</th><th>Bins</th>
      <th>Load</th><th>Disposal trips</th><th>Reroutes</th><th>Blocked</th></tr></thead>
    <tbody>${rows.map((r, i) => `<tr>
      <td><span class="dot" style="background:${sim.trucks[i].color}"></span>${esc(r.truck)}</td>
      <td>${r.status}</td><td>${(r.distanceM / 1000).toFixed(2)} km</td><td>${fmtDuration(r.workingTimeS)}</td>
      <td>${r.binsCollected}</td><td>${Math.round(r.load)}/${r.maxCapacity}</td><td>${r.disposalTrips}</td>
      <td>${r.reroutes}</td><td>${r.blockedCount}</td></tr>`).join('')}</tbody>`;
}

export function renderEventTable(table, sim) {
  const upcoming = sim.events.upcoming();
  const kindCell = (e) => {
    const spec = INCIDENTS[e.cause] || INCIDENTS[e.type];
    const group = spec ? spec.group : 'road';
    return `<span class="ev-kind g-${group}">${incidentIcon(e)} ${esc(e.label || incidentLabel(e))}</span>`;
  };
  const whereOf = (e) => {
    const spec = INCIDENTS[e.cause] || INCIDENTS[e.type];
    if (spec && spec.group === 'bin') return 'a bin near a working truck';
    if (spec && spec.group === 'truck') return 'a working truck';
    if (e.near) return 'a road near a working truck';
    return sim.world.edgeLabel(e.edge);
  };
  const done = sim.eventLog.map((e) => `<tr>
      <td>${e.clock}</td><td class="left">${kindCell(e)}</td><td class="left">${esc(e.edge)}</td><td class="left">${esc(e.description)}</td>
      <td class="left">${e.rerouted.length ? esc(e.rerouted.join(', ')) : '—'}</td>
      <td class="left">${esc([...e.blocked.map((b) => `${b} blocked`), ...e.unblocked.map((b) => `${b} unblocked`)].join(', ') || '—')}</td>
      <td class="left">${e.source}</td></tr>`);
  const next = upcoming.slice(0, 8).map((e) => `<tr style="opacity:.5">
      <td>${fmtClockLocal(e.time)}</td><td class="left">${kindCell(e)}</td><td class="left">${esc(whereOf(e))}</td>
      <td class="left">scheduled${e.note ? ` — ${esc(e.note)}` : ''}</td><td class="left">—</td><td class="left">—</td><td class="left">${e.source}</td></tr>`);
  table.innerHTML = `
    <thead><tr><th>Time</th><th class="left">Event</th><th class="left">Where</th><th class="left">Effect</th>
      <th class="left">Rerouted trucks</th><th class="left">Blocked / unblocked</th><th class="left">Source</th></tr></thead>
    <tbody>${done.join('')}${next.join('')}${done.length + next.length === 0 ? '<tr><td colspan="7" class="left">No road events in this variant.</td></tr>' : ''}</tbody>`;
}

export function renderRunsTable(table, runs) {
  if (runs.length === 0) {
    table.innerHTML = '<tbody><tr><td class="left">Finished runs appear here. Try the sample with and without road events, or with fewer trucks.</td></tr></tbody>';
    return;
  }
  const cols = [
    ['Scenario', (r) => r.scenario], ['Variant', (r) => r.variant], ['Trucks', (r) => r.trucks],
    ['Collected', (r) => `${r.binsCollected}/${r.bins}`], ['Missed', (r) => r.binsMissed],
    ['Distance', (r) => `${(r.totalDistanceM / 1000).toFixed(2)} km`], ['Makespan', (r) => fmtDuration(r.makespanS)],
    ['A* calls', (r) => r.astarCalls], ['Avg A* ms', (r) => r.astarAvgMs.toFixed(4)],
    ['Expanded/search', (r) => r.nodesExpandedAvg], ['Reroutes', (r) => r.reroutes],
    ['Blocked', (r) => r.blockedIncidents], ['Reassign', (r) => r.reassignments],
  ];
  table.innerHTML = `<thead><tr>${cols.map(([h]) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${runs.map((r) => `<tr>${cols.map(([, f]) => `<td>${esc(f(r))}</td>`).join('')}</tr>`).join('')}</tbody>`;
}

export function renderLegend(el, sim) {
  const th = sim.world.settings.fill_thresholds;
  const item = (sw, label) => `<span class="legend-item">${sw}${esc(label)}</span>`;
  const box = (c) => `<span class="swatch" style="background:${c}"></span>`;
  // Same icons as on the map, so the legend says which marker is which.
  const svg = (kind, stroke, bg, ring) => `<span class="legend-icon" style="background:${bg};border-color:${ring}">` +
    `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="${stroke}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">` +
    `${ICON_PATHS[kind].map((d) => `<path d="${d}"/>`).join('')}</svg></span>`;
  el.innerHTML = [
    item(svg('truck', '#0f172a', '#fff', '#38bdf8'), 'truck (ring = its colour, chip = ETA)'),
    item('<span class="swatch" style="border-radius:50%;background:#38bdf8;border:1.5px solid #fff"></span>', 'numbered dot = truck parked at the depot'),
    item(svg('bin', '#0f172a', BIN_STATUS_COLORS.full, '#0f172a'), 'bin'),
    item(svg('depot', '#065f46', '#fff', '#059669'), sim.world.depotName || 'depot'),
    ...(sim.world.disposal !== sim.world.depot
      ? [item(svg('landfill', '#065f46', '#fff', '#059669'), sim.world.disposalName || 'disposal')] : []),
    item(box(BIN_STATUS_COLORS.low), `bin < ${th.medium}%`),
    item(box(BIN_STATUS_COLORS.medium), `bin ${th.medium}–${th.high}%`),
    item(box(BIN_STATUS_COLORS.full), `bin ≥ ${th.high}% (needs pickup)`),
    item(box(BIN_STATUS_COLORS.collected), 'collected'),
    item('<span class="swatch" style="border:3px solid #9ca3af"></span>', 'grey outline = Unassigned (not in a route area)'),
    item('<span class="swatch" style="border-radius:50%;background:#0e7490;border:1.5px solid #fff"></span>', 'schedule stop of the selected area (grey = not a collection stop)'),
    item('<span class="swatch line" style="background:#fb923c"></span>', 'traffic delay'),
    item('<span class="swatch dash"></span>', 'road closed'),
    ...sim.trucks.map((t) => item(`<span class="swatch line" style="background:${t.color}"></span>`, `${t.name} (ring = assigned bins)`)),
  ].join('');
}

function fmtClockLocal(s) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(Math.floor(s % 60))}`;
}
