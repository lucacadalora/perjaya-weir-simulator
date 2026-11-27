// Tests for engine/sediment.js (lane s, 24 Nov 2026). Run: node --test site/js/engine/sediment.test.js
// A small parameter set is written here; the last block runs on the real data files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sedimentParams, ratingA, riverLoad, storageM3, initState, requestFlush, trapShare, step } from './sediment.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} got ${a}, want ${b} +/- ${tol}`);
const HOUR = 3600;
const DAY = 86400;

const P0 = {
  rating_a: 0.053, rating_b: 2.5199, yield_t_yr: 5.02e6, rating_fit_yield: false,
  monthly_q_m3s: [235.6, 253.9, 238.1, 291.8, 252.3, 188.8, 146.5, 135.7, 134.9, 140.9, 183.7, 235.4],
  conc_max_mgL: 10000, intake_factor: 0.4, intake_sand_share: 0.3, trap_sand: 0.85, trap_fine: 0.1, trap_full_from: 0.8,
  dry_density_t_m3: 1.4, storage_depth_m: 1.0, flush_at: 0.8, flush_hours: 4, flush_left: 0.02, flush_q_m3s: 16,
  start_fill: [0.55, 0.15, 0.7, 0.3, 0.45], count: 5, width_m: 45, length_m: 140, depth_m: 4.3, q_design_m3s: 16,
};
const P = (o = {}) => ({ ...P0, ...o });

test('rating: the sourced formula, t/day and mg/L', () => {
  const r = riverLoad(100, P());
  near(r.t_day, 0.053 * Math.pow(100, 2.5199), 1e-6, 'Qs');
  near(r.c_mgL, (r.t_day * 1e6) / (100 * DAY), 1e-9, 'c = Qs / Qw');
  assert.deepEqual(riverLoad(0, P()), { t_day: 0, c_mgL: 0 });
});

test('rating fitted to the sourced yield over the mean year keeps the exponent', () => {
  const p = P({ rating_fit_yield: true });
  const a = ratingA(p);
  const days = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const yr = p.monthly_q_m3s.reduce((s, q, m) => s + days[m] * riverLoad(q, p).t_day, 0);
  near(yr, 5.02e6, 1, 'annual load');
  near(a, 0.0187, 0.0005, 'coefficient');
  near(riverLoad(200, p).t_day / riverLoad(100, p).t_day, Math.pow(2, 2.5199), 1e-9, 'exponent unchanged');
});

test('concentration is held at the cap', () => {
  const r = riverLoad(5000, P());
  assert.equal(r.c_mgL, 10000);
  near(r.t_day, (10000 * 5000 * DAY) / 1e6, 1e-3);
});

test('intake draws a share of the river concentration; the canal is clearer than the intake', () => {
  const p = P();
  const { out } = step(initState(p), { q_river: 200, q_intake: 80, dt_s: 0 }, p);
  near(out.c_intake_mgL, 0.4 * out.c_river_mgL, 1e-9);
  assert.ok(out.c_canal_mgL < out.c_intake_mgL && out.c_canal_mgL > 0);
  assert.equal(out.storage_m3, 45 * 140 * 1.0);
  assert.deepEqual(out.basins.map((b) => +b.fill.toFixed(2)), [0.55, 0.15, 0.7, 0.3, 0.45]);
  assert.equal(out.flushing, null);
});

test('mass balance: what is trapped is the deposit gained times the dry density', () => {
  const p = P();
  const s0 = initState(p);
  const { state, out } = step(s0, { q_river: 200, q_intake: 80, dt_s: 2 * DAY }, p);
  const dv = state.basins.reduce((s, b, i) => s + b.deposit_m3 - s0.basins[i].deposit_m3, 0);
  near(out.trapped_t, dv * 1.4, 1e-6);
  assert.equal(out.returned_t, 0);
  // rate check by hand: each basin 16 m3/s, intake concentration 0.4 x river, trap share 0.3*0.85 + 0.7*0.1
  const cIn = 0.4 * riverLoad(200, p).c_mgL;
  near(out.trapped_t_day, ((80 * cIn) / 1e6) * DAY * (0.3 * 0.85 + 0.7 * 0.1), 1e-6);
});

test('a basin over its design flow and a basin nearly full trap less', () => {
  const p = P();
  const base = trapShare(16, 0.5, p);
  near(base, 0.325, 1e-12);
  near(trapShare(20, 0.5, p), base * 16 / 20, 1e-12);
  near(trapShare(16, 0.9, p), base * 0.5, 1e-12);
  assert.equal(trapShare(16, 1, p), 0);
  assert.equal(trapShare(0, 0.5, p), 0);
});

test('automatic rule: the fullest basin at 80 %, one at a time, the others carry the canal', () => {
  const p = P({ start_fill: [0.79, 0.85, 0.82, 0.1, 0.1] });
  const { state, out } = step(initState(p), { q_river: 200, q_intake: 80, dt_s: 60 }, p);
  assert.equal(state.active, 1, 'fullest first');
  assert.equal(out.basins[1].state, 'flushing');
  assert.equal(out.basins.filter((b) => b.state === 'flushing').length, 1);
  near(out.basins[0].q_m3s, 20, 1e-9, 'four basins share 80');
  near(out.q_flush_m3s, 16, 1e-9);
  assert.ok(out.c_flush_mgL > out.c_intake_mgL * 5, 'flushing water is very muddy');
  // without the automatic rule nothing starts
  const off = step(initState(p), { q_river: 200, q_intake: 80, dt_s: 60, auto: false }, p);
  assert.equal(off.state.active, null);
  assert.equal(off.out.next.days, 0, 'due now');
});

test('a flush clears the deposit to 2 % in 4 hours and returns it to the river', () => {
  const p = P({ start_fill: [0.9, 0, 0, 0, 0] });
  const s0 = initState(p);
  const V0 = s0.basins[0].deposit_m3;
  let r = step(s0, { q_river: 200, q_intake: 80, dt_s: 2 * HOUR }, p);
  assert.equal(r.out.basins[0].state, 'flushing');
  near(r.out.basins[0].progress, 0.5, 1e-9);
  near(r.state.basins[0].deposit_m3, V0 * Math.sqrt(0.02), 1e-6, 'half-way');
  r = step(r.state, { q_river: 200, q_intake: 80, dt_s: 2 * HOUR + 600 }, p);
  assert.equal(r.state.active, null);
  assert.equal(r.out.basins[0].flushes, 1);
  assert.ok(r.state.basins[0].deposit_m3 >= V0 * 0.02 - 1e-6 && r.state.basins[0].deposit_m3 < V0 * 0.03, 'about 2 % left, refilling');
  // one long step gives the same as two
  const one = step(s0, { q_river: 200, q_intake: 80, dt_s: 4 * HOUR + 600 }, p);
  near(one.state.basins[0].deposit_m3, r.state.basins[0].deposit_m3, 1e-6);
});

test('returned tonnes are the deposit removed', () => {
  const p = P({ start_fill: [0.9, 0, 0, 0, 0] });
  const s0 = initState(p);
  const r = step(s0, { q_river: 200, q_intake: 0, dt_s: 5 * HOUR }, p);
  near(r.out.returned_t, (s0.basins[0].deposit_m3 - r.state.basins[0].deposit_m3) * 1.4, 1e-6);
  assert.equal(r.out.trapped_t, 0, 'intake shut: nothing comes in');
});

test('a flush waits when the river has nothing to spare', () => {
  const p = P({ start_fill: [0.9, 0, 0, 0, 0] });
  const s0 = initState(p);
  const r = step(s0, { q_river: 80, q_intake: 80, dt_s: 6 * HOUR }, p);
  assert.equal(r.state.active, 0);
  near(r.state.basins[0].deposit_m3, s0.basins[0].deposit_m3, 1e-9, 'nothing scoured');
  assert.equal(r.out.basins[0].waiting, true);
  const half = step(s0, { q_river: 88, q_intake: 80, dt_s: 4 * HOUR }, p);
  near(half.out.basins[0].progress, 0.5, 1e-9, 'half the water, half the pace');
});

test('flush by hand: starts at once or queues; asking twice changes nothing', () => {
  const p = P();
  let s = initState(p);
  let r = requestFlush(s, null, p);
  assert.equal(r.basin, 2, 'the fullest');
  assert.equal(r.state.active, 2);
  r = requestFlush(r.state, 0, p);
  assert.deepEqual(r.state.queue, [0]);
  r = requestFlush(r.state, 0, p);
  assert.deepEqual(r.state.queue, [0]);
  r = requestFlush(r.state, 2, p);
  assert.deepEqual(r.state.queue, [0], 'the active one is not queued');
  s = r.state;
  const out = step(s, { q_river: 200, q_intake: 80, dt_s: 4 * HOUR + 60 }, p);
  assert.equal(out.state.active, 0, 'the queued basin follows');
  assert.equal(out.out.basins[2].flushes, 1);
  assert.equal(s.queue.length, 1, 'state never changed in place');
});

test('a year per second equals an hour per second (sub-steps)', () => {
  const p = P();
  let a = initState(p);
  let ta = 0;
  for (let i = 0; i < 24 * 30; i++) {
    const r = step(a, { q_river: 220, q_intake: 81, dt_s: HOUR }, p);
    a = r.state;
    ta += r.out.trapped_t;
  }
  const b = step(initState(p), { q_river: 220, q_intake: 81, dt_s: 30 * DAY }, p);
  for (let i = 0; i < 5; i++) near(b.state.basins[i].deposit_m3, a.basins[i].deposit_m3, 1, 'basin ' + i);
  near(b.out.trapped_t, ta, 1);
  // in 30 wet-season days at least one basin was flushed on its own
  assert.ok(b.state.basins.some((x) => x.flushes > 0));
});

test('next flush: which basin and in how many days', () => {
  const p = P();
  const { out } = step(initState(p), { q_river: 200, q_intake: 80, dt_s: 0 }, p);
  assert.equal(out.next.basin, 2);
  const rate = out.basins[2].q_m3s * (out.c_intake_mgL / 1e6) * out.basins[2].trap / 1.4; // m3/s
  near(out.next.days, (0.1 * 6300) / rate / DAY, 1e-6);
});

test('real data files', () => {
  const root = fileURLToPath(new URL('../../data/', import.meta.url));
  const params = JSON.parse(readFileSync(root + 'params.json', 'utf8'));
  const weir = JSON.parse(readFileSync(root + 'weir.json', 'utf8'));
  const p = sedimentParams(params, weir);
  assert.ok(p, 'params read');
  assert.equal(p.count, 5);
  assert.equal(p.width_m, 45);
  assert.equal(p.length_m, 140);
  assert.equal(p.q_design_m3s, 16);
  assert.equal(p.rating_fit_yield, true);
  const a = ratingA(p);
  near(a, 0.0187, 0.0005);
  // at the mean flow the river carries several hundred mg/L; the basins fill in weeks, not hours or years
  const mean = params.flat['hydro.mean_flow_m3s'];
  const c = riverLoad(mean, p).c_mgL;
  assert.ok(c > 300 && c < 2000, 'mean-flow concentration ' + c);
  const { out } = step(initState(p), { q_river: mean, q_intake: 81, dt_s: 0 }, p);
  const perBasin = out.trapped_t_day / 1.4 / 5; // m3/day
  const days = (0.8 * storageM3(p)) / (perBasin / p.dry_density_t_m3 * 1.4);
  assert.ok(days > 10 && days < 200, 'empty to 80 % in ' + days.toFixed(0) + ' days');
  assert.equal(sedimentParams({}, weir), null, 'missing values give null');
});
