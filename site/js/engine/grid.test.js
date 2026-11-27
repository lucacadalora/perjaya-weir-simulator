// Tests for engine/grid.js (lane b11). node --test site/js/engine/grid.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as grid from './grid.js';
import { loadPacks, packsPresent } from './node-loader.js';

const DIR_CODES = { 0: 'no flow (outlet on the box edge, sea)', 1: 'E', 2: 'SE', 4: 'S', 8: 'SW', 16: 'W', 32: 'NW', 64: 'N', 128: 'NE' };
const CODE_OF = { '1,0': 1, '1,1': 2, '0,1': 4, '-1,1': 8, '-1,0': 16, '-1,-1': 32, '0,-1': 64, '1,-1': 128 };

// D8 steepest descent (diagonal drop divided by sqrt 2), as the spec writes it; the outlet cell drains off the box.
function d8FromDem(dem, cols, rows, outlet) {
  const dir = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i === outlet) {
        dir[i] = 4;
        continue;
      }
      let best = 0;
      let code = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nc = c + dx;
          const nr = r + dy;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const drop = (dem[i] - dem[nr * cols + nc]) / (dx && dy ? Math.SQRT2 : 1);
          if (drop > best) {
            best = drop;
            code = CODE_OF[dx + ',' + dy];
          }
        }
      }
      dir[i] = code;
    }
  }
  return dir;
}

// A toy 5x5 valley on the equator: a V across, sloping south to the outlet at the bottom middle.
function toyValley() {
  const cols = 5;
  const rows = 5;
  const dem = new Int16Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) dem[r * cols + c] = 100 * Math.abs(c - 2) + 30 * (rows - 1 - r) + 10;
  const outlet = 4 * cols + 2;
  const cell = 30 / 111319.49; // about 30 m at the equator
  const meta = { name: 'toy', west: 0, north: (rows * cell) / 2, south: (-rows * cell) / 2, east: cols * cell, cols, rows, cellsize_deg: cell, dir_codes: DIR_CODES, nodata: { dem: -32768 } };
  const g = grid.makeGrid(meta, { dem, dir: d8FromDem(dem, cols, rows, outlet) });
  return { g, outlet };
}

test('d8 table is read from the header', () => {
  const t = grid.d8Table(DIR_CODES);
  assert.deepEqual([t.dc[1], t.dr[1]], [1, 0]);
  assert.deepEqual([t.dc[8], t.dr[8]], [-1, 1]);
  assert.deepEqual([t.dc[128], t.dr[128]], [1, -1]);
  assert.equal(t.ok[0], 0);
  // a header with another code table is honoured, not assumed
  const t2 = grid.d8Table({ 1: 'N', 2: 'NE', 3: 'E', 4: 'SE', 5: 'S', 6: 'SW', 7: 'W', 8: 'NW' });
  assert.deepEqual([t2.dc[3], t2.dr[3]], [1, 0]);
  assert.deepEqual([t2.dc[1], t2.dr[1]], [0, -1]);
});

test('E4-01: toy valley, the outlet drains all 25 cells (22,500 m2 at 30 m)', () => {
  const { g, outlet } = toyValley();
  const G = { toy: g };
  const c = grid.catchment(G, { grid: 'toy', idx: outlet });
  assert.equal(c.cells, 25);
  assert.deepEqual(c.bbox, [0, 0, 4, 4]);
  const m2 = (c.area_km2 / g.cellAreaKm2(2)) * 900;
  assert.ok(Math.abs(m2 - 22500) < 22500 * 0.01, 'about 22,500 m2: ' + m2);
  assert.ok(Math.abs(g.cellAreaKm2(2) * 1e6 - 900) < 9, 'a 30 m cell on the equator is about 900 m2 (the meridian degree is shorter)');
  const acc = grid.accumulate(g);
  assert.ok(Math.abs(acc[outlet] - c.area_km2) < 1e-9);
  assert.ok(Math.abs(acc[0] - g.cellAreaKm2(0)) < 1e-6 * acc[0], 'a ridge corner drains only itself');
  const side = grid.catchment(G, { grid: 'toy', idx: 3 * 5 + 2 });
  assert.ok(side.cells < 25 && side.cells >= 1);
});

test('cells, coordinates, elevation and downstream', () => {
  const { g, outlet } = toyValley();
  const p = grid.cellToLonLat(g, 3, 1);
  assert.deepEqual(grid.lonLatToCell(g, p.lon, p.lat), { col: 3, row: 1, idx: 8 });
  assert.equal(grid.lonLatToCell(g, -1, 0), null);
  assert.ok(Math.abs(grid.elevationAt(g, p.lon, p.lat) - g.dem[8] / 10) < 1e-9);
  const q = grid.cellToLonLat(g, 2, 1);
  const mid = grid.elevationAt(g, (p.lon + q.lon) / 2, p.lat);
  assert.ok(Math.abs(mid - (g.dem[7] + g.dem[8]) / 20) < 1e-6, 'bilinear between centres');
  assert.equal(grid.downstream(g, outlet), -1);
  assert.equal(grid.downstream(g, 0), 1, 'the corner flows east, steeper than the diagonal once divided by sqrt 2');
  const tr = grid.traceDownstream({ toy: g }, { grid: 'toy', idx: 0 });
  assert.equal(tr.idx[tr.idx.length - 1], outlet);
  for (let i = 1; i < tr.dist_km.length; i++) assert.ok(tr.dist_km[i] > tr.dist_km[i - 1]);
  assert.ok(Math.abs(tr.dist_km[1] - 0.03) < 0.0005, 'an east step is 30 m');
  const d = tr.dist_km[2] - tr.dist_km[1];
  assert.ok(Math.abs(d - 0.03) < 0.0005 || Math.abs(d - 0.03 * Math.SQRT2) < 0.0005, 'next step 30 m or 30 m x sqrt 2: ' + d);
  const s = grid.snapToStream({ toy: g }, { grid: 'toy', lon: grid.cellToLonLat(g, 0, 4).lon, lat: grid.cellToLonLat(g, 0, 4).lat, min_km2: 0.005, radius_cells: 3 });
  assert.ok(s.ok && s.col === 2, 'snaps to the valley cells: ' + JSON.stringify(s));
});

function outlineCells(g, geo) {
  // signed area of every ring in cell units (outer positive, hole negative in lon/lat)
  let total = 0;
  for (const poly of geo.coordinates) {
    poly.forEach((ring, k) => {
      let s = 0;
      for (let i = 1; i < ring.length; i++) s += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
      s /= 2 * g.cell * g.cell;
      assert.ok(k === 0 ? s > 0 : s < 0, 'outer counter-clockwise, holes clockwise');
      assert.deepEqual(ring[0], ring[ring.length - 1], 'closed ring');
      total += s;
    });
  }
  return total;
}

test('maskOutline: holes, corner-touching cells, exact area', () => {
  const cols = 9;
  const rows = 8;
  const meta = { name: 'm', west: 100, north: 0, south: -8, east: 109, cols, rows, cellsize_deg: 1, dir_codes: DIR_CODES };
  const g = grid.makeGrid(meta, { dem: new Int16Array(cols * rows), dir: new Uint8Array(cols * rows) });
  const mask = new Uint8Array(cols * rows);
  const set = (c, r) => (mask[r * cols + c] = 1);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (!(r === 1 && c === 1) && !(r === 2 && c === 2)) set(c, r);
  set(5, 5);
  set(6, 6); // touches (5,5) only at a corner
  set(8, 0);
  const geo = grid.maskOutline({ m: g }, { grid: 'm', mask });
  assert.equal(geo.type, 'MultiPolygon');
  assert.equal(geo.coordinates.length, 4, 'square + two corner cells + one far cell');
  const big = geo.coordinates[0];
  assert.equal(big.length, 2, 'two hole cells that touch at a corner make one hole (mask 4-connected, outside 8-connected)');
  const count = mask.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(outlineCells(g, geo) - count) < 1e-9);
  assert.equal(big[0].length, 5, 'a square outer ring keeps only its 4 corners');
  const local = grid.maskOutline({ m: g }, { grid: 'm', mask: Uint8Array.from([1, 1, 0, 1]), bbox: [2, 5, 3, 6] });
  assert.equal(local.coordinates.length, 1);
  assert.ok(local.coordinates[0][0].some((p) => p[0] === 102 && p[1] === -5), 'local mask placed at its bbox');
  assert.equal(local.coordinates[0][0].length, 7, 'an L of three cells has 6 corners');
});

const HAVE_WIDE = await packsPresent('wide');
const HAVE_FINE = await packsPresent('fine');

test('real wide grid: the weir catchment within 3 % of the header, under 1.5 s', { skip: !HAVE_WIDE && 'no wide pack' }, async () => {
  const G = await loadPacks(['wide'], { layers: ['dem', 'dir', 'acc'] });
  const g = G.wide;
  const w = g.meta.weir;
  const at = grid.lonLatToCell(g, w.lon, w.lat);
  assert.deepEqual([at.col, at.row], [w.col, w.row]);
  const t0 = performance.now();
  const c = grid.catchment(G, { grid: 'wide', idx: at.idx });
  const ms = performance.now() - t0;
  const err = (c.area_km2 - w.catchment_km2) / w.catchment_km2;
  console.log(`# wide weir catchment ${c.area_km2.toFixed(1)} km2 vs header ${w.catchment_km2} (${(err * 100).toFixed(2)} %), ${c.cells} cells, ${ms.toFixed(0)} ms`);
  assert.ok(Math.abs(err) < 0.03);
  assert.ok(ms < 1500);
  assert.ok(Math.abs(g.acc[at.idx] - c.area_km2) / c.area_km2 < 0.01, 'agrees with the acc pack');
  for (const [k, o] of Object.entries(g.meta.outlets || {})) {
    const oc = grid.catchment(G, { grid: 'wide', idx: o.row * g.cols + o.col });
    assert.ok(Math.abs(oc.area_km2 - o.catchment_km2) / o.catchment_km2 < 0.03, k + ' ' + oc.area_km2);
  }
  const s = grid.snapToStream(G, { grid: 'wide', lon: w.lon + 0.002, lat: w.lat + 0.002, min_km2: 1000, radius_cells: 10 });
  assert.ok(s.ok && s.acc_km2 > 4000, 'a click beside the weir snaps onto the Komering: ' + s.acc_km2);
  const tr = grid.traceDownstream(G, { grid: 'wide', idx: at.idx, max_steps: 200 });
  assert.equal(tr.idx[0], at.idx);
  assert.ok(tr.dist_km[tr.dist_km.length - 1] > 10, 'traces at least 10 km down the river');
  const t1 = performance.now();
  const geo = grid.maskOutline(G, { grid: 'wide', mask: c.mask, bbox: c.bbox, simplify: 1 });
  const exact = grid.maskOutline(G, { grid: 'wide', mask: c.mask, bbox: c.bbox });
  console.log(`# outline ${geo.coordinates.length} polygons, ${geo.coordinates[0][0].length} points simplified, ${(performance.now() - t1).toFixed(0)} ms for both`);
  assert.equal(geo.coordinates.length, 1, 'one catchment polygon');
  assert.ok(Math.abs(outlineCells(g, exact) - c.cells) < 1e-6, 'exact outline encloses exactly the catchment cells');
  assert.ok(geo.coordinates[0][0].length < exact.coordinates[0][0].length / 3);
});

test('real wide grid: accumulate() reproduces the acc pack at the weir', { skip: !HAVE_WIDE && 'no wide pack' }, async () => {
  const G = await loadPacks(['wide'], { layers: ['dem', 'dir', 'acc'] });
  const g = G.wide;
  const t0 = performance.now();
  const acc = grid.accumulate(g);
  const ms = performance.now() - t0;
  const i = g.meta.weir.row * g.cols + g.meta.weir.col;
  console.log(`# accumulate wide ${ms.toFixed(0)} ms, weir ${acc[i].toFixed(1)} km2 vs pack ${g.acc[i].toFixed(1)}`);
  assert.ok(Math.abs(acc[i] - g.acc[i]) / g.acc[i] < 0.01);
});

test('real fine grid loads with land cover; weir cell is on the big river', { skip: !HAVE_FINE && 'no fine pack' }, async () => {
  const G = await loadPacks(['fine']);
  const g = G.fine;
  assert.ok(g.lc && g.hand && g.acc);
  const w = g.meta.weir;
  const at = grid.lonLatToCell(g, w.lon, w.lat);
  assert.deepEqual([at.col, at.row], [w.col, w.row]);
  assert.ok(Math.abs(g.acc[at.idx] - w.catchment_km2) / w.catchment_km2 < 0.03, 'acc at the weir ' + g.acc[at.idx]);
  const el = grid.elevationAt(g, w.lon, w.lat);
  assert.ok(el > 20 && el < 150, 'weir surface elevation is plausible: ' + el);
});
