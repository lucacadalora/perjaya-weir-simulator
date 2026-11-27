// Irrigation demand engine (lane b17). CONTRACT 4.8; method E6 of the engine spec (KP-01 2013, Lampiran II).
// Pure functions, no DOM. Every constant comes from `params` (params.json group `irrigation`, unwrapped flat values)
// or from `pattern` (the tab's controls, state key `irrigation.pattern`).
//
//   demand({area_ha, month, day, doy, pattern, params}) -> m3/s at the intake for that date
//   balance({q_river[], demand[], intake_capacity_m3s, env_flow_m3s}) -> {supplied[], shortfall[], reliability}
//   demandTable(params, pattern) -> {dr_lsha[24], nfr[24], groups[g][24] phase codes, ...} by half-month
//   lpRate, effRain, nfr, drLsHa, halfMonthOf: the KP-01 building blocks (tested against the E6 targets).

export const HALF_MONTHS = 24;
// FALLBACK until params.json carries `irrigation.kc_palawija` (asked b18): KP-01 crop factors per half-month for
// soybean (kedelai), the usual palawija of the KP-01 tables.
export const FALLBACK_KC_PALAWIJA = [0.5, 0.75, 1.0, 1.0, 0.82, 0.45]; // FALLBACK
const MONTH_DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const pick = (...xs) => xs.find(fin);

// Land preparation rate (Van de Goor and Zijlstra): IR = M e^k / (e^k - 1), k = M T / S. mm/day.
export function lpRate({ M_mm_d, T_d, S_mm }) {
  if (!fin(M_mm_d) || !fin(T_d) || !fin(S_mm) || T_d <= 0 || S_mm <= 0) return null;
  if (M_mm_d <= 0) return S_mm / T_d;
  const ek = Math.exp((M_mm_d * T_d) / S_mm);
  return (M_mm_d * ek) / (ek - 1);
}

// Effective rain for rice (KP-01 eq A.2.5): Re = 0.7 R5 / 15, R5 the dry half-month rain. mm/day.
export function effRain(R5_halfmonth_mm, factor = 0.7) {
  return fin(R5_halfmonth_mm) && R5_halfmonth_mm > 0 ? ((fin(factor) ? factor : 0.7) * R5_halfmonth_mm) / 15 : 0;
}

// Net field requirement in the growth stage: NFR = Kc ETo + P + WLR - Re (never below zero). mm/day.
export function nfr({ ETo, Kc, P, WLR = 0, Re = 0 }) {
  if (!fin(ETo) || !fin(Kc) || !fin(P)) return null;
  if (Kc <= 0) return 0; // harvest half-month: field dried out
  return Math.max(0, Kc * ETo + P + (WLR || 0) - (Re || 0));
}

// Intake demand per hectare: DR = NFR / (8.64 e). l/s/ha.
export function drLsHa(nfr_mm_d, eff) {
  if (!fin(nfr_mm_d) || !fin(eff) || eff <= 0) return null;
  return nfr_mm_d / (8.64 * eff);
}

// Half-month index 0..23 (0 = 1-15 January, 1 = 16-31 January, ...). month 1..12, day 1..31.
export function halfMonthOf(month, day) {
  const m = Math.min(12, Math.max(1, Math.round(month || 1)));
  return (m - 1) * 2 + ((day || 1) > 15 ? 1 : 0);
}

const at24 = (v, h) => (Array.isArray(v) || ArrayBuffer.isView(v) ? v[((h % v.length) + v.length) % v.length] : v);
// A 12-value monthly series is read per month; 24 values per half-month; a scalar as is.
function seriesAt(v, h) {
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    if (v.length === 12) return v[Math.floor(h / 2)];
    return at24(v, h);
  }
  return v;
}

// Resolve the working settings from params (defaults) and pattern (the user's controls).
export function settings(params = {}, pattern = {}) {
  const p = params || {};
  const q = pattern || {};
  const kc = Array.isArray(q.kc) ? q.kc : p.kc_fao;
  const T = pick(q.landprep_days, p.landprep_days);
  return {
    eff: pick(q.efficiency, p.efficiency),
    groups: Math.max(1, Math.round(pick(q.groups, p.groups) ?? 1)),
    stagger_hm: Math.max(0, Math.round(pick(q.stagger_hm, 1))), // KP-01: groups start 15 days apart
    T,
    S: pick(q.landprep_mm, p.landprep_mm),
    P: pick(q.percolation_mm_day, p.percolation_mm_day),
    eto: q.eto_mm_day ?? p.eto_monthly_mm_day ?? p.eto_mm_day, // mm/day: scalar, [12] or [24]
    r5: q.r5_mm ?? p.r80_halfmonth_mm ?? p.r5_halfmonth_mm ?? null, // R80 half-month rain [24] (mm)
    re_factor: pick(q.re_factor, p.re_factor, 0.7),
    wlr: pick(q.wlr_mm_day, p.wlr_mm_day, 50 / 15), // 50 mm over a half-month (KP-01), method constant
    wlr_hm: Array.isArray(q.wlr_hm) ? q.wlr_hm : [1, 3], // growth half-months that carry the WLR (1 and 2 months)
    kc: Array.isArray(kc) ? kc : null,
    lp_hm: fin(T) ? Math.max(1, Math.round(T / 15)) : 2,
    start_hm: pick(q.start_hm, p.start_hm, 20), // FALLBACK: land preparation of group 1 from 1 November (JICA's November peak)
    seasons: Math.max(1, Math.min(2, Math.round(pick(q.seasons, p.rice_seasons, 2)))), // two rice crops, then palawija
    area_share: pick(q.area_share, 1),
    // third crop (palawija) after the two rice crops: Kc per half-month from params (none = not counted)
    kc_pal: Array.isArray(q.kc_palawija) ? q.kc_palawija : Array.isArray(p.kc_palawija) ? p.kc_palawija : q.palawija === false ? null : FALLBACK_KC_PALAWIJA,
    pal_share: pick(q.palawija_share, p.palawija_share, 1), // share of the area planted with the third crop
  };
}

// Phase of one group at half-month h: {stage:'lp'|'grow'|'fallow', i}
function phaseAt(s, g, h) {
  const len = s.lp_hm + (s.kc ? s.kc.length : 0);
  const first = s.start_hm + g * s.stagger_hm;
  for (let k = 0; k < s.seasons; k++) {
    const st = first + k * len;
    const d = (((h - st) % HALF_MONTHS) + HALF_MONTHS) % HALF_MONTHS;
    if (d < s.lp_hm) return { stage: 'lp', i: d };
    if (d < len) return { stage: 'grow', i: d - s.lp_hm };
  }
  if (s.kc_pal) {
    const d = (((h - (first + s.seasons * len)) % HALF_MONTHS) + HALF_MONTHS) % HALF_MONTHS;
    if (d < s.kc_pal.length && s.seasons * len + d < HALF_MONTHS) return { stage: 'pal', i: d };
  }
  return { stage: 'fallow', i: -1 };
}

// NFR (mm/day) of a field in a given phase at half-month h.
export function nfrPhase(s, phase, h) {
  const ETo = seriesAt(s.eto, h);
  const Re = effRain(seriesAt(s.r5, h), s.re_factor);
  if (!fin(ETo) || !fin(s.P)) return null;
  if (phase.stage === 'lp') {
    const IR = lpRate({ M_mm_d: 1.1 * ETo + s.P, T_d: s.T, S_mm: s.S });
    return IR == null ? null : Math.max(0, IR - Re);
  }
  if (phase.stage === 'grow') {
    const Kc = s.kc[phase.i];
    const WLR = s.wlr_hm.includes(phase.i) ? s.wlr : 0;
    return nfr({ ETo, Kc, P: s.P, WLR, Re });
  }
  if (phase.stage === 'pal') {
    // upland crop: no ponding, no percolation, no water-layer replacement (KP-01 palawija: NFR = ETc - Re)
    const Kc = s.kc_pal[phase.i];
    return fin(Kc) ? Math.max(0, Kc * ETo - Re) * s.pal_share : 0;
  }
  return 0;
}

// Demand by half-month for the whole year: NFR and DR are means over the groups (each group holds 1/groups of the area).
export function demandTable(params, pattern) {
  const s = settings(params, pattern);
  const out = { nfr: new Array(HALF_MONTHS).fill(null), dr_lsha: new Array(HALF_MONTHS).fill(null), phases: [], ok: false, settings: s };
  if (!s.kc || !fin(s.eff) || !fin(s.T) || !fin(s.S) || !fin(s.P) || s.eto == null) return out;
  for (let g = 0; g < s.groups; g++) out.phases.push(new Array(HALF_MONTHS));
  for (let h = 0; h < HALF_MONTHS; h++) {
    let sum = 0;
    for (let g = 0; g < s.groups; g++) {
      const ph = phaseAt(s, g, h);
      out.phases[g][h] = ph.stage === 'grow' ? 'g' + ph.i : ph.stage;
      const v = nfrPhase(s, ph, h);
      if (v == null) return out;
      sum += v;
    }
    out.nfr[h] = sum / s.groups;
    out.dr_lsha[h] = drLsHa(out.nfr[h], s.eff);
  }
  out.ok = true;
  return out;
}

// The value exceeded a share `p` of the time (Weibull plotting position) in a list.
export function exceededShare(values, p) {
  const a = Array.from(values || []).filter(fin).sort((x, y) => y - x);
  if (!a.length) return null;
  const rank = Math.min(a.length, Math.max(1, Math.round(p * (a.length + 1))));
  return a[rank - 1];
}

// Half-month rain exceeded 80 % of the years (KP-01 R80), mm per half-month, from a daily series
// {start 'YYYY-MM-DD', scale, values[]} (rain.json daily_basin_mean). Only complete years count. -> [24] or null.
export function halfMonthR80(daily, p = 0.8) {
  if (!daily || !daily.values || !daily.start) return null;
  const t0 = Date.parse(daily.start + 'T00:00:00Z');
  if (!Number.isFinite(t0)) return null;
  const scale = fin(daily.scale) ? daily.scale : 1;
  const sums = new Map(); // year -> {v[24], n}
  for (let i = 0; i < daily.values.length; i++) {
    const v = daily.values[i];
    if (!fin(v)) continue;
    const d = new Date(t0 + i * 86400000);
    const y = d.getUTCFullYear();
    let rec = sums.get(y);
    if (!rec) sums.set(y, (rec = { v: new Array(HALF_MONTHS).fill(0), n: 0 }));
    rec.v[halfMonthOf(d.getUTCMonth() + 1, d.getUTCDate())] += v * scale;
    rec.n++;
  }
  const years = [...sums.values()].filter((r) => r.n >= 365);
  if (years.length < 5) return null;
  const out = [];
  for (let h = 0; h < HALF_MONTHS; h++) out.push(Math.round(exceededShare(years.map((r) => r.v[h]), p) * 10) / 10);
  return out;
}

// Reference evapotranspiration per day by month from monthly totals (mm per month, [12]).
export function etoPerDay(monthly_mm) {
  if (!Array.isArray(monthly_mm) || monthly_mm.length !== 12 || !monthly_mm.every(fin)) return null;
  return monthly_mm.map((v, m) => Math.round((v / MONTH_DAYS[m]) * 100) / 100);
}

// Everything the demand needs from rain.json: {r5_mm[24] (R80 half-month rain), eto_mm_day[12]}.
// `et0_monthly_mm` (params rainflow) wins over rain.json's own monthly totals so both engines use one ETo.
export function rainInputs(rain, et0_monthly_mm) {
  return {
    r5_mm: halfMonthR80(rain && rain.daily_basin_mean),
    eto_mm_day: etoPerDay(Array.isArray(et0_monthly_mm) ? et0_monthly_mm : rain && rain.evap_monthly_mm),
  };
}

const cache = new Map();
function cachedTable(params, pattern) {
  let key;
  try {
    key = JSON.stringify([params, pattern]);
  } catch {
    return demandTable(params, pattern);
  }
  let t = cache.get(key);
  if (!t) {
    if (cache.size > 32) cache.clear();
    t = demandTable(params, pattern);
    cache.set(key, t);
  }
  return t;
}

// Intake demand (m3/s) on a date. Returns null when the inputs are incomplete.
export function demand({ area_ha, month, day, doy, pattern, params } = {}) {
  if (!fin(area_ha) || area_ha < 0) return null;
  let m = month;
  let d = day;
  if (!fin(m) && fin(doy)) {
    const dt = new Date(Date.UTC(2001, 0, 1) + (Math.max(1, doy) - 1) * 86400000);
    m = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
  }
  if (!fin(m)) return null;
  const t = cachedTable(params || {}, pattern || {});
  if (!t.ok) return null;
  const dr = t.dr_lsha[halfMonthOf(m, d)];
  return fin(dr) ? (dr * area_ha * t.settings.area_share) / 1000 : null;
}

// Water balance at the weir: the river keeps env_flow below the weir; the intake takes at most its capacity.
// reliability = share of steps whose demand is met in full (within 0.1 %).
export function balance({ q_river = [], demand: dem = [], intake_capacity_m3s, env_flow_m3s } = {}) {
  const n = Math.min(q_river.length, dem.length);
  const supplied = new Array(n);
  const shortfall = new Array(n);
  const cap = fin(intake_capacity_m3s) ? intake_capacity_m3s : Infinity;
  const env = fin(env_flow_m3s) ? env_flow_m3s : 0;
  let ok = 0;
  let counted = 0;
  for (let i = 0; i < n; i++) {
    const q = q_river[i];
    const d = dem[i];
    if (!fin(q) || !fin(d)) {
      supplied[i] = null;
      shortfall[i] = null;
      continue;
    }
    const avail = Math.max(0, Math.min(cap, q - env));
    supplied[i] = Math.min(Math.max(0, d), avail);
    shortfall[i] = Math.max(0, d - supplied[i]);
    counted++;
    if (shortfall[i] <= 1e-3 * Math.max(d, 1e-9)) ok++;
  }
  return { supplied, shortfall, reliability: counted ? ok / counted : null };
}
