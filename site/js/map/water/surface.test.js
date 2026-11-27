// node --test site/js/map/water/surface.test.js (lane w): the river's colour follows its flow; the ground under a
// sheet is spread and fitted where the water is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turbidityFor, riverLook, TURBIDITY } from './surface.js';
import { RIVER, WATER } from './palette.js';
import { spreadGround, nearMask } from './sheet.js';

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const close = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

test('turbidity: clear at low flow, normal near an ordinary flow, flood at a big one, never outside 0..1', () => {
  assert.equal(turbidityFor(null), null);
  assert.equal(turbidityFor(NaN), null);
  assert.equal(turbidityFor(0), 0);
  assert.equal(turbidityFor(35), 0, 'the maintenance flow looks clear');
  assert.ok(Math.abs(turbidityFor(250) - TURBIDITY.normal_at) < 0.03, 'about 250 m3/s is the normal look');
  assert.equal(turbidityFor(1984), 1, 'the design flood is the flood look');
  let last = -1;
  for (let q = 1; q < 5000; q *= 1.3) {
    const t = turbidityFor(q);
    assert.ok(t >= last && t >= 0 && t <= 1, 'rises with the flow');
    last = t;
  }
});

test('riverLook hits the palette at its three stops and mixes between them', () => {
  const c = riverLook(0);
  const n = riverLook(TURBIDITY.normal_at);
  const f = riverLook(1);
  for (const k of ['shallow', 'body', 'deep']) {
    assert.ok(close(c[k], hex(RIVER.clear[k])), 'clear ' + k);
    assert.ok(close(n[k], hex(RIVER.normal[k])), 'normal ' + k);
    assert.ok(close(f[k], hex(RIVER.flood[k])), 'flood ' + k);
  }
  assert.ok(Math.abs(c.see_m - RIVER.clear.see_m) < 1e-9 && Math.abs(f.see_m - RIVER.flood.see_m) < 1e-9);
  // the bed fades from view as the mud comes; the water darkens towards the flood; shallows are lighter than deep
  let see = Infinity;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const L = riverLook(t);
    assert.ok(L.see_m <= see + 1e-12, 'see_m never grows with the mud');
    see = L.see_m;
    assert.ok(lum(L.shallow) > lum(L.body) && lum(L.body) > lum(L.deep), 'shallow > body > deep at t=' + t.toFixed(2));
  }
  assert.ok(lum(f.body) < lum(n.body), 'a flood is darker than the normal river');
  assert.ok(c.body[1] > c.body[0], 'low flow is green');
  assert.ok(n.body[0] > n.body[2] && f.body[0] > f.body[2], 'normal and flood are brown');
  assert.deepEqual(riverLook(NaN).body, n.body, 'no flow known: the normal look');
});

test('the blue map family of A8 is still there for map symbols', () => {
  for (const k of ['shallow', 'body', 'deep', 'foam', 'shore']) assert.match(WATER[k], /^#[0-9a-f]{6}$/);
  for (const k of ['bed', 'bank', 'foam', 'floodFoam', 'map']) assert.match(RIVER[k], /^#[0-9a-f]{6}$/);
});

test('spreadGround matches the grid at cell centres and is bilinear between them', () => {
  const g = Float32Array.from([0, 3, 6, 9]); // 2 x 2
  const s = spreadGround(g, 2, 2, 6, 6); // 3 texels per cell
  assert.equal(s[1 * 6 + 1], 0, 'centre of cell (0,0)');
  assert.equal(s[4 * 6 + 4], 9, 'centre of cell (1,1)');
  assert.ok(Math.abs(s[1 * 6 + 2] - 1) < 1e-6, 'a third of the way east');
  assert.equal(s[0], 0, 'clamped at the edge');
  const one = spreadGround(Float32Array.from([5]), 1, 1, 3, 3);
  assert.ok(one.every((v) => v === 5));
});

test('nearMask marks the mask and two cells round it, nothing further', () => {
  const W = 9, H = 9;
  const m = new Uint8Array(W * H);
  m[4 * W + 4] = 255;
  const n = nearMask(m, W, H, 2);
  assert.equal(n.reduce((a, x) => a + x, 0), 25);
  assert.equal(n[2 * W + 2], 1);
  assert.equal(n[1 * W + 4], 0);
});
