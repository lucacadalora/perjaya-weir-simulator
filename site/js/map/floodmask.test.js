// node --test site/js/map/floodmask.test.js (lane w): the flood's water surface for drawing, and its legend colours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floodSurface, FLOOD_STEPS, FLOOD_EDGE, FLOOD_WATER, shadeFlood, paintCells } from './floodmask.js';

// a valley sloping down to the north (row 0): ground rises 0.1 m per row southwards and 1 m per column off the axis
const cols = 20, rows = 20;
const groundAll = new Float32Array(cols * rows);
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) groundAll[r * cols + c] = 50 + 0.1 * r + Math.abs(c - 10);
const mask = new Uint8Array(cols * rows);
const depth = new Int16Array(cols * rows);
for (let r = 2; r < 18; r++) for (let c = 8; c <= 12; c++) {
  mask[r * cols + c] = 1;
  depth[r * cols + c] = Math.round((3 - Math.abs(c - 10)) * 10); // 3 m in the middle, 1 m at the edge
}
const box = [4, 0, 16, 19];
const w = box[2] - box[0] + 1, h = box[3] - box[1] + 1;
const ground = new Float32Array(w * h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ground[y * w + x] = groundAll[(box[1] + y) * cols + box[0] + x];

test('wet cells: surface = ground + depth; the ring carries it past the edge; the rest lies under the ground', () => {
  const fs = floodSurface({ mask, depth_dm: depth, cols, ground, box, ring: 2 });
  assert.equal(fs.w, w);
  const at = (c, r) => (r - box[1]) * w + (c - box[0]);
  assert.ok(Math.abs(fs.surface[at(10, 5)] - (50 + 0.5 + 3)) < 1e-6);
  assert.equal(fs.mask[at(10, 5)], 255);
  // ring: two cells past the wet edge (cols 6, 7 and 13, 14) are drawn, with the neighbours' surface
  for (const c of [6, 7, 13, 14]) assert.equal(fs.mask[at(c, 9)], 255, 'ring at col ' + c);
  assert.equal(fs.mask[at(5, 9)], 0, 'nothing beyond the ring');
  assert.ok(fs.surface[at(5, 9)] < ground[at(5, 9)], 'cells never drawn lie under the ground');
  assert.ok(Math.abs(fs.surface[at(7, 9)] - fs.surface[at(8, 9)]) < 1.5, 'the ring continues the water surface');
  // the terrain then cuts it: the ring's surface is below the dry ground two cells out
  assert.ok(fs.surface[at(6, 9)] < ground[at(6, 9)], 'the terrain, not the mask, ends the water');
});

test('the current runs down the water surface (north here), and is still where the water is flat', () => {
  const fs = floodSurface({ mask, depth_dm: depth, cols, ground, box, ring: 2 });
  const i = ((9 - box[1]) * w + (10 - box[0])) * 4;
  const east = fs.flow[i] / 127.5 - 1;
  const south = fs.flow[i + 1] / 127.5 - 1;
  assert.ok(south < -0.9 && Math.abs(east) < 0.2, 'flows north, down the valley');
  assert.equal(fs.flow[i + 2], 255);
  const flat = floodSurface({ mask, depth_dm: null, cols, ground: new Float32Array(w * h).fill(10), box, ring: 1 });
  assert.equal(flat.flow[i + 2], 0, 'level water does not drift');
  assert.equal(flat.surface[(9 - box[1]) * w + (10 - box[0])], 10.5, 'no depth known: half a metre');
});

test('legend colours are the river flood look, the line round it light; edge-only drape has no fill', () => {
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  assert.ok(lum(FLOOD_STEPS[0].rgb) > lum(FLOOD_STEPS[1].rgb) && lum(FLOOD_STEPS[1].rgb) > lum(FLOOD_STEPS[2].rgb), 'deeper is darker');
  for (const s of FLOOD_STEPS) assert.ok(s.rgb[0] > s.rgb[2], s.id + ' is brown');
  assert.ok(lum(FLOOD_EDGE.rgb) > lum(FLOOD_STEPS[0].rgb), 'the edge line is lighter than the water');
  const p = paintCells({ mask, depth, cols, rows, box: [8, 2, 12, 17] });
  const full = shadeFlood(p, 2);
  const line = shadeFlood(p, 2, undefined, false);
  let a = 0, b = 0;
  for (let k = 3; k < full.px.length; k += 4) (a += full.px[k] > 0), (b += line.px[k] > 0);
  assert.ok(b > 0 && b < a / 2, 'only the line is left');
  assert.ok(FLOOD_WATER.ring >= 2);
});

test('the flood water carries on over the normal river channel (left out of the extent), not over dry land', () => {
  // a channel at col 2..3 (ground 48, below the flood surface) joined to the wet band only through dry ground
  const g2 = Float32Array.from(groundAll);
  for (let r = 0; r < rows; r++) for (const c of [2, 3]) g2[r * cols + c] = 48;
  const b = [0, 0, 19, 19];
  const fs = floodSurface({ mask, depth_dm: depth, cols, ground: g2, box: b, ring: 3, under: 10 });
  assert.equal(fs.mask[9 * cols + 5], 255, 'the ring reaches col 5');
  assert.equal(fs.mask[9 * cols + 3], 0, 'col 4 is dry ground above the water: the channel beyond is not reached');
  // now a low channel right next to the band (cols 4..7 at 48)
  for (let r = 0; r < rows; r++) for (const c of [4, 5, 6, 7]) g2[r * cols + c] = 48;
  const fs2 = floodSurface({ mask, depth_dm: depth, cols, ground: g2, box: b, ring: 3, under: 10 });
  assert.equal(fs2.mask[9 * cols + 2], 255, 'the channel under the flood surface is water all the way across');
  assert.equal(fs2.mask[9 * cols + 0], 0, 'and no further than the ground under it');
});
