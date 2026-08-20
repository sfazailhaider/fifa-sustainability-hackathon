// Pulls green infrastructure out of OpenStreetMap and indexes it so route
// scoring can ask "how much of this route is next to something green?".
//
// Three sources, in order: a session cache, the live Overpass API, and a
// prebuilt inner-loop extract that ships with the app. The fallback exists
// because Overpass rate-limits by IP, and a hackathon demo cannot go dark
// because a public mirror is busy.

import { OVERPASS_ENDPOINTS, FALLBACK_DATA_URL } from './config.js';
import { SegmentIndex, projector, pointInRing } from './geo.js';

const GREEN_QUERY = (bbox) => `
[out:json][timeout:60];
(
  way["leisure"~"^(park|garden|nature_reserve|recreation_ground|dog_park)$"](${bbox});
  way["landuse"~"^(grass|forest|meadow|village_green|recreation_ground|cemetery|orchard)$"](${bbox});
  way["natural"~"^(wood|water|scrub|grassland|wetland)$"](${bbox});
  way["waterway"="riverbank"](${bbox});
  way["natural"="tree_row"](${bbox});
  node["natural"="tree"](${bbox});
);
out geom;`;

const CACHE_PREFIX = 'coolways.green.';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bboxString(bbox) {
  return `${bbox.s},${bbox.w},${bbox.n},${bbox.e}`;
}

function cacheKey(bbox) {
  const r = (v) => v.toFixed(2);
  return `${CACHE_PREFIX}${r(bbox.s)},${r(bbox.w)},${r(bbox.n)},${r(bbox.e)}`;
}

function readCache(bbox) {
  try {
    const raw = localStorage.getItem(cacheKey(bbox));
    if (!raw) return null;
    const { at, elements } = JSON.parse(raw);
    if (Date.now() - at > CACHE_TTL_MS) return null;
    return elements;
  } catch {
    return null;
  }
}

function writeCache(bbox, elements) {
  try {
    localStorage.setItem(cacheKey(bbox), JSON.stringify({ at: Date.now(), elements }));
  } catch {
    // Quota exceeded on a big city-wide query is fine; we just re-fetch later.
  }
}

// Overpass mirrors return 429/502/504 under load often enough that a single
// attempt is not good enough. Walk the mirrors, then retry the primary.
async function queryOverpass(query) {
  const attempts = [...OVERPASS_ENDPOINTS, OVERPASS_ENDPOINTS[0]];
  let lastError;

  for (let i = 0; i < attempts.length; i++) {
    try {
      const res = await fetch(attempts[i], {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        // A mirror that hasn't answered in 25s is not going to save the demo.
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) throw new Error(`Overpass returned ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (i < attempts.length - 1) await sleep(600);
    }
  }
  throw lastError ?? new Error('All Overpass endpoints failed.');
}

/** Normalised element: { kind: 'node' | 'way', tags, geom: [[lat, lon], ...] }. */
function fromOverpass(json) {
  const out = [];
  for (const el of json.elements || []) {
    if (el.type === 'node') {
      out.push({ kind: 'node', tags: el.tags || {}, geom: [[el.lat, el.lon]] });
    } else if (el.type === 'way' && el.geometry?.length > 1) {
      out.push({
        kind: 'way',
        tags: el.tags || {},
        geom: el.geometry.map((g) => [g.lat, g.lon]),
      });
    }
  }
  return out;
}

function fromBundle(doc, bbox) {
  const out = [];
  for (const el of doc.elements) {
    const geom = el.t === 'n' ? [el.g] : el.g;
    // Cheap bbox filter so a city-wide bundle doesn't slow down a short trip.
    const inside = geom.some(
      ([lat, lon]) => lat >= bbox.s && lat <= bbox.n && lon >= bbox.w && lon <= bbox.e,
    );
    if (!inside) continue;
    out.push({ kind: el.t === 'n' ? 'node' : 'way', tags: el.k || {}, geom });
  }
  return out;
}

let bundlePromise = null;

async function loadBundle() {
  if (!bundlePromise) {
    bundlePromise = fetch(FALLBACK_DATA_URL).then((res) => {
      if (!res.ok) throw new Error('Bundled green data unavailable.');
      return res.json();
    });
  }
  return bundlePromise;
}

function bboxOverlaps(a, b) {
  return !(a.n < b.s || a.s > b.n || a.e < b.w || a.w > b.e);
}

/** Get green features for `bbox`, noting which source actually answered. */
async function fetchGreenElements(bbox) {
  const cached = readCache(bbox);
  if (cached) return { elements: cached, source: 'cache' };

  try {
    const json = await queryOverpass(GREEN_QUERY(bboxString(bbox)));
    const elements = fromOverpass(json);
    writeCache(bbox, elements);
    return { elements, source: 'overpass' };
  } catch (overpassError) {
    const doc = await loadBundle().catch(() => null);
    if (!doc || !bboxOverlaps(bbox, doc.bbox)) throw overpassError;
    return {
      elements: fromBundle(doc, bbox),
      source: 'bundle',
      // The bundle only covers the inner loop, so say so when the trip runs past it.
      partial: bbox.s < doc.bbox.s || bbox.n > doc.bbox.n || bbox.w < doc.bbox.w || bbox.e > doc.bbox.e,
    };
  }
}

// Shoelace area of a projected ring, in square metres.
function ringArea(xy) {
  let sum = 0;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) {
    sum += (xy[j][0] + xy[i][0]) * (xy[j][1] - xy[i][1]);
  }
  return Math.abs(sum / 2);
}

function isClosed(geom) {
  if (geom.length < 4) return false;
  return Math.abs(geom[0][0] - geom.at(-1)[0]) < 1e-7 && Math.abs(geom[0][1] - geom.at(-1)[1]) < 1e-7;
}

/**
 * Fetch and index green features inside `bbox`.
 * Returns { proj, greenIndex, treeIndex, polygons, areas, counts, source }.
 */
export async function loadGreenLayer(bbox) {
  const { elements, source, partial } = await fetchGreenElements(bbox);
  const proj = projector((bbox.s + bbox.n) / 2);

  const greenIndex = new SegmentIndex(300);
  const treeIndex = new SegmentIndex(120);
  const polygons = [];
  const canopyPolygons = [];
  const areas = [];
  let treeCount = 0;
  let id = 0;

  for (const el of elements) {
    id++;

    if (el.kind === 'node') {
      const xy = proj.toXY(el.geom[0]);
      treeIndex.addPoint(xy, { a: xy });
      treeCount++;
      continue;
    }

    const xy = el.geom.map(proj.toXY);

    // A tree row is canopy, not an area: it belongs in the shade index.
    if (el.tags.natural === 'tree_row') {
      for (let i = 1; i < xy.length; i++) {
        treeIndex.addSegment(xy[i - 1], xy[i], { a: xy[i - 1], b: xy[i] });
      }
      continue;
    }

    for (let i = 1; i < xy.length; i++) {
      greenIndex.addSegment(xy[i - 1], xy[i], { a: xy[i - 1], b: xy[i] });
    }

    if (!isClosed(el.geom)) continue;

    const area = ringArea(xy);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of xy) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const polygon = { id, ring: xy, areaM2: area, box: [minX, minY, maxX, maxY] };
    polygons.push(polygon);

    // Woods and forest are canopy in their own right; OSM's individual tree
    // nodes are far too sparse in Houston to carry the shade score alone.
    if (el.tags.natural === 'wood' || el.tags.landuse === 'forest') canopyPolygons.push(polygon);

    let cLat = 0;
    let cLon = 0;
    for (const [lat, lon] of el.geom) {
      cLat += lat;
      cLon += lon;
    }
    areas.push({
      id,
      name: el.tags.name || null,
      areaM2: area,
      centroid: [cLat / el.geom.length, cLon / el.geom.length],
      tags: el.tags,
    });
  }

  return {
    proj,
    greenIndex,
    treeIndex,
    polygons,
    canopyPolygons,
    areas,
    source,
    partial: Boolean(partial),
    counts: { features: elements.length, trees: treeCount, parks: polygons.length },
  };
}

/** True if the projected point falls inside any green polygon. */
export function insideGreen(xy, polygons) {
  for (const poly of polygons) {
    const [minX, minY, maxX, maxY] = poly.box;
    if (xy[0] < minX || xy[0] > maxX || xy[1] < minY || xy[1] > maxY) continue;
    if (pointInRing(xy, poly.ring)) return true;
  }
  return false;
}
