// Scenarios: which year of rain and flow the simulator runs. Owner: lane b13. Used by s01 (weir-run, maker-run).
// A plain module (not in MODULES): no DOM, no ctx. Every flow it makes is a MODEL ("debit model"), never measured.
//
// state.scenario = { kind 'climatology'|'replay'|'design', year, rain_scale, label, design_T }
//   climatology  a mean year: the 1991-2020 monthly rain (or the rain tab's monthly_mm) on a real year's daily pattern
//   replay       a real year 1991-2025 of the daily basin rain (ERA5), run from 1991 so the stores carry over
//   design       the mean year plus a flood wave whose peak is the published flood of return period design_T
//                (params hydro.flood_T / flood_q_m3s); design_T null = the weir's design flood (return period not stated)

import { inflowSeries, dependable, daysInYear } from '../engine/rainflow.js';

// FALLBACK values, used only while site/data/params.json lacks the key (posted to lane b18 for params.json).
const FALLBACK = {
  'catchment.area_km2': 4260, // FALLBACK r03 (Martapura)
  'rainflow.bucket_smax_mm': 117, // FALLBACK fitted by b13 (fix round, A7 M5)
  'rainflow.bucket_k_days': 11.6, // FALLBACK fitted by b13 (fast store)
  'rainflow.bucket_k_slow_days': 152, // FALLBACK fitted by b13
  'rainflow.bucket_gw_share': 0.686, // FALLBACK fitted by b13
  'rainflow.bucket_perc_mm_day': 0, // FALLBACK fitted by b13
  'rainflow.bucket_et_factor': 1.207, // FALLBACK fitted by b13
  'rainflow.bucket_fc': 0.92, // FALLBACK fitted by b13
  'rainflow.bucket_slow_exp': 1.057, // FALLBACK fitted by b13
  'rainflow.bucket_g_ref_mm': 100, // FALLBACK assumed reference store of the slow exponent
  'rainflow.template_year': 2003, // FALLBACK the 1991-2020 year closest to the mean annual rain
  'rainflow.spin_years': 3, // FALLBACK
  'rainflow.design_tp_days': 3, // FALLBACK A7 L12: rise time of the flood wave
  'rainflow.design_len_days': 30, // FALLBACK assumed length of the wave
  'rainflow.design_step_days': 0.125, // FALLBACK 3-hour points over the wave
  'rainflow.design_shape': 4, // FALLBACK assumed wave shape
  'hydro.flood_T': [2, 5, 10, 20, 50, 100, 200, 1000], // FALLBACK r03 JICA82
  'hydro.flood_q_m3s': [917, 1190, 1372, 1546, 1771, 1939, 2107, 2497], // FALLBACK r03 JICA82
  'hydro.design_flood_m3s': 2200, // FALLBACK r01
  'hydro.flood_season_months': [2, 3, 4, 5], // FALLBACK r03
};

/** One value from params.json (flat copy first, then the grouped leaf), else the FALLBACK. */
export function pv(params, key) {
  const flat = params?.flat;
  if (flat && flat[key] != null) return flat[key];
  const [g, k] = key.split('.');
  const leaf = params?.[g]?.[k];
  if (leaf != null) return typeof leaf === 'object' && !Array.isArray(leaf) && 'v' in leaf ? leaf.v : leaf;
  return FALLBACK[key] ?? null;
}

/** The engine's bucket and design parameters from params.json. */
export function bucketParams(params) {
  const T = pv(params, 'hydro.flood_T') ?? [];
  const Q = pv(params, 'hydro.flood_q_m3s') ?? [];
  const design_q = {};
  T.forEach((t, i) => { if (Q[i] != null) design_q[t] = Q[i]; });
  const season = pv(params, 'hydro.flood_season_months') ?? [];
  const midMonth = season.length ? season[Math.floor(season.length / 2)] : null;
  let peakDay = null;
  if (midMonth) { const d = new Date(Date.UTC(2001, midMonth - 1, 15)); peakDay = Math.round((d - Date.UTC(2001, 0, 1)) / 864e5); }
  return {
    smax_mm: pv(params, 'rainflow.bucket_smax_mm'),
    k_fast_days: pv(params, 'rainflow.bucket_k_days'),
    k_slow_days: pv(params, 'rainflow.bucket_k_slow_days'),
    gw_share: pv(params, 'rainflow.bucket_gw_share'),
    perc_mm_day: pv(params, 'rainflow.bucket_perc_mm_day'),
    et_factor: pv(params, 'rainflow.bucket_et_factor'),
    fc: pv(params, 'rainflow.bucket_fc'),
    slow_exp: pv(params, 'rainflow.bucket_slow_exp'),
    g_ref_mm: pv(params, 'rainflow.bucket_g_ref_mm'),
    template_year: pv(params, 'rainflow.template_year'),
    spin_years: pv(params, 'rainflow.spin_years'),
    design_q,
    design_tp_days: pv(params, 'rainflow.design_tp_days'),
    design_shape: pv(params, 'rainflow.design_shape'),
    design_len_days: pv(params, 'rainflow.design_len_days'),
    design_step_days: pv(params, 'rainflow.design_step_days'),
    design_peak_day: peakDay,
  };
}

/** Years of the daily rain: {first, last}. */
export function rainYears(rain) {
  const ys = Object.keys(rain?.annual ?? {}).map(Number).filter(Number.isFinite);
  return ys.length ? { first: Math.min(...ys), last: Math.max(...ys) } : null;
}

/** The n driest years by annual basin rain. */
export function dryYears(rain, n = 4) {
  return Object.entries(rain?.annual ?? {}).sort((a, b) => a[1] - b[1]).slice(0, n).map(([y, mm]) => ({ year: +y, mm }));
}

/** The n wettest years by annual basin rain. */
export function wetYears(rain, n = 3) {
  return Object.entries(rain?.annual ?? {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([y, mm]) => ({ year: +y, mm }));
}

/**
 * The scenario list for chips and presets. Each: {id, kind, year, design_T, q_peak, label: {key, en, vars}}.
 * Labels are i18n keys with English fallbacks: the caller passes them through ctx.t.
 */
export function scenarioList(data, params) {
  const rain = data?.rain;
  const out = [{ id: 'mean', kind: 'climatology', year: null, design_T: null, label: { key: 'scen.mean', en: 'Mean year (1991-2020)' } }];
  const yrs = rainYears(rain);
  if (yrs) {
    out.push({ id: 'replay', kind: 'replay', year: yrs.last, design_T: null, years: yrs,
      label: { key: 'scen.replay', en: 'Replay a year ({first}-{last})', vars: yrs } });
    for (const d of dryYears(rain)) {
      out.push({ id: `dry-${d.year}`, kind: 'replay', year: d.year, design_T: null, dry: true, rain_mm: d.mm,
        label: { key: 'scen.dry', en: 'Dry year {year}', vars: { year: d.year } } });
    }
  }
  const bp = bucketParams(params);
  for (const [T, q] of Object.entries(bp.design_q)) {
    out.push({ id: `T${T}`, kind: 'design', year: null, design_T: +T, q_peak: q,
      label: { key: 'scen.design', en: '{T}-year flood', vars: { T: +T } } });
  }
  const qd = pv(params, 'hydro.design_flood_m3s');
  if (qd != null) {
    out.push({ id: 'Tweir', kind: 'design', year: null, design_T: null, q_peak: qd,
      label: { key: 'scen.design_weir', en: 'Weir design flood (return period not stated)' } });
  }
  return out;
}

/**
 * The inflow series of a scenario at the weir (or any catchment area).
 * scenario: state.scenario. data: {rain (rain.json), flow (flow_glofas.json, optional)}. params: params.json.
 * opts: {monthly_mm (rain tab, mean year), runoff_share (rain tab, null = the model's), area_km2 (default the weir's)}
 * -> {kind, year, start, q_m3s, rain_mm, share_model, peak_day, q_peak, q_ref, q80, q_mean, modelled: true}
 */
export function seriesFor(scenario, data, params, opts = {}) {
  const rain = data?.rain;
  if (!rain?.daily_basin_mean) return null;
  const sc = scenario ?? {};
  const kind = sc.kind === 'replay' || sc.kind === 'design' ? sc.kind : 'climatology';
  const bp = bucketParams(params);
  const area = opts.area_km2 ?? pv(params, 'catchment.area_km2');
  let design = null;
  if (kind === 'design') {
    design = sc.design_T != null ? { T: sc.design_T } : { q_peak: pv(params, 'hydro.design_flood_m3s') };
  }
  const yrs = rainYears(rain);
  let year = sc.year ?? null;
  if (kind === 'replay' && year == null && yrs) year = yrs.last;
  const s = inflowSeries({
    kind, year, rain, flow: data?.flow ?? null, area_km2: area, rain_scale: sc.rain_scale ?? 1,
    share: opts.runoff_share ?? null, params: bp, monthly_mm: kind === 'replay' ? null : opts.monthly_mm ?? null, design,
  });
  let sum = 0;
  for (const q of s.q_m3s) sum += q;
  s.q_mean = sum / s.q_m3s.length;
  s.q80 = dependable(s.q_m3s, 80);
  s.days = daysInYear(+s.start.slice(0, 4));
  s.area_km2 = area;
  s.modelled = true;
  return s;
}

/**
 * Flow on a (fractional) day of the series, linear between daily values; days past the end wrap to the start.
 * Inside a design flood wave it reads the wave's sub-daily points (series.wave), so the peak is a curve.
 */
export function flowAt(series, day) {
  const q = series?.q_m3s;
  if (!q || !q.length) return null;
  const n = q.length;
  const d = ((day % n) + n) % n;
  const w = series.wave;
  if (w && w.q_m3s?.length) {
    const x = (d - w.start_day) / w.step_days;
    if (x >= 0 && x <= w.q_m3s.length - 1) {
      const k = Math.floor(x);
      const f = x - k;
      return w.q_m3s[k] * (1 - f) + w.q_m3s[Math.min(k + 1, w.q_m3s.length - 1)] * f;
    }
  }
  const i = Math.floor(d);
  const f = d - i;
  return q[i] * (1 - f) + q[(i + 1) % n] * f;
}
