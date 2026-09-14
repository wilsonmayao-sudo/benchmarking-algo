/**
 * Predefined test scenarios for solid-waste-collection routing.
 *
 * Scenarios 1–5 deliberately share the SAME seeded road network (identical layout,
 * road classes, topology). Only the operating conditions change, so each scenario
 * isolates one factor. Scenario 6 swaps in a larger, irregular network.
 *
 * Sizing note: the base network is deliberately ~6 000 nodes. Below roughly that size
 * an A* search finishes in a fraction of a millisecond, where browser timer resolution
 * and JIT warm-up noise swamp the real difference between the algorithms.
 */

/** The shared base network used by scenarios 1–5. */
const BASE_NETWORK = {
  type: 'grid',
  targetNodes: 6000,
  width: 6000,
  height: 4200,
  arterialRatio: 0.2,
  extraEdgeRatio: 0.1,
  jitter: 0.26,
  linkProbability: 0.88,
};

/** The shared base seed for scenarios 1–5. */
const BASE_SEED = 20260913;

export const SCENARIOS = [
  {
    id: 'normal',
    name: '1 · Normal road conditions',
    description:
      'Free-flowing traffic, gentle topography (±25 m), no closed roads. The reference case.',
    seed: BASE_SEED,
    repeat: 7,
    network: { ...BASE_NETWORK },
    elevation: { amplitude: 25, hills: 4, trend: 0.35 },
    traffic: { level: 0.05, hotspots: 2, radius: 0.22 },
    closures: { count: 0 },
  },
  {
    id: 'heavy-traffic',
    name: '2 · Heavy traffic',
    description:
      'Congested network (85 % slowdown) with five urban congestion hotspots. Elevation and closures unchanged.',
    seed: BASE_SEED,
    repeat: 7,
    network: { ...BASE_NETWORK },
    elevation: { amplitude: 25, hills: 4, trend: 0.35 },
    traffic: { level: 0.85, hotspots: 5, radius: 0.28 },
    closures: { count: 0 },
  },
  {
    id: 'elevation',
    name: '3 · Significant elevation changes',
    description:
      'Steep terrain (±130 m, six hills) where climbing dominates the cost. Light traffic, no closures.',
    seed: BASE_SEED,
    repeat: 7,
    network: { ...BASE_NETWORK },
    elevation: { amplitude: 130, hills: 6, trend: 0.6 },
    traffic: { level: 0.1, hotspots: 2, radius: 0.22 },
    closures: { count: 0 },
  },
  {
    id: 'closures',
    name: '4 · Multiple road closures',
    description:
      '60 closed roads force detours. Light traffic and moderate topography so closures are the dominant factor.',
    seed: BASE_SEED,
    repeat: 7,
    network: { ...BASE_NETWORK },
    elevation: { amplitude: 30, hills: 4, trend: 0.35 },
    traffic: { level: 0.15, hotspots: 2, radius: 0.22 },
    closures: { count: 60, maxFraction: 0.25 },
  },
  {
    id: 'combined',
    name: '5 · Traffic + elevation + closures',
    description:
      'Everything at once: 80 % congestion, ±110 m of relief and 50 closed roads. The realistic worst case.',
    seed: BASE_SEED,
    repeat: 7,
    network: { ...BASE_NETWORK },
    elevation: { amplitude: 110, hills: 5, trend: 0.5 },
    traffic: { level: 0.8, hotspots: 4, radius: 0.3 },
    closures: { count: 50, maxFraction: 0.25 },
  },
  {
    id: 'large',
    name: '6 · Large / complex road network',
    description:
      'Irregular 12 000-node network with a long start→destination pair, moderate congestion, ±80 m terrain and 40 closures.',
    seed: 777,
    repeat: 5,
    network: {
      type: 'random',
      targetNodes: 12000,
      width: 12000,
      height: 8400,
      arterialRatio: 0.22,
      extraEdgeRatio: 0.12,
    },
    elevation: { amplitude: 80, hills: 7, trend: 0.45 },
    traffic: { level: 0.4, hotspots: 5, radius: 0.25 },
    closures: { count: 40, maxFraction: 0.25 },
  },
];

/** Default configuration backing the "custom scenario" panel. */
export const CUSTOM_SCENARIO_DEFAULTS = {
  type: 'grid',
  targetNodes: 4000,
  // Not exposed in the UI either: it changes road costs but never the topology, so the
  // panel keeps it at the same fixed default as the links parameter.
  arterialRatio: 0.2,
  // Not exposed in the UI: the control read as "add this % more roads" but on an already
  // well-connected grid it changes the road count by ~0.3 %, which is misleading. The
  // generator still uses it, fixed at this default.
  extraEdgeRatio: 0.1,
  elevationAmplitude: 60,
  trafficLevel: 0.4,
  closures: 25,
  seed: BASE_SEED,
  repeat: 7,
};

/**
 * Condition defaults applied right after a city map is imported.
 *
 * `repeat` is higher than for the generated scenarios on purpose: a real city extract is
 * usually only a few thousand roads, where a search finishes in a fraction of a
 * millisecond and single runs are dominated by timer noise. Repetitions are cheap here,
 * so buy statistical stability instead.
 */
export const CITY_MAP_SCENARIO_DEFAULTS = {
  trafficLevel: 0.35,
  elevationAmplitude: 60,
  closureShare: 0.003,
  seed: 424242,
  repeat: 15,
};

/** The scenario id used for an imported city map, so conditions can be re-applied to it. */
export const CITY_MAP_SCENARIO_ID = 'city-map';

/**
 * Scenario built around an imported city map. Traffic and closures are still generated
 * by the scenario (a static map export carries no traffic data); elevations come from
 * the file when it has them.
 *
 * @param {object} map parsed by `cityMapLoader.parseCityMap()`
 * @param {object} [overrides] overrides for `CITY_MAP_SCENARIO_DEFAULTS`
 */
export function scenarioFromCityMap(map, overrides = {}) {
  const d = { ...CITY_MAP_SCENARIO_DEFAULTS, ...overrides };
  const closures = overrides.closures !== undefined
    ? overrides.closures
    : Math.min(80, Math.round(map.edgeCount * (overrides.closureShare ?? d.closureShare)));

  return {
    id: CITY_MAP_SCENARIO_ID,
    name: `7 · ${map.name}`,
    description: cityMapDescription(map, d.trafficLevel, closures, d.seed),
    seed: d.seed,
    repeat: d.repeat,
    cityMap: map,
    elevation: { amplitude: d.elevationAmplitude, hills: 5, trend: 0.4 },
    traffic: { level: d.trafficLevel, hotspots: 4, radius: 0.25 },
    closures: { count: closures, maxFraction: 0.25 },
  };
}

function cityMapDescription(map, trafficLevel, closures, seed) {
  return (
    `Imported ${map.source} road network · ${map.nodeCount.toLocaleString('en-US')} nodes, ` +
    `${map.edgeCount.toLocaleString('en-US')} roads` +
    (map.stats && map.stats.oneway ? ` (${map.stats.oneway} one-way)` : '') +
    ` · ${map.hasElevation ? 'elevations from the file' : 'synthetic terrain'}` +
    ` · ${Math.round(trafficLevel * 100)} % congestion · ${closures} closed roads · seed ${seed}`
  );
}

/**
 * Turn the values of the custom scenario panel into a scenario object that the
 * test-case builder understands.
 *
 * When a city map is loaded, the panel's traffic / elevation / closure values are
 * applied to that map instead of generating a new network.
 *
 * @param {object} config
 * @param {object|null} [cityMap]
 */
export function scenarioFromCustom(config, cityMap = null) {
  const c = { ...CUSTOM_SCENARIO_DEFAULTS, ...config };

  if (cityMap) {
    return scenarioFromCityMap(cityMap, {
      trafficLevel: c.trafficLevel,
      elevationAmplitude: c.elevationAmplitude,
      closures: c.closures,
      seed: c.seed,
      repeat: c.repeat,
    });
  }

  return {
    id: 'custom',
    name: 'Custom scenario',
    description:
      `${c.type === 'random' ? 'Irregular' : 'Grid'} network · ${c.targetNodes} nodes · ` +
      `${Math.round(c.trafficLevel * 100)} % congestion · ±${c.elevationAmplitude} m terrain · ` +
      `${c.closures} closed roads · seed ${c.seed}`,
    seed: c.seed,
    repeat: c.repeat,
    network: {
      type: c.type,
      targetNodes: c.targetNodes,
      width: 6000,
      height: 4200,
      arterialRatio: c.arterialRatio,
      extraEdgeRatio: c.extraEdgeRatio,
    },
    elevation: { amplitude: c.elevationAmplitude, hills: 5, trend: 0.4 },
    traffic: { level: c.trafficLevel, hotspots: 4, radius: 0.25 },
    closures: { count: c.closures, maxFraction: 0.25 },
  };
}
