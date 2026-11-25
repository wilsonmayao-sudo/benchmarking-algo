/**
 * Testing-area toolbar: choose, draw, save and switch areas. View and filter only — the
 * simulation is never changed, except by the opt-in "Run only this area's bins", which
 * restarts the run with the bins of the selected area.
 */

import {
  makeZone, zoneAt, inZone, toXY, toLngLat, readStops, scheduleZones, boundaryZones, binInZone, stopsInZone, fleetIn, formatAreaLabel, addExtraAreaBins,
} from './areas.js';
import { selfCrosses, polygonArea } from '../sim/fleet/routeAreas.js';
import { mulberry32 } from '../core/rng.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KINDS = { schedule: 'Schedule areas', barangay: 'Barangays', district: 'Districts', city: 'City', custom: 'My areas' };
const ZONES_KEY = 'ecoloop.fleet.testAreas';
const VIEW_KEY = 'ecoloop.fleet.areaView:';

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function formatDaysList(days) {
  if (!Array.isArray(days) || days.length === 0) return '';
  if (days.length === 7) return 'Mon–Sun (Daily)';
  return days.join(', ');
}

function readStore(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: not remembered */ }
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class AreaPanel {
  /**
   * @param {object} map FleetMapView
   * @param {{rebuild:()=>Promise<void>, onChange:()=>void, setMode:(mode:string)=>void, readText:(path:string)=>Promise<string>}} host
   */
  constructor(map, host) {
    this.map = map;
    this.host = host;
    this.sim = null;
    this.world = null;
    this.zones = [];
    this.stops = [];
    this.kind = 'schedule';
    this.zone = null;
    this.loadedFor = null; // what the zones were built for
    this._bind();
  }

  // --------------------------------------------------------------- loading

  /** A world was (re)built: make its zones. Must run before the editor limits the bins. */
  async prepare(cfg, world) {
    this.cfg = cfg;
    this.world = world;
    const src = cfg.test_areas || {};
    const key = JSON.stringify([world.name, src, world.geo, world.trucks.map((t) => [t.id, t.areas])]);
    if (key === this.loadedFor) return;
    const keepId = this.zone?.id;
    const sameScenario = this.scenario === world.name;
    const problems = [];
    const load = async (path, use) => {
      if (!path || !world.geo) return [];
      try { return use(await this.host.readText(path)); } catch (err) { problems.push(`${path}: ${err.message}`); return []; }
    };
    const [stops, scheduleAreas, boundaries] = await Promise.all([
      load(src.schedule || cfg.bins?.csv, (t) => readStops(t, world.geo)),
      load(src.schedule_areas, (t) => boundaryZones(JSON.parse(t), world.geo)),
      load(src.boundaries, (t) => boundaryZones(JSON.parse(t), world.geo)),
    ]);
    this.loadedFor = key;
    this._detailsKey = '';
    this.scenario = world.name;
    this.stops = stops;
    this.zones = [...scheduleZones(stops, world.trucks, scheduleAreas), ...boundaries, ...this._loadCustom()];

    const view = sameScenario ? { kind: this.kind, id: keepId, only: $('optAreaBins').checked } : readStore(VIEW_KEY + world.name, {});
    const has = (k) => k === 'custom' || this.zones.some((z) => z.kind === k);
    this.kind = has(view.kind) ? view.kind : Object.keys(KINDS).find(has);
    this.zone = this.zones.find((z) => z.id === view.id) || null;
    $('optAreaBins').checked = Boolean(view.only && this.zone);
    if (view.outside) $('areaOutside').value = view.outside;
    this.pendingView = !sameScenario && this.zone ? this.zone.bbox : null;
    this._fill();
    this.say(problems.length ? `⚠ Could not load ${problems.join('; ')}` : '', 'err');
  }

  /** Ensure every schedule area and barangay has extra simulated bins for collection. */
  ensureAreaBins(world) {
    if (!world || this.zones.length === 0) return { addedCount: 0, scheduleAdded: 0, barangayAdded: 0 };
    return addExtraAreaBins(world, this.zones, {
      extraPerScheduleArea: 3,
      minPerBarangay: 3,
      fill: this.cfg?.bins?.random?.fill || this.cfg?.bins?.fill || [45, 95],
    });
  }

  /** The editor asks which bins take part (null = all). */
  binFilter(world) {
    if (!this.zone || !$('optAreaBins').checked) return null;
    const { zone } = this;
    const { graph } = world;
    const test = (b) => binInZone(zone, b, b.x ?? graph.x[b.node], b.y ?? graph.y[b.node]);
    if (!world.bins.some(test)) {
      if (!world.binImport) {
        const nodes = [];
        for (let i = 0; i < graph.nodeCount; i++) {
          if (world.allowed && !world.allowed[i]) continue;
          if (i === world.depot || i === world.disposal) continue;
          if (inZone(zone, graph.x[i], graph.y[i])) nodes.push(i);
        }
        if (nodes.length > 0) {
          const rng = mulberry32(((world.seed || 20260913) ^ hashStr(zone.id)) >>> 0);
          for (let i = nodes.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
          }
          const targetCount = Math.min(18, Math.max(6, Math.min(nodes.length, Math.round(nodes.length * 0.03))));
          const [fMin, fMax] = this.cfg?.bins?.random?.fill || [25, 70];
          const cap = world.settings.bin_capacity_kg || 168;
          const labelBase = zone.displayName || zone.name;
          world.bins = nodes.slice(0, targetCount).map((node, idx) => {
            const fill = Math.round(fMin + rng() * (fMax - fMin));
            return {
              id: `AB_${idx + 1}`,
              name: `${labelBase} Bin ${idx + 1}`,
              node,
              fill,
              capacityKg: cap,
              load: (cap * fill) / 100,
              configTruck: null,
              serviceTime: world.settings.service_time_s,
              area: zone.kind === 'schedule' ? zone.code : null,
            };
          });
          world.variant += `, only ${labelBase} bins`;
          return () => true;
        }
      }
      this.say(`${zone.displayName || zone.name} has no bins${$('optDayWrap').hidden ? '' : ' on this schedule day'}, so the run still uses all bins.`, 'err');
      return null;
    }
    world.variant += `, only ${zone.displayName || zone.name} bins`; // keeps run comparisons honest
    return test;
  }

  attach(sim) {
    this.sim = sim;
    this.map.zones = this._shown();
    this.refresh();
    if (this.pendingView) { this.map.flyTo(this.pendingView, false); this.pendingView = null; }
  }

  // ------------------------------------------------------------ saved areas

  _customKey() { return this.world.geo ? ZONES_KEY : `${ZONES_KEY}:${this.world.name}`; }

  _loadCustom() {
    const raw = readStore(this._customKey(), []);
    return (Array.isArray(raw) ? raw : []).filter((z) => z && z.id && Array.isArray(z.ring) && z.ring.length >= 3)
      .map((z) => makeZone({ id: z.id, kind: 'custom', name: String(z.name) }, [z.ring.map((p) => toXY(this.world.geo, p))]));
  }

  _saveCustom() {
    writeStore(this._customKey(), this.zones.filter((z) => z.kind === 'custom')
      .map((z) => ({ id: z.id, name: z.name, ring: z.rings[0].map((p) => toLngLat(this.world.geo, p)) })));
  }

  /** Outline drawn by the user. @returns {string} problem, or '' when saved */
  addDrawn(poly) {
    if (poly.length < 3) return 'Click at least 3 corners to make an area.';
    if (selfCrosses(poly)) return 'The outline crosses itself. Please draw a simple shape.';
    if (polygonArea(poly) < 1) return 'This area is too small. Please draw it larger.';
    const names = new Set(this.zones.map((z) => z.name));
    let n = 1;
    while (names.has(`Test area ${n}`)) n++;
    const zone = makeZone({ id: `custom:${Date.now().toString(36)}`, kind: 'custom', name: `Test area ${n}` }, [poly]);
    this.zones.push(zone);
    this._saveCustom();
    this.select(zone);
    $('areaName').select(); // ready to be renamed
    return '';
  }

  // -------------------------------------------------------------- selecting

  select(zone) {
    const changed = zone !== this.zone;
    const only = $('optAreaBins').checked;
    this.zone = zone;
    if (zone) this.kind = zone.kind;
    else $('optAreaBins').checked = false;
    this._fill();
    this._remember();
    this.say('');
    this.refresh();
    this.map.flyTo(zone ? zone.bbox : null);
    if (changed && only) this.host.rebuild();
    else this.host.onChange();
  }

  _step(d) {
    const list = this._shown();
    if (!list.length) return;
    const i = list.indexOf(this.zone);
    this.select(list[i < 0 ? (d > 0 ? 0 : list.length - 1) : (i + d + list.length) % list.length]);
  }

  _shown() { return this.zones.filter((z) => z.kind === this.kind); }

  _remember() {
    writeStore(VIEW_KEY + this.world.name, { kind: this.kind, id: this.zone?.id, only: $('optAreaBins').checked, outside: $('areaOutside').value });
  }

  _fill() {
    const sched = this.zones.filter((z) => z.kind === 'schedule');
    const brgys = this.zones.filter((z) => z.kind === 'barangay');
    const other = this.zones.filter((z) => z.kind === 'district' || z.kind === 'city');
    const customZones = this.zones.filter((z) => z.kind === 'custom');

    $('areaScheduleWrap').hidden = sched.length === 0;
    $('areaScheduleSelect').innerHTML = '<option value="">All areas</option>' + sched.map((z) =>
      `<option value="${esc(z.id)}">${esc(z.displayName || z.name)}${z.note ? ` (${esc(z.note)})` : ''}</option>`).join('');
    $('areaScheduleSelect').value = this.zone?.kind === 'schedule' ? this.zone.id : '';

    let brgyHtml = '<option value="">All barangays</option>' + brgys.map((z) =>
      `<option value="${esc(z.id)}">${esc(z.name)}</option>`).join('');
    if (other.length) {
      brgyHtml += `<optgroup label="City & Districts">${other.map((z) =>
        `<option value="${esc(z.id)}">${esc(z.name)}</option>`).join('')}</optgroup>`;
    }
    if (customZones.length) {
      brgyHtml += `<optgroup label="My areas">${customZones.map((z) =>
        `<option value="${esc(z.id)}">${esc(z.name)}</option>`).join('')}</optgroup>`;
    }
    $('areaBarangayWrap').hidden = brgys.length === 0 && other.length === 0 && customZones.length === 0;
    $('areaBarangaySelect').innerHTML = brgyHtml;
    $('areaBarangaySelect').value = this.zone && this.zone.kind !== 'schedule' ? this.zone.id : '';

    const custom = this.zone?.kind === 'custom';
    $('areaCustom').hidden = !custom;
    if (custom) $('areaName').value = this.zone.name;
    $('areaReset').disabled = !this.zone;
    $('areaLogWrap').hidden = !this.zone;
    $('optAreaBins').disabled = !this.zone;
    this.map.zones = this._shown();
  }

  // ---------------------------------------------------------------- refresh

  /** Work out who is in the area. Called by the page a few times per second. */
  refresh() {
    if (!this.sim) return;
    const { zone, sim, map } = this;
    if (!zone) {
      map.focus = null;
      $('areaStatus').textContent = '';
      this._renderDetails(null, []);
      return;
    }
    const fleet = fleetIn(sim, zone);
    const stops = stopsInZone(zone, this.stops, $('optDayWrap').hidden ? 'all' : $('optDay').value);
    map.focus = { zone, outside: $('areaOutside').value, ...fleet, stops };
    const { graph, road } = sim;
    let events = 0;
    for (let e = 0; e < graph.edgeCount; e++) {
      if ((road.closed[e] || road.multiplier[e] !== 1) && this._roadInside(zone, e)) events++;
    }
    const bins = sim.bins.filter((b) => fleet.bins.has(b.id));
    $('areaStatus').textContent = `${plural(fleet.trucks.size, 'truck')} (${fleet.here.size} inside now) · ` +
      `${bins.filter((b) => b.state === 'collected').length} of ${plural(bins.length, 'bin')} collected · ` +
      `${plural(stops.length, 'schedule stop')} · ${plural(events, 'road event')}`;
    if (map.editMode === 'none') {
      if (zone.kind === 'schedule' && zone.accuracy_pct !== undefined) {
        const unv = Array.isArray(zone.unverified_locations) ? zone.unverified_locations.length : 0;
        this.say(zone.needs_verification
          ? `OSM grounding: ${zone.accuracy_pct}% (${unv} location${unv === 1 ? '' : 's'} flagged for verification).`
          : `OSM grounding: ${zone.accuracy_pct}% (verified).`);
      } else {
        this.say('');
      }
    }
    this._renderDetails(zone, stops);
  }

  _renderDetails(zone, stops) {
    const el = $('areaDetails');
    const day = $('optDayWrap').hidden ? 'all' : $('optDay').value;
    const key = zone ? `${zone.id}|${day}|${stops.length}|${zone.name}` : '';
    if (key === this._detailsKey) return;
    this._detailsKey = key;
    if (!zone) { el.hidden = true; el.innerHTML = ''; return; }

    if (zone.kind === 'schedule') {
      const title = zone.displayName || zone.name;
      const sub = zone.areaLabel && zone.areaLabel.toUpperCase() !== title.toUpperCase() ? ` — ${zone.areaLabel}` : '';
      const areaKm2 = zone.areaKm2 ?? Number((zone.rings.reduce((s, r) => s + polygonArea(r), 0) / 1e6).toFixed(2));
      const meta = [`${areaKm2.toFixed(2)} km²`];
      if (zone.note) meta.push(`Trucks: ${zone.note}`);
      if (zone.accuracy_pct !== undefined) meta.push(`OSM: ${zone.accuracy_pct}%`);

      const schedParts = [];
      if (zone.shift) schedParts.push(`<span><b>Shift:</b>${esc(zone.shift)}</span>`);
      const daysText = formatDaysList(zone.days);
      if (daysText) schedParts.push(`<span><b>Days:</b>${esc(daysText)}</span>`);
      if (zone.waste) schedParts.push(`<span><b>Waste:</b>${esc(zone.waste)}</span>`);

      const locs = stops.length
        ? stops.slice().sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)).map((s) => ({
          order: s.order, name: s.name, barangay: s.barangay, time: s.time,
        }))
        : (zone.locations || []);
      const brgys = Array.isArray(zone.barangays) ? zone.barangays : [];
      const streetsAndPlaces = [...new Set([...(zone.matchedStreets || []), ...(zone.matchedPlaces || [])])];

      el.innerHTML =
        `<div class="area-details-head"><strong>${esc(title + sub)}</strong><span class="area-details-meta">${esc(meta.join(' · '))}</span></div>` +
        (schedParts.length ? `<div class="area-details-row" style="display:flex;flex-wrap:wrap;gap:4px 14px;">${schedParts.join('')}</div>` : '') +
        (brgys.length ? `<div class="area-details-row"><b>Barangays:</b> ${esc(brgys.join(', '))}</div>` : '') +
        (streetsAndPlaces.length ? `<div class="area-details-row"><b>Streets &amp; subdivisions:</b> ${esc(streetsAndPlaces.join(', '))}</div>` : '') +
        (locs.length ? `<details class="area-stops-list"><summary>Scheduled locations (${locs.length} stop${locs.length === 1 ? '' : 's'})</summary><ul class="area-stops-items">${
          locs.map((s) => `<li><span>${s.order ? `#${esc(s.order)} ` : ''}${esc(s.name)}</span><span class="s-meta">${esc([s.barangay, s.time].filter(Boolean).join(' · '))}</span></li>`).join('')
        }</ul></details>` : '');
      el.hidden = false;
      return;
    }

    const areaKm2 = zone.rings.reduce((s, r) => s + polygonArea(r), 0) / 1e6;
    const coveringAreas = [...new Set(stops.map((s) => s.area).filter(Boolean))].map(formatAreaLabel);
    el.innerHTML =
      `<div class="area-details-head"><strong>${esc(zone.name)}</strong><span class="area-details-meta">${areaKm2.toFixed(2)} km² · ${esc(KINDS[zone.kind] || zone.kind)}</span></div>` +
      (coveringAreas.length ? `<div class="area-details-row"><b>Schedule areas:</b> ${esc(coveringAreas.join(', '))}</div>` : '') +
      (stops.length ? `<details class="area-stops-list"><summary>Scheduled stops inside ${esc(zone.name)} (${stops.length})</summary><ul class="area-stops-items">${
        stops.map((s) => `<li><span>${s.area ? `${esc(formatAreaLabel(s.area))} ` : ''}${s.order ? `#${esc(s.order)} ` : ''}${esc(s.name)}</span><span class="s-meta">${esc(s.time || '')}</span></li>`).join('')
      }</ul></details>` : '');
    el.hidden = false;
  }

  _roadInside(zone, e) {
    const { graph } = this.sim;
    return [graph.edgeFrom[e], graph.edgeTo[e]].some((n) => inZone(zone, graph.x[n], graph.y[n]));
  }

  /** Log filter for the selected area (null = show everything). */
  logFilter() {
    const { focus } = this.map;
    if (!focus || !$('optAreaLog').checked) return null;
    const { sim } = this;
    const key = `${focus.zone.id}|${[...focus.trucks].sort()}|${[...focus.bins].sort()}`;
    if (this.logKey !== key || this.logSim !== sim) {
      // whole names only: "Truck 1" must not match "Truck 10"
      const mentions = (names) => (names.length
        ? new RegExp(`(^|[^\\p{L}\\p{N}])(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}])`, 'u') : null);
      const own = mentions([...sim.trucks.filter((t) => focus.trucks.has(t.id)), ...sim.bins.filter((b) => focus.bins.has(b.id))].map((x) => x.name));
      const any = mentions(sim.trucks.map((t) => t.name));
      const cache = new WeakMap();
      this.logKey = key;
      this.logSim = sim;
      this.logTest = (entry) => {
        if (!cache.has(entry)) {
          cache.set(entry, Boolean(own?.test(entry.text) || (entry.kind === 'event'
            ? this._roadInside(focus.zone, entry.data.edgeIndex) : entry.kind === 'info' && !any?.test(entry.text))));
        }
        return cache.get(entry);
      };
    }
    return this.logTest;
  }

  say(text, kind = '') {
    $('areaInfo').textContent = text;
    $('areaInfo').className = `hint ${kind}`;
  }

  // ----------------------------------------------------------------- events

  modeChanged(mode) {
    const draw = mode === 'drawZone', pick = mode === 'pickZone';
    $('areaDraw').setAttribute('aria-pressed', String(draw));
    $('areaPick').setAttribute('aria-pressed', String(pick));
    if (draw) this.say('Click the corners of the testing area. Click the first corner again, or press Finish, to close it.');
    else if (pick) this.say(`Click one of the outlines on the map: ${KINDS[this.kind]} (Esc to stop).`);
    else if (this.lastMode === 'drawZone' || this.lastMode === 'pickZone') this.say('');
    this.lastMode = mode;
  }

  _bind() {
    const { map } = this;
    const toggle = (mode) => { if (this.sim) this.host.setMode(map.editMode === mode ? 'none' : mode); };
    $('areaScheduleSelect').addEventListener('change', (e) => {
      const val = e.target.value;
      if (val) {
        this.select(this.zones.find((z) => z.id === val) || null);
      } else {
        this.kind = 'schedule';
        this.select(null);
      }
    });
    $('areaBarangaySelect').addEventListener('change', (e) => {
      const val = e.target.value;
      if (val) {
        this.select(this.zones.find((z) => z.id === val) || null);
      } else {
        this.kind = this.zones.some((z) => z.kind === 'barangay') ? 'barangay' : 'custom';
        this.select(null);
      }
    });
    $('areaPrev').addEventListener('click', () => this._step(-1));
    $('areaNext').addEventListener('click', () => this._step(1));
    $('areaReset').addEventListener('click', () => this.select(null));
    $('areaDraw').addEventListener('click', () => toggle('drawZone'));
    $('areaPick').addEventListener('click', () => toggle('pickZone'));
    $('areaOutside').addEventListener('change', () => { this._remember(); this.host.onChange(); });
    $('optAreaBorders').addEventListener('change', (e) => { map.options.borders = e.target.checked; map.render(); });
    $('optAreaLog').addEventListener('change', () => this.host.onChange());
    $('optAreaBins').addEventListener('change', () => { this._remember(); this.say(''); this.host.rebuild(); });
    $('areaName').addEventListener('change', (e) => {
      if (this.zone?.kind !== 'custom') return;
      const name = e.target.value.trim();
      if (name) { this.zone.name = name; this._saveCustom(); }
      this._fill();
      map.render();
    });
    $('areaDelete').addEventListener('click', () => {
      const { zone } = this;
      if (zone?.kind !== 'custom' || !confirm(`Delete ${zone.name}?`)) return;
      this.zones = this.zones.filter((z) => z !== zone);
      this._saveCustom();
      this.select(null);
    });
    $('mapZoomIn').addEventListener('click', () => map.zoomBy(1.6));
    $('mapZoomOut').addEventListener('click', () => map.zoomBy(1 / 1.6));
    map.zoneAt = (x, y) => zoneAt(this._shown(), x, y);
    map.onPickZone = (x, y) => {
      const zone = map.zoneAt(x, y);
      if (!zone) { this.say('There is no area at that point. Try another one.', 'err'); return; }
      this.host.setMode('none');
      this.select(zone);
    };
  }
}
