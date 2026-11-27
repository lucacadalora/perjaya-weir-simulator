// Tests for engine/reservoir.js (lane b12). Expected values of the E2 targets are copied from
// plan/P2-targets-draft.json (ids in the test names); never loosen them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  damLine, fillReservoir, storageCurve, volumeAt, levelAt, areaAt,
  routeStep, levelPoolStep, spillFlow, spillHeadFor, evapLoss,
} from './reservoir.js';

const M = 111320;

// a grid object in the CONTRACT 4.8 shape; dem in metres in, decimetres stored
function makeGrid({ name = 'wide', cols, rows, cell_m, north = 0, west = 100, z, dir, acc }) {
  const cell = cell_m / M;
  const dem = new Int16Array(cols * rows), d = new Uint8Array(cols * rows), a = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    dem[i] = Math.round(z(c, r) * 10);
    if (dir) d[i] = dir(c, r);
    if (acc) a[i] = acc(c, r);
  }
  return {
    name, west, north, south: north - rows * cell, east: west + cols * cell, cols, rows, cell,
    dem, dir: dir ? d : null, acc: acc ? a : null, hand: null, lc: null,
    cellAreaKm2(row) {
      const lat = north - (row + 0.5) * cell;
      return (cell * M) * (cell * M * Math.cos(lat * Math.PI / 180)) / 1e6;
    },
  };
}

// V-valley running north to south: bed rises upstream (north) at Sy, sides rise at s per metre across
const V = { cols: 81, rows: 460, cell_m: 30, cr: 40, rd: 420, z0: 50, s: 0.05, Sy: 0.002 };
function vValley() {
  const { cols, rows, cell_m, cr, rd, z0, s, Sy } = V;
  return makeGrid({
    cols, rows, cell_m,
    z: (c, r) => z0 + Sy * (rd - r) * cell_m + s * Math.abs(c - cr) * cell_m,
    dir: (c) => (c === cr ? 4 : c < cr ? 1 : 16),
    acc: (c, r) => (c === cr ? 1 + r : 0.001),
  });
}
const analyticV = (h) => Math.pow(h - V.z0, 3) / (3 * V.s * V.Sy); // integral of (h - z0 - Sy y)^2 / s dy

test('E2-01-grid-volume and E2-02-grid-area on the 3x3 target grid', () => {
  const rowsZ = [[10, 11, 12], [9, 10, 11], [8, 9, 13]];
  const g = makeGrid({ cols: 3, rows: 3, cell_m: 30, z: (c, r) => rowsZ[r][c] });
  g.cellAreaKm2 = () => 900 / 1e6; // cell_m 30 exactly, as the target states
  const res = fillReservoir({ wide: g }, { grid: 'wide', idx: 6, level_el: 10.5, line: false });
  assert.ok(Math.abs(res.volume_m3 - 5850.0) <= 0.01, `volume ${res.volume_m3}`);
  assert.ok(Math.abs(res.area_km2 * 1e6 - 4500.0) <= 0.01, `area ${res.area_km2 * 1e6}`);
  const cur = storageCurve({ wide: g }, { grid: 'wide', idx: 6, crest_el: 10.5, line: false });
  assert.ok(Math.abs(volumeAt(cur, 10.5) - 5850) <= 0.01);
});

test('damLine closes a V-valley at right angles to the stream', () => {
  const G = { wide: vValley() };
  const idx = V.rd * V.cols + V.cr;
  const crest = V.z0 + 20;
  const l = damLine(G, { grid: 'wide', idx, crest_el: crest });
  assert.equal(l.ok, true, l.reason);
  // half width = 20 / s = 400 m each side
  assert.ok(Math.abs(l.length_m - 800) < 2, `length ${l.length_m}`);
  assert.ok(Math.abs(l.height_m - 20) < 0.1, `height ${l.height_m}`);
  assert.ok(Math.abs(l.base_el - V.z0) < 0.1);
  assert.ok(Math.abs(l.dir_deg - 180) < 1e-6, 'stream runs south');
  assert.ok(Math.abs(l.bearing_deg - 90) < 1e-6 || Math.abs(l.bearing_deg - 270) < 1e-6, `bearing ${l.bearing_deg}`);
  assert.ok(l.a.lon > l.b.lon, 'a is the left bank looking downstream (east when flowing south)');
  assert.ok(l.profile.length > 10 && l.profile[0].d_m === 0);
  assert.ok(Math.abs(l.profile.at(-1).d_m - l.length_m) < 1e-6);
});

test('damLine says why when the valley does not close', () => {
  const G = { wide: vValley() };
  const idx = V.rd * V.cols + V.cr;
  const open = damLine(G, { grid: 'wide', idx, crest_el: V.z0 + 20, max_side_m: 300 });
  assert.equal(open.ok, false);
  assert.match(open.reason, /valley_open/);
  const low = damLine(G, { grid: 'wide', idx, crest_el: V.z0 - 1 });
  assert.equal(low.ok, false);
  assert.equal(low.reason, 'crest_below_ground');
  const flat = makeGrid({ cols: 50, rows: 50, cell_m: 30, z: () => 10, dir: () => 4, acc: (c, r) => r + 1 });
  const f = damLine({ wide: flat }, { grid: 'wide', idx: 25 * 50 + 25, crest_el: 30 });
  assert.equal(f.ok, false);
});

test('fillReservoir in a V-valley matches the analytic volume within 2 % and stays upstream', () => {
  const G = { wide: vValley() };
  const idx = V.rd * V.cols + V.cr;
  for (const h of [V.z0 + 10, V.z0 + 15, V.z0 + 20]) {
    const line = damLine(G, { grid: 'wide', idx, crest_el: V.z0 + 20 });
    const f = fillReservoir(G, { grid: 'wide', idx, level_el: h, line });
    const err = Math.abs(f.volume_m3 / analyticV(h) - 1);
    assert.ok(err < 0.02, `h ${h}: ${f.volume_m3} vs ${analyticV(h)} (${(err * 100).toFixed(2)} %)`);
    assert.ok(f.bbox[3] < V.rd, 'nothing below the dam');
    assert.equal(f.mask.length, V.cols * V.rows);
    assert.ok(f.max_depth_m <= h - V.z0 + 0.06);
  }
});

test('storageCurve agrees with fillReservoir and with the analytic curve', () => {
  const G = { wide: vValley() };
  const idx = V.rd * V.cols + V.cr;
  const crest = V.z0 + 20;
  const line = damLine(G, { grid: 'wide', idx, crest_el: crest });
  const cur = storageCurve(G, { grid: 'wide', idx, crest_el: crest, line });
  assert.ok(cur.level_el.length > 150, 'every 0.1 m by default');
  assert.ok(Math.abs(cur.level_el.at(-1) - crest) < 1e-9);
  for (let k = 1; k < cur.volume_m3.length; k++) {
    assert.ok(cur.volume_m3[k] >= cur.volume_m3[k - 1]);
    assert.ok(cur.area_km2[k] >= cur.area_km2[k - 1]);
  }
  for (const h of [V.z0 + 5.05, V.z0 + 12.3, crest]) {
    const f = fillReservoir(G, { grid: 'wide', idx, level_el: h, line });
    assert.ok(Math.abs(volumeAt(cur, h) / f.volume_m3 - 1) < 0.005, `curve vs fill at ${h}`);
    // areas of a decimetre-quantised surface step between tabulated levels; exact on them
    const onLevel = Math.abs(h * 10 - Math.round(h * 10)) < 1e-9;
    assert.ok(Math.abs(areaAt(cur, h) / f.area_km2 - 1) < (onLevel ? 1e-9 : 0.06), `area at ${h}`);
    if (h - V.z0 >= 10) { // a 5 m pond is only 7 cells wide: too coarse for a 2 % analytic match
      assert.ok(Math.abs(volumeAt(cur, h) / analyticV(h) - 1) < 0.02, `curve vs analytic at ${h}`);
    }
  }
  const s5 = storageCurve(G, { grid: 'wide', idx, crest_el: crest, line, steps: 5 });
  assert.equal(s5.level_el.length, 5);
});

test('fill does not leak through a low saddle beyond the wall but does fill a connected side basin', () => {
  // a pocket below the level that only connects over a ridge higher than the level stays dry
  const g = vValley();
  const pr = 300, pc = 70; // pocket on the side slope
  for (let r = pr - 2; r <= pr + 2; r++) for (let c = pc - 2; c <= pc + 2; c++) g.dem[r * g.cols + c] = (V.z0 + 5) * 10;
  const G = { wide: g };
  const idx = V.rd * V.cols + V.cr;
  const line = damLine(G, { grid: 'wide', idx, crest_el: V.z0 + 20 });
  const f = fillReservoir(G, { grid: 'wide', idx, level_el: V.z0 + 15, line });
  assert.equal(f.mask[pr * g.cols + pc], 0, 'isolated pocket stays dry');
  const cur = storageCurve(G, { grid: 'wide', idx, crest_el: V.z0 + 20, line });
  assert.ok(Math.abs(volumeAt(cur, V.z0 + 15) / f.volume_m3 - 1) < 0.005, 'curve also leaves it out');
});

test('interpolators invert each other and extend sensibly', () => {
  const cur = { level_el: [10, 11, 12, 13], area_km2: [0, 1, 2, 3], volume_m3: [0, 0.5e6, 2e6, 4.5e6] };
  for (const h of [10.2, 11, 11.7, 12.9]) assert.ok(Math.abs(levelAt(cur, volumeAt(cur, h)) - h) < 1e-9);
  assert.equal(volumeAt(cur, 9), 0);
  assert.equal(levelAt(cur, 0), 10);
  assert.equal(areaAt(cur, 20), 3);
  assert.equal(volumeAt(cur, 14), 4.5e6 + 3e6);
  assert.ok(Math.abs(levelAt(cur, 7.5e6) - 14) < 1e-9);
  assert.equal(areaAt(cur, 11.5), 1.5);
});

// a prism pond: constant area, crest at level 0
const prism = (A_m2) => ({ level_el: [0, 100], area_km2: [A_m2 / 1e6, A_m2 / 1e6], volume_m3: [0, A_m2 * 100] });

test('E2-03-pool-equilibrium: head where C b H^1.5 equals the inflow', () => {
  assert.ok(Math.abs(spillHeadFor(500, 100, 2.2) - 1.7286) <= 0.001);
  assert.ok(Math.abs(spillFlow(1.7286, 100, 2.2) - 500) < 0.1);
  // routing settles there too
  let st = { curve: prism(2e6), volume_m3: 0, crest_el: 0, spill_width_m: 100, spill_cd: 2.2 };
  for (let k = 0; k < 400; k++) st = { ...st, ...routeStep(st, 500, 3600) };
  assert.ok(Math.abs(st.level_el - 1.7286) <= 0.001, `settled at ${st.level_el}`);
  assert.ok(Math.abs(st.spill_m3s - 500) < 0.5);
});

test('E2-04-pool-euler-step: H1 = H0 + (I - O) dt / A', () => {
  const st = { curve: prism(2e6), volume_m3: 2e6 * 1.0, crest_el: 0, spill_width_m: 100, spill_cd: 2.2,
    method: 'euler' };
  const r = routeStep(st, 500, 3600);
  assert.ok(Math.abs(r.level_el - 1.504) <= 0.001, `H1 ${r.level_el}`);
  assert.ok(Math.abs(r.spill_m3s - 220) < 1e-9);
});

test('E2-05-puls-linear: trapezoid step with a linear outflow', () => {
  const A = 2e6;
  const r = levelPoolStep({ v1_m3: A * 1.0, i1_m3s: 500, i2_m3s: 500, dt_s: 3600, outflow: (v) => 100 * v / A });
  assert.ok(Math.abs(r.v2_m3 / A - 1.6606) <= 0.0005, `H2 ${r.v2_m3 / A}`);
});

test('E2-06-evap-loss: pan 4.6 mm/d x 0.7 over 1 km2', () => {
  assert.ok(Math.abs(evapLoss({ pan_mm_d: 4.6, pan_coef: 0.7, area_km2: 1 }) - 3220.0) <= 1);
  const st = { curve: prism(1e6), volume_m3: 5e6, crest_el: 100, evap_mm_day: 4.6, pan_coef: 0.7 };
  const r = routeStep(st, 0, 86400);
  assert.ok(Math.abs(r.evap_m3s * 86400 - 3220) <= 1);
  assert.ok(Math.abs(5e6 - r.volume_m3 - 3220) <= 1);
});

test('routeStep keeps mass, holds a constant release and never goes negative', () => {
  const cur = prism(1e6);
  let st = { curve: cur, volume_m3: 1e6, crest_el: 50, spill_width_m: 50, spill_cd: 2, release_m3s: 20 };
  const r1 = routeStep(st, 30, 3600);
  assert.ok(Math.abs(r1.volume_m3 - (1e6 + 10 * 3600)) < 1);
  assert.equal(r1.release_m3s, 20);
  assert.equal(r1.spill_m3s, 0);
  // drain: release larger than what is there
  st = { ...st, volume_m3: 1000, release_m3s: 100 };
  const r2 = routeStep(st, 0, 3600);
  assert.equal(r2.volume_m3, 0);
  assert.ok(r2.release_m3s >= 0 && Math.abs(r2.release_m3s * 3600 - 1000) < 1e-6);
  const r3 = routeStep({ ...st, volume_m3: 0 }, 0, 3600);
  assert.equal(r3.volume_m3, 0);
  assert.equal(r3.release_m3s, 0);
  // mass balance over a flood with spill: dV = (I - O) dt summed
  st = { curve: cur, volume_m3: 50e6, crest_el: 50, spill_width_m: 50, spill_cd: 2, release_m3s: 10 };
  let v0 = st.volume_m3, out = 0, inn = 0;
  for (let k = 0; k < 200; k++) {
    const q = k < 50 ? 1000 * k / 50 : Math.max(0, 1000 - 10 * (k - 50));
    const r = routeStep(st, q, 1800);
    inn += q * 1800; out += (r.release_m3s + r.spill_m3s + r.evap_m3s) * 1800;
    st = { ...st, volume_m3: r.volume_m3 };
  }
  assert.ok(Math.abs(st.volume_m3 - v0 - (inn - out)) / inn < 1e-6, 'mass kept');
});

test('a pond that would spill round the dam is held at the rim and says so', () => {
  const G = { wide: vValley() };
  const idx = V.rd * V.cols + V.cr;
  const line = damLine(G, { grid: 'wide', idx, crest_el: V.z0 + 10 }); // closes at 60
  const f = fillReservoir(G, { grid: 'wide', idx, level_el: V.z0 + 20, line });
  assert.equal(f.leak, 'spill');
  assert.ok(f.rim_el > V.z0 + 10 && f.rim_el < V.z0 + 16, `rim ${f.rim_el}`);
  assert.equal(f.level_el, f.rim_el);
  assert.ok(f.bbox[3] < V.rd + 3, 'the lowland below the dam stays dry');
  const cur = storageCurve(G, { grid: 'wide', idx, crest_el: V.z0 + 20, line });
  assert.equal(cur.leak, 'spill');
  assert.ok(Math.abs(cur.level_el.at(-1) - f.rim_el) < 1e-9);
  assert.ok(Math.abs(cur.volume_m3.at(-1) / f.volume_m3 - 1) < 0.005);
  // a sound dam has no rim
  const ok = fillReservoir(G, { grid: 'wide', idx, level_el: V.z0 + 9.5, line });
  assert.equal(ok.leak, null);
  assert.equal(ok.rim_el, null);
});

test('a pond that reaches the edge of the grid is flagged', () => {
  const g = vValley();
  const G = { wide: g };
  const idx = V.rd * V.cols + V.cr;
  const line = damLine(G, { grid: 'wide', idx, crest_el: V.z0 + 20 });
  // cut the valley short: rows above 300 are gone, so a 20 m pond (10 km long) runs into the top edge
  const short = { ...g, rows: g.rows - 200, north: g.north - 200 * g.cell,
    dem: g.dem.slice(200 * g.cols), dir: g.dir.slice(200 * g.cols), acc: g.acc.slice(200 * g.cols) };
  short.cellAreaKm2 = g.cellAreaKm2;
  const shortIdx = (V.rd - 200) * V.cols + V.cr;
  const f = fillReservoir({ wide: short }, { grid: 'wide', idx: shortIdx, level_el: V.z0 + 20, line });
  assert.equal(f.leak, 'edge');
  assert.ok(f.rim_el < V.z0 + 20);
});

// ---- the real wide grid (skipped when the packs are not on disk) ------------------------------------------------
test('real wide grid: 100 m dams give a storage curve in under 2 s', async (t) => {
  let loader;
  try { loader = await import('./node-loader.js'); } catch { t.skip('node-loader.js not there yet'); return; }
  if (!(await loader.packsPresent('wide'))) { t.skip('wide packs not on disk'); return; }
  const G = await loader.loadPacks(['wide'], { layers: ['dem', 'dir', 'acc'] });
  const g = G.wide;
  for (const [name, p] of Object.entries(g.meta.outlets || {})) {
    const idx = p.row * g.cols + p.col;
    const crest = g.dem[idx] / 10 + 100;
    const t0 = performance.now();
    const line = damLine(G, { grid: 'wide', idx, crest_el: crest });
    if (!line.ok) continue; // an open valley is a fair answer for some sites
    const cur = storageCurve(G, { grid: 'wide', idx, crest_el: crest, line });
    const ms = performance.now() - t0;
    assert.ok(ms < 2000, `${name}: ${ms.toFixed(0)} ms`);
    assert.ok(cur.volume_m3.at(-1) > 0, `${name}: some storage`);
    const f = fillReservoir(G, { grid: 'wide', idx, level_el: cur.level_el.at(-1), line });
    assert.ok(Math.abs(f.volume_m3 / cur.volume_m3.at(-1) - 1) < 0.005, `${name}: fill and curve agree`);
  }
  // worst case: a natural basin filled 100 m deep from the weir with no wall and no rim floods the lowlands
  const w = g.meta.weir, wi = w.row * g.cols + w.col;
  const t1 = performance.now();
  const big = storageCurve(G, { grid: 'wide', idx: wi, crest_el: g.dem[wi] / 10 + 100, line: false });
  const ms = performance.now() - t1;
  assert.ok(ms < 2000, `worst-case curve ${ms.toFixed(0)} ms over ${big.cells} cells`);
});

test('x01 L13: the curve starts at the dam foot and rises strictly, with a high river cell and a pit upstream', () => {
  const g = vValley();
  const C = V.cols, foot = V.rd * C + V.cr;
  g.dem[foot] = (V.z0 - 8) * 10; // the river at the dam is 8 m lower than the next cell up (a 30 m model artefact)
  const pr = V.rd - 6, pc = V.cr + 3; // a 5 m pit near the river, its rim reached only once the pond rises
  g.dem[pr * C + pc] = (V.z0 - 3) * 10;
  const G = { wide: g };
  const line = damLine(G, { grid: 'wide', idx: foot, crest_el: V.z0 + 20 });
  assert.equal(line.ok, true);
  assert.ok(line.base_el < V.z0 - 7, `foot ${line.base_el}`);
  const cur = storageCurve(G, { grid: 'wide', idx: foot, crest_el: V.z0 + 20, line });
  assert.ok(Math.abs(cur.level_el[0] - line.base_el) < 1e-9, `curve starts at ${cur.level_el[0]}`);
  assert.equal(cur.base_el, line.base_el);
  assert.equal(cur.volume_m3[0], 0);
  for (let k = 1; k < cur.volume_m3.length; k++) {
    assert.ok(cur.volume_m3[k] > cur.volume_m3[k - 1], `strict at ${cur.level_el[k]}`);
    // no steps: a 0.1 m rise never adds more than the area at the top of the step times 0.1 m
    const dv = cur.volume_m3[k] - cur.volume_m3[k - 1], dh = cur.level_el[k] - cur.level_el[k - 1];
    assert.ok(dv <= cur.area_km2[k] * 1e6 * dh * 1.0001, `step at ${cur.level_el[k]}`);
  }
  for (const h of [V.z0 - 4, V.z0 + 0.35, V.z0 + 12]) {
    const f = fillReservoir(G, { grid: 'wide', idx: foot, level_el: h, line });
    assert.ok(Math.abs(f.volume_m3 - volumeAt(cur, h)) <= 1e-6 * Math.max(1, f.volume_m3) + 1, `fill vs curve at ${h}`);
    assert.ok(f.cells > 0 && f.bbox[3] < V.rd);
  }
  // the analytic volume still holds once the pond is deep
  assert.ok(Math.abs(volumeAt(cur, V.z0 + 20) / analyticV(V.z0 + 20) - 1) < 0.02);
  // levels round-trip from the foot up
  for (const v of [1, 1e3, 1e5, 1e7]) assert.ok(Math.abs(volumeAt(cur, levelAt(cur, v)) - v) < 1e-6 * v + 1e-6);
});
