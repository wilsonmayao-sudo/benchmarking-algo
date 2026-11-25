#!/usr/bin/env node
/** Testing-area checks: boundaries, schedule areas, who belongs to an area. Usage: node tools/areacheck.mjs */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = new URL('../', import.meta.url).href;
const readText = async (p) => readFileSync(join(root, p), 'utf8');
const { loadScenario, applyScenarioType } = await import(R + 'js/sim/config/scenarioLoader.js');
const { Simulation } = await import(R + 'js/sim/simulation.js');
const { selfCrosses, polygonArea } = await import(R + 'js/sim/fleet/routeAreas.js');
const A = await import(R + 'js/fleetui/areas.js');
let ok = 0, bad = 0;
const check = (name, cond) => { cond ? ok++ : bad++; console.log(`${cond ? '✓' : '✗'} ${name}`); };

const cfg = JSON.parse(await readText('data/scenarios/naga-swmo-schedule.json'));
const world = await loadScenario(cfg, { readText, overrides: { noEvents: true } });
const stops = A.readStops(await readText(cfg.test_areas.schedule), world.geo);
const scheduleGeo = cfg.test_areas.schedule_areas ? JSON.parse(await readText(cfg.test_areas.schedule_areas)) : null;
const scheduleBorders = scheduleGeo ? A.boundaryZones(scheduleGeo, world.geo) : null;
const schedule = A.scheduleZones(stops, world.trucks, scheduleBorders);
const legacySchedule = A.scheduleZones(stops, world.trucks);
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
check('all 17 schedule polygons are simple (no self-crossings)', schedule.every((z) => z.size > 0 && z.rings.every((r) => !selfCrosses(r))));
check('all 17 schedule areas are single continuous polygons (no disconnected fragments)',
  schedule.every((z) => z.rings.length === 1) &&
  (!scheduleGeo || scheduleGeo.features.every((f) => f.geometry.type === 'Polygon' && f.properties.ring_count === 1)));
check('schedule polygon vertices stay inside Naga City (30 m tolerance)', (() => {
  const step = 30;
  return schedule.every((z) => z.rings.every((r) => r.every(([x, y]) =>
    A.inZone(city, x, y) || A.inZone(city, x + step, y) || A.inZone(city, x - step, y) ||
    A.inZone(city, x, y + step) || A.inZone(city, x, y - step))));
})());
const osmAcc = scheduleGeo?.validation?.overall_osm_accuracy_pct ?? 0;
check(`OSM grounding accuracy >= 80% (${osmAcc}%)`, osmAcc >= 80);
const newSum = schedule.reduce((s, z) => s + z.rings.reduce((rs, r) => rs + polygonArea(r), 0), 0);
const legSum = legacySchedule.reduce((s, z) => s + z.rings.reduce((rs, r) => rs + polygonArea(r), 0), 0);
check(`street-bounded footprint tighter than convex hulls (${(newSum / 1e6).toFixed(2)} < ${(legSum / 1e6).toFixed(2)} km²)`, newSum < legSum);

const expectedCodes = ['AREA-1', 'AREA-2A', 'AREA-2B', 'AREA-3', 'AREA-4', 'AREA-5', 'AREA-6', 'AREA-7', 'AREA-8', 'AREA-9', 'AREA-10', 'AREA-11', 'AREA-12', 'AREA-13', 'AREA-15', 'COMPACTOR', 'FLEET-CLEARING'];
check('all 17 schedule areas sorted numerically with display labels and metadata',
  JSON.stringify(schedule.map((z) => z.code)) === JSON.stringify(expectedCodes) &&
  schedule.every((z) => z.displayName && z.shift && z.days.length > 0 && z.barangays.length > 0 && z.locations.length > 0));

const naga14Cfg = JSON.parse(await readText('data/scenarios/naga-14-trucks.json'));
check('Normal/Worst/Randomized cases preserve test_areas schedule & schedule_areas',
  ['normal', 'worst', 'random'].every((kind) => {
    const gen = applyScenarioType(naga14Cfg, kind, 20260913);
    return gen.test_areas?.schedule === naga14Cfg.test_areas.schedule &&
      gen.test_areas?.schedule_areas === naga14Cfg.test_areas.schedule_areas &&
      gen.test_areas?.boundaries === naga14Cfg.test_areas.boundaries &&
      Boolean(gen.bins?.random);
  }));

check('all 17 schedule areas contain reachable road nodes for isolated benchmarking',
  schedule.every((z) => {
    for (let i = 0; i < world.graph.nodeCount; i++) {
      if (world.allowed[i] && i !== world.depot && i !== world.disposal && A.inZone(z, world.graph.x[i], world.graph.y[i])) return true;
    }
    return false;
  }));

const naga14World = await loadScenario(naga14Cfg, { readText, overrides: { noEvents: true } });
const extraStats = A.addExtraAreaBins(naga14World, [...schedule, ...barangays], { extraPerScheduleArea: 3, minPerBarangay: 3 });
check('extra area bins placed across all 17 schedule areas (51 extra) and every barangay (>= 3 bins)',
  extraStats.scheduleAdded === 51 &&
  schedule.every((z) => naga14World.bins.filter((b) => b.extra && b.area === z.code).length >= 3 &&
    naga14World.bins.filter((b) => b.id.startsWith(`XB_${z.code}_`)).length === 3) &&
  barangays.every((z) => naga14World.bins.filter((b) => A.inZone(z, naga14World.graph.x[b.node], naga14World.graph.y[b.node])).length >= 3));

const naga14Sim = new Simulation(naga14World).run();
check('all bins including extra area bins are collected in simulation',
  naga14Sim.finished && naga14Sim.binsCollected === naga14World.bins.length && naga14Sim.binsMissed === 0);

console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
