// Anywhere-in-Houston place lookup: type-ahead search, reverse geocoding for
// map clicks and dragged pins, and the browser's own location.
//
// Photon does the type-ahead (Nominatim's usage policy forbids autocomplete),
// Nominatim is the one-shot fallback when Photon is down, and every result
// collapses to the same { coord, label, detail } shape.

import {
  PHOTON_SEARCH_URL,
  PHOTON_REVERSE_URL,
  NOMINATIM_URL,
  SEARCH_BIAS,
  GREATER_HOUSTON,
  TEXAS,
  PRESETS,
} from './config.js';
import { exactAlias, matchAliases } from './aliases.js';

const LAT_LON = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** A coordinate pair typed straight into the box is a valid place. */
export function parseCoordinates(text) {
  const match = text.match(LAT_LON);
  if (!match) return null;
  const lat = parseFloat(match[1]);
  const lon = parseFloat(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    coord: [lat, lon],
    label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    detail: 'Dropped pin',
    kind: 'coordinate',
  };
}

// Photon splits an address across properties; rebuild something readable.
function fromPhoton(feature) {
  const p = feature.properties || {};
  const [lon, lat] = feature.geometry.coordinates;

  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const label = p.name || street || p.city || 'Unnamed place';
  const detail = [
    p.name && street ? street : null,
    p.district,
    p.city || p.county,
    p.state,
    p.postcode,
  ]
    .filter(Boolean)
    .join(', ');

  return {
    coord: [lat, lon],
    label,
    detail: detail || 'Houston area',
    kind: p.osm_value || p.type || 'place',
  };
}

function inBox([lat, lon], b) {
  return lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e;
}

/** "1600 Main St" — a house number followed by a word. */
export function looksLikeAddress(text) {
  return /^\s*\d+[a-z]?\s+\w/i.test(text);
}

/**
 * Nominatim is markedly better than Photon at house-numbered addresses
 * ("1600 Main St" lands downtown rather than in Seabrook), but its usage
 * policy allows one-shot lookups only — never per-keystroke autocomplete.
 */
// City names that mean "do not assume Houston". Covers the metro plus the
// rest of Texas, so "1600 Guadalupe St Austin" is not dragged into Houston.
const KNOWN_CITIES =
  /\b(houston|katy|sugar ?land|pearland|pasadena|baytown|conroe|the woodlands|spring|humble|kingwood|cypress|tomball|missouri city|stafford|bellaire|galveston|league city|friendswood|webster|seabrook|kemah|richmond|rosenberg|deer park|la porte|texas city|clear lake|atascocita|channelview|alvin|dickinson|santa fe|angleton|lake jackson|austin|san antonio|dallas|fort worth|college station|bryan|waco|lubbock|el paso|corpus christi|amarillo|midland|odessa|laredo|beaumont|huntsville|denton|arlington|plano|tyler|abilene|killeen|round rock|tx|texas)\b/i;

/** "1600 Main St" matches a Seabrook post office first without a city hint. */
function withCityHint(text) {
  if (KNOWN_CITIES.test(text) || /\b\d{5}\b/.test(text)) return text;
  return `${text}, Houston, TX`;
}

async function nominatimSearch(text, limit = 1) {
  const params = new URLSearchParams({
    format: 'json',
    q: withCityHint(text),
    limit: String(limit),
    viewbox: `${TEXAS.w},${TEXAS.n},${TEXAS.e},${TEXAS.s}`,
    bounded: '1',
  });
  const res = await fetch(`${NOMINATIM_URL}?${params}`);
  if (!res.ok) return [];

  return (await res.json()).map((hit) => {
    const parts = hit.display_name.split(',').map((p) => p.trim());
    // Nominatim leads with the house number as its own part; rejoin it.
    const numbered = /^\d+[a-z]?$/i.test(parts[0]);
    return {
      coord: [parseFloat(hit.lat), parseFloat(hit.lon)],
      label: numbered ? `${parts[0]} ${parts[1]}` : parts[0],
      detail: parts.slice(numbered ? 2 : 1, numbered ? 5 : 4).join(', '),
      kind: hit.type || 'house',
    };
  });
}

/** Presets that match what has been typed so far, for the empty/short case. */
function matchingPresets(query) {
  const q = query.trim().toLowerCase();
  const hits = q
    ? PRESETS.filter((p) => p.name.toLowerCase().includes(q))
    : PRESETS.slice(0, 6);

  return hits.slice(0, 6).map((p) => ({
    coord: p.coord,
    label: p.name.replace(/\s*\(.*\)$/, ''),
    detail: p.name.includes('(') ? p.name.replace(/^[^(]*\(|\)$/g, '') : 'Houston landmark',
    kind: 'preset',
  }));
}

function dedupeByCoord(places) {
  const seen = new Set();
  const out = [];
  for (const place of places) {
    const key = `${place.coord[0].toFixed(4)},${place.coord[1].toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(place);
  }
  return out;
}

/**
 * Suggestions for a partially typed query. Never throws: an unreachable
 * geocoder degrades to preset matches rather than breaking the input.
 */
export async function suggestPlaces(query, { signal } = {}) {
  const coordinate = parseCoordinates(query);
  if (coordinate) return [coordinate];

  // "rga", "brc", "tmc tc" find nothing at any geocoder. Expand a known
  // abbreviation before searching, and offer the near-matches as rows so a
  // half-typed one still leads somewhere.
  const matched = matchAliases(query);
  const expanded = exactAlias(query);
  const searchText = expanded ? expanded.full : query;

  const aliasRows = matched
    .filter((entry) => entry !== expanded)
    .map((entry) => ({
      coord: null,
      query: entry.full,
      label: entry.label,
      detail: `${entry.keys[0].toUpperCase()} · abbreviation`,
      kind: 'alias',
    }));

  const presets = matchingPresets(query);
  if (query.trim().length < 2) return presets;
  if (!expanded && query.trim().length < 3) return [...aliasRows, ...presets];

  const params = new URLSearchParams({
    q: searchText,
    lat: String(SEARCH_BIAS.lat),
    lon: String(SEARCH_BIAS.lon),
    limit: '8',
    bbox: `${TEXAS.w},${TEXAS.s},${TEXAS.e},${TEXAS.n}`,
  });

  // House numbers are Photon's weak spot, so offer an explicit lookup the user
  // can commit to — one Nominatim request per selection, not per keystroke.
  const lookup = looksLikeAddress(query)
    ? [
        {
          coord: null,
          query: query.trim(),
          label: `Look up "${query.trim()}"`,
          detail: 'exact address search',
          kind: 'lookup',
        },
      ]
    : [];

  try {
    const res = await fetch(`${PHOTON_SEARCH_URL}?${params}`, { signal });
    if (!res.ok) throw new Error(`Photon returned ${res.status}`);
    const data = await res.json();

    const remote = (data.features || [])
      .map(fromPhoton)
      // The bbox is a hint, not a guarantee, so re-check on the way out.
      .filter((place) => inBox(place.coord, TEXAS))
      .map((place) =>
        // Say why an expansion matched, so "rga" showing Rice Graduate
        // Apartments does not look like the search ignored what was typed.
        expanded ? { ...place, detail: `${expanded.keys[0].toUpperCase()} · ${place.detail}` } : place,
      );

    // An exact abbreviation is what the user asked for, so its real result
    // leads and the near-miss rows ("uh" also offering UHD) follow it.
    const head = expanded ? remote : [...presets.slice(0, 2), ...remote];
    const ordered = expanded
      ? [...lookup, ...dedupeByCoord(head), ...aliasRows]
      : [...lookup, ...aliasRows, ...dedupeByCoord(head)];
    return ordered.slice(0, 8);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return [...lookup, ...aliasRows, ...presets];
  }
}

/** Resolve free text to a single place — used when someone hits Enter. */
export async function resolvePlace(query) {
  const text = query.trim();
  if (!text) throw new Error('Enter a start and a destination.');

  const coordinate = parseCoordinates(text);
  if (coordinate) return coordinate;

  const exact = PRESETS.find((p) => p.name.toLowerCase() === text.toLowerCase());
  if (exact) return { coord: exact.coord, label: exact.name, detail: 'Houston landmark' };

  const alias = exactAlias(text);
  if (alias) {
    const [best] = (await suggestPlaces(alias.full)).filter((place) => place.coord);
    if (best) return best;
  }

  // Street addresses go to Nominatim first; everything else to Photon first.
  if (looksLikeAddress(text)) {
    const [best] = await nominatimSearch(text, 1);
    if (best) return best;
  }

  const suggestions = (await suggestPlaces(text)).filter((place) => place.coord);
  if (suggestions.length) return suggestions[0];

  const [fallback] = await nominatimSearch(text, 1);
  if (fallback) return fallback;

  throw new Error(`Could not find "${text}" in Texas.`);
}

/** Name a coordinate the user picked off the map, so the box isn't just numbers. */
export async function describeCoordinate(coord) {
  const params = new URLSearchParams({ lat: String(coord[0]), lon: String(coord[1]) });
  try {
    const res = await fetch(`${PHOTON_REVERSE_URL}?${params}`);
    if (!res.ok) throw new Error(`Photon returned ${res.status}`);
    const data = await res.json();
    if (!data.features?.length) throw new Error('No match');
    return { ...fromPhoton(data.features[0]), coord };
  } catch {
    return {
      coord,
      label: `${coord[0].toFixed(5)}, ${coord[1].toFixed(5)}`,
      detail: 'Dropped pin',
      kind: 'coordinate',
    };
  }
}

/** The browser's own position, named via reverse geocoding. */
export function locateMe() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This browser will not share a location.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const coord = [position.coords.latitude, position.coords.longitude];
        const place = await describeCoordinate(coord);
        resolve({ ...place, detail: place.detail || 'Your location' });
      },
      (err) =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? 'Location permission denied.'
              : 'Could not get your location.',
          ),
        ),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}
