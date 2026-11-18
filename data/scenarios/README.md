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

On imported maps a node can also be given as `{"lat": 13.6218, "lng": 123.1948}` (nearest node), and the depot / disposal may carry a `"name"` shown on the map.

Places outside the road file can be linked with `map.connectors`: `[{ "to": [lng, lat], "name": "...", "maxspeed": 40 }]` adds one straight road from the nearest mapped road vertex to that point. Its length is the straight-line distance, so it is shorter than the real road; mention this wherever distances are reported.

`{"at": [0.5, 0.5]}` means "the node nearest to the middle of the map". The fractions are
of the bounding box, so (0,0) is bottom-left and (1,1) is top-right. On imported maps
only the largest connected component is used.

If a config is invalid, loading fails with one error that lists every problem.
