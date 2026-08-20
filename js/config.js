// Central configuration: endpoints, travel modes, scoring weights, Houston presets.

export const TILE_URL = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
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

export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

export const MODES = {
  car: {
    label: 'Drive',
    icon: '🚗',
    // g CO2e per passenger-km. EPA average light-duty vehicle ~404 g/mi, single occupant.
    co2PerKm: 251,
    kcalPerKm: 0,
    // Only the walk/bike portion of a trip is heat-exposed; a car is (usually) air conditioned.
    heatExposed: false,
    costPerKm: 0.42, // IRS-style all-in cost of operating a car, $/km
  },
  bike: {
    label: 'Bike',
    icon: '🚲',
    co2PerKm: 5, // lifecycle emissions of the bicycle itself
    kcalPerKm: 30,
    heatExposed: true,
    costPerKm: 0.03,
  },
  foot: {
    label: 'Walk',
    icon: '🚶',
    co2PerKm: 0,
    kcalPerKm: 62,
    heatExposed: true,
    costPerKm: 0,
  },
};

// A METRO local bus, for the "what if you took transit" comparison line.
export const TRANSIT_CO2_PER_KM = 105;

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
