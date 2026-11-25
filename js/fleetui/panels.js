/**
 * DOM panels for the fleet page: truck/ETA cards, run log, metrics, event log, run
 * comparison, legend. Pure rendering — reads the simulation, never changes it.
 */

import { etaLines, ICON_PATHS } from './mapView.js';
import { BIN_STATUS_COLORS } from '../sim/fleet/bins.js';
import { truckRows, timingSummary } from '../sim/metrics.js';
import { fmtDuration, fmtClock } from '../sim/fleet/eta.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderTruckList(el, sim, focus = null) {
  // Selected testing area: its trucks first, the others dimmed or left out.
  const inArea = (t) => !focus || focus.trucks.has(t.id);
  const list = focus ? [...sim.trucks.filter(inArea), ...(focus.outside === 'hide' ? [] : sim.trucks.filter((t) => !inArea(t)))] : sim.trucks;
  const html = list.map((t) => {
    const [l1, l2] = etaLines(t, sim.time);
    const pct = Math.min(100, (t.load / t.maxCapacity) * 100);
    return `
      <div class="truck-card ${t.status === 'blocked' ? 'blocked' : ''}${inArea(t) ? '' : ' outside'}" data-truck="${esc(t.id)}" title="Show trip details" style="--truck:${t.color}">
        <div class="t-head"><span class="t-name"><span class="dot" style="background:${t.color}"></span>${esc(t.name)}</span><span class="t-status">${t.status}${t.mode !== 'collect' ? ` · ${t.mode}` : ''}</span></div>
        <div class="t-eta">${esc(l1)}</div>
        <div class="t-sub">${esc(l2)}</div>
        <div class="t-sub">queue: ${t.queue.length ? esc(t.queue.join(', ')) : '—'} · ${t.collected} collected</div>
        <div class="loadbar ${pct >= 100 ? 'over' : ''}"><div style="width:${pct}%"></div></div>
      </div>`;
  }).join('') || '<p class="hint">No truck is working in this area.</p>';
  if (html !== el._html) { el.innerHTML = html; el._html = html; } // unchanged cards stay clickable
}

const IMPORTANT = new Set(['event', 'handoff', 'pending', 'warning', 'info']);

export function renderLog(el, entries, filter, inArea = null) {
  const rows = entries.filter((e) => (!inArea || inArea(e)) && (filter === 'all' || (filter === 'event' ? e.kind === 'event' : IMPORTANT.has(e.kind))));
  const html = rows.map((e) =>
    `<div class="log-row k-${e.kind}"><span class="lt">${e.clock}</span><span class="lk">${e.kind}</span><span class="lx">${esc(e.text)}</span></div>`,
  ).join('');
  if (html === el._html) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  el.innerHTML = html;
  el._html = html;
  if (atBottom) el.scrollTop = el.scrollHeight;
}

export function renderMetrics(table, s, playing = false, sim = null) {
  const status = s.finished
    ? `finished — ${s.finishReason}`
    : playing
      ? 'running'
      : s.makespanS > 0
        ? 'paused'
        : 'ready';
  const tm = sim ? timingSummary(sim) : null;
  const rows = [
    [s.finished ? 'Bins collected / missed' : 'Bins collected / remaining', `${s.binsCollected} / ${s.binsMissed}`],
    ['Coverage (planned / confirmed)', `${s.plannedCoveragePct}% / ${s.confirmedCoveragePct}%`],
    ['Total distance (coll / disp / ret)', `${(s.totalDistanceM / 1000).toFixed(2)} km (${(s.collectionDistanceM / 1000).toFixed(2)} / ${(s.disposalDistanceM / 1000).toFixed(2)} / ${(s.returnDistanceM / 1000).toFixed(2)})`],
    ['Repeated road / Backtracking', `${(s.repeatedRoadRatio * 100).toFixed(1)}% (${(s.repeatedRoadDistanceM / 1000).toFixed(2)} km) / ${(s.backtrackingDistanceM || 0).toFixed(0)} m`],
    ['Total time (makespan)', fmtDuration(s.makespanS)],
    ['Sum of truck working time', fmtDuration(s.totalTruckTimeS)],
    ['A* calls', s.astarCalls],
    ['  route / reroute / ETA / assign', `${s.astarRouteCalls} / ${s.astarRerouteCalls} / ${s.astarEtaCalls} / ${s.astarAssignCalls}`],
    ['Avg A* time', `${s.astarAvgMs.toFixed(4)} ms`],
    ...(tm && tm.altPrepMs > 0 ? [['ALT prep / sequencing / memory', `${tm.altPrepMs.toFixed(1)} ms / ${tm.sequencingTotalMs.toFixed(1)} ms / ${(s.memoryBytes / 1024).toFixed(0)} KB`]] : []),
    ['Nodes expanded / search (avg, min–max)', `${s.nodesExpandedAvg} (${s.nodesExpandedMin}–${s.nodesExpandedMax})`],
    ['Leg-cache hits (not A* calls)', s.legCacheHits],
    ['Road events applied', s.eventsApplied],
    ['Reroutes (events / GPS dev / offline)', `${s.reroutes} / ${s.deviationReroutes} / ${s.offlineFallbackReroutes}`],
    ['Blocked incidents', s.blockedIncidents],
    ['Bin reassignments', s.reassignments],
    ['Disposal trips (unload confirms)', `${s.disposalTrips} (${s.unloadConfirmations})`],
    ['ETA mean absolute error', `${s.etaMaeS} s`],
    ['Status', status],
  ];
  const html = `<tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody>`;
  if (html !== table._html) { table.innerHTML = html; table._html = html; }
}

export function renderTruckTable(table, sim) {
  const rows = truckRows(sim);
  const html = `
    <thead><tr><th>Truck</th><th>Status</th><th>Distance</th><th>Working time</th><th>Bins</th>
      <th>Load</th><th>Disposal trips</th><th>Reroutes</th><th>Blocked</th></tr></thead>
    <tbody>${rows.map((r, i) => `<tr>
      <td><span class="dot" style="background:${sim.trucks[i].color}"></span>${esc(r.truck)}</td>
      <td>${esc(r.status)}</td><td>${(r.distanceM / 1000).toFixed(2)} km</td><td>${fmtDuration(r.workingTimeS)}</td>
      <td>${r.binsCollected}</td><td>${Math.round(r.load)}/${r.maxCapacity}</td><td>${r.disposalTrips}</td>
      <td>${r.reroutes}</td><td>${r.blockedCount}</td></tr>`).join('')}</tbody>`;
  if (html !== table._html) { table.innerHTML = html; table._html = html; }
}

export function renderEventTable(table, sim) {
  const upcoming = sim.events.upcoming();
  const done = sim.eventLog.map((e) => `<tr>
      <td>${e.clock}</td><td class="left">${esc(e.type)}</td><td class="left">${esc(e.edge)}</td><td class="left">${esc(e.description)}</td>
      <td class="left">${e.rerouted.length ? esc(e.rerouted.join(', ')) : '—'}</td>
      <td class="left">${esc([...e.blocked.map((b) => `${b} blocked`), ...e.unblocked.map((b) => `${b} unblocked`)].join(', ') || '—')}</td>
      <td class="left">${esc(e.source)}</td></tr>`);
  const next = upcoming.slice(0, 8).map((e) => `<tr style="opacity:.5">
      <td>${fmtClock(e.time)}</td><td class="left">${esc(e.type)}</td><td class="left">${esc(sim.world.edgeLabel(e.edge))}</td>
      <td class="left">scheduled${e.note ? ` — ${esc(e.note)}` : ''}</td><td class="left">—</td><td class="left">—</td><td class="left">${esc(e.source)}</td></tr>`);
  const html = `
    <thead><tr><th>Time</th><th class="left">Event</th><th class="left">Edge</th><th class="left">Effect</th>
      <th class="left">Rerouted trucks</th><th class="left">Blocked / unblocked</th><th class="left">Source</th></tr></thead>
    <tbody>${done.join('')}${next.join('')}${done.length + next.length === 0 ? '<tr><td colspan="7" class="left">No road events in this variant.</td></tr>' : ''}</tbody>`;
  if (html !== table._html) { table.innerHTML = html; table._html = html; }
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
