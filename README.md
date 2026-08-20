# Houston Route Comparison

**Not just the fastest way there — the one you'll survive in July.**

Built for the FIFA Sustainability Hackathon. Houston hosts seven FIFA World Cup 26 matches at
NRG Stadium in June and July, when the afternoon heat index regularly clears 105 °F. Every
mapping app in the world will tell a visitor the *fastest* way from Discovery Green to the
stadium. None of them will tell them which way has shade.

This app compares the realistic routes between two Houston points and scores each one on the
things that actually decide whether a person walks, bikes, or gives up and calls a car:

| Signal | What it measures | Source |
| --- | --- | --- |
| **Green space** | share of the route inside or within 60 m of a park, bayou, or green area | OpenStreetMap |
| **Tree canopy** | share of the route under mapped trees, tree rows, or woodland | OpenStreetMap |
| **Away from traffic** | share of route distance on freeways, tollways, and feeder roads | OSRM step data |
| **Directness** | detour vs. the shortest option, plus turns per km | OSRM |

Those four combine into a 0–100 **pleasantness score** with weights the user controls live.
Alongside it the app reports the sustainability numbers: CO₂ emitted or avoided versus driving
the same trip solo, the METRO-bus equivalent, calories burned, and — the Houston-specific ones —
**unshaded minutes outdoors** and the **longest stretch without drinking water**.

### Where the impact numbers come from

Every impact figure is a published average applied to the routed distance. None of it is
measured, live, or specific to a given vehicle or person. They live as named constants in
[`js/config.js`](js/config.js) so they are auditable and easy to swap, and the app lists these
same sources under "Trip impact" so provenance travels with the number.

| Figure | Value | Source |
| --- | --- | --- |
| Driving CO₂ | 251 g/km | US EPA typical passenger vehicle, ~404 g CO₂/mile, single occupant |
| Cycling CO₂ | 5 g/km | European Cyclists' Federation lifecycle estimate, manufacturing share only |
| Walking CO₂ | 0 g/km | no vehicle; dietary energy is reported as calories instead |
| Transit CO₂ | 105 g/km | FTA transit averages, local bus at average occupancy (~0.17 kg/passenger-mile) |
| Calories | 62 kcal/km walking, 30 cycling | ~100 kcal/mile for a ~70 kg adult |
| Driving cost | $0.42/km | IRS 2024 standard mileage rate, $0.67/mile (fuel, maintenance, insurance, depreciation) |
| Unshaded minutes, green %, water | — | computed here from OSM geometry along the route |

Caveats worth saying out loud: the ECF's full cycling figure is ~21 g/km once the extra food is
counted, and this app reports that part as calories rather than double-counting it as carbon.
The bike maintenance cost ($0.03/km) is a rough allowance, not a sourced figure. Car CO₂ assumes
a single occupant — carpooling divides it.

### Two scoring scales

The score can be read either way, and the toggle switches between them without re-routing:

| | Absolute | Relative |
| --- | --- | --- |
| **Scale** | fixed 0–1 per component: the real share of the route that is green, shaded, off big roads, plus how close it comes to a straight line | each component normalised across this candidate set |
| **Means** | "this route is 52% green" — the same 60 tomorrow, on any trip | "best of these five" |
| **Good for** | comparing trips, tracking change, reporting a number | ranking near-identical options |
| **Watch out** | nothing scores 100; sparse canopy data compresses the range | the best of five bad routes still scores 100 |

They genuinely disagree, which is the point. On Discovery Green → NRG by bike, absolute picks the
park detour that is 64% green; relative picks the route through The Commons, because it wins on
more components *relative to the field* even though it is less green in absolute terms.

Absolute directness is anchored on crow-flies efficiency (straight-line ÷ actual distance) rather
than "vs. the shortest option we happened to find", which is what makes it trip-independent.

## What makes this more than a route-drawing demo

Standard routing engines only ever offer the two or three fastest options, and in a grid city
those are near-identical. So the app *generates its own candidates*: after loading the green
layer, it finds large parks near the origin–destination corridor that would barely lengthen the
trip, then re-routes through them. The "most pleasant" route is usually one no routing engine
would have offered.

## Picking places

Any point in greater Houston works — Katy, Sugar Land, and Galveston included. Four ways in:

- **Type anything.** Live suggestions from [Photon](https://photon.komoot.io/), an OSM geocoder
  built for type-ahead. (Nominatim's usage policy forbids autocomplete, so it is kept as a
  one-shot fallback only.) Arrow keys and Enter work.
- **Click the map.** *Set start* / *Set finish*, then click. The point is reverse-geocoded so
  the box shows a real name rather than a coordinate pair.
- **Drag the pins.** Either endpoint can be dragged; the comparison re-runs on drop.
- **Paste coordinates**, or use ◎ for the browser's own location.

The World Cup venues and fan sites are still one keystroke away as starred suggestions, but they
are a shortcut, not the menu.

## Water stops

Drinking fountains (`amenity=drinking_water`, `water_point`, `drinking_water=yes`) within 120 m
of the route are pulled from the same Overpass round-trip, pinned on the map, listed in order
with how far along the route they sit, and flagged on the individual turn they belong to.

The headline number is not how many fountains exist but **the longest stretch without one** —
the question that actually matters at 100 °F. Decorative fountains (`amenity=fountain`) are
deliberately excluded: they are not potable, and pointing someone at one in that heat is worse
than saying nothing.

Two findings from the Houston data, both worth stating plainly:

- Buffalo Bayou Park → Discovery Green on foot: **6 refill points**, longest dry stretch 1.0 km.
- Rice University or Hermann Park → NRG Stadium on foot: **zero** mapped water within 120 m of
  any route, for the whole ~5 km. Fountains exist in Hermann Park, but not along the corridor
  people actually walk to the stadium.

That second result is either a genuine gap in Houston's pedestrian infrastructure or a gap in
OpenStreetMap's coverage of it. Both are worth knowing before a World Cup summer, and the app
says which it can and cannot tell.

## Turn-by-turn directions

Selecting a route produces exact directions built from OSRM's step data — with the shade layer
carried through to each individual instruction:

```
→ Turn right onto Crawford Street Bikeway     480 ft   green
← Turn left onto Austin Street Bikeway        600 ft
↖ Bear left onto Brays Bayou Greenway         370 ft   shaded, green
◎ Arrive at NRG Stadium, on your right         10 ft
```

Clicking any instruction zooms the map to that maneuver and highlights the stretch of road it
covers. Steps under 25 m and "continue" steps that restate the current road are folded into the
previous instruction, so a walking route reads as ~50 usable steps instead of 75 noisy ones.

A detail that is easy to get wrong: OSRM's `name` is *the way along which travel proceeds* for
that step — the road the maneuver puts you **onto**, not the one you are leaving. Houston's OSM
sidewalk network is largely unnamed, and there the bare turn word is more honest than inventing
a street name.

## Running it

It is a static site with no build step and no API keys.

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## How it works

```
origin, destination, mode
   │   (typed, clicked, dragged, or geolocated — Photon geocodes either way)
   │
   ├─ OSRM (FOSSGIS public instances) ──────────► 1–3 fastest alternatives
   │
   ├─ Overpass API over the route corridor ─────► parks, woods, trees, fountains
   │      └─ falls back to data/houston-green.json when Overpass rate-limits
   │
   ├─ pick large parks near the corridor ───────► re-route through each
   │
   ├─ sample every route at 75 m, test each sample against a grid-indexed
   │  green layer ─────────────────────────────► green %, shade %, big-road %
   │                                               → weighted 0–100 score
   │
   ├─ re-sample each OSRM step at 20 m ─────────► per-instruction shade / green
   │                                               → turn-by-turn directions
   │
   └─ match fountains within 120 m of the line ─► water stops in route order
                                                   → longest dry stretch
```

### Files

| File | Role |
| --- | --- |
| [`js/config.js`](js/config.js) | endpoints, emission factors, default weights, Houston presets |
| [`js/geo.js`](js/geo.js) | haversine, local projection, path resampling, point-in-polygon, grid index |
| [`js/routing.js`](js/routing.js) | OSRM calls, green-detour candidate generation |
| [`js/places.js`](js/places.js) | type-ahead search, reverse geocoding, geolocation |
| [`js/directions.js`](js/directions.js) | turn-by-turn instructions, per-step shade scoring |
| [`js/water.js`](js/water.js) | drinking-water matching along a route, longest dry stretch |
| [`js/greenspace.js`](js/greenspace.js) | Overpass query, caching, offline fallback, spatial indexing |
| [`js/scoring.js`](js/scoring.js) | route metrics, normalisation, composite score, badges |
| [`js/app.js`](js/app.js) | map, form, sliders, rendering |
| [`data/houston-green.json`](data/houston-green.json) | prebuilt inner-loop green extract (offline fallback) |

## Honest limitations

- **Tree canopy is only as good as OpenStreetMap.** Houston has ~2,000 individually mapped
  trees inside the loop, which under-reports real canopy. A production version would use the
  City of Houston / NAIP canopy raster or Landsat land-surface-temperature tiles instead.
- **Absolute scores are compressed by data sparsity.** Because canopy is under-mapped, absolute
  shade rarely exceeds 20%, which drags the absolute composite into the 50s even for genuinely
  pleasant routes. Better canopy data moves this number, not a change to the formula.
- **No transit legs yet.** METRO bus and METRORail appear only as a CO₂ comparison line.
  Routing an actual multimodal trip is the obvious next step.
- Public OSRM and Overpass instances are rate-limited and occasionally unavailable; the bundled
  extract covers the inner loop so a live demo still works when they are.

## Data and attribution

Routing by [OSRM](https://project-osrm.org/) via the FOSSGIS public instances. Map data
© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, queried through
[Overpass](https://overpass-api.de/). Basemap tiles © [CARTO](https://carto.com/attributions).
Emission factors from the US EPA (average light-duty vehicle, 404 g CO₂/mile) and FTA transit
averages.

## License

MIT
