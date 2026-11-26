#!/usr/bin/env node
/**
 * Live-event checks for the fleet simulation: random-event count / re-roll seed, events
 * injected mid-run, clearing a road (no leftover follow-ups), and seed compatibility.
 * Usage: node tools/livecheck.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = new URL('../', import.meta.url).href;
const readText = async (p) => readFileSync(join(root, p), 'utf8');
const { loadScenario } = await import(R + 'js/sim/config/scenarioLoader.js');
const { Simulation } = await import(R + 'js/sim/simulation.js');
const { mulberry32, randInt, randRange } = await import(R + 'js/core/rng.js');
let ok = 0, bad = 0; const check = (name, cond) => { cond ? ok++ : bad++; console.log(`${cond ? '✓' : '✗'} ${name}`); };

// 1. Old seeds unchanged: re-implement the original loop and compare with the sample config.
const sample = JSON.parse(readFileSync(join(root, 'data/scenarios/sample-fleet.json'), 'utf8'));
const w0 = await loadScenario(sample, { readText });
const r = sample.events.random, rng = mulberry32(r.seed >>> 0), old = [];
const types = r.types, names = Object.keys(types), tot = names.reduce((s, t) => s + types[t], 0);
for (let k = 0; k < r.count; k++) {
  let p = rng() * tot, type = names[0]; for (const t of names) { p -= types[t]; if (p <= 0) { type = t; break; } }
  const edge = randInt(rng, w0.graph.edgeCount), time = Math.round(randRange(rng, ...r.window_s));
  const [f0, f1] = r.delay_factor, [d0, d1] = r.delay_duration_s;
  old.push({ time, type, edge, factor: Number(randRange(rng, f0, f1).toFixed(2)), duration: Math.round(randRange(rng, d0, d1)) });
}
const now = w0.events.filter((e) => e.source === 'random').map(({ time, type, edge, factor, duration }) => ({ time, type, edge, factor, duration }));
check('existing seed produces identical random events', JSON.stringify(old) === JSON.stringify(now));

// 2. Naga scenario: 14 trucks, count override, re-roll seed changes events, same seed reproduces.
const naga = JSON.parse(readFileSync(join(root, 'data/scenarios/naga-14-trucks.json'), 'utf8'));
const a = await loadScenario(naga, { readText, overrides: { randomEventCount: 25 } });
check('14 trucks loaded', a.trucks.length === 14 && new Set(a.trucks.map((t) => t.color)).size === 14);
check('random count override → 25 events', a.events.filter((e) => e.source === 'random').length === 25);
const s1 = await loadScenario(naga, { readText, overrides: { eventSeed: 123 } });
const s1b = await loadScenario(naga, { readText, overrides: { eventSeed: 123 } });
const s2 = await loadScenario(naga, { readText, overrides: { eventSeed: 456 } });
const sig = (w) => JSON.stringify(w.events.map((e) => [e.time, e.type, e.edge]));
check('same re-roll seed → same events', sig(s1) === sig(s1b));
check('different re-roll seed → different events', sig(s1) !== sig(s2));
const none = await loadScenario({ ...naga, events: undefined }, { readText, overrides: { randomEventCount: 5 } });
check('random events work even when config has no events block', none.events.length === 5);

// 3. Live injection mid-run: closure on a road a truck is about to use → reroute.
const sim = new Simulation(await loadScenario(naga, { readText, overrides: { noEvents: true } }));
for (let i = 0; i < 120; i++) sim.step();
const truck = sim.trucks.find((t) => t.status === 'driving' && t.arcs.length > 3);
const edge = sim.graph.adjEdge[truck.arcs[2]];
const entry = sim.injectEvent({ type: 'ROAD_CLOSURE', edge, duration: 600 });
check('live closure applied immediately', sim.road.isClosed(edge) && entry.source === 'manual');
check(`live closure rerouted the truck using it (${truck.name})`, entry.rerouted.includes(truck.name) || entry.blocked.includes(truck.name));
check('closure expiry auto-scheduled', sim.events.upcoming().some((e) => e.edge === edge && e.type === 'ROAD_REOPEN'));

// 4. Clear road cancels pending follow-ups (no speed-up bug).
const e2 = (edge + 7) % sim.graph.edgeCount;
sim.injectEvent({ type: 'TRAFFIC_DELAY', edge: e2, factor: 2.5, duration: 300 });
check('delay applied ×2.5', Math.abs(sim.road.multiplier[e2] - 2.5) < 1e-9);
check('clearRoad on delayed road', sim.clearRoad(e2) === 1 && sim.road.multiplier[e2] === 1);
check('clearRoad removed the queued "delay cleared"', !sim.events.upcoming().some((e) => e.edge === e2));
for (let i = 0; i < 400; i++) sim.step();
check('multiplier still exactly 1 after the old expiry time (no speed-up)', sim.road.multiplier[e2] === 1);
check('clearRoad on closed road reopens it', sim.clearRoad(edge) === 1 && !sim.road.isClosed(edge));
check('clearRoad on normal road is a no-op', sim.clearRoad(edge) === 0);
check('invalid injections rejected', sim.injectEvent({ type: 'ROAD_CLOSURE', edge: -1 }) === null && sim.injectEvent({ type: 'TRAFFIC_DELAY', edge: 1, factor: 0 }) === null);

// 5. Run to the end with live events in it.
const res = sim.run();
check(`run finishes (${res.finishReason}); bins ${res.binsCollected ?? '?'} collected`, sim.finished);
check('summary counts live events', res.events === sim.world.events.length && res.events >= 4);
check('injection after finish rejected', sim.injectEvent({ type: 'ROAD_CLOSURE', edge: 1 }) === null);

// 6. Bins from the SWMO collection schedule CSV.
const sched = JSON.parse(readFileSync(join(root, 'data/scenarios/naga-swmo-schedule.json'), 'utf8'));
const ws = await loadScenario(sched, { readText, overrides: { noEvents: true } });
const imp = ws.binImport;
const skippedTotal = imp.skipped.outsideRoadMap + imp.skipped.day + imp.skipped.area + imp.skipped.inactive +
  imp.skipped.noCoordinates + Object.values(imp.skipped.stopType).reduce((a, b) => a + b, 0);
check(`schedule CSV: ${imp.used} stops placed, every skipped row counted`, imp.used > 0 && imp.used + skippedTotal === imp.rows);

const { parseCsv } = await import(R + 'js/data/cityMapLoader.js');
const csvRows = parseCsv(readFileSync(join(root, sched.bins.csv), 'utf8'));
const H = csvRows[0];
const byId = new Map(csvRows.slice(1).map((r) => [`${r[H.indexOf('area_code')]}-${r[H.indexOf('stop_order')]}`, r]));
let worst = 0;
for (const b of ws.bins) {
  const r = byId.get(b.id);
  if (!r) continue;
  const x = (Number(r[H.indexOf('longitude')]) - ws.geo.minLon) * ws.geo.mPerLon;
  const y = (Number(r[H.indexOf('latitude')]) - ws.geo.minLat) * ws.geo.mPerLat;
  worst = Math.max(worst, Math.hypot(ws.graph.x[b.node] - x, ws.graph.y[b.node] - y));
}
check(`every stop placed within ${sched.bins.max_snap_m} m of its recorded lat/lng (worst ${Math.round(worst)} m)`, worst <= sched.bins.max_snap_m);
const areaOwner = (area) => ws.trucks.find((t) => t.areas.includes(area));
check('stops go to the truck covering their area', ws.bins.every((b) => !b.area || !areaOwner(b.area) || areaOwner(b.area).id === b.configTruck));
const wMon = await loadScenario(sched, { readText, overrides: { noEvents: true, binDay: 'mon' } });
check(`Monday filter keeps a subset (${wMon.bins.length} of ${ws.bins.length})`,
  wMon.bins.length > 0 && wMon.bins.length < ws.bins.length && wMon.bins.every((b) => ws.bins.some((a) => a.id === b.id)));

console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
