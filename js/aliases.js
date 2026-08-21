// Abbreviations people actually type.
//
// Geocoders match names, not local shorthand: "rga" finds nothing, "brc"
// finds nothing, "tmc tc" finds nothing. Each entry below expands to a name
// that Photon does resolve — every one was checked against the live service
// before being added, and anything that resolved to the wrong place (TDECU
// Stadium comes back as Shell Energy Stadium) was left out rather than
// shipped wrong.
//
// `full` is what gets searched; `label` is what the user sees explaining the
// match. Keep keys lowercase.

export const ALIASES = [
  // --- Rice campus -------------------------------------------------------
  { keys: ['rga'], full: 'Rice Graduate Apartments', label: 'Rice Graduate Apartments' },
  { keys: ['brc'], full: 'BioScience Research Collaborative', label: 'BioScience Research Collaborative' },
  { keys: ['rmc'], full: 'Rice Memorial Center', label: 'Rice Memorial Center' },
  { keys: ['fondren'], full: 'Fondren Library', label: 'Fondren Library, Rice' },
  { keys: ['duncan', 'duncan hall'], full: 'Duncan Hall Rice University', label: 'Duncan Hall, Rice' },
  { keys: ['brochstein'], full: 'Brochstein Pavilion', label: 'Brochstein Pavilion, Rice' },
  { keys: ['tudor'], full: 'Tudor Fieldhouse', label: 'Tudor Fieldhouse, Rice' },
  { keys: ['moody'], full: 'Moody Center for the Arts', label: 'Moody Center for the Arts, Rice' },
  { keys: ['rice stadium'], full: 'Rice Stadium', label: 'Rice Stadium' },

  // --- Texas Medical Center ---------------------------------------------
  { keys: ['tmc'], full: 'Texas Medical Center', label: 'Texas Medical Center' },
  {
    keys: ['tmc tc', 'tmctc', 'tmc transit'],
    full: 'Texas Medical Center Transit Center',
    label: 'TMC Transit Center',
  },
  {
    keys: ['mda', 'mdacc', 'md anderson'],
    full: 'MD Anderson Cancer Center',
    label: 'MD Anderson Cancer Center',
  },
  { keys: ['bcm'], full: 'Baylor College of Medicine', label: 'Baylor College of Medicine' },
  { keys: ['tch'], full: "Texas Children's Hospital", label: "Texas Children's Hospital" },
  {
    keys: ['hmh', 'methodist'],
    full: 'Houston Methodist Hospital',
    label: 'Houston Methodist Hospital',
  },
  {
    keys: ['uth', 'uthealth'],
    full: 'University of Texas Health Science Center at Houston',
    label: 'UTHealth Houston',
  },
  {
    keys: ['utmb'],
    full: 'University of Texas Medical Branch at Galveston',
    label: 'UTMB Galveston',
  },

  // --- Museums and attractions ------------------------------------------
  {
    keys: ['hmns'],
    full: 'Houston Museum of Natural Science',
    label: 'Houston Museum of Natural Science',
  },
  { keys: ['mfah'], full: 'Museum of Fine Arts Houston', label: 'Museum of Fine Arts, Houston' },
  { keys: ['cmh'], full: "Children's Museum Houston", label: "Children's Museum of Houston" },
  {
    keys: ['camh'],
    full: 'Contemporary Arts Museum Houston',
    label: 'Contemporary Arts Museum Houston',
  },
  { keys: ['holocaust'], full: 'Holocaust Museum Houston', label: 'Holocaust Museum Houston' },
  { keys: ['menil'], full: 'Menil Collection', label: 'The Menil Collection' },
  { keys: ['rothko'], full: 'Rothko Chapel', label: 'Rothko Chapel' },
  { keys: ['zoo'], full: 'Houston Zoo', label: 'Houston Zoo' },
  { keys: ['miller'], full: 'Miller Outdoor Theatre', label: 'Miller Outdoor Theatre' },

  // --- Venues ------------------------------------------------------------
  { keys: ['nrg'], full: 'NRG Stadium', label: 'NRG Stadium — WC26 venue' },
  {
    keys: ['grb'],
    full: 'George R. Brown Convention Center',
    label: 'George R. Brown Convention Center',
  },
  // BBVA Compass Stadium was renamed; both names point at the same ground.
  { keys: ['bbva'], full: 'Shell Energy Stadium', label: 'Shell Energy Stadium' },
  // Minute Maid Park is now Daikin Park; the old name still resolves.
  { keys: ['mmp', 'minute maid'], full: 'Minute Maid Park', label: 'Daikin Park (Minute Maid)' },
  { keys: ['dg'], full: 'Discovery Green', label: 'Discovery Green — Fan Festival site' },
  { keys: ['post'], full: 'POST Houston', label: 'POST Houston' },
  { keys: ['ion'], full: 'The Ion Houston', label: 'The Ion' },

  // --- Universities, Houston and statewide -------------------------------
  { keys: ['uh'], full: 'University of Houston', label: 'University of Houston' },
  { keys: ['uhd'], full: 'University of Houston-Downtown', label: 'UH-Downtown' },
  { keys: ['tsu'], full: 'Texas Southern University', label: 'Texas Southern University' },
  { keys: ['ust'], full: 'University of St. Thomas Houston', label: 'University of St. Thomas' },
  {
    keys: ['ut', 'ut austin', 'utexas'],
    full: 'University of Texas at Austin',
    label: 'UT Austin',
  },
  {
    keys: ['tamu', 'a&m', 'texas a&m', 'atm'],
    full: 'Texas A&M University',
    label: 'Texas A&M, College Station',
  },
  { keys: ['ttu'], full: 'Texas Tech University', label: 'Texas Tech, Lubbock' },
  { keys: ['utsa'], full: 'University of Texas at San Antonio', label: 'UT San Antonio' },
  { keys: ['smu'], full: 'Southern Methodist University', label: 'SMU, Dallas' },
  { keys: ['tcu'], full: 'Texas Christian University', label: 'TCU, Fort Worth' },
  { keys: ['shsu'], full: 'Sam Houston State University', label: 'Sam Houston State, Huntsville' },
  { keys: ['baylor'], full: 'Baylor University Waco', label: 'Baylor University, Waco' },

  // --- Airports ----------------------------------------------------------
  { keys: ['iah'], full: 'George Bush Intercontinental Airport', label: 'Bush Intercontinental (IAH)' },
  { keys: ['hou', 'hobby'], full: 'William P Hobby Airport', label: 'Hobby Airport (HOU)' },
];

const normalise = (text) => text.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');

/** The alias the user has typed in full, if any. */
export function exactAlias(query) {
  const q = normalise(query);
  return ALIASES.find((entry) => entry.keys.some((key) => key === q)) || null;
}

/**
 * Aliases worth offering while the user is still typing. Exact matches come
 * first, then keys that start with what has been typed, so "hm" offers HMNS
 * before anything else.
 */
export function matchAliases(query, limit = 4) {
  const q = normalise(query);
  if (!q) return [];

  const exact = [];
  const prefix = [];

  for (const entry of ALIASES) {
    if (entry.keys.some((key) => key === q)) {
      exact.push(entry);
      continue;
    }
    // Prefix-match single-word keys only. Multi-word keys like "rice stadium"
    // would otherwise hijack "ric" from the far better Rice University match.
    if (entry.keys.some((key) => !key.includes(' ') && key.startsWith(q))) prefix.push(entry);
  }

  return [...exact, ...prefix].slice(0, limit);
}
