// Economic intensity — jobs on the ground, from the Harris County business file.
//
// Deliverable 2a of the brief names economic intensity as an input to the
// high-intensity-corridor classification, which is where this belongs. It is
// deliberately NOT part of the route score: the walkability index already
// carries a "stops for rest and water" term, and adding business density beside
// it would count amenity twice.
//
// Aggregated offline to a 150 m grid (tools/build-economic-intensity.py). The
// source carries named individuals, phone numbers, gender and ethnicity; none
// of it survives aggregation, and none of it is shipped.

import { ECONOMY_URL } from './config.js';

let grid = null;
let loading = null;
let overlayUrl = null;

// Density as depth of colour: the more jobs, the more purple.
//
// This started as a luminance ramp — deep purple for sparse, white hot for
// dense — screen-blended so it added light rather than hue. That reads on a
// dark ground and backwards on a light one, which is the only kind this app
// ships: `screen` lightens, so the densest cells were painted white onto a
// near-white basemap and the emptiest parts of the county were the most
// strongly coloured. Exactly inverted from what anybody expects of a heatmap.
//
// Now it runs pale to deep and composites normally. More jobs, more purple.
//
// Purple is still the one hue nothing else on the map uses — the walkability
// ramp owns red through green, water markers own blue, priority owns crimson.
const HEAT = [
  [0.0, [250, 245, 255]], // barely there
  [0.35, [216, 180, 254]],
  [0.7, [147, 51, 234]],
  [1.0, [88, 28, 135]], // deep purple, dense
];

function heatColor(t) {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < HEAT.length; i++) {
    if (x <= HEAT[i][0]) {
      const [t0, c0] = HEAT[i - 1];
      const [t1, c1] = HEAT[i];
      const k = (x - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * k),
        Math.round(c0[1] + (c1[1] - c0[1]) * k),
        Math.round(c0[2] + (c1[2] - c0[2]) * k),
      ];
    }
  }
  return HEAT[HEAT.length - 1][1];
}

export const HEAT_RAMP = HEAT.map(([stop, rgb]) => ({ stop, css: `rgb(${rgb.join(',')})` }));

export async function loadEconomy() {
  if (grid !== null) return grid;
  if (loading) return loading;

  loading = fetch(ECONOMY_URL)
    .then(async (res) => {
      if (!res.ok) throw new Error(String(res.status));
      const doc = await res.json();

      // Sparse in, dense out: a lookup table keyed by cell, since most of a
      // county has no businesses at all and storing those zeroes is waste.
      const byCell = new Map();
      let topJobs = 0;
      for (const [row, col, jobs, walkJobs, count] of doc.cells) {
        byCell.set(row * doc.cols + col, { jobs, walkJobs, count });
        if (jobs > topJobs) topJobs = jobs;
      }

      grid = { ...doc, byCell, topJobs };
      return grid;
    })
    .catch(() => {
      grid = false;
      return grid;
    });

  return loading;
}

export const economyMeta = () => grid || null;

function cellAt(lat, lon) {
  if (!grid) return null;
  const { bbox, rows, cols } = grid;
  if (lat < bbox.s || lat > bbox.n || lon < bbox.w || lon > bbox.e) return null;
  const row = Math.min(rows - 1, Math.floor(((bbox.n - lat) / (bbox.n - bbox.s)) * rows));
  const col = Math.min(cols - 1, Math.floor(((lon - bbox.w) / (bbox.e - bbox.w)) * cols));
  return grid.byCell.get(row * cols + col) || null;
}

/** Jobs and businesses within `radius` cells of a point — a small neighbourhood. */
export function nearbyJobs(lat, lon, radius = 2) {
  if (!grid) return null;
  const { bbox, rows, cols } = grid;
  if (lat < bbox.s || lat > bbox.n || lon < bbox.w || lon > bbox.e) return null;

  const row = Math.floor(((bbox.n - lat) / (bbox.n - bbox.s)) * rows);
  const col = Math.floor(((lon - bbox.w) / (bbox.e - bbox.w)) * cols);

  let jobs = 0;
  let walkJobs = 0;
  let count = 0;
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      const cell = grid.byCell.get((row + dr) * cols + (col + dc));
      if (!cell) continue;
      jobs += cell.jobs;
      walkJobs += cell.walkJobs;
      count += cell.count;
    }
  }
  return { jobs, walkJobs, count };
}

export { cellAt };

/**
 * The grid as one image for the map.
 *
 * Log-scaled, because the distribution is extreme: the busiest cell holds
 * 21,292 jobs and the median holds a handful. On a linear ramp everything
 * outside downtown and the medical centre would be invisible, which would
 * misrepresent the county as empty rather than as unevenly dense.
 */
export function overlayImage() {
  if (!grid) return null;
  if (overlayUrl) return { url: overlayUrl, bbox: grid.bbox };

  const { rows, cols, byCell, topJobs } = grid;
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(cols, rows);
  const ceiling = Math.log1p(topJobs);

  for (const [key, cell] of byCell) {
    const p = key * 4;
    const strength = ceiling > 0 ? Math.log1p(cell.jobs) / ceiling : 0;
    const [r, g, b] = heatColor(strength);
    image.data[p] = r;
    image.data[p + 1] = g;
    image.data[p + 2] = b;
    // Alpha rises with intensity as well as colour, so the sparse end fades
    // toward the basemap instead of washing the whole county pale purple.
    image.data[p + 3] = Math.round(18 + 215 * strength);
  }

  ctx.putImageData(image, 0, 0);
  overlayUrl = canvas.toDataURL('image/png');
  return { url: overlayUrl, bbox: grid.bbox };
}
