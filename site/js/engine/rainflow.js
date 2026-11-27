// Rain to flow (engine E1). Owner: lane b13. Pure functions: no DOM, no window, no imports outside engine/.
// Every constant comes in through the arguments (params from site/data/params.json, resolved by sim/scenarios.js).
// Methods: runoff coefficient, rational peak, F.J. Mock (monthly), NRECA (monthly), a daily soil bucket with a fast
// and a slow linear store, the series maker, dependable flow and Gumbel. All flows are a MODEL, never a measurement.

const DAY_S = 86400;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInYear = (y) => (isLeap(y) ? 366 : 365);
export const monthDays = (y) => MONTH_DAYS.map((d, i) => (i === 1 && y != null && isLeap(y) ? 29 : d));

/** Depth of water (mm) over an area (km2) in a time (s) -> m3/s. */
export function mmToM3s(mm, area_km2, seconds) {
  return (mm * 1e-3 * area_km2 * 1e6) / seconds;
}
export function m3sToMm(q, area_km2, seconds) {
  return (q * seconds) / (area_km2 * 1e3);
}

/** Method 3: Q = C x P x A / t. */
export function runoffCoeff({ rain_mm, area_km2, share, seconds }) {
  return mmToM3s(share * rain_mm, area_km2, seconds);
}

/** Rational check for small side catchments: Qp = 0.278 C I A (I mm/h, A km2). */
export function rational({ c, i_mm_h, area_km2 }) {
  return 0.278 * c * i_mm_h * area_km2;
}

// ---------------------------------------------------------------- F.J. Mock (monthly)

/**
 * One month of F.J. Mock. state {sm, v} (soil moisture mm, groundwater store mm).
 * input {p_mm, pet_mm, rain_days}; params {m, smc, i, k, pf}.
 */
export function mockStep(state, { p_mm, pet_mm, rain_days }, params) {
  const { m, smc, i, k } = params;
  const pf = params.pf ?? 0;
  const n = Math.min(rain_days ?? 18, 18); // dE is never negative
  const dE = pet_mm * (m / 20) * (18 - n);
  const et = pet_mm - dE;
  const ds = p_mm - et;
  let sm = state.sm + ds;
  let ws = 0;
  if (sm > smc) { ws = sm - smc; sm = smc; }
  if (sm < 0) sm = 0;
  const inf = i * ws;
  const v = k * state.v + 0.5 * (1 + k) * inf;
  const base = inf - (v - state.v);
  const direct = ws - inf;
  const storm = ds < 0 ? pf * p_mm : 0;
  return { runoff: base + direct + storm, base, direct: direct + storm, et, ws, inf, state: { sm, v } };
}

/**
 * Twelve months of Mock. Without sm0/v0 the cycle is repeated until it settles (spin up), then reported.
 * -> {q_m3s[12], base[12], direct[12], runoff_mm[12], state}
 */
export function mockMonthly({ rain_mm, pet_mm, area_km2, params, rain_days = null, year = null, sm0 = null, v0 = null, spin = 6 }) {
  const days = monthDays(year);
  let st = { sm: sm0 ?? params.smc, v: v0 ?? 0 };
  const run = (record) => {
    const out = { q_m3s: [], base: [], direct: [], runoff_mm: [] };
    for (let mo = 0; mo < 12; mo++) {
      const r = mockStep(st, { p_mm: rain_mm[mo], pet_mm: pet_mm[mo], rain_days: rain_days ? rain_days[mo] : params.rain_days }, params);
      st = r.state;
      if (record) {
        const sec = days[mo] * DAY_S;
        out.q_m3s.push(mmToM3s(r.runoff, area_km2, sec));
        out.base.push(mmToM3s(r.base, area_km2, sec));
        out.direct.push(mmToM3s(r.direct, area_km2, sec));
        out.runoff_mm.push(r.runoff);
      }
    }
    return out;
  };
  if (sm0 == null || v0 == null) for (let s = 0; s < spin; s++) run(false);
  const out = run(true);
  out.state = st;
  return out;
}

// ---------------------------------------------------------------- NRECA (monthly, the alternative)

/** One month of NRECA. state {w, gw} mm; input {p_mm, pet_mm}; params {ra_mm_yr, psub, gwf}. */
export function nrecaStep(state, { p_mm, pet_mm }, params) {
  const nominal = 100 + 0.2 * params.ra_mm_yr;
  const wi = state.w / nominal;
  const pr = p_mm / pet_mm;
  const aetRatio = pr < 1 && wi < 2 ? Math.min(1, pr * (1 - 0.5 * wi) + 0.5 * wi) : 1;
  const aet = aetRatio * pet_mm;
  const excess = p_mm - aet;
  const emRatio = excess > 0 ? 0.5 * (1 + Math.tanh((wi - 1) / 0.52)) : 0;
  const em = excess * emRatio;
  const recharge = params.psub * em;
  const direct = em - recharge;
  const gwflow = params.gwf * (state.gw + recharge);
  const w = Math.max(0, state.w + excess - em);
  const gw = state.gw + recharge - gwflow;
  return { runoff: direct + gwflow, direct, gwflow, aet, em, state: { w, gw } };
}

// ---------------------------------------------------------------- daily bucket

/**
 * One step of the daily bucket. state {s, f, g}: soil store, fast store, slow store (mm).
 * Rain fills the soil store; what overflows smax_mm goes to the fast store (share 1 - gw_share) and the slow store
 * (gw_share); the soil also drains perc_mm_day x (s / smax) to the slow store; evaporation takes
 * et_factor x pet x min(1, s / (fc x smax)). Each store empties as a linear reservoir: out = store x (1 - e^(-dt/K)).
 * params {smax_mm, k_fast_days, k_slow_days, gw_share, perc_mm_day, et_factor, fc, slow_exp, g_ref_mm}
 * -> {q_mm, q_fast, q_slow, et, state}
 */
export function bucketStep(state, { rain_mm, pet_mm = 0, dt_days = 1 }, params) {
  const smax = params.smax_mm;
  const gwShare = params.gw_share ?? 0;
  const fc = params.fc ?? 0.5;
  let s = (state?.s ?? 0) + Math.max(0, rain_mm);
  let f = state?.f ?? 0;
  let g = state?.g ?? 0;
  const over = s > smax ? s - smax : 0;
  s -= over;
  const perc = Math.min(s, (params.perc_mm_day ?? 0) * dt_days * (s / smax));
  s -= perc;
  const et = Math.min(s, (params.et_factor ?? 1) * pet_mm * Math.min(1, s / (fc * smax)));
  s -= et;
  f += (1 - gwShare) * over;
  g += gwShare * over + perc;
  const qf = f * (1 - Math.exp(-dt_days / params.k_fast_days));
  const ks = params.k_slow_days ?? 0;
  // slow_exp > 1 makes the slow store non-linear: it drains faster when full and holds back when low (g_ref_mm)
  const b = params.slow_exp ?? 1;
  const kr = b === 1 ? 1 : Math.pow(Math.max(g, 0) / (params.g_ref_mm ?? 100), b - 1);
  const qs = ks > 0 ? Math.min(g, g * (1 - Math.exp(-dt_days / ks)) * kr) : 0;
  f -= qf;
  g -= qs;
  return { q_mm: qf + qs, q_fast: qf, q_slow: qs, et, state: { s, f, g } };
}

/**
 * Run the bucket over a daily rain array. pet: number per day, an array per day, or a function (index) -> mm.
 * -> {q_mm: Float32Array, slow_mm: Float32Array, state}
 */
export function runBucket(rain, pet, params, state0 = null, from = 0, to = rain.length) {
  let st = state0 ?? { s: params.smax_mm * (params.s0_share ?? 0.8), f: 0, g: params.g0_mm ?? 0 };
  const n = to - from;
  const q = new Float32Array(n);
  const slow = new Float32Array(n);
  const petAt = typeof pet === 'function' ? pet : Array.isArray(pet) || ArrayBuffer.isView(pet) ? (j) => pet[j] : () => pet;
  for (let j = from; j < to; j++) {
    const r = bucketStep(st, { rain_mm: rain[j], pet_mm: petAt(j), dt_days: 1 }, params);
    st = r.state;
    q[j - from] = r.q_mm;
    slow[j - from] = r.q_slow;
  }
  return { q_mm: q, slow_mm: slow, state: st };
}

// ---------------------------------------------------------------- statistics

/** Normal quantile (Acklam), for the KP-01 "normal" dependable flow. */
export function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

const meanSd = (xs) => {
  const n = xs.length;
  let m = 0;
  for (const x of xs) m += x;
  m /= n;
  let v = 0;
  for (const x of xs) v += (x - m) * (x - m);
  return { mean: m, sd: Math.sqrt(v / (n - 1)) };
};

/**
 * Flow equalled or exceeded pct % of the time. method 'weibull' (rank m/(n+1), linear between ranks, default)
 * or 'normal' (mean + z sd, KP-01 Tabel 4-4 row 1a).
 */
export function dependable(values, pct, method = 'weibull') {
  const xs = Array.from(values).filter((x) => Number.isFinite(x));
  if (!xs.length) return null;
  const p = pct / 100;
  if (method === 'normal') {
    const { mean, sd } = meanSd(xs);
    return mean + normInv(1 - p) * sd;
  }
  xs.sort((a, b) => b - a);
  const n = xs.length;
  const m = p * (n + 1); // rank, 1-based
  if (m <= 1) return xs[0];
  if (m >= n) return xs[n - 1];
  const lo = Math.floor(m);
  return xs[lo - 1] + (m - lo) * (xs[lo] - xs[lo - 1]);
}

/** Flow-duration curve: points [{p (exceedance 0..1), q}] at the given exceedances. */
export function durationCurve(values, ps = [0.01, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99]) {
  return ps.map((p) => ({ p, q: dependable(values, p * 100) }));
}

/** Gumbel by the method of moments: mu, beta and q(T) = mu - beta ln(-ln(1 - 1/T)). */
export function gumbel(annualMax) {
  const { mean, sd } = meanSd(Array.from(annualMax));
  const beta = (sd * Math.sqrt(6)) / Math.PI;
  const mu = mean - 0.5772156649 * beta;
  return { mu, beta, mean, sd, q: (T) => mu - beta * Math.log(-Math.log(1 - 1 / T)) };
}

/** Gumbel reduced variate of a return period. */
export const gumbelY = (T) => -Math.log(-Math.log(1 - 1 / T));

/** Interpolate a table {T: q} at any T, linearly in the Gumbel reduced variate (extrapolates at the ends). */
export function tableQ(table, T) {
  const pts = Object.entries(table).map(([t, q]) => [gumbelY(+t), +q]).sort((a, b) => a[0] - b[0]);
  if (!pts.length) return null;
  if (pts.length === 1) return pts[0][1];
  const y = gumbelY(T);
  let i = 1;
  while (i < pts.length - 1 && y > pts[i][0]) i++;
  const [y0, q0] = pts[i - 1];
  const [y1, q1] = pts[i];
  return q0 + ((y - y0) * (q1 - q0)) / (y1 - y0);
}

// ---------------------------------------------------------------- series maker

const dailyCache = new WeakMap();
/** The daily basin rain of rain.json as mm: {start 'YYYY-MM-DD', y0, values: Float32Array}. */
export function dailyRain(rain) {
  const src = rain?.daily_basin_mean;
  if (!src?.values) return null;
  if (dailyCache.has(src)) return dailyCache.get(src);
  const sc = src.scale ?? 1;
  const values = Float32Array.from(src.values, (v) => (v == null ? 0 : v * sc));
  const out = { start: src.start, y0: +src.start.slice(0, 4), values };
  dailyCache.set(src, out);
  return out;
}

/** Month (0..11) of each day of a year. */
export function monthOfDay(year) {
  const out = new Uint8Array(daysInYear(year));
  let j = 0;
  monthDays(year).forEach((d, mo) => { for (let k = 0; k < d; k++) out[j++] = mo; });
  return out;
}

/** Day index of 1 January of year y counted from 1 January of y0. */
export function yearOffset(y0, y) {
  let n = 0;
  for (let k = y0; k < y; k++) n += daysInYear(k);
  return n;
}

/** Monthly totals of a daily array that starts on 1 January of year. */
export function monthlyTotals(values, year) {
  const mo = monthOfDay(year);
  const out = new Array(12).fill(0);
  for (let j = 0; j < mo.length && j < values.length; j++) out[mo[j]] += values[j];
  return out;
}

/**
 * A mean year of daily rain: the daily pattern of a template year, each month rescaled to monthly_mm x rain_scale
 * (default monthly_mm: the 1991-2020 climatology of rain.json). -> Float32Array (days of `year`).
 */
export function meanYearRain(rain, { monthly_mm = null, template_year, rain_scale = 1, year = 2025 } = {}) {
  const d = dailyRain(rain);
  const target = monthly_mm ?? rain?.monthly_mean_1991_2020;
  const n = daysInYear(year);
  const out = new Float32Array(n);
  const mo = monthOfDay(year);
  let tmpl = null;
  if (d && template_year != null) {
    const off = yearOffset(d.y0, template_year);
    tmpl = d.values.subarray(off, off + daysInYear(template_year));
  }
  const tot = new Array(12).fill(0);
  const cnt = new Array(12).fill(0);
  for (let j = 0; j < n; j++) {
    cnt[mo[j]]++;
    if (tmpl) tot[mo[j]] += tmpl[Math.min(j, tmpl.length - 1)];
  }
  for (let j = 0; j < n; j++) {
    const m = mo[j];
    const want = (target ? target[m] : 0) * rain_scale;
    out[j] = tmpl && tot[m] > 0 ? (tmpl[Math.min(j, tmpl.length - 1)] * want) / tot[m] : want / cnt[m];
  }
  return out;
}

/**
 * A design flood wave to add on top of the seasonal flow: amp x (t/tp)^a x e^(a(1 - t/tp)), t in days from its
 * start, peak amp at t = tp. -> Float32Array of n_days.
 */
export function floodHydrograph({ amp, tp_days, shape, n_days }) {
  const out = new Float32Array(n_days);
  for (let t = 0; t < n_days; t++) {
    const x = t / tp_days;
    out[t] = x <= 0 ? 0 : amp * Math.pow(x, shape) * Math.exp(shape * (1 - x));
  }
  return out;
}

const petFor = (pet_monthly, year) => {
  const mo = monthOfDay(year);
  const days = monthDays(year);
  return (j) => pet_monthly[mo[j]] / days[mo[j]];
};

/** Run the bucket over a mean year `spin` times to reach a settled start state. */
export function spinUp(rainYear, pet_monthly, params, year, spin = 3) {
  const pet = petFor(pet_monthly, year);
  let st = null;
  for (let s = 0; s < spin; s++) st = runBucket(rainYear, pet, params, st).state;
  return st;
}

/**
 * Daily modelled flow over whole years of the daily rain, from 1 January of from_year to 31 December of to_year,
 * starting from a settled mean-year state. -> {start, q_m3s, rain_mm, years: [y...]}
 */
export function replayRange(rain, { area_km2, params, from_year, to_year, rain_scale_year = null, rain_scale = 1 }) {
  const d = dailyRain(rain);
  if (!d) return null;
  const pm = rain.evap_monthly_mm;
  let st = spinUp(meanYearRain(rain, { template_year: params.template_year, year: 2001 }), pm, params, 2001, params.spin_years ?? 3);
  const off0 = yearOffset(d.y0, from_year);
  const total = yearOffset(from_year, to_year + 1);
  const q = new Float32Array(total);
  const r = new Float32Array(total);
  let j0 = 0;
  for (let y = from_year; y <= to_year; y++) {
    const n = daysInYear(y);
    const src = d.values.subarray(off0 + j0, off0 + j0 + n);
    const sc = rain_scale_year === y ? rain_scale : 1;
    const ry = sc === 1 ? src : Float32Array.from(src, (v) => v * sc);
    const res = runBucket(ry, petFor(pm, y), params, st);
    st = res.state;
    for (let k = 0; k < n; k++) { q[j0 + k] = mmToM3s(res.q_mm[k], area_km2, DAY_S); r[j0 + k] = ry[k]; }
    j0 += n;
  }
  return { start: `${from_year}-01-01`, q_m3s: q, rain_mm: r };
}

/**
 * The inflow series of one scenario year at the weir.
 * kind 'climatology' (mean year), 'replay' (a real year of the daily basin rain), 'design' (the mean year with a
 * design flood wave whose peak equals the published flood of return period design.T, or design.q_peak).
 * share (0..1 or null): scales the year's flow so that flow / rain over the year equals it; null keeps the model's.
 * -> {start, q_m3s, rain_mm, share_model, peak_day, q_peak, q_ref (GloFAS model, same days, or null),
 *     wave (design only: {start_day, step_days, q_m3s} total flow at sub-daily steps over the wave, else null)}
 */
export function inflowSeries({ kind = 'climatology', year = null, rain, flow = null, area_km2, rain_scale = 1, share = null,
  params, monthly_mm = null, design = null }) {
  const d = dailyRain(rain);
  const y1 = d ? d.y0 + Math.floor(d.values.length / 365.25) - 1 : null;
  let yr = year ?? params.nominal_year ?? 2025;
  let q;
  let r;
  if (kind === 'replay' && d) {
    yr = Math.min(Math.max(yr, d.y0), y1);
    const res = replayRange(rain, { area_km2, params, from_year: d.y0, to_year: yr, rain_scale_year: yr, rain_scale });
    const off = yearOffset(d.y0, yr);
    q = res.q_m3s.slice(off);
    r = res.rain_mm.slice(off);
  } else {
    r = meanYearRain(rain, { monthly_mm, template_year: params.template_year, rain_scale, year: yr });
    const pm = rain.evap_monthly_mm;
    const st = spinUp(r, pm, params, yr, params.spin_years ?? 3);
    const res = runBucket(r, petFor(pm, yr), params, st);
    q = Float32Array.from(res.q_mm, (v) => mmToM3s(v, area_km2, DAY_S));
  }
  let rs = 0;
  let qs = 0;
  for (let j = 0; j < q.length; j++) { rs += r[j]; qs += m3sToMm(q[j], area_km2, DAY_S); }
  const shareModel = rs > 0 ? qs / rs : null;
  if (share != null && shareModel) {
    const k = share / shareModel;
    for (let j = 0; j < q.length; j++) q[j] *= k;
  }
  let peakDay = null;
  let qPeak = null;
  let wave = null;
  if (kind === 'design') {
    const T = design?.T ?? null;
    qPeak = design?.q_peak ?? (T != null && params.design_q ? tableQ(params.design_q, T) : null);
    if (qPeak != null) {
      const tp = params.design_tp_days;
      const shape = params.design_shape;
      peakDay = Math.min(q.length - 1, design?.peak_day ?? params.design_peak_day);
      const start = Math.max(0, peakDay - tp); // the wave starts tp days before the peak
      const nDays = Math.min(q.length - 1 - Math.ceil(start), params.design_len_days ?? 30);
      const amp = Math.max(0, qPeak - q[peakDay]);
      // sub-daily points (step_days) over the wave: the seasonal flow interpolated plus the wave, so a slow run sees
      // the peak as a curve, not a single instant
      const step = params.design_step_days ?? 0.125;
      const n = Math.floor(nDays / step) + 1;
      const wq = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        const day = start + k * step;
        const i = Math.floor(day);
        const f = day - i;
        const base = q[i] * (1 - f) + q[Math.min(i + 1, q.length - 1)] * f;
        const x = (k * step) / tp;
        wq[k] = base + (x <= 0 ? 0 : amp * Math.pow(x, shape) * Math.exp(shape * (1 - x)));
      }
      for (let d = Math.ceil(start); d <= start + nDays; d++) {
        const x = (d - start) / tp;
        q[d] += x <= 0 ? 0 : amp * Math.pow(x, shape) * Math.exp(shape * (1 - x));
      }
      wave = { start_day: start, step_days: step, q_m3s: wq };
    }
  }
  let qRef = null;
  if (flow?.daily?.values && kind === 'replay') {
    const f0 = +flow.daily.start.slice(0, 4);
    if (yr >= f0) {
      const off = yearOffset(f0, yr);
      const v = flow.daily.values;
      if (off < v.length) qRef = Float32Array.from({ length: q.length }, (_, j) => (off + j < v.length && v[off + j] != null ? v[off + j] : NaN));
    }
  }
  return { kind, year: kind === 'replay' ? yr : null, start: `${yr}-01-01`, q_m3s: q, rain_mm: r, share_model: shareModel,
    peak_day: peakDay, q_peak: qPeak, q_ref: qRef, wave };
}
