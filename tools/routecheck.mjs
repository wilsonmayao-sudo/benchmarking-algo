/**
 * Bin edits + area-locked routes + trip details — run with `npm run routecheck`.
 * Uses the real Naga map and the small sample, headless.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadScenario } from '../js/sim/config/scenarioLoader.js';
import { Simulation } from '../js/sim/simulation.js';
import { saveRoute, removeRoute, addBin, moveBin, updateBin, deleteBin, areaProblem, hold, OUTSIDE_MSG } from '../js/sim/fleet/routes.js';
import { pointInPolygon } from '../js/sim/fleet/routeAreas.js';
import { truckXY } from '../js/sim/fleet/truck.js';
import { truckDetails, routeDetails, fmtTime } from '../js/sim/fleet/trip.js';
import { visibleBins } from '../js/sim/fleet/bins.js';

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` ${extra}`}`);
}
const readText = async (p) => readFileSync(resolve(p), 'utf8');
const load = async (name) => new Simulation(await loadScenario(JSON.parse(await readText(`data/scenarios/${name}.json`)), { readText }));
const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/**
 * Watches every truck for jumps. look(dt) compares with the last look: a truck may not be
 * farther away than it could have driven in dt seconds (dt = 0: an edit, nobody may move).
 */
function jumpWatch(sim) {
  let prev = sim.trucks.map((t) => truckXY(sim.graph, t));
  const w = {
    worst: 0,
    look(dt) {
      sim.trucks.forEach((t, i) => {
        const p = truckXY(sim.graph, t);
        w.worst = Math.max(w.worst, Math.hypot(p.x - prev[i].x, p.y - prev[i].y) - (t.speed * dt * 1.02 + 0.5));
        prev[i] = p;
      });
    },
    /** Run an edit: positions right before and right after it must be the same. */
    edit(fn) { w.look(1e9); const r = fn(); w.look(0); return r; },
  };
  return w;
}

/**
 * Follow route trucks through their trip, one tick at a time, and collect every rule break:
 *   outside    collecting part of the trip, but not inside the area
 *   badWork    emptying or heading for a bin on any other part of the trip
 *   badLeave   left the area although the next bin would still fit
 */
function tripWatch(sim, trucks, poly) {
  const phases = new Map(trucks.map((t) => [t.id, [t.phase]]));
  const w = { outside: 0, badWork: 0, badLeave: 0, phases };
  w.look = () => {
    for (const t of trucks) {
      const list = phases.get(t.id);
      const was = list[list.length - 1];
      if (t.phase !== was) list.push(t.phase);
      const p = truckXY(sim.graph, t);
      if (t.phase === 'area' && !pointInPolygon(p.x, p.y, poly)) w.outside++;
      if (t.phase !== 'area' && (t.status === 'servicing' || t.target?.kind === 'bin')) w.badWork++;
      if (was === 'area' && t.phase !== 'area' && t.queue.some((id) => t.load + sim.binsById.get(id).load <= t.maxCapacity) && t.mode !== 'full') w.badLeave++;
    }
  };
  return w;
}
const TRIP = 'toArea,area,toLandfill,toDepot,done';

/** A square around the densest group of bins. */
function busyBox(sim, half) {
  let best = null, n = -1;
  for (const b of sim.bins) {
    const c = sim.bins.filter((o) => Math.abs(o.x - b.x) < half && Math.abs(o.y - b.y) < half).length;
    if (c > n) { n = c; best = b; }
  }
  return box(best.x - half + 3.3, best.y - half + 1.7, best.x + half + 3.3, best.y + half + 1.7);
}

for (const [name, half] of [['sample-fleet', 450], ['naga-14-trucks', 1200], ['naga-swmo-schedule', 500]]) {
  console.log(`\n${name}`);
  const sim = await load(name);
  const total = sim.bins.length;

  // 1. bin limit
  const ten = visibleBins(sim.bins, 10);
  const minShown = Math.min(...ten.map((b) => b.fill));
  const rest = sim.bins.filter((b) => !ten.includes(b));
  check('limit 10 gives exactly the 10 fullest bins', ten.length === Math.min(10, total) && rest.every((b) => b.fill <= minShown));
  check('"All" gives every bin', visibleBins(sim.bins, Infinity).length === total);

  // 3. route
  const jumps = jumpWatch(sim);
  const poly = busyBox(sim, half);
  const ids = [sim.trucks[0].id, sim.trucks[1].id];
  const t0 = Date.now();
  const res = jumps.edit(() => saveRoute(sim, { id: 'r1', name: 'Centro', color: '#38bdf8', truckIds: ids, poly }));
  check(`route saved (${sim.bins.filter((b) => b.routeId).length} bins, ${Date.now() - t0} ms)`, res.ok, res.message);
  if (!res.ok) continue;
  const inside = sim.bins.filter((b) => pointInPolygon(b.x, b.y, poly));
  check('every bin inside belongs to the route, none outside', sim.bins.every((b) => (b.routeId === 'r1') === inside.includes(b)));
  check('no free truck keeps a bin of the route', sim.trucks.every((t) => t.routeId || t.queue.every((id) => !sim.binsById.get(id).routeId)));
  check('overlapping route is refused with a warning', /overlaps "Centro"/.test(saveRoute(sim, { id: 'r2', name: 'X', color: '#fff', truckIds: [], poly: poly.map(([x, y]) => [x + half / 2, y]) }).message || ''));
  check('area inside another is refused', /overlaps/.test(areaProblem(sim, poly.map(([x, y]) => [poly[0][0] + half + (x - poly[0][0] - half) / 2, poly[0][1] + half + (y - poly[0][1] - half) / 2]))));
  check('area containing another is refused', /overlaps/.test(areaProblem(sim, poly.map(([x, y]) => [poly[0][0] + half + (x - poly[0][0] - half) * 2, poly[0][1] + half + (y - poly[0][1] - half) * 2]))));
  check('self-crossing outline is refused', /crosses itself/.test(areaProblem(sim, [poly[0], poly[2], poly[1], poly[3]], 'r1')));

  // add bins: inside joins, just outside does not
  const anchor = sim.routes.get('r1').area.core[0];
  const a = addBin(sim, { id: 'U1', name: 'Bin #901', type: 'Organic', x: sim.graph.x[anchor], y: sim.graph.y[anchor], fill: 100, capacityKg: 80 });
  check('bin added inside joins the route and a route truck', a.ok && a.bin.routeId === 'r1' && ids.includes(a.bin.truckId));
  let edge = -1, edgeD = Infinity; // the road corner outside, closest to the boundary
  const distToBox = (i) => Math.hypot(Math.max(poly[0][0] - sim.graph.x[i], 0, sim.graph.x[i] - poly[2][0]), Math.max(poly[0][1] - sim.graph.y[i], 0, sim.graph.y[i] - poly[2][1]));
  for (let i = 0; i < sim.graph.nodeCount; i++) {
    if (pointInPolygon(sim.graph.x[i], sim.graph.y[i], poly) || (sim.world.allowed && !sim.world.allowed[i])) continue;
    const d = distToBox(i);
    if (d < edgeD) { edgeD = d; edge = i; }
  }
  const o = addBin(sim, { id: 'U2', name: 'Bin #902', x: sim.graph.x[edge], y: sim.graph.y[edge], fill: 100, capacityKg: 10 });
  check(`full bin ${Math.round(edgeD)} m outside stays Unassigned`, o.ok && o.bin.routeId === null && !ids.includes(o.bin.truckId));
  check('total counts the added bins', sim.bins.length === total + 2);

  // strict rule, every tick; a road event now and then
  const routeTrucks = sim.trucks.filter((t) => t.routeId);
  check('creating the route moves no truck', jumps.worst <= 0, jumps.worst);
  check('route trucks start at the depot', routeTrucks.every((t) => t.node === sim.world.depot && t.arcPos === 0));
  const depotInside = sim.routes.get('r1').area.inCore[sim.world.depot] === 1; // then there is nothing to drive to
  const trip = tripWatch(sim, routeTrucks, poly);
  const d0 = routeDetails(sim, sim.routes.get('r1'));
  check('not late at the start', d0.delay === '' && d0.done === 0 && d0.total === inside.length + 1, JSON.stringify(d0));
  let offPin = 0, seen = new Set(), steps = 0, serviceTimes = [], started = new Map();
  while (!sim.finished && steps < 60000) {
    sim.step();
    steps++;
    jumps.look(1);
    trip.look();
    for (const t of sim.trucks) {
      if (t.status !== 'servicing') continue;
      const bin = sim.binsById.get(t.target.binId), q = truckXY(sim.graph, t);
      if (Math.hypot(q.x - bin.x, q.y - bin.y) > 0.01) offPin++;
    }
    for (const t of routeTrucks) {
      seen.add(truckDetails(sim, t).status);
      if (t.status === 'servicing' && !started.has(t.id)) started.set(t.id, sim.time);
      if (t.status !== 'servicing' && started.has(t.id)) { serviceTimes.push(sim.time - started.get(t.id)); started.delete(t.id); }
    }
    if (routeTrucks.every((t) => t.status === 'idle')) break;
  }
  check('no truck ever jumps (every tick, every truck)', jumps.worst <= 0, `${jumps.worst} m too far`);
  check('while collecting, route trucks are inside the area on every tick', trip.outside === 0, `${trip.outside} ticks`);
  check('nothing is collected on the way to the area, landfill or depot', trip.badWork === 0, trip.badWork);
  check('every truck stands exactly on the bin pin while collecting', offPin === 0, offPin);
  check('leaves the area only when its bins are done or it is full', trip.badLeave === 0, trip.badLeave);
  check('trip is depot → area → landfill → depot', routeTrucks.every((t) => {
    const list = trip.phases.get(t.id).join();
    return list.startsWith(depotInside ? 'area,toLandfill' : 'toArea,area,toLandfill') && list.endsWith('toLandfill,toDepot,done');
  }), [...trip.phases.values()].join(' | '));
  check('ends empty and parked at the depot', routeTrucks.every((t) => t.load === 0 && t.status === 'idle' && t.node === sim.world.depot &&
    t.timeline.some((e) => e.text === 'Unloaded at the landfill') && t.timeline.at(-1).text === 'Route finished: back at the depot'),
  routeTrucks.map((t) => `${t.status} ${t.load} ${t.timeline.at(-1)?.text}`).join(' | '));
  check('route trucks collected only route bins', sim.bins.every((b) => !ids.includes(b.collectedBy) || b.routeId === 'r1'));
  check('all route bins collected and emptied, or listed as unreachable',
    sim.bins.filter((b) => b.routeId === 'r1').every((b) => (b.state === 'collected' && b.fill === 0 && ids.includes(b.collectedBy)) || b.unreachable),
    sim.bins.filter((b) => b.routeId === 'r1' && b.state !== 'collected').map((b) => b.id).join());
  check('stops last about 2 minutes', Math.abs(Math.min(...serviceTimes) - 120) <= 2, Math.min(...serviceTimes));
  check('status words seen', ['On the way', 'Collecting'].every((s) => seen.has(s)), [...seen].join());
  const d1 = routeDetails(sim, sim.routes.get('r1'));
  check('route finishes with times and newest event first', d1.status === 'Finished' && d1.done === d1.total - sim.bins.filter((b) => b.unreachable).length &&
    d1.events[0].time >= d1.events[d1.events.length - 1].time && d1.events.at(-1).text.includes('Route started'));
  console.log(`    started ${fmtTime(d1.startedAt)}, finished ${fmtTime(d1.endAt)}, ${d1.delay || 'on time'}; statuses ${[...seen].join(', ')}`);

  // 2. edit / move / delete after collection
  if (!sim.finished) {
    jumps.edit(() => updateBin(sim, 'U1', { fill: 90, name: 'Bin #901b' }));
    check('a refilled bin goes back to work', sim.binsById.get('U1').state === 'assigned' && sim.binsById.get('U1').name === 'Bin #901b');
    const back = sim.trucks.find((t) => t.id === sim.binsById.get('U1').truckId);
    let entered = false, k = 0;
    while (back.status !== 'idle' && !sim.finished && k++ < 20000) {
      sim.step();
      jumps.look(1);
      if (back.status === 'servicing') { const q = truckXY(sim.graph, back); entered = pointInPolygon(q.x, q.y, poly) && back.phase === 'area'; }
    }
    check('truck goes out again for a refilled bin and returns to the depot', entered && sim.binsById.get('U1').state === 'collected' && back.load === 0 && back.node === sim.world.depot);
    if (sim.finished) { console.log('    (run ended)'); continue; }
    updateBin(sim, 'U1', { fill: 60 });
    const far = moveBin(sim, 'U1', poly[0][0] - 1e6, 0);
    check('moving far from any road is refused', !far.ok);
    moveBin(sim, 'U1', sim.graph.x[edge], sim.graph.y[edge]);
    check('bin dragged out of the area leaves the route', sim.binsById.get('U1').routeId === null && !ids.includes(sim.binsById.get('U1').truckId));
    const n = sim.bins.length;
    deleteBin(sim, 'U1');
    check('deleted bin is gone everywhere', sim.bins.length === n - 1 && sim.trucks.every((t) => !t.queue.includes('U1')) && !sim.pending.includes('U1'));
    jumps.edit(() => removeRoute(sim, 'r1'));
    check('none of these edits moved a truck', jumps.worst <= 0, jumps.worst);
    check('deleting the route frees its trucks and bins', sim.trucks.every((t) => !t.routeId) && sim.bins.every((b) => !b.routeId));
    sim.run();
    check('run still finishes', sim.finished);
  }
}

// stacked bins + chosen bins
console.log('\nstacked bins, chosen bins');
{
  const stacked = async () => {
    const sim = await load('naga-swmo-schedule');
    const groups = new Map();
    for (const b of sim.bins) groups.set(b.node, [...(groups.get(b.node) || []), b]);
    const list = [...groups.values()].find((g) => g.length === 27) || [...groups.values()].sort((a, b) => b.length - a.length)[0];
    const c = list[0];
    let poly = null;
    for (const h of [60, 100, 150, 200, 300]) {
      poly = box(c.x - h + 0.3, c.y - h + 0.7, c.x + h + 0.3, c.y + h + 0.7);
      if (!areaProblem(sim, poly)) break;
    }
    sim.truckDelays = false;
    return { sim, poly, inside: sim.bins.filter((b) => pointInPolygon(b.x, b.y, poly)) };
  };
  const runRoute = (sim, t) => { let n = 0; const order = []; let last = 0; while (t.status !== 'idle' && !sim.finished && n++ < 40000) { sim.step(); if (t.collected > last) { last = t.collected; order.push(sim.bins.filter((b) => b.collectedBy === t.id).sort((a, b) => b.collectedAt - a.collectedAt)[0].id); } } return { n, order }; };

  const a = await stacked();
  const t = a.sim.trucks[0];
  saveRoute(a.sim, { id: 'r', name: 'R', color: '#fff', truckIds: [t.id], poly: a.poly });
  const ra = runRoute(a.sim, t);
  const spots = new Set(a.inside.map((b) => b.node)).size;
  check(`${a.inside.length} bins on ${spots} point(s) are emptied without getting stuck (${Math.round(ra.n / 60)} min)`,
    a.inside.every((b) => b.state === 'collected') && ra.n < a.inside.length * 60 + 3600, ra.n);
  check('finish prediction stays right for stacked bins', Math.abs(t.trip.finishedAt - t.trip.plannedEnd) < 120, t.trip.finishedAt - t.trip.plannedEnd);

  const b = await stacked();
  const tb = b.sim.trucks[0];
  const want = [b.inside[4].id, b.inside[0].id, b.inside[2].id];
  const excluded = b.inside.map((x) => x.id).filter((id) => !want.includes(id));
  saveRoute(b.sim, { id: 'r', name: 'R', color: '#fff', truckIds: [tb.id], poly: b.poly, excluded, order: want });
  const d = routeDetails(b.sim, b.sim.routes.get('r'));
  check('only the 3 selected bins are on the route', d.total === 3 && b.sim.bins.filter((x) => x.routeId).length === 3, d.total);
  const rb = runRoute(b.sim, tb);
  check('visited in the selected order 1, 2, 3', JSON.stringify(rb.order) === JSON.stringify(want), rb.order.join());
  check('unselected bins were not collected by the route truck', b.inside.every((x) => want.includes(x.id) || x.collectedBy !== tb.id));
  const c = await stacked();
  saveRoute(c.sim, { id: 'r', name: 'R', color: '#fff', truckIds: [c.sim.trucks[0].id], poly: c.poly, excluded: c.inside.map((x) => x.id) });
  const n0 = c.sim.routes.get('r').area.core[0];
  const add = addBin(c.sim, { id: 'U5', name: 'Bin #5', x: c.sim.graph.x[n0], y: c.sim.graph.y[n0], fill: 80, capacityKg: 50 });
  check('a new bin still joins a route with selected bins', add.bin.routeId === 'r');
  saveRoute(c.sim, { ...c.sim.routes.get('r'), excluded: [], order: null });
  check('left-out bins can be put back', c.inside.every((x) => x.routeId === 'r'));
}

// edits in the middle of a run
console.log('\nmid-run edits');
{
  const sim = await load('naga-14-trucks');
  const jumps = jumpWatch(sim);
  for (let i = 0; i < 900; i++) { sim.step(); jumps.look(1); }
  const poly = busyBox(sim, 1200);
  const t = sim.trucks.find((x) => { const p = truckXY(sim.graph, x); return x.arcPos > 0 && !pointInPolygon(p.x, p.y, poly); });
  const id = t.id;
  const midRoad = sim.trucks.some((x) => x.arcPos > 0);
  const r = jumps.edit(() => saveRoute(sim, { id: 'r', name: 'R', color: '#fff', truckIds: [id], poly }));
  check('route created while trucks are driving', r.ok && midRoad, r.message);
  check('truck stays where it was and starts driving there', jumps.worst <= 0 && t.phase === 'toArea' && t.arcPos > 0, `${jumps.worst} ${t.phase}`);
  for (let i = 0; i < 4000 && t.phase !== 'area'; i++) { sim.step(); jumps.look(1); }
  check('truck reaches the area by road', t.phase === 'area' && jumps.worst <= 0 && t.timeline.some((e) => e.text === 'Reached R'), jumps.worst);
  check('truck with work is tracked', t.trip !== null);
  const before = truckDetails(sim, t).late;
  const n = sim.routes.get('r').area.core[5];
  addBin(sim, { id: 'U9', name: 'Bin #9', x: sim.graph.x[n], y: sim.graph.y[n], fill: 50, capacityKg: 100 });
  check('extra work is not reported as a delay', Math.abs(truckDetails(sim, t).late - before) < 2, `${before} → ${truckDetails(sim, t).late}`);
  // delay shows
  while (t.status !== 'driving' && !sim.finished) sim.step();
  hold(sim, t, 360, 'heavy traffic');
  sim.refreshEta(t);
  const d = truckDetails(sim, t);
  check('a 6 min hold shows as Delayed with a reason', d.status === 'Delayed' && /Running \d+ min late — heavy traffic/.test(d.delay), JSON.stringify([d.status, d.delay]));
  // force an illegal road
  while ((t.arcPos !== 0 || t.status !== 'driving' || t.holdUntil > sim.time) && !sim.finished) sim.step();
  const bad = sim.routes.get('r').area.edgeOk.indexOf(0);
  let arc = -1;
  for (let k = 0; k < sim.graph.arcCount; k++) if (sim.graph.adjEdge[k] === bad) { arc = k; break; }
  t.arcs = [arc];
  sim.step();
  const p = truckXY(sim.graph, t);
  check('a step out of the area is blocked and logged', pointInPolygon(p.x, p.y, poly) && t.timeline.some((e) => e.text === OUTSIDE_MSG));
  const poly2 = busyBox(sim, 900);
  check('route can be redrawn', jumps.edit(() => saveRoute(sim, { id: 'r', name: 'R', color: '#fff', truckIds: [id], poly: poly2 })).ok);
  // far away from where the truck is now: it must drive to the new place
  const here = truckXY(sim.graph, t);
  const away = sim.bins.filter((b) => b.state !== 'collected' && Math.hypot(b.x - here.x, b.y - here.y) > 3000)[0];
  const poly3 = box(away.x - 900, away.y - 900, away.x + 900.5, away.y + 900.5);
  const moved = jumps.edit(() => saveRoute(sim, { id: 'r', name: 'R', color: '#fff', truckIds: [id], poly: poly3 }));
  check('redrawing the area far away does not move the truck', moved.ok && jumps.worst <= 0 && t.phase === 'toArea', moved.message || jumps.worst);
  const trip = tripWatch(sim, [t], poly3);
  while (!sim.finished && t.status !== 'idle') { sim.step(); jumps.look(1); trip.look(); }
  check('it drives to the new area, collects, and returns to the depot', trip.phases.get(id).join().endsWith('area,toLandfill,toDepot,done') &&
    trip.outside + trip.badWork + trip.badLeave === 0 && t.node === sim.world.depot, trip.phases.get(id).join());
  while (!sim.finished) { sim.step(); jumps.look(1); }
  check('no truck jumped in the whole run', jumps.worst <= 0, `${jumps.worst} m too far`);
  check('run finishes', sim.finished);
  check('12-hour clock', fmtTime(0) === '8:00 AM' && fmtTime(5 * 3600 + 60) === '1:01 PM');
}

// a full truck, closed roads, a truck that is unloading when it is assigned
console.log('\nfull truck, closed roads, busy truck');
{
  const small = async () => {
    const sim = await load('sample-fleet');
    sim.truckDelays = false;
    return { sim, t: sim.trucks[1], poly: busyBox(sim, 450) };
  };
  const a = await small();
  const ja = jumpWatch(a.sim);
  ja.edit(() => saveRoute(a.sim, { id: 'r', name: 'R', color: '#fff', truckIds: [a.t.id], poly: a.poly }));
  const n = a.sim.routes.get('r').area.core;
  for (let i = 0; i < 4; i++) addBin(a.sim, { id: `H${i}`, name: `Heavy ${i}`, x: a.sim.graph.x[n[i]], y: a.sim.graph.y[n[i]], fill: 100, capacityKg: 400 });
  a.sim.events.removeWhere(() => true); // no road events: only the plan itself is tested
  const heavy = addBin(a.sim, { id: 'HX', name: 'Too heavy', x: a.sim.graph.x[n[0]], y: a.sim.graph.y[n[0]], fill: 100, capacityKg: 5000 });
  const ta = tripWatch(a.sim, [a.t], a.poly);
  let over = 0;
  while (!a.sim.finished && a.t.status !== 'idle') { a.sim.step(); ja.look(1); ta.look(); if (a.t.load > a.t.maxCapacity) over++; }
  const list = ta.phases.get(a.t.id).join();
  check('a full truck goes to the landfill and comes back for the rest', (list.match(/toLandfill/g) || []).length >= 3 && /toLandfill,toArea,area/.test(list) && list.endsWith('toLandfill,toDepot,done'), list);
  check('it is never overloaded, outside its area while collecting, or moved', over === 0 && ta.outside + ta.badWork + ta.badLeave === 0 && ja.worst <= 0, JSON.stringify([over, ta.outside, ta.badWork, ta.badLeave, ja.worst]));
  check('every bin that fits is collected, the too heavy one is skipped', a.sim.bins.filter((b) => b.routeId === 'r').every((b) => (b.state === 'collected') === (b.id !== 'HX')) && heavy.ok);
  check('expected finish was right (landfill trips and drive home included)', Math.abs(a.t.trip.finishedAt - a.t.trip.plannedEnd) < 30, a.t.trip.finishedAt - a.t.trip.plannedEnd);

  const b = await small();
  const near = [];
  for (let k = b.sim.graph.adjStart[b.sim.world.depot]; k < b.sim.graph.adjStart[b.sim.world.depot + 1]; k++) near.push(b.sim.graph.adjEdge[k]);
  for (const e of near) b.sim.injectEvent({ type: 'ROAD_CLOSURE', edge: e, duration: 0 });
  saveRoute(b.sim, { id: 'r', name: 'R', color: '#fff', truckIds: [b.t.id], poly: b.poly });
  check('all roads from the depot closed: truck waits there', b.t.status === 'blocked' && b.t.node === b.sim.world.depot && truckDetails(b.sim, b.t).status === 'Delayed');
  for (let i = 0; i < 600; i++) b.sim.step();
  for (const e of near) b.sim.clearRoad(e);
  for (let i = 0; i < 30; i++) b.sim.step();
  check('roads open again: it drives off, with a sensible plan', b.t.phase === 'toArea' && b.t.arcs.length > 0 && Number.isFinite(b.t.trip.plannedEnd) && truckDetails(b.sim, b.t).late < 120, truckDetails(b.sim, b.t).late);

  const c = await load('naga-14-trucks');
  const jc = jumpWatch(c);
  while (!c.trucks.some((x) => x.status === 'unloading') && !c.finished) { c.step(); jc.look(1); }
  const busy = c.trucks.find((x) => x.status === 'unloading');
  const until = busy.busyUntil;
  jc.edit(() => saveRoute(c, { id: 'r', name: 'R', color: '#fff', truckIds: [busy.id], poly: busyBox(c, 1200) }));
  check('a truck that is unloading finishes that first', busy.status === 'unloading' && busy.busyUntil === until && jc.worst <= 0);
  for (let i = 0; i < 400; i++) { c.step(); jc.look(1); }
  check('then it drives to its area', busy.phase === 'toArea' && busy.load === 0 && jc.worst <= 0, `${busy.phase} ${busy.load}`);
  // taken off its route on the very last road before the depot (it used to snap back)
  const d = await load('sample-fleet');
  d.truckDelays = false;
  const jd = jumpWatch(d);
  const td = d.trucks[1];
  saveRoute(d, { id: 'r', name: 'R', color: '#fff', truckIds: [td.id], poly: busyBox(d, 450) });
  const lastRoad = () => td.phase === 'toDepot' && td.arcPos > 0 && td.arcs.length === 1;
  while (!d.finished && !lastRoad()) { d.step(); jd.look(1); }
  check('route deleted on the last road home: truck finishes the road', lastRoad());
  jd.edit(() => removeRoute(d, 'r'));
  while (!d.finished) { d.step(); jd.look(1); }
  check('no jump, and it ends at the depot', jd.worst <= 0 && td.node === d.world.depot && td.arcPos === 0, jd.worst);

  // two trucks on one route: a heavy bin goes to the one that can carry it
  const e = await load('naga-swmo-schedule');
  const tiny = e.trucks.reduce((x, y) => (y.maxCapacity < x.maxCapacity ? y : x));
  const big = e.trucks.reduce((x, y) => (y.maxCapacity > x.maxCapacity ? y : x));
  saveRoute(e, { id: 'r', name: 'R', color: '#fff', truckIds: [tiny.id, big.id], poly: busyBox(e, 500) });
  const core = e.routes.get('r').area.core[0];
  const weight = tiny.maxCapacity + 100;
  const h1 = addBin(e, { id: 'H1', name: 'Heavy', x: e.graph.x[core], y: e.graph.y[core], fill: 100, capacityKg: weight });
  check('heavy bin goes to the truck that can carry it', h1.bin.truckId === big.id, h1.bin.truckId);
  const l1 = e.bins.find((b) => b.truckId === tiny.id);
  updateBin(e, l1.id, { capacityKg: weight, fill: 100 });
  check('a bin that got too heavy changes to the other truck', l1.truckId === big.id, l1.truckId);
  const island = areaProblem(c, box(-5000, -5000, -4000, -4000));
  check('an area without roads is refused', /no road trucks can use/.test(island), island);
  // every place a new bin can stand is reachable: try the awkward corners (one-way starts, cut-off streets)
  const f = await load('naga-swmo-schedule');
  const ways = new Uint8Array(f.graph.nodeCount);
  for (let i = 0; i < f.graph.nodeCount; i++) if (f.graph.revStart[i + 1] === f.graph.revStart[i] || f.graph.adjStart[i + 1] === f.graph.adjStart[i]) ways[i] = 1;
  let tried = 0, stuck = 0;
  for (let i = 0; i < f.graph.nodeCount && tried < 25; i++) {
    if (!ways[i] || !f.world.allowed[i]) continue;
    const r = addBin(f, { id: `W${i}`, name: `W${i}`, x: f.graph.x[i], y: f.graph.y[i], fill: 10, capacityKg: 10 });
    if (!r.ok) continue;
    tried++;
    if (f.router.findPath(f.world.depot, r.bin.node, 'route').found !== true || f.router.findPath(r.bin.node, f.world.disposal, 'route').found !== true) stuck++;
  }
  check(`bins clicked at ${tried} corners no truck can enter or leave stand at a reachable corner`, tried > 0 && stuck === 0, `${tried} ${stuck}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
