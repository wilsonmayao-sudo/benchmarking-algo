#!/usr/bin/env node
/**
 * Real-life incident checks: road accidents / floods / road works…, bin problems
 * (missing, blocked, damaged, overflowing) and truck problems (breakdown, flat tire),
 * and that random incidents land next to the trucks that are working.
 * Usage: node tools/incidentcheck.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = new URL('../', import.meta.url).href;
const readText = async (p) => readFileSync(join(root, p), 'utf8');
const { loadScenario } = await import(R + 'js/sim/config/scenarioLoader.js');
const { Simulation } = await import(R + 'js/sim/simulation.js');
const { INCIDENTS } = await import(R + 'js/sim/events/incidents.js');
let ok = 0, bad = 0;
const check = (name, cond) => { cond ? ok++ : bad++; console.log(`${cond ? '✓' : '✗'} ${name}`); };

const naga = JSON.parse(readFileSync(join(root, 'data/scenarios/naga-14-trucks.json'), 'utf8'));
const { types, ...randomRest } = naga.events?.random || {};

// 1. Default mix: random events now include road, bin and truck incidents.
const w = await loadScenario({ ...naga, events: { random: { ...randomRest, enabled: true, count: 60, seed: 5 } } }, { readText });
const kinds = new Set(w.events.map((e) => e.cause).filter(Boolean));
const groups = new Set([...kinds].map((k) => INCIDENTS[k]?.group));
check(`default random mix has road, bin and truck incidents (${kinds.size} kinds)`, groups.has('road') && groups.has('bin') && groups.has('truck'));
check('every random event is placed near the trucks when it happens', w.events.filter((e) => e.source === 'random').every((e) => e.near));

// 2. A random road incident lands on a road a working truck is about to drive.
const sim = new Simulation(await loadScenario(naga, { readText, overrides: { noEvents: true } }));
for (let i = 0; i < 150; i++) sim.step();
const ahead = new Set();
for (const t of sim.trucks) if (t.status !== 'idle') for (let i = 1; i < Math.min(t.arcs.length, 40); i++) ahead.add(sim.graph.adjEdge[t.arcs[i]]);
const acc = sim.injectEvent({ type: 'ROAD_CLOSURE', cause: 'ROAD_ACCIDENT', near: true, pick: 0.37, duration: 900 });
check(`road accident placed on a truck's path (${acc?.edge})`, acc && ahead.has(acc.edgeIndex) && sim.road.isClosed(acc.edgeIndex));
check('accident keeps its real-life label', acc.label === 'Road accident' && sim.roadCause.get(acc.edgeIndex) === 'ROAD_ACCIDENT');
const works = sim.injectEvent({ type: 'TRAFFIC_DELAY', cause: 'ROAD_WORKS', near: true, pick: 0.8, factor: 2, duration: 1200 });
check('road works slow a road near the trucks', works && sim.road.multiplier[works.edgeIndex] === 2);

// 3. Missing bin: never collected, the truck skips it.
const missing = sim.injectEvent({ type: 'BIN_MISSING', pick: 0.2 });
const lost = sim.bins.find((b) => b.name === missing.edge);
check(`bin missing applied to a bin on a truck's next stops (${missing.edge})`, lost && lost.state === 'missed');

// 4. Blocked / damaged / overflowing bins add time (and weight).
const blocked = sim.injectEvent({ type: 'BIN_BLOCKED', pick: 0.6, extra: 600 });
const bBin = sim.bins.find((b) => b.name === blocked.edge);
check('blocked bin adds 10 min at the stop', bBin && bBin.extraTime >= 600);
const over = sim.injectEvent({ type: 'BIN_OVERFLOW', pick: 0.9, extra: 120, factor: 1.5 });
const oBin = sim.bins.find((b) => b.name === over.edge);
check('overflowing bin gets heavier and full', oBin && oBin.fill === 100 && oBin.extraTime >= 120);

// 5. Truck breakdown: the truck stands still for the repair.
const brk = sim.injectEvent({ type: 'TRUCK_BREAKDOWN', pick: 0.5, duration: 1200 });
const broken = sim.trucks.find((t) => t.name === brk.edge);
check(`breakdown stops a working truck (${brk.edge})`, broken && broken.holdUntil >= sim.time + 1100 && broken.incident?.label === 'Truck breakdown');

// 6. Run to the end.
const res = sim.run();
check(`run finishes (${res.finishReason})`, sim.finished);
check('missing bin was not collected', lost.state === 'missed' && lost.collectedBy === null);
check('blocked bin was still collected, extra time used up', bBin.state === 'collected' && !bBin.extraTime);
check('incidents counted in the event log', sim.eventLog.filter((e) => e.label && INCIDENTS[e.cause]).length >= 6);

// 7. Scheduled incidents in a config, plus a full run with a random mix.
const cfg = { ...naga, events: { scheduled: [
  { type: 'FLOODED_ROAD', time_s: 300 },
  { type: 'FLAT_TIRE', time_s: 400, truck: naga.trucks[0].id },
  { type: 'BIN_DAMAGED', time_s: 500 },
], random: { ...randomRest, enabled: true, count: 25, seed: 9 } } };
const w2 = await loadScenario(cfg, { readText });
check('scheduled incidents load', w2.events.filter((e) => e.source === 'schedule').length === 3);
const sim2 = new Simulation(w2);
const res2 = sim2.run();
check(`full run with 28 incidents finishes (${res2.finishReason})`, sim2.finished && res2.events === 28);
check('flood was placed on a real road', sim2.eventLog.some((e) => e.cause === 'FLOODED_ROAD' && e.edgeIndex >= 0));

// 8. Accuracy: an area truck that fills up unloads and finishes its own area, and the
//    route-end ETA predicted at the start is right (no events = nothing unforeseen).
const sched = JSON.parse(readFileSync(join(root, 'data/scenarios/naga-swmo-schedule.json'), 'utf8'));
const sim3 = new Simulation(await loadScenario(sched, { readText, overrides: { noEvents: true } }));
const firstEnd = new Map(), doneAt = new Map();
while (!sim3.finished) {
  sim3.step();
  for (const t of sim3.trucks) {
    if (t.status !== 'idle' && !firstEnd.has(t.id) && t.eta) firstEnd.set(t.id, t.eta.endAt);
    if (t.status === 'idle' && firstEnd.has(t.id) && !doneAt.has(t.id)) doneAt.set(t.id, sim3.time);
  }
}
const worst = Math.max(...[...firstEnd].map(([id, p]) => Math.abs(doneAt.get(id) - p)));
check(`route-end ETA predicted at the start is within 1 min for every truck (worst ${Math.round(worst)} s)`, worst <= 60);
check('area trucks keep their own bins (no handoffs)', sim3.logEntries.every((e) => e.kind !== 'handoff'));
check('a full area truck makes another landfill trip', sim3.trucks.some((t) => t.disposalTrips >= 2));
check('every bin is collected by the truck of its area', sim3.bins.every((b) => b.state === 'collected' && (!b.configTruck || b.collectedBy === b.configTruck)));

console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
