// Tests for the irrigation engine (lane b17).
// Targets E6-01..06 are from plan/P2-targets-draft.json (copied with their ids; never loosened).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lpRate, effRain, nfr, drLsHa, nfrPhase, settings, halfMonthOf, demandTable, demand, balance, halfMonthR80, etoPerDay, rainInputs, exceededShare } from './irrigation.js';

const near = (got, want, tol, msg) => assert.ok(Math.abs(got - want) <= tol, `${msg}: got ${got}, want ${want} +- ${tol}`);

const T = [
  { id: 'E6-01-lp-table', inputs: { M_mm_d: 5.0, T_d: 30, S_mm: 250 }, expect: 11.0818, tol: 0.05 },
  { id: 'E6-02-lp-table-b', inputs: { M_mm_d: 11.0, T_d: 45, S_mm: 300 }, expect: 13.6147, tol: 0.05 },
];
for (const t of T) test(t.id, () => near(lpRate(t.inputs), t.expect, t.tol, t.id));

test('E6-03-re', () => near(effRain(90), 4.2, 0.001, 'Re'));
test('E6-04-nfr', () => near(nfr({ ETo: 4.0, Kc: 1.1, P: 2.0, WLR: 3.3, Re: 4.2 }), 5.5, 0.001, 'NFR'));
test('E6-05-dr', () => near(drLsHa(5.5, 0.65), 0.9793, 0.002, 'DR'));

test('E6-06-golongan', () => {
  // three groups 15 days apart: one in land preparation, one at Kc 1.10, one at Kc 1.05 (both carrying WLR)
  const s = settings({ kc_fao: [1.1, 1.1, 1.05, 1.05, 0.95, 0], efficiency: 0.65, groups: 3, landprep_days: 30, landprep_mm: 250, percolation_mm_day: 2, eto_mm_day: 4 }, { r5_mm: 90, wlr_mm_day: 3.3 });
  const v = [nfrPhase(s, { stage: 'lp', i: 0 }, 0), nfrPhase(s, { stage: 'grow', i: 1 }, 0), nfrPhase(s, { stage: 'grow', i: 3 }, 0)];
  near((v[0] + v[1] + v[2]) / 3, 6.1797, 0.01, 'mean NFR');
});

// ---- with the real params.json ----
const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));
let P = null;
try {
  const raw = JSON.parse(readFileSync(dataDir + 'params.json', 'utf8'));
  const flat = raw.flat || {};
  P = {};
  for (const k of Object.keys(flat)) if (k.startsWith('irrigation.')) P[k.slice(11)] = flat[k];
} catch {
  P = null;
}

test('half-month index', () => {
  assert.equal(halfMonthOf(1, 1), 0);
  assert.equal(halfMonthOf(1, 16), 1);
  assert.equal(halfMonthOf(12, 31), 23);
});

test('demand table from params.json: positive, finite, three seasons', { skip: !P }, () => {
  const pattern = { r5_mm: new Array(24).fill(60), start_hm: 19, eto_mm_day: 4 };
  const t = demandTable(P, pattern);
  assert.ok(t.ok, 'table built');
  for (const v of t.dr_lsha) assert.ok(Number.isFinite(v) && v >= 0);
  const peak = Math.max(...t.dr_lsha);
  // KP-01 Gambar A.2.2: peak DR typically 1.2-1.5 l/s/ha with 3-4 groups; with modest rain it stays in 0.9-2.2
  assert.ok(peak > 0.9 && peak < 2.2, `peak ${peak}`);
  // two rice seasons and a palawija crop
  assert.ok(t.phases[0].includes('pal') && t.phases[0].includes('lp'), 'three seasons');
  const q = demand({ area_ha: P.area_default_ha, month: 11, day: 1, pattern, params: P });
  assert.ok(q > 0 && q < 200, `Nov demand ${q}`);
  const q2 = demand({ area_ha: P.area_default_ha, doy: 305, pattern, params: P });
  near(q2, q, 1e-9, 'doy gives same as month/day');
  // demand scales with area
  near(demand({ area_ha: 2 * P.area_default_ha, month: 11, day: 1, pattern, params: P }), 2 * q, 1e-9, 'linear in area');
});

test('demand returns null on missing inputs', () => {
  assert.equal(demand({ area_ha: 1000, month: 3, day: 1, params: {} }), null);
  assert.equal(demand({ area_ha: null, month: 3, day: 1, params: P || {} }), null);
});

test('balance keeps the maintenance flow and caps at the intake', () => {
  const r = balance({ q_river: [200, 100, 50, 20, NaN], demand: [80, 80, 80, 10, 5], intake_capacity_m3s: 91.68, env_flow_m3s: 35 });
  assert.deepEqual(r.supplied.slice(0, 4), [80, 65, 15, 0]);
  assert.deepEqual(r.shortfall.slice(0, 4), [0, 15, 65, 10]);
  assert.equal(r.supplied[4], null);
  near(r.reliability, 0.25, 1e-9, 'reliability');
  const c = balance({ q_river: [500], demand: [120], intake_capacity_m3s: 91.68, env_flow_m3s: 35 });
  near(c.supplied[0], 91.68, 1e-9, 'capped');
});

test('third crop (palawija) fills the fallow half-months when a Kc table is given', () => {
  const base = { kc_fao: [1.1, 1.1, 1.05, 1.05, 0.95, 0], efficiency: 0.65, groups: 1, landprep_days: 30, landprep_mm: 250, percolation_mm_day: 2, eto_mm_day: 4 };
  const pat = { start_hm: 19, r5_mm: new Array(24).fill(0) };
  const a = demandTable(base, { ...pat, palawija: false });
  const b = demandTable({ ...base, kc_palawija: [0.5, 0.75, 1, 1, 0.8, 0.5] }, pat); // test table, not a source value
  const fallowA = a.dr_lsha.filter((v) => v === 0).length;
  const fallowB = b.dr_lsha.filter((v) => v === 0).length;
  assert.equal(fallowA, 10); // 8 fallow + the two harvest half-months (Kc 0)
  assert.equal(fallowB, 4);
  // palawija half-month 2 (Kc 1): NFR = ETo
  const s = settings(base, { kc_palawija: [0.5, 0.75, 1] });
  near(nfrPhase(s, { stage: 'pal', i: 2 }, 0), 4, 1e-9, 'palawija NFR');
});

test('R80 half-month rain from a daily series and ETo per day', () => {
  // 10 synthetic years: every day of year k rains k mm -> each half-month total is k x its days
  const values = [];
  for (let y = 2001; y <= 2010; y++) {
    const days = (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / 86400000;
    for (let d = 0; d < days; d++) values.push((y - 2000) * 10);
  }
  const r = halfMonthR80({ start: '2001-01-01', scale: 0.1, values });
  assert.equal(r.length, 24);
  // exceeded 80 % of 10 years: rank round(0.8 x 11) = 9 from the top -> year 2 -> 2 mm/day x 15 days
  near(r[0], 30, 1e-9, 'Jan I');
  near(r[1], 32, 1e-9, 'Jan II (16 days)');
  assert.equal(exceededShare([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.8), 2);
  const e = etoPerDay([31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
  for (const v of e) near(v, 1, 1e-9, 'eto');
});

// CONTRACT A7 point 7 checks on the real data (KP-01 with rain.json): peak within 15 % of the sourced 1.1 l/s/ha,
// a palawija demand in September of roughly 0.3 to 0.5 l/s/ha, tight against Q80 less the maintenance flow.
let RAIN = null;
try {
  RAIN = JSON.parse(readFileSync(dataDir + 'climate/rain.json', 'utf8'));
} catch {
  RAIN = null;
}
test('A7.7: KP-01 demand from rain.json meets the sourced peak and shows palawija in September', { skip: !P || !RAIN }, () => {
  const raw = JSON.parse(readFileSync(dataDir + 'params.json', 'utf8'));
  const ri = rainInputs(RAIN, raw.flat['rainflow.et0_monthly_mm']);
  assert.ok(ri.r5_mm && ri.r5_mm.every(Number.isFinite), 'R80 from the daily rain');
  assert.ok(ri.eto_mm_day && ri.eto_mm_day.every((v) => v > 2 && v < 6), 'monthly ETo');
  // params' R80 table (b18) when present, else the one computed here; ETo always the monthly series
  const t = demandTable(P, Array.isArray(P.r80_halfmonth_mm) ? { eto_mm_day: ri.eto_mm_day } : ri);
  assert.ok(t.ok);
  for (let h = 0; h < 24; h++) if (Array.isArray(P.r80_halfmonth_mm)) assert.ok(Math.abs(P.r80_halfmonth_mm[h] - ri.r5_mm[h]) <= 0.3 * P.r80_halfmonth_mm[h] + 5, `R80 ${h}`);
  const peak = Math.max(...t.dr_lsha);
  const want = P.unit_demand_peak_lsha;
  assert.ok(Math.abs(peak - want) <= 0.15 * want, `peak ${peak.toFixed(3)} l/s/ha vs ${want}`);
  const sep = (t.dr_lsha[16] + t.dr_lsha[17]) / 2;
  assert.ok(sep >= 0.3 && sep <= 0.5, `September mean ${sep.toFixed(3)} l/s/ha`);
  assert.ok(t.phases.some((g) => g[16] === 'pal'), 'palawija in September');
  // tight: September demand on the legal area is within 20 % of (or over) Q80 - maintenance flow
  const q80sep = raw.flat['hydro.monthly_q80_m3s'][8];
  const freeSep = q80sep - P.env_flow_m3s;
  const dSep = (Math.max(t.dr_lsha[16], t.dr_lsha[17]) * P.area_default_ha) / 1000;
  assert.ok(dSep >= 0.8 * freeSep, `September demand ${dSep.toFixed(1)} vs free ${freeSep}`);
});
