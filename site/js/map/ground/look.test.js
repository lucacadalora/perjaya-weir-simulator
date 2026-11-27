// node --test site/js/map/ground/look.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { hash2, vnoise, fbm, band, worley, shadeTile, SUN } from './look.js';

test('noise is deterministic and in range', () => {
  for (let i = 0; i < 200; i++) {
    const h = hash2(i * 37 - 500, i * 11 + 3, 7);
    assert.ok(h >= 0 && h < 1);
    assert.equal(h, hash2(i * 37 - 500, i * 11 + 3, 7));
    const v = vnoise(i * 0.37 - 20, i * 0.21, 3);
    assert.ok(v >= -1 && v <= 1);
  }
  const r = worley(12.3, -4.5, 7, 1, new Float64Array(4));
  assert.ok(r[0] >= 0 && r[0] < 7 * 1.5 && r[1] >= 0 && r[1] < 1);
});

test('detail finer than two pixels is left out (the far view is the mean of the near one)', () => {
  assert.equal(fbm(100.3, 200.7, 4, 3, 10, 1), 0);
  assert.notEqual(fbm(100.3, 200.7, 4, 3, 0.5, 1), 0);
  assert.equal(band(1, 1), 0);
  assert.equal(band(5, 1), 1);
});

test('the sun is the scene sun: north-east and high', () => {
  assert.ok(SUN[0] > 0 && SUN[1] > 0 && SUN[2] > 0.8);
  assert.ok(Math.abs(Math.hypot(...SUN) - 1) < 1e-9);
});

function tile({ N = 32, m = 0.6, cls = 30, slope = [0, 0], water = null, hand = 20 } = {}) {
  const H = new Float32Array((N + 2) * (N + 2));
  for (let j = 0; j < N + 2; j++) for (let i = 0; i < N + 2; i++) H[j * (N + 2) + i] = 80 + slope[0] * i * m - slope[1] * j * m;
  const f = { N, m, X0: 1234.5, Y0: -876.25, H, cls: new Uint8Array(N * N).fill(cls), hand: new Float32Array(N * N).fill(hand),
    wat: null, dOut: null, dIn: null, rip: null, yard: null };
  if (water) Object.assign(f, water(N));
  const out = new Uint8ClampedArray(N * N * 4);
  shadeTile(f, out);
  const mean = [0, 0, 0];
  for (let p = 0; p < N * N; p++) for (let c = 0; c < 3; c++) mean[c] += out[4 * p + c] / (N * N);
  return { out, mean };
}

test('flat grass is green, opaque, and the same colour near and far', () => {
  const near = tile({ m: 0.6, N: 64 }), far = tile({ m: 9.5, N: 64 });
  assert.ok(near.mean[1] > near.mean[0] && near.mean[1] > near.mean[2]);
  for (let p = 0; p < 64 * 64; p++) assert.equal(near.out[4 * p + 3], 255);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(near.mean[c] - far.mean[c]) < 14, `channel ${c}: ${near.mean[c]} vs ${far.mean[c]}`);
});

test('a slope facing the sun is lighter than one facing away', () => {
  const toSun = tile({ slope: [-0.3, -0.3] }), away = tile({ slope: [0.3, 0.3] });
  assert.ok(toSun.mean[1] > away.mean[1] + 10);
});

test('trees are darker than grass, a low bank by the water turns to sand, the wet edge is darker still', () => {
  const grass = tile(), trees = tile({ cls: 10 });
  assert.ok(trees.mean[1] < grass.mean[1]);
  const bank = (dist) => (N) => ({ wat: new Uint8Array(N * N), dOut: new Float32Array(N * N).fill(dist), dIn: new Float32Array(N * N) });
  const sand = tile({ hand: 0.3, water: bank(12) });
  assert.ok(sand.mean[0] > grass.mean[0] + 30, 'sand is warmer and lighter than grass');
  const wet = tile({ hand: 0.3, water: bank(0.5) });
  assert.ok(wet.mean[0] < sand.mean[0] - 20, 'the wet band is darker');
  const high = tile({ hand: 8, water: bank(12) });
  assert.ok(Math.abs(high.mean[0] - grass.mean[0]) < 8, 'a high bank keeps its grass');
});

test('riprap shows stone grey where asked', () => {
  const N = 32;
  const rock = tile({ water: () => ({ rip: new Float32Array(N * N).fill(1) }) });
  const spread = Math.max(...rock.mean) - Math.min(...rock.mean);
  assert.ok(spread < 20, 'grey stones: the channels are close together');
});
