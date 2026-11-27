// Node tests for the simulation core (lane s01). Run: node --test site/js/sim/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createStore } from '../store.js';
import { createClock, dateFor, calendarOf } from './clock.js';
import { init, pushHistory, emptyHistory, HISTORY_MAX } from './loop.js';
import { setEngineOverride, seriesAt, fallbackSeries } from './weir-run.js';

const DATA = new URL('../../data/', import.meta.url);
// The state keys of CONTRACT 4.4 that s01 reads (main.js cannot be imported in node: it boots the page).
const INITIAL_FOR_TEST = {
  mode: 'weir',
  clock: { day: 0, date: '2025-01-01', start_date: '2025-01-01', speed: 1, running: false },
  scenario: { kind: 'climatology', year: null, rain_scale: 1, label: '' },
  rain: { annual_mm: null, monthly_mm: null, runoff_share: null, today_mm: null },
  flow: { q_in: null, q_base: null },
  weir: { mode: 'auto', gates: [0, 0, 0, 0, 0, 0, 0], intake_open: 1, demand_m3s: null },
  flood: { stage_m: null, q: null, area_km2: null, depth_max_m: null, version: 0 },
  impact: { buildings: null, places: [], version: 0 },
  irrigation: { area_ha: null, demand_m3s: null, supplied_m3s: null, shortfall_m3s: null },
  maker: { active: null, placing: false, dams: [] },
};

function fakeCtx(extra = {}) {
  const store = createStore(structuredClone(INITIAL_FOR_TEST));
  const fieldMap = new Map();
  const ctx = {
    store,
    shot: true,
    log: () => {},
    data: { json: async (p) => JSON.parse(fs.readFileSync(new URL(p, DATA))) },
    fields: {
      get: (n) => fieldMap.get(n),
      set: (n, v) => { fieldMap.set(n, v); store.emit('field:' + n, v); },
      on: (n, fn) => store.listen('field:' + n, fn),
    },
    ...extra,
  };
  return ctx;
}

// Run `days` simulated days through __simStep-style frames of dt seconds at `speed` days per second.
async function runDays(ctx, days, speed, dt = 1 / 15) {
  ctx.store.patch('clock', { speed, running: true });
  const frames = Math.ceil(days / (speed * dt) - 1e-9);
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) await ctx.sim.clock.step(dt);
  return { frames, ms: performance.now() - t0 };
}

test('dates and calendar', () => {
  assert.equal(dateFor('2025-01-01', 0), '2025-01-01');
  assert.equal(dateFor('2025-01-01', 31.9), '2025-02-01');
  assert.equal(dateFor('2024-02-28', 1), '2024-02-29');
  assert.deepEqual(calendarOf('2025-01-01', 59), { year: 2025, month: 2, doy: 59, mday: 1 });
});

test('clock: frame events and exact stepping', async () => {
  const store = createStore({ clock: { day: 0, date: '2025-01-01', start_date: '2025-01-01', speed: 30, running: true } });
  const frames = [];
  store.listen('frame', (f) => frames.push(f));
  let stepped = 0;
  const clock = createClock(store, { onStep: (d) => (stepped += d), raf: () => 0, caf: () => {} });
  for (let i = 0; i < 15; i++) await clock.step(1 / 15);
  assert.equal(frames.length, 15);
  assert.ok(Math.abs(frames[14].t - 1) < 1e-9);
  assert.ok(Math.abs(store.get('clock.day') - 30) < 1e-9);
  assert.ok(Math.abs(stepped - 30) < 1e-9);
  assert.equal(store.get('clock.date'), '2025-01-31');
  assert.equal(clock.external(), true);
});

test('history ring buffer stays at 1500', () => {
  let h = emptyHistory();
  for (let i = 0; i < 1600; i++) h = pushHistory(h, { day: i, q_in: i });
  assert.equal(h.day.length, HISTORY_MAX);
  assert.equal(h.day[HISTORY_MAX - 1], 1599);
});

test('fallback series from the data files', () => {
  const rain = JSON.parse(fs.readFileSync(new URL('climate/rain.json', DATA)));
  const flow = JSON.parse(fs.readFileSync(new URL('climate/flow_glofas.json', DATA)));
  const s = fallbackSeries({ kind: 'climatology', rain_scale: 1 }, rain, flow);
  assert.equal(s.q_m3s.length, 365);
  const mean = s.q_m3s.reduce((a, b) => a + b, 0) / 365;
  assert.ok(mean > 50 && mean < 1000, 'mean ' + mean);
  const r = fallbackSeries({ kind: 'replay', year: 2010 }, rain, flow);
  assert.equal(r.start, '2010-01-01');
  assert.ok(Number.isFinite(seriesAt(r.q_m3s, 100.5)));
});

test('weir mode, a mean year with no engines at all: no exception, clock runs', async () => {
  setEngineOverride({ weir: null, rainflow: null, irrigation: null, flood: null });
  const ctx = fakeCtx();
  await init(ctx);
  ctx.sim.clock.stop();
  await ctx.sim.ready;
  await runDays(ctx, 365, 30);
  assert.ok(ctx.store.get('clock.day') >= 364.9);
  assert.ok(Number.isFinite(ctx.store.get('flow.q_in')));
  assert.equal(ctx.store.get('weir.pond_el'), null);
  assert.ok(ctx.store.get('history').day.length > 100);
  setEngineOverride(null);
});

test('weir mode, a mean year with stub engines', async () => {
  const stubWeir = {
    weirParamsFromData: () => ({ levels: { pond_target_el: 80 } }),
    solve: ({ q_in, controls }) => ({ pond_el: 80 + q_in / 1000, tail_el: 75, q_gates: q_in - 20, q_sluices: 0, q_intake: 20, q_down: q_in - 20, q_spill: 0, freeboard_m: 1, gates: [1, 1, 0, 0, 0, 0, 0], sluices: [0, 0, 0], intake_open: 1, alerts: controls.mode === 'flood' ? ['gates_full'] : [] }),
  };
  const stubFlood = { stageAt: (q) => q / 500 };
  let extents = 0;
  const engine = { call: async (fn) => { if (fn === 'flood.extent') { extents++; return { mask: new Uint8Array(10), depth_dm: null, area_km2: 1, depth_max_m: 1 }; } throw new Error('no ' + fn); } };
  setEngineOverride({ weir: stubWeir, rainflow: null, irrigation: { demand: () => 25 }, flood: stubFlood });
  const ctx = fakeCtx({ engine });
  await init(ctx);
  ctx.sim.clock.stop();
  await ctx.sim.ready;
  await runDays(ctx, 365, 30);
  const w = ctx.store.get('weir');
  assert.ok(w.pond_el > 80 && w.q_intake === 20);
  assert.deepEqual(w.gates, [1, 1, 0, 0, 0, 0, 0]);
  assert.equal(ctx.store.get('irrigation.demand_m3s'), 25);
  assert.equal(ctx.store.get('irrigation.reliability'), null); // no irrigation.balance in the stub: no rule, no number
  assert.ok(extents > 0, 'flood extent called');
  assert.ok(ctx.fields.get('flood.mask'));
  assert.ok(ctx.fields.get('scenario.series').q_m3s.length >= 365);
  setEngineOverride(null);
});

test('weir mode, a mean year with the real light engines; speed above 20 steps a second', async () => {
  const ctx = fakeCtx();
  await init(ctx);
  ctx.sim.clock.stop();
  await ctx.sim.ready;
  // "1 month per second" = about 30.4 days per real second, frames of 1/15 s
  const { frames, ms } = await runDays(ctx, 365, 30.4);
  const perSec = frames / (ms / 1000);
  const w = ctx.store.get('weir');
  console.log(`# real engines: ${frames} steps in ${ms.toFixed(0)} ms = ${perSec.toFixed(0)} steps/s; pond ${w.pond_el?.toFixed(2)} tail ${w.tail_el?.toFixed(2)} q_in ${ctx.store.get('flow.q_in')?.toFixed(0)} intake ${w.q_intake?.toFixed(1)} stage ${ctx.store.get('flood.stage_m')?.toFixed(2)} series ${ctx.fields.get('scenario.series')?.fallback ? 'fallback' : 'engine'}`);
  assert.ok(perSec > 20, 'steps per second ' + perSec);
  assert.ok(ctx.store.get('clock.day') >= 364.9);
});

test('maker mode on the real wide grid: place a preset dam, fill for a year', { timeout: 120000 }, async (t) => {
  const { packsPresent, loadPacks } = await import('../engine/node-loader.js');
  if (!(await packsPresent('wide'))) return t.skip('wide grid not on disk');
  const G = await loadPacks(['wide']);
  const mods = {};
  for (const n of ['grid', 'reservoir', 'impact']) mods[n] = await import('../engine/' + n + '.js');
  const engine = { call: async (fn, args) => { const [m, f] = fn.split('.'); return mods[m][f](G, args); } };
  const presets = JSON.parse(fs.readFileSync(new URL('presets.json', DATA)));
  const list = Array.isArray(presets) ? presets : presets.presets || presets.items || [];
  const p = list.find((x) => x.kind === 'dam' && x.id !== 'ranau') || list.find((x) => x.kind === 'dam');
  const ctx = fakeCtx({ engine });
  ctx.store.set('mode', 'maker');
  await init(ctx);
  ctx.sim.clock.stop();
  await ctx.sim.ready;
  const r = await ctx.sim.runner();
  const t0 = performance.now();
  await r.place({ lon: p.lon, lat: p.lat, name: p.name && p.name.en, ...p.dam });
  const buildMs = performance.now() - t0;
  let d = ctx.store.get('maker').dams[0];
  console.log(`# maker ${p.id}: build ${buildMs.toFixed(0)} ms, status ${d.status} ${d.error || ''}, catchment ${d.catchment_km2?.toFixed(0)} km2, crest ${d.crest_el} base ${d.base_el} line ${d.crest_len_m?.toFixed(0)} m, fsl ${(d.fsl_volume_m3 / 1e6)?.toFixed(0)} Mm3`);
  assert.ok(Number.isFinite(d.catchment_km2), 'catchment');
  assert.ok(ctx.fields.get('catchment.mask:' + d.id), 'catchment field');
  if (d.status === 'computing') return; // the valley does not close for this preset: the dam says so (error)
  assert.ok(ctx.fields.get('reservoir.curve:' + d.id) && ctx.fields.get('dam.line:' + d.id));
  // a new dam starts EMPTY on the day it is placed, level at its base, and fills over weeks
  assert.equal(d.fill, 0);
  assert.equal(d.level_el, d.base_el);
  const rows = [];
  const show = () => { const x = ctx.store.get('maker').dams[0]; rows.push(`${ctx.store.get('clock.day').toFixed(0)} d: ${(x.fill * 100).toFixed(1)} %, level ${x.level_el?.toFixed(1)}, spill ${x.spill_m3s?.toFixed(1)}`); return x; };
  show();
  ctx.store.patch('clock', { speed: 1, running: true });
  const fills = [];
  for (const target of [5, 15, 40]) { while (ctx.store.get('clock.day') < target - 1e-6) await ctx.sim.clock.step(1 / 15); fills.push(show().fill); }
  console.log('# fill from empty: ' + rows.join(' | '));
  assert.ok(fills[0] > 0 && fills[0] < 0.6 && fills[1] > fills[0], 'fills over weeks, not at once');
  await runDays(ctx, 300, 30.4);
  d = ctx.store.get('maker').dams[0];
  console.log(`# after a year: inflow ${d.inflow_m3s?.toFixed(1)} m3/s, level ${d.level_el?.toFixed(1)}, fill ${(d.fill * 100).toFixed(1)} %, spill ${d.spill_m3s?.toFixed(1)}, status ${d.status}, lake field ${!!ctx.fields.get('reservoir.mask:' + d.id)}, buildings ${ctx.store.get('impact.buildings')}`);
  assert.ok(d.fill > 0 && Number.isFinite(d.level_el));
  assert.ok(ctx.fields.get('reservoir.mask:' + d.id), 'lake mask');
  assert.ok(ctx.store.get('history').fill.some((v) => v > 0));
});

// A7 checks on the real fine grid with the real engines, run in-process (the worker's dispatch, impact prepared).
async function realFineCtx() {
  const { packsPresent, loadPacks } = await import('../engine/node-loader.js');
  if (!(await packsPresent('fine'))) return null;
  const G = await loadPacks(['fine']);
  const mods = {};
  for (const n of ['grid', 'flood', 'impact']) mods[n] = await import('../engine/' + n + '.js');
  const rd = (p, bin) => (bin ? (() => { const b = fs.readFileSync(new URL(p, DATA)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); })() : JSON.parse(fs.readFileSync(new URL(p, DATA))));
  const opt = (p, bin) => { try { return rd(p, bin); } catch { return null; } };
  const bin = opt('feat/buildings.bin', true), meta = opt('feat/buildings.json');
  mods.impact.prepare(G, { buildings: bin && meta ? { bin, meta } : null, roads: opt('feat/roads.geojson'), roads_fine: opt('feat/roads_fine.geojson'), rail: opt('feat/rail.geojson'), places: opt('feat/places.geojson') });
  const calls = [];
  const engine = { call: async (fn, args) => { calls.push(fn); const [m, f] = fn.split('.'); return mods[m][f](G, args); } };
  return { engine, calls };
}

test('A7: the mean year at day 100 floods 0 km2 and 0 buildings', { timeout: 120000 }, async (t) => {
  const real = await realFineCtx();
  if (!real) return t.skip('fine grid not on disk');
  const ctx = fakeCtx({ engine: real.engine });
  await init(ctx);
  ctx.sim.clock.stop();
  await ctx.sim.ready;
  await runDays(ctx, 100, 30);
  const s = ctx.store, f = s.get('flood'), im = s.get('impact');
  console.log(`# mean year ${s.get('clock.date')} (day ${s.get('clock.day').toFixed(1)}): q_in ${s.get('flow.q_in').toFixed(0)}, pond ${s.get('weir.pond_el').toFixed(2)}, tail ${s.get('weir.tail_el').toFixed(2)}, rises ${f.stage_m.toFixed(2)}/${f.stage_up_m.toFixed(2)} m, flood ${f.area_km2} km2, buildings ${im.buildings}, source ${im.source}`);
  assert.equal(f.area_km2, 0);
  assert.equal(im.buildings, 0);
  assert.equal(ctx.fields.get('flood.mask'), null);
});

test('A7: the 100-year design flood at its peak', { timeout: 180000 }, async (t) => {
  const real = await realFineCtx();
  if (!real) return t.skip('fine grid not on disk');
  const ctx = fakeCtx({ engine: real.engine, t: (k, en) => en });
  const toasts = [];
  ctx.store.listen('toast', (x) => toasts.push(x));
  ctx.store.set('scenario', { kind: 'design', year: null, rain_scale: 1, label: '', design_T: 100 });
  await init(ctx);
  ctx.sim.clock.stop();
  await ctx.sim.ready;
  const ser = ctx.fields.get('scenario.series');
  assert.ok(Number.isFinite(ser.peak_day), 'design series has a peak day');
  // pacing: 18 hours before the peak at one hour per second, run state kept, told once
  const { peakTime } = await import('./weir-run.js');
  assert.ok(Math.abs(ctx.store.get('clock.day') - (peakTime(ser) - 0.75)) < 1e-9);
  assert.ok(Math.abs(ctx.store.get('clock.speed') - 1 / 24) < 1e-12);
  assert.equal(ctx.store.get('clock.running'), false);
  assert.equal(toasts.length, 1);
  await ctx.sim.reset();
  assert.equal(toasts.length, 1, 'one toast per scenario');
  const qPeak = ser.wave && ser.wave.q_m3s ? Math.max(...ser.wave.q_m3s) : ser.q_m3s[ser.peak_day];
  // (a) frames of 2 days (30 d/s): the sub-daily steps must still see the peak in the history
  await runDays(ctx, 10, 30);
  const qmax = Math.max(...ctx.store.get('history').q_in.filter(Number.isFinite));
  // (b) start again and walk to the peak at 1 day per second (frames of 1/15 day), so the flood follows each frame
  await ctx.sim.reset();
  const day0 = ctx.store.get('clock.day');
  await runDays(ctx, ser.peak_day - day0, 1);
  const s = ctx.store, w = s.get('weir'), f = s.get('flood'), im = s.get('impact');
  console.log(`# design T100 peak ${s.get('clock.date')} (day ${ser.peak_day}): q_in ${s.get('flow.q_in').toFixed(0)} (series peak ${qPeak.toFixed(0)}, history max ${qmax.toFixed(0)}), pond EL ${w.pond_el.toFixed(2)}, tail EL ${w.tail_el.toFixed(2)}, rises ${f.stage_m.toFixed(2)}/${f.stage_up_m.toFixed(2)} m, flood ${f.area_km2.toFixed(2)} km2, depth max ${f.depth_max_m.toFixed(1)} m, buildings ${im.buildings}, roads ${im.roads_km?.toFixed(1)} km, alerts ${w.alerts.join(',')}`);
  assert.ok(qmax >= 0.99 * qPeak, 'history saw the peak');
  assert.ok(w.pond_el <= 81.0 + 1e-6, 'pond at or under EL 81.00');
  assert.ok(f.area_km2 > 0 && f.area_km2 < 500, 'plausible area');
  assert.ok(Number.isFinite(im.buildings) && im.buildings > 0, 'a building count');
  assert.equal(im.source, 'weir');
});

test('A8: demand without the irrigation tab, year totals, bank reference shift while paused', { timeout: 180000 }, async (t) => {
  const real = await realFineCtx();
  if (!real) return t.skip('fine grid not on disk');
  const ctx = fakeCtx({ engine: real.engine });
  await init(ctx);
  ctx.sim.clock.stop();
  await ctx.sim.ready;
  // a mean year, no tab ever wrote irrigation.pattern
  assert.equal(ctx.store.get('irrigation.pattern'), undefined);
  await runDays(ctx, 360, 30);
  const irr = ctx.store.get('irrigation');
  console.log(`# mean year totals: demand now ${irr.demand_m3s?.toFixed(1)} m3/s, days_run ${irr.days_run.toFixed(1)}, short_days ${irr.short_days.toFixed(1)}, short volume ${(irr.short_volume_m3 / 1e6).toFixed(1)} Mm3, reliability ${irr.reliability?.toFixed(3)}`);
  assert.ok(Number.isFinite(irr.demand_m3s), 'demand from defaults');
  assert.ok(Math.abs(irr.days_run - 360) < 0.01, 'days_run ' + irr.days_run);
  // the 100-year peak, paused, then shift the bank reference down 1 m: more ground floods at once
  ctx.store.set('scenario', { kind: 'design', year: null, rain_scale: 1, label: '', design_T: 100 });
  await new Promise((r) => setTimeout(r, 50));
  await ctx.sim.ready;
  const ser = ctx.fields.get('scenario.series');
  await runDays(ctx, ser.peak_day - ctx.store.get('clock.day'), 1);
  ctx.store.patch('clock', { running: false });
  const f0 = { ...ctx.store.get('flood') };
  const b0 = ctx.store.get('impact.buildings');
  ctx.store.set('flood.ref_shift_m', -1);
  await new Promise((r) => setTimeout(r, 1500));
  const f1 = ctx.store.get('flood');
  const b1 = ctx.store.get('impact.buildings');
  console.log(`# bank reference: shift 0 -> ref EL ${f0.ref_tail_el_used.toFixed(2)} (reached at ${f0.ref_q_m3s?.toFixed(0)} m3/s), ${f0.area_km2.toFixed(2)} km2, ${b0} buildings; shift -1 -> ref EL ${f1.ref_tail_el_used.toFixed(2)} (${f1.ref_q_m3s?.toFixed(0)} m3/s), ${f1.area_km2.toFixed(2)} km2, ${b1} buildings`);
  assert.ok(Math.abs(f1.ref_tail_el_used - (f0.ref_tail_el_used - 1)) < 1e-9);
  assert.ok(f1.ref_q_m3s < f0.ref_q_m3s);
  assert.ok(f1.area_km2 > f0.area_km2, 'more flooded with a lower bank');
});
