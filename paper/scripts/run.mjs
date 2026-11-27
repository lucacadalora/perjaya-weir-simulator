#!/usr/bin/env node
// Runs the simulator's engines headless on the repository's own data files and writes every number the paper uses
// to paper/results/results.json (plus two small rasters for the flood map figure).
//   node paper/scripts/run.mjs
// Nothing here is typed by hand: constants come from site/data/params.json, weir.json and presets.json, exactly as
// the browser app reads them. All flows, levels, extents and counts are MODEL results, not measurements.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadPacks } from '../../site/js/engine/node-loader.js';
import * as RF from '../../site/js/engine/rainflow.js';
import * as W from '../../site/js/engine/weir.js';
import * as FL from '../../site/js/engine/flood.js';
import * as IM from '../../site/js/engine/impact.js';
import * as IR from '../../site/js/engine/irrigation.js';
import * as SD from '../../site/js/engine/sediment.js';
import * as RS from '../../site/js/engine/reservoir.js';
import * as GR from '../../site/js/engine/grid.js';
import * as SC from '../../site/js/sim/scenarios.js';
import { paramGroup } from '../../site/js/sim/weir-run.js';

const DATA = new URL('../../site/data/', import.meta.url);
const OUT = new URL('../results/', import.meta.url);
const json = async (p) => JSON.parse(await readFile(new URL(p, DATA), 'utf8'));
const r2 = (x, d = 2) => (Number.isFinite(x) ? +x.toFixed(d) : null);
const DAY_S = 86400;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const timeIt = (fn, n = 5) => { const t = []; let r; for (let i = 0; i < n; i++) { const a = performance.now(); r = fn(); t.push(performance.now() - a); } return { ms: r2(median(t), 1), value: r }; };

await mkdir(OUT, { recursive: true });
const params = await json('params.json');
const weirJson = await json('weir.json');
const rain = await json('climate/rain.json');
const flow = await json('climate/flow_glofas.json');
const presets = await json('presets.json');
const facts = await json('facts.json');
const P = (g) => paramGroup(params, g);
const wp = W.weirParamsFromData(params, weirJson);
const floodParams = P('flood');
const irrParams = P('irrigation');
const hydro = P('hydro');
const area = P('catchment').area_km2;
const R = { meta: { made: new Date().toISOString().slice(0, 10), node: process.version, params_built: params.meta?.built ?? null } };

// ------------------------------------------------------------------------------------------------ A. rain to flow
{
  const bp = SC.bucketParams(params);
  const d = RF.dailyRain(rain);
  const yFirst = d.y0;
  const yLast = d.y0 + Math.floor(d.values.length / 365.25) - 1; // last whole year in the file
  const rep = RF.replayRange(rain, { area_km2: area, params: bp, from_year: yFirst, to_year: yLast });
  const monthly = []; // [year][12] mean flow
  const annualMean = [], annualMax = [], annualMin = [];
  let j0 = 0;
  for (let y = yFirst; y <= yLast; y++) {
    const n = RF.daysInYear(y);
    const q = rep.q_m3s.subarray(j0, j0 + n);
    const mo = RF.monthOfDay(y);
    const s = new Array(12).fill(0), c = new Array(12).fill(0);
    let mx = -Infinity, mn = Infinity, tot = 0;
    for (let j = 0; j < n; j++) { s[mo[j]] += q[j]; c[mo[j]]++; tot += q[j]; if (q[j] > mx) mx = q[j]; if (q[j] < mn) mn = q[j]; }
    monthly.push(s.map((v, m) => v / c[m]));
    annualMean.push(tot / n); annualMax.push(mx); annualMin.push(mn);
    j0 += n;
  }
  const years = Array.from({ length: yLast - yFirst + 1 }, (_, i) => yFirst + i);
  const monMean = MONTHS.map((_, m) => mean(monthly.map((r) => r[m])));
  const monQ80 = MONTHS.map((_, m) => RF.dependable(monthly.map((r) => r[m]), 80));
  const pubMean = hydro.monthly_mean_m3s, pubQ80 = hydro.monthly_q80_m3s;
  const relErr = (a, b) => a.map((v, i) => (v - b[i]) / b[i]);
  const rmsRel = (a, b) => Math.sqrt(mean(relErr(a, b).map((e) => e * e)));
  const clim = SC.seriesFor({ kind: 'climatology' }, { rain, flow }, params);
  const climMon = RF.monthlyTotals(clim.q_m3s, +clim.start.slice(0, 4)).map((v, m) => v / RF.monthDays(+clim.start.slice(0, 4))[m]);
  const g = RF.gumbel(annualMax);
  // GloFAS (a second, independent model of the same river) over the common whole years
  const f0 = +flow.daily.start.slice(0, 4);
  const fv = flow.daily.values;
  const gMon = [], mMon = [];
  for (let y = Math.max(f0, yFirst); y <= yLast; y++) {
    const off = RF.yearOffset(f0, y), n = RF.daysInYear(y);
    if (off + n > fv.length) break;
    const mo = RF.monthOfDay(y);
    const s = new Array(12).fill(0), c = new Array(12).fill(0);
    for (let j = 0; j < n; j++) if (fv[off + j] != null) { s[mo[j]] += fv[off + j]; c[mo[j]]++; }
    for (let m = 0; m < 12; m++) { gMon.push(s[m] / c[m]); mMon.push(monthly[y - yFirst][m]); }
  }
  const corr = (a, b) => { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db); };
  const annualRain = years.map((y) => rain.annual[String(y)]);
  const dry = SC.dryYears(rain, 4).map((x) => ({ year: x.year, rain_mm: r2(x.mm, 0), q_mean: r2(annualMean[x.year - yFirst], 1), q_min_day: r2(annualMin[x.year - yFirst], 1) }));
  R.rainflow = {
    area_km2: area, years: [yFirst, yLast], n_years: years.length, bucket: bp,
    rain_annual_mean_mm: r2(mean(annualRain), 0), rain_monthly_mm: rain.monthly_mean_1991_2020, et0_monthly_mm: rain.evap_monthly_mm,
    replay: {
      q_mean: r2(mean(annualMean), 1), q_mean_published: hydro.mean_flow_m3s,
      monthly_mean: monMean.map((v) => r2(v, 1)), monthly_mean_published: pubMean,
      monthly_q80: monQ80.map((v) => r2(v, 1)), monthly_q80_published: pubQ80,
      rel_err_mean: relErr(monMean, pubMean).map((v) => r2(v, 3)), rel_err_q80: relErr(monQ80, pubQ80).map((v) => r2(v, 3)),
      rms_rel_mean: r2(rmsRel(monMean, pubMean), 3), rms_rel_q80: r2(rmsRel(monQ80, pubQ80), 3),
      max_abs_rel_mean: r2(Math.max(...relErr(monMean, pubMean).map(Math.abs)), 3),
      dry_season_q80_rel: [6, 7, 8, 9].map((m) => r2((monQ80[m] - pubQ80[m]) / pubQ80[m], 3)),
      annual_max_range: [r2(Math.min(...annualMax), 0), r2(Math.max(...annualMax), 0)],
      gumbel_q100: r2(g.q(100), 0), published_q2: hydro.flood_q_m3s[0], published_q100: hydro.flood_q_m3s[5], published_largest: hydro.flood_largest_m3s,
      runoff_share: r2(mean(annualMean) * 365.25 * DAY_S / (area * 1e6) / (mean(annualRain) / 1000), 3),
    },
    climatology: { q_mean: r2(clim.q_mean, 1), q80_daily: r2(clim.q80, 1), share_model: r2(clim.share_model, 3), monthly_mean: climMon.map((v) => r2(v, 1)) },
    glofas: { years: [Math.max(f0, yFirst), yLast], monthly_mean: flow.monthly_mean.map((v) => r2(v, 1)), corr_monthly: r2(corr(gMon, mMon), 3), n_months: gMon.length, mean: r2(mean(gMon), 1) },
    dry_years: dry,
    design: { T: hydro.flood_T, q: hydro.flood_q_m3s, weir_design_q: hydro.design_flood_m3s, tp_days: bp.design_tp_days, shape: bp.design_shape },
    daily_sample: { year: 2019, q: Array.from(rep.q_m3s.subarray(RF.yearOffset(yFirst, 2019), RF.yearOffset(yFirst, 2020)), (v) => r2(v, 1)) },
  };
}

// ------------------------------------------------------------------------------------------------ B. the weir
const solveAuto = (q_in, demand = wp.intake.target_m3s) => W.solve({ q_in, controls: { mode: 'auto', demand_m3s: demand }, weirParams: wp });
{
  const row = (q, s) => ({
    q_in: q, pond_el: r2(s.pond_el, 2), tail_el: r2(s.tail_el, 2), stage: s.stage, q_intake: r2(s.q_intake, 1), q_down: r2(s.q_down, 1),
    q_gates: r2(s.q_gates, 1), q_sluices: r2(s.q_sluices, 1), q_spill: r2(s.q_spill, 1),
    gates: s.gates.map((a) => r2(a, 2)), sluices: s.sluices.map((a) => r2(a, 2)), alerts: s.alerts,
    balance_err: r2(Math.abs(q - s.q_intake - s.q_down) / q, 6),
  });
  const table = [20, 50, 100, 203.1, 400, 800, 1200, 1400, 1939, 2200, 2497, 3000].map((q) => row(q, solveAuto(q)));
  const sweep = { q: [], pond: [], tail: [], gate_mean: [], sluice_mean: [], intake: [], stage: [] };
  let maxErr = 0, holdTo = null, over = null, maxJump = 0, prev = null, tailAbove = 0;
  for (let q = 5; q <= 3000; q += 5) {
    const s = solveAuto(q);
    sweep.q.push(q); sweep.pond.push(r2(s.pond_el, 3)); sweep.tail.push(r2(s.tail_el, 3));
    sweep.gate_mean.push(r2(mean(s.gates), 3)); sweep.sluice_mean.push(r2(mean(s.sluices), 3)); sweep.intake.push(r2(s.q_intake, 2)); sweep.stage.push(s.stage);
    maxErr = Math.max(maxErr, Math.abs(q - s.q_intake - s.q_down) / q);
    if (Math.abs(s.pond_el - wp.levels.pond_target_el) < 0.005) holdTo = q;
    if (over == null && s.pond_el > wp.levels.design_high_water_el) over = q;
    if (prev != null) maxJump = Math.max(maxJump, Math.abs(s.pond_el - prev));
    if (s.tail_el > s.pond_el + 1e-6) tailAbove++;
    prev = s.pond_el;
  }
  const floodMode = (q) => { const s = W.solve({ q_in: q, controls: { mode: 'flood', demand_m3s: 0, intake_open: 0 }, weirParams: wp }); return { q_in: q, pond_el: r2(s.pond_el, 2), tail_el: r2(s.tail_el, 2) }; };
  // the design flood as a wave, in 3-hour steps
  const wave = (sc) => {
    const s = SC.seriesFor(sc, { rain, flow }, params);
    const out = { t: [], q: [], pond: [], tail: [] };
    let peak = { pond: -Infinity };
    for (let day = s.wave.start_day; day <= s.wave.start_day + 14; day += 0.125) {
      const q = SC.flowAt(s, day);
      const r = solveAuto(q, 60);
      out.t.push(r2(day - s.wave.start_day, 3)); out.q.push(r2(q, 0)); out.pond.push(r2(r.pond_el, 3)); out.tail.push(r2(r.tail_el, 3));
      if (r.pond_el > peak.pond) peak = { pond: r.pond_el, tail: r.tail_el, q, day: day - s.wave.start_day };
    }
    let vol = 0; // wave volume above the seasonal flow, by the daily series
    const base = SC.seriesFor({ kind: 'climatology' }, { rain, flow }, params);
    for (let k = 0; k < s.q_m3s.length; k++) vol += Math.max(0, s.q_m3s[k] - base.q_m3s[k]) * DAY_S;
    return { series: out, q_peak: r2(s.q_peak, 0), pond_peak: r2(peak.pond, 2), tail_peak: r2(peak.tail, 2), wave_volume_mm3: r2(vol / 1e6, 0), wave_depth_mm: r2(vol / (area * 1e6) * 1000, 0) };
  };
  const tSolve = timeIt(() => solveAuto(800), 21);
  R.weir = {
    levels: wp.levels, intake: wp.intake, ops: wp.ops, tail: wp.tail, n_gates: wp.gates.length, n_sluices: wp.sluices.length,
    gate_width_m: wp.gates[0].width_m, sluice_width_m: wp.sluices[0].width_m,
    table, sweep, max_balance_err: maxErr, pond_held_to_q: holdTo, pond_over_dhw_from_q: over, max_pond_jump_m: r2(maxJump, 3), tail_above_pond: tailAbove,
    flood_mode: [1939, 2200].map(floodMode),
    design_wave: wave({ kind: 'design', design_T: null }), q100_wave: wave({ kind: 'design', design_T: 100 }),
    tail_at_design: r2(W.tailwater(2200, wp), 2), tail_at_mean: r2(W.tailwater(hydro.mean_flow_m3s, wp), 2),
    solve_ms: tSolve.ms,
  };
}

// ------------------------------------------------------------------------------------------------ C. flood and what it reaches
const tGrid0 = performance.now();
const G = await loadPacks(['wide', 'fine']);
R.grid = {
  load_ms: Math.round(performance.now() - tGrid0),
  wide: { cols: G.wide.cols, rows: G.wide.rows, cell_arcsec: Math.round(G.wide.cell * 3600), cell_m: Math.round(G.wide.cell * 111320) },
  fine: { cols: G.fine.cols, rows: G.fine.rows, cell_arcsec: Math.round(G.fine.cell * 3600), cell_m: Math.round(G.fine.cell * 111320) },
};
{
  const river = FL.prepare(G, { grid: 'fine', river_poly: await json('feat/river_poly.geojson') });
  const buf = await readFile(new URL('feat/buildings.bin', DATA));
  const bin = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  IM.prepare(G, { buildings: { bin, meta: await json('feat/buildings.json') }, roads: await json('feat/roads.geojson'), roads_fine: await json('feat/roads_fine.geojson'), rail: await json('feat/rail.geojson'), places: await json('feat/places.geojson') });
  const refTail = floodParams.ref_tail_el, refPond = P('weir').pond_normal_el;
  const lcNames = (await json('grid/lc.json')).classes;
  const at = (q, shift = 0, keep = false) => {
    const s = solveAuto(q);
    const stage = Math.max(0, s.tail_el - (refTail + shift));
    const up = Math.max(0, s.pond_el - refPond);
    const e = FL.extent(G, { grid: 'fine', stage_m: stage, stage_up_m: up, floodParams });
    const c = IM.count(G, { grid: 'fine', mask: e.mask, depth_dm: e.depth_dm, min_depth_m: floodParams.min_depth_m ?? null, max_points: 20000 });
    const l = IM.lines(G, { grid: 'fine', mask: e.mask });
    const pl = IM.places(G, { grid: 'fine', mask: e.mask, buffer_cells: 2 });
    const lc = {};
    for (const [k, v] of Object.entries(c.lc_ha || {})) lc[lcNames[k] ?? k] = r2(v, 0);
    const out = { q_in: q, shift_m: shift, pond_el: r2(s.pond_el, 2), tail_el: r2(s.tail_el, 2), rise_below_m: r2(stage, 2), rise_above_m: r2(up, 2),
      area_km2: r2(e.area_km2, 2), area_up_km2: r2(e.area_up_km2, 2), area_down_km2: r2(e.area_down_km2, 2), volume_mm3: r2(e.volume_m3 / 1e6, 2), depth_max_m: r2(e.depth_max_m, 1),
      buildings: c.buildings, footprint_m2: Math.round(c.footprint_m2), roads_km: r2(l.roads_km, 2), rail_km: r2(l.rail_km, 2), lc_ha: lc,
      places_inside: pl.filter((p) => p.inside).length, places_near: pl.length };
    return keep ? { out, e } : out;
  };
  const flows = [203.1, 800, 1250, 1400, 1546, 1771, 1939, 2107, 2200, 2497];
  const table = flows.map((q) => at(q));
  const sens = [-1, -0.5, 0, 0.5].map((sh) => at(2200, sh));
  // the flow at which the tail reaches the reference (ground starts to count as flooded below the weir)
  let lo = 0, hi = 5000;
  for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (W.tailwater(mid, wp) < refTail) lo = mid; else hi = mid; }
  // first flow (10 m3/s steps) with any flooded ground
  let firstWet = null;
  for (let q = 1000; q <= 2500 && firstWet == null; q += 10) if (at(q).area_km2 > 0) firstWet = q;
  const tExt = timeIt(() => FL.extent(G, { grid: 'fine', stage_m: 1.67, stage_up_m: 0.9, floodParams }), 7);
  // rasters for the map figure: the design-flood depth and the ground, cropped to the wet box plus a margin
  const { e } = at(2200, 0, true);
  const g = G.fine, m = 60;
  const c0 = Math.max(0, e.bbox[0] - m), r0 = Math.max(0, e.bbox[1] - m), c1 = Math.min(g.cols - 1, e.bbox[2] + m), r1 = Math.min(g.rows - 1, e.bbox[3] + m);
  const w = c1 - c0 + 1, h = r1 - r0 + 1;
  const dep = new Int16Array(w * h), dem = new Int16Array(w * h), lcc = new Uint8Array(w * h), riv = new Uint8Array(w * h);
  const rivMask = FL.rasterisePolygons(g, await json('feat/river_poly.geojson'));
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const i = (r + r0) * g.cols + c + c0;
    dep[r * w + c] = e.mask[i] ? Math.max(1, e.depth_dm[i]) : 0; dem[r * w + c] = g.dem[i]; lcc[r * w + c] = g.lc ? g.lc[i] : 0; riv[r * w + c] = rivMask[i];
  }
  await writeFile(new URL('flood_depth_dm.i16', OUT), Buffer.from(dep.buffer));
  await writeFile(new URL('flood_dem_dm.i16', OUT), Buffer.from(dem.buffer));
  await writeFile(new URL('flood_lc.u8', OUT), Buffer.from(lcc.buffer));
  await writeFile(new URL('flood_river.u8', OUT), Buffer.from(riv.buffer));
  R.flood = {
    ref_tail_el: refTail, ref_pond_el: refPond, min_depth_m: floodParams.min_depth_m, river_cells: river.river_cells, ref_flow_m3s: r2((lo + hi) / 2, 0), first_wet_q: firstWet,
    table, sensitivity: sens, extent_ms: tExt.ms,
    raster: { cols: w, rows: h, west: g.west + c0 * g.cell, north: g.north - r0 * g.cell, cell_deg: g.cell, weir: [params.flat['flood.weir_lon'], params.flat['flood.weir_lat']] },
  };
}

// ------------------------------------------------------------------------------------------------ D. irrigation
const ri = IR.rainInputs(rain, P('rainflow').et0_monthly_mm);
const pattern = {};
for (const k of ['start_hm', 'groups', 'efficiency']) if (Number.isFinite(irrParams[k])) pattern[k] = irrParams[k];
if (!(Array.isArray(irrParams.r80_halfmonth_mm) && irrParams.r80_halfmonth_mm.length === 24) && Array.isArray(ri.r5_mm)) pattern.r5_mm = ri.r5_mm;
if (Array.isArray(ri.eto_mm_day)) pattern.eto_mm_day = ri.eto_mm_day;
const areaHa = irrParams.area_default_ha;
const dateOf = (start, i) => { const d = new Date(Date.parse(start + 'T00:00:00Z') + i * 864e5); return { month: d.getUTCMonth() + 1, day: d.getUTCDate() }; };
// one scenario year through the chain: flow -> canal demand -> automatic gates -> what the canal gets
function yearChain(sc) {
  const s = SC.seriesFor(sc, { rain, flow }, params);
  const n = s.q_m3s.length;
  const out = { q: [], demand: [], supplied: [], q_down: [], pond: [] };
  let shortDays = 0, shortVol = 0, ok = 0, belowEnv = 0, minQ = Infinity, minDown = Infinity, demVol = 0, supVol = 0;
  for (let i = 0; i < n; i++) {
    const q = s.q_m3s[i];
    const { month, day } = dateOf(s.start, i);
    const dem = IR.demand({ area_ha: areaHa, month, day, pattern, params: irrParams });
    const r = W.solve({ q_in: q, controls: { mode: 'auto', demand_m3s: dem }, weirParams: wp });
    const b = IR.balance({ q_river: [r.q_intake], demand: [dem], intake_capacity_m3s: null, env_flow_m3s: 0 });
    if (b.reliability < 1) { shortDays++; shortVol += Math.max(0, dem - r.q_intake) * DAY_S; } else ok++;
    if (q > wp.ops.q_env_m3s && r.q_down < wp.ops.q_env_m3s - 1e-3) belowEnv++;
    minQ = Math.min(minQ, q); minDown = Math.min(minDown, r.q_down);
    demVol += dem * DAY_S; supVol += r.q_intake * DAY_S;
    out.q.push(r2(q, 1)); out.demand.push(r2(dem, 2)); out.supplied.push(r2(r.q_intake, 2)); out.q_down.push(r2(r.q_down, 1)); out.pond.push(r2(r.pond_el, 3));
  }
  return { series: out, start: s.start, year: s.year, days: n, q_mean: r2(s.q_mean, 1), q_min: r2(minQ, 1), q_down_min: r2(minDown, 1), short_days: shortDays,
    short_volume_mm3: r2(shortVol / 1e6, 1), reliability: r2(ok / n, 3), days_below_env_with_water: belowEnv,
    demand_mm3: r2(demVol / 1e6, 0), supplied_mm3: r2(supVol / 1e6, 0) };
}
{
  const t = IR.demandTable(irrParams, pattern);
  const dr = t.dr_lsha;
  const kPeak = dr.indexOf(Math.max(...dr));
  const hmName = (h) => `${MONTHS[Math.floor(h / 2)]} ${h % 2 ? 'II' : 'I'}`;
  const scen = { mean: { kind: 'climatology' } };
  for (const y of SC.dryYears(rain, 4).map((x) => x.year).sort()) scen['dry' + y] = { kind: 'replay', year: y };
  const years = {};
  for (const [k, sc] of Object.entries(scen)) years[k] = yearChain(sc);
  R.irrigation = {
    area_ha: areaHa, efficiency: irrParams.efficiency, groups: irrParams.groups, start_hm: irrParams.start_hm,
    dr_lsha: dr.map((v) => r2(v, 3)), nfr_mm_day: t.nfr.map((v) => r2(v, 2)), demand_m3s: dr.map((v) => r2((v * areaHa) / 1000, 1)),
    r80_halfmonth_mm: t.settings.r5, eto_mm_day: t.settings.eto, phases: t.phases,
    peak_dr_lsha: r2(dr[kPeak], 3), peak_halfmonth: hmName(kPeak), peak_demand_m3s: r2((dr[kPeak] * areaHa) / 1000, 1),
    peak_dr_published: irrParams.unit_demand_peak_lsha, peak_demand_published: irrParams.peak_demand_default_m3s,
    canal_cap_m3s: wp.intake.target_m3s, env_flow_m3s: wp.ops.q_env_m3s, years,
  };
}

// ------------------------------------------------------------------------------------------------ E. sediment
{
  const SP = SD.sedimentParams(params, weirJson);
  const aUsed = SD.ratingA(SP);
  let unscaled = 0; // tonnes a year on the published mean monthly flows with the published rating as it stands
  const MD = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (let m = 0; m < 12; m++) unscaled += MD[m] * SP.rating_a * Math.pow(hydro.monthly_mean_m3s[m], SP.rating_b);
  const yr = R.irrigation.years.mean.series;
  let st = SD.initState(SP);
  const perYear = [];
  const fill = [];
  for (let y = 0; y < 3; y++) {
    let trapped = 0, returned = 0, river = 0, intake = 0;
    const f0 = st.basins.map((b) => b.flushes);
    for (let i = 0; i < yr.q.length; i++) {
      // 3-hour steps so a 4-hour flush is resolved
      for (let k = 0; k < 8; k++) {
        const r = SD.step(st, { q_river: yr.q[i], q_intake: yr.supplied[i], dt_s: DAY_S / 8, auto: true }, SP);
        st = r.state; trapped += r.out.trapped_t; returned += r.out.returned_t;
        river += r.out.river_t_day / 8; intake += r.out.intake_t_day / 8;
        if (y === 2 && k === 7) fill.push(r.out.basins.map((b) => r2(b.fill, 3)));
      }
    }
    perYear.push({ trapped_t: Math.round(trapped), returned_t: Math.round(returned), river_t: Math.round(river), intake_t: Math.round(intake),
      flushes: st.basins.map((b, i) => b.flushes - f0[i]) });
  }
  const last = perYear[2];
  const nFl = last.flushes.reduce((s, x) => s + x, 0);
  R.sediment = {
    rating_a: SP.rating_a, rating_b: SP.rating_b, rating_a_used: r2(aUsed, 5), scale: r2(aUsed / SP.rating_a, 3),
    yield_t_yr: SP.yield_t_yr, unscaled_t_yr: Math.round(unscaled), basins: SP.count, storage_m3: SD.storageM3(SP), q_design_m3s: SP.q_design_m3s,
    intake_factor: SP.intake_factor, flush_at: SP.flush_at, flush_hours: SP.flush_hours, flush_q_m3s: SP.flush_q_m3s,
    c_at_mean_mgL: r2(SD.riverLoad(hydro.mean_flow_m3s, SP).c_mgL, 0), c_at_2200_mgL: r2(SD.riverLoad(2200, SP).c_mgL, 0),
    trap_share_design: r2(SD.trapShare(SP.q_design_m3s, 0, SP), 3),
    years: perYear, flushes_per_year: nFl, days_between_flushes_per_basin: nFl ? r2(365 * SP.count / nFl, 0) : null,
    trapped_share_of_intake: r2(last.trapped_t / last.intake_t, 3), intake_share_of_river: r2(last.intake_t / last.river_t, 4),
    fill_year3: fill.filter((_, i) => i % 2 === 0),
  };
}

// ------------------------------------------------------------------------------------------------ F. maker mode: a dam anywhere
{
  const items = Array.isArray(presets) ? presets : presets.presets ?? Object.values(presets);
  const maker = P('maker'), evap = P('evap');
  const run = (id, crestOverride) => {
    const p = items.find((x) => x.id === id);
    const snap = GR.snapToStream(G, { grid: 'wide', lon: p.lon, lat: p.lat, min_km2: 10, radius_cells: 8 });
    const tC = timeIt(() => GR.catchment(G, { grid: 'wide', idx: snap.idx }), 3);
    const cm = tC.value;
    const ground = G.wide.dem[snap.idx] / 10;
    const crest = crestOverride ?? p.dam.crest_el ?? ground + p.dam.height_m;
    const line = RS.damLine(G, { grid: 'wide', idx: snap.idx, crest_el: crest });
    if (!line.ok) return { id, ok: false, reason: line.reason, catchment_km2: r2(cm.area_km2, 1) };
    const tS = timeIt(() => RS.storageCurve(G, { grid: 'wide', idx: snap.idx, crest_el: crest, line, steps: 60 }), 3);
    const curve = tS.value;
    const n = curve.level_el.length - 1;
    // fill from empty on the mean year, flow scaled to the dam's own catchment (the app's seriesFor with area_km2)
    const s = SC.seriesFor({ kind: 'climatology' }, { rain, flow }, params, { area_km2: cm.area_km2 });
    let v = 0, days = null, spillMax = 0;
    const fill = [];
    for (let d = 0; d < 365 * 6 && days == null; d++) {
      const r = RS.routeStep({ curve, volume_m3: v, crest_el: curve.level_el[n], spill_width_m: maker.spill_width_default_m, spill_cd: maker.spill_cd, release_m3s: 0,
        evap_mm_day: evap.open_water_mm_day, pan_coef: 1 }, s.q_m3s[d % s.q_m3s.length], DAY_S);
      v = r.volume_m3; spillMax = Math.max(spillMax, r.spill_m3s);
      if (d % 5 === 0) fill.push(r2(v / curve.volume_m3[n], 4));
      if (r.spill_m3s > 0.01 && days == null) days = d + 1;
    }
    return { id, ok: true, name: p.name.en, lon: p.lon, lat: p.lat, catchment_km2: r2(cm.area_km2, 1), catchment_published_km2: p.dam.catchment_km2 ?? null,
      crest_el: crest, base_el: r2(line.base_el, 1), height_m: r2(line.height_m, 1), height_published_m: p.dam.height_m ?? null,
      crest_len_m: Math.round(line.length_m), crest_len_published_m: p.dam.crest_len_m ?? null,
      fsl_area_km2: r2(curve.area_km2[n], 2), fsl_volume_mm3: r2(curve.volume_m3[n] / 1e6, 1), storage_published_mm3: p.dam.storage_mm3 ?? null,
      leak: curve.leak, rim_el: curve.rim_el, inflow_mean_m3s: r2(s.q_mean, 1), days_to_fill: days,
      curve: { level: curve.level_el.map((x) => r2(x, 1)), area: curve.area_km2.map((x) => r2(x, 3)), volume_mm3: curve.volume_m3.map((x) => r2(x / 1e6, 2)) },
      fill, catchment_ms: tC.ms, curve_ms: tS.ms };
  };
  const weirSnap = GR.snapToStream(G, { grid: 'wide', lon: params.flat['flood.weir_lon'], lat: params.flat['flood.weir_lat'], min_km2: 1000, radius_cells: 8 });
  const weirCm = GR.catchment(G, { grid: 'wide', idx: weirSnap.idx });
  R.maker = { weir_catchment_km2: r2(weirCm.area_km2, 1), weir_catchment_published_km2: area, dams: [run('tiga-dihaji'), run('try-selabung')], spill_cd: maker.spill_cd, evap_mm_day: evap.open_water_mm_day };
}

// ------------------------------------------------------------------------------------------------ G. data sheet counts
{
  const count = (obj, acc = {}) => { for (const v of Object.values(obj)) { if (v && typeof v === 'object' && !Array.isArray(v)) { if ('v' in v && 'status' in v) acc[v.status] = (acc[v.status] || 0) + 1; else count(v, acc); } } return acc; };
  const pc = {}; for (const g of Object.keys(params)) if (g !== 'flat' && g !== 'meta') count({ [g]: params[g] }, pc);
  const fc = {}; for (const f of Object.values(facts.facts)) fc[f.status] = (fc[f.status] || 0) + 1;
  R.data = { params_by_status: pc, params_total: Object.values(pc).reduce((s, x) => s + x, 0), facts_by_status: fc, facts_total: Object.keys(facts.facts).length,
    sources: Object.keys(facts.sources).length, weir_leaves_by_status: count(weirJson), datum_offset_m: P('datum').offset_m };
}

await writeFile(new URL('results.json', OUT), JSON.stringify(R, null, 1) + '\n');
console.log('wrote paper/results/results.json');
for (const k of Object.keys(R)) console.log(' ', k, JSON.stringify(R[k]).length, 'bytes');
