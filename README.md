# CoolWays Houston

**Not just the fastest way there — the one you'll survive in July.**

Built for the FIFA Sustainability Hackathon. Houston hosts seven FIFA World Cup 26 matches at
NRG Stadium in June and July, when the afternoon heat index regularly clears 105 °F. Every
mapping app in the world will tell a visitor the *fastest* way from Discovery Green to the
stadium. None of them will tell them which way has shade.

CoolWays compares the realistic routes between two Houston points and scores each one on the
things that actually decide whether a person walks, bikes, or gives up and calls a car:

| Signal | What it measures | Source |
| --- | --- | --- |
| **Green space** | share of the route inside or within 60 m of a park, bayou, or green area | OpenStreetMap |
| **Tree canopy** | share of the route under mapped trees, tree rows, or woodland | OpenStreetMap |
| **Away from traffic** | share of route distance on freeways, tollways, and feeder roads | OSRM step data |
| **Directness** | detour vs. the shortest option, plus turns per km | OSRM |

Those four combine into a 0–100 **pleasantness score** with weights the user controls live.
Alongside it the app reports the sustainability numbers: CO₂ emitted or avoided versus driving
the same trip solo, the METRO-bus equivalent, calories burned, and — the Houston-specific one —
**unshaded minutes outdoors**.

## What makes this more than a route-drawing demo

Standard routing engines only ever offer the two or three fastest options, and in a grid city
those are near-identical. So CoolWays *generates its own candidates*: after loading the green
layer, it finds large parks near the origin–destination corridor that would barely lengthen the
trip, then re-routes through them. The "most pleasant" route is usually one no routing engine
would have offered.

## Running it

It is a static site with no build step and no API keys.

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## How it works

```
origin, destination, mode
   │
   ├─ OSRM (FOSSGIS public instances) ──────────► 1–3 fastest alternatives
   │
   ├─ Overpass API over the route corridor ─────► parks, water, woods, trees
   │      └─ falls back to data/houston-green.json when Overpass rate-limits
   │
   ├─ pick large parks near the corridor ───────► re-route through each
   │
   └─ sample every route at 75 m, test each sample against a grid-indexed
      green layer ─────────────────────────────► green %, shade %, big-road %
                                                  → weighted 0–100 score
```

### Files

| File | Role |
| --- | --- |
| [`js/config.js`](js/config.js) | endpoints, emission factors, default weights, Houston presets |
| [`js/geo.js`](js/geo.js) | haversine, local projection, path resampling, point-in-polygon, grid index |
| [`js/routing.js`](js/routing.js) | OSRM calls, green-detour candidate generation, geocoding |
| [`js/greenspace.js`](js/greenspace.js) | Overpass query, caching, offline fallback, spatial indexing |
| [`js/scoring.js`](js/scoring.js) | route metrics, normalisation, composite score, badges |
| [`js/app.js`](js/app.js) | map, form, sliders, rendering |
| [`data/houston-green.json`](data/houston-green.json) | prebuilt inner-loop green extract (offline fallback) |

## Honest limitations

- **Tree canopy is only as good as OpenStreetMap.** Houston has ~2,000 individually mapped
  trees inside the loop, which under-reports real canopy. A production version would use the
  City of Houston / NAIP canopy raster or Landsat land-surface-temperature tiles instead.
- **The score is relative, not absolute.** Each component is normalised across the candidate
  set, so a 90/100 means "best of these five", not "objectively pleasant".
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
