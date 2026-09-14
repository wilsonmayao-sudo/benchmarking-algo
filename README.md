# Pathfinding Benchmark — Solid Waste Collection

A small, dependency-free web app that runs **your custom pathfinding algorithm** and
**standard A\*** on the *exact same* road networks and reports how they compare.

No build step. No npm packages. No external benchmarking tools — everything is measured
in the browser with `performance.now()`.

---

## Quick start

ES modules cannot be loaded from a `file://` URL, so serve the folder over HTTP:

```bash
npm start
# or: python -m http.server 8000
```

Then open <http://localhost:8000>. Use the **City map** panel to load your own road
network — `data/sample-city.geojson` is a working example you can try straight away.

Any static server works (VS Code *Live Server*, `npx serve`, XAMPP, IIS…). If you open
`index.html` directly the page shows a reminder instead of failing silently.

Optional headless checks (need Node ≥ 16, no packages installed):

```bash
npm run check       # reference check + algorithm self-check
npm run checkrefs   # every import resolves and every DOM id exists
npm run selfcheck   # builds every scenario, runs both algorithms, asserts both are optimal
npm run compare     # full multi-metric head-to-head, fairness and feature-integration analysis
npm run round       # single trip vs collection round, and where preprocessing pays off
```

`npm run compare` also runs the checks that a results table cannot: it applies a
**Welch t-test** to decide whether a time difference is real or noise, verifies the two
algorithms received identical inputs, and switches each condition (traffic, elevation,
closures) off in a twin test case to confirm the chosen route actually responds to it.
`REPEATS=25 npm run compare` raises the sample size.

---

## Folder structure

```
Benchmarking ALGO/
├─ index.html                        # single page: controls · canvases · results
├─ package.json                      # only for `npm run check` / `npm run selfcheck`
├─ css/styles.css
├─ data/                             # drop your own map files here (one-click loading)
│  └─ sample-city.geojson            # tiny working example
├─ tools/
│  ├─ checkrefs.mjs                  # import paths + DOM ids (no bundler to catch typos)
│  └─ selfcheck.mjs                  # headless verification of the core
└─ js/
   ├─ main.js                        # app controller (state + wiring)
   ├─ core/                          # framework-agnostic building blocks
   │  ├─ rng.js                      # seeded PRNG → reproducible scenarios
   │  ├─ dsu.js                      # union-find (connectivity guarantees)
   │  ├─ heap.js                     # binary min-heap frontier (shared by all algorithms)
   │  ├─ graph.js                    # typed-array graph + CSR adjacency (two-way & one-way)
   │  ├─ costModel.js                # traffic + elevation + closures → one cost
   │  ├─ pathUtils.js                # path reconstruction + independent verification
   │  ├─ metrics.js                  # avg / min / max / median / std-dev
   │  └─ format.js
   ├─ algorithms/
   │  ├─ registry.js                 # pluggable algorithm registry
   │  ├─ astar.js                    # ⛔ BASELINE — do not modify
   │  ├─ customAlgorithm.js          # ✅ YOUR ALGORITHM — swap this file
   │  └─ altAstar.js                 # A* + landmarks, to show what preprocessing buys
   ├─ data/
   │  ├─ networkGenerator.js         # road networks + topography + traffic + closures
   │  ├─ cityMapLoader.js            # GeoJSON / Overpass / CSV importer
   │  ├─ scenarios.js                # the six predefined scenarios + city-map scenarios
   │  └─ testCaseBuilder.js          # scenario → frozen test case
   ├─ benchmark/
   │  ├─ runner.js                   # single-trip timing harness + comparison
   │  └─ routeRunner.js              # collection-round harness (many legs, one prep)
   └─ ui/
      ├─ colors.js, networkView.js, resultsView.js, controls.js, playback.js
```

---

## Using your own algorithm

Everything you need to change is in **`js/algorithms/customAlgorithm.js`**. Nothing in
`astar.js` reads anything from it, and it imports nothing from `astar.js` — the two are
fully independent, so you can keep iterating on yours without ever touching the baseline.

### The contract

```js
export const myAlgorithm = {
  id: 'custom',                 // unique key
  name: 'My Algorithm',         // label in the results table
  short: 'Mine',                // short label for the canvases
  color: '#38bdf8',             // canvas colour (hex)
  description: '...',           // shown in the UI

  // OPTIONAL — runs once per test case, NOT part of the measured time.
  // Its cost is reported separately as "Prep (ms)".
  prepare(graph, costModel) {
    return context;             // e.g. landmark tables, contraction order, grids…
  },

  // REQUIRED — the ONLY thing that is timed.
  solve(graph, start, goal, costModel, context, options) {
    return {
      path,                     // number[] of node ids, start … goal (null if no route)
      found,                    // boolean
      nodesExplored,            // distinct nodes discovered
      nodesExpanded,            // nodes popped from the frontier and processed
      arcsRelaxed,              // neighbour arcs examined
      exploredNodes,            // OPTIONAL number[] — used only for the visualisation
    };
  },
};
```

### Exposing your own settings

Declare a `tunables` array and the sidebar renders a control for each entry, forwarding the
live values to your algorithm as `options`. The harness knows nothing about them.

```js
tunables: [
  {
    id: 'weight',
    label: 'Heuristic weight (w)',
    type: 'range',          // currently the only supported type
    min: 1, max: 5, step: 0.05,
    value: 1,               // default
    digits: 2,              // decimals in the live readout
    hint: 'w = 1 is exact A*; higher is faster but may cost up to w x optimal.',
  },
],

prepare(graph, costModel, options) { ... }         // options = { weight: 1.5 }
solve(graph, start, goal, costModel, context, options) { ... }
```

Changing a setting clears the previous results, because they were measured under the old
value and would otherwise look like they describe the current one.

### Rules for a meaningful comparison

1. **Never mutate** `graph`, `costModel`, `start` or `goal`. The harness fingerprints the
   graph before and after the run and warns you if anything changed.
2. **Take costs from `costModel.costOf(arc)`** (`Infinity` = closed road). Do not compute
   cost in a way A\* could not — that would make yours cheaper by definition.
3. **Put heavy setup in `prepare()`.** Only `solve()` is timed.
4. **Report honest counters.** The harness re-measures path distance and cost itself.

### Graph cheat-sheet

| Expression | Meaning |
|---|---|
| `graph.nodeCount` | number of nodes |
| `graph.x[i]`, `graph.y[i]` | coordinates (metres) |
| `graph.elevation[i]` | elevation (metres) |
| `graph.adjStart[u] … adjStart[u+1]` | the arcs leaving node `u` |
| `graph.adjNeighbor[a]` | head node of arc `a` |
| `graph.adjTail[a]` | origin node of arc `a` |
| `graph.arcTwin[a]` | the arc in the opposite direction |
| `graph.adjEdge[a]` | physical road id of arc `a` |
| `graph.edgeLength[e]`, `edgeSpeedLimit[e]`, `edgeTraffic[e]`, `edgeClosed[e]` | road attributes |
| `graph.revStart[v] … revStart[v+1]`, `graph.revArc[i]` | arcs **entering** `v` (backwards search) |
| `costModel.costOf(a)` / `timeOf(a)` | generalized cost / seconds |
| `costModel.heuristic(u, v)` | admissible straight-line lower bound |

`customAlgorithm.js` holds the **Dynamic A\*** implementation. It keeps the original
structure — the same helper functions, the same cost ingredients, a straight-line
heuristic — adapted to the harness's CSR graph and shared cost model. The header of that
file documents every adaptation and why it was needed.

---

## What the benchmark says about Dynamic A*

Measured with `npm run selfcheck` on the 6 045-node scenarios:

| Variant | Nodes expanded | Avg time | Optimal? |
|---|---|---|---|
| A\* (baseline) | 4 444 | 1.17 ms | yes |
| Dynamic A\*, as written | **6 063** | 1.20 ms | yes |
| Dynamic A\* + closed set | **4 444** | 1.08 ms | yes |

Three findings, in order of importance:

**1. The route is optimal, and `nodesExplored` is identical to A\*'s — 4 593 either way.**
Those extra 1 619 expansions are pure re-work: the loop has no closed set, so a node can be
popped and expanded repeatedly. Re-expanding never discovers anything new (which is why
`nodesExplored` matches exactly), it just relaxes the same neighbours again. Disabling that
is a **26.7 % reduction in expansions** with the identical optimal route.
The header of `customAlgorithm.js` explains how to switch it on (`skipStale`), and why it
is left off by default: the benchmark should measure the algorithm as written.

**2. The sort-based priority queue costs far more than the search it drives.** On a
1 200-node grid:

| Frontier | Avg time |
|---|---|
| shared binary min-heap | 0.14 ms |
| `MinPriorityQueue` | **9.10 ms** |

**63× slower.** It re-sorts the entire open set on every `enqueue` and uses
`Array.shift()`. Because A\* uses the shared heap, leaving this in place would charge the
queue's cost to the search strategy. `useSharedHeap: false` switches back to it if you want
to benchmark the queue itself.

**3. The cost formula could not be used as written, and one term inverts.** The original
rule is `trafficCost = distance * (trafficFactor - 1.0)`, which assumes
`trafficFactor > 1` means "worse". The harness stores traffic as a **speed** multiplier
where 1.0 is free flow and 0.12 is a jam. Measured on the heavy-traffic scenario:

| Road | Length | Traffic | Your formula | Harness cost |
|---|---|---|---|---|
| free-flowing | 60 m | 0.532 | 17.82 | 10.17 |
| congested | 67 m | 0.120 | **−21.34** | 50.08 |

The congested road scores *cheaper* than the free-flowing one, so a search using that
formula would actively prefer jams. Feeding a speed multiplier into a penalty term
written for a slowdown multiplier inverts the traffic objective.

⚠️ **This matters beyond the bugs.** Your cost *ideas* — distance, traffic, elevation with
a truck weight multiplier, restriction penalties — are all present in the harness cost
model, and both algorithms use them. What the shared model removes is the ability for one
algorithm to optimise a *different* objective than the other. If it could, "path cost" in
results would compare apples to oranges, and A\* would look better or worse because the
formulas disagree, not because either search is better.

**What this means for the comparison.** With the closed set enabled, Dynamic A\* expands
exactly the same nodes as A\* — it *is* A\* plus the extra cost bookkeeping, because the
cost model already encodes traffic and elevation. Unweighted, there is no search-strategy
difference left to measure. The sidebar's **Algorithm settings** slider changes that.

---

## Weighted A* — the speed / optimality dial

Priority is `f(n) = g(n) + w·h(n)`. At `w = 1` this is exact A\* and the route is optimal.
Above 1 the heuristic is no longer admissible, so the search is pulled toward the
destination: far fewer nodes, much faster, and the route is **bounded-suboptimal** — its
cost is guaranteed to be at most `w ×` optimal (Pohl, 1970). Drag the slider in
**Algorithm settings** to sweep it.

Measured on scenario 1 (6 045 nodes, 11 306 roads), `npm run selfcheck`:

| w | Nodes expanded | vs w = 1 | Path cost | vs optimal | Time |
|---|---|---|---|---|---|
| **1.00** | 4 444 | — | 511.34 | 1.0000× | 2.33 ms |
| 1.05 | 4 218 | −5 % | 511.34 | **1.0000×** | 2.20 ms |
| 1.10 | 3 994 | −10 % | 511.34 | **1.0000×** | 1.90 ms |
| 1.25 | 3 284 | −26 % | 511.34 | **1.0000×** | 0.60 ms |
| 1.50 | 2 165 | −51 % | 514.81 | 1.0068× | 0.62 ms |
| **2.00** | **132** | **−97 %** | 546.93 | 1.0696× | 0.09 ms |
| 3.00 | 101 | −98 % | 565.65 | 1.1062× | 0.11 ms |
| 5.00 | 101 | −98 % | 581.08 | 1.1364× | 0.07 ms |

Two things worth taking from this:

* **`w` up to 1.25 is free.** It expands 26 % fewer nodes and still returns the *exact*
  optimal route on every scenario. The cost of the guarantee has not started being paid yet.
* **The knee is at `w = 2`**: 97 % fewer nodes for 7 % more cost. Beyond that the search has
  collapsed into almost pure best-first and the extra weight only buys sub-optimality.

Node counts are exact and reproducible; the millisecond column comes from a single run each,
so treat the times as indicative — that is what the repeats and the std-dev column in the
results table are for.

---

## Using your own city map

Use the **City map** panel in the sidebar. Nothing is uploaded anywhere — the file is read
locally in the browser.

There are **three ways in**, because a native file dialog is not available in every
environment (VS Code's integrated browser and other webviews often block it):

| Way | How |
|---|---|
| Pick a file | Click the dashed **Choose file(s)** box. Two files at once = node table + edge table |
| Drag & drop | Drag the file anywhere onto the window |
| From the project folder | Copy the file into `data/`, reload the page, then click its name under **Found in data/**. Or type a path such as `data/mycity.geojson` and press **Load** (comma-separate two paths) |

The third route needs no browser file API at all — it fetches the file over the same HTTP
server that serves the app, so it works even where the picker is unavailable. If you open
the page in a normal browser tab (Chrome/Edge/Firefox at <http://localhost:8000>) the
picker works too.

> **If clicking the box does nothing**, that is the environment, not the file — use
> drag & drop or the `data/` route.

Once loaded, the map becomes scenario **7** and everything else (benchmark, comparison,
canvases) works on it unchanged. The custom-scenario panel then lets you apply different
traffic / elevation / closure conditions to it without re-uploading.

Try it right now with `data/sample-city.geojson`.

### Supported formats

Paste the Overpass query below into <https://overpass-api.de/console>, save the response as
`.json`, and load it. Add `[out:json];` and the `out body; >; out skel qt;` tail exactly as
shown so the node coordinates are included:

```
[out:json][timeout:60];
area["name"="Calauag"]->.a;
way(area.a)["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service)$"];
out body; >; out skel qt;
```

| Format | Shape | Notes |
|---|---|---|
| **GeoJSON** | `FeatureCollection` of `LineString` / `MultiLineString` | `properties.highway`, `.maxspeed`, `.oneway` are read; a third coordinate is used as elevation; `Polygon` features are skipped |
| **Overpass / OSM JSON** | `{ "elements": [...] }` | Both `out body` (ways reference node ids) and `out geom` (inline `geometry`) work. Non-drivable `highway` values (`footway`, `steps`, `cycleway`, `path`, …) are dropped |
| **CSV — one edge list** | `from_lat,from_lon,to_lat,to_lon[,speed_kph][,highway][,oneway]` | Self-contained. Other spellings of the column names work too |
| **CSV — two files** | nodes `id,lat,lon[,elevation]` **+** edges `from,to[,speed_kph][,highway][,oneway]` | Select **both** files together in the picker |

Column names are matched loosely: `node_id`/`nid`/`osmid`/`id`, `latitude`/`lat`/`y`,
`longitude`/`lon`/`lng`/`x`, `source`/`from`/`u`, `target`/`to`/`v`, `speed_kph`/`maxspeed`/`kph`,
`elevation`/`elev`/`z`/`altitude`, and so on. Comma, semicolon, tab and pipe delimiters are
auto-detected.

### What the importer does with your data

| Thing | Handling |
|---|---|
| Coordinates | Projected to local metres (equirectangular about the map's mid-latitude). City-scale distortion is well under a metre |
| Intersections | Vertices are snapped onto a 0.5 m grid, so shared junctions become one node. GIS data a few centimetres out is stitched together; two genuinely distinct nodes under 0.5 m apart would be merged |
| Distances | Recomputed from the geometry. A `length` column is **ignored** on purpose — every algorithm must see identical distances |
| One-way streets | Kept as genuinely one-way arcs (`oneway=yes` / `-1` / `reverse`, and `junction=roundabout`) |
| Speeds | From `maxspeed` (understands `"50"`, `"30 mph"`, `"none"`) or a speed column. Missing values fall back to the `highway` class table, and if the file has no speeds at all the longest 20 % of roads become 60 km/h arterials and the rest 40 km/h |
| Elevation | Used when the file has it (CSV `elevation` column, GeoJSON third coordinate). Otherwise terrain is synthesised so topography still affects routing — the panel tells you which happened |
| Connectivity | The largest connected component is found; origin and destination are always drawn from it, so a route always exists. Other components are reported as a warning |
| Traffic & closures | **Generated by the scenario, never read from the file** — a static map export carries no live traffic. This is deliberate: both algorithms get the identical congestion and closure set |

### What to send me

If you'd rather I wire in a specific map, or if your file doesn't load, send either:

1. **The file itself** — a GeoJSON, the raw Overpass JSON response, or your CSV pair. Any
   size is fine; if it is large, the bounding box plus a sample of ~50 lines is enough for
   me to see the schema.
2. **If you can't share the file**, send the **first two lines** (header + one data row) of
   each CSV, or the first ~30 lines of the JSON, plus roughly how many roads it has and
   which field holds the elevation (if any).

Useful extras, if you have them: which city / bounding box it covers, whether the
`highway` and `maxspeed` fields are populated, and whether one-way streets are tagged.

---

## Cost model

Traffic, topography and closures are folded into **one** generalized cost that both
algorithms read:

$$\text{cost}(u\to v)\;=\;\underbrace{w_t\cdot\frac{\text{len}}{\text{speed}\cdot\text{traffic}}}_{\text{congestion}}\;+\;\underbrace{w_d\cdot\text{len}}_{\text{distance}}\;+\;\underbrace{w_c\cdot\max(0,\Delta e)}_{\text{climb}}\;+\;\underbrace{w_x\cdot\max(0,-\Delta e)}_{\text{descent}}$$

| Symbol | Meaning | Default |
|---|---|---|
| $w_t$ | weight on travel time | `1.0` |
| $w_d$ | weight on distance | `0.0` |
| $w_c$ | weight per metre climbed | `0.5` |
| $w_x$ | weight per metre descended | `0.15` |

A closed road gets cost $\infty$, so it is simply never traversable.

**Heuristic (identical for both algorithms).** $h(v,g)=\text{euclid}(v,g)\cdot\left(w_d+\dfrac{w_t}{\max(\text{speed}\cdot\text{traffic})}\right)$.
Every cost term is non-negative and monotone in distance, so $h$ is admissible *and*
consistent — plain A\* at weight 1 is therefore provably optimal, which makes it a valid
reference point.

Weights are editable in the sidebar; changing them re-costs the network **without**
changing its topology, so the route geometry stays comparable.

---

## Data model

**Graph** — flat typed arrays, no per-node objects, so the inner search loops stay cache
friendly:

```
nodes : x[], y[], elevation[]
edges : edgeFrom[], edgeTo[], edgeLength[], edgeSpeedLimit[],
        edgeTraffic[] (speed multiplier 0.12 … 1.0), edgeClosed[] (0/1),
        edgeClass[], edgeDirected[] (1 = one-way)
CSR   : arcCount, adjStart[n+1], adjTail[], adjNeighbor[], adjEdge[], arcTwin[],
        revStart[n+1], revArc[]
```

Most roads are two-way: one road record produces two directed *arcs*, because cost is
direction dependent (climbing is not the same as descending). A **one-way** road (common in
real city maps) is flagged with `edgeDirected` and produces a single arc, so it is only
drivable in the `from → to` direction — `arcCount` is therefore `2·E − one-way edges`.
`arcTwin[a]` gives the opposite arc, or `-1` for a one-way road.

**Test case** (`{ graph, costModel, start, goal, meta }`) is built once per benchmark and
handed to every algorithm by reference. That single object is the definition of fairness.

---

## Benchmarking methodology

| Step | What happens |
|---|---|
| 1 | The scenario is expanded into **one frozen test case**: network, elevation, traffic, closures, origin, destination. Built once, shared by reference. |
| 2 | `prepare()` runs for each algorithm and is **timed separately** → reported as *Prep (ms)*. |
| 3 | **Warm-up runs** (default 3) are executed and discarded so the JIT has settled. |
| 4 | **N measured repetitions** (default 7). The execution order is **reversed on every other repetition** so a systematic first-run penalty cannot appear. |
| 5 | Only `solve()` is wrapped in `performance.now()`. Progress-bar updates and repaints happen outside the timed region. |
| 6 | The **harness** re-walks each returned path arc by arc, verifies that it is contiguous, that every arc exists, and that no closed road is used — then computes distance, cost and travel time. Identical accounting for everyone. |
| 7 | Statistics are aggregated: count, **average, fastest, slowest, median, std-dev** for time; averages for explored / expanded / arcs relaxed / path cost / distance. |
| 8 | Everything is expressed as a delta against **A\***: % change plus a speed-up factor. |

### Reproducibility

Every stage gets its own seed derived from the scenario seed
(`seed+1` network, `+2` elevation, `+3` traffic, `+4` closures, `+5` endpoints). Changing
one condition therefore leaves the others untouched, and any scenario can be replayed
exactly. Heaps break ties by insertion order, so both algorithms are fully deterministic.

---

## Test scenarios

Scenarios 1–5 share the **same** seeded 6 045-node road network, so only the operating
condition changes — a controlled experiment.

| # | Scenario | Network | Traffic | Elevation | Closures |
|---|---|---|---|---|---|
| 1 | Normal road conditions | grid 6 045 | 5 % | ±25 m | 0 |
| 2 | Heavy traffic | grid 6 045 | 85 % (+5 hotspots) | ±25 m | 0 |
| 3 | Significant elevation changes | grid 6 045 | 10 % | ±130 m | 0 |
| 4 | Multiple road closures | grid 6 045 | 15 % | ±30 m | 60 |
| 5 | Traffic + elevation + closures | grid 6 045 | 80 % (+4 hotspots) | ±110 m | 50 |
| 6 | Large / complex network | irregular 12 000 | 40 % | ±80 m | 40 |
| 7 | **Your city map** | imported | 35 % | ±60 m *or from file* | 0.3 % of roads |

Why 6 000 nodes? Below roughly that size an A\* search finishes in a fraction of a
millisecond, where browser timer resolution and JIT noise swamp the real difference. The
sidebar's **Custom scenario** panel lets you pick any size, topology, condition mix and
seed.

### What the custom-scenario inputs do

| Input | Effect |
|---|---|
| **Network type** | *Grid* = jittered city blocks. *Random* = irregular layout from Poisson-style sampling with k-nearest links |
| **Nodes** | Target node count. The grid is sized to the closest rows × columns, so you get roughly this many |
| **Elevation (m)** | Peak-to-peak terrain range, from smooth gaussian hills plus a linear trend |
| **Traffic (%)** | Congestion level, plus congestion hotspots that model busy collection zones |
| **Closed roads** | How many roads become unavailable. Weighted towards minor streets; capped at 25 % of all roads |
| **Seed** | Replays the same network and conditions exactly |

Two shape parameters are **fixed at their defaults and no longer exposed**, because both
looked like they did something they did not:

* **Arterials** (`arterialRatio`, 0.2). Sorts roads by length and promotes the longest 20 %
  to 60 km/h arterials. It changes **cost only, never topology** — 11 271 roads at 0 % and at
  50 % alike. It is a meaningful trade-off knob (at 0 % every road is the same speed, so the
  shortest route always wins and no algorithm can distinguish itself), but it sat next to
  four things that *do* change the network, which made it look like a fifth.
* **Extra links** (`extraEdgeRatio`, 0.1). Read as "add this % more roads"; on an already
  well-connected grid it changed the road count by ~0.3 % (10 % asked for, +35 roads out of
  11 271). Misleading, so the control is gone.

Both are still applied — change them in `js/data/scenarios.js`
(`CUSTOM_SCENARIO_DEFAULTS`) if you want to experiment.

Scenario 7 only appears once you load a map (see *Using your own city map*). Its final
node/edge counts, one-way count, whether elevations came from the file, and every
connection or speed warning are reported in the panel and repeated in the verdict line
above the canvases. Its default is **15 repetitions** rather than 7, because a real city
extract is usually only a few thousand roads — small enough that a single run is
dominated by timer noise.

---

## Collection rounds — many pickup points, one preprocessing pass

Switch **Route mode** to *Collection round* and the truck leaves a depot, visits N pickup
points in one sector sweep, and returns. Every algorithm gets the **same depot, the same
stops and the same order**, so this measures pathfinding, not tour planning.

### Does adding pickup points create an advantage on its own? No.

Round size, scenario 1, preprocessing paid every round:

| stops | legs | A\* prep+solve | Dynamic A\* prep+solve | ALT prep+solve |
|---|---|---|---|---|
| 1 | 2 | 0.25 ms | 0.21 ms | 5.05 ms |
| 3 | 4 | 1.98 ms | 1.93 ms | 6.06 ms |
| 6 | 7 | 2.18 ms | 2.34 ms | 5.96 ms |
| 12 | 13 | 2.83 ms | 3.21 ms | 7.40 ms |
| 25 | 26 | 4.27 ms | 4.39 ms | 10.90 ms |

An algorithm with an empty `prepare()` does the same work per leg no matter how long the
round is, so its ratio to A\* does not move. Adding stops changes nothing for it.

### What does create an advantage: paying once and reusing

Landmark tables depend on the **network**, not on the round. A depot builds them once and
every truck, every round, reuses them. Measured with the minimum estimator (noise only ever
adds time, so the best run is the closest estimate):

| Landmarks | Prep ms | Round solve ms | Prep + solve | Nodes expanded |
|---|---|---|---|---|
| 1 | 1.00 | 1.55 | **2.55** | 5 417 |
| 2 | 2.39 | 1.79 | 4.17 | 4 744 |
| 3 | 3.85 | 1.57 | 5.42 | 2 695 |
| 4 | 4.70 | 1.27 | 5.97 | 1 914 |
| 8 | 10.75 | 1.28 | 12.04 | 1 173 |

More landmarks shrink the search but grow the prep, and for a *single* round the prep
never wins. Once reused:

```
  one-off preprocessing: 4.90 ms
  A*  per round: 2.08 ms   (no prep)
  ALT per round: 1.30 ms   (tables reused)
  break-even:    6.3 rounds (82 legs)

  rounds   legs   A* cum.   ALT cum.   saved   winner
       1     13      2.08       6.20   -4.12   A*
       5     65     10.39      11.41   -1.02   A*
       8    104     16.62      15.31    1.31   ALT
      20    260     41.55      30.93   10.63   ALT
```

**This is the shape of a real advantage.** A single truck making 12 stops cannot amortise
preprocessing — 82 legs is roughly six rounds, i.e. a small fleet or a few days. Beyond
that the gap keeps widening, because the prep is already paid.

The lesson for a custom solid-waste algorithm: the factors that make collection routing hard
— traffic, elevation, closures — live in the **cost model**, which both algorithms read, so
they cannot be an advantage on their own. An advantage comes from buying something once and
reusing it across many legs. `prepare()` is where that happens, and it is not timed.

---

## Reading the results

* **Aggregate** — one row per algorithm: average / fastest / slowest / median / std-dev
  time, average nodes explored / expanded / arcs relaxed, average path cost, distance,
  travel time and preprocessing cost. Best time and fewest expansions are highlighted.
* **Compared with standard A\*** — % change in each metric plus a speed-up factor.
  `identical` / `cheaper` / `longer` describes the route itself.
* **Per-run detail** — the raw numbers behind the averages, useful for spotting outliers.
* **The verdict line** restates everything in plain language.

A route marked *cheaper* than A\* means the other algorithm returned a lower-cost path
than the provably optimal baseline — that only happens when optimality is deliberately
traded away (e.g. weighted A\*, or a heuristic that overestimates).

### What the canvas shows

| Layer | Meaning |
|---|---|
| Road lines | traffic level — green (free) → amber → red (congested); roads are colour-binned so huge networks still render in one pass |
| Dashed dark-red lines | closed roads |
| Node dots | elevation ramp — blue (low) → green → brown → white (high) |
| Translucent circles | nodes expanded by each algorithm, in that algorithm's colour |
| Route lines | custom = cyan, A\* = magenta, drawn with a halo so overlapping routes read as a two-tone line |
| `S` / `G` | origin and destination |

The **View** selector switches between overlay, custom-only, A\*-only and side-by-side.
Individual layers can be toggled off in the toolbar.

---

## Slow-motion playback

The bar under the toolbar replays a finished run instead of just showing its end state.

```
progress 0 ────────────── 0.8 ────────────── 1
         │  search phase   │  route phase   │
         │  expanded nodes │  route drawn   │
         │  appear one by  │  vertex by     │
         │  one            │  vertex        │
```

* **Speed** is in *expanded nodes per second*, from 25 (watch individual frontier growth)
  to 8 000 (instant). 200 is the default.
* Press **Play** to start; it becomes **Pause** while running and **Replay** at the end.
* Grab the **scrubber** to jump anywhere — this pauses the animation so it cannot fight you.
* Each algorithm reveals its **own** expansion list against the same clock, so both searches
  finish together at the 0.8 mark no matter how many nodes each needed. That is the
  comparison worth watching: A\*'s cloud keeps growing long after the custom algorithm's
  has stopped.

**Animating cannot affect the measurements.** The algorithms are not re-run — the playback
is a redraw of the traversal traces already returned by `solve()`. The benchmark itself
has finished by the time anything moves.

### Seeing the search clearly

Expanded nodes are drawn in **three tiers**, which is what makes the search readable:

| Tier | Appearance | What it tells you |
|---|---|---|
| Settled cloud | broad, faint dots | everywhere the search has already closed |
| Wavefront | bright dots, last 90 expansions | where the frontier is pushing right now |
| Head | ringed marker | the exact node expanded most recently — follow this |

The tiering only appears while a search is **running**. Once it completes, the cloud is
drawn uniformly, so the finished view stays clean.

While a search is running the road network is **dimmed to 22 %**, so the coloured cloud is
the brightest thing on screen instead of competing with 11 000 roads. It comes back to full
opacity during the route phase.

### Zoom and pan

| Gesture | Action |
|---|---|
| Scroll | Zoom about the cursor |
| Drag | Pan |
| Double-click a canvas | Reset to fit |
| **Reset view** button | Reset every canvas to fit |

Zoom is mirrored across all canvases, so side-by-side and overlay views always show the
same patch of road. It is essential on a dense network: 6 045 nodes across 700 px puts
every node well under one pixel, and no amount of colour will make that legible.

The road network is painted once into an offscreen canvas and blitted each frame, so only
nodes and route lines are redrawn. Without that, an 11 000-road network would be re-stroked
60 times a second.

---

## Extending

**Add another algorithm** — create `js/algorithms/yourAlgo.js` exporting the contract
above, then in `main.js`:

```js
import { yourAlgo } from './algorithms/yourAlgo.js';
registerAlgorithm(yourAlgo);
```

It immediately appears in the tables, gets its own canvas colour and is compared against
A\*. `astar.js` is never touched.

**Add another scenario** — append an entry to `js/data/scenarios.js`; the dropdown, the
sizing, the seeds and the aggregation all pick it up automatically.

**Change the generator** — `js/data/networkGenerator.js` is where topology, topography,
traffic and closure models live.

---

## Limitations (worth knowing)

* **Main-thread timing.** Benchmarks run on the UI thread. Only `solve()` is timed, but a
  browser is not a laboratory — treat differences under ~5 % as noise and raise the
  repetition count.
* **`exploredNodes` costs something.** Both implementations collect a traversal trace for
  the visualisation; the overhead is identical for both, but remove that field from the
  returned object if you want the leanest possible timing.
* **Traffic is synthetic, always.** Neither the generator nor the importer has real
  congestion data. Both algorithms see identical traffic, so the comparison stays valid,
  but absolute travel times are not predictions.
* **Terrain is synthetic unless your file has elevation.** For imported maps, check the
  status line — it says which one you got.
* **Imported maps are benchmarked, not validated.** A malformed OSM extract will still
  produce *some* graph. The importer reports excluded footways, duplicate segments,
  disconnected components and missing speeds so you can judge the input quality, but it is
  not a topology validator.
* **Very large maps cost render time.** Tens of thousands of roads are fine (roads are
  colour-binned into ~10 strokes), but every canvas redraw re-walks the whole edge list, so
  a 300 000-road extract will feel sluggish when you resize the window.
* **One origin/destination pair per scenario.** Re-running with a different seed gives a
  different pair if you want a broader sample.
