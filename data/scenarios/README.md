# Fleet scenario config

Every fleet simulation is defined by one JSON file. Nothing is hard-coded: map, depot,
bins, trucks and events all come from here. `sample-fleet.json` is a complete, working
example. It is the one `fleet.html` and `npm run fleet` load by default.

```jsonc
{
  "name": "My scenario",
  "description": "shown in the UI",
  "seed": 42,                       // drives random bins / random events (reproducible)

  "map": { ... },                   // see "Map" below
  "depot": "A1",                    // node reference
  "disposal": "H1",                 // optional, defaults to the depot

  "settings": {                     // all optional (defaults shown)
    "heuristic": "euclidean",       // or "manhattan" (admissible only on axis-aligned grids)
    "service_time_s": 60,           // time to empty one bin (a bin may override)
    "unload_time_s": 300,           // time to unload at the disposal site
    "dt_s": 1,                      // simulation tick
    "max_time_s": 21600,            // hard stop
    "bin_capacity_kg": 120,         // load of a 100 %-full bin
    "fill_thresholds": { "medium": 40, "high": 75 },  // green < 40 ≤ yellow < 75 ≤ red
    "visit_order": "nearest",       // "nearest" (greedy) or "given" (config order)
    "return_to_depot": true
  },

  "trucks": [
    { "id": "T1", "name": "Truck 1", "start": "A1", "speed_kph": 25,
      "max_capacity": 1000, "current_load": 0, "color": "#38bdf8" }
  ],

  "bins": [
    { "id": "B1", "node": "B2", "fill": 90, "capacity_kg": 120, "truck": "T1",
      "service_time_s": 60 }
    // "truck" is optional. Bins without one are auto-assigned to the truck with the
    // lowest ETA that has enough free capacity.
  ],
  // or the real stops from an EcoLoop export (collection_schedules or bins table, CSV):
  //   "bins": { "csv": "data/collection_schedules.csv", "day": "Mon", "areas": ["AREA-1"],
  //             "stop_types": ["collection"], "max_snap_m": 300, "fill": [30, 100], "assign_by_area": true }
  //   Stops are placed at their latitude/longitude (imported maps only). A truck with
  //   "areas": ["AREA-1"] collects that area's stops. Every skipped row is counted by reason.
  // or random placement:  "bins": { "random": { "count": 15, "fill": [10, 100], "seed": 7 } }

  "events": {
    "scheduled": [
      { "time_s": 600,  "type": "ROAD_CLOSURE",  "edge": "E3-F3", "duration_s": 900, "note": "..." },
      { "time_s": 1500, "type": "ROAD_REOPEN",   "edge": "E3-F3" },
      { "time_s": 900,  "type": "TRAFFIC_DELAY", "edge": "G1-H1", "factor": 3, "duration_s": 600 }
    ],
    "random": {
      "enabled": true, "seed": 7, "count": 3, "window_s": [300, 1800],
      "types": { "TRAFFIC_DELAY": 0.7, "ROAD_CLOSURE": 0.3 },
      "closure_duration_s": [300, 1200],
      "delay_factor": [1.5, 3], "delay_duration_s": [300, 900]
    }
  }
}
```

`duration_s` is optional. On a closure it schedules the matching `ROAD_REOPEN`, and on a
delay it schedules the "delay cleared" event.

## Map

| `map.type` | Fields | Node references | Edge references |
|---|---|---|---|
| `explicit` | `nodes: [{id,x,y}]` (metres), `edges: [{from,to,id?,length?,oneway?}]` | node id `"C3"` | `"C3-D3"` (either direction) or the edge `id` |
| `generated` | `network: {type:"grid"\|"random", targetNodes, width, height}` | index `42` or `{"at":[fx,fy]}` | index `17` or `{"from":12,"to":13}` |
| `geojson` | `path: "data/Naga_City_roads.geojson"` (GeoJSON / Overpass / CSV) | same as generated | same as generated |

`test_areas` (optional, imported maps) fills the fleet page's *Testing area* list: `schedule` = a collection-schedule CSV (one area per `area_code`), `boundaries` = a GeoJSON of polygons with `kind` (`city`, `district` or `barangay`) and `name`.

On imported maps a node can also be given as `{"lat": 13.6218, "lng": 123.1948}` (nearest node), and the depot / disposal may carry a `"name"` shown on the map.

Places outside the road file can be linked with `map.connectors`: `[{ "to": [lng, lat], "name": "...", "maxspeed": 40 }]` adds one straight road from the nearest mapped road vertex to that point. Its length is the straight-line distance, so it is shorter than the real road; mention this wherever distances are reported.

`{"at": [0.5, 0.5]}` means "the node nearest to the middle of the map". The fractions are
of the bounding box, so (0,0) is bottom-left and (1,1) is top-right. On imported maps
only the largest connected component is used.

If a config is invalid, loading fails with one error that lists every problem.

## Real-life incidents

Besides `ROAD_CLOSURE`, `ROAD_REOPEN` and `TRAFFIC_DELAY`, `events.scheduled[].type` and the
keys of `events.random.types` accept these incidents (defined in `js/sim/events/incidents.js`):

| Group | Type | What happens |
|---|---|---|
| road | `ROAD_ACCIDENT` | road closed 10–30 min |
| road | `FLOODED_ROAD` | road closed 30–90 min |
| road | `STALLED_VEHICLE` | road closed 5–15 min |
| road | `PROCESSION` | road closed 15–45 min (fiesta / procession) |
| road | `ROAD_WORKS` | road 1.8–3× slower for 30–120 min |
| road | `HEAVY_TRAFFIC` | road 1.5–3× slower for 5–20 min |
| road | `HEAVY_RAIN` | road 1.3–1.8× slower for 15–45 min |
| bin | `BIN_MISSING` | bin is gone: skipped, counted as missed |
| bin | `BIN_BLOCKED` | parked vehicle: +5–15 min at the stop |
| bin | `BIN_DAMAGED` | loaded by hand: +3–8 min at the stop |
| bin | `BIN_OVERFLOW` | 1.3–1.8× heavier, +2–5 min at the stop |
| truck | `TRUCK_BREAKDOWN` | truck stands still 15–40 min |
| truck | `FLAT_TIRE` | truck stands still 10–20 min |

**Every random event happens near the trucks.** Its road, bin or truck is chosen at the moment it
happens: a road a working truck is about to drive, a bin among a working truck's next stops, or
a truck that is out working. Scheduled incidents work the same way unless they name an `edge`
(road incidents), a `bin` or a `truck`. Optional overrides: `duration_s`, `factor`, `extra_s`.

```json
{ "type": "FLOODED_ROAD", "time_s": 900, "note": "low road under water" }
{ "type": "FLAT_TIRE", "time_s": 2100, "truck": "TRK-03" }
```

Scenarios: `naga-rainy-day.json` (floods, rain, accidents, flat tires, overflowing bins) and
`naga-busy-day.json` (fiesta processions, road works, blocked / overflowing / missing bins).

## Full trucks (`settings.full_truck`)

When the next bin would not fit, a truck with `areas` drives to the landfill, unloads and comes
back to finish its own area (`"return"`, how SWMO area trucks work). A truck without an area hands
its remaining bins to other trucks with room (`"handoff"`). Set `"full_truck": "return"` or
`"handoff"` in `settings` to force one behaviour for every truck. The route-end ETA includes
those landfill trips and any extra minutes at problem bins, so with no unforeseen events it
matches the real finish to within a second.
