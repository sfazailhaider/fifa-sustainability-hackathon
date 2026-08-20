// Regenerates data/houston-green.json — the offline fallback green layer.
//
//   node tools/build-green-extract.mjs [south west north east]
//
// Overpass rejects Node's default User-Agent, so set a real one. Keep the box
// modest: the extract ships to every visitor, and it is ~1.3 MB for the loop.

import { writeFile } from 'node:fs/promises';

const [s, w, n, e] = (process.argv.slice(2).length === 4
  ? process.argv.slice(2)
  : ['29.66', '-95.44', '29.78', '-95.33']
).map(Number);

const bbox = `${s},${w},${n},${e}`;
const query = `
[out:json][timeout:180];
(
  way["leisure"~"^(park|garden|nature_reserve|recreation_ground|dog_park)$"](${bbox});
  way["landuse"~"^(grass|forest|meadow|village_green|recreation_ground|cemetery|orchard)$"](${bbox});
  way["natural"~"^(wood|water|scrub|grassland|wetland)$"](${bbox});
  way["waterway"="riverbank"](${bbox});
  way["natural"="tree_row"](${bbox});
  node["natural"="tree"](${bbox});
  node["amenity"~"^(drinking_water|water_point)$"](${bbox});
  way["amenity"~"^(drinking_water|water_point)$"](${bbox});
  node["drinking_water"="yes"](${bbox});
);
out geom;`;

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// A city-wide extract is a heavy query; public mirrors routinely answer 429 or
// 504 on the first ask, so work through them with a growing backoff.
async function fetchWithRetry(attempts = 6) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    const mirror = MIRRORS[i % MIRRORS.length];
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        headers: { 'User-Agent': 'houston-route-comparison/1.0 (FIFA Sustainability Hackathon)' },
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) throw new Error(`${mirror} returned ${res.status}`);
      return res;
    } catch (err) {
      lastError = err;
      console.warn(`attempt ${i + 1}/${attempts} failed: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 4000 * (i + 1)));
    }
  }
  throw lastError;
}

const res = await fetchWithRetry();

const KEEP = new Set([
  'name',
  'leisure',
  'landuse',
  'natural',
  'waterway',
  'amenity',
  'drinking_water',
  'indoor',
  'seasonal',
]);
const round = (v) => Math.round(v * 1e5) / 1e5;
const elements = [];

for (const el of (await res.json()).elements) {
  const tags = Object.fromEntries(
    Object.entries(el.tags || {}).filter(([k]) => KEEP.has(k)),
  );

  if (el.type === 'node') {
    elements.push({ t: 'n', g: [round(el.lat), round(el.lon)], k: tags });
    continue;
  }
  if (el.type !== 'way' || !el.geometry?.length) continue;

  // Rounding to 5 decimals (~1 m) can collapse neighbouring nodes; drop the dupes.
  const geom = [];
  for (const p of el.geometry) {
    const point = [round(p.lat), round(p.lon)];
    const last = geom.at(-1);
    if (!last || last[0] !== point[0] || last[1] !== point[1]) geom.push(point);
  }
  if (geom.length < 2) continue;
  elements.push({ t: 'w', g: geom, k: tags });
}

await writeFile(
  'data/houston-green.json',
  JSON.stringify({
    v: 1,
    bbox: { s, w, n, e },
    note: 'Prebuilt OpenStreetMap green-infrastructure extract for inner-loop Houston. Offline fallback when Overpass is rate-limited.',
    elements,
  }),
);

console.log(`Wrote ${elements.length} features for bbox ${bbox}`);
