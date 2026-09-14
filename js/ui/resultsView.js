/**
 * Results rendering: the summary verdict, the aggregate table, the comparison
 * against A* and the per-run detail table.
 */

import {
  fmtMs, fmtNum, fmtInt, fmtMeters, fmtSeconds, fmtDeltaPct,
} from '../core/format.js';
import { trafficRampCss, elevationRampCss, UI } from './colors.js';

const DASH = '\u2014';

// ===========================================================================
//  Verdict
// ===========================================================================

/**
 * Plain-language summary of how each non-baseline algorithm performed against A*.
 * @param {HTMLElement} el
 * @param {object} run result object returned by `runBenchmark`
 */
export function renderVerdict(el, run) {
  if (!run) {
    el.textContent = 'No benchmark has been run yet.';
    return;
  }

  const { comparison, results, testCase, repetitions, warnings } = run;
  const baseline = results.find((r) => r.isBaseline);
  const others = comparison.rows.filter((r) => !r.isBaseline);

  const parts = [];

  const meta = testCase.meta;
  parts.push(
    `<div><span class="k">${meta.scenarioName}</span> &nbsp;·&nbsp; ` +
    `${fmtInt(meta.nodeCount)} nodes, ${fmtInt(meta.edgeCount)} roads, ` +
    `${fmtInt(meta.closedEdges)} closed &nbsp;·&nbsp; ` +
    `terrain range ${fmtMeters(meta.elevationRange)}, mean traffic factor ` +
    `${fmtNum(meta.meanTraffic, 3)} &nbsp;·&nbsp; origin ${testCase.start} → destination ${testCase.goal} ` +
    `&nbsp;·&nbsp; ${repetitions} repetitions per algorithm</div>`,
  );

  // A collection round changes what every column means, so say so explicitly.
  if (run.mode === 'round') {
    parts.push(
      `<div><span class="k">Collection round</span>: depot ${run.round.depot} → ` +
      `${run.stopCount} pickup points → depot (${run.legCount} legs). ` +
      `<span class="flat">All times, node counts and costs below are ROUND TOTALS, not per query.</span></div>`,
    );
  }

  // Preprocessing is paid once, so show the combined figure alongside its two parts.
  const prepParts = results.map((r) => {
    const combined = run.mode === 'round' && r.timeWithPrep
      ? ` = <span class="k">${fmtMs(r.timeWithPrep.avg)} ms per round</span>`
      : '';
    return `${r.short}: ${fmtMs(r.prepMs, 2)} ms prep + ${fmtMs(r.time.avg)} ms solve${combined}`;
  });
  if (results.some((r) => r.prepMs > 0)) {
    parts.push(
      `<div><span class="k">Preprocessing</span> is not part of the timed solve: ` +
      `${prepParts.join(' &nbsp;·&nbsp; ')}</div>`,
    );
  }

  for (const row of others) {
    const r = results.find((x) => x.id === row.id);
    if (!r) continue;

    if (!r.found) {
      parts.push(`<div><span class="k" style="color:${r.color}">${r.name}</span> found <span class="down">no route</span> between the origin and the destination.</div>`);
      continue;
    }
    if (!r.valid) {
      parts.push(`<div><span class="k" style="color:${r.color}">${r.name}</span> returned an <span class="down">invalid path</span> (${r.reason || 'verification failed'}).</div>`);
      continue;
    }

    if (!baseline || !baseline.valid) {
      parts.push(`<div><span class="k" style="color:${r.color}">${r.name}</span>: ${fmtMs(r.time.avg)} ms average, ${fmtInt(r.nodesExpanded.avg)} nodes expanded.</div>`);
      continue;
    }

    const faster = row.timeDeltaPct < 0;
    const speedClass = Math.abs(row.timeDeltaPct) < 0.5 ? 'flat' : faster ? 'up' : 'down';
    const exploredClass = row.exploredDeltaPct < -0.5 ? 'up' : row.exploredDeltaPct > 0.5 ? 'down' : 'flat';
    const expandedClass = row.expandedDeltaPct < -0.5 ? 'up' : row.expandedDeltaPct > 0.5 ? 'down' : 'flat';
    const costClass = Math.abs(row.costDeltaPct) < 0.05 ? 'flat' : row.costDeltaPct < 0 ? 'up' : 'down';

    parts.push(
      `<div><span class="k" style="color:${r.color}">${r.name}</span> vs A*: ` +
      `execution time <span class="${speedClass}">${fmtDeltaPct(row.timeDeltaPct)}</span> ` +
      `(<span class="${speedClass}">${fmtNum(row.speedup, 2)}×</span>), ` +
      `nodes explored <span class="${exploredClass}">${fmtDeltaPct(row.exploredDeltaPct)}</span>, ` +
      `nodes expanded <span class="${expandedClass}">${fmtDeltaPct(row.expandedDeltaPct)}</span>, ` +
      `path cost <span class="${costClass}">${fmtDeltaPct(row.costDeltaPct)}</span>, ` +
      `distance <span class="${costClass}">${fmtDeltaPct(row.distanceDeltaPct)}</span>. ` +
      (row.sameRoute
        ? '<span class="flat">Identical route.</span>'
        : row.betterRoute
          ? '<span class="up">Cheaper route than A* (A* is optimal here, so the other search trades optimality for speed).</span>'
          : '<span class="down">Different, more expensive route than A*.</span>') +
      '</div>',
    );
  }

  if (baseline && baseline.found) {
    const invalidNote = !baseline.valid ? ` <span class="down">(${baseline.reason || 'invalid route'})</span>` : '';
    parts.push(
      `<div><span class="k">Baseline</span>: A* averaged ${fmtMs(baseline.time.avg)} ms${invalidNote}, ` +
      `expanded ${fmtInt(baseline.nodesExpanded.avg)} nodes, expanded ` +
      `${fmtInt(baseline.arcsRelaxed.avg)} arcs, route cost ${fmtNum(baseline.cost.avg, 2)} ` +
      `over ${fmtMeters(baseline.distance.avg)}.</div>`,
    );
  }

  for (const w of warnings) {
    parts.push(`<div class="down">Warning: ${w}</div>`);
  }

  el.innerHTML = parts.join('');
}

// ===========================================================================
//  Aggregate table
// ===========================================================================

export function renderResultsTable(table, run) {
  if (!run) {
    table.innerHTML = '';
    return;
  }

  const { results } = run;
  const valid = results.filter((r) => r.valid && Number.isFinite(r.time.avg));
  const bestTime = valid.length ? Math.min(...valid.map((r) => r.time.avg)) : NaN;
  const bestExpanded = valid.length ? Math.min(...valid.map((r) => r.nodesExpanded.avg)) : NaN;

  const head = [
    'Algorithm', 'Route',
    'Avg (ms)', 'Fastest (ms)', 'Slowest (ms)', 'Median (ms)', 'Std dev',
    'Avg nodes explored', 'Avg nodes expanded', 'Avg arcs relaxed',
    'Avg path cost', 'Avg distance', 'Avg travel time', 'Prep (ms)',
  ];

  const body = results.map((r) => {
    const routeTag = !r.found
      ? '<span class="tag no">no route</span>'
      : r.valid
        ? '<span class="tag ok">valid</span>'
        : `<span class="tag no" title="${r.reason || 'invalid path'}">invalid</span>`;

    const isBestTime = Number.isFinite(bestTime) && r.time.avg === bestTime;
    const isBestExpanded = Number.isFinite(bestExpanded) && r.nodesExpanded.avg === bestExpanded;

    return `<tr class="${r.isBaseline ? 'baseline' : ''}">
      <td><span class="dot" style="background:${r.color}"></span>${r.name}${r.isBaseline ? ' <span class="tag base">baseline</span>' : ''}</td>
      <td>${routeTag}</td>
      <td class="${isBestTime ? 'best' : ''}">${fmtMs(r.time.avg)}</td>
      <td>${fmtMs(r.time.min)}</td>
      <td>${fmtMs(r.time.max)}</td>
      <td>${fmtMs(r.time.median)}</td>
      <td>${fmtMs(r.time.stddev, 3)}</td>
      <td>${fmtInt(r.nodesExplored.avg)}</td>
      <td class="${isBestExpanded ? 'best' : ''}">${fmtInt(r.nodesExpanded.avg)}</td>
      <td>${fmtInt(r.arcsRelaxed.avg)}</td>
      <td>${fmtNum(r.cost.avg, 2)}</td>
      <td>${fmtMeters(r.distance.avg)}</td>
      <td>${fmtSeconds(r.travelTime.avg)}</td>
      <td>${fmtMs(r.prepMs, 2)}</td>
    </tr>`;
  }).join('');

  table.innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody>`;
}

// ===========================================================================
//  Comparison table
// ===========================================================================

export function renderComparisonTable(table, run) {
  if (!run) {
    table.innerHTML = '';
    return;
  }
  const { results, comparison } = run;
  const others = comparison.rows.filter((r) => !r.isBaseline);

  if (others.length === 0) {
    table.innerHTML = '<tbody><tr><td>Only the baseline algorithm is registered.</td></tr></tbody>';
    return;
  }

  const head = [
    'Algorithm', 'Execution time', 'Speed-up', 'Nodes explored', 'Nodes expanded',
    'Arcs relaxed', 'Path cost', 'Path distance', 'Route',
  ];

  const cls = (v, lowerIsBetter = true) => {
    if (!Number.isFinite(v) || Math.abs(v) < 0.05) return 'flat';
    const better = lowerIsBetter ? v < 0 : v > 0;
    return better ? 'up' : 'down';
  };

  const body = others.map((row) => {
    const r = results.find((x) => x.id === row.id);
    const routeCell = !row.comparable
      ? DASH
      : row.sameRoute
        ? '<span class="tag ok">identical</span>'
        : row.betterRoute
          ? '<span class="tag ok">cheaper</span>'
          : '<span class="tag no">longer</span>';

    return `<tr>
      <td><span class="dot" style="background:${r ? r.color : '#888'}"></span>${row.name}</td>
      <td class="${cls(row.timeDeltaPct)}">${fmtDeltaPct(row.timeDeltaPct)}</td>
      <td class="${Number.isFinite(row.speedup) && row.speedup > 1 ? 'up' : 'flat'}">${Number.isFinite(row.speedup) ? `${fmtNum(row.speedup, 2)}×` : DASH}</td>
      <td class="${cls(row.exploredDeltaPct)}">${fmtDeltaPct(row.exploredDeltaPct)}</td>
      <td class="${cls(row.expandedDeltaPct)}">${fmtDeltaPct(row.expandedDeltaPct)}</td>
      <td class="${cls(row.arcsDeltaPct)}">${fmtDeltaPct(row.arcsDeltaPct)}</td>
      <td class="${cls(row.costDeltaPct)}">${fmtDeltaPct(row.costDeltaPct)}</td>
      <td class="${cls(row.distanceDeltaPct)}">${fmtDeltaPct(row.distanceDeltaPct)}</td>
      <td>${routeCell}</td>
    </tr>`;
  }).join('');

  table.innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody>`;
}

// ===========================================================================
//  Per-run detail
// ===========================================================================

export function renderRunsTable(table, run) {
  if (!run) {
    table.innerHTML = '';
    return;
  }

  const head = [
    'Algorithm', 'Run', 'Time (ms)', 'Found', 'Valid',
    'Nodes explored', 'Nodes expanded', 'Arcs relaxed', 'Path cost', 'Distance',
  ];

  const rows = [];
  for (const r of run.results) {
    for (const run_ of r.runs) {
      rows.push(`<tr>
        <td><span class="dot" style="background:${r.color}"></span>${r.short}</td>
        <td>${run_.index}</td>
        <td>${fmtMs(run_.ms)}</td>
        <td>${run_.found ? 'yes' : 'no'}</td>
        <td>${run_.valid ? 'yes' : 'no'}</td>
        <td>${fmtInt(run_.nodesExplored)}</td>
        <td>${fmtInt(run_.nodesExpanded)}</td>
        <td>${fmtInt(run_.arcsRelaxed)}</td>
        <td>${fmtNum(run_.cost, 2)}</td>
        <td>${fmtMeters(run_.distance)}</td>
      </tr>`);
    }
  }

  table.innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody>`;
}

// ===========================================================================
//  Legend
// ===========================================================================

export function renderLegend(el, algorithms, options) {
  const items = [];

  for (const alg of algorithms) {
    items.push(`<span class="legend-item"><span class="swatch line" style="background:${alg.color}"></span>${alg.name} route</span>`);
  }

  if (options.explored) {
    for (const alg of algorithms) {
      items.push(`<span class="legend-item"><span class="swatch" style="background:${alg.color};opacity:0.34"></span>${alg.short} expanded nodes</span>`);
    }
  }

  if (options.traffic) {
    items.push(`<span class="legend-item"><span class="swatch ramp" style="background:${trafficRampCss()}"></span>road traffic: free → congested</span>`);
  }

  if (options.elevation) {
    items.push(`<span class="legend-item"><span class="swatch ramp" style="background:${elevationRampCss()}"></span>node elevation: low → high</span>`);
  }

  if (options.closed) {
    items.push('<span class="legend-item"><span class="swatch dashed"></span>closed road</span>');
  }

  items.push(`<span class="legend-item"><span class="swatch" style="background:${UI.start}"></span>origin (S)</span>`);
  items.push(`<span class="legend-item"><span class="swatch" style="background:${UI.goal}"></span>destination (G)</span>`);

  el.innerHTML = items.join('');
}

/** Update the little caption badges on the single-algorithm canvases. */
export function updateBadges(badges, results) {
  for (const [id, el] of Object.entries(badges)) {
    if (!el) continue;
    const r = results.find((x) => x.id === id);
    if (!r) {
      el.textContent = id;
      continue;
    }
    const stats = Number.isFinite(r.time.avg)
      ? ` · ${fmtMs(r.time.avg, 2)} ms · ${fmtInt(r.nodesExpanded.avg)} expanded`
      : '';
    el.textContent = `${r.name}${stats}`;
  }
}
