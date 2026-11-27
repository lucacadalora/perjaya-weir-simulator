// node --test site/js/map/water/ (lane b06): the pure mask helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cropMask, maskBytes, rasterPolygons, channelMask, splitByAxis, riverFloor, bboxDegrees } from './masks.js';

const meta = { west: 100, north: 0, cols: 10, rows: 10, cellsize_deg: 0.1 };

test('cropMask takes a full-grid mask or a bbox-sized one', () => {
  const full = new Uint8Array(100);
  full[2 * 10 + 3] = 1;
  const c = cropMask(full, meta, [3, 2, 5, 4]);
  assert.equal(c.length, 9);
  assert.equal(c[0], 1);
  const own = new Uint8Array(9);
  assert.equal(cropMask(own, meta, [3, 2, 5, 4]), own);
  assert.equal(cropMask(new Uint8Array(7), meta, [3, 2, 5, 4]), null);
});

test('maskBytes never moves a cell to the other side of 0.5', () => {
  const m = new Uint8Array(25);
  m[12] = 1; // a lone wet cell
  const b = maskBytes(m, null, 5);
  assert.ok(b[12] > 127);
  for (let i = 0; i < 25; i++) if (i !== 12) assert.ok(b[i] < 128);
});

test('rasterPolygons fills by cell centre', () => {
  const sq = [[[100.12, -0.12], [100.38, -0.12], [100.38, -0.38], [100.12, -0.38], [100.12, -0.12]]];
  const m = rasterPolygons([sq], meta, [0, 0, 9, 9]);
  assert.equal(m.reduce((a, x) => a + x, 0), 9); // cells 1..3 by 1..3
  assert.equal(m[2 * 10 + 2], 1);
  assert.equal(m[4 * 10 + 4], 0);
});

test('channelMask grows only to low ground and splitByAxis puts south on side a for an east-west axis', () => {
  const g = new Float32Array(100).fill(10);
  for (let r = 0; r < 10; r++) g[r * 10 + 4] = g[r * 10 + 5] = 1;
  const seeds = new Uint8Array(100);
  for (let r = 0; r < 10; r++) seeds[r * 10 + 4] = 1;
  const ch = channelMask(g, 10, 10, seeds, { rise_m: 2, max_steps: 3 });
  assert.equal(ch.reduce((a, x) => a + x, 0), 20);
  const { a, b } = splitByAxis(ch, 10, 10, 5, 5, 90, 0);
  assert.equal(a[8 * 10 + 4], 1); // row 8 is south of row 5
  assert.equal(b[1 * 10 + 4], 1);
  const f = riverFloor(g, 10, 10, ch);
  assert.equal(f[3 * 10 + 4], 1);
  assert.equal(f[3 * 10 + 6], 1); // spread beside the channel, not the bank's 10 m
});

test('bboxDegrees', () => {
  const d = bboxDegrees(meta, [1, 2, 3, 4]);
  assert.ok(Math.abs(d.west - 100.1) < 1e-9 && Math.abs(d.east - 100.4) < 1e-9);
  assert.ok(Math.abs(d.north + 0.2) < 1e-9 && Math.abs(d.south + 0.5) < 1e-9);
});

import { dilate, polygonsOf, polygonsBox } from './masks.js';
test('dilate grows by the radius and polygonsOf reads GeoJSON shapes', () => {
  const m = new Uint8Array(121);
  m[60] = 1;
  const d = dilate(m, 11, 11, 3);
  assert.equal(d[60 + 3], 1);
  assert.equal(d[60 + 4], 0);
  const ring = [[0, 0], [1, 0], [1, 1], [0, 0]];
  assert.equal(polygonsOf({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } }).length, 1);
  assert.equal(polygonsOf({ type: 'MultiPolygon', coordinates: [[ring], [ring]] }).length, 2);
  assert.equal(polygonsOf(ring).length, 1);
  assert.deepEqual(polygonsBox(polygonsOf(ring)), [0, 0, 1, 1]);
});
