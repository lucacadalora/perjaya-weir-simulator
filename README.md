# Perjaya Weir Simulator

A browser simulator of Bendung Perjaya, the gated weir on the Komering river near Martapura (OKU Timur, South
Sumatra, Indonesia), and of the river basin above it. It runs entirely in the browser on a 3D map (MapLibre GL JS with
a three.js scene), from static files: terrain and hydrology grids built from open data, researched facts about the
weir, and small calculation engines written as pure JavaScript functions with node tests. The interface is in
Indonesian with an English switch (`?lang=en`).

## What it simulates

- **Rain to flow** over the 4,305 km² catchment above the weir: a mean year, replay years from ERA5 rain (1991 to
  2025), or design floods; runoff coefficient, F.J. Mock and NRECA monthly methods and a daily soil bucket
  (`site/js/engine/rainflow.js`), compared with modelled GloFAS v4 flows.
- **The weir**: seven flood gates, three scouring sluices and the canal intake (gate type assumed: lift gates with a
  top flap), with the pond above and the tailwater below; automatic operation that holds the normal pond level, or manual openings
  (`site/js/engine/weir.js`, KP-02 2013 methods).
- **Flood extent beyond the normal river** below and above the weir by height above nearest drainage on a 30 m grid,
  and what it reaches: buildings, roads, rail, land cover in hectares, named places (`flood.js`, `impact.js`).
- **Irrigation** demand of the command area by half-month (KP-01 2013: land preparation, crop water use,
  percolation, effective rain, rotation groups) against the river's supply (`irrigation.js`).
- **Sediment** through the intake and the five settling basins, with flushing (`sediment.js`).
- **Maker mode**: a dam of your own anywhere in the basin: its catchment from the flow grid, the dam line, the storage
  curve, filling and level-pool routing with release and spill, and what the lake drowns (`grid.js`, `reservoir.js`).
- **A 3D scene** of the weir, its gates, intake and settling basins, with water surfaces driven by the computed flows.
- **In-page filming**: camera tours recorded to MP4 (WebCodecs) or a still picture, with a title card and the data
  credits burnt into every frame, and a share link that restores the view and settings.

The engines are described in `docs/ENGINE-SPEC.md`; the shapes and rules the modules follow are in
`docs/CONTRACT.md`.

## Quick start

Needs Node 20 or later. No install, no build step.

```sh
node tools/serve.mjs --port 8791
```

Then open <http://127.0.0.1:8791/>. Any static file server that serves `site/` works as well. The 3D scene needs
WebGL 2; a computer with a graphics card is recommended.

## Tests

```sh
npm test
# same as:
node --test --test-concurrency=4 'site/js/engine/*.test.js' 'site/js/sim/*.test.js' 'site/js/map/**/*.test.js' 'test/**/*.test.js'
```

The glob patterns need Node 22 or later. `test/targets.test.js` runs 39 hand-calculated targets
(`test/targets.json`, recomputed by `tools/targets/`) against the engines; three targets (FF-01, FF-03, FF-04) are
skipped because no engine exports the function they test. `node tools/data/check.mjs` checks the data files.

## Repository layout

| Path | What |
|---|---|
| `site/` | The web root: `index.html`, `css/`, `fonts/`, `js/`, `data/`, `vendor/` |
| `site/js/engine/` | Calculation engines (pure functions, no DOM) and their tests; `worker.js` runs them off the main thread |
| `site/js/sim/` | The simulation loop and clock, the weir and maker runners, scenarios |
| `site/js/map/` | Map, base map, 3D host, weir and dam models, water, flood tint, camera and filming |
| `site/js/ui/` | Panel, tabs, charts, status card, search, share link |
| `site/js/i18n/` | Indonesian and English text tables |
| `site/data/` | `params.json`, `facts.json`, `weir.json`, `presets.json`, `credits.json`; `grid/` terrain and hydrology grids; `tiles/` terrain, satellite and land-cover tiles; `feat/` map features; `climate/` rain and modelled flow |
| `data-src/` | The fragments `site/data/*.json` are built from (`node tools/data/build.mjs`) |
| `tools/` | Local server, data build and check, flood calibration table, i18n tools, test-target scripts, data preparation scripts (`tools/README.md`) |
| `test/` | Test targets and their runner |
| `docs/` | Build contract, engine spec, glossary, and the independent hydraulics review of the engines |
| `paper/` | The paper: LaTeX source and the scripts that produce every number in it |

## Numbers and their status

Every researched number carries one status letter: **S** sourced (a document says it), **C** computed from sourced
values, **R** read from a picture or map, **A** assumed, **P** from the press. Researched facts live in
`site/data/facts.json` (value, unit, status, year, sources, label and note in both languages); engine constants live in
`site/data/params.json` and the weir's geometry in `site/data/weir.json`, each value as `{v, unit, status, src}`. They
are built from `data-src/`. No researched number is typed into the code; the dossier tab lists every fact with its
status and source.

## URL options

| Option | Effect |
|---|---|
| `lang=en` | English (default Indonesian) |
| `tab=<ringkas\|operasi\|hujan\|irigasi\|dampak\|buat\|dosir\|film>` | open that tab |
| `mode=maker&dam=<preset id>` | maker mode with that preset dam placed (ids of `kind: "dam"` in `presets.json`); `mode=weir` for the weir |
| `scn=<mean\|dry2019\|design\|q100>`, `scnDay=<n>` | set a scenario (mean year, dry year, weir design flood, 100-year flood) and move to day n |
| `run=1`, `run=0`, `speed=<days per second>` | start or hold the clock, and its speed |
| `view=<name>` | camera view: `weir-downstream`, `weir-upstream`, `gates-close`, `weir-above`, `intake`, `martapura`, `rail-bridge`, `floodplain`, `basin`, `ranau`, `dam-site` |
| `play=<orbit\|orbit-close\|gates\|river\|floodplain>`, `tourSeconds=<n>`, `loop=1` | play a camera tour |
| `act=<gates\|touch\|flush>` | a scripted action: gates lift one after another, rings on the pond, a settling-basin flush |
| `ui=0` | hide the controls and show the film title card and credit line (for filming the page) |
| `t0=<s>` | hold `play`, `run` and `dam` until the page's own time reaches t0 seconds |
| `shot=1` | no idle animation, no automatic run |
| `layers=open`, `ground=0` | open the layers menu; turn off the close-zoom ground drape and terrain smoothing |
| `#c=lon,lat,zoom,pitch,bearing&m=<mode>&x=<state>` | the share link's camera, mode and settings (written by the page) |

## Limits of use

- Everything the simulator computes is an **indicative model**. It is not a survey, not a flood forecast, and not
  fit for design, operation or any decision about the real weir, its canal or the people near it.
- The terrain is the Copernicus GLO-30 **30 m surface model**: it includes tree tops and roofs and records the river at
  its water surface on the days it was flown. Flood extents, storage curves and catchments drawn on it carry that error.
- The **sill, bed and deck levels of the weir are assumed** (status A), derived from a few sourced levels; the river
  bed near the weir is an assumed carve into the terrain, not a measurement.
- **Replay years show seasonal flow, not flood peaks**: daily basin-mean rain understates storms. Floods come from the
  design-flood scenarios.
- The weir operator's manual and as-built levels were not available to this project.
- Building, road and place data are open map data with gaps; counts are a lower bound and say nothing about people,
  damage or loss.

## Data and licences

The code and the project's own data files are under the MIT licence (`LICENSE`). Third-party libraries, fonts and the
datasets derived from open data (Copernicus DEM, Sentinel-2, ESA WorldCover, OpenStreetMap via Overture Maps, ERA5 and
GloFAS via Open-Meteo) stay under their own licences, with the credit lines in `NOTICE.md`. How each data file was
made: `tools/dataprep/README.md`.

## Paper

`paper/perjaya-weir-simulator-paper.pdf` describes what the simulator computes, how well it agrees with published
tables, and where it stops; its appendices give the equations, the principal parameters with their status, and the
software design. Every number, table and plot in it is produced from this repository:

```sh
cd paper && make      # runs the engines on the data files, writes numbers.tex, tables and plots, compiles the PDF
```

`make` needs Node 22 or later, Python 3 with numpy and matplotlib, and a LaTeX distribution. `make pdf` only compiles.

## How to cite

See `CITATION.cff`.
