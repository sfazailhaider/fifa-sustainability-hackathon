# Licence for `houston-green.json`

`houston-green.json` is a Derivative Database extracted from OpenStreetMap via the Overpass API
(see [`tools/build-green-extract.mjs`](../tools/build-green-extract.mjs) for exactly how). Under
the OpenStreetMap Foundation's terms, any database derived from OSM data must be distributed
under the same licence:

> © OpenStreetMap contributors, available under the
> [Open Database Licence (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

In practice that means anyone redistributing this file, or a database derived from it, must:

- **attribute** OpenStreetMap contributors;
- keep it under **ODbL** (share-alike applies to derived *databases*);
- not add technical restrictions on it.

Produced Works — a map image, a screenshot, a rendered route — are not themselves subject to
share-alike, but still require attribution. The app credits OpenStreetMap in its footer and on
the map for that reason.

This applies to the data file only. The application code that reads it is a separate work under
default copyright — see the Licence section of the root README.
