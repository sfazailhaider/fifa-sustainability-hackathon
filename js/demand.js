// Simulated foot traffic, as a map layer.
//
// Two simulations, two different questions:
//
//   venues  event-day demand — hotels and neighbourhoods walking to the four
//           tournament sites. Partly presupposes its answer, since every trip
//           ends at one of four places, so the corridors feeding them are
//           guaranteed to dominate.
//   jobs    everyday demand — neighbourhoods walking to where the jobs are,
//           drawn from the employment grid and capped at 2.5 km, because
//           nobody walks across the county to work.
//
// Neither subsumes the other, which is the point of having both. They are
// mutually exclusive on the map: two intensity surfaces at once is unreadable,
// and the honest comparison is one then the other.

import { DEMAND_URLS } from './config.js';

const loaded = new Map();
const images = new Map();

// Orange, the last clear slot on this map: walkability owns red through green,
// jobs purple, priority crimson, water blue.
//
// The ramp runs light-to-dark, which is the reverse of how it started. It was
// built to be screen-blended, so its bright end was white — and screen blend
// lightens, which on a light street basemap means the busiest cells were
// painted white onto near-white and disappeared. Every basemap this app ships
// is light, so the layer is composited normally now and the busiest cells are
// the darkest, which is the way a heat layer reads on paper too.
const HEAT = [
  [0.0, [254, 215, 170]],
  [0.35, [251, 146, 60]],
  [0.7, [234, 88, 12]],
  [1.0, [124, 45, 18]],
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

export async function loadDemand(mode) {
  if (loaded.has(mode)) return loaded.get(mode);
  try {
    const res = await fetch(DEMAND_URLS[mode]);
    if (!res.ok) throw new Error(String(res.status));
    loaded.set(mode, await res.json());
  } catch {
    loaded.set(mode, null);
  }
  return loaded.get(mode);
}

export const demandMeta = (mode) => loaded.get(mode) || null;

/**
 * The hotspots as a heat image.
 *
 * Demand is points, not a grid, so this paints a soft disc per cell rather
 * than a pixel — accumulating where routes overlap, which is what makes a
 * corridor show up as a corridor rather than a dotted line. The CSS blur
 * finishes the job.
 */
export function overlayImage(mode) {
  if (images.has(mode)) return images.get(mode);
  const doc = loaded.get(mode);
  if (!doc?.hotspots?.length) return null;

  const lats = doc.hotspots.map((h) => h.c[0]);
  const lons = doc.hotspots.map((h) => h.c[1]);
  const bbox = {
    s: Math.min(...lats) - 0.01,
    n: Math.max(...lats) + 0.01,
    w: Math.min(...lons) - 0.01,
    e: Math.max(...lons) + 0.01,
  };

  // Ground distances across the box, so the raster can be given square pixels.
  // A fixed 1000x700 raster stretched over a box that is taller than it is
  // wide turns every disc into a vertical ellipse; the blobs were leaning.
  const midLat = ((bbox.s + bbox.n) / 2) * (Math.PI / 180);
  const widthM = (bbox.e - bbox.w) * 111320 * Math.cos(midLat);
  const heightM = (bbox.n - bbox.s) * 111320;

  const W = 1000;
  const H = Math.max(200, Math.min(1600, Math.round((W * heightM) / widthM)));
  const metresPerPx = widthM / W;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const counts = doc.hotspots.map((h) => h.n);
  const top = Math.max(...counts);
  const floor = Math.min(...counts);

  // Normalised across the range the data actually occupies, not from zero.
  // Every cell in the event-day run carries at least 45 trips, so measuring
  // from zero squeezed the whole layer into the top third of the ramp and
  // nothing ever reached the colours that read as busy.
  const lo = Math.log1p(floor);
  const span = Math.log1p(top) - lo;

  // Cells are 60 m. A disc has to cover a couple of them for a corridor to
  // read as a corridor rather than a row of dots.
  const radiusM = (strength) => 90 + strength * 70;

  // Painted lightest-first so the busiest cells finish on top.
  const ordered = [...doc.hotspots].sort((a, b) => a.n - b.n);
  for (const spot of ordered) {
    const strength = span > 0 ? (Math.log1p(spot.n) - lo) / span : 1;
    const [r, g, b] = heatColor(strength);
    const x = ((spot.c[1] - bbox.w) / (bbox.e - bbox.w)) * W;
    const y = ((bbox.n - spot.c[0]) / (bbox.n - bbox.s)) * H;
    const radius = radiusM(strength) / metresPerPx;

    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(${r},${g},${b},${(0.5 + 0.42 * strength).toFixed(2)})`);
    gradient.addColorStop(0.55, `rgba(${r},${g},${b},${(0.24 + 0.3 * strength).toFixed(2)})`);
    gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  const result = { url: canvas.toDataURL('image/png'), bbox, top, cells: doc.hotspots.length };
  images.set(mode, result);
  return result;
}
