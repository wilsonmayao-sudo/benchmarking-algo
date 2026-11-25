#!/usr/bin/env node
/** Testing-area checks: boundaries, schedule areas, who belongs to an area. Usage: node tools/areacheck.mjs */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = new URL('../', import.meta.url).href;
const readText = async (p) => readFileSync(join(root, p), 'utf8');
const { loadScenario } = await import(R + 'js/sim/config/scenarioLoader.js');
const { Simulation } = await import(R + 'js/sim/simulation.js');
const A = await import(R + 'js/fleetui/areas.js');
let ok = 0, bad = 0;
const check = (name, cond) => { cond ? ok++ : bad++; console.log(`${cond ? '✓' : '✗'} ${name}`); };

const cfg = JSON.parse(await readText('data/scenarios/naga-swmo-schedule.json'));
const world = await loadScenario(cfg, { readText, overrides: { noEvents: true } });
const stops = A.readStops(await readText(cfg.test_areas.schedule), world.geo);
const schedule = A.scheduleZones(stops, world.trucks);
const borders = A.boundaryZones(JSON.parse(await readText(cfg.test_areas.boundaries)), world.geo);
const city = borders.find((z) => z.kind === 'city');
const barangays = borders.filter((z) => z.kind === 'barangay');
const at = (lng, lat) => A.toXY(world.geo, [lng, lat]);

check('17 schedule areas, each with its truck', schedule.length === 17 && schedule.every((z) => z.note));
check('every collection stop is inside its own area', stops.filter((s) => s.type === 'collection')
  .every((s) => A.inZone(schedule.find((z) => z.code === s.area), s.x, s.y)));
check('27 barangays that fill the city (within 1 %)', barangays.length === 27 &&
  Math.abs(barangays.reduce((s, z) => s + z.size, 0) / city.size - 1) < 0.01);
check('the landfill is in San Isidro', A.zoneAt(barangays, ...at(123.2576126, 13.6212151))?.name === 'San Isidro');
check('depot and landfill are in the city', A.inZone(city, ...at(123.1995803, 13.618842)) && A.inZone(city, ...at(123.2576126, 13.6212151)));
const [lng, lat] = A.toLngLat(world.geo, at(123.2, 13.62));
check('saved areas keep their place (lat/lng round trip)', Math.abs(lng - 123.2) < 1e-9 && Math.abs(lat - 13.62) < 1e-9);
const mon = A.stopsInZone(schedule[0], stops, 'mon');
check('schedule day narrows the checkpoints', mon.length > 0 && mon.every((s) => s.days.includes('mon') && s.area === 'AREA-1'));

const sim = new Simulation(world);
const zone = schedule.find((z) => z.code === 'AREA-8');
const f = A.fleetIn(sim, zone);
check('AREA-8: its truck, its bins', f.trucks.has('TRK-16') && f.bins.size > 0 && [...f.bins].every((id) => sim.binsById.get(id).area === 'AREA-8'));
check('trucks parked at the depot are not "inside"', f.here.size === 0 && A.fleetIn(sim, city).here.size === 0);
for (let i = 0; i < 600; i++) sim.step();
check('driving trucks are inside the city', A.fleetIn(sim, city).here.size > 0);

console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
