// Tests for engine/flood.js (lane b15). Targets: plan/P2-targets-draft.json E4-04, E4-05; CONTRACT A7 points 2-3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageAt, extent, handFromDem, param, prepare, rasterisePolygons } from './flood.js';
import { tailwater } from './weir.js';

const CODES = { '0,1': 1, '1,1': 2, '1,0': 4, '1,-1': 8, '0,-1': 16, '-1,-1': 32, '-1,0': 64, '-1,1': 128 };

// D8 steepest descent as in r13's calc_examples.py (neighbour order, strict >, diagonal drop / sqrt 2)
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
function accCells(dem, dir, cols, rows) {
  const off = { 1: [0, 1], 2: [1, 1], 4: [1, 0], 8: [1, -1], 16: [0, -1], 32: [-1, -1], 64: [-1, 0], 128: [-1, 1] };
  const acc = new Float32Array(cols * rows).fill(1);
  const order = [...dem.keys()].sort((a, b) => dem[b] - dem[a]);
  for (const i of order) {
    const o = off[dir[i]];
    if (o) acc[(((i / cols) | 0) + o[0]) * cols + (i % cols) + o[1]] += acc[i];
  }
  return acc;
}
// a grid object in the contract's shape (cell 1 arc-second, origin anywhere)
function mkGrid(dem, cols, rows, { hand, acc, dir } = {}) {
  const cell = 1 / 3600;
  return { name: 'fine', west: 100, north: 0, south: -rows * cell, east: 100 + cols * cell, cols, rows, cell,
    dem: Int16Array.from(dem, (z) => Math.round(z * 10)), dir, acc, hand, lc: null, cellAreaKm2: () => 0.0009 };
}

const TOY = [9, 8, 7, 8, 9, 8, 6, 5, 6, 8, 7, 5, 3, 5, 7, 8, 6, 2, 6, 8, 9, 7, 1, 7, 9];

test('E4-04: HAND of cell (0,0) on the toy valley is 6 m', () => {
  const dir = d8(TOY, 5, 5), acc = accCells(TOY, dir, 5, 5);
  assert.equal(acc[4 * 5 + 2], 25, 'E4-01 by the same D8: outlet collects all 25 cells');
  const hand = handFromDem(TOY, dir, acc, 5, 5, 3);
  assert.ok(Math.abs(hand[0] - 6) <= 0.001, `hand ${hand[0]}`);
});

test('E4-05: 9 cells with HAND <= 2 m, and extent() floods exactly those 9 at stage 2 m', () => {
  const dir = d8(TOY, 5, 5), acc = accCells(TOY, dir, 5, 5);
  const h = handFromDem(TOY, dir, acc, 5, 5, 3);
  assert.equal([...h].filter((v) => v <= 2).length, 9);
  const g = mkGrid(TOY, 5, 5, { dir, acc, hand: Int16Array.from(h, (v) => Math.round(v * 10)) });
  const fp = { min_river_km2: 3, filter: 0, weir_lon: 200, weir_lat: 0 }; // weir off-grid: no pond
  const r = extent({ fine: g }, { grid: 'fine', stage_m: 2, floodParams: fp });
  assert.equal(r.cells, 9);
  for (let i = 0; i < 25; i++) assert.equal(r.mask[i], h[i] <= 2 ? 1 : 0, `cell ${i}`);
  assert.equal(r.depth_dm[22], 20, 'depth on the river = stage');
});

const WP = { tail: { bed_el: 76.8, width_m: 200, side_z: 2, n: 0.035, slope: 0.0004 } }; // test section only

test('stageAt: the weir engine tail level minus flood.ref_tail_el, never negative, null without a rating', () => {
  const fp = { 'flood.ref_tail_el': 78.2, 'flood.stage_max_m': 10 };
  for (const q of [300, 1000, 2200]) {
    const want = Math.max(0, tailwater(q, WP) - 78.2);
    assert.ok(Math.abs(stageAt(q, fp, WP) - want) < 1e-9, `q ${q}`);
  }
  assert.equal(stageAt(50, fp, WP), 0, 'below the reference: no rise');
  assert.equal(stageAt(0, fp, WP), 0);
  assert.equal(stageAt(1000, fp, null), null);
  let prev = -1;
  for (const q of [200, 400, 800, 1600, 2200]) { const s = stageAt(q, fp, WP); assert.ok(s >= prev); prev = s; }
  assert.ok(stageAt(1e7, fp, WP) <= 10);
  // until b18 adds flood.ref_tail_el the flight-day tail level is the reference
  assert.equal(param({ 'weir.tail_flight_el': 78.2 }, 'ref_tail_el'), 78.2);
  assert.equal(param({ flood: { ref_tail_el: { v: 78.0 } } }, 'ref_tail_el'), 78.0);
  assert.equal(param({ flood: { stage_max_m: { v: 10 } } }, 'max_stage_m'), 10);
});

// synthetic valley: 41 x 61 cells, a river down column 20 flowing south, banks rising 0.5 m per cell,
// a closed hollow at (5, 30) that is low but not connected, a weir at row 30 on the river
function valley() {
  const cols = 41, rows = 61, n = cols * rows, dem = new Float64Array(n), dir = new Uint8Array(n);
  const acc = new Float32Array(n), hand = new Int16Array(n);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c, bed = 100 - r * 0.05, dx = Math.abs(c - 20);
    dem[i] = bed + dx * 0.5;
    dir[i] = c < 20 ? 1 : c > 20 ? 16 : (r < rows - 1 ? 4 : 0);
    acc[i] = c === 20 ? 2000 : 1;
    hand[i] = Math.round(dx * 5); // 0.5 m per cell, in dm
  }
  for (let r = 28; r <= 32; r++) for (let c = 3; c <= 7; c++) { // the hollow: HAND tiny, but walled off
    hand[r * cols + c] = 2;
  }
  for (let r = 27; r <= 33; r++) for (const c of [2, 8]) hand[r * cols + c] = 200;
  for (const r of [27, 33]) for (let c = 2; c <= 8; c++) hand[r * cols + c] = 200;
  const g = mkGrid(dem, cols, rows, { dir, acc, hand });
  return { g, cols, rows, fp: { min_river_km2: 1000, filter: 1, weir_lon: 100 + 20.5 / 3600, weir_lat: -30.5 / 3600 } };
}

test('synthetic valley: width grows with the rise, hollow stays dry, depth = rise - HAND, area and volume add up', () => {
  const { g, cols, fp } = valley();
  const G = { fine: g };
  let prevCells = 0;
  for (const s of [0.5, 1, 2, 3, 4]) { // up to 4 m the band stays clear of the hollow's walls
    const r = extent(G, { stage_m: s, stage_up_m: s, floodParams: fp });
    const width = 2 * Math.floor(s / 0.5) + 1;
    assert.equal(r.cells, width * 61, `rise ${s}`);
    assert.ok(r.cells > prevCells); prevCells = r.cells;
    assert.equal(r.mask[30 * cols + 5], 0, 'walled hollow is not connected');
    assert.ok(Math.abs(r.area_km2 - r.cells * 0.0009) < 1e-9);
    assert.equal(r.depth_max_m, s);
    let v = 0; for (let i = 0; i < r.mask.length; i++) if (r.mask[i]) v += r.depth_dm[i] * 0.1 * 0.0009e6;
    assert.ok(Math.abs(v - r.volume_m3) < 1e-6 * v);
  }
  assert.equal(extent(G, { stage_m: 0, stage_up_m: 0, floodParams: fp }).cells, 0, 'a rise of 0 floods nothing');
});

test('each rise floods only its own side of the weir', () => {
  const { g, cols, fp } = valley();
  const G = { fine: g };
  const up = extent(G, { stage_m: 0, stage_up_m: 2, floodParams: fp });
  assert.ok(up.cells > 0 && up.area_down_km2 < 1e-9);
  assert.equal(up.mask[60 * cols + 20], 0);
  assert.equal(up.mask[5 * cols + 22], 1);
  const dn = extent(G, { stage_m: 2, stage_up_m: 0, floodParams: fp });
  assert.ok(dn.cells > 0 && dn.area_up_km2 < 1e-9);
  assert.equal(dn.mask[5 * cols + 22], 0);
  assert.equal(dn.mask[50 * cols + 22], 1);
});

test('the normal river (land cover 80 or the river outline) carries the connection but is never returned', () => {
  const { g, cols, rows, fp } = valley();
  const G = { fine: g };
  g.lc = new Uint8Array(cols * rows).fill(10);
  for (let r = 0; r < rows; r++) for (let c = 19; c <= 21; c++) g.lc[r * cols + c] = 80; // a 3-cell channel
  const r = extent(G, { stage_m: 2, stage_up_m: 2, floodParams: fp });
  assert.equal(r.cells, 6 * 61, 'the 9-cell band minus the 3 river cells');
  for (let row = 0; row < rows; row++) assert.equal(r.mask[row * cols + 20], 0);
  assert.equal(r.depth_dm[30 * cols + 20], 0);
  assert.ok(Math.abs(r.area_km2 - 6 * 61 * 0.0009) < 1e-9);
  // the outline: a polygon over columns 22-23 from prepare()
  const cell = 1 / 3600, x0 = 100 + 22 * cell, x1 = 100 + 24 * cell;
  const poly = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {},
    geometry: { type: 'Polygon', coordinates: [[[x0, 0], [x1, 0], [x1, -rows * cell], [x0, -rows * cell], [x0, 0]]] } }] };
  const ras = rasterisePolygons(g, poly);
  assert.equal(ras.reduce((a, b) => a + b, 0), 2 * rows);
  assert.equal(prepare(G, { grid: 'fine', river_poly: poly }).river_cells, 2 * rows);
  const r2 = extent(G, { stage_m: 2, stage_up_m: 2, floodParams: fp });
  assert.equal(r2.cells, 4 * 61);
  assert.equal(r2.mask[10 * cols + 22], 0);
});

test('a river cell bridges the connection: wet ground beyond a channel-only gap still floods', () => {
  const { g, cols, rows, fp } = valley();
  const G = { fine: g };
  g.lc = new Uint8Array(cols * rows).fill(10);
  // a side channel (water, high HAND) from the river at column 21 out to a low pocket at columns 30-32, row 40
  for (let c = 21; c <= 29; c++) { g.lc[40 * cols + c] = 80; g.dem[40 * cols + c] += 50; }
  for (let c = 30; c <= 32; c++) g.dem[40 * cols + c] = g.dem[40 * cols + 20] + 5; // 0.5 m above the river, D8 to it
  const r = extent(G, { stage_m: 1, stage_up_m: 1, floodParams: { ...fp, filter: 0 } });
  assert.equal(r.mask[40 * cols + 31], 1);
  assert.equal(r.mask[40 * cols + 25], 0, 'the channel itself is not returned');
});

test('majority filter fills a one-cell hole; filter 0 leaves it', () => {
  const { g, cols, fp } = valley();
  const G = { fine: g };
  g.dem[10 * cols + 20 + 6] += 100; // a 10 m knoll: a hole in the wet band at a 4 m rise (width 17)
  const r = extent(G, { stage_m: 4, stage_up_m: 4, floodParams: fp });
  assert.equal(r.mask[10 * cols + 26], 1, 'hole filled');
  const off = extent(G, { stage_m: 4, stage_up_m: 4, floodParams: { ...fp, filter: 0 } });
  assert.equal(off.mask[10 * cols + 26], 0);
});

test('min_depth_m: cells shallower than it are not wet', () => {
  const { g, fp } = valley();
  const a = extent({ fine: g }, { stage_m: 2, stage_up_m: 2, floodParams: fp });
  const b = extent({ fine: g }, { stage_m: 2, stage_up_m: 2, floodParams: { ...fp, min_depth_m: 0.5 } });
  assert.equal(a.cells, 9 * 61);
  assert.equal(b.cells, 7 * 61);
});

test('real fine grid: 0 at rise 0, growing, under 400 ms (skipped without the packs)', async (t) => {
  let G;
  try {
    const { loadPacks } = await import('./node-loader.js');
    G = await loadPacks(['fine'], { layers: ['dem', 'dir', 'acc', 'hand', 'lc'] });
  } catch { G = null; }
  if (!G || !G.fine || !G.fine.hand) { t.skip('fine packs or node-loader missing'); return; }
  assert.equal(extent(G, { stage_m: 0, stage_up_m: 0 }).cells, 0);
  extent(G, { stage_m: 1 }); // first call prepares the grid
  const t0 = performance.now();
  const r = extent(G, { stage_m: 1.8, stage_up_m: 1 });
  const ms = performance.now() - t0;
  assert.ok(ms < 400, `${ms} ms`);
  assert.ok(r.area_km2 > 0 && r.area_km2 < 500, `${r.area_km2} km2`);
  let prev = -1;
  for (const s of [0.25, 0.5, 1, 1.8, 3]) { const a = extent(G, { stage_m: s }).area_km2; assert.ok(a >= prev); prev = a; }
});
