// UI controller: wires the map, the place search, and the scoring pipeline together.

import {
  BASEMAPS,
  BASEMAP_ORDER,
  HOUSTON_CENTER,
  TEXAS,
  MODES,
  DEFAULT_WEIGHTS,
  ROUTE_COLORS,
  IMPACT_SOURCES,
  METRO_LINKS,
  DATA_EXTENT,
  COUNTY_URL,
  ECONOMY_URL,
  DEMAND_URLS,
} from './config.js';
import { bboxOf, padBbox, haversine } from './geo.js';
import { fetchBaseRoutes, fetchViaRoute, pickGreenViaPoints, dedupe } from './routing.js';
import { loadGreenLayer } from './greenspace.js';
import { scoreRoutes, assignBadges, formatDistance, formatDuration } from './scoring.js';
import { buildDirections, stepDistance } from './directions.js';
import { assignStopsToSteps } from './water.js';
import { loadWalkability, walkabilityMeta, overlayImage } from './walkability.js';
import { loadPriority, priorityMeta, radiusFor, colorFor, describeSite, renderScatter } from './priority.js';
import { loadEconomy, economyMeta, overlayImage as economyImage } from './economy.js';
import { loadDemand, demandMeta, overlayImage as demandImage } from './demand.js';
import { runScenario, renderScenario } from './scenario.js';
import { renderProfile, seriesFor, sampleAt, describeSample } from './profile.js';
import {
  planTransit,
  VEHICLES,
  formatClock,
  formatDay,
  houstonWallTimeToDate,
  dateToHoustonWallTime,
} from './transit.js';
import {
  loadConditions,
  conditionsOver,
  hoursFrom,
  heatBand,
  aqiBand,
  HEAT_BANDS,
} from './weather.js';
import { suggestPlaces, resolvePlace, describeCoordinate, locateMe } from './places.js';
import { initSheet } from './sheet.js';

const el = (id) => document.getElementById(id);

// Rice to Hermann Park: about a 20 minute walk that exercises every part of
// the app — four distinct routes, 86% green, the best canopy in the city's
// mapped data, water stops on the way, and a 58-76 spread so the ranking
// visibly means something. A cross-town trek makes a poor first screen.
const DEFAULT_TRIP = {
  origin: { coord: [29.7174, -95.4018], label: 'Rice University', detail: 'Houston landmark' },
  destination: { coord: [29.7157, -95.39], label: 'Hermann Park', detail: 'Houston landmark' },
};

const state = {
  mode: 'foot',
  scoreMode: 'absolute',
  weights: { ...DEFAULT_WEIGHTS },
  normalised: { ...DEFAULT_WEIGHTS },
  places: { origin: null, destination: null },
  rawRoutes: [],
  routes: [],
  selected: 0,
  directions: [],
  activeStep: null,
  layer: null,
  pick: null,
  lines: [],
  markers: {},
  stepLayer: null,
  stopLayer: null,
  labelLayer: null,
  basemap: 'streets',
  walkLayer: null,
  priorityLayer: null,
  economyLayer: null,
  demandLayer: null,
  demandMode: null,
  demandRun: 'venues',
  scenario: { count: 5, effect: 30 },
  priorityMarkers: [],
  waterLayer: null,
  showWater: true,
  busy: false,
  directionsOpen: true,
  sheet: null,
  // Transit is the only mode where *when* changes the answer, so the time
  // lives in state rather than being read off the clock at request time.
  when: { kind: 'depart' },
  // The forecast for this trip, and the slice of it the trip happens in.
  // Loaded once per comparison; changing the hour re-reads it rather than
  // re-fetching, which is what makes the hour strip feel instant.
  conditions: null,
  heatHour: null,
  stepFree: false,
  stepFreeCost: null,
  queued: false,
  // What has changed since the routes on screen were found. Null when they
  // are current. Nothing here ever triggers a search by itself.
  stale: null,
  transitNote: '',
};

const isTransit = () => state.mode === 'transit';

/* ---------------------------------------------------------------- map --- */

// Fenced to Texas, because that is the extent of everything the app knows.
// The walkability surface stops at Harris County, the green extract at the
// inner loop, and search is Texas-biased — so panning to Oklahoma offers a map
// with nothing on it and no way to tell that from a bug. maxBounds keeps the
// view where the data is; the padding lets the edges breathe rather than
// slamming shut.
const TEXAS_BOUNDS = L.latLngBounds(
  [TEXAS.s - 0.3, TEXAS.w - 0.3],
  [TEXAS.n + 0.3, TEXAS.e + 0.3],
);

const map = L.map('map', {
  zoomControl: true,
  maxBounds: TEXAS_BOUNDS,
  maxBoundsViscosity: 0.85, // firm, but it gives a little rather than jarring
  minZoom: 6,
});

// Open on the whole covered area rather than one neighbourhood, so the first
// thing on screen is the extent of what the app actually knows. Comparing a
// trip zooms to the routes straight after.
map.fitBounds(
  L.latLngBounds([DATA_EXTENT.s, DATA_EXTENT.w], [DATA_EXTENT.n, DATA_EXTENT.e]),
  { padding: [20, 20] },
);

let tileFailures = 0;

function makeBasemap(key) {
  const spec = BASEMAPS[key];

  // Vector needs WebGL and the MapLibre bridge; if either is missing, fall
  // straight through to raster rather than showing an empty map.
  if (spec.type === 'vector' && typeof L.maplibreGL === 'function' && hasWebGL()) {
    return L.maplibreGL({ style: spec.style, attribution: spec.attribution });
  }
  const raster = spec.type === 'raster' ? spec : BASEMAPS.osm;
  const layer = L.tileLayer(raster.url, {
    attribution: raster.attribution,
    maxZoom: raster.maxZoom,
  });

  // A raster provider that starts failing shows as grey squares with nothing in
  // the console, so count the misses and move on. This cannot catch a provider
  // that *watermarks* rather than fails, which is why none of these need keys.
  layer.on('tileerror', () => {
    tileFailures += 1;
    if (tileFailures !== 10) return;
    const next = BASEMAP_ORDER.find((name) => name !== state.basemap);
    if (!next) return;
    setBasemap(next);
    setStatus(`Map tiles were failing, so the basemap switched to ${BASEMAPS[next].label}.`);
  });
  return layer;
}

let webglAnswer = null;

function hasWebGL() {
  if (webglAnswer !== null) return webglAnswer;
  try {
    const canvas = document.createElement('canvas');
    webglAnswer = Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    webglAnswer = false;
  }
  return webglAnswer;
}

let basemap = makeBasemap('streets').addTo(map);

/**
 * The walkability surface as a map layer.
 *
 * It sits under the routes, not over them — the point is to see which ground a
 * route crosses, so the route has to stay the brightest thing on screen. Where
 * the surface has no data the image is transparent, so a gap reads as a gap
 * rather than as a colour that means something.
 */
let countyLines = null;

/** The county outline, so the surface's edge reads as a boundary not a crop. */
async function countyBoundary() {
  if (countyLines) return countyLines;
  try {
    const res = await fetch(COUNTY_URL);
    countyLines = res.ok ? (await res.json()).lines || [] : [];
  } catch {
    countyLines = [];
  }
  return countyLines;
}

async function toggleWalkLayer() {
  const button = el('walk-layer-btn');

  if (state.walkLayer) {
    map.removeLayer(state.walkLayer);
    state.walkLayer = null;
    button.classList.remove('is-armed');
    button.setAttribute('aria-pressed', 'false');
    el('walk-legend').hidden = true;
    return;
  }

  button.disabled = true;
  await loadWalkability();
  const image = overlayImage();
  button.disabled = false;

  if (!image) {
    setStatus('The walkability surface could not be loaded.', true);
    return;
  }

  const lines = await countyBoundary();

  state.walkLayer = L.layerGroup().addTo(map);
  const surface = L.imageOverlay(
    image.url,
    [
      [image.bbox.s, image.bbox.w],
      [image.bbox.n, image.bbox.e],
    ],
    { opacity: 1, interactive: false, className: 'walk-overlay' },
  ).addTo(state.walkLayer);

  // Two passes: a wide pale casing under a thin dark line, so the boundary
  // stays legible over both the pale and the saturated parts of the surface.
  for (const width of [[4.5, '#ffffff', 0.85], [1.6, '#7f1d1d', 0.95]]) {
    for (const line of lines) {
      L.polyline(line, {
        color: width[1],
        weight: width[0],
        opacity: width[2],
        interactive: false,
      }).addTo(state.walkLayer);
    }
  }

  surface.bringToBack();
  basemap.bringToBack?.();

  button.classList.add('is-armed');
  button.setAttribute('aria-pressed', 'true');
  el('walk-legend').hidden = false;
}

/**
 * Economic intensity, as a map layer.
 *
 * Log-scaled in economy.js, because the busiest cell holds 21,292 jobs against
 * a median of a handful — on a linear ramp the county would look empty rather
 * than unevenly dense.
 */
async function toggleEconomy() {
  const button = el('economy-btn');

  if (state.economyLayer) {
    map.removeLayer(state.economyLayer);
    state.economyLayer = null;
    button.classList.remove('is-armed');
    button.setAttribute('aria-pressed', 'false');
    el('economy-legend').hidden = true;
    return;
  }

  button.disabled = true;
  await loadEconomy();
  const image = economyImage();
  const lines = await countyBoundary();
  button.disabled = false;

  if (!image) {
    setStatus('The economic intensity layer could not be loaded.', true);
    return;
  }

  state.economyLayer = L.layerGroup().addTo(map);
  const heat = L.imageOverlay(
    image.url,
    [
      [image.bbox.s, image.bbox.w],
      [image.bbox.n, image.bbox.e],
    ],
    { opacity: 1, interactive: false, className: 'econ-overlay' },
  ).addTo(state.economyLayer);

  // Same outline as the walkability layer, so both read against the same
  // boundary rather than each ending at an unexplained edge.
  for (const [weight, color, opacity] of [[4.5, '#ffffff', 0.85], [1.6, '#7f1d1d', 0.95]]) {
    for (const line of lines) {
      L.polyline(line, { color, weight, opacity, interactive: false }).addTo(state.economyLayer);
    }
  }

  // Above the walkability wash, since `screen` needs something to brighten.
  heat.bringToFront();
  basemap.bringToBack?.();

  const meta = economyMeta();
  el('economy-count').textContent = meta
    ? `${meta.records.toLocaleString()} businesses · ${meta.employeeCounts.actual.toLocaleString()} employee counts measured, the rest modelled by industry`
    : '';
  button.classList.add('is-armed');
  button.setAttribute('aria-pressed', 'true');
  el('economy-legend').hidden = false;
}

const DEMAND_LABEL = {
  venues: ['🔥 Event-day foot traffic', 'Hotels and neighbourhoods walking to the four venues.'],
  jobs: ['🔥 Everyday foot traffic', 'Neighbourhoods walking to where the jobs are, within 2.5 km.'],
};

/**
 * Foot traffic, as an on/off layer with a named run.
 *
 * This was one button cycling off → event-day → everyday → off. Nothing on
 * screen said a second press gave a different map, and getting back to the
 * first run meant pressing through "off". The button is now an ordinary
 * toggle, and the two runs are named buttons in the legend — both visible,
 * either reachable in one press.
 *
 * They stay mutually exclusive: two intensity surfaces at once is unreadable,
 * and the honest comparison is one and then the other.
 */
async function toggleDemand() {
  await setDemandRun(state.demandMode ? null : state.demandRun || 'venues');
}

async function setDemandRun(next) {
  const button = el('demand-btn');

  if (state.demandLayer) {
    map.removeLayer(state.demandLayer);
    state.demandLayer = null;
  }

  state.demandMode = next;
  if (!next) {
    button.classList.remove('is-armed');
    button.setAttribute('aria-pressed', 'false');
    el('demand-legend').hidden = true;
    return;
  }

  // Remembered, so turning the layer off and on again comes back to the run
  // that was last being looked at rather than resetting to event-day.
  state.demandRun = next;
  syncDemandRuns(next);

  button.disabled = true;
  await loadDemand(next);
  const image = demandImage(next);
  button.disabled = false;

  if (!image) {
    setStatus(
      next === 'jobs'
        ? 'The everyday demand run has not been generated yet.'
        : 'The demand layer could not be loaded.',
      true,
    );
    state.demandMode = null;
    button.classList.remove('is-armed');
    button.setAttribute('aria-pressed', 'false');
    el('demand-legend').hidden = true;
    return;
  }

  state.demandLayer = L.imageOverlay(
    image.url,
    [
      [image.bbox.s, image.bbox.w],
      [image.bbox.n, image.bbox.e],
    ],
    { opacity: 1, interactive: false, className: 'dem-overlay' },
  ).addTo(map);
  state.demandLayer.bringToFront();

  const doc = demandMeta(next);
  const [title, note] = DEMAND_LABEL[next];
  el('demand-title').textContent = title;
  el('demand-note').textContent =
    `${note} Darker means more of the ${doc.routed.toLocaleString()} simulated walking trips use that ` +
    `street: the busiest 60 m square is crossed by ${image.top} of them.`;
  button.classList.add('is-armed');
  button.setAttribute('aria-pressed', 'true');
  el('demand-legend').hidden = false;
}

function syncDemandRuns(active) {
  document.querySelectorAll('#demand-runs .seg-btn').forEach((btn) => {
    const on = btn.dataset.run === active;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
  });
}

/** The priority sites, on the map and in a ranked list. */
async function togglePriority() {
  const button = el('priority-btn');

  if (state.priorityLayer) {
    map.removeLayer(state.priorityLayer);
    state.priorityLayer = null;
    button.classList.remove('is-armed');
    button.setAttribute('aria-pressed', 'false');
    el('priority-card').hidden = true;
    el('priority-legend').hidden = true;
    return;
  }

  button.disabled = true;
  const sites = await loadPriority();
  sitesCache = sites;
  button.disabled = false;

  if (!sites.length) {
    setStatus('The priority layer could not be loaded.', true);
    return;
  }

  const meta = priorityMeta();
  const top = sites[0].priority;
  state.priorityLayer = L.layerGroup().addTo(map);

  state.priorityMarkers = sites.map((site, i) => {
    const { fill, stroke } = colorFor(site.priority, top);
    const marker = L.circleMarker(site.coord, {
      radius: radiusFor(site.priority, top),
      color: stroke,
      weight: 1.5,
      fillColor: fill,
      fillOpacity: 1,
    })
      .bindTooltip(
        `<b>#${i + 1} ${escapeHtml(site.name || 'site')}</b><br>` +
          `${site.trips} of ${meta.routed} simulated walks cross here · difficulty ${site.cost}/10`,
        { direction: 'top' },
      )
      .on('click', () => focusPrioritySite(i))
      .addTo(state.priorityLayer);
    // Remembered, so a site dropping out of the treated set goes back to the
    // colour the ramp gave it rather than to whatever it was last styled with.
    marker.baseStyle = { color: stroke, fillColor: fill };
    return marker;
  });

  button.classList.add('is-armed');
  button.setAttribute('aria-pressed', 'true');
  el('priority-legend').hidden = false;
  renderPriorityList(sites, meta);
  map.fitBounds(L.latLngBounds(sites.map((s) => s.coord)), boundsOptions());
}

function renderPriorityList(sites, meta) {
  el('priority-card').hidden = false;
  const top = sites.slice(0, 12).map((site, i) => describeSite(site, i + 1, meta.routed));

  el('priority-summary').innerHTML =
    `Busiest <em>and</em> hardest to walk. ${sites[0].name || 'The top site'} carries ` +
    `<b>${top[0].share}%</b> of ${meta.routed.toLocaleString()} simulated walking trips ` +
    `to the venues — on ground the walkability index rates <b>${sites[0].cost} out of 10 for difficulty</b>, where 10 is the hardest to walk.`;

  el('priority-list').innerHTML = top
    .map(
      (site) => `
      <li class="priority-site" data-index="${site.rank - 1}">
        <span class="priority-rank">${site.rank}</span>
        <span>
          <span class="priority-name">${escapeHtml(site.name)}</span>
          <span class="priority-meta">${site.trips} of ${meta.routed.toLocaleString()} simulated walks cross here · difficulty ${site.cost}/10</span>
        </span>
        <span class="priority-score">${site.priority.toFixed(2)}</span>
      </li>`,
    )
    .join('');

  el('priority-list')
    .querySelectorAll('.priority-site')
    .forEach((node) =>
      node.addEventListener('click', () => focusPrioritySite(Number(node.dataset.index))),
    );

  el('priority-chart').innerHTML = renderScatter(meta.cells, sites);
  el('priority-chart-legend').innerHTML =
    '<span class="sc-key"><i class="sc-dot-site"></i>the 40 chosen</span>' +
    `<span class="sc-key"><i class="sc-dot-bg"></i>all ${meta.cells?.length || 0} scored cells</span>` +
    '<span class="sc-key"><i class="sc-dash"></i>cut-off</span>';
  el('priority-method').textContent = meta.method;
  renderScenarioPanel();
}

/**
 * The what-if, recomputed from numbers already in memory. No request, no
 * re-routing — which is what lets the sliders answer as fast as they move.
 */
function renderScenarioPanel() {
  const sites = sitesCache;
  if (!sites?.length) return;
  const meta = priorityMeta();
  const { count, effect } = state.scenario;

  const result = runScenario(sites, { count, reduction: effect / 100 });

  el('scn-count-out').textContent = String(count);
  el('scn-effect-out').textContent = `${effect}%`;
  el('scenario-out').innerHTML = renderScenario(result, meta.routed);

  // Treated sites get a ring on the map, so the budget is legible as a place
  // and not only as a number.
  state.priorityMarkers.forEach((marker, i) => {
    const treated = i < count;
    marker.setStyle({
      color: treated ? '#1f7a4d' : marker.baseStyle.color,
      weight: treated ? 3 : 1.5,
      fillOpacity: treated ? 0.5 : 1,
    });
  });
}

function focusPrioritySite(index) {
  const site = state.priorityLayer && sitesCache[index];
  if (!site) return;
  map.flyTo(offsetForVisibleArea(site.coord), Math.max(map.getZoom(), 16), { duration: 0.5 });
}

let sitesCache = [];

function setBasemap(key) {
  state.basemap = key;
  tileFailures = 0;
  map.removeLayer(basemap);
  basemap = makeBasemap(key).addTo(map);
  // Keep the basemap under the routes after swapping.
  basemap.bringToBack?.();
  const button = el('basemap-btn');
  const label = button?.querySelector('.btn-text');
  if (label) label.textContent = BASEMAPS[key].label;
  if (button) button.title = `Basemap: ${BASEMAPS[key].label}`;
}

// Start is a plain white dot sitting on the point; the destination is a
// teardrop pin whose tip marks the spot. Same convention as every other map
// app, so nobody has to work out which end is which.
const DESTINATION_PIN = `
  <svg width="24" height="32" viewBox="0 0 24 32" aria-hidden="true">
    <path d="M12 1C6.5 1 2 5.5 2 11c0 7.5 10 19.5 10 19.5S22 18.5 22 11C22 5.5 17.5 1 12 1z"
          fill="#d93025" stroke="#fff" stroke-width="2" stroke-linejoin="round" />
    <circle cx="12" cy="11" r="4" fill="#fff" />
  </svg>`;

function pinIcon(role) {
  if (role === 'origin') {
    return L.divIcon({
      className: '',
      html: '<div class="pin-start"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
  }
  return L.divIcon({
    className: '',
    html: `<div class="pin-destination">${DESTINATION_PIN}</div>`,
    iconSize: [24, 32],
    // The tip of the teardrop, not its centre.
    iconAnchor: [12, 31],
  });
}

/** Place (or move) a draggable endpoint pin. */
function setMarker(role, place) {
  const existing = state.markers[role];
  if (existing) {
    existing.setLatLng(place.coord);
  } else {
    const marker = L.marker(place.coord, { icon: pinIcon(role), draggable: true, zIndexOffset: 900 })
      .addTo(map)
      .on('dragend', async (event) => {
        const { lat, lng } = event.target.getLatLng();
        setStatus('Naming the spot you dropped…');
        const dropped = await describeCoordinate([lat, lng]);
        applyPlace(role, dropped);
        setStatus(`${role === 'origin' ? 'Start' : 'Finish'} moved to ${dropped.label}.`);
        markStale(`${role === 'origin' ? 'Start' : 'Finish'} moved.`);
      });
    state.markers[role] = marker;
  }
  state.markers[role].bindTooltip(
    `${role === 'origin' ? 'Start' : 'Finish'}: ${place.label}`,
    { direction: 'top' },
  );
}

function clearRouteLines() {
  state.lines.forEach((line) => map.removeLayer(line));
  state.lines = [];
  if (state.stepLayer) {
    map.removeLayer(state.stepLayer);
    state.stepLayer = null;
  }
  if (state.stopLayer) {
    map.removeLayer(state.stopLayer);
    state.stopLayer = null;
  }
}

/** Blue dots for every refill point on the selected route. */
function drawWater() {
  if (state.waterLayer) {
    map.removeLayer(state.waterLayer);
    state.waterLayer = null;
  }
  const route = state.routes[state.selected];
  if (!route?.water?.stops.length || !state.showWater) return;

  state.waterLayer = L.layerGroup().addTo(map);
  route.water.stops.forEach((stop, i) => {
    L.marker(stop.coord, {
      icon: L.divIcon({
        className: '',
        html: '<div class="water-pin">💧</div>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      }),
      zIndexOffset: 600,
    })
      .bindTooltip(
        `${stop.name || 'Drinking water'} — ${formatDistance(stop.distanceFromStart)} in`,
        { direction: 'top' },
      )
      .on('click', () => focusWater(i))
      .addTo(state.waterLayer);
  });
}

function drawRoutes() {
  clearRouteLines();
  if (!state.routes.length) return;

  // Draw unselected first so the selected route lands on top.
  const order = state.routes
    .map((_, i) => i)
    .sort((a, b) => (a === state.selected ? 1 : 0) - (b === state.selected ? 1 : 0));

  for (const i of order) {
    const route = state.routes[i];
    const isSelected = i === state.selected;

    if (route.transit?.rides.length) {
      drawTransitRoute(route, i, isSelected);
      continue;
    }

    const line = L.polyline(route.points, {
      color: route.color,
      weight: isSelected ? 6 : 4,
      opacity: isSelected ? 0.95 : 0.35,
      lineJoin: 'round',
    })
      .addTo(map)
      .on('click', () => select(i));

    // No hover tooltip: the time and distance are on a permanent label
    // instead, so the information is there without asking for it.
    state.lines.push(line);
  }

  drawStops();
  drawWater();
  drawRouteLabels();
}

/**
 * A transit trip is drawn leg by leg: each ride solid, in its own line colour
 * from METRO's feed, and the walking dashed and grey. The distinction is the
 * whole point of the picture — a solid twelve-mile red line that turns into
 * two short dashes says "the train does almost all of this" faster than any
 * number on the card can.
 */
function drawTransitRoute(route, index, isSelected) {
  const dim = isSelected ? 1 : 0.4;
  for (const leg of legGeometries(route)) {
    const ride = leg.ride;
    const line = L.polyline(leg.points, {
      color: ride ? ride.color || route.color : '#64748b',
      weight: ride ? (isSelected ? 6 : 4) : isSelected ? 4 : 3,
      opacity: (ride ? 0.95 : 0.8) * dim,
      dashArray: ride ? null : '2 7',
      lineCap: ride ? 'round' : 'butt',
      lineJoin: 'round',
    })
      .addTo(map)
      .on('click', () => select(index));

    if (ride) {
      line.bindTooltip(
        `${escapeHtml(ride.shortName)} ${escapeHtml(ride.longName)}` +
          (ride.headsign ? `<br><small>toward ${escapeHtml(ride.headsign)}</small>` : ''),
        { sticky: true },
      );
    }
    state.lines.push(line);
  }
}

/**
 * A transit route's geometry split back into legs for drawing: one entry per
 * ride, carrying that ride, and one per run of walking steps carrying none.
 * The zero-length "get off here" steps are skipped — they mark a stop, not a
 * stretch of line.
 */
function legGeometries(route) {
  const legs = [];
  for (const step of route.legs[0]?.steps || []) {
    const points = (step.geometry?.coordinates || []).map(([lon, lat]) => [lat, lon]);
    if (points.length < 2) continue;

    const ride = step.mode === 'transit' ? step.transit : null;
    // A new leg starts at every ride, and wherever walking and riding meet.
    const current = legs[legs.length - 1];
    if (!current || ride || Boolean(current.ride) !== Boolean(ride)) {
      legs.push({ ride, points: [...points] });
      continue;
    }
    current.points.push(...points.slice(1));
  }
  return legs;
}

/** Boarding and alighting points on the selected trip. */
function drawStops() {
  if (state.stopLayer) {
    map.removeLayer(state.stopLayer);
    state.stopLayer = null;
  }
  const route = state.routes[state.selected];
  if (!route?.transit?.rides.length) return;

  state.stopLayer = L.layerGroup().addTo(map);
  for (const ride of route.transit.rides) {
    for (const [role, stop, time] of [
      ['board', ride.board, ride.board.departure],
      ['alight', ride.alight, ride.alight.arrival],
    ]) {
      L.marker(stop.coord, {
        icon: L.divIcon({
          className: '',
          html:
            `<div class="stop-pin stop-${role}"` +
            `${ride.color ? ` style="border-color:${ride.color}"` : ''}></div>`,
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        }),
        zIndexOffset: 650,
      })
        .bindTooltip(
          `<b>${escapeHtml(stop.name)}</b><br>${role === 'board' ? 'Board' : 'Get off'} ` +
            `${escapeHtml(ride.shortName)} · ${formatClock(time)}`,
          { direction: 'top' },
        )
        .addTo(state.stopLayer);
    }
  }
}

// A point `fraction` of the way along the line, used to hang the time pill
// somewhere on the route rather than at an endpoint.
function pointAlong(points, fraction) {
  let total = 0;
  const steps = [];
  for (let i = 1; i < points.length; i++) {
    const d = haversine(points[i - 1], points[i]);
    steps.push(d);
    total += d;
  }

  let target = total * fraction;
  for (let i = 0; i < steps.length; i++) {
    if (target <= steps[i]) {
      const t = steps[i] === 0 ? 0 : target / steps[i];
      const a = points[i];
      const b = points[i + 1];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    target -= steps[i];
  }
  return points[Math.floor(points.length / 2)];
}

// A label is roughly 70x34px, so clearance has to exceed its own width or
// two "clear" labels still overlap.
const LABEL_CLEARANCE_PX = 82;

/**
 * Where to hang a route's label. Normally its fixed position along the line;
 * if that lands on top of `avoid`, walk along the route in both directions
 * until the label is clear of it.
 */
/**
 * Where to hang one route's label.
 *
 * Three constraints, in order: it must be on screen, it must not cover the
 * manoeuvre you just selected, and it must not land on another route's label.
 * The last one matters most when zoomed in, because several routes share the
 * same visible stretch and every label would otherwise anchor to its middle.
 */
function labelPoint(route, avoid, placed = []) {
  const base = route.labelAt ?? 0.5;
  const view = map.getBounds();

  // Candidate positions along this route: its own fixed spot first, then
  // progressively further along in both directions.
  const fractions = [base];
  for (const step of [0.1, 0.2, 0.3, 0.4]) {
    fractions.push(base + step, base - step);
  }

  const obstacles = [...placed];
  if (avoid) obstacles.push(avoid);

  const clears = (point) => {
    const at = map.latLngToContainerPoint(point);
    return obstacles.every((o) => at.distanceTo(map.latLngToContainerPoint(o)) > LABEL_CLEARANCE_PX);
  };

  // Prefer a spot that is both visible and clear of everything already placed.
  const onRoute = fractions
    .filter((f) => f >= 0.04 && f <= 0.96)
    .map((f) => pointAlong(route.points, f));

  for (const point of onRoute) {
    if (view.contains(point) && clears(point)) return point;
  }

  // Nothing on its usual line works — walk the visible stretch instead, which
  // is what happens when the view is zoomed into part of the route.
  const visible = route.points.filter((p) => view.contains(p));
  if (visible.length) {
    const stride = Math.max(1, Math.floor(visible.length / 12));
    for (let i = Math.floor(visible.length / 2); i < visible.length; i += stride) {
      if (clears(visible[i])) return visible[i];
    }
    for (let i = Math.floor(visible.length / 2); i >= 0; i -= stride) {
      if (clears(visible[i])) return visible[i];
    }
    // Everything collides; the middle of what is visible still beats off screen.
    return visible[Math.floor(visible.length / 2)];
  }

  return pointAlong(route.points, base);
}


/** Google-style time pills sitting on each route line. */
function drawRouteLabels() {
  if (state.labelLayer) {
    map.removeLayer(state.labelLayer);
    state.labelLayer = null;
  }
  if (!state.routes.length) return;

  state.labelLayer = L.layerGroup().addTo(map);

  // The focused turn marker must stay readable; a label sitting on top of it
  // is worse than a label a little further along the line.
  const avoid =
    state.activeStep != null ? state.directions[state.activeStep]?.location : null;

  const placed = [];

  state.routes.forEach((route, i) => {
    const isSelected = i === state.selected;
    // route.labelAt is fixed per route (see compare) so overlapping
    // alternatives keep distinct, stable label positions.
    const at = labelPoint(route, avoid, placed);
    placed.push(at);

    L.marker(at, {
      icon: L.divIcon({
        className: 'route-label',
        html:
          `<div class="route-pill ${isSelected ? 'is-selected' : ''}"` +
          `${isSelected ? ` style="background:${route.color};border-color:${route.color}"` : ''}>` +
          `<span class="route-pill-icon">${MODES[state.mode].icon}</span>` +
          `<span class="route-pill-text"><b>${formatDuration(route.duration)}</b>` +
          `<small>${formatDistance(route.distance)}</small></span></div>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      }),
      // Selected label on top, and above the water pins.
      zIndexOffset: isSelected ? 800 : 700,
      interactive: true,
    })
      .on('click', () => select(i))
      .addTo(state.labelLayer);
  });
}

/**
 * How much of the map is hidden by furniture sitting on top of it, in pixels
 * per edge. On a phone the bottom sheet covers the lower part of a
 * full-screen map, so "centre of the map" is not the centre of the element —
 * it is the centre of what you can actually see.
 */
function mapInsets() {
  const base = window.innerWidth < 560 ? 24 : window.innerWidth < 900 ? 36 : 50;
  const insets = { top: base, bottom: base, left: base, right: base };
  if (!state.sheet?.isMobile()) return insets;

  const mapRect = map.getContainer().getBoundingClientRect();
  const sheetTop = el('panel').getBoundingClientRect().top;
  const covered = Math.max(0, mapRect.bottom - sheetTop);

  // Leave the view something to work with when the sheet is nearly full.
  insets.bottom = base + Math.min(covered, mapRect.height * 0.6);
  // Clear the floating tools and weights panel along the top edge.
  insets.top = base + 44;
  return insets;
}

function boundsOptions() {
  const { top, bottom, left, right } = mapInsets();
  return {
    paddingTopLeft: [left, top],
    paddingBottomRight: [right, bottom],
  };
}

function fitToRoutes() {
  const bounds = L.latLngBounds(state.routes.flatMap((r) => r.points));
  map.fitBounds(bounds, boundsOptions());
}

/**
 * Shift a target point so it lands in the middle of the *visible* map rather
 * than the middle of the element, for the cases where there is no extent to
 * fit and flyToBounds cannot be used.
 */
function offsetForVisibleArea(coord) {
  const { top, bottom } = mapInsets();
  const shift = (bottom - top) / 2;
  if (Math.abs(shift) < 1) return coord;
  const point = map.project(coord, map.getZoom());
  return map.unproject(L.point(point.x, point.y + shift), map.getZoom());
}

/** Frame one route inside the visible part of the map. */
function focusRoute(index) {
  const route = state.routes[index];
  if (!route) return;
  map.flyToBounds(L.latLngBounds(route.points), { ...boundsOptions(), duration: 0.55 });
}

/* ---------------------------------------------------------- map picks --- */

/**
 * What the map is currently *about*.
 *
 * Resolved in the order a person would expect: the turn they clicked beats the
 * route it belongs to, which beats a layer they switched on, which beats the
 * two pins. Returns null only on a blank map.
 */
function recenterTarget() {
  const step = state.activeStep != null ? state.directions[state.activeStep] : null;
  if (step?.points?.length) {
    return { label: 'this turn', bounds: L.latLngBounds(step.points) };
  }

  const route = state.routes[state.selected];
  if (route?.points?.length) {
    return { label: 'your route', bounds: L.latLngBounds(route.points) };
  }

  if (state.priorityLayer && sitesCache.length) {
    return { label: 'the priority sites', bounds: L.latLngBounds(sitesCache.map((site) => site.coord)) };
  }

  if (state.demandLayer) {
    return { label: 'the demand layer', bounds: state.demandLayer.getBounds() };
  }

  const pins = ['origin', 'destination']
    .map((role) => state.places[role]?.coord)
    .filter(Boolean);
  if (pins.length === 2) return { label: 'your trip', bounds: L.latLngBounds(pins) };
  if (pins.length === 1) return { label: 'your start', bounds: L.latLngBounds([pins[0], pins[0]]) };

  return null;
}

function recenterMap() {
  const target = recenterTarget();
  if (!target) {
    map.flyTo(HOUSTON_CENTER, 12, { duration: 0.55 });
    return;
  }
  map.flyToBounds(target.bounds, { ...boundsOptions(), duration: 0.55, maxZoom: 17 });
}

/**
 * Light the button only when it has something to do — which is the whole
 * reason Google's appears when it does. "Away" means the thing being shown is
 * no longer fully on screen.
 */
function syncRecenter() {
  const button = el('recenter-btn');
  if (!button) return;
  const target = recenterTarget();
  button.title = target ? `Recentre on ${target.label}` : 'Recentre on Houston';
  button.setAttribute(
    'aria-label',
    target ? `Recentre the map on ${target.label}` : 'Recentre the map on Houston',
  );
  const away = target ? !map.getBounds().contains(target.bounds) : false;
  button.classList.toggle('is-away', away);
}

function armPick(role) {
  state.pick = state.pick === role ? null : role;
  // Scoped to the pick buttons only. The layer toggles beside them share the
  // class and own their own armed state, and an unscoped query cleared their
  // highlight while their layer was still on the map.
  document.querySelectorAll('.pick-btn[data-pick]').forEach((btn) => {
    btn.classList.toggle('is-armed', btn.dataset.pick === state.pick);
  });
  map.getContainer().classList.toggle('map-picking', Boolean(state.pick));

  // Arming used to announce itself with a coloured button, a crosshair, and a
  // line of status text in the sidebar — none of which is where the eye is once
  // someone has decided to click the map. The banner sits over the map and says
  // what to do and how to stop.
  const banner = el('pick-banner');
  if (state.pick) {
    const what = state.pick === 'origin' ? 'start' : 'finish';
    el('pick-banner-text').textContent = `Click the map to set your ${what}`;
    banner.hidden = false;
    setStatus(`Click the map to set the ${what}.`);
  } else {
    banner.hidden = true;
  }
}

map.on('click', async (event) => {
  if (!state.pick) return;
  const role = state.pick;
  const coord = [event.latlng.lat, event.latlng.lng];
  armPick(null);

  setStatus('Naming that spot…');
  const place = await describeCoordinate(coord);
  applyPlace(role, place);
  setStatus(`${role === 'origin' ? 'Start' : 'Finish'} set to ${place.label}.`);
  markStale(`${role === 'origin' ? 'Start' : 'Finish'} changed.`);
});

/* ------------------------------------------------------------- status --- */

function setStatus(message, isError = false) {
  const node = el('status');
  node.textContent = message;
  node.classList.toggle('is-error', isError);
}

/**
 * Record that an input changed without going and fetching anything.
 *
 * Searching is expensive — a comparison is an OSRM call, an Overpass download
 * over the corridor, and for METRO three timetable queries — and it used to
 * fire on its own from seven different places: picking a suggestion, clicking
 * the map, dragging a pin, swapping ends, geolocating, switching mode, moving
 * the departure time. Now those only say what changed; the button does the work.
 *
 * The one thing that must not happen is a stale list looking current, so the
 * results keep their place on screen and are labelled for what they are.
 */
function markStale(reason) {
  if (!state.routes.length && !state.rawRoutes.length) {
    // Nothing on screen to go stale — just let the button speak for itself.
    state.stale = null;
    renderStale();
    return;
  }
  state.stale = reason;
  renderStale();
}

function clearStale() {
  state.stale = null;
  renderStale();
}

function renderStale() {
  const note = el('stale-note');
  const chip = el('stale-chip');
  const button = el('compare-btn');

  note.hidden = !state.stale;
  chip.hidden = !state.stale;
  button.classList.toggle('is-pending', Boolean(state.stale));

  if (state.stale) {
    note.innerHTML =
      `${escapeHtml(state.stale)} The routes below are from your last search — ` +
      `hit <b>Compare routes</b> to update them.`;
  }
}

function setBusy(busy) {
  state.busy = busy;
  el('compare-btn').disabled = busy;
  el('compare-btn').textContent = busy ? 'Comparing…' : 'Compare routes';
}

/* ------------------------------------------------------ place search --- */

const PLACE_ICONS = {
  preset: '⭐',
  coordinate: '📌',
  stadium: '🏟',
  park: '🌳',
  garden: '🌳',
  water: '💧',
  university: '🎓',
  school: '🎓',
  hotel: '🛏',
  restaurant: '🍽',
  bus_stop: '🚏',
  station: '🚉',
  house: '🏠',
  residential: '🏠',
  lookup: '🔎',
  alias: '🔤',
  street: '🛣',
  primary: '🛣',
  secondary: '🛣',
  tertiary: '🛣',
};

function placeIcon(kind) {
  return PLACE_ICONS[kind] || '📍';
}

function applyPlace(role, place) {
  state.places[role] = place;
  el(role === 'origin' ? 'origin-input' : 'dest-input').value = place.label;
  setMarker(role, place);
}

/**
 * Turns one text input into a real search box: debounced suggestions from the
 * geocoder, keyboard navigation, and a resolved place object on selection.
 */
function createCombo(role, inputId, listId) {
  const input = el(inputId);
  const list = el(listId);
  let items = [];
  let active = -1;
  let controller = null;
  let timer = null;

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  }

  function render() {
    if (!items.length) {
      close();
      return;
    }
    list.innerHTML = items
      .map(
        (place, i) => `
        <li class="suggestion ${i === active ? 'is-active' : ''}" role="option"
            aria-selected="${i === active}" data-index="${i}">
          <span class="suggestion-icon">${placeIcon(place.kind)}</span>
          <span class="suggestion-text">
            <span class="suggestion-label">${escapeHtml(place.label)}</span>
            <span class="suggestion-detail">${escapeHtml(place.detail || '')}</span>
          </span>
        </li>`,
      )
      .join('');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  async function choose(index) {
    const place = items[index];
    if (!place) return;
    close();

    // A "look up this address" row has no coordinate yet — resolve it now.
    if (!place.coord) {
      setStatus(`Looking up ${place.query}…`);
      try {
        applyPlace(role, await resolvePlace(place.query));
      } catch (err) {
        setStatus(err.message, true);
        return;
      }
    } else {
      applyPlace(role, place);
    }

    const label = role === 'origin' ? 'Start' : 'Finish';
    setStatus(
      state.places.origin && state.places.destination
        ? `${label} set. Hit Compare routes when you are ready.`
        : `${label} set to ${state.places[role].label}.`,
    );
    markStale(`${label} changed.`);
  }

  async function search() {
    controller?.abort();
    controller = new AbortController();
    try {
      items = await suggestPlaces(input.value, { signal: controller.signal });
      active = -1;
      render();
    } catch (err) {
      if (err.name !== 'AbortError') close();
    }
  }

  input.addEventListener('input', () => {
    // Typing invalidates the previously resolved place for this field, which
    // is exactly what makes the routes on screen out of date. (Setting the
    // box from code does not fire this, so picking a suggestion cannot
    // trigger it twice.)
    state.places[role] = null;
    markStale(`${role === 'origin' ? 'Start' : 'Finish'} changed.`);
    clearTimeout(timer);
    timer = setTimeout(search, 220);
  });

  input.addEventListener('focus', () => {
    if (!input.value.trim()) search();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (list.hidden) {
        search();
        return;
      }
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + items.length) % items.length;
      render();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!list.hidden && active >= 0) choose(active);
      else compare();
      return;
    }
    if (event.key === 'Escape') close();
  });

  // mousedown, not click: blur would otherwise close the list first.
  list.addEventListener('mousedown', (event) => {
    const node = event.target.closest('.suggestion');
    if (!node) return;
    event.preventDefault();
    choose(Number(node.dataset.index));
  });

  input.addEventListener('blur', () => setTimeout(close, 120));

  return { close };
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/** Whatever is in the box, turned into a place — typed, picked, or dragged. */
async function ensurePlace(role) {
  if (state.places[role]) return state.places[role];

  const input = el(role === 'origin' ? 'origin-input' : 'dest-input');
  const text = input.value.trim();

  if (!text) {
    applyPlace(role, DEFAULT_TRIP[role]);
    return DEFAULT_TRIP[role];
  }

  const place = await resolvePlace(text);
  applyPlace(role, place);
  return place;
}

/* ----------------------------------------------------------- pipeline --- */

async function compare() {
  // A request arriving mid-run is not noise to be dropped — it is someone
  // changing the departure time or the mode and expecting an answer. Remember
  // it and re-run once the current comparison lets go.
  if (state.busy) {
    state.queued = true;
    return;
  }
  state.queued = false;
  clearStale();
  setBusy(true);
  setStatus('Finding your start and finish…');

  try {
    const origin = await ensurePlace('origin');
    const destination = await ensurePlace('destination');

    const straight = haversine(origin.coord, destination.coord);

    // Start and finish on the same spot produces a zero-length "route" that
    // scores like any other and wins every badge going — fastest, shortest,
    // greenest — on a trip nobody is taking.
    if (straight < 25) {
      clearResults();
      setStatus('Start and finish are the same place. Pick two different points.', true);
      return;
    }

    const ceiling = MODES[state.mode].maxTripKm * 1000;
    if (straight > ceiling) {
      // Only suggest modes that actually clear this distance. Naming one that
      // does not just moves the refusal one click away: at 232 km "try Bike"
      // was a dead end, because bike stops at 120.
      const viable = Object.entries(MODES)
        .filter(([key, cfg]) => key !== state.mode && straight <= (cfg.maxTripKm ?? Infinity) * 1000)
        // Gentlest upgrade first, so the nearest workable option leads.
        .sort((a, b) => (a[1].maxTripKm ?? Infinity) - (b[1].maxTripKm ?? Infinity))
        .map(([, cfg]) => cfg.label);

      const suggestion = viable.length
        ? `Try ${viable.length > 1 ? `${viable.slice(0, -1).join(', ')} or ${viable.at(-1)}` : viable[0]}.`
        : 'No mode here covers that distance.';

      const tooFar = isTransit()
        ? "further than METRO's network reaches"
        : `too far to ${MODES[state.mode].label.toLowerCase()}`;
      clearResults();
      setStatus(
        `That is ${Math.round(straight / 1000)} km in a straight line — ${tooFar}. ${suggestion}`,
        true,
      );
      return;
    }

    setStatus(
      isTransit()
        ? 'Asking METRO\u2019s timetable for the trips that work…'
        : 'Asking the router for every sensible way there…',
    );

    let candidates;
    if (isTransit()) {
      candidates = await fetchTransitCandidates(origin, destination);
    } else {
      candidates = await fetchBaseRoutes(state.mode, origin.coord, destination.coord);
    }

    let layer = null;

    // What to download the green layer over. On a transit trip the only part
    // that has to be scored for shade is the walking, and a bbox drawn around
    // a twelve-mile rail corridor is both a slow Overpass query and an
    // answer about nothing. The walk to the stop is usually a few blocks.
    const scored = candidates.flatMap((route) =>
      route.transit?.walkPoints?.length ? route.transit.walkPoints : [route.points],
    );
    const span = isTransit()
      ? Math.max(...candidates.map((r) => r.transit?.walkM ?? r.distance), 0)
      : straight;

    if (span > 60000) {
      setStatus('Trip is long — scoring on road type and directness only.');
    } else {
      setStatus('Downloading parks, bayous and tree canopy from OpenStreetMap…');
      // Small, cached after the first call, and scoring reads it synchronously.
      await loadWalkability();
      const bbox = padBbox(bboxOf(scored), isTransit() ? 400 : 2000);
      try {
        layer = await loadGreenLayer(bbox);
      } catch {
        setStatus('OpenStreetMap green data unavailable — scoring on road type only.', true);
      }
    }

    // A bus route is not ours to reroute through a park.
    if (layer && !isTransit()) {
      setStatus('Building greener alternatives through nearby parks…');
      const vias = pickGreenViaPoints(layer.areas, origin.coord, destination.coord, 3);
      const detours = await Promise.allSettled(
        vias.map((via) =>
          fetchViaRoute(
            state.mode,
            origin.coord,
            destination.coord,
            via.centroid,
            via.name ? `via ${via.name}` : 'green detour',
          ),
        ),
      );
      for (const result of detours) {
        if (result.status === 'fulfilled') candidates.push(result.value);
      }
      candidates = dedupe(candidates);
    }

    // Drop absurd detours: nobody walks 3x as far for a nicer view. Transit
    // options are already real timetabled trips, so the only thing worth
    // trimming there is the length of the list.
    if (isTransit()) {
      // Late at night a bus-only or rail-only search can answer with something
      // technically valid and practically absurd — three transfers and a
      // four-hour wait. Judge transit on time rather than distance: the ride
      // length is not the rider's cost, the clock is.
      const quickest = Math.min(...candidates.map((r) => r.duration));
      const tightest = Math.min(...candidates.map((r) => r.distance));
      candidates = candidates.filter(
        (r) =>
          r.duration <= Math.max(quickest * 2.2, quickest + 1800) &&
          // Time alone lets an absurdity through: riding the Red Line out,
          // a bus across, and the Red Line back covers 20 km for a 5 km trip
          // and still lands inside the time cap.
          r.distance <= tightest * 2.5,
      );
    } else {
      const shortest = Math.min(...candidates.map((r) => r.distance));
      candidates = candidates.filter((r) => r.distance <= shortest * 1.9);
    }
    candidates = candidates.slice(0, 6);

    // Colour belongs to the route, and is assigned here exactly once.
    // Everything downstream reads route.color instead of its list index, so
    // changing the weights reorders the list without repainting the map.
    // The label offset is pinned here too, so labels stay put on rerank
    // instead of sliding along their lines.
    const offsets = [0.5, 0.38, 0.62, 0.28, 0.72, 0.45];
    const used = new Set();
    candidates.forEach((route, i) => {
      // A METRORail trip drawn in anything but red is a worse map. The line
      // colour comes out of METRO's feed (`route_color`), so the Red Line is
      // red because METRO says it is — but two candidates sharing a colour
      // would be unreadable, so a clash falls back to the palette.
      const own = route.transit?.rides[0]?.color;
      route.color = own && !used.has(own) ? own : ROUTE_COLORS[i % ROUTE_COLORS.length];
      used.add(route.color);
      route.labelAt = offsets[i % offsets.length];
    });

    // The forecast is for where the trip is, which is neither endpoint when the
    // two are far apart. It is deliberately not awaited before scoring: a
    // weather outage must cost the heat card, never the routes.
    const midpoint = [
      (origin.coord[0] + destination.coord[0]) / 2,
      (origin.coord[1] + destination.coord[1]) / 2,
    ];
    loadConditions(midpoint)
      .then((conditions) => {
        state.conditions = conditions;
        renderHeat();
        renderDetail();
      })
      .catch(() => {
        state.conditions = null;
        renderHeat();
      });

    state.layer = layer;
    state.rawRoutes = candidates;
    state.selected = 0;
    rescore({ fit: true });

    setStatus(isTransit() ? describeTransitRun(candidates, layer) : describeRun(candidates.length, layer));

    // On a phone the results are inside the sheet, so bring it up far enough
    // to show them rather than leaving the answer hidden below the fold.
    if (state.sheet?.isMobile() && state.sheet.current() === 'min') {
      state.sheet.snapTo('half');
    }
  } catch (err) {
    console.error(err);
    clearResults();
    setStatus(err.message || 'Something went wrong. Try again.', true);
  } finally {
    setBusy(false);
    if (state.queued) compare();
  }
}

/** The instant the trip should be planned around, from the When? controls. */
function departureTime() {
  const value = el('when-time').value;
  return value ? houstonWallTimeToDate(value) : new Date();
}

/**
 * Ask METRO's timetable for the trips that work, and turn them into
 * candidates the rest of the pipeline can score.
 *
 * The walk-only fallback is not a consolation prize: MOTIS will not return a
 * transit option slower than simply walking, so on a short trip an empty list
 * plus "it is quicker to walk" is the true answer, and the one worth giving.
 */
async function fetchTransitCandidates(origin, destination) {
  const when = departureTime();
  const arriveBy = state.when.kind === 'arrive';
  const { routes, walkOnly, stepFreeCost } = await planTransit(origin.coord, destination.coord, {
    when,
    arriveBy,
    stepFree: state.stepFree,
  });

  state.transitNote = '';
  state.stepFreeCost = stepFreeCost;
  const candidates = [...routes];

  if (walkOnly) {
    // Only worth offering when it is a walk a person would actually make.
    if (walkOnly.distance < 3500) candidates.push(walkOnly);
    if (!routes.length) {
      state.transitNote =
        'No scheduled METRO trip beats walking this one, so the walk is the answer.';
    }
  }

  if (!candidates.length) {
    // Distinguish "METRO does not go there" from "METRO goes there, but not
    // step-free". The second is a finding about Houston, not a dead end.
    if (state.stepFree && stepFreeCost?.blocked) {
      throw new Error(
        `No step-free METRO trip found between those points. On foot the ` +
          `${stepFreeCost.baseline.routes.join(' → ')} does it in ` +
          `${stepFreeCost.baseline.minutes} min. OpenStreetMap's kerb and crossing data is ` +
          `patchy, so check METRO directly before believing it.`,
      );
    }
    throw new Error(
      `No METRO trip found between those points ${
        arriveBy ? 'arriving by' : 'leaving around'
      } ${formatClock(when)} on ${formatDay(when)}. Try another time, or a point closer to a stop.`,
    );
  }
  return candidates;
}

function describeTransitRun(candidates, layer) {
  const rides = candidates.filter((route) => route.transit?.rides.length);
  const numbers = [
    ...new Set(rides.flatMap((route) => route.transit.rides.map((ride) => ride.shortName))),
  ].filter(Boolean);

  const head = rides.length
    ? `${rides.length} METRO trip${rides.length === 1 ? '' : 's'} on the published timetable` +
      (numbers.length ? ` — route${numbers.length === 1 ? '' : 's'} ${numbers.join(', ')}` : '')
    : 'No METRO trip on the timetable for that time';

  const walking = layer
    ? ', scored on the walking legs against OpenStreetMap parks and canopy'
    : '';
  return `${head}${walking}.${state.transitNote ? ` ${state.transitNote}` : ''}`;
}

/**
 * What the collapsed sheet says about itself: the trip on top, the result
 * underneath. Minimised, this is the only thing on screen, so it has to name
 * the trip rather than just count routes.
 */
function updatePeek() {
  const { origin, destination } = state.places;
  const count = state.routes.length;

  el('sheet-trip').textContent =
    origin && destination ? `${origin.label} → ${destination.label}` : 'Plan a trip';

  const route = state.routes[state.selected];
  el('sheet-sub').textContent = count
    ? `${formatDuration(route.duration)} · ${formatDistance(route.distance)} · ` +
      `${count} route${count === 1 ? '' : 's'} ${MODES[state.mode].gerund}`
    : 'Search a start and a destination';

  // The handle just changed height, so the minimised stop moved with it.
  state.sheet?.refresh();
}

function describeRun(count, layer) {
  if (!layer) return `${count} routes compared on road type and directness only.`;

  const where = {
    overpass: 'live OpenStreetMap data',
    cache: 'cached OpenStreetMap data',
    bundle: 'the bundled Houston extract (Overpass was unreachable)',
  }[layer.source];

  const scope = layer.partial ? ' Part of this trip runs outside the bundled area.' : '';
  return (
    `${count} routes compared against ${layer.counts.parks.toLocaleString()} green areas, ` +
    `${layer.counts.trees.toLocaleString()} mapped trees and ` +
    `${layer.counts.water.toLocaleString()} drinking fountains, from ${where}.${scope}`
  );
}

/**
 * Take the last result off the screen.
 *
 * A failed run has already moved the pins to the points it rejected, so
 * leaving the previous routes drawn puts a Houston route on the map under a
 * destination pin in Dallas, with an error message above it — three things on
 * screen that disagree. Better to show the error and nothing else.
 */
function clearResults() {
  state.rawRoutes = [];
  state.routes = [];
  state.directions = [];
  state.activeStep = null;
  state.selected = 0;
  state.stepFreeCost = null;
  state.heatHour = null;
  clearRouteLines();
  if (state.waterLayer) {
    map.removeLayer(state.waterLayer);
    state.waterLayer = null;
  }
  if (state.labelLayer) {
    map.removeLayer(state.labelLayer);
    state.labelLayer = null;
  }
  for (const id of [
    'results-card',
    'transit-card',
    'profile-card',
    'directions-card',
    'water-card',
    'detail-card',
    'heat-card',
  ]) {
    el(id).hidden = true;
  }
  el('legend').hidden = true;
  updatePeek();
}

function rescore({ fit = false } = {}) {
  if (!state.rawRoutes?.length) return;

  const scored = assignBadges(
    scoreRoutes(state.rawRoutes, state.layer, state.mode, state.normalised, state.scoreMode),
  );
  scored.sort((a, b) => b.pleasantness - a.pleasantness);
  nameRoutes(scored);

  state.routes = scored;

  // Selection is by rank, not by route. Reweighting is a question about the
  // ranking itself, so staying on rank 2 and seeing whatever now ranks 2nd is
  // the useful answer — the alternative pulls your view away from the top of
  // a list you just reordered.
  state.selected = Math.min(state.selected, scored.length - 1);

  renderRoutes();
  renderHeat();
  renderTransit();
  renderDirections();
  renderRouteProfile();
  renderWater();
  renderDetail();
  drawRoutes();
  renderLegend();
  updatePeek();
  if (fit) fitToRoutes();
}

const letter = (i) => String.fromCharCode(65 + i);

// Named parks make the best labels; everything else falls back to letters,
// and unnamed detours get numbered so two of them never collide.
function nameRoutes(routes) {
  let plain = 0;
  let detour = 0;
  for (const route of routes) {
    // A transit trip names itself: the route numbers are the name, which is
    // also what a rider has to remember. "Route B" would be a worse label
    // than the one METRO already prints on the side of the bus.
    if (route.transit) {
      const rides = route.transit.rides;
      route.name = rides.length
        ? rides.map((ride) => ride.shortName || ride.longName).join(' → ')
        : 'Walk the whole way';
      continue;
    }
    if (route.source.startsWith('via ')) {
      route.name = route.source.replace(/^via /, 'Via ');
    } else if (route.source === 'green detour') {
      detour += 1;
      route.name = `Park detour ${detour}`;
    } else {
      route.name = `Route ${letter(plain)}`;
      plain += 1;
    }
  }
}

function select(index, { focus = true } = {}) {
  state.selected = index;
  state.activeStep = null;
  renderRoutes();
  renderHeat();
  renderTransit();
  renderDirections();
  renderRouteProfile();
  renderWater();
  renderDetail();
  drawRoutes();
  renderLegend();
  updatePeek();
  if (focus) focusRoute(index);
}

/* ------------------------------------------------------------ render --- */

function bar(label, value) {
  const pct = Math.round(value * 100);
  // Titled, because a bare "52%" begs the question "of what?" and the answer
  // is the same for all three: of the distance you travel.
  return `
    <div class="bar" title="${pct}% of this route">
      <span>${label}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
      <span class="bar-val">${pct}%</span>
    </div>`;
}

/**
 * The trip as a row of chips: walk, then each route number in its own line
 * colour, then walk. It is the one part of a transit result people read
 * before anything else — "is this the train or two buses?" — so it sits at
 * the top of the card, above the score.
 */
function legStrip(route) {
  if (!route.transit) return '';
  const chips = route.transit.legs.map((leg) => {
    if (leg.kind === 'walk') {
      return `<span class="leg leg-walk">🚶 ${stepDistance(leg.distance)}</span>`;
    }
    const ride = leg.ride;
    const vehicle = VEHICLES[ride.vehicle] || VEHICLES.bus;
    const style = ride.color
      ? ` style="background:${ride.color};color:${ride.textColor || '#fff'};border-color:${ride.color}"`
      : '';
    return (
      `<span class="leg leg-ride"${style} title="${escapeHtml(ride.longName)}">` +
      `${vehicle.icon} ${escapeHtml(ride.shortName || ride.longName)}</span>`
    );
  });
  return `<div class="legs">${chips.join('<span class="leg-join">›</span>')}</div>`;
}

function renderRoutes() {
  el('results-card').hidden = state.routes.length === 0;

  el('routes').innerHTML = state.routes
    .map((route, i) => {
      const m = route.metrics;
      // On a walk or a ride, extra distance is the cost. On a bus it is not —
      // the rider is sitting down either way — so a transit trip is flagged
      // for the minutes it costs against the quickest option instead.
      const quickest = Math.min(...state.routes.map((r) => r.duration));
      const slowerMin = Math.round((route.duration - quickest) / 60);
      const penalty = route.transit
        ? slowerMin >= 5
          ? [`<span class="badge warn">+${slowerMin} min slower</span>`]
          : []
        : m.detourPct > 12
          ? [`<span class="badge warn">+${Math.round(m.detourPct)}% longer</span>`]
          : [];

      const badges = route.badges
        .map((b) => `<span class="badge">${b.label}</span>`)
        .concat(penalty)
        .join('');

      return `
        <div class="route ${i === state.selected ? 'is-selected' : ''}" data-index="${i}">
          <div class="route-top">
            <span class="route-name">
              <span class="route-swatch" style="background:${route.color}"></span>
              ${escapeHtml(route.name)}
            </span>
            <span class="route-score"><b>${Math.round(route.pleasantness)}</b>/100</span>
          </div>
          <div class="route-sub">
            ${
              route.transit?.rides.length
                ? `${formatClock(route.transit.startTime)} → ${formatClock(route.transit.endTime)} · `
                : ''
            }${formatDuration(route.duration)} · ${formatDistance(route.distance)} ·
            ${m.co2Kg < 0.05 ? 'zero tailpipe CO₂' : `${m.co2Kg.toFixed(1)} kg CO₂`}
          </div>
          ${legStrip(route)}
          <div class="badges">${badges}</div>
          <div class="bars">
            ${bar(route.transit ? 'Green on foot' : 'Green', m.greenShare)}
            ${bar(route.transit ? 'Shade on foot' : 'Shade', m.shadeShare)}
            ${bar('Away from traffic', 1 - m.bigRoadShare)}
          </div>
        </div>`;
    })
    .join('');

  el('routes')
    .querySelectorAll('.route')
    .forEach((node) => node.addEventListener('click', () => select(Number(node.dataset.index))));
}

function stat(label, value, note) {
  return `
    <div class="stat">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}</div>
      ${note ? `<div class="stat-note">${note}</div>` : ''}
    </div>`;
}

function renderDetail() {
  const route = state.routes[state.selected];
  el('detail-card').hidden = !route;
  if (!route) return;

  const m = route.metrics;
  const mode = MODES[state.mode];
  const t = route.transit;

  // The headline number for a transit trip is not how long it takes, it is how
  // long it leaves you outside: the walk to the stop plus the wait at it.
  // Twelve air-conditioned miles on the Red Line cost nothing in heat.
  // The forecast turns the exposure figure from a geometry result into a
  // physical one: twenty-three unshaded minutes means nothing until you know
  // whether it is 72°F or 104°F out there.
  const now = tripConditions();
  const band = now ? heatBand(now.heatIndex) : null;
  const feels = now ? `feels like ${Math.round(now.heatIndex)}°F` : null;

  const heatCard = t
    ? stat(
        'Unshaded outdoors',
        `${Math.round(m.exposedMinutes)} min`,
        feels
          ? `${feels} — the ride is indoors, the ${Math.round(m.outdoorMinutes)} min outside is not`
          : `of ${Math.round(m.outdoorMinutes)} min walking and waiting — the ride is indoors`,
      )
    : mode.heatExposed
      ? stat(
          'Unshaded time',
          `${Math.round(m.exposedMinutes)} min`,
          feels
            ? `${feels}, ${escapeHtml(band.label.toLowerCase())}`
            : `${Math.round(m.shadeShare * 100)}% of this route has mapped canopy`,
        )
      : stat(
          'In traffic',
          formatDuration(route.duration),
          feels ? `${feels} outside — you are not in it` : 'Air-conditioned, but still emitting',
        );

  const carbon =
    m.co2Kg < (MODES.car.co2PerKm * m.km) / 1000
      ? stat(
          'CO₂ avoided',
          `${m.co2SavedVsDrivingKg.toFixed(2)} kg`,
          t?.rides.length
            ? `vs. driving solo — this trip emits ${m.co2Kg.toFixed(2)} kg`
            : 'vs. driving the same trip solo',
        )
      : stat('CO₂ emitted', `${m.co2Kg.toFixed(2)} kg`, `${m.transitCo2Kg.toFixed(2)} kg by METRO bus`);

  el('impact-sources').innerHTML = IMPACT_SOURCES.map(
    (entry) => `<li><b>${escapeHtml(entry.figure)}</b>${escapeHtml(entry.source)}</li>`,
  ).join('');

  el('detail').innerHTML = `
    <div class="stats">
      ${heatCard}
      ${carbon}
      ${
        // Ozone is Houston's own pollutant and it peaks on exactly the hot,
        // still afternoons this app is about. It only takes a slot from the
        // water stats when it is high enough to change what somebody does —
        // and it matters most to the people breathing hardest.
        now && Number.isFinite(now.aqi) && now.aqi >= 101 && mode.heatExposed
          ? stat(
              'Air quality',
              `${now.aqi} AQI`,
              `${escapeHtml(aqiBand(now.aqi).label.toLowerCase())} · ozone ${Math.round(now.ozone)} µg/m³`,
            )
          : m.waterStops
            ? stat(
                'Water stops',
                String(m.waterStops),
                `longest dry stretch ${formatDistance(m.longestDryKm * 1000)}`,
              )
            : stat('Beside green space', `${Math.round(m.greenShare * 100)}%`, 'parks, bayous, tree cover')
      }
      ${
        t?.rides.length
          ? stat(
              'Transfers',
              String(t.transfers),
              `${Math.round(t.waitSec / 60)} min waiting at stops`,
            )
          : mode.kcalPerKm
            ? stat('Energy burned', `${Math.round(m.kcal)} kcal`, `${m.turns} turns to remember`)
            : stat('Trip cost', `$${m.cost.toFixed(2)}`, 'fuel, wear, and depreciation')
      }
    </div>
    <p class="hint" style="margin:12px 0 0">
      ${
        t
          ? `${Math.round(m.bigRoadShare * 100)}% of the walking on this trip runs beside a ` +
            `freeway or major arterial, and you burn about ${Math.round(m.kcal)} kcal getting ` +
            `to and from the stops. Riding is not scored: green space, shade and traffic all ` +
            `stop mattering once the doors close.`
          : `${Math.round(m.bigRoadShare * 100)}% of this route runs along a freeway or major arterial. ` +
            (m.detourPct > 1
              ? `It is ${Math.round(m.detourPct)}% longer than the shortest option.`
              : 'It is also the shortest option available.')
      }
    </p>`;
}

/* -------------------------------------------------------------- heat --- */

/** The Houston wall-clock string the trip is planned around. */
function whenWall() {
  return el('when-time').value || dateToHoustonWallTime(new Date());
}

/** Conditions over the span the selected route actually occupies. */
function tripConditions() {
  const route = state.routes[state.selected];
  if (!route || !state.conditions) return null;
  // A transit trip starts when its first vehicle does, not when you asked.
  const start = route.transit?.startTime
    ? dateToHoustonWallTime(route.transit.startTime)
    : whenWall();
  return conditionsOver(state.conditions, start, route.duration);
}

/**
 * The hour strip: heat index across the afternoon, and a picker for it.
 *
 * This is the only chart in the app that is also a control, and that is the
 * point of it. The route cards answer "which way"; this answers the question
 * underneath, which in Houston is usually "should I go now at all". Clicking
 * an hour re-plans at that hour — instantly for walking, cycling and driving,
 * where the roads do not care what time it is, and with a fresh timetable
 * lookup for METRO, where they very much do.
 *
 * Colour encodes the National Weather Service band rather than a continuous
 * temperature, because the bands are the part that carries meaning. Five steps
 * of one hue, light to dark, validated for lightness monotonicity rather than
 * chosen by eye. The band is always named in text beside it.
 */
function renderHeat() {
  const card = el('heat-card');
  const route = state.routes[state.selected];
  const conditions = state.conditions;
  card.hidden = !route || !conditions;
  if (card.hidden) return;

  const startWall = route.transit?.startTime
    ? dateToHoustonWallTime(route.transit.startTime)
    : whenWall();
  const hours = hoursFrom(conditions, startWall, 12);
  if (!hours.length) {
    // The forecast runs out long before METRO's timetable does.
    card.hidden = true;
    return;
  }

  const selectedStamp = state.heatHour || `${startWall.slice(0, 13)}:00`;
  const now = tripConditions();
  const band = now ? heatBand(now.heatIndex) : null;

  el('heat-title').textContent = `Heat along the way · ${route.name}`;

  // A driver is not in the weather, and telling them how many unshaded minutes
  // they face — zero — while offering to find them a cooler hour is advice for
  // somebody else's trip. The conditions still belong on screen for them,
  // because they are the reason the other three modes look the way they do.
  const exposedToIt = MODES[state.mode].heatExposed;

  if (now && band) {
    const exposed = Math.round(route.metrics.exposedMinutes);
    const conditionsPart =
      `Feels like <b>${Math.round(now.heatIndex)}°F</b> (${escapeHtml(band.label)}) — ` +
      `air ${Math.round(now.tempF)}°F at ${Math.round(now.humidity)}% humidity.`;

    el('heat-summary').innerHTML = exposedToIt
      ? `${conditionsPart} You are outside and unshaded for <b>${exposed} min</b> of it` +
        `${now.uv >= 6 ? `, under UV ${Math.round(now.uv)}` : ''}.`
      : `${conditionsPart} You are in air conditioning for all ` +
        `${formatDuration(route.duration)} of it — which is what the CO₂ below buys.`;
  }

  const label = (h) => {
    const hour = h.hour % 12 === 0 ? 12 : h.hour % 12;
    return `${hour}${h.hour < 12 ? 'a' : 'p'}`;
  };

  el('heat-strip').innerHTML =
    `<div class="heat-strip">` +
    hours
      .map((h) => {
        const hb = heatBand(h.heatIndex);
        const on = h.stamp === selectedStamp;
        // Every third tick, plus always the selected one, so the axis stays
        // readable at sidebar width without losing the reader's place.
        const showTick = hours.indexOf(h) % 3 === 0 || on;
        return (
          `<button type="button" class="heat-hour ${on ? 'is-on' : ''}" data-stamp="${h.stamp}"` +
          ` title="${label(h)} — feels like ${Math.round(h.heatIndex)}°F, ${escapeHtml(hb?.label || '')}"` +
          ` aria-label="${label(h)}, feels like ${Math.round(h.heatIndex)} degrees, ${escapeHtml(hb?.label || '')}">` +
          `<span class="heat-bar" style="background:${hb?.color || 'var(--line)'}"></span>` +
          `<span class="heat-tick">${showTick ? label(h) : '&nbsp;'}</span>` +
          `</button>`
        );
      })
      .join('') +
    `</div><div class="heat-readout" id="heat-readout"></div>`;

  // Only the bands actually on screen, so the legend describes this strip
  // rather than the whole scale.
  const shown = new Set(hours.map((h) => heatBand(h.heatIndex)?.label));
  el('heat-legend').innerHTML = HEAT_BANDS.filter((b) => shown.has(b.label))
    .map(
      (b) =>
        `<span class="profile-key"><i style="background:${b.color}"></i>${escapeHtml(b.label)}</span>`,
    )
    .join('');

  // "Go later" is only advice when it is actually cooler later, when the
  // difference is worth the wait, and when the better hour is near enough to
  // still be the same plan. Left unbounded this degenerates into "travel at
  // night", which is true of every hot place and helps nobody.
  const advice = el('heat-advice');
  const best = bestHourWithin(hours, selectedStamp, route.duration, 6);

  // And only when the heat is worth escaping in the first place. On a 72°F
  // morning it is still true that 3am would be cooler; it is just not a
  // reason to change anybody's plans, and saying so every time would teach
  // people to stop reading this box.
  const worthMoving = exposedToIt && now && now.heatIndex >= 90;

  if (worthMoving && best && best.heatIndex + 4 <= now.heatIndex) {
    advice.hidden = false;
    advice.classList.toggle('is-blocked', now.heatIndex >= 103);
    advice.innerHTML =
      `<b>Leaving at ${label(best.hour)} is ${Math.round(now.heatIndex - best.heatIndex)}°F easier.</b> ` +
      `This trip would feel like ${Math.round(best.heatIndex)}°F then, against ` +
      `${Math.round(now.heatIndex)}°F now. Same route, same shade — different afternoon.`;
  } else if (exposedToIt && band?.advice && now.heatIndex >= 90) {
    advice.hidden = false;
    advice.classList.toggle('is-blocked', now.heatIndex >= 103);
    advice.innerHTML = `<b>${escapeHtml(band.label)}.</b> ${escapeHtml(band.advice)}`;
  } else {
    advice.hidden = true;
  }

  const air = now && Number.isFinite(now.aqi) ? aqiBand(now.aqi) : null;
  el('heat-source').innerHTML =
    `Heat index computed from Open-Meteo temperature and humidity with the ` +
    `<a href="https://www.weather.gov/safety/heat-index" target="_blank" rel="noopener">NWS</a> ` +
    `equation — it assumes shade, so in direct sun read it high.` +
    (air
      ? ` Air quality <b>${now.aqi}</b> US AQI (${escapeHtml(air.label)}), ozone ` +
        `${Math.round(now.ozone)} µg/m³ — modelled, not a nearby monitor.`
      : '');

  bindHeatStrip(hours);
}

/**
 * The easiest hour to make this trip in, within `horizon` hours of the one
 * picked.
 *
 * Every candidate is scored the way the headline is — averaged over the span
 * the trip actually occupies — so the two figures can be put in one sentence
 * without comparing a single hour against a multi-hour average and printing
 * two different temperatures for the same departure.
 */
function bestHourWithin(hours, selectedStamp, durationSec, horizon) {
  const from = hours.findIndex((h) => h.stamp === selectedStamp);
  if (from < 0 || !state.conditions) return null;

  let best = null;
  for (const hour of hours.slice(from + 1, from + 1 + horizon)) {
    const span = conditionsOver(state.conditions, hour.stamp.slice(0, 16), durationSec);
    if (!span || !Number.isFinite(span.heatIndex)) continue;
    if (!best || span.heatIndex < best.heatIndex) best = { hour, heatIndex: span.heatIndex };
  }
  return best;
}

function bindHeatStrip(hours) {
  const readout = el('heat-readout');
  const say = (h) => {
    const hb = heatBand(h.heatIndex);
    const air = Number.isFinite(h.aqi) ? aqiBand(h.aqi) : null;
    readout.innerHTML =
      `<b>${Math.round(h.heatIndex)}°F</b> ${escapeHtml(hb?.label || '')} · ` +
      `air ${Math.round(h.tempF)}°F, ${Math.round(h.humidity)}% humidity` +
      (Number.isFinite(h.uv) ? ` · UV ${Math.round(h.uv)}` : '') +
      (air ? ` · AQI ${h.aqi}` : '') +
      (h.rainPct >= 30 ? ` · ${h.rainPct}% rain` : '');
  };

  el('heat-strip')
    .querySelectorAll('.heat-hour')
    .forEach((node) => {
      const hour = hours.find((h) => h.stamp === node.dataset.stamp);
      if (!hour) return;
      node.addEventListener('pointerenter', () => say(hour));
      node.addEventListener('focus', () => say(hour));
      node.addEventListener('click', () => pickHour(hour));
    });
  el('heat-strip').addEventListener('pointerleave', () => {
    readout.textContent = '';
  });
}

/**
 * Re-plan for a different hour.
 *
 * Roads do not change with the clock, so walking, cycling and driving re-read
 * the forecast they already have and re-render on the spot. METRO's timetable
 * does change, so that one goes back to the router.
 */
function pickHour(hour) {
  state.heatHour = hour.stamp;
  el('when-time').value = hour.stamp.slice(0, 16);

  // Roads do not change with the clock, so this is a re-read of a forecast
  // already in memory and the answer is on screen immediately. METRO's
  // timetable does change, and that needs a search — which only the button
  // starts, so say so and let the ring move in the meantime.
  if (isTransit()) {
    renderHeat();
    markStale('Departure time changed.');
    return;
  }
  rescore();
}

/* ----------------------------------------------------------- transit --- */

/**
 * The METRO card: what to catch, from where, at what time.
 *
 * Everything here is quoted from METRO's feed rather than composed — the route
 * number, the route name, the headsign, the stop name, the stop code, the
 * number of stops, the departure and arrival times. Where the feed has nothing
 * to say, this card links to METRO instead of guessing: the feed ships no fare
 * products, so there is no fare figure anywhere in this app.
 */
function renderTransit() {
  const route = state.routes[state.selected];
  const card = el('transit-card');
  card.hidden = !route?.transit;
  if (card.hidden) return;

  const t = route.transit;
  const rides = t.rides;

  el('transit-title').textContent = rides.length
    ? `METRO trip · ${route.name}`
    : 'On foot the whole way';

  if (!rides.length) {
    renderStepFreeFinding();
    el('transit-summary').textContent =
      'No scheduled METRO trip is faster than walking this, so there is nothing to catch.';
    el('transit-legs').innerHTML = '';
    el('transit-sources').innerHTML = '';
    return;
  }

  renderStepFreeFinding();

  const wait = Math.round(t.waitSec / 60);
  el('transit-summary').innerHTML =
    `Leave ${formatClock(t.startTime)}, arrive ${formatClock(t.endTime)} on ` +
    `${escapeHtml(formatDay(t.startTime))} · ${t.transfers} transfer${t.transfers === 1 ? '' : 's'} · ` +
    `${formatDistance(t.walkM)} on foot${wait ? `, ${wait} min waiting` : ''}. ` +
    `<b>Scheduled times</b>, not live arrivals.`;

  el('transit-legs').innerHTML = rides
    .map((ride) => {
      const vehicle = VEHICLES[ride.vehicle] || VEHICLES.bus;
      const swatch = ride.color
        ? ` style="background:${ride.color};color:${ride.textColor || '#fff'}"`
        : '';
      const stops = `${ride.stopCount} stop${ride.stopCount === 1 ? '' : 's'}`;
      const schedule = ride.scheduleUrl
        ? ` · <a href="${escapeHtml(ride.scheduleUrl)}" target="_blank" rel="noopener">timetable</a>`
        : '';
      return `
        <div class="ride">
          <div class="ride-head">
            <span class="ride-badge"${swatch}>${vehicle.icon} ${escapeHtml(ride.shortName)}</span>
            <span class="ride-name">${escapeHtml(ride.longName)}</span>
          </div>
          ${ride.headsign ? `<div class="ride-toward">toward ${escapeHtml(ride.headsign)}</div>` : ''}
          <div class="ride-stop">
            <b>${formatClock(ride.board.departure)}</b>
            <span>Board at ${escapeHtml(ride.board.name)}${
              ride.board.code ? ` <span class="stop-code">#${escapeHtml(ride.board.code)}</span>` : ''
            }</span>
          </div>
          <div class="ride-ride">${stops} · ${formatDuration(ride.duration)}${
            ride.waitSec > 60 ? ` · ${Math.round(ride.waitSec / 60)} min wait before boarding` : ''
          }${ride.wheelchair ? ' · ♿ accessible' : ''}${schedule}</div>
          <div class="ride-stop">
            <b>${formatClock(ride.alight.arrival)}</b>
            <span>Get off at ${escapeHtml(ride.alight.name)}${
              ride.alight.code ? ` <span class="stop-code">#${escapeHtml(ride.alight.code)}</span>` : ''
            }</span>
          </div>
        </div>`;
    })
    .join('');

  el('transit-sources').innerHTML =
    `Route numbers, stops and times read live from ` +
    `<a href="${METRO_LINKS.feed}" target="_blank" rel="noopener">METRO's GTFS feed</a>, ` +
    `routed by <a href="${METRO_LINKS.router}" target="_blank" rel="noopener">Transitous</a>. ` +
    `Fares are not in the feed — see ` +
    `<a href="${t.fareUrl || METRO_LINKS.fares}" target="_blank" rel="noopener">METRO fares</a>.`;
}

/**
 * What routing step-free cost on this trip.
 *
 * Careful about what this number is, because the obvious reading of it is
 * wrong. METRO's vehicles are accessible throughout the feed and METRORail has
 * level boarding at every platform, so on most Houston trips the step-free
 * route is the SAME route — it just takes longer, because the router walks it
 * at about 0.69 m/s instead of 1.03. That is a real cost and worth showing,
 * and in July it is the cost that matters: the same pavement, more minutes
 * standing on it. What it is not is evidence of a blocked path, and the copy
 * below does not imply one.
 *
 * Where the two genuinely differ in *route*, that is worth naming too — but
 * only as the observation that a different trip was chosen, not as a verdict
 * on why.
 */
function renderStepFreeFinding() {
  const node = el('step-free-finding');
  const cost = state.stepFreeCost;
  node.hidden = !state.stepFree || !cost;
  if (node.hidden) return;

  node.classList.toggle('is-blocked', Boolean(cost.blocked) || cost.minutes >= 15);

  if (cost.blocked) {
    node.innerHTML =
      `<b>No step-free trip found.</b> On foot the ` +
      `${escapeHtml(cost.baseline.routes.join(' → '))} does this in ${cost.baseline.minutes} min. ` +
      `OpenStreetMap's kerb and crossing data is patchy, so this is a gap in the map as much ` +
      `as a statement about the city — check METRO directly before believing it.`;
    return;
  }

  const same =
    cost.stepFree.routes.join(' → ') === cost.baseline.routes.join(' → ');

  if (cost.minutes <= 1 && cost.transfers <= 0) {
    node.innerHTML =
      `<b>Step-free costs nothing here.</b> The same trip works either way — ` +
      `${escapeHtml(cost.stepFree.routes.join(' → '))}, ${cost.stepFree.minutes} min.`;
    return;
  }

  // Same routes, more minutes: the difference is pace, not access. Saying so
  // matters, because the alternative reading — that something is blocked — is
  // both the likelier one and untrue.
  if (same) {
    node.innerHTML =
      `<b>Step-free adds ${cost.minutes} min here.</b> Same trip, ` +
      `${escapeHtml(cost.stepFree.routes.join(' → '))}: the route is unchanged, it is walked ` +
      `at wheelchair pace. That is ${cost.minutes} more minutes outdoors, which is the part ` +
      `that matters in July.`;
    return;
  }

  const extraTransfers =
    cost.transfers > 0
      ? `, ${cost.transfers} more transfer${cost.transfers === 1 ? '' : 's'}`
      : '';
  node.innerHTML =
    `<b>Step-free adds ${cost.minutes} min${extraTransfers} here.</b> ` +
    `At wheelchair pace the quickest trip becomes ` +
    `${escapeHtml(cost.stepFree.routes.join(' → '))} (${cost.stepFree.minutes} min) rather than ` +
    `${escapeHtml(cost.baseline.routes.join(' → '))} (${cost.baseline.minutes} min) — a different ` +
    `trip wins, not a blocked one. METRO's vehicles are accessible either way.`;
}

/* -------------------------------------------------------- directions --- */

function renderDirections() {
  const route = state.routes[state.selected];
  el('directions-card').hidden = !route;
  if (!route) return;

  state.directions = buildDirections(
    route,
    state.layer,
    state.mode,
    state.places.destination?.label,
  );

  // Which instruction is each refill point nearest to? Only walking steps are
  // candidates — a fountain does not belong on "board the 700", and the ride's
  // geometry is long enough to win the nearest-point test from across town.
  const waterByStep = assignStopsToSteps(
    route.water?.stops || [],
    state.directions.filter((step) => !step.transit),
  );

  el('directions-title').textContent = `Directions · ${route.name}`;
  el('directions-summary').textContent =
    `${state.directions.length} steps · ${formatDistance(route.distance)} · ` +
    `${formatDuration(route.duration)} ${MODES[state.mode].gerund}`;

  el('directions').innerHTML = state.directions
    .map((step) => {
      const chips = [];
      if (step.bigRoad) chips.push('<span class="chip chip-road">busy road</span>');
      const stops = waterByStep.get(step.index);
      if (stops?.length) {
        chips.push(`<span class="chip chip-water">💧 water${stops.length > 1 ? ` ×${stops.length}` : ''}</span>`);
      }
      if (step.shadeShare > 0.5) chips.push('<span class="chip chip-shade">shaded</span>');
      if (step.greenShare > 0.6) chips.push('<span class="chip chip-green">green</span>');

      // A transit step's own meta line is the stop, the clock and the stop
      // count — all of it straight from the feed.
      const ride = step.transit;
      const transitMeta = !ride
        ? ''
        : ride.kind === 'alight'
          ? `${formatClock(ride.alight.arrival)}${
              ride.alight.code ? ` · stop #${escapeHtml(ride.alight.code)}` : ''
            }`
          : `${escapeHtml(ride.board.name)} · ${formatClock(ride.board.departure)} · ` +
            `${ride.stopCount} stop${ride.stopCount === 1 ? '' : 's'}`;

      const meta = [
        transitMeta,
        step.road && !step.isArrival ? escapeHtml(step.road) : '',
        chips.join(' '),
      ]
        .filter(Boolean)
        .join(' · ');

      return `
        <li class="dir-step ${step.index === state.activeStep ? 'is-active' : ''}
            ${step.transit ? 'is-transit' : ''}" data-index="${step.index}">
          <span class="dir-arrow">${step.arrow}</span>
          <span>
            <span class="dir-text">${escapeHtml(step.instruction)}</span>
            ${meta ? `<span class="dir-meta">${meta}</span>` : ''}
          </span>
          <span class="dir-dist">${
            step.isArrival || step.transit?.kind === 'alight'
              ? ''
              : step.transit
                ? formatDuration(step.duration)
                : stepDistance(step.distance)
          }</span>
        </li>`;
    })
    .join('');

  el('directions')
    .querySelectorAll('.dir-step')
    .forEach((node) =>
      node.addEventListener('click', () => focusStep(Number(node.dataset.index))),
    );

  el('directions').classList.toggle('is-collapsed', !state.directionsOpen);
  el('toggle-directions').textContent = state.directionsOpen ? 'collapse' : 'expand';
}

/** Zoom the map to one instruction and highlight the stretch of road it covers. */
function focusStep(index) {
  const step = state.directions[index];
  if (!step) return;
  state.activeStep = index;

  if (state.stepLayer) map.removeLayer(state.stepLayer);
  state.stepLayer = L.layerGroup().addTo(map);

  if (step.points.length > 1) {
    L.polyline(step.points, { color: '#111827', weight: 9, opacity: 0.35 }).addTo(state.stepLayer);
  }
  L.circleMarker(step.location, {
    radius: 8,
    weight: 3,
    color: '#111827',
    fillColor: '#fff',
    fillOpacity: 1,
  })
    .bindTooltip(step.instruction, { direction: 'top', permanent: false })
    .addTo(state.stepLayer);

  // Same framing rules as selecting a route: frame the manoeuvre inside the
  // visible part of the map, not the centre of the element.
  // Clearance is measured in screen pixels, so wait for the final zoom.
  map.once('moveend', drawRouteLabels);

  if (step.points.length > 1) {
    map.flyToBounds(L.latLngBounds(step.points), {
      ...boundsOptions(),
      maxZoom: 17,
      duration: 0.5,
    });
  } else {
    map.flyTo(offsetForVisibleArea(step.location), Math.max(map.getZoom(), 17), { duration: 0.5 });
  }

  el('directions')
    .querySelectorAll('.dir-step')
    .forEach((node) =>
      node.classList.toggle('is-active', Number(node.dataset.index) === index),
    );
}

function renderWater() {
  const route = state.routes[state.selected];
  const stops = route?.water?.stops || [];
  el('water-card').hidden = !route;
  if (!route) return;

  const dryKm = route.metrics.longestDryKm;
  const dry = formatDistance(dryKm * 1000);

  el('water-summary').innerHTML = stops.length
    ? `${stops.length} refill point${stops.length === 1 ? '' : 's'} within 120 m of this route. ` +
      `Longest stretch without one: <span class="${dryKm > 2 ? 'dry-warning' : ''}">${dry}</span>.`
    : 'No mapped drinking water within 120 m of this route — carry your own. ' +
      'OpenStreetMap under-records fountains, so this is a floor, not a guarantee.';

  el('water-list').innerHTML = stops
    .map(
      (stop, i) => `
      <li class="water-stop" data-index="${i}">
        <span class="water-icon">💧</span>
        <span>
          <span class="water-name">${escapeHtml(stop.name || 'Drinking fountain')}</span>
          <span class="water-meta">
            ${Math.round(stop.offRouteM)} m off route${stop.indoor ? ' · indoors' : ''}${
              stop.seasonal ? ' · seasonal' : ''
            }
          </span>
        </span>
        <span class="water-at">${formatDistance(stop.distanceFromStart)} in</span>
      </li>`,
    )
    .join('');

  el('water-list')
    .querySelectorAll('.water-stop')
    .forEach((node) => node.addEventListener('click', () => focusWater(Number(node.dataset.index))));
}

function focusWater(index) {
  const stop = state.routes[state.selected]?.water?.stops[index];
  if (!stop) return;
  // Same rule as routes and turns: centre it in the visible map, not the
  // middle of an element the sheet is sitting on.
  map.flyTo(offsetForVisibleArea(stop.coord), Math.max(map.getZoom(), 17), { duration: 0.5 });
}

/**
 * The When? row, which only exists for transit: it is the one mode where the
 * answer changes with the clock. Times are Houston's, whatever the browser's
 * own zone is.
 */
function setupWhenControls() {
  const time = el('when-time');
  const kind = el('when-kind');

  const reset = () => {
    time.value = dateToHoustonWallTime(new Date());
  };
  reset();

  // Changing the hour means something different per mode. METRO's answer
  // depends on the timetable, so it goes back to the router; a road does not
  // care what time it is, so walking, cycling and driving only need the
  // conditions re-read against routes they already have.
  const rerun = () => {
    if (!state.places.origin || !state.places.destination) return;
    state.heatHour = null;
    if (isTransit()) {
      markStale('Departure time changed.');
    } else if (state.routes.length) {
      rescore();
    }
  };

  kind.addEventListener('change', () => {
    state.when.kind = kind.value;
    rerun();
  });
  time.addEventListener('change', rerun);
  el('when-now').addEventListener('click', () => {
    reset();
    rerun();
  });

  el('step-free').addEventListener('change', (event) => {
    state.stepFree = event.target.checked;
    state.stepFreeCost = null;
    if (!state.places.origin || !state.places.destination) return;
    markStale(event.target.checked ? 'Step-free routing turned on.' : 'Step-free routing turned off.');
  });

  return {
    // Every mode is time-aware now — only what the time *does* differs, and
    // the hint says which.
    show(transit) {
      el('when-kind').hidden = !transit;
      // Arriving-by and step-free are both questions about a timetable, so
      // they belong to METRO only — the time itself belongs to every mode,
      // because every mode happens in weather.
      el('step-free-field').hidden = !transit;
      el('when-hint').textContent = transit
        ? 'Houston time. METRO timetables are scheduled, not live — a late bus still shows on time here.'
        : 'Houston time. Changes the heat you travel in, not the route.';
      if (new Date(houstonWallTimeToDate(time.value)) < Date.now() - 60 * 60 * 1000) reset();
    },
  };
}

function setWeightsOpen(open) {
  el('weights-body').hidden = !open;
  el('weights-toggle').setAttribute('aria-expanded', String(open));
}

/* -------------------------------------------------------- profile --- */

function renderRouteProfile() {
  const route = state.routes[state.selected];
  const card = el('profile-card');
  card.hidden = !route?.profile;
  if (card.hidden) return;

  el('profile-title').textContent = `Route profile · ${route.name}`;
  el('profile').innerHTML = renderProfile(route, {
    water: route.water?.stops || [],
    turns: state.directions.filter((step) => !step.isArrival && !step.transit),
  });

  const m = route.metrics;
  el('profile-summary').textContent =
    `${Math.round(m.greenShare * 100)}% green · ${Math.round(m.shadeShare * 100)}% shaded · ` +
    `${Math.round(m.bigRoadShare * 100)}% beside traffic, sampled every 75 m` +
    // Said out loud, because the three percentages above are averages over a
    // different denominator on a transit trip than on a walk.
    (route.profile?.hasRide ? ' — measured over the walking legs only' : '');

  el('profile-legend').innerHTML = seriesFor(route).map(
    (series) =>
      `<span class="profile-key" title="${series.description}">` +
      `<i style="background:${series.color}"></i>${series.label}</span>`,
  )
    .concat(
      route.water?.stops.length
        ? ['<span class="profile-key"><i style="background:#0284c7;border-radius:50%"></i>Water</span>']
        : [],
    )
    .join('');

  bindProfilePointer(route);
}

/**
 * Crosshair, readout, and click-to-locate. The profile doubles as a scrubber:
 * clicking a point on it puts that point of the route on the map.
 */
function bindProfilePointer(route) {
  const svg = el('profile').querySelector('.profile-svg');
  const hit = svg?.querySelector('.profile-hit');
  const cursor = svg?.querySelector('.profile-cursor');
  if (!hit) return;

  const fractionFor = (event) => {
    const box = svg.getBoundingClientRect();
    const hitBox = hit.getBoundingClientRect();
    void box;
    return Math.min(1, Math.max(0, (event.clientX - hitBox.left) / hitBox.width));
  };

  const show = (event) => {
    const fraction = fractionFor(event);
    const index = sampleAt(route.profile, fraction);
    const info = describeSample(route.profile, index);
    const x = hit.x.baseVal.value + fraction * hit.width.baseVal.value;
    cursor.setAttribute('x1', x);
    cursor.setAttribute('x2', x);
    cursor.style.display = '';
    el('profile-readout').innerHTML = `${info.distance} in · ${info.parts}`;
    return index;
  };

  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', (event) => {
    const index = show(event);
    map.flyTo(offsetForVisibleArea(route.profile.coords[index]), Math.max(map.getZoom(), 16), {
      duration: 0.45,
    });
  });
  hit.addEventListener('pointerleave', () => {
    cursor.style.display = 'none';
    el('profile-readout').textContent = '';
  });
}

function renderScoreModeHint() {
  el('score-mode-hint').textContent =
    state.scoreMode === 'absolute'
      ? 'Fixed 0-100 scale: the real share of the route that is green, shaded, and off big roads. Comparable between trips, but nothing scores 100.'
      : 'Normalised across these candidates only: spreads the field out to rank them, but the best of five bad routes still scores 100.';
}

function renderLegend() {
  const legend = el('legend');
  legend.hidden = state.routes.length === 0;
  legend.innerHTML =
    `<strong>${MODES[state.mode].icon} ${MODES[state.mode].label} routes</strong>` +
    state.routes
      .map(
        (route, i) => `
        <button type="button" class="legend-row ${i === state.selected ? 'is-selected' : ''}"
                data-index="${i}">
          <span class="legend-swatch" style="background:${route.color}"></span>
          <span>${escapeHtml(route.name)} — ${Math.round(route.pleasantness)}/100</span>
        </button>`,
      )
      .join('');

  legend
    .querySelectorAll('.legend-row')
    .forEach((node) => node.addEventListener('click', () => select(Number(node.dataset.index))));
}

/* ------------------------------------------------------------ weights --- */

function buildWeightSliders() {
  // Order is the order they are drawn. Tree canopy sits last because it is the
  // one switched off by default.
  const labels = {
    walk: ['Walkability', 'The GIS walkability index'],
    direct: ['Directness', "Doesn't wander"],
    green: ['Green space', 'Parks, bayou trails, water'],
    quiet: ['Away from traffic', 'Avoids freeways and feeders'],
    shade: ['Tree canopy', 'Already inside walkability — raise to double-count it.'],
  };

  el('weights').innerHTML = Object.entries(labels)
    .map(
      ([key, [title, note]]) => `
        <div class="weight">
          <div class="weight-head">
            <span title="${note}">${title}</span>
            <b id="w-${key}-val">${Math.round(DEFAULT_WEIGHTS[key] * 100)}%</b>
          </div>
          ${
            DEFAULT_WEIGHTS[key] === 0
              ? `<p class="weight-note">${escapeHtml(note)}</p>`
              : ''
          }
          <input type="range" id="w-${key}" min="0" max="100" value="${Math.round(
            DEFAULT_WEIGHTS[key] * 100,
          )}" />
        </div>`,
    )
    .join('');

  Object.keys(labels).forEach((key) => {
    el(`w-${key}`).addEventListener('input', (event) => {
      state.weights[key] = Number(event.target.value) / 100;
      normaliseWeights();
      rescore();
    });
  });
}

// Keep the weights a proper mix that sums to 1 so scores stay comparable.
function normaliseWeights() {
  const total = Object.values(state.weights).reduce((a, b) => a + b, 0);
  const share = {};
  for (const [key, value] of Object.entries(state.weights)) {
    share[key] = total > 0 ? value / total : 0.25;
    el(`w-${key}-val`).textContent = `${Math.round(share[key] * 100)}%`;
  }
  state.normalised = share;
}

/* ---------------------------------------------------------------- init --- */

// Leaflet caches its container size, so a rotation or a resize leaves the
// map rendering into stale dimensions until it is told otherwise.
// Labels are anchored to what is on screen, so they have to be recomputed
// when what is on screen changes.
map.on('moveend zoomend', () => {
  if (state.routes.length) drawRouteLabels();
});

function watchViewport() {
  let timer = null;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => map.invalidateSize(), 150);
  };
  window.addEventListener('resize', refresh);
  window.addEventListener('orientationchange', refresh);
}

function init() {
  buildWeightSliders();
  normaliseWeights();
  createCombo('origin', 'origin-input', 'origin-suggestions');
  createCombo('destination', 'dest-input', 'dest-suggestions');

  const when = setupWhenControls();

  el('mode-row').addEventListener('click', (event) => {
    const button = event.target.closest('.mode');
    if (!button) return;
    state.mode = button.dataset.mode;
    el('mode-row')
      .querySelectorAll('.mode')
      .forEach((b) => b.classList.toggle('is-active', b === button));
    when.show(isTransit());
    // A different mode is a different road network, so the routes on screen
    // are not merely stale, they are for the wrong vehicle. They stay put
    // rather than vanishing — swapping mode to look and swapping back should
    // not cost a re-search — but they are labelled plainly.
    markStale(`Mode changed to ${MODES[state.mode].label}.`);
  });

  el('compare-btn').addEventListener('click', compare);

  el('swap-btn').addEventListener('click', () => {
    const { origin, destination } = state.places;
    const originText = el('origin-input').value;
    el('origin-input').value = el('dest-input').value;
    el('dest-input').value = originText;
    state.places = { origin: destination, destination: origin };
    if (destination) setMarker('origin', destination);
    if (origin) setMarker('destination', origin);
    markStale('Start and finish swapped.');
  });

  el('locate-btn').addEventListener('click', async () => {
    setStatus('Asking your browser where you are…');
    try {
      const place = await locateMe();
      applyPlace('origin', place);
      map.setView(place.coord, 14);
      setStatus(`Start set to ${place.label}.`);
      markStale('Start changed.');
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  // Scoped to the picking pair: the layer toggles beside them share the class,
  // and an unscoped listener ran armPick(undefined) for those too — which
  // cancelled a pick in progress every time a layer was switched on.
  document.querySelectorAll('.pick-btn[data-pick]').forEach((btn) =>
    btn.addEventListener('click', () => armPick(btn.dataset.pick)),
  );

  el('weights-toggle').addEventListener('click', () => {
    setWeightsOpen(el('weights-body').hidden);
  });

  // An open panel covers the map, so anything aimed past it should shut it.
  // Capture phase, because Leaflet handles map clicks before they bubble.
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (el('weights-body').hidden) return;
      if (el('weights-panel').contains(event.target)) return;
      setWeightsOpen(false);
    },
    true,
  );

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!el('weights-body').hidden) setWeightsOpen(false);
    // A mode you cannot get out of is worse than no mode at all.
    if (state.pick) {
      armPick(null);
      setStatus('');
    }
  });

  el('pick-cancel').addEventListener('click', () => {
    armPick(null);
    setStatus('');
  });

  el('walk-layer-btn').addEventListener('click', toggleWalkLayer);
  el('priority-btn').addEventListener('click', togglePriority);
  el('economy-btn').addEventListener('click', toggleEconomy);
  el('demand-btn').addEventListener('click', toggleDemand);

  document.querySelectorAll('#demand-runs .seg-btn').forEach((btn) =>
    btn.addEventListener('click', () => setDemandRun(btn.dataset.run)),
  );
  el('close-priority').addEventListener('click', togglePriority);

  el('scn-count').addEventListener('input', (event) => {
    state.scenario.count = Number(event.target.value);
    renderScenarioPanel();
  });

  el('scn-effect').addEventListener('input', (event) => {
    state.scenario.effect = Number(event.target.value);
    renderScenarioPanel();
  });

  el('scenario-reset').addEventListener('click', () => {
    state.scenario = { count: 5, effect: 30 };
    el('scn-count').value = '5';
    el('scn-effect').value = '30';
    renderScenarioPanel();
  });

  el('recenter-btn').addEventListener('click', recenterMap);
  map.on('moveend zoomend layeradd layerremove', syncRecenter);
  syncRecenter();

  el('basemap-btn').addEventListener('click', () => {
    const index = BASEMAP_ORDER.indexOf(state.basemap);
    setBasemap(BASEMAP_ORDER[(index + 1) % BASEMAP_ORDER.length]);
  });

  el('toggle-water').addEventListener('click', () => {
    state.showWater = !state.showWater;
    el('toggle-water').textContent = state.showWater ? 'hide on map' : 'show on map';
    drawWater();
  });

  el('toggle-directions').addEventListener('click', () => {
    state.directionsOpen = !state.directionsOpen;
    el('directions').classList.toggle('is-collapsed', !state.directionsOpen);
    el('toggle-directions').textContent = state.directionsOpen ? 'collapse' : 'expand';
  });

  el('score-mode-row').addEventListener('click', (event) => {
    const button = event.target.closest('.mode');
    if (!button) return;
    state.scoreMode = button.dataset.score;
    el('score-mode-row')
      .querySelectorAll('.mode')
      .forEach((b) => b.classList.toggle('is-active', b === button));
    renderScoreModeHint();
    // Both scores are already computed per route; this only re-reads them.
    rescore();
  });

  el('reset-weights').addEventListener('click', () => {
    state.weights = { ...DEFAULT_WEIGHTS };
    Object.entries(DEFAULT_WEIGHTS).forEach(([k, v]) => {
      el(`w-${k}`).value = Math.round(v * 100);
    });
    normaliseWeights();
    rescore();
  });

  when.show(isTransit());
  renderScoreModeHint();
  watchViewport();

  state.sheet = initSheet({
    panel: el('panel'),
    handle: el('sheet-handle'),
    scroll: el('panel-scroll'),
    // The visible map area changes with the sheet, so let Leaflet re-measure
    // and re-frame the selected route for the space that is now available.
    onSnap: () =>
      setTimeout(() => {
        map.invalidateSize();
        if (state.routes.length) focusRoute(state.selected);
      }, 320),
  });
  updatePeek();
  setStatus(
    'Hit Compare for Rice → Hermann Park, or search anywhere in Texas. ' +
      'Pick 🚌 METRO for real METRORail and bus trips.',
  );
}

init();

// Test hooks for the browser harness. Gated to local hosts so production does
// not hand its internals to anything that asks.
if (['localhost', '127.0.0.1', ''].includes(window.location.hostname)) {
  window.__map = map;
  window.__state = state;
}
