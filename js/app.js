// UI controller: wires the map, the form, and the scoring pipeline together.

import {
  TILE_URL,
  TILE_ATTR,
  HOUSTON_CENTER,
  PRESETS,
  MODES,
  DEFAULT_WEIGHTS,
  ROUTE_COLORS,
} from './config.js';
import { bboxOf, padBbox, haversine } from './geo.js';
import { fetchBaseRoutes, fetchViaRoute, pickGreenViaPoints, dedupe, geocode } from './routing.js';
import { loadGreenLayer } from './greenspace.js';
import { scoreRoutes, assignBadges, formatDistance, formatDuration } from './scoring.js';

const el = (id) => document.getElementById(id);

const state = {
  mode: 'bike',
  weights: { ...DEFAULT_WEIGHTS },
  routes: [],
  selected: 0,
  layer: null,
  endpoints: null,
  lines: [],
  markers: [],
  busy: false,
};

/* ---------------------------------------------------------------- map --- */

const map = L.map('map', { zoomControl: true }).setView(HOUSTON_CENTER, 12);
L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(map);

function clearMap() {
  state.lines.forEach((l) => map.removeLayer(l));
  state.markers.forEach((m) => map.removeLayer(m));
  state.lines = [];
  state.markers = [];
}

function endpointMarker(coord, label, colour) {
  return L.circleMarker(coord, {
    radius: 7,
    weight: 3,
    color: colour,
    fillColor: '#fff',
    fillOpacity: 1,
  }).bindTooltip(label, { direction: 'top' });
}

function drawRoutes() {
  clearMap();
  if (!state.routes.length) return;

  // Draw unselected first so the selected route lands on top.
  const order = state.routes
    .map((_, i) => i)
    .sort((a, b) => (a === state.selected ? 1 : 0) - (b === state.selected ? 1 : 0));

  for (const i of order) {
    const route = state.routes[i];
    const isSelected = i === state.selected;
    const colour = ROUTE_COLORS[i % ROUTE_COLORS.length];

    const line = L.polyline(route.points, {
      color: colour,
      weight: isSelected ? 6 : 4,
      opacity: isSelected ? 0.95 : 0.35,
      lineJoin: 'round',
    })
      .addTo(map)
      .on('click', () => select(i));

    line.bindTooltip(
      `${route.name} · ${formatDistance(route.distance)} · ${formatDuration(route.duration)}`,
      { sticky: true },
    );
    state.lines.push(line);
  }

  const [origin, destination] = state.endpoints;
  state.markers.push(endpointMarker(origin, 'Start', '#1f7a4d').addTo(map));
  state.markers.push(endpointMarker(destination, 'Finish', '#be123c').addTo(map));
}

function fitToRoutes() {
  const bounds = L.latLngBounds(state.routes.flatMap((r) => r.points));
  map.fitBounds(bounds, { padding: [50, 50] });
}

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

/* -------------------------------------------------------------- input --- */

function fillPresets() {
  const list = el('preset-list');
  list.innerHTML = PRESETS.map((p) => `<option value="${p.name}"></option>`).join('');
}

// Accepts a preset name, a raw "lat, lon" pair, or free text to geocode.
async function resolvePlace(text, fallbackName) {
  const query = text.trim() || fallbackName;

  const preset = PRESETS.find((p) => p.name.toLowerCase() === query.toLowerCase());
  if (preset) return { coord: preset.coord, label: preset.name };

  const pair = query.match(/^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/);
  if (pair) {
    return { coord: [parseFloat(pair[1]), parseFloat(pair[2])], label: query };
  }

  const loose = PRESETS.find((p) => p.name.toLowerCase().includes(query.toLowerCase()));
  if (loose) return { coord: loose.coord, label: loose.name };

  return geocode(query);
}

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

/* ----------------------------------------------------------- pipeline --- */

async function compare() {
  if (state.busy) return;
  setBusy(true);
  setStatus('Finding your start and finish…');

  try {
    const origin = await resolvePlace(el('origin-input').value, 'Discovery Green (Fan Festival site)');
    const destination = await resolvePlace(
      el('dest-input').value,
      'NRG Stadium (Houston Sports Park / WC26 venue)',
    );
    el('origin-input').value = origin.label.split(',')[0];
    el('dest-input').value = destination.label.split(',')[0];
    state.endpoints = [origin.coord, destination.coord];

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
    `${count} routes compared against ${layer.counts.parks.toLocaleString()} green areas ` +
    `and ${layer.counts.trees.toLocaleString()} mapped trees, from ${where}.${scope}`
  );
}

function rescore({ fit = false } = {}) {
  if (!state.rawRoutes?.length) return;

  const scored = assignBadges(
    scoreRoutes(state.rawRoutes, state.layer, state.mode, state.normalised),
  );
  scored.sort((a, b) => b.pleasantness - a.pleasantness);
  nameRoutes(scored);

  state.routes = scored;
  state.selected = Math.min(state.selected, scored.length - 1);

  renderRoutes();
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
  renderRoutes();
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
      const colour = ROUTE_COLORS[i % ROUTE_COLORS.length];
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
        <div class="route ${i === state.selected ? 'is-selected' : ''}"
             style="border-left-color:${colour}" data-index="${i}">
          <div class="route-top">
            <span class="route-name">${route.name}</span>
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

  const carbon = mode.co2PerKm < MODES.car.co2PerKm
    ? stat(
        'CO₂ avoided',
        `${m.co2SavedVsDrivingKg.toFixed(2)} kg`,
        `vs. driving the same trip solo`,
      )
    : stat('CO₂ emitted', `${m.co2Kg.toFixed(2)} kg`, `${m.transitCo2Kg.toFixed(2)} kg by METRO bus`);

  el('detail').innerHTML = `
    <div class="stats">
      ${heatCard}
      ${carbon}
      ${stat('Beside green space', `${Math.round(m.greenShare * 100)}%`, 'parks, bayous, tree cover')}
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

function renderLegend() {
  const legend = el('legend');
  legend.hidden = state.routes.length === 0;
  legend.innerHTML =
    `<strong>${MODES[state.mode].icon} ${MODES[state.mode].label} routes</strong>` +
    state.routes
      .map(
        (route, i) => `
        <div class="legend-row">
          <span class="legend-swatch" style="background:${ROUTE_COLORS[i % ROUTE_COLORS.length]}"></span>
          <span>${route.name} — ${Math.round(route.pleasantness)}/100</span>
        </div>`,
      )
      .join('');
}

/* ---------------------------------------------------------------- init --- */

function init() {
  fillPresets();
  buildWeightSliders();
  normaliseWeights();

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
  el('reset-weights').addEventListener('click', () => {
    state.weights = { ...DEFAULT_WEIGHTS };
    Object.entries(DEFAULT_WEIGHTS).forEach(([k, v]) => {
      el(`w-${k}`).value = Math.round(v * 100);
    });
    normaliseWeights();
    rescore();
  });

  for (const id of ['origin-input', 'dest-input']) {
    el(id).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') compare();
    });
  }

  setStatus('Try the default: Discovery Green → NRG Stadium, by bike.');
}

init();
