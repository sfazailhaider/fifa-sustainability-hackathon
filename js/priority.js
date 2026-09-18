// Where to spend first: high intensity crossed with low walkability.
//
// Deliverable 2b of the GIS brief. Neither half is a finding alone — a busy
// corridor that is already pleasant needs nothing, and a miserable corridor
// nobody walks is not where a limited budget goes. The product of the two is
// the question a city actually has to answer.
//
// Built offline by tools/build-priority-layer.mjs from the 1,000-route demand
// simulation and the GIS team's walkability surface, so this only has to read
// and draw it.

import { PRIORITY_URL } from './config.js';

let sites = null;
let meta = null;

export async function loadPriority() {
  if (sites) return sites;
  try {
    const res = await fetch(PRIORITY_URL);
    if (!res.ok) throw new Error(String(res.status));
    const doc = await res.json();
    meta = { routed: doc.routed, method: doc.method, generated: doc.generated, cells: doc.cells || [] };
    sites = doc.sites || [];
  } catch {
    sites = [];
  }
  return sites;
}

export const priorityMeta = () => meta;

/** Marker radius: area carries priority, so the eye compares fairly. */
export function radiusFor(priority, top) {
  const share = top > 0 ? priority / top : 0;
  return 6 + Math.sqrt(share) * 14;
}

/**
 * Sequential red, because this is the one layer that is genuinely a warning —
 * these are the places the analysis says are worst-served relative to how many
 * people use them. Everything else in the app avoids red for exactly this
 * reason: so that when it appears, it means something.
 */
export function colorFor(priority, top) {
  const share = top > 0 ? priority / top : 0;
  const alpha = 0.35 + 0.5 * share;
  return { fill: `rgba(190, 18, 60, ${alpha.toFixed(2)})`, stroke: '#9f1239' };
}

export function describeSite(site, rank, routed) {
  const share = routed ? Math.round((site.trips / routed) * 100) : null;
  return {
    rank,
    name: site.name || site.coord.map((v) => v.toFixed(4)).join(', '),
    trips: site.trips,
    share,
    cost: site.cost,
    priority: site.priority,
  };
}

/* --------------------------------------------------------- the scatter --- */

// Why a site ranks, rather than just which ones did.
//
// Priority is intensity × difficulty, and a product is hard to argue with in a
// list — the scatter makes the rule visible. Every scored cell is plotted;
// the chosen ones are the top-right corner, and the dashed curve is the
// iso-priority line through the last site that made the cut, so "both busy and
// hard" is something you can see rather than something you are told.

const W = 320;
const H = 208;
const PAD = { top: 10, right: 10, bottom: 30, left: 38 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

// Crimson matches the priority markers on the map; the population is neutral
// because it is context, not a second series competing for identity.

export function renderScatter(cells, sites) {
  if (!cells?.length || !sites?.length) return '';

  // Difficulty tops out around 0.38, so the axis follows the data. Scaling to
  // a nominal 0..1 would flatten every point onto the floor.
  const yMax = Math.ceil(Math.max(...cells.map((c) => c[1])) * 10) / 10;
  const x = (v) => PAD.left + v * PLOT_W;
  const y = (v) => PAD.top + PLOT_H - (v / yMax) * PLOT_H;

  const population = cells
    .map(([i, d]) => `<circle cx="${x(i).toFixed(1)}" cy="${y(d).toFixed(1)}" r="1.8" class="sc-bg" />`)
    .join('');

  const chosen = sites
    .map(
      (s, rank) =>
        `<circle cx="${x(s.intensity).toFixed(1)}" cy="${y(s.difficulty).toFixed(1)}" r="${rank === 0 ? 5 : 3.6}"
                 class="sc-site" data-rank="${rank}" />`,
    )
    .join('');

  // Iso-priority curve through the last site that made the cut.
  const threshold = sites[sites.length - 1].priority;
  const points = [];
  for (let i = 0; i <= 60; i++) {
    const xi = threshold / yMax + (i / 60) * (1 - threshold / yMax);
    const yi = threshold / xi;
    if (xi > 1 || yi > yMax) continue;
    points.push(`${x(xi).toFixed(1)},${y(yi).toFixed(1)}`);
  }
  const curve = points.length
    ? `<polyline class="sc-iso" points="${points.join(' ')}" />`
    : '';

  const xTicks = [0, 0.5, 1]
    .map(
      (v) =>
        `<text class="sc-tick" x="${x(v).toFixed(1)}" y="${H - 14}" text-anchor="${
          v === 0 ? 'start' : v === 1 ? 'end' : 'middle'
        }">${Math.round(v * 100)}%</text>`,
    )
    .join('');

  const yTicks = [0, yMax / 2, yMax]
    .map(
      (v) =>
        `<g><line class="sc-grid" x1="${PAD.left}" y1="${y(v).toFixed(1)}" x2="${W - PAD.right}" y2="${y(v).toFixed(1)}" />
           <text class="sc-tick" x="${PAD.left - 5}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${v.toFixed(1)}</text></g>`,
    )
    .join('');

  return `
    <svg class="sc" viewBox="0 0 ${W} ${H}" role="img"
         aria-label="Every scored corner plotted by how many walking trips cross it against how hard it is to walk. The priority sites are the ones high on both.">
      ${yTicks}
      ${curve}
      ${population}
      ${chosen}
      ${xTicks}
      <text class="sc-axis" x="${PAD.left + PLOT_W / 2}" y="${H - 2}" text-anchor="middle">share of simulated trips →</text>
      <text class="sc-axis" x="${-(PAD.top + PLOT_H / 2)}" y="10" transform="rotate(-90)" text-anchor="middle">harder to walk →</text>
    </svg>`;
}
