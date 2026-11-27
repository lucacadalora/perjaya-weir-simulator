# Notices: third-party software, fonts and data

## What the MIT licence covers

`LICENSE` (MIT) covers the code of this project (`site/js/`, `site/css/`, `site/index.html`, `tools/`, `test/`) and
the project's own data files: `site/data/params.json`, `site/data/facts.json`, `site/data/weir.json`,
`site/data/presets.json`, `site/data/credits.json` and everything in `data-src/`, and the documents in `docs/`.
`facts.json` and `data-src/` cite published reports, papers and press articles; the citations are ours, the cited
works belong to their authors.

It does **not** cover the third-party software in `site/vendor/`, the fonts, or the datasets derived from open data
listed below. Those stay under their own licences, and the credit lines below must travel with them.

## Software in `site/vendor/`

Copied unchanged from npm registry tarballs (versions and SHA-256 sums in `site/vendor/VENDOR.md` and the
`VENDOR.md` files beside each library).

| Library | Version | Licence | Licence file |
|---|---|---|---|
| MapLibre GL JS (`maplibre-gl`) | 5.24.1 | BSD-3-Clause | `site/vendor/maplibre-gl/LICENSE.txt` |
| three.js (`three`), build and the add-ons in `examples/jsm/` | 0.187.0 | MIT | `site/vendor/three/LICENSE` |
| Draco decoder (inside three.js, `examples/jsm/libs/draco/gltf/`) | as shipped with three 0.187.0 | Apache-2.0 | stated in `site/vendor/three/examples/jsm/libs/draco/README.md` |
| maplibre-contour | 0.2.0 | BSD-3-Clause | `site/vendor/maplibre-contour/LICENSE` |
| mp4-muxer | 5.2.2 | MIT | `site/vendor/mp4-muxer/LICENSE` |

## Fonts

| Font | Where | Licence |
|---|---|---|
| IBM Plex Sans, IBM Plex Mono (WOFF2) | `site/fonts/` | SIL Open Font License 1.1, `site/fonts/OFL.txt` (Copyright 2019 IBM Corp.) |
| Noto Sans Regular and Medium, MapLibre glyph ranges 0-255 and 256-511 (from the Protomaps basemaps assets) and a local range 8192-8447 (dashes copied from the hyphen glyph) | `site/vendor/glyphs/` | SIL Open Font License 1.1, Copyright 2022 The Noto Project Authors (`site/vendor/glyphs/README.txt`) |

## Datasets

Credit lines are quoted from `site/data/credits.json` and the headers of the files themselves. The page shows them in
its credit line, its dossier and in every film frame and still picture. "Derived files" lists what in this repository
was made from each source (scripts: `tools/dataprep/README.md`).

| Source | Licence as stated in the files | Required credit (as written in the files) | Derived files |
|---|---|---|---|
| Copernicus DEM GLO-30 | `credits.json`: "Copernicus DEM licence" (url spacedata.copernicus.eu, collection copernicus-digital-elevation-model) | "Elevation: Copernicus DEM GLO-30, (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved." | `site/data/grid/{wide,fine}.{dem.i16,dir.u8,acc.f32,hand.i16}` and their json headers; `site/data/tiles/terrain/`; `site/data/feat/contours_*.geojson`, `catchments.geojson`, `streams.geojson`, `profile.json`, `carve.json` |
| Sentinel-2 cloudless 2016 by EOX IT Services GmbH | CC BY 4.0 | "Sentinel-2 cloudless 2016 by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016), CC BY 4.0, cloudless.eox.at" | `site/data/tiles/sat/`; also the parts of `site/data/tiles/sat2026/` tiles outside the fine box |
| Copernicus Sentinel-2 L2A, scene S2B_48MVA_20260426_0_L2A | `credits.json`: "Copernicus Sentinel data licence (free and open)" | "Contains modified Copernicus Sentinel data 2026" | `site/data/tiles/sat2026/`; `site/data/feat/river_poly.geojson` (with the OpenStreetMap river line); the river outline used in `feat/carve.json` and the carved terrain tiles |
| ESA WorldCover 2021 (v200) | CC BY 4.0 | "(c) ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0)." | `site/data/grid/wide.lc.u8`, `fine.lc.u8`, `lc.json`; `site/data/tiles/lc10/` |
| OpenStreetMap contributors, via Overture Maps Foundation release 2026-11-18.0 | ODbL 1.0 | "Map features: (c) OpenStreetMap contributors, available under the Open Database License (ODbL); data via Overture Maps Foundation (release 2026-11-18.0)." | `site/data/feat/roads.geojson`, `roads_fine.geojson`, `rail.geojson`, `rivers.geojson`, `lakes.geojson`, `admin.geojson`, `places.geojson`; the rivers burned into the `grid/*` flow directions and used for `feat/catchments.geojson` and `feat/streams.geojson` (stated in their headers); the river line in `feat/river_poly.geojson` and `feat/carve.json` |
| Overture Maps buildings theme, release 2026-11-18.0 | file header: "ODbL-1.0 (Overture buildings theme)" | "Buildings: Overture Maps Foundation release 2026-11-18.0: (c) OpenStreetMap contributors (ODbL 1.0); Google Open Buildings (CC BY 4.0 / ODbL); Microsoft ML Buildings (ODbL)" | `site/data/feat/buildings.bin`, `buildings.json`, `buildings_fine.geojson` |
| Overture Maps Places | `credits.json`: CDLA Permissive 2.0 | "Places: Overture Maps Foundation (release 2026-11-18.0), CDLA Permissive 2.0." | listed in `credits.json`; note that `feat/places.geojson` itself states it was made from Overture *divisions* (OpenStreetMap, ODbL), see the row above |
| ERA5 reanalysis via the Open-Meteo Historical Weather API | `rain.json` meta: "Open-Meteo API data: CC BY 4.0 (open-meteo.com/en/licence); free API is for non-commercial use only, under 10,000 calls/day (open-meteo.com/en/terms); commercial use needs a paid plan" and "ERA5: Copernicus licence (C3S), attribution required" | "Rain and evaporation: ERA5 reanalysis, generated using Copernicus Climate Change Service information; weather data by Open-Meteo.com (CC BY 4.0)." The file also lists Hersbach et al. (2023), doi:10.24381/cds.adbb2d47, and Zippenfenig (2023), doi:10.5281/zenodo.7970649 | `site/data/climate/rain.json` |
| GloFAS v4 river discharge (Copernicus Emergency Management Service) via the Open-Meteo Flood API | `flow_glofas.json` meta: "Open-Meteo API data CC BY 4.0 (link to open-meteo.com next to the data; free API for non-commercial use only, under 10,000 calls a day); underlying GloFAS data under the Copernicus/CEMS licence (free, attribution required)" | "River discharge: Copernicus Emergency Management Service, GloFAS v4 (modelled), via Open-Meteo.com (CC BY 4.0); summary statistics computed by us." | `site/data/climate/flow_glofas.json` |

Files under `site/data/` that are not listed here (`params.json`, `facts.json`, `weir.json`, `presets.json`,
`credits.json`) are the project's own and fall under the MIT licence.
