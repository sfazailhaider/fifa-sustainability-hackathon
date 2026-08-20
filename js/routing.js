// OSRM route fetching plus "green detour" candidate generation.

import { OSRM_HOSTS, NOMINATIM_URL } from './config.js';
import { haversine } from './geo.js';

function coordString(points) {
  // OSRM wants lon,lat.
  return points.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(';');
}

async function osrm(mode, waypoints, { alternatives }) {
  const host = OSRM_HOSTS[mode];
  const params = new URLSearchParams({
    overview: 'full',
    geometries: 'geojson',
    steps: 'true',
    alternatives: alternatives ? '3' : 'false',
  });
  const url = `${host}/route/v1/driving/${coordString(waypoints)}?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Routing service returned ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.length) {
    throw new Error(data.message || 'No route found between those points.');
  }
  return data.routes;
}

function toRoute(raw, source) {
  const points = raw.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  return {
    points,
    distance: raw.distance, // metres
    duration: raw.duration, // seconds
    legs: raw.legs || [],
    source,
  };
}

// Two routes are "the same" if their length and their sampled shape agree closely.
function signature(route) {
  const step = Math.max(1, Math.floor(route.points.length / 12));
  const shape = [];
  for (let i = 0; i < route.points.length; i += step) {
    shape.push(route.points[i].map((v) => v.toFixed(3)).join(','));
  }
  return `${Math.round(route.distance / 200)}|${shape.join(' ')}`;
}

export function dedupe(routes) {
  const seen = new Set();
  const out = [];
  for (const route of routes) {
    const sig = signature(route);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(route);
  }
  return out;
}

export async function fetchBaseRoutes(mode, origin, destination) {
  const raws = await osrm(mode, [origin, destination], { alternatives: true });
  return dedupe(raws.map((r) => toRoute(r, 'osrm-alternative')));
}

// Route the trip through one extra waypoint, e.g. the middle of a park.
export async function fetchViaRoute(mode, origin, destination, via, source) {
  const raws = await osrm(mode, [origin, via, destination], { alternatives: false });
  return toRoute(raws[0], source);
}

// Pick green spaces that sit near the corridor between origin and destination
// and are big enough to be worth a detour, then rank by "close to the line".
export function pickGreenViaPoints(greenAreas, origin, destination, limit = 3) {
  const direct = haversine(origin, destination);
  const maxDetour = Math.max(1200, direct * 0.45);
  const scored = [];

  for (const area of greenAreas) {
    if (!area.centroid || !area.areaM2) continue;
    if (area.areaM2 < 25000) continue; // smaller than ~2.5 ha isn't worth rerouting for
    const detour =
      haversine(origin, area.centroid) + haversine(area.centroid, destination) - direct;
    if (detour > maxDetour) continue;
    // Favour large parks that barely lengthen the trip.
    const score = Math.log10(area.areaM2) * 2 - detour / 1000;
    scored.push({ ...area, detour, score });
  }

  scored.sort((a, b) => b.score - a.score);

  // Spread the picks out so we don't send three routes through the same park.
  const picked = [];
  for (const candidate of scored) {
    if (picked.every((p) => haversine(p.centroid, candidate.centroid) > 700)) {
      picked.push(candidate);
    }
    if (picked.length >= limit) break;
  }
  return picked;
}

export async function geocode(query) {
  const params = new URLSearchParams({
    format: 'json',
    q: query,
    limit: '1',
    countrycodes: 'us',
    // Bias results to greater Houston.
    viewbox: '-95.90,30.15,-94.90,29.40',
    bounded: '1',
  });
  const res = await fetch(`${NOMINATIM_URL}?${params}`);
  if (!res.ok) throw new Error('Geocoding service unavailable.');
  const results = await res.json();
  if (!results.length) throw new Error(`Could not find "${query}" in the Houston area.`);
  return {
    coord: [parseFloat(results[0].lat), parseFloat(results[0].lon)],
    label: results[0].display_name,
  };
}
