# Data preparation scripts

These are the scripts that made the terrain, hydrology, land-cover, map-feature, satellite and climate files under
`site/data/`. They were written during the research round before the build (lanes `g01` to `g07`, `r07`, `r14`; see
`docs/CONTRACT.md` for lane ids) and are published as they ran, with only the file paths changed. They are a record
of method, not a polished pipeline: no raw downloads are included, several steps read files that an earlier step or a
manual download put in place, and re-running them against today's services may give slightly different files.

## Running them

Python 3 with numpy, and per folder: rasterio, shapely, pyproj, scipy, pysheds 0.5, duckdb (with its `spatial` and
`httpfs` extensions), Pillow, matplotlib (check pictures only). Each script starts with two paths:

- `REPO`: the repository root (worked out from the script's own place).
- `WORK`: a scratch folder for downloads and intermediate files, `$PERJAYA_WORK` or `.scratch/work/` by default.
  Inside it the scripts keep the layout they were written for: `WORK/geo/` (shared rasters, `geo/raw/glo30/`,
  `geo/around/`, `geo/shots/` for check pictures) and `WORK/lanes/<lane id>/` (per-step downloads and intermediates).
  Copy `tools/dataprep/box.json` to `WORK/geo/box.json` first: it holds the two boxes all grids use
  (wide 103.30 to 105.00 E, 5.20 to 3.50 S; fine 104.20 to 104.55 E, 4.50 to 4.10 S).

Scripts that write into `site/data/` refuse to write anywhere outside the paths listed in their own `ALLOWED` or
`guard` lines.

## Which script made which file

| Output in `site/data/` | Script (folder in `tools/dataprep/`) | Open dataset | Notes |
|---|---|---|---|
| `tiles/terrain/{z}/{x}/{y}.png` + `tiles.json` (Terrarium, z6 to 12 wide box) | `terrain/build.py tiles` (lane g01) | Copernicus DEM GLO-30, six 1-degree COG tiles listed with SHA-256 in `terrain/glo30.sha256` | The tiles are not downloaded by the script: it reads `WORK/geo/raw/glo30/*.tif` (fetched from the public `copernicus-dem-30m` bucket). `terrain/build.py dem` first writes `WORK/geo/dem_wide.tif` and `dem_fine.tif`. |
| `tiles/terrain/` z10 to 14 inside the fine box, `feat/carve.json` | `carve/build.py carve`, then `tiles` (lane g07) | GLO-30 (via the g01 mosaic), `feat/rivers.geojson`, `feat/river_poly.geojson`, levels from `params.json` and `weir.json` | Lowers the river inside the 26 Apr 2026 outline to an ASSUMED bed 5 km either side of the weir and rewrites those tiles. |
| `feat/contours_wide.geojson`, `feat/contours_fine.geojson` | `terrain/build.py contours` (lane g01) | GLO-30 | 100 m and 12.5 m intervals, smoothed before contouring. |
| `grid/{wide,fine}.json`, `.dem.i16`, `.dir.u8`, `.acc.f32`, `.hand.i16`; `feat/catchments.geojson`, `feat/streams.geojson`, `feat/profile.json` | `hydro/ov.py`, `hydro/build.py wide` / `fine`, then `hydro/post.py` (lane g02) | GLO-30 (tiles read from `WORK/lanes/g02/dl/*.tif`), OpenStreetMap rivers and the weir point via Overture Maps release 2026-11-18.0 (`ov.py`) | Conditioning (pit and depression filling, flats, river burning, Danau Ranau flattened) with pysheds 0.5; details in each grid's json header. |
| `grid/wide.lc.u8`, `grid/fine.lc.u8`, `grid/lc.json` | `features/rasters.py` (lane g04) | ESA WorldCover 2021 v200, tile S06E102 (windowed read over HTTP) | Same script also writes `WORK/geo/water_occurrence_fine.tif` from JRC Global Surface Water occurrence 1.4; that raster is not shipped. |
| `feat/roads.geojson`, `feat/roads_fine.geojson`, `feat/rail.geojson`, `feat/places.geojson`, `feat/admin.geojson` | `features/fetch.py <layers>`, then `features/vectors.py` (lane g04) | Overture Maps release 2026-11-18.0 (transportation segments, divisions, division areas: OpenStreetMap-derived) | `places.geojson` comes from Overture *divisions* (OSM `place=*`), not from the Overture Places theme. |
| `feat/rivers.geojson`, `feat/lakes.geojson` | `features/rivers.py` (lane g04) | Overture Maps base/water (OpenStreetMap) | `rivers.geojson` was later given the properties `w` and `poly` by `tools/geo/river_widths.py`. |
| `feat/buildings.bin`, `feat/buildings.json`, `feat/buildings_fine.geojson` | `features/buildings.py`, `features/bfine.py` (lane g04; `vectors.py` first writes the river bands both use) | Overture Maps buildings theme, release 2026-11-18.0 (OpenStreetMap, Google Open Buildings, Microsoft ML Buildings) | Both scripts write `buildings_fine.geojson`; which run produced the shipped copy is not recorded (its header matches `bfine.py`'s "fine box ... within 1300 m of Sungai Komering" selection). |
| `tiles/sat/{z}/{x}/{y}.jpg` + `tiles.json` | `satellite/fetch.py`, with `satellite/z14list.py` for the z14 tile list (lane g03) | Sentinel-2 cloudless 2016 by EOX (WMTS, fetched 23 Nov 2026) | Copied tiles, no processing. `tiles.json` was written by hand or by a step not included. |
| `feat/river_poly.geojson` | `river-outline/fetch.py`, `index.py`, `poly.py` (lane g06) | Sentinel-2 L2A scene S2B_48MVA_20260426_0_L2A (bands B02, B03, B04, B08, B11 from the public `sentinel-cogs` bucket) | MNDWI / NDWI thresholds, method in the file header. |
| `tiles/sat2026/` + `tiles.json` | `river-outline/tiles.py sat` (lane g06) | Same Sentinel-2 scene, true colour | Outside the fine box each tile shows the EOX 2016 tile underneath. |
| `tiles/lc10/` + `tiles.json` | `river-outline/tiles.py lc` (lane g06) | ESA WorldCover 2021 v200 (read by `river-outline/fetch.py` into `WORK/lanes/g06/dl/wc.tif`) | Palette and resampling in `tiles.json`. |
| `climate/rain.json` | `rain/fetch_om.py`, then `rain/analyse.py` (lane r14) | ERA5 daily precipitation and FAO-56 reference evapotranspiration, 12 points, 1991 to 2025, Open-Meteo Historical Weather API | The station check named in `rain.json` (BMG rain at Banding Agung and Belitang from a 2003 JICA data book) was done from a text extract of that report; that script and extract are not included. |
| `climate/flow_glofas.json` | `glofas/build.py` (lane r07) | GloFAS v4 river discharge via the Open-Meteo Flood API | The script reads a saved API answer (`WORK/lanes/r07/glofas_-4.30_104.35.json`); the download itself was not scripted and is not included. The request point and cell are stated in the file's `meta`. |

Not included: check-picture scripts (`shots` steps that only draw PNGs into `WORK/geo/shots/` are left inside
`terrain/build.py` and `carve/build.py`, other picture scripts are left out), lane `g05` (no script on disk) and lane
`r09` (chainage of places along the river for the research notes; it wrote nothing into `site/data/`).

Licences of the datasets and the credit lines each derived file must carry: `NOTICE.md` at the repository root.
