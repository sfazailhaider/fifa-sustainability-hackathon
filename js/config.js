// Central configuration: endpoints, travel modes, scoring weights, Houston presets.

// Voyager is CARTO's natural-colour basemap — green parks, blue water, beige
// arterials — which reads like a familiar road map and, more usefully here,
// makes the green space the app scores on actually visible under the routes.
// The pale "positron" style is kept as a second option for when the route
// colours need to dominate.
export const BASEMAPS = {
  natural: {
    label: 'Natural',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  },
  minimal: {
    label: 'Minimal',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  },
};
export const TILE_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

export const HOUSTON_CENTER = [29.7604, -95.3698];

// FOSSGIS public OSRM instances (same servers openstreetmap.org uses for routing).
// All three accept "driving" in the URL path; the profile is chosen by the host path.
export const OSRM_HOSTS = {
  car: 'https://routing.openstreetmap.de/routed-car',
  bike: 'https://routing.openstreetmap.de/routed-bike',
  foot: 'https://routing.openstreetmap.de/routed-foot',
};

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// Photon is an OSM geocoder built for type-ahead; Nominatim's usage policy
// explicitly rules autocomplete out, so it is kept for one-shot lookups only.
export const PHOTON_SEARCH_URL = 'https://photon.komoot.io/api/';
export const PHOTON_REVERSE_URL = 'https://photon.komoot.io/reverse';
export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

// Results are biased toward Houston, not restricted to it — a fan staying in
// Katy, Sugar Land, or Galveston still has to get to the stadium.
export const SEARCH_BIAS = { lat: 29.7604, lon: -95.3698 };
export const GREATER_HOUSTON = { s: 29.0, w: -96.2, n: 30.6, e: -94.6 };

// IMPACT FACTORS
//
// Every number below is a published average applied to the routed distance —
// none of it is measured, live, or specific to a given vehicle or person.
// They are constants precisely so they are auditable and easy to replace; the
// UI lists these sources under "Trip impact" rather than hiding them here.
export const MODES = {
  car: {
    label: 'Drive',
    verb: 'Head',
    icon: '🚗',
    // 404 g CO2/mile ÷ 1.609 — US EPA's typical passenger vehicle, one occupant.
    co2PerKm: 251,
    kcalPerKm: 0,
    // Only the walk/bike portion of a trip is heat-exposed; a car is (usually) air conditioned.
    heatExposed: false,
    // $0.67/mile ÷ 1.609 — IRS 2024 standard mileage rate, which bundles fuel,
    // maintenance, insurance and depreciation.
    costPerKm: 0.42,
  },
  bike: {
    label: 'Bike',
    verb: 'Ride',
    icon: '🚲',
    // Manufacturing and maintenance only. The European Cyclists' Federation
    // puts cycling at ~21 g/km all-in, of which ~16 g is the extra food eaten;
    // that part is reported separately here as calories, not carbon.
    co2PerKm: 5,
    kcalPerKm: 30, // ~500 kcal/h at a 16 km/h commuting pace
    heatExposed: true,
    costPerKm: 0.03, // rough maintenance allowance — the softest number here
  },
  foot: {
    label: 'Walk',
    verb: 'Walk',
    icon: '🚶',
    co2PerKm: 0,
    kcalPerKm: 62, // ~100 kcal/mile for a ~70 kg adult at moderate pace
    heatExposed: true,
    costPerKm: 0,
  },
};

// A METRO local bus at average occupancy, for the "what if you took transit"
// comparison line: ~0.17 kg CO2 per passenger-mile (FTA transit averages).
export const TRANSIT_CO2_PER_KM = 105;

// Rendered in the UI so the provenance of each figure travels with the number.
export const IMPACT_SOURCES = [
  {
    figure: 'Driving CO₂ — 251 g/km',
    source: 'US EPA, typical passenger vehicle: ~404 g CO₂ per mile, single occupant',
  },
  {
    figure: 'Cycling CO₂ — 5 g/km',
    source: "European Cyclists' Federation lifecycle estimate, manufacturing share only",
  },
  { figure: 'Walking CO₂ — 0 g/km', source: 'no vehicle; dietary energy reported as calories' },
  {
    figure: 'Transit CO₂ — 105 g/km',
    source: 'FTA transit averages, local bus at average occupancy (~0.17 kg/passenger-mile)',
  },
  { figure: 'Calories — 62 kcal/km walking, 30 cycling', source: '~100 kcal/mile, ~70 kg adult' },
  { figure: 'Driving cost — $0.42/km', source: 'IRS 2024 standard mileage rate, $0.67/mile' },
  {
    figure: 'Unshaded minutes',
    source: 'computed here: trip duration × the share of the route with no mapped canopy',
  },
  {
    figure: 'Green, shade, water',
    source: 'computed here from OpenStreetMap geometry along the route',
  },
];

// Default weights for the composite "pleasantness" score. Tunable in the UI.
export const DEFAULT_WEIGHTS = {
  green: 0.35, // share of the route next to parks, bayous, trees
  shade: 0.25, // tree canopy along the route -> heat protection
  quiet: 0.25, // avoids highways and big arterials
  direct: 0.15, // not a wandering detour; fewer turns
};

// Distances in metres.
export const GREEN_BUFFER_M = 60; // "next to green space"
export const TREE_BUFFER_M = 30; // "under canopy"
export const SAMPLE_SPACING_M = 75; // route sampling resolution

// Houston landmarks, weighted toward FIFA World Cup 2026 venues and fan sites.
export const PRESETS = [
  { name: 'NRG Stadium (Houston Sports Park / WC26 venue)', coord: [29.6847, -95.4107] },
  { name: 'Discovery Green (Fan Festival site)', coord: [29.7530, -95.3596] },
  { name: 'George R. Brown Convention Center', coord: [29.7527, -95.3565] },
  { name: 'Shell Energy Stadium', coord: [29.7522, -95.3524] },
  { name: 'Downtown Houston (City Hall)', coord: [29.7604, -95.3698] },
  { name: 'Rice University', coord: [29.7174, -95.4018] },
  { name: 'Texas Medical Center', coord: [29.7080, -95.3980] },
  { name: 'Museum District (MFAH)', coord: [29.7256, -95.3906] },
  { name: 'Buffalo Bayou Park', coord: [29.7614, -95.3894] },
  { name: 'Hermann Park / Houston Zoo', coord: [29.7157, -95.3900] },
  { name: 'The Heights (19th St)', coord: [29.8027, -95.4113] },
  { name: 'Montrose (Westheimer & Montrose)', coord: [29.7434, -95.3906] },
  { name: 'EaDo (East Downtown)', coord: [29.7480, -95.3450] },
  { name: 'Midtown METRORail (Ensemble/HCC)', coord: [29.7395, -95.3800] },
  { name: 'Memorial Park', coord: [29.7642, -95.4364] },
  { name: 'Houston Hobby Airport (HOU)', coord: [29.6454, -95.2789] },
  { name: 'Bush Intercontinental (IAH)', coord: [29.9902, -95.3368] },
  { name: 'Galleria / Uptown', coord: [29.7398, -95.4618] },
];

// Palette used for route lines and cards, in draw order.
export const ROUTE_COLORS = ['#1f7a4d', '#2563eb', '#b45309', '#7c3aed', '#be123c', '#0f766e'];

export const FALLBACK_DATA_URL = 'data/houston-green.json';
