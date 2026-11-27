// Tests for engine E1 (rain to flow). Owner: lane b13. Targets: plan/P2-targets-draft.json (E1-01 to E1-11), never loosened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as rf from './rainflow.js';

const near = (got, want, tol, msg) => assert.ok(Math.abs(got - want) <= tol, `${msg}: got ${got}, want ${want} ± ${tol}`);
const MOCK = { m: 0.3, smc: 200, i: 0.4, k: 0.6, pf: 0 };

test('E1-01 runoff coefficient, a month', () => {
  near(rf.runoffCoeff({ rain_mm: 300, area_km2: 4320, share: 0.5, seconds: 30 * 86400 }), 250.0, 0.5, 'Q');
});

test('E1-02 rational peak', () => {
  near(rf.rational({ c: 0.6, i_mm_h: 20, area_km2: 100 }), 333.6, 0.5, 'Qp');
});

test('E1-03, E1-04, E1-06 Mock wet month', () => {
  const r = rf.mockStep({ sm: 200, v: 100 }, { p_mm: 300, pet_mm: 120, rain_days: 15 }, MOCK);
  near(r.runoff, 166.072, 0.1, 'runoff mm');
  near(rf.mmToM3s(r.runoff, 4320, 30 * 86400), 276.7867, 0.5, 'Q');
  near(r.state.v, 119.328, 0.05, 'V1');
});

test('E1-05 Mock dry month is all baseflow', () => {
  const r = rf.mockStep({ sm: 200, v: 119.328 }, { p_mm: 60, pet_mm: 135, rain_days: 5 }, MOCK);
  near(r.runoff, 47.732, 0.1, 'runoff mm');
  near(r.base, r.runoff, 1e-9, 'all base');
  near(r.state.sm, 151.325, 0.01, 'soil');
});

test('E1-07, E1-08 NRECA month', () => {
  const r = rf.nrecaStep({ w: 600, gw: 100 }, { p_mm: 300, pet_mm: 120 }, { ra_mm_yr: 2800, psub: 0.5, gwf: 0.5 });
  near(r.runoff, 105.8181, 0.2, 'runoff');
  near(r.state.w, 705.5759, 0.2, 'W1');
});

test('E1-09 daily bucket, first day', () => {
  const r = rf.bucketStep({ s: 120, f: 0, g: 0 }, { rain_mm: 100, pet_mm: 0, dt_days: 1 }, { smax_mm: 150, k_fast_days: 2 });
  near(rf.mmToM3s(r.q_mm, 4320, 86400), 1377.1427, 2, 'Q day 1');
});

const FLOWS = [420, 380, 350, 300, 280, 260, 240, 210, 190, 150];
test('E1-10 Q80 Weibull', () => near(rf.dependable(FLOWS, 80), 194.0, 0.01, 'Q80'));
test('E1-11 Q80 normal', () => near(rf.dependable(FLOWS, 80, 'normal'), 205.5141, 0.1, 'Q80'));

test('Gumbel by moments reproduces the GloFAS file fit', () => {
  const flow = JSON.parse(fs.readFileSync(new URL('../../data/climate/flow_glofas.json', import.meta.url)));
  const am = Object.entries(flow.annual_max).filter(([y]) => +y <= 2025).map(([, v]) => v);
  const g = rf.gumbel(am);
  near(g.q(100), flow.flood_frequency.Q100, 2, 'Q100');
  near(g.q(10), flow.flood_frequency.Q10, 2, 'Q10');
});

test('design table interpolates in the Gumbel variate', () => {
  const t = { 2: 917, 10: 1372, 100: 1939 };
  near(rf.tableQ(t, 10), 1372, 1e-9, 'on a point');
  const q50 = rf.tableQ(t, 50);
  assert.ok(q50 > 1372 && q50 < 1939);
});

test('Mock monthly spins up to a cycle', () => {
  const rain = [335, 305, 327, 283, 186, 116, 114, 99, 123, 224, 329, 375];
  const pet = [102, 97, 110, 105, 106, 100, 109, 122, 129, 127, 105, 97];
  const r = rf.mockMonthly({ rain_mm: rain, pet_mm: pet, area_km2: 4260, params: { ...MOCK, rain_days: 15 } });
  assert.equal(r.q_m3s.length, 12);
  assert.ok(r.q_m3s.every((q) => q >= 0));
  assert.ok(r.q_m3s[11] > r.q_m3s[7]);
});

// ---- the fit against the published Martapura flows (r03: JICA 1982 Table I-26, 1963-1980)
const rain = JSON.parse(fs.readFileSync(new URL('../../data/climate/rain.json', import.meta.url)));
// FALLBACK: the fitted bucket (lane b13, posted to b18 for params.json)
const BUCKET = { smax_mm: 117, k_fast_days: 11.6, k_slow_days: 152, gw_share: 0.686, perc_mm_day: 0, et_factor: 1.207, fc: 0.92, slow_exp: 1.057, g_ref_mm: 100, template_year: 2003, spin_years: 3 };
const Q80_PUB = [196, 176, 185, 182, 174, 110, 88, 73, 68, 56, 109, 157]; // params hydro.monthly_q80_m3s
const PUB = [235.6, 253.9, 238.1, 291.8, 252.3, 188.8, 146.5, 135.7, 134.9, 140.9, 183.7, 235.4];

test('replay 1991-2024 (A7 M5): mean within 5 %, April within 12 %, Q80 Jul-Oct within 20 %, 2019 low day under 60', () => {
  const res = rf.replayRange(rain, { area_km2: 4260, params: BUCKET, from_year: 1991, to_year: 2024 });
  const sum = new Array(12).fill(0);
  const cnt = new Array(12).fill(0);
  const means = Array.from({ length: 12 }, () => []);
  let j = 0;
  let all = 0;
  let min2019 = Infinity;
  for (let y = 1991; y <= 2024; y++) {
    const mo = rf.monthOfDay(y);
    const ms = new Array(12).fill(0);
    const mc = new Array(12).fill(0);
    for (let k = 0; k < mo.length; k++, j++) {
      const q = res.q_m3s[j];
      sum[mo[k]] += q; cnt[mo[k]]++; all += q; ms[mo[k]] += q; mc[mo[k]]++;
      if (y === 2019) min2019 = Math.min(min2019, q);
    }
    ms.forEach((v, i) => means[i].push(v / mc[i]));
  }
  const m = sum.map((v, i) => v / cnt[i]);
  near(all / j / 203.1, 1, 0.05, 'mean flow ratio');
  near(m[3] / PUB[3], 1, 0.12, 'April ratio');
  for (const i of [6, 7, 8, 9]) near(rf.dependable(means[i], 80) / Q80_PUB[i], 1, 0.2, `Q80 month ${i + 1}`);
  assert.ok(min2019 < 60, `2019 lowest day ${min2019}`);
});

test('series: each kind, length, positive, under 50 ms', () => {
  const flow = JSON.parse(fs.readFileSync(new URL('../../data/climate/flow_glofas.json', import.meta.url)));
  const design_q = { 2: 917, 10: 1372, 100: 1939 };
  const P = { ...BUCKET, design_q, design_tp_days: 3, design_shape: 4, design_peak_day: 104, design_len_days: 30, design_step_days: 0.125 };
  for (const [kind, year] of [['climatology', null], ['replay', 2016], ['replay', 2025], ['design', null]]) {
    const t0 = performance.now();
    const s = rf.inflowSeries({ kind, year, rain, flow, area_km2: 4260, params: P, design: { T: 100 } });
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `${kind} ${year} took ${ms.toFixed(1)} ms`);
    assert.equal(s.q_m3s.length, s.rain_mm.length);
    assert.ok(s.q_m3s.length >= 365);
    assert.ok(s.q_m3s.every((q) => q > 0 && Number.isFinite(q)), kind);
    if (kind === 'design') {
      near(s.q_m3s[s.peak_day], 1939, 1, 'design peak');
      const w = s.wave;
      assert.equal(w.step_days, 0.125);
      const kp = Math.round((s.peak_day - w.start_day) / w.step_days);
      near(w.q_m3s[kp], 1939, 1, 'wave peak');
      assert.ok(w.q_m3s[kp - 1] > 1800 && w.q_m3s[kp - 1] < 1939, 'peak is a curve at 3-hour steps');
      near(w.q_m3s[0], s.q_m3s[w.start_day], 1, 'wave starts on the seasonal flow');
    }
    if (kind === 'replay' && year === 2016) assert.ok(s.q_ref && s.q_ref.length === s.q_m3s.length);
  }
});

test('share and rain scale move the flow', () => {
  const a = rf.inflowSeries({ kind: 'climatology', rain, area_km2: 4260, params: BUCKET });
  const b = rf.inflowSeries({ kind: 'climatology', rain, area_km2: 4260, params: BUCKET, share: a.share_model * 1.2 });
  const c = rf.inflowSeries({ kind: 'climatology', rain, area_km2: 4260, params: BUCKET, rain_scale: 0.7 });
  const sum = (s) => s.q_m3s.reduce((x, y) => x + y, 0);
  near(sum(b) / sum(a), 1.2, 1e-3, 'share');
  assert.ok(sum(c) < 0.8 * sum(a));
});

test('scenarios: list and seriesFor with the real params.json', async () => {
  const S = await import('../sim/scenarios.js');
  const rd = (p) => JSON.parse(fs.readFileSync(new URL('../../data/' + p, import.meta.url)));
  const data = { rain, flow: rd('climate/flow_glofas.json') };
  let params = {};
  try { params = rd('params.json'); } catch { /* FALLBACK values */ }
  const list = S.scenarioList(data, params);
  assert.ok(list.find((s) => s.id === 'mean') && list.find((s) => s.kind === 'design') && list.filter((s) => s.dry).length === 4);
  for (const sc of [{ kind: 'climatology' }, { kind: 'replay', year: 1997 }, { kind: 'design', design_T: 100 }, { kind: 'design', design_T: null }]) {
    const t0 = performance.now();
    const s = S.seriesFor(sc, data, params);
    assert.ok(performance.now() - t0 < 50);
    assert.ok(s.modelled && s.q80 > 0 && s.q_mean > s.q80);
    if (sc.kind === 'design') {
      const T = S.pv(params, 'hydro.flood_T');
      const want = sc.design_T ? S.pv(params, 'hydro.flood_q_m3s')[T.indexOf(sc.design_T)] : S.pv(params, 'hydro.design_flood_m3s');
      near(s.q_m3s[s.peak_day], want, 1, 'design peak');
    }
  }
  near(S.flowAt({ q_m3s: [100, 200] }, 0.25), 125, 1e-9, 'flowAt');
});
