// Turns a raw OSRM route + the OSM green layer into the numbers the UI compares.

import {
  GREEN_BUFFER_M,
  TREE_BUFFER_M,
  SAMPLE_SPACING_M,
  MODES,
  TRANSIT_CO2_PER_KM,
} from './config.js';
import { samplePath, haversine, pointSegmentDistance } from './geo.js';
import { insideGreen } from './greenspace.js';

// Roads we would rather not walk, bike, or sit in traffic beside. OSRM step
// names carry a `ref` (I-45, US-59, TX-288) for exactly the roads that hurt.
const BIG_ROAD_REF = /^(I-|US-|TX-|SH-|FM-|BW-|Sam Houston|Hardy Toll|Westpark Toll)/i;
const BIG_ROAD_NAME =
  /(Freeway|Fwy|Tollway|Toll Rd|Interstate|Expressway|Expwy|Parkway Feeder|Feeder)/i;

/** Fraction of route samples that are inside or beside green space. */
function greenMetrics(samples, layer) {
  const { proj, polygons, canopyPolygons, greenIndex, treeIndex } = layer;
  let greenHits = 0;
  let treeHits = 0;

  for (const p of samples) {
    const xy = proj.toXY(p);

    let green = insideGreen(xy, polygons);
    if (!green) {
      for (const seg of greenIndex.near(xy)) {
        if (pointSegmentDistance(xy, seg.a, seg.b) <= GREEN_BUFFER_M) {
          green = true;
          break;
        }
      }
    }
    if (green) greenHits++;

    let shaded = insideGreen(xy, canopyPolygons);
    if (!shaded) {
      for (const t of treeIndex.near(xy)) {
        const d = t.b
          ? pointSegmentDistance(xy, t.a, t.b)
          : Math.hypot(xy[0] - t.a[0], xy[1] - t.a[1]);
        if (d <= TREE_BUFFER_M) {
          shaded = true;
          break;
        }
      }
    }
    if (shaded) treeHits++;
  }

  const n = Math.max(1, samples.length);
  return { greenShare: greenHits / n, shadeShare: treeHits / n };
}

/** Share of route distance spent on freeways and major arterials. */
function bigRoadShare(route) {
  let big = 0;
  let known = 0;
  let turns = 0;

  for (const leg of route.legs) {
    for (const step of leg.steps || []) {
      const dist = step.distance || 0;
      known += dist;
      const ref = step.ref || '';
      const name = step.name || '';
      if (BIG_ROAD_REF.test(ref) || BIG_ROAD_NAME.test(name)) big += dist;
      const type = step.maneuver?.type;
      if (type && !['depart', 'arrive', 'continue'].includes(type)) turns++;
    }
  }

  return {
    bigRoadShare: known > 0 ? big / known : 0,
    turns,
    turnsPerKm: route.distance > 0 ? turns / (route.distance / 1000) : 0,
  };
}

function normalise(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || max - min < 1e-9) return values.map(() => 1);
  return values.map((v) => (v - min) / (max - min));
}

/**
 * Score every candidate route. Absolute metrics are computed per route;
 * the composite score is normalised across the candidate set so the cards
 * always answer "which of these is nicest", not "is this nice in the abstract".
 */
export function scoreRoutes(routes, layer, mode, weights) {
  const modeCfg = MODES[mode];

  const enriched = routes.map((route) => {
    const samples = samplePath(route.points, SAMPLE_SPACING_M);
    const green = layer ? greenMetrics(samples, layer) : { greenShare: 0, shadeShare: 0 };
    const roads = bigRoadShare(route);
    const km = route.distance / 1000;
    const minutes = route.duration / 60;

    // Unshaded minutes outdoors — the number that matters for a June
    // World Cup in Houston, where afternoon heat index runs past 105F.
    const exposedMinutes = modeCfg.heatExposed ? minutes * (1 - green.shadeShare) : 0;

    return {
      ...route,
      samples,
      metrics: {
        km,
        minutes,
        greenShare: green.greenShare,
        shadeShare: green.shadeShare,
        bigRoadShare: roads.bigRoadShare,
        turns: roads.turns,
        turnsPerKm: roads.turnsPerKm,
        exposedMinutes,
        co2Kg: (km * modeCfg.co2PerKm) / 1000,
        co2SavedVsDrivingKg: (km * (MODES.car.co2PerKm - modeCfg.co2PerKm)) / 1000,
        transitCo2Kg: (km * TRANSIT_CO2_PER_KM) / 1000,
        kcal: km * modeCfg.kcalPerKm,
        cost: km * modeCfg.costPerKm,
      },
    };
  });

  const shortest = Math.min(...enriched.map((r) => r.distance));

  const greenN = normalise(enriched.map((r) => r.metrics.greenShare));
  const shadeN = normalise(enriched.map((r) => r.metrics.shadeShare));
  const quietN = normalise(enriched.map((r) => -r.metrics.bigRoadShare));
  const directN = normalise(
    enriched.map((r) => -(r.distance / shortest - 1) * 4 - r.metrics.turnsPerKm / 6),
  );

  enriched.forEach((route, i) => {
    route.components = {
      green: greenN[i],
      shade: shadeN[i],
      quiet: quietN[i],
      direct: directN[i],
    };
    route.pleasantness =
      100 *
      (weights.green * greenN[i] +
        weights.shade * shadeN[i] +
        weights.quiet * quietN[i] +
        weights.direct * directN[i]);
    route.metrics.detourPct = (route.distance / shortest - 1) * 100;
  });

  return enriched;
}

/** Label the standouts: fastest, shortest, greenest, coolest, best overall. */
export function assignBadges(routes) {
  const best = (fn) => routes.reduce((a, b) => (fn(b) > fn(a) ? b : a));
  const worst = (fn) => routes.reduce((a, b) => (fn(b) < fn(a) ? b : a));

  routes.forEach((r) => (r.badges = []));
  worst((r) => r.duration).badges.push({ key: 'fastest', label: 'Fastest' });
  worst((r) => r.distance).badges.push({ key: 'shortest', label: 'Shortest' });
  best((r) => r.pleasantness).badges.push({ key: 'pleasant', label: 'Most pleasant' });
  best((r) => r.metrics.greenShare).badges.push({ key: 'green', label: 'Greenest' });
  best((r) => r.metrics.shadeShare).badges.push({ key: 'shade', label: 'Most shaded' });
  return routes;
}

export function formatDuration(seconds) {
  const total = Math.round(seconds / 60);
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')} min`;
}

export function formatDistance(metres) {
  const miles = metres / 1609.34;
  return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
}

export { haversine };
