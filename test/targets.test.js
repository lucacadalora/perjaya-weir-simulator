// Lane q01: every target of test/targets.json (originally plan/P2-targets-draft.json, made by
// tools/targets/) run against the engine it names.
// Run: node --test test/   (from the repo root). Expected values and tolerances are read from the targets file
// itself, never copied or loosened here. A target whose engine file is not on disk yet, or whose engine does not
// export the function the target needs, is SKIPPED with a message saying which.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const TARGETS_PATH = new URL('./targets.json', import.meta.url);
const ENG = (n) => new URL(`site/js/engine/${n}.js`, ROOT);

const targets = existsSync(TARGETS_PATH) ? JSON.parse(readFileSync(TARGETS_PATH, 'utf8')) : [];
const byId = Object.fromEntries(targets.map((t) => [t.id, t]));

const mods = {};
for (const n of ['rainflow', 'reservoir', 'weir', 'grid', 'flood', 'irrigation']) {
  if (existsSync(ENG(n))) {
    try { mods[n] = await import(ENG(n).href); } catch (e) { mods[n] = { __error: e.message }; }
  }
}

// The 5x5 toy valley of tools/targets/calc_examples.py (lane r13) (row-major from the north-west corner, metres).
const TOY = [9, 8, 7, 8, 9, 8, 6, 5, 6, 8, 7, 5, 3, 5, 7, 8, 6, 2, 6, 8, 9, 7, 1, 7, 9];
const CODES = { '0,1': 1, '1,1': 2, '1,0': 4, '1,-1': 8, '0,-1': 16, '-1,-1': 32, '-1,0': 64, '-1,1': 128 };
const DIR_NAMES = { 0: 'outlet', 1: 'E', 2: 'SE', 4: 'S', 8: 'SW', 16: 'W', 32: 'NW', 64: 'N', 128: 'NE' };
function d8(dem, cols, rows) {
  const nbr = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  const dir = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let best = 0, code = 0;
    for (const [dr, dc] of nbr) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      const s = (dem[r * cols + c] - dem[rr * cols + cc]) / (dr && dc ? Math.SQRT2 : 1);
      if (s > best) { best = s; code = CODES[`${dr},${dc}`]; }
    }
    dir[r * cols + c] = code;
  }
  return dir;
}
function accCells(dem, dir, cols) {
  const off = { 1: [0, 1], 2: [1, 1], 4: [1, 0], 8: [1, -1], 16: [0, -1], 32: [-1, -1], 64: [-1, 0], 128: [-1, 1] };
  const acc = new Float32Array(dem.length).fill(1);
  const order = [...dem.keys()].sort((a, b) => dem[b] - dem[a]);
  for (const i of order) { const o = off[dir[i]]; if (o) acc[(((i / cols) | 0) + o[0]) * cols + (i % cols) + o[1]] += acc[i]; }
  return acc;
}
// A grid object in the CONTRACT 4.8 shape whose cells are exactly 30 m by 30 m (900 m2), as the targets state.
function cellGrid(name, demM, cols, rows, extra = {}) {
  const cell = 30 / 111320;
  return { name, west: 100, north: 0, south: -rows * cell, east: 100 + cols * cell, cols, rows, cell,
    dem: Int16Array.from(demM, (z) => Math.round(z * 10)), dir: null, acc: null, hand: null, lc: null,
    cellAreaKm2: () => 900 / 1e6, ...extra };
}

// id -> [engine file, function names needed, (M, t) -> value]
const RUN = {
  'E1-01-coef-month': ['rainflow', ['runoffCoeff'], (M, t) => M.runoffCoeff({ rain_mm: t.P_mm, area_km2: t.A_km2, share: t.C, seconds: t.days * 86400 })],
  'E1-02-rational': ['rainflow', ['rational'], (M, t) => M.rational({ c: t.C, i_mm_h: t.I_mm_h, area_km2: t.A_km2 })],
  'E1-03-mock-wet-runoff': ['rainflow', ['mockStep'], (M, t) => mock(M, t).runoff],
  'E1-04-mock-wet-Q': ['rainflow', ['mockStep', 'mmToM3s'], (M, t) => M.mmToM3s(mock(M, byId[t.same_as].inputs).runoff, t.A_km2, t.days * 86400)],
  'E1-05-mock-dry-baseflow': ['rainflow', ['mockStep'], (M, t) => mock(M, t).runoff],
  'E1-06-mock-groundwater': ['rainflow', ['mockStep'], (M, t) => mock(M, byId[t.same_as].inputs).state.v],
  'E1-07-nreca-total': ['rainflow', ['nrecaStep'], (M, t) => nreca(M, t).runoff],
  'E1-08-nreca-storage': ['rainflow', ['nrecaStep'], (M, t) => nreca(M, byId[t.same_as].inputs).state.w],
  'E1-09-bucket-day1': ['rainflow', ['bucketStep', 'mmToM3s'], (M, t) =>
    M.mmToM3s(M.bucketStep({ s: t.S0_mm, f: 0, g: 0 }, { rain_mm: t.P_mm, pet_mm: 0, dt_days: 1 }, { smax_mm: t.Smax_mm, k_fast_days: t.K_days }).q_mm, t.A_km2, 86400)],
  'E1-10-q80-weibull': ['rainflow', ['dependable'], (M, t) => M.dependable(t.flows_m3s, 80)],
  'E1-11-q80-normal': ['rainflow', ['dependable'], (M, t) => M.dependable(t.flows_m3s, 80, 'normal')],
  'E2-01-grid-volume': ['reservoir', ['fillReservoir'], (M, t) => pool3(M, t).volume_m3],
  'E2-02-grid-area': ['reservoir', ['fillReservoir'], (M, t) => pool3(M, byId[t.same_as].inputs).area_km2 * 1e6],
  'E2-03-pool-equilibrium': ['reservoir', ['spillHeadFor'], (M, t) => M.spillHeadFor(t.I_m3s, t.b_m, t.C)],
  'E2-04-pool-euler-step': ['reservoir', ['routeStep'], (M, t) => M.routeStep({ curve: prism(t.A_m2), volume_m3: t.A_m2 * t.H0_m, crest_el: 0,
    spill_width_m: t.b_m, spill_cd: t.C, method: 'euler' }, t.I_m3s, t.dt_s).level_el],
  'E2-05-puls-linear': ['reservoir', ['levelPoolStep'], (M, t) => M.levelPoolStep({ v1_m3: t.A_m2 * t.H1_m, i1_m3s: t.I1, i2_m3s: t.I2, dt_s: t.dt_s,
    outflow: (v) => t.O_per_m * v / t.A_m2 }).v2_m3 / t.A_m2],
  'E2-06-evap-loss': ['reservoir', ['evapLoss'], (M, t) => M.evapLoss({ pan_mm_d: t.pan_mm_d, pan_coef: t.pan_coef, area_km2: t.area_km2 })],
  'E3-01-gate-free-kp02': ['weir', ['gateFlow'], (M, t) => M.gateFlow({ type: 'sluice', opening_m: t.a_m, width_m: t.b_m, h_up_m: t.h1_m, h_down_m: 0, cd: t.mu, g: t.g }).q_m3s],
  'E3-02-gate-free-energy': ['weir', ['gateFlowEnergy'], (M, t) => M.gateFlowEnergy({ Cc: t.Cc, a_m: t.a_m, b_m: t.b_m, h1_m: t.h1_m })],
  'E3-03-intake-submerged': ['weir', ['intakeFlow'], (M, t) => M.intakeFlow({ mu: t.mu, b_m: t.b_m, a_m: t.a_m, z_m: t.z_m })],
  'E3-04-crest': ['weir', ['crestFlow'], (M, t) => M.crestFlow({ width_m: t.b_m, head_m: t.H1_m, cd: t.Cd })],
  'E3-05-effective-width': ['weir', ['effectiveWidth'], (M, t) => M.effectiveWidth({ B_m: t.B_m, n_piers: t.n_piers, Kp: t.Kp, Ka: t.Ka, H1_m: t.H1_m })],
  'E3-06-crest-with-be': ['weir', ['effectiveWidth', 'crestFlow'], (M, t) =>
    M.crestFlow({ width_m: M.effectiveWidth({ B_m: t.B_m, n_piers: t.n_piers, Kp: t.Kp, Ka: t.Ka, H1_m: t.H1_m }), head_m: t.H1_m, cd: t.Cd })],
  'E3-07-manning': ['weir', ['manningQ'], (M, t) => M.manningQ({ b_m: t.b_m, side_z: t.side_z, y_m: t.y_m, n: t.n, S: t.S })],
  'E4-01-d8-acc': ['grid', ['catchment'], (M) => {
    const g = cellGrid('toy', TOY, 5, 5, { dir: d8(TOY, 5, 5) });
    if (typeof M.makeGrid === 'function') {
      const meta = { name: 'toy', west: g.west, north: g.north, south: g.south, east: g.east, cols: 5, rows: 5, cellsize_deg: g.cell, dir_codes: DIR_NAMES, nodata: { dem: -32768 } };
      Object.assign(g, M.makeGrid(meta, { dem: Int16Array.from(TOY), dir: d8(TOY, 5, 5) }), { cellAreaKm2: () => 900 / 1e6 });
    }
    return M.catchment({ toy: g }, { grid: 'toy', idx: 4 * 5 + 2 }).cells * 900;
  }],
  'E4-02-fill-cells': ['reservoir', ['fillReservoir'], (M, t) => fillToy(M, t).cells],
  'E4-03-fill-volume': ['reservoir', ['fillReservoir'], (M, t) => fillToy(M, byId[t.same_as].inputs).volume_m3],
  'E4-04-hand': ['flood', ['handFromDem'], (M, t) => hand(M, t)[t.cell[0] * 5 + t.cell[1]]],
  'E4-05-hand-extent': ['flood', ['handFromDem', 'extent'], (M, t) => {
    const h = hand(M, t), dir = d8(TOY, 5, 5);
    const g = cellGrid('fine', TOY, 5, 5, { dir, acc: accCells(TOY, dir, 5), hand: Int16Array.from(h, (v) => Math.round(v * 10)) });
    const fp = { min_river_km2: t.drain_threshold_cells * 0.0009, filter: 0, weir_lon: 200, weir_lat: 0 };
    return M.extent({ fine: g }, { grid: 'fine', stage_m: t.stage_m, floodParams: fp }).cells;
  }],
  'E6-01-lp-table': ['irrigation', ['lpRate'], (M, t) => M.lpRate({ M_mm_d: t.M_mm_d, T_d: t.T_d, S_mm: t.S_mm })],
  'E6-02-lp-table-b': ['irrigation', ['lpRate'], (M, t) => M.lpRate({ M_mm_d: t.M_mm_d, T_d: t.T_d, S_mm: t.S_mm })],
  'E6-03-re': ['irrigation', ['effRain'], (M, t) => M.effRain(t.R5_halfmonth_mm)],
  'E6-04-nfr': ['irrigation', ['nfr'], (M, t) => M.nfr({ ETo: t.ETo, Kc: t.Kc, P: t.P, WLR: t.WLR, Re: t.Re })],
  'E6-05-dr': ['irrigation', ['drLsHa'], (M, t) => M.drLsHa(t.NFR_mm_d, t.eff)],
  // groups staggered: one in land preparation (E6-01 settings), one at Kc 1.10, one at Kc 1.05, WLR of E6-04
  'E6-06-golongan': ['irrigation', ['settings', 'nfrPhase'], (M, t) => {
    const lp = byId['E6-01-lp-table'].inputs, n4 = byId['E6-04-nfr'].inputs;
    const s = M.settings({ kc_fao: [1.1, 1.1, 1.05, 1.05, 0.95, 0], efficiency: 0.65, groups: t.groups, landprep_days: lp.T_d, landprep_mm: lp.S_mm,
      percolation_mm_day: t.P, eto_mm_day: t.ETo }, { r5_mm: t.R5, wlr_mm_day: n4.WLR });
    const v = [M.nfrPhase(s, { stage: 'lp', i: 0 }, 0), M.nfrPhase(s, { stage: 'grow', i: 1 }, 0), M.nfrPhase(s, { stage: 'grow', i: 3 }, 0)];
    return (v[0] + v[1] + v[2]) / 3;
  }],
  'FF-01-gumbel-100': ['rainflow', ['gumbelYnSn'], (M, t) => M.gumbelYnSn(t.annual_max_m3s, { Yn: t.Yn, Sn: t.Sn }).q(t.T)],
  'FF-02-gumbel-chow-100': ['rainflow', ['gumbel'], (M, t) => M.gumbel(byId[t.same_as].inputs.annual_max_m3s).q(100)],
  'FF-03-lp3-100': ['rainflow', ['logPearson3'], (M, t) => M.logPearson3(byId[t.same_as].inputs.annual_max_m3s).q(100)],
  'FF-04-kt-cs05': ['rainflow', ['frequencyFactor'], (M, t) => M.frequencyFactor(t.Cs, t.T)],
};
const MOCK = (t) => ({ m: t.m, smc: t.SMC_mm, i: t.i, k: t.k, pf: t.PF ?? 0 });
const mock = (M, t) => M.mockStep({ sm: t.SM0_mm, v: t.V0_mm }, { p_mm: t.P_mm, pet_mm: t.Ep_mm, rain_days: t.rain_days }, MOCK(t));
const nreca = (M, t) => M.nrecaStep({ w: t.W0_mm, gw: t.GW0_mm }, { p_mm: t.P_mm, pet_mm: t.PET_mm }, { ra_mm_yr: t.Ra_mm_yr, psub: t.PSUB, gwf: t.GWF });
const prism = (A) => ({ level_el: [0, 100], area_km2: [A / 1e6, A / 1e6], volume_m3: [0, A * 100] });
function pool3(M, t) {
  const g = cellGrid('wide', t.dem.flat(), 3, 3);
  const flat = t.dem.flat(), seed = flat.indexOf(Math.min(...flat));
  return M.fillReservoir({ wide: g }, { grid: 'wide', idx: seed, level_el: t.level_m, line: false });
}
// "rows 0-2 behind dam line": the toy valley cut at the dam line, filled from the seed with no further wall.
function fillToy(M, t) {
  const g = cellGrid('wide', TOY.slice(0, 15), 5, 3);
  return M.fillReservoir({ wide: g }, { grid: 'wide', idx: t.seed[0] * 5 + t.seed[1], level_el: t.crest_m, line: false });
}
function hand(M, t) {
  const dir = d8(TOY, 5, 5);
  return M.handFromDem(TOY, dir, accCells(TOY, dir, 5), 5, 5, t.drain_threshold_cells);
}

test('targets file is readable and every target has a runner here', () => {
  assert.ok(targets.length > 0, `no targets at ${TARGETS_PATH}`);
  const missing = targets.filter((t) => !RUN[t.id]).map((t) => t.id);
  assert.deepEqual(missing, [], 'targets with no runner in test/targets.test.js');
});

for (const t of targets) {
  const spec = RUN[t.id];
  if (!spec) continue;
  const [eng, fns, fn] = spec;
  const M = mods[eng];
  let skip = false;
  if (!M) skip = `engine site/js/engine/${eng}.js not on disk yet`;
  else if (M.__error) skip = false;
  else if (!fn || fns.some((f) => typeof M[f] !== 'function')) skip = `${eng}.js exports no ${fns.filter((f) => typeof M[f] !== 'function').join(', ') || fns.join(', ')} for this target`;
  test(`${t.id} [${t.engine}] expect ${t.expect} ± ${t.tol}`, { skip }, () => {
    assert.ok(!M.__error, `${eng}.js failed to import: ${M.__error}`);
    const got = fn(M, t.inputs);
    assert.ok(Number.isFinite(got), `${t.id}: got ${got}`);
    assert.ok(Math.abs(got - t.expect) <= t.tol, `${t.id}: got ${got}, want ${t.expect} ± ${t.tol}`);
  });
}
