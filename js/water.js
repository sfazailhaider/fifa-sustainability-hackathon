// Where you can refill a bottle along a route.
//
// In a Houston June the useful question is not "how many fountains exist" but
// "how far will I walk before the next one" — so this reports the stops in
// order with their distance along the route, and the longest dry stretch,
// including the gaps at either end.

import { haversine, projector, pointSegmentDistance } from './geo.js';

/** Metres from the route a fountain can be and still count as "on the way". */
export const WATER_BUFFER_M = 120;

/**
 * Match water points to a route.
 * Returns { stops, longestDryM, coverage } where each stop carries how far
 * along the route it sits and how far off the line it is.
 */
export function waterAlongRoute(points, water, buffer = WATER_BUFFER_M) {
  if (!water?.length || points.length < 2) {
    return { stops: [], longestDryM: totalLength(points), coverage: 0 };
  }

  const proj = projector(points[0][0]);
  const xy = points.map(proj.toXY);

  // Cumulative distance to each vertex, so a match can report its position
  // along the route rather than just "somewhere near".
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative[i] = cumulative[i - 1] + haversine(points[i - 1], points[i]);
  }
  const total = cumulative[cumulative.length - 1];

  const stops = [];
  for (const point of water) {
    const p = proj.toXY(point.coord);

    let bestDistance = Infinity;
    let bestSegment = 0;
    for (let i = 1; i < xy.length; i++) {
      const d = pointSegmentDistance(p, xy[i - 1], xy[i]);
      if (d < bestDistance) {
        bestDistance = d;
        bestSegment = i;
      }
    }

    if (bestDistance > buffer) continue;

    stops.push({
      ...point,
      offRouteM: bestDistance,
      // Good enough: the nearest vertex, not the exact projection onto it.
      distanceFromStart: cumulative[bestSegment - 1],
    });
  }

  stops.sort((a, b) => a.distanceFromStart - b.distanceFromStart);

  // Drop near-duplicates: a park often maps several fountains a few metres apart.
  const deduped = stops.filter(
    (stop, i) => i === 0 || stop.distanceFromStart - stops[i - 1].distanceFromStart > 40,
  );

  let longestDryM = 0;
  let previous = 0;
  for (const stop of deduped) {
    longestDryM = Math.max(longestDryM, stop.distanceFromStart - previous);
    previous = stop.distanceFromStart;
  }
  longestDryM = Math.max(longestDryM, total - previous);

  return {
    stops: deduped,
    longestDryM,
    // Share of the route within reach of a refill, at 400 m either side.
    coverage: total > 0 ? Math.min(1, (deduped.length * 800) / total) : 0,
  };
}

function totalLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversine(points[i - 1], points[i]);
  return total;
}

/** Attach each stop to the turn-by-turn step it sits closest to. */
export function assignStopsToSteps(stops, steps) {
  const byStep = new Map();
  for (const stop of stops) {
    let best = null;
    let bestDistance = Infinity;
    for (const step of steps) {
      const d = Math.min(
        ...step.points.map((p) => haversine(p, stop.coord)),
      );
      if (d < bestDistance) {
        bestDistance = d;
        best = step;
      }
    }
    if (!best) continue;
    if (!byStep.has(best.index)) byStep.set(best.index, []);
    byStep.get(best.index).push(stop);
  }
  return byStep;
}
