// UI controller: wires the map, the place search, and the scoring pipeline together.

import {
  BASEMAPS,
  TILE_ATTR,
  HOUSTON_CENTER,
  PRESETS,
  MODES,
  DEFAULT_WEIGHTS,
  ROUTE_COLORS,
  IMPACT_SOURCES,
} from './config.js';
import { bboxOf, padBbox, haversine } from './geo.js';
import { fetchBaseRoutes, fetchViaRoute, pickGreenViaPoints, dedupe } from './routing.js';
import { loadGreenLayer } from './greenspace.js';
import { scoreRoutes, assignBadges, formatDistance, formatDuration } from './scoring.js';
import { buildDirections, stepDistance } from './directions.js';
import { assignStopsToSteps } from './water.js';
import { suggestPlaces, resolvePlace, describeCoordinate, locateMe } from './places.js';

const el = (id) => document.getElementById(id);

const state = {
  mode: 'bike',
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
  labelLayer: null,
  basemap: 'natural',
  waterLayer: null,
  showWater: true,
  busy: false,
  directionsOpen: true,
};

/* ---------------------------------------------------------------- map --- */

const map = L.map('map', { zoomControl: true }).setView(HOUSTON_CENTER, 12);

let basemap = L.tileLayer(BASEMAPS.natural.url, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(map);

function setBasemap(key) {
  state.basemap = key;
  map.removeLayer(basemap);
  basemap = L.tileLayer(BASEMAPS[key].url, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(map);
  // Keep the tiles under the routes after swapping.
  basemap.bringToBack();
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
        compare();
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

  drawWater();
  drawRouteLabels();
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

/** Google-style time pills sitting on each route line. */
function drawRouteLabels() {
  if (state.labelLayer) {
    map.removeLayer(state.labelLayer);
    state.labelLayer = null;
  }
  if (!state.routes.length) return;

  state.labelLayer = L.layerGroup().addTo(map);

  state.routes.forEach((route, i) => {
    const isSelected = i === state.selected;
    // route.labelAt is fixed per route (see compare) so overlapping
    // alternatives keep distinct, stable label positions.
    const at = pointAlong(route.points, route.labelAt ?? 0.5);

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

function fitToRoutes() {
  const bounds = L.latLngBounds(state.routes.flatMap((r) => r.points));
  map.fitBounds(bounds, { padding: [50, 50] });
}

/* ---------------------------------------------------------- map picks --- */

function armPick(role) {
  state.pick = state.pick === role ? null : role;
  document.querySelectorAll('.pick-btn').forEach((btn) => {
    btn.classList.toggle('is-armed', btn.dataset.pick === state.pick);
  });
  map.getContainer().classList.toggle('map-picking', Boolean(state.pick));
  if (state.pick) {
    setStatus(`Click the map to set the ${state.pick === 'origin' ? 'start' : 'finish'}.`);
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

  if (state.places.origin && state.places.destination) compare();
  else setStatus(`${role === 'origin' ? 'Start' : 'Finish'} set to ${place.label}.`);
});

/* ------------------------------------------------------------- status --- */

function setStatus(message, isError = false) {
  const node = el('status');
  node.textContent = message;
  node.classList.toggle('is-error', isError);
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

    // Both ends known? Go straight to comparing — that is why they typed it.
    if (state.places.origin && state.places.destination) compare();
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
    // Typing invalidates the previously resolved place for this field.
    state.places[role] = null;
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
async function ensurePlace(role, fallbackName) {
  if (state.places[role]) return state.places[role];

  const input = el(role === 'origin' ? 'origin-input' : 'dest-input');
  const text = input.value.trim();

  if (!text) {
    const preset = PRESETS.find((p) => p.name === fallbackName);
    const place = { coord: preset.coord, label: preset.name, detail: 'Houston landmark' };
    applyPlace(role, place);
    return place;
  }

  const place = await resolvePlace(text);
  applyPlace(role, place);
  return place;
}

/* ----------------------------------------------------------- pipeline --- */

async function compare() {
  if (state.busy) return;
  setBusy(true);
  setStatus('Finding your start and finish…');

  try {
    const origin = await ensurePlace('origin', 'Discovery Green (Fan Festival site)');
    const destination = await ensurePlace(
      'destination',
      'NRG Stadium (Houston Sports Park / WC26 venue)',
    );

    setStatus('Asking the router for every sensible way there…');
    let candidates = await fetchBaseRoutes(state.mode, origin.coord, destination.coord);

    const straight = haversine(origin.coord, destination.coord);
    let layer = null;

    if (straight > 60000) {
      setStatus('Trip is long — scoring on road type and directness only.');
    } else {
      setStatus('Downloading parks, bayous and tree canopy from OpenStreetMap…');
      const bbox = padBbox(bboxOf(candidates.map((r) => r.points)), 2000);
      try {
        layer = await loadGreenLayer(bbox);
      } catch {
        setStatus('OpenStreetMap green data unavailable — scoring on road type only.', true);
      }
    }

    if (layer) {
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

    // Drop absurd detours: nobody walks 3x as far for a nicer view.
    const shortest = Math.min(...candidates.map((r) => r.distance));
    candidates = candidates.filter((r) => r.distance <= shortest * 1.9).slice(0, 6);

    // Colour belongs to the route, and is assigned here exactly once.
    // Everything downstream reads route.color instead of its list index, so
    // changing the weights reorders the list without repainting the map.
    // The label offset is pinned here too, so labels stay put on rerank
    // instead of sliding along their lines.
    const offsets = [0.5, 0.38, 0.62, 0.28, 0.72, 0.45];
    candidates.forEach((route, i) => {
      route.color = ROUTE_COLORS[i % ROUTE_COLORS.length];
      route.labelAt = offsets[i % offsets.length];
    });

    state.layer = layer;
    state.rawRoutes = candidates;
    state.selected = 0;
    rescore({ fit: true });

    setStatus(describeRun(candidates.length, layer));
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Something went wrong. Try again.', true);
  } finally {
    setBusy(false);
  }
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

function rescore({ fit = false } = {}) {
  if (!state.rawRoutes?.length) return;

  const scored = assignBadges(
    scoreRoutes(state.rawRoutes, state.layer, state.mode, state.normalised, state.scoreMode),
  );
  scored.sort((a, b) => b.pleasantness - a.pleasantness);
  nameRoutes(scored);

  state.routes = scored;
  state.selected = Math.min(state.selected, scored.length - 1);

  renderRoutes();
  renderDirections();
  renderWater();
  renderDetail();
  drawRoutes();
  renderLegend();
  if (fit) fitToRoutes();
}

const letter = (i) => String.fromCharCode(65 + i);

// Named parks make the best labels; everything else falls back to letters,
// and unnamed detours get numbered so two of them never collide.
function nameRoutes(routes) {
  let plain = 0;
  let detour = 0;
  for (const route of routes) {
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

function select(index) {
  state.selected = index;
  state.activeStep = null;
  renderRoutes();
  renderDirections();
  renderWater();
  renderDetail();
  drawRoutes();
}

/* ------------------------------------------------------------ render --- */

function bar(label, value) {
  const pct = Math.round(value * 100);
  return `
    <div class="bar">
      <span>${label}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
      <span class="bar-val">${pct}%</span>
    </div>`;
}

function renderRoutes() {
  el('results-card').hidden = state.routes.length === 0;

  el('routes').innerHTML = state.routes
    .map((route, i) => {
      const m = route.metrics;
      const badges = route.badges
        .map((b) => `<span class="badge">${b.label}</span>`)
        .concat(
          m.detourPct > 12
            ? [`<span class="badge warn">+${Math.round(m.detourPct)}% longer</span>`]
            : [],
        )
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
            ${formatDuration(route.duration)} · ${formatDistance(route.distance)} ·
            ${m.co2Kg < 0.05 ? 'zero tailpipe CO₂' : `${m.co2Kg.toFixed(1)} kg CO₂`}
          </div>
          <div class="badges">${badges}</div>
          <div class="bars">
            ${bar('Green', m.greenShare)}
            ${bar('Shade', m.shadeShare)}
            ${bar('Calm', 1 - m.bigRoadShare)}
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
  const heatCard = mode.heatExposed
    ? stat(
        'Unshaded time',
        `${Math.round(m.exposedMinutes)} min`,
        `${Math.round(m.shadeShare * 100)}% of this route has mapped canopy`,
      )
    : stat('In traffic', formatDuration(route.duration), 'Air-conditioned, but still emitting');

  const carbon =
    mode.co2PerKm < MODES.car.co2PerKm
      ? stat('CO₂ avoided', `${m.co2SavedVsDrivingKg.toFixed(2)} kg`, 'vs. driving the same trip solo')
      : stat('CO₂ emitted', `${m.co2Kg.toFixed(2)} kg`, `${m.transitCo2Kg.toFixed(2)} kg by METRO bus`);

  el('impact-sources').innerHTML = IMPACT_SOURCES.map(
    (entry) => `<li><b>${escapeHtml(entry.figure)}</b>${escapeHtml(entry.source)}</li>`,
  ).join('');

  el('detail').innerHTML = `
    <div class="stats">
      ${heatCard}
      ${carbon}
      ${
        m.waterStops
          ? stat(
              'Water stops',
              String(m.waterStops),
              `longest dry stretch ${formatDistance(m.longestDryKm * 1000)}`,
            )
          : stat('Beside green space', `${Math.round(m.greenShare * 100)}%`, 'parks, bayous, tree cover')
      }
      ${
        mode.kcalPerKm
          ? stat('Energy burned', `${Math.round(m.kcal)} kcal`, `${m.turns} turns to remember`)
          : stat('Trip cost', `$${m.cost.toFixed(2)}`, 'fuel, wear, and depreciation')
      }
    </div>
    <p class="hint" style="margin:12px 0 0">
      ${Math.round(m.bigRoadShare * 100)}% of this route runs along a freeway or major arterial.
      ${
        m.detourPct > 1
          ? `It is ${Math.round(m.detourPct)}% longer than the shortest option.`
          : 'It is also the shortest option available.'
      }
    </p>`;
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

  // Which instruction is each refill point nearest to?
  const waterByStep = assignStopsToSteps(route.water?.stops || [], state.directions);

  el('directions-title').textContent = `Directions · ${route.name}`;
  el('directions-summary').textContent =
    `${state.directions.length} steps · ${formatDistance(route.distance)} · ` +
    `${formatDuration(route.duration)} by ${MODES[state.mode].label.toLowerCase()}`;

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

      const meta = [
        step.road && !step.isArrival ? escapeHtml(step.road) : '',
        chips.join(' '),
      ]
        .filter(Boolean)
        .join(' · ');

      return `
        <li class="dir-step ${step.index === state.activeStep ? 'is-active' : ''}"
            data-index="${step.index}">
          <span class="dir-arrow">${step.arrow}</span>
          <span>
            <span class="dir-text">${escapeHtml(step.instruction)}</span>
            ${meta ? `<span class="dir-meta">${meta}</span>` : ''}
          </span>
          <span class="dir-dist">${step.isArrival ? '' : stepDistance(step.distance)}</span>
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

  map.setView(step.location, Math.max(map.getZoom(), 16), { animate: true });

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
  map.setView(stop.coord, Math.max(map.getZoom(), 17), { animate: true });
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
        <div class="legend-row">
          <span class="legend-swatch" style="background:${route.color}"></span>
          <span>${escapeHtml(route.name)} — ${Math.round(route.pleasantness)}/100</span>
        </div>`,
      )
      .join('');
}

/* ------------------------------------------------------------ weights --- */

function buildWeightSliders() {
  const labels = {
    green: ['Green space', 'Parks, bayou trails, water'],
    shade: ['Tree canopy', 'Shade = survivable heat'],
    quiet: ['Away from traffic', 'Avoids freeways and feeders'],
    direct: ['Directness', "Doesn't wander"],
  };

  el('weights').innerHTML = Object.entries(labels)
    .map(
      ([key, [title, note]]) => `
        <div class="weight">
          <div class="weight-head">
            <span title="${note}">${title}</span>
            <b id="w-${key}-val">${Math.round(DEFAULT_WEIGHTS[key] * 100)}%</b>
          </div>
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

function init() {
  buildWeightSliders();
  normaliseWeights();
  createCombo('origin', 'origin-input', 'origin-suggestions');
  createCombo('destination', 'dest-input', 'dest-suggestions');

  el('mode-row').addEventListener('click', (event) => {
    const button = event.target.closest('.mode');
    if (!button) return;
    state.mode = button.dataset.mode;
    el('mode-row')
      .querySelectorAll('.mode')
      .forEach((b) => b.classList.toggle('is-active', b === button));
    // Mode changes the road network, so the routes have to be re-fetched.
    if (state.rawRoutes?.length) compare();
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
    if (state.places.origin && state.places.destination) compare();
  });

  el('locate-btn').addEventListener('click', async () => {
    setStatus('Asking your browser where you are…');
    try {
      const place = await locateMe();
      applyPlace('origin', place);
      map.setView(place.coord, 14);
      setStatus(`Start set to ${place.label}.`);
      if (state.places.destination) compare();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  document.querySelectorAll('.pick-btn').forEach((btn) =>
    btn.addEventListener('click', () => armPick(btn.dataset.pick)),
  );

  el('basemap-btn').addEventListener('click', () => {
    const next = state.basemap === 'natural' ? 'minimal' : 'natural';
    setBasemap(next);
    el('basemap-btn').textContent = `🗺 ${BASEMAPS[next].label}`;
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

  renderScoreModeHint();
  setStatus('Search any Houston address, or just hit Compare for Discovery Green → NRG Stadium.');
}

init();
