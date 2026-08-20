// Small geometry toolkit. Everything works in [lat, lon] pairs unless noted.

const R_EARTH = 6371008.8;
const DEG = Math.PI / 180;

export function haversine(a, b) {
  const dLat = (b[0] - a[0]) * DEG;
  const dLon = (b[1] - a[1]) * DEG;
  const lat1 = a[0] * DEG;
  const lat2 = b[0] * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

// Local equirectangular projection to metres, accurate enough over a city.
export function projector(refLat) {
  const kx = Math.cos(refLat * DEG) * R_EARTH * DEG;
  const ky = R_EARTH * DEG;
  return {
    toXY: (p) => [p[1] * kx, p[0] * ky],
    metresPerDegLon: kx,
    metresPerDegLat: ky,
  };
}

export function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversine(points[i - 1], points[i]);
  return total;
}

// Resample a polyline to roughly one point every `spacing` metres.
export function samplePath(points, spacing) {
  if (points.length < 2) return points.slice();
  const out = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = haversine(a, b);
    if (seg === 0) continue;
    let pos = spacing - carry;
    while (pos <= seg) {
      const t = pos / seg;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      pos += spacing;
    }
    carry = (carry + seg) % spacing;
  }
  out.push(points[points.length - 1]);
  return out;
}

export function bboxOf(pointLists) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const list of pointLists) {
    for (const p of list) {
      if (p[0] < s) s = p[0];
      if (p[0] > n) n = p[0];
      if (p[1] < w) w = p[1];
      if (p[1] > e) e = p[1];
    }
  }
  return { s, w, n, e };
}

export function padBbox(bbox, metres) {
  const dLat = metres / 111320;
  const midLat = (bbox.s + bbox.n) / 2;
  const dLon = metres / (111320 * Math.max(0.2, Math.cos(midLat * DEG)));
  return { s: bbox.s - dLat, w: bbox.w - dLon, n: bbox.n + dLat, e: bbox.e + dLon };
}

export function midpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

// Distance from point p to segment ab, in projected metres.
export function pointSegmentDistance(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const dx = wx - t * vx;
  const dy = wy - t * vy;
  return Math.sqrt(dx * dx + dy * dy);
}

// Ray-casting point-in-polygon over an [x, y] ring.
export function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// Uniform grid index over line segments, so proximity queries stay cheap.
export class SegmentIndex {
  constructor(cellSize = 250) {
    this.cell = cellSize;
    this.cells = new Map();
    this.empty = true;
  }

  key(x, y) {
    return `${Math.floor(x / this.cell)}:${Math.floor(y / this.cell)}`;
  }

  addSegment(a, b, payload) {
    this.empty = false;
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / this.cell));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const k = this.key(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      let bucket = this.cells.get(k);
      if (!bucket) this.cells.set(k, (bucket = []));
      bucket.push(payload);
    }
  }

  addPoint(p, payload) {
    this.empty = false;
    const k = this.key(p[0], p[1]);
    let bucket = this.cells.get(k);
    if (!bucket) this.cells.set(k, (bucket = []));
    bucket.push(payload);
  }

  // Everything stored in the 3x3 block of cells around p (deduplicated).
  near(p) {
    const cx = Math.floor(p[0] / this.cell);
    const cy = Math.floor(p[1] / this.cell);
    const seen = new Set();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.cells.get(`${cx + dx}:${cy + dy}`);
        if (bucket) for (const item of bucket) seen.add(item);
      }
    }
    return seen;
  }
}
