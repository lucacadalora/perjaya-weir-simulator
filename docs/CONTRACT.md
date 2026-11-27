# Perjaya simulator: build contract (public edition)

**About this file.** This is the build contract the modules in this repository were written against, published so
that references in code comments ("CONTRACT 4.8", "CONTRACT A7.3") can be followed. The simulator was built as a set
of parallel work packages called *lanes*: `b01` to `b24` (browser modules), `s01` (simulation runner), `q01` (tests),
`x01` (hydraulic review), `g`, `w` and `s` (ground, water and sediment rounds, amendment A10), `t01` (vendored
libraries), the data lanes `g01` to `g07` and research lanes `r01` to `r15` of the research round before the build,
and `lead` (the coordinator). A lane id
in a code comment names the package that wrote the module.

This edition keeps sections 1 to 6 and the amendments of section 9 with their original numbering. Sections 7
(machine rules of the build computer) and 8 (release) are omitted. Some files named below were internal working files
of the build and are not in this repository: the settled-values file (`SETTLE.md` / `SETTLED.md`), the lane briefs
(`BRIEFS.md`), status and inbox files, QA reviews (`QA/...`), research notes (`r08-...` and similar),
`plan/T1-render-findings.md` and the developer test pages under `site/dev/`. Where a file has moved, the path given
is its place in this repository.

Adopted by the build lead, 23 Nov 2026 UTC. This file is the law for every lane. **Section 9 (amendments) wins over
everything above it.** `SETTLE.md` holds the settled values and wording; it wins over any number in a brief.

## 1. Product and scope

**What it is.** A browser simulator of Bendung Perjaya (the gated weir on Sungai Komering near Martapura, OKU Timur,
Sumatera Selatan) and of its river basin, on a real 3D map, built on MapLibre GL JS with three.js in a custom 3D
layer. Working title "Simulator Bendung Perjaya"; the title lives in one string (`app.title`).

**Two modes, one engine.**

| Mode | What the user does | What answers |
|---|---|---|
| `weir` (front door) | Watches and operates the real weir: rain over the real catchment becomes river flow, the gates and the intake split it, the pond and the river below rise and fall, the flood plain floods, the canal gets or misses its water | rain to flow, weir hydraulics, flood extent, impact count, irrigation balance |
| `maker` | Puts a dam of their own on any river in the basin (with presets for real and planned dams), sets its height, watches it fill over simulated years, reads what it drowns | catchment from the terrain grid, reservoir fill and storage curve, routing and spill, impact count |

**The six functions that must all work in build one:**
1. a place on a real 3D map, found by search or by presets;
2. rain simulation that fills or feeds it over simulated time, with speed chips;
3. a status card and charts that read it (level, volume or flow, inflow, outflow, fill history);
4. impact survey: flooded area tinted, buildings as dots with a count, roads and rail highlighted, hectares by land cover, places named;
5. release operation: modes and manual gates for the weir, release and spill for a maker dam;
6. automatic aerial filming with a title card burnt into the frames, a still picture and a share link.

Plus, because this is a real structure: a dossier tab with the researched facts, each with its status and source.

**Not in build one:** a sign-in, a server, live gauge readings, phone-first layouts (laptop first; a phone must not
break).

## 2. Public rules

1. **Honesty.** Everything the simulation computes is a model: the status card and the impact tab carry the line
   `app.model_note` ("Model indikatif, bukan hasil survei"). Never write "live", "real-time", "measured", "terukur" or
   "aktual" about a modelled value. Flood extent and reservoir shapes say they are drawn on a 30 m surface model that
   includes tree tops and roofs.
2. **Status on facts.** A researched fact shown anywhere carries one status letter: `S` sourced, `C` computed,
   `R` read from a picture or map, `A` assumed, `P` press. Facts come only from `site/data/facts.json` and
   `site/data/params.json` (section 4.9). No lane types a researched number into code or markup.
3. **Elevations.** Project documents give levels in the project datum ("EL +81.00"). The terrain grid has its own
   surface heights. The two are tied by ONE number, `params.datum.offset_m` (model = EL + offset), owned by lane b18.
   The interface shows project EL; the 3D scene works in model metres. Nobody else adds or subtracts an offset.
4. **Languages.** Indonesian first, English by a switch. Call `ctx.t(key, 'English fallback', vars)`; never write
   visible text any other way. Plain words; fixed terms are in `docs/GLOSSARY.md` (lane b03).
5. **Privacy.** No private project, company or person is named anywhere. No operator, ministry or company logo.
6. **Credits.** Every dataset on screen is credited from `site/data/credits.json` (lane b18): in the map's credit
   line, in the dossier, and burnt into every film frame and still picture.
7. **Nothing loads from another host at run time.** Libraries, fonts, glyphs, tiles and data are all inside `site/`.
8. **Light only.** No dark page and no dark panels; the only dark element allowed is the film's title card.
   Corners 4 px, no round pills, numbers in tabular figures, labels in small mono capitals.
9. **Never quiet.** Anything that takes more than about 300 ms shows what it is doing (a line of text with a moving
   bar). The first visible thing (map frame and title) appears before any big data file is requested.
10. **Errors.** A user never sees a raw error. A failed module shows one plain sentence in its own place and the rest
    of the app keeps working.
11. **`robots`**: the page carries `noindex`.

## 3. Repo layout and owners

`site/` is the web root: static files, plain ES modules, no build step. **One owner per path. You write only your own
paths.** (In the build, lanes asked other owners through inbox files, which are not published.)

| Path | Owner |
|---|---|
| `site/index.html`, `site/js/main.js`, `site/js/store.js`, `site/js/data.js`, `site/js/ui/panel.js`, `site/js/ui/toolbar.js`, `site/js/ui/statuscard.js`, `site/js/ui/loading.js`, `site/js/ui/tab-ringkas.js` | b01 |
| `site/css/**`, `site/fonts/**`, `site/img/**`, `site/js/ui/icons.js` | b02 |
| `site/js/i18n.js`, `site/js/i18n/**`, `site/js/fmt.js`, `docs/GLOSSARY.md`, `tools/i18n/**` | b03 |
| `site/js/map/map.js`, `site/js/map/scene3d.js`, `site/js/map/geo.js`, `site/js/map/terrain-sampler.js` | b04 |
| `site/js/map/basemap.js`, `site/js/map/layers-menu.js`, `site/data/style/**`, `site/vendor/glyphs/**` | b05 |
| `site/js/map/water.js`, `site/js/map/water/**` | b06 |
| `site/js/map/floodmask.js`, `site/js/map/impact-layers.js` | b07 |
| `site/js/map/structures/weir.js`, `site/js/map/structures/weir/**`, `site/js/map/structures/mount-weir.js` | b08 |
| `site/js/map/structures/site.js`, `site/js/map/structures/site/**` | b09 |
| `site/js/map/camera.js`, `site/js/map/film.js`, `site/js/map/film/**`, `site/js/ui/tab-film.js`, `site/js/ui/share.js` | b10 |
| `site/js/engine/grid.js`, `site/js/engine/worker.js`, `site/js/engine/client.js`, `site/js/engine/node-loader.js`, their tests | b11 |
| `site/js/engine/reservoir.js` and its tests | b12 |
| `site/js/engine/rainflow.js` and its tests, `site/js/sim/scenarios.js` | b13 |
| `site/js/engine/weir.js` and its tests | b14 |
| `site/js/engine/flood.js` and its tests, `tools/calib/**` | b15 |
| `site/js/engine/impact.js` and its tests | b16 |
| `site/js/engine/irrigation.js` and its tests, `site/js/ui/tab-irigasi.js` | b17 |
| `site/data/facts.json`, `site/data/params.json`, `site/data/weir.json`, `site/data/credits.json`, `site/data/presets.json`, `data-src/**`, `tools/data/**`, `site/js/ui/tab-dosir.js` | b18 |
| `site/js/ui/charts.js`, `site/js/ui/tab-hujan.js` | b19 |
| `site/js/ui/tab-operasi.js`, `site/js/ui/weir-section.js` | b20 |
| `site/js/ui/tab-buat.js`, `site/js/ui/search.js` | b21 |
| `site/js/ui/tab-dampak.js` | b22 |
| `site/js/map/thematic.js` | b23 |
| `site/js/map/structures/dam.js`, `site/js/map/structures/mount-dam.js` | b24 |
| `site/js/sim/loop.js`, `site/js/sim/clock.js`, `site/js/sim/weir-run.js`, `site/js/sim/maker-run.js` | s01 |
| `test/**` | q01 |
| `site/data/tiles/**`, `site/data/grid/**`, `site/data/feat/**`, `site/data/climate/**` | the research round's data lanes (finished; their scripts are in `tools/dataprep/`). Read-only for build lanes |
| `site/vendor/maplibre-gl/**`, `site/vendor/three/**`, `tools/serve.mjs`, `package.json` | finished lanes. Read-only |
| `docs/CONTRACT.md` | lead |

## 4. Shapes

### 4.1 Store (`site/js/store.js`, frozen)

`ctx.store`: `get(path)`, `set(path, value)`, `patch(path, object)`, `on(path, fn, {immediate})` returning an off
function, `emit(event, payload)`, `listen(event, fn)`, `snapshot()`. Paths are dot-separated. A change notifies the
path, its ancestors and subscribed descendants. **All talk between modules goes through the store, `ctx.fields` and
the functions on `ctx`. A UI module never imports a map or sim module, and the other way round.**

### 4.2 `ctx` (built in `main.js`)

| Key | Set by | What |
|---|---|---|
| `store`, `data`, `fields`, `t`, `fmt`, `log`, `query`, `dev`, `shot` | main | `data.json(path)`, `data.bin(path)`, `data.text(path)`, `data.url(path)`, `data.onProgress(fn)`; paths relative to `site/data/`. `fields.get/set/on(name)` for big arrays. `shot` is true with `?shot=1`: no idle animation, no auto-run |
| `map`, `geo`, `scene3d`, `sampler` | `map/map` (b04) | the MapLibre map; `geo` helpers; the three.js host (4.7); `sampler.elevation(lon, lat)` in model metres from the terrain tiles |
| `camera` | `map/camera` (b10) | `camera.goto(name or {lon, lat, zoom, pitch, bearing}, {ms})`, `camera.tour(name)`, `camera.views` |
| `engine` | `engine/client` (b11) | `engine.call('module.function', args)` returning a Promise (4.8), `engine.ready` |
| `sim` | `sim/loop` (s01) | `sim.step(dtDays)`, `sim.reset()`, `sim.run(bool)` |
| `panel` | `ui/panel` (b01) | `panel.addTab({id, order, label: [id, en], modes: ['weir','maker'], mount(el), onShow()})` |
| `film` | `map/film` (b10) | `film.start({tour, seconds, size})`, `film.stop()`, `film.still()` |

A module is `site/js/<path>.js` exporting `async function init(ctx)`. The load order is the `MODULES` list in
`main.js`. A module that needs something another module sets (`ctx.map`, `ctx.panel`, `ctx.engine`) checks for it and
returns quietly when it is absent, so each lane can test with `index.html?only=<list of modules>`.
`window.__simReady` turns true when boot is over; `window.__simStep(dtSeconds)` (s01) advances the simulation and the
camera by exactly that much real time for the film tool; `window.__modules` lists what loaded.

### 4.3 Text and numbers

`ctx.t(key, 'English fallback', {vars})`; keys are `<area>.<name>` with your tab or module as the area. Elements may
carry `data-t="key"` with the English text inside. `ctx.fmt`: `num(v, digits)`, `q(v)`, `vol(m3)`, `area(km2)`,
`ha(v)`, `el(m)`, `len(m)`, `pct(fraction)`, `date(iso)`; all return "–" for missing values. Lane b03 harvests the
keys and writes both language tables: other lanes never edit `i18n/`.

### 4.4 State keys (frozen names and units; the writer is in brackets)

```
lang        'id' | 'en'                                                     [b01 toolbar]
mode        'weir' | 'maker'                                                [b01 toolbar]
tab         tab id                                                          [b01 panel]
clock       { day (days since start, float), date 'YYYY-MM-DD', start_date, speed (simulated days per real second),
              running }                                                     [s01; speed and running also by UI]
scenario    { kind 'climatology'|'replay'|'design', year, rain_scale, label, design_T (years) }   [b19 tab-hujan]
rain        { annual_mm, monthly_mm[12], runoff_share (0..1) }  controls    [b19 tab-hujan]
            { today_mm }                                         result     [s01]
flow        { q_in (m3/s at the weir), q_base, q_ranau }                    [s01]
weir        controls: { mode 'auto'|'manual'|'flush'|'flood'|'closed', gates[7] (opening m, gate 1 first),
              sluices[3] (opening m), intake_open (0..1), demand_m3s }      [b20 tab-operasi]
            results:  { pond_el, tail_el (project EL, m), q_gates, q_sluices, q_intake, q_down, q_spill (m3/s),
              freeboard_m, alerts[] (codes) }                               [s01]
flood       { stage_m (water depth above the low-flow river surface at the weir tail), q, area_km2,
              depth_max_m, version }                                        [s01]
impact      { buildings, footprint_m2, roads_km, rail_km, lc_ha {class: ha}, places [{name, kind}], version } [s01]
irrigation  { area_ha, demand_m3s, supplied_m3s, shortfall_m3s, reliability }  [s01, controls by b17]
maker       { active (dam id or null), placing (bool), dams [ {
              id, name, lon, lat, grid 'wide', idx, type 'gravity'|'embankment', crest_el, base_el, height_m,
              crest_len_m, release_m3s, spill_width_m,                       controls [b21 tab-buat]
              catchment_km2, fsl_area_km2, fsl_volume_m3, inflow_m3s, level_el, volume_m3, fill (0..1),
              spill_m3s, status 'computing'|'filling'|'full'|'spilling'|'empty', line {a:{lon,lat}, b:{lon,lat}} } ] }
                                                                             results [s01]
view        { base 'topo'|'sat'|'blend', exaggeration, layers { contours, roads, labels, buildings, canals,
              catchment, gauge, admin } }                                   [b05 layers-menu]
film        { state 'idle'|'recording'|'encoding'|'done', tour, progress }  [b10]
history     { day[], q_in[], pond_el[], q_down[], q_intake[], fill[] }  ring buffers, at most 1,500 points  [s01]
```

Maker dam elevations are model metres (there is no project datum away from the weir). Results a module has not
computed yet are `null`; every reader shows "–" for `null`. Controls are written by their tab and read by `s01`;
results are written only by `s01`.

Events on the store bus: `app:ready`, `sim:reset`, `sim:tick` (after each step), `camera:goto` (payload as
`camera.goto`), `maker:place` (payload `{lon, lat}`), `maker:remove` (`{id}`), `toast` (`{text, kind}`),
`film:frame`.

### 4.5 Fields (big arrays, `ctx.fields`)

| Name | Value | Writer |
|---|---|---|
| `flood.mask` | `{ grid:'fine', mask: Uint8Array (1 = wet), depth_dm: Int16Array or null, version }` | s01 |
| `reservoir.mask:<dam id>` | `{ grid:'wide', mask: Uint8Array, level_el, bbox:[c0,r0,c1,r1], version }` | s01 |
| `catchment.mask:<dam id or 'weir'>` | `{ grid:'wide', mask: Uint8Array, area_km2, outline: GeoJSON }` | s01 |
| `impact.points` | `Float32Array` of lon, lat pairs of the affected buildings (at most 20,000) | s01 |
| `impact.lines` | GeoJSON FeatureCollection of the flooded road and rail pieces (`kind` property) | s01 |
| `grid.meta:<wide or fine>` | the grid's json header | b11 |

### 4.6 Charts (`site/js/ui/charts.js`, b19)

`lineChart(el, {x, series:[{name, y, color, fill, dashed}], height, yMin, yMax, yLabel, xFormat, yFormat, markers,
bands})` and `barChart(el, {labels, values, highlight, height, yLabel, yFormat, color})`, each returning
`{update(opts)}`. A seed exists; import it directly.

### 4.7 The 3D host (`site/js/map/scene3d.js`, b04) and models

- One MapLibre custom layer holds one three.js scene (shared WebGL context). Recipe:
  `plan/T1-render-findings.md` (an internal note of the build, not published).
- **Model frame:** metres at true scale. `+X` east, `+Y` up, `+Z` south (so north is `-Z`). A model's origin sits on its
  own reference point at its reference elevation (stated in the model's file header).
- `ctx.scene3d.add(object3D, {lon, lat, el, bearing_deg})` returns a handle with `set({lon, lat, el, bearing_deg})`
  and `remove()`; `el` is model metres. `ctx.scene3d.onFrame(fn(dtSeconds, timeSeconds))`, `ctx.scene3d.requestRender()`,
  `ctx.scene3d.THREE`, `ctx.scene3d.toLocal(lon, lat, el)` returning `[x, y, z]` in the scene frame.
- **Models are pure factories** that never touch the map, so they can be built and photographed alone (in the build, on a developer page
  `site/dev/models.html`, not published):
  `buildWeir(THREE, weirParams)` returns `{ group, setGates(openings_m[7]), setSluices(openings_m[3]),
  setLevels({pond_y, tail_y}), update(dt) }` (b08);
  `buildDam(THREE, {profile:[{d_m, ground_m}], crest_el, base_el, type, crest_width_m, spill_width_m})` returns
  `{ group, setSpill(q_m3s), update(dt) }` with X along the dam line from bank `a` to bank `b` (b24);
  `buildSite(THREE, siteParams)` returns `{ group, update(dt) }` (b09).
- Never boxes for a real structure: piers, gates, hoist deck, bridge and intake are modelled as what they are, from
  `site/data/weir.json` and the reference pictures.

### 4.8 Engines (pure functions, `site/js/engine/*.js`)

No DOM, no `window`, no imports outside `engine/`. Each file has a `*.test.js` beside it, run with
`node --test --test-concurrency=4 site/js/engine/`. Heavy calls run in the worker: the worker imports every engine
module and `ctx.engine.call('reservoir.fillReservoir', args)` runs `reservoir.fillReservoir(G, args)` there, where
`G = { wide, fine }` holds the grids. So **every exported engine function that needs a grid takes `G` first and an
args object second, and names its grid by string (`grid: 'wide'`).** Typed arrays in results are transferred.

Grid object (b11): `{ name, west, south, east, north, cols, rows, cell (degrees), dem (Int16Array, decimetres),
dir (Uint8Array, D8), acc (Float32Array, km2) or null, hand (Int16Array, dm) or null, lc (Uint8Array) or null,
cellAreaKm2(row) }`, row-major from the north-west corner. The pack format is in `site/data/grid/*.json`.

```
grid.js       loadGrid(name, fetchBinary)            lonLatToCell(g, lon, lat) -> {col,row,idx}|null
(b11)         cellToLonLat(g, col, row)              elevationAt(g, lon, lat) -> m (bilinear)
              downstream(g, idx) -> idx|-1           snapToStream(G, {grid, lon, lat, min_km2, radius_cells})
              catchment(G, {grid, idx}) -> {mask, cells, area_km2, bbox}
              accumulate(g) -> Float32Array km2      traceDownstream(G, {grid, idx, max_steps}) -> {idx: Int32Array, dist_km: Float32Array, el_m: Float32Array}
              maskOutline(G, {grid, mask, simplify}) -> GeoJSON MultiPolygon
reservoir.js  damLine(G, {grid, idx, crest_el}) -> {ok, a, b, length_m, bearing_deg, height_m, base_el, profile:[{d_m, ground_m}]}
(b12)         fillReservoir(G, {grid, idx, level_el, line}) -> {mask, cells, area_km2, volume_m3, mean_depth_m, max_depth_m, bbox}
              storageCurve(G, {grid, idx, crest_el, line, steps}) -> {level_el[], area_km2[], volume_m3[]}
              volumeAt(curve, level_el)   levelAt(curve, volume_m3)   areaAt(curve, level_el)
              routeStep({curve, volume_m3, crest_el, spill_width_m, spill_cd, release_m3s, evap_mm_day}, inflow_m3s, dt_s)
                -> {volume_m3, level_el, release_m3s, spill_m3s, evap_m3s}
rainflow.js   runoffCoeff({rain_mm, area_km2, share, seconds}) -> m3/s
(b13)         mockMonthly({rain_mm[12], pet_mm[12], area_km2, params}) -> {q_m3s[12], base[12], direct[12]}
              bucketStep(state, {rain_mm, pet_mm, dt_days}, params) -> {q_mm, state}
              inflowSeries({kind, year, rain, flow, area_km2, rain_scale, share, params}) -> {start, q_m3s: Float32Array, rain_mm: Float32Array}
              dependable(values, pct) -> value       gumbel(annualMax[]) -> {mu, beta, q(T)}
weir.js       gateFlow({type 'radial'|'sluice'|'flap', opening_m, width_m, h_up_m, h_down_m, cd}) -> {q_m3s, regime}
(b14)         crestFlow({width_m, head_m, cd, submergence}) -> m3/s
              tailwater(q_m3s, weirParams) -> el (project EL)
              solve({q_in, controls, weirParams, pond_el_prev, dt_s}) -> {pond_el, tail_el, q_gates, q_sluices, q_intake, q_down, q_spill, freeboard_m, gates[7], sluices[3], alerts[]}
              autoGates({q_in, demand_m3s, weirParams, pond_el}) -> {gates[7], sluices[3], intake_open}
flood.js      stageAt(q_m3s, floodParams) -> stage_m
(b15)         extent(G, {grid:'fine', stage_m, floodParams}) -> {mask, depth_dm, cells, area_km2, volume_m3, depth_max_m}
impact.js     indexBuildings(bin, meta) -> buildings          (kept inside the worker)
(b16)         count(G, {grid, mask, max_points}) -> {buildings, footprint_m2, points: Float32Array, lc_ha, cells}
              lines(G, {grid, mask, features}) -> {roads_km, rail_km, geojson}
              places(G, {grid, mask, places, buffer_cells}) -> [{name, kind}]
irrigation.js demand({area_ha, month, day, pattern, params}) -> m3/s
(b17)         balance({q_river[], demand[], intake_capacity_m3s, env_flow_m3s}) -> {supplied[], shortfall[], reliability}
```

Engines take their constants from arguments (`weirParams`, `floodParams`, `params`), never from a number in the code:
the values come from `site/data/params.json` and `site/data/weir.json`. Test targets:
`test/targets.json` (originally `plan/P2-targets-draft.json`; made by `tools/targets/`). **A target is never loosened by a lane.**

### 4.9 Data files

| File | Shape | Owner |
|---|---|---|
| `site/data/facts.json` | `{ meta, facts: { "<key>": { v, unit, status 'S'|'C'|'R'|'A'|'P', year, src [source keys], label: {id, en}, note: {id, en}, alt: [{v, src}] } }, sources: { "<key>": { title, publisher, year, url } }, timeline: [ {date, id, en, src} ] }` | b18 |
| `site/data/params.json` | engine constants, grouped: `datum {offset_m}`, `catchment`, `rainflow`, `weir` (hydraulic coefficients, levels in project EL), `flood`, `irrigation`, `evap`; every leaf is `{v, unit, status, src}` and `tools/data/` also writes a flat copy under `flat` for the engines | b18 |
| `site/data/weir.json` | the weir's geometry for the 3D model and the section drawing: axis `{lon, lat, bearing_deg}`, bays in order from the left bank (kind 'flood'|'sluice', width, gate height, sill EL), piers, deck, bridge, intake, settling basins, fish ladder, canal head; every value `{v, status, src}` | b18 |
| `site/data/presets.json` | places and dams for search and maker mode: `[{id, kind 'place'|'dam'|'view', name:{id,en}, lon, lat, zoom, pitch, bearing, dam:{crest_el, type, ...}}]` | b18 |
| `site/data/credits.json` | `[{id, short, full, licence, url}]` | b18 |
| `site/data/grid/{wide,fine}.json` + `.dem.i16`, `.dir.u8`, `.acc.f32`, `.hand.i16`, `.lc.u8`, `lc.json` | terrain and hydrology grids (see the json headers) | data lanes |
| `site/data/feat/*.geojson`, `buildings.bin` + `buildings.json`, `profile.json` | map features | data lanes |
| `site/data/climate/rain.json`, `flow_glofas.json` | daily basin rain 1991 to 2025, modelled daily river flow 1997 to 2026 | data lanes |
| `site/data/tiles/terrain/{z}/{x}/{y}.png` (Terrarium), `site/data/tiles/sat/{z}/{x}/{y}.jpg`, each with `tiles.json` | map tiles | data lanes |

## 5. Look (lane b02 owns the stylesheet; the names are frozen so other lanes can write markup now)

Regions in `index.html`: `#map` (full screen), `#topbar` (title, mode switch, search, language), `#status`
(status card, top left), `#maptools` (map buttons, bottom left), `#panel` (right, 392 px, tab bar on top),
`#toast`, `#credits`, `#loading`.

Classes: `.btn`, `.btn--primary`, `.btn--quiet`, `.btn--icon`, `.chips` (a segmented row of `button[aria-pressed]`),
`.field` (a label over a control), `.slider` (a labelled range input: `.slider__label`, `.slider__value`,
`input[type=range]`), `.tiles` (grid) of `.tile` (`.label`, `.value`, `.unit`, optional `.status-letter`), `.card`,
`.card__title`, `.label` (small mono capitals), `.table`, `.note`, `.alert` with `--warn` or `--danger`, `.legend`
of `.legend__item` with a `.swatch`, `.tabbar` and `.tab[aria-selected]`, `.tabpanel`, `.status-letter` (`data-s`
holds the letter), `.kv` (a two-column list of label and value), `.sep`. Tokens are the CSS variables in
`site/css/app.css`. Use these names; do not write private CSS in your module beyond layout that is truly your own
(prefix such classes with your tab id).

Direction: an engineering instrument on a survey map. The map is the page; panels are white, flat, bordered, never
blurred glass. One blue accent, amber for warnings, red only for danger and flood. Laptop first (1440 by 900 and
1280 by 720 must both work without scrolling the page); at 390 px wide the panel becomes a bottom sheet.

## 6. Gates

- `node --test --test-concurrency=4 site/js/engine/ test/` is green.
- A headless-browser check of `/index.html`, `/index.html?lang=en` and `/index.html?shot=1` reports no console error,
  page error or failed request (the build used a browser-pool tool of its own build machine, not included here).
- Shots of the front door at 1440 by 900 and 390 by 844 exist, and somebody has looked at them.
- No visible string is outside `ctx.t`; no researched number is typed in code (grep by q01).
- Every picture and film carries the credit line.

## 9. Amendments (newest last; they win)

A1 (lead, 23 Nov 2026): **Which way the river runs.** At the weir Sungai Komering flows from SOUTH to
NORTH (checked on the flow grid: 60 cells downstream of the weir lie 1.9 km to the north). The weir axis runs
east to west. So the RIGHT bank is the EAST side (Perjaya village: the three narrow sluice bays, the intake, the
five settling basins, the canal head at about 104.3855 E, 4.3020 S, the fish ladder, the operator's office) and the
LEFT bank is the WEST side (Keromongan). Upstream (the pond, Martapura, the rail bridge) is to the south.
The note `r08-weir-geometry-look.md` has north and south, and left and right, the wrong way round: take its
shapes and sizes, not its compass words.

A2 (lead, 23 Nov 2026): **The frame clock, map clicks and three more fields** are law as written in the
LEAD ADDENDUM of `BRIEFS.md` (not published): `store.emit('frame', {dt, t})` by lane s01 is the only source of animation time;
lane b04 emits `map:click` `{lon, lat}`; lane s01 writes the fields `dam.line:<id>`, `reservoir.curve:<id>` and
`scenario.series`.

A3 (lead, 23 Nov 2026): **Water against terrain.** The rendering test found that MapLibre's terrain is in
the depth buffer when the custom layer draws, so a flat water surface in the three.js scene is cut by the ground
exactly where ground = level. Lane b06 may rely on that depth test for the shoreline and use the mask texture only
to keep water out of unconnected hollows. Recipe: `plan/T1-render-findings.md` (not published).

A4 (lead, 23 Nov 2026 10:35 UTC): **The close view is a drawn map, not a blurred photo.** The satellite picture is
10 m per pixel: sharp from far away, blurred once the camera is closer than about zoom 13.5. So in the default base
(`blend`) lane b05 shows the satellite picture at full strength up to zoom 13 and fades it to about 0.25 by zoom
15, over a drawn base that stays sharp at any zoom: the land-cover picture (`site/data/tiles/lc10/`, 10 m, fine box,
zoom 11 to 15, arriving from lane g06; before that the tint from `wide.lc.u8`), hillshade, contours, the river as a
filled outline from `site/data/feat/river_poly.geojson` (lane g06, arriving), canals, roads with casings, building
footprints from `buildings_fine.geojson` as flat fills (on by default above zoom 14), rail and names. `view.base`
`sat` still shows the satellite picture at full strength at every zoom, and above zoom 12.5 inside the fine box it
uses the newer picture in `site/data/tiles/sat2026/` (26 Apr 2026, lane g06) when that exists. `topo` is the drawn
base alone. Lane b06 clips the water sheets at the weir to `river_poly.geojson` when it exists.

A5 (lead, 23 Nov 2026 10:40 UTC): **Normal pond level and design high water are two levels.** Ruling on the
conflict in `SETTLED.md`: the normal pond level that the gates hold is **EL 79.70** (the 2019 JICA report's spec
sheet from the operation manual gives EL 79.70 as the intake's water level and EL 81.00 as the design high water
level, two separate lines); the **design high water is EL 81.00**, reached only in the design flood with every gate
open. The student paper's "pond held at +81.00" stays as an `alt` value. Lane b18 changes `params.json` and
`weir.json` accordingly and re-derives every assumed level from it (gate sills = normal pond + 0.20 m freeboard
minus the gate height; the datum offset from the terrain's pond surface minus EL 79.70; tail levels and beds from
the terrain's tail surface and the new offset). No other lane changes a number: everything follows the data files.
Check for every lane with tests on real data: after b18's change, in automatic mode the pond holds EL 79.70 across
normal flows, and the design flood of 2,200 m3/s with every gate open peaks at or a little under EL 81.00.

A6 (lead, 23 Nov 2026 10:40 UTC): **Test command.** Node 24 does not take a folder: the gate runs
`node --test --test-concurrency=4 'site/js/engine/*.test.js' 'test/**/*.test.js'`.

A7 (lead, 23 Nov 2026 10:50 UTC): **Rulings on the hydraulic review** (the review of lane x01, not published; its
finding numbers are used here). They bind b13, b14, b15, b17, b18, b12, s01, b19, b22.
1. **H1, one tailwater rating, anchored on the sourced design case.** The river's rating below the weir is the
   Manning section whose bed makes the tail level EL 80.00 at 2,200 m3/s (`weir.tailwater_flood_case_el`, sourced).
   b18 sets `weir.tail_bed_el` from that (about EL 74.0, status C, arithmetic in the note) and removes the anchor on
   the terrain's surface at mean flow. Check: with every gate open the design flood peaks at or under EL 81.00.
2. **L11, the flood engine uses the same rating** (`flood.stageAt` takes the weir's tail level, not a second section).
3. **H4 and M9, what counts as flooded.** The terrain records the river at some water level of its survey days; we
   take that level as the edge of the normal channel. Reference levels in project EL: below the weir
   `flood.ref_tail_el` = the terrain's tail surface minus the datum offset (about EL 78.2, status C, b18); above the
   weir the normal pond EL 79.70. Flood stage below = max(0, tail level - `flood.ref_tail_el`); above = max(0, pond
   level - normal pond level) (s01 passes these two RISES; b15 takes rises, not levels). At stage 0 nothing is
   flooded. `flood.extent` returns only ground flooded BEYOND the normal river: cells that are permanent water in the
   land cover (class 80) or lie inside `river_poly.geojson` are used for connection but never returned, never
   counted in the area and never passed to the impact count. So the mean flow floods 0 km2 and 0 buildings, flooding
   below the weir begins at roughly 1,250 m3/s, and the design flood stands about 1.8 m over the reference.
4. **H2, the river keeps its maintenance flow first.** In automatic mode the intake takes
   min(demand, cap, max(0, inflow - `weir.maintenance_flow_m3s`)) (35 m3/s, sourced). Only manual mode can break
   that, and then the alert says the river below is under its maintenance flow.
5. **M8, the canal's cap.** Automatic mode holds the canal to the operating flow `weir.intake_target_m3s` (81 m3/s,
   sourced; the five settling basins pass about 80). Manual mode may go to the design capacity 91.68 and, with an
   alert, to the maximum 101.
6. **M7.** The pond stays at EL 79.70 across the whole range from low flow to gates fully open: no 0.28 m jump
   (b14 drops the flap stage or models the flap lowered).
7. **H3, M10, L16, irrigation as KP-01 writes it.** Net requirement = crop use + percolation + water-layer
   replacement - effective rain, with effective rain = 0.7 x the half-month rain exceeded 80 % of the time / 15
   (computed from the daily basin rain in `rain.json`), three seasons (padi, padi, palawija) with staggered groups,
   and the monthly reference evapotranspiration from `rain.json`, not a constant. Check: the peak comes out within
   15 % of the sourced 1.1 l/s/ha, and September shows a palawija demand, tight against the dependable flow.
8. **M5, low flows.** b13 refits the slow store so the replay's dry-season dependable flows (July to October) come
   within 20 % of the published table while the yearly mean stays within 5 %.
9. **M6, say what a replay year is.** Replay years show seasonal flow, not flood peaks (daily basin-mean rain
   understates storms): one plain sentence in the rain tab (b19). Floods come from the design-flood scenarios.
10. **L12 to L15** are fixed by their owners as the review proposes (design wave base 3 days; the storage curve
    starts at the river bed under the dam; maker-mode levels are labelled "m (model terrain)"; one supply tolerance).
A lane that cannot meet a check writes BLOCKED with the numbers. When the fixes are in, lane x01 re-runs its scripts.

A8 (lead, 23 Nov 2026 11:12 UTC): **Rulings after the first assembled look**.
1. **Water is one colour family, and it is blue.** On a drawn map dark brown water reads as mud or asphalt. Lane b06
   owns `site/js/map/water/palette.js` exporting `WATER = { shallow, body, deep, foam, shore }` as hex strings
   (a clear mid blue, about #7fb2cc shallow, #3f7fa6 body, #1f5a85 deep, white foam, a pale shore line). b06's
   sheets (weir and maker lakes), b08's water inside the weir model (through `mount-weir`), b09's canal and basin
   water, b24's spillway water and b05's river, lake and canal fills all take their colours from it, so the river
   does not change colour where a sheet fades out. Water must look like water at a glance: lighter where shallow,
   a soft sky sheen, slow ripples.
2. **The front door opens on the weir, close.** The opening view shows the weir as the hero: seen from downstream
   (looking south) and a little from the west, the structure about 40 % of the free map width, the settling basins
   and the canal head in view. The free map area is what lies between the status card and the panel: b04 sets the
   map's padding from the real sizes of `#status` and `#panel` (and updates it on resize), b18 sets the `weir`
   preset's zoom, pitch and bearing for that, b10's named views use the same padding.
3. **One name per thing.** b09's leader labels name parts of the structure (flood gates, sluices, intake,
   settling basins, fish ladder, office). b23 names geography (the canal, the gauge, bridges, towns, catchments).
   b05 hides OpenStreetMap's own name for the settling basin. So: b09 drops its canal label; b23 hides its
   canal-head marker above zoom 14.5.
4. **The flood map says what it measures from.** The impact tab states the reference in one sentence ("ground counts
   as flooded above the river level in the terrain model, about EL 78.2 below the weir, a level the river reaches at
   roughly 1,200 m3/s") and offers one control, "bank reference", from -2.0 to +1.0 m in 0.25 m steps (state key
   `flood.ref_shift_m`, written by b22, read by s01, default 0), so an engineer can test how much the answer
   depends on that assumption.
5. **Shortage is counted.** The irrigation tab shows, for the scenario year, the days the canal is short and the
   volume missing (s01 writes `irrigation.short_days` and `irrigation.short_volume_m3` as running totals of the year).
6. **Replay caveat** (A7 point 9) goes into the rain tab now (b19).
7. **Gates move smoothly.** In automatic mode gate openings change by at most the flood step per simulated hour
   between neighbouring flows; no jump from 2.3 m to fully open at the same flow (b14).
8. **Drawings are readable without zoom.** No text in the live section drawing under 10 px at the panel's width;
   an "enlarge" button opens the sheet over the map at up to 1,100 px wide (b20).
9. **Flood tint is visible.** A flood 0.3 m deep must read at a glance on the default base (b07).

A9 (lead, 23 Nov 2026 18:10 UTC): **Water that moves.** The river water looked flat and static; it should respond to
the flow and to the user.
1. **One look for every piece of river water.** `site/js/map/water/surface.js` (`waterKit(THREE)`) holds the ripple
   texture (made in the page, no file), the shared uniforms (frame-clock time, eye, colours, sky, sun, pointer
   rings) and the GLSL that shades a point from its position in scene metres, the current there, its depth and its
   foam. The river sheets (`water/shader.js`) and the water inside the weir (`structures/weir/flow.js`) both use it,
   so two meshes that meet show one surface. Colours stay `WATER` (A8 point 1).
2. **The weir's own water is a 3D surface shaped by the flow.** `structures/weir/hydraulics.js` (pure, tested) turns
   each bay's pond level, tail level, opening and flow into a profile: the pond held by the leaf, the fast sheet under
   it and down the glacis, the hydraulic jump where it meets the tailwater, the pool the end sill holds, the water
   beyond, and the nappe over a leaf's top. It draws what the engine computed and feeds no number on a panel.
   `weir.gate_q[7]` and `weir.sluice_q[3]` (m3/s, from `weir.solve`) are in the store for it (s01's runner writes
   them); a page with no engine estimates them from the openings. Leaves, levels and flows glide to new values in
   about half a second. The old flat pond and tail quads and the foam curtains are gone.
3. **Where the two meet** is `water/join.js`: the river sheets stop exactly 12 m upstream and 60 m downstream of
   the axis (a cut in the shader) and lie flat at the level for their first 160 m; the weir's water runs 5 m past
   those lines, fading out. The masks also take in the pit dug under the weir between the abutments and the
   pond's pocket in front of the intake (b09 opens the surface model there with a lid, `site/layout.js` `P.pocket`;
   no house or tree stands in it).
4. **The river has a current.** `water/flowfield.js` (pure, tested) walks each channel mask from the weir and gives
   the direction of flow at every point; the speed is flow / (width x mean depth) from the store. It steers how
   ripples and foam travel. Each bay's white water carries on into the tail sheet and fades with distance.
5. **The water answers the pointer.** A move or a tap on water starts a ring (`ctx.water.touch(x, z, strength)` in
   scene metres does the same). `ctx.scene3d.camera` is exported for the ray. Water deeper than about half a metre
   is no longer see-through (the ground's contour lines used to show through it).
6. **Films of it.** URL option `act=gates` (by hand: all shut, then gates lift one after another) and `act=touch`
   (rings on the pond), both on the frame clock from `t0`.

A10 (lead, 24 Nov 2026): **Real ground, real river colour, mud you can see.** The ground and water read as flat
fills up close, the sediment in the settling basins was not visible, and smaller rivers such as Sungai Selabung lost
their water when zoomed in. Built by three lanes in parallel (g ground, w water, s sediment) and the lead (rivers,
base map).
1. **Water surfaces take the river's real colour.** `water/palette.js` RIVER (clear, normal, flood looks, bed, bank,
   foam, map) is used by every moving water surface (river sheets, the weir's water, flooded land, settling basins,
   channels) and by the base map's river areas and river lines up close (`RIVER.map`). The look follows the flow
   (`surface.turbidityFor`, from `flow.q_in`). WATER (blue) stays for map symbols: names, canal lines, outlines, and
   for lakes, ponds and reservoirs (Danau Ranau is a clear lake). This replaces A8 point 1 for water surfaces.
2. **Every river keeps its water up close.** River lines carry a drawn width `w` (metres, DISPLAY ESTIMATE
   1.83 x upstream km2 ^ 0.5, tools/geo/river_widths.py) and are drawn at max(symbol width, own width); only the
   pieces of Sungai Komering inside its outline (`poly` = 1) fade out under the outline.
3. **Ground at close zoom** (`map/ground/`, lane g): a raster drape made in workers from the terrain, land cover and
   height above drainage (forest crowns, rice plots, gardens, villages, bare earth, sand and mud banks, wet band,
   riprap by the weir), fading in from zoom 13.6, under roads, contours and names. Terrain tiles at zoom 13 and 14
   are smoothed in a worker pool (carved bed and weir pit kept exactly); `?ground=0` turns both off.
4. **Sediment** (`engine/sediment.js`, lane s): the sourced JICA rating scaled to the sourced 5.02 Mt/yr yield
   (`params sediment.rating_fit_yield`, status A: on the mean year the unscaled rating gives 14.2 Mt/yr; LEAD RULING:
   keep the scaling, show both facts), assumed intake share, trap share, density and an automatic flush at 80 % full,
   one basin at a time; store key `sediment`, event `sediment:flush`. In 3D: muddy inflow clearing toward the
   outlet, sinking particles, a growing delta on each floor, flushing with a gully and a brown plume down Saluran
   Bilas into the river. Panel block "Kantong lumpur" in the Operasi tab with "Bilas sekarang". Film option
   `act=flush`. The flat OpenStreetMap outline of the basins is no longer drawn under the 3D basins.
