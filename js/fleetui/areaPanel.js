/**
 * Testing-area toolbar: choose, draw, save and switch areas. View and filter only — the
 * simulation is never changed, except by the opt-in "Run only this area's bins", which
 * restarts the run with the bins of the selected area.
 */

import {
  makeZone, zoneAt, inZone, toXY, toLngLat, readStops, scheduleZones, boundaryZones, binInZone, stopsInZone, fleetIn,
} from './areas.js';
import { selfCrosses, polygonArea } from '../sim/fleet/routeAreas.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KINDS = { schedule: 'Schedule areas', barangay: 'Barangays', district: 'Districts', city: 'City', custom: 'My areas' };
const ZONES_KEY = 'ecoloop.fleet.testAreas';
const VIEW_KEY = 'ecoloop.fleet.areaView:';

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
    const [stops, boundaries] = await Promise.all([
      load(src.schedule || cfg.bins?.csv, (t) => readStops(t, world.geo)),
      load(src.boundaries, (t) => boundaryZones(JSON.parse(t), world.geo)),
    ]);
    this.loadedFor = key;
    this.scenario = world.name;
    this.stops = stops;
    this.zones = [...scheduleZones(stops, world.trucks), ...boundaries, ...this._loadCustom()];

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

  /** The editor asks which bins take part (null = all). */
  binFilter(world) {
    if (!this.zone || !$('optAreaBins').checked) return null;
    const { zone } = this;
    const { graph } = world;
    const test = (b) => binInZone(zone, b, b.x ?? graph.x[b.node], b.y ?? graph.y[b.node]);
    if (!world.bins.some(test)) {
      this.say(`${zone.name} has no bins${$('optDayWrap').hidden ? '' : ' on this schedule day'}, so the run still uses all bins.`, 'err');
      return null;
    }
    world.variant += `, only ${zone.name} bins`; // keeps run comparisons honest
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
    const kinds = Object.keys(KINDS).filter((k) => k === 'custom' || this.zones.some((z) => z.kind === k));
    $('areaKind').innerHTML = kinds.map((k) => `<option value="${k}">${KINDS[k]}</option>`).join('');
    $('areaKind').value = this.kind;
    $('areaSelect').innerHTML = '<option value="">Full fleet map</option>' + this._shown().map((z) =>
      `<option value="${esc(z.id)}">${esc(z.name)}${z.note ? ` (${esc(z.note)})` : ''}</option>`).join('');
    $('areaSelect').value = this.zone?.id || '';
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
    if (!zone) { map.focus = null; $('areaStatus').textContent = ''; return; }
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
    $('areaKind').addEventListener('change', (e) => {
      const kind = e.target.value;
      if (this.zone && this.zone.kind !== kind) this.select(null);
      this.kind = kind;
      this._fill();
      this._remember();
      map.render();
      if (map.editMode === 'pickZone') this.modeChanged('pickZone');
      if (kind === 'custom' && !this._shown().length) this.say('No saved areas yet. Press “Draw area”.');
    });
    $('areaSelect').addEventListener('change', (e) => this.select(this.zones.find((z) => z.id === e.target.value) || null));
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
