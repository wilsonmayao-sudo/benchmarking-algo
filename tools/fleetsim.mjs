/**
 * Headless fleet simulation — run with `npm run fleet` (or `node tools/fleetsim.mjs`).
 *
 *   node tools/fleetsim.mjs [scenario.json] [options]
 *
 * Options
 *   --out <dir>        where to write results (default: results/)
 *   --no-events        ignore every road event (baseline run)
 *   --no-random        keep scheduled events, drop random ones
 *   --trucks <n>       use only the first n trucks from the config
 *   --type <case>      schedule-independent case: normal | worst | random
 *   --seed <n>         override the scenario seed (changes random events / bins)
 *   --day <day>        schedule day for CSV-imported stops (mon … sun, or all)
 *   --compare          run a standard set of variants and write ONE comparison CSV:
 *                        as configured · no events · scheduled only · each truck count
 *   --log              print the full run log, not only events / handoffs / warnings
 *
 * Output (per run)
 *   <out>/<scenario>__<variant>.json   full export (summary, trucks, bins, event log, log)
 *   <out>/runs.csv                     one row per run, APPENDED, so runs from different
 *                                      scenarios accumulate into one comparable table
 *   <out>/<scenario>__compare.csv      with --compare: just that comparison
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { loadScenario, applyScenarioType, FLEET_SCENARIO_TYPES } from '../js/sim/config/scenarioLoader.js';
import { Simulation } from '../js/sim/simulation.js';
import { toJSON, toCSV, truckRows } from '../js/sim/metrics.js';
import { fmtDuration } from '../js/sim/fleet/eta.js';

// ------------------------------------------------------------------ args
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const scenarioPath = resolve(args.find((a) => a.endsWith('.json')) || 'data/scenarios/sample-fleet.json');
const outDir = resolve(opt('--out', 'results'));
const scenarioType = opt('--type', null);
const verbose = flag('--log');

if (scenarioType && !FLEET_SCENARIO_TYPES[scenarioType]) {
  console.error(`Unknown --type "${scenarioType}". Expected one of: ${Object.keys(FLEET_SCENARIO_TYPES).join(', ')}`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(scenarioPath, 'utf8'));
const readText = async (p) => readFileSync(resolve(p), 'utf8'); // geojson maps resolve from cwd
const slug = basename(scenarioPath, '.json');

// ------------------------------------------------------------------ run one
async function runOnce(overrides, { quiet = false } = {}) {
  const effective = scenarioType
    ? applyScenarioType(config, scenarioType, overrides.seed ?? config.seed)
    : config;
  const finalOverrides = scenarioType ? { scenarioType, ...overrides } : overrides;
  const world = await loadScenario(effective, { readText, overrides: finalOverrides });
  const sim = new Simulation(world);
  const summary = sim.run();

  if (!quiet) {
    console.log(`\n=== ${world.name} — ${world.variant} ===`);
    const shown = verbose ? sim.logEntries : sim.logEntries.filter((e) => e.kind !== 'collect' && e.kind !== 'assign');
    for (const e of shown) console.log(`  [${e.clock}] ${e.kind.padEnd(7)} ${e.text}`);
    console.log('\n  Per truck');
    console.table(truckRows(sim));
    printSummary(summary);
  }
  return { sim, summary };
}

function printSummary(s) {
  const rows = [
    ['Bins collected / missed', `${s.binsCollected} / ${s.binsMissed}`],
    ['Total distance', `${(s.totalDistanceM / 1000).toFixed(2)} km`],
    ['Total time (makespan)', fmtDuration(s.makespanS)],
    ['Sum of truck working time', fmtDuration(s.totalTruckTimeS)],
    ['A* calls (route/reroute/eta/assign)', `${s.astarCalls} (${s.astarRouteCalls}/${s.astarRerouteCalls}/${s.astarEtaCalls}/${s.astarAssignCalls})`],
    ['A* avg time', `${s.astarAvgMs.toFixed(4)} ms`],
    ['Nodes expanded per search avg (min–max)', `${s.nodesExpandedAvg} (${s.nodesExpandedMin}–${s.nodesExpandedMax})`],
    ['Leg-cache hits (not counted as A* calls)', s.legCacheHits],
    ['Road events applied', s.eventsApplied],
    ['Reroutes caused by events', s.reroutes],
    ['Blocked incidents', s.blockedIncidents],
    ['Bin reassignments', s.reassignments],
    ['Disposal trips', s.disposalTrips],
    ['ETA mean abs. error', `${s.etaMaeS} s`],
    ['Finished', s.finishReason],
  ];
  console.log('\n  Benchmark metrics');
  for (const [k, v] of rows) console.log(`    ${k.padEnd(42)} ${v}`);
}

function save(sim, summary) {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const variantSlug = summary.variant.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const jsonPath = join(outDir, `${slug}__${variantSlug}.json`);
  writeFileSync(jsonPath, JSON.stringify(toJSON(sim), null, 2));

  // Append to runs.csv (write the header only when the file is new).
  const csvPath = join(outDir, 'runs.csv');
  const row = { timestamp: new Date().toISOString(), scenarioFile: slug, ...summary };
  const csv = toCSV([row]);
  if (existsSync(csvPath)) appendFileSync(csvPath, csv.split('\n').slice(1).join('\n'));
  else writeFileSync(csvPath, csv);
  return { jsonPath, csvPath, row };
}

// ------------------------------------------------------------------ main
const base = {};
if (flag('--no-events')) base.noEvents = true;
if (flag('--no-random')) base.noRandomEvents = true;
if (opt('--trucks')) base.truckCount = Number(opt('--trucks'));
if (opt('--seed')) base.seed = Number(opt('--seed'));
if (opt('--day')) base.binDay = opt('--day');

if (flag('--compare')) {
  const truckTotal = (config.trucks || []).length;
  const variants = [
    { ...base },
    { ...base, noEvents: true },
    { ...base, noRandomEvents: true },
  ];
  for (let n = 1; n < truckTotal; n++) variants.push({ ...base, truckCount: n });

  const rows = [];
  for (const v of variants) {
    const { sim, summary } = await runOnce(v, { quiet: true });
    rows.push(save(sim, summary).row);
  }
  const cmpPath = join(outDir, `${slug}__compare.csv`);
  writeFileSync(cmpPath, toCSV(rows));
  console.table(rows.map((r) => ({
    variant: r.variant, collected: r.binsCollected, missed: r.binsMissed,
    'distance km': (r.totalDistanceM / 1000).toFixed(2), makespan: fmtDuration(r.makespanS),
    'A* calls': r.astarCalls, 'avg ms': r.astarAvgMs, 'exp/search': r.nodesExpandedAvg,
    reroutes: r.reroutes, blocked: r.blockedIncidents, reassign: r.reassignments,
  })));
  console.log(`\nComparison written to ${cmpPath}`);
} else {
  const { sim, summary } = await runOnce(base);
  const { jsonPath, csvPath } = save(sim, summary);
  console.log(`\n  Exported ${jsonPath}\n  Appended ${csvPath}`);
}
