// node --test site/js/map/ground/dem.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tileAvailability, decodeTerrariumRGBA, encodeTerrariumRGBA, tentKernel, smoothPatch, resampleCR, childPositions,
  assemblePatch, fillRings, strokeLine, chamfer, dilate, mpp, NATIVE_M,
} from './dem.js';

const TJ = {
  minzoom: 6, maxzoom: 13, bounds: [103.3, -5.2, 105.0, -3.5],
  manifest: { 13: { x: [6467, 6475], y: [4189, 4198] }, 14: { x: [12934, 12950], y: [8378, 8397] } },
};

test('availability: zoom 14 on disk only in the fine box, every tile in the bounds can be drawn', () => {
  const a = tileAvailability(TJ);
  assert.equal(a.maxzoom, 14);
  assert.ok(a.has(14, 12942, 8388));
  assert.ok(!a.has(14, 12919, 8402)); // the dam site, outside the fine box
  assert.ok(a.inBounds(14, 12919, 8402));
  assert.ok(a.has(12, 3235, 2097));
  assert.ok(!a.inBounds(14, 0, 0));
  assert.ok(!a.inBounds(15, 25884, 16776)); // deeper than the deepest zoom
});

test('Terrarium encode and decode agree to 1/256 m', () => {
  const h = Float32Array.from([0, 68.8, 76.5, 235.004, -3.25, 1000.1]);
  const back = decodeTerrariumRGBA(encodeTerrariumRGBA(h, h.length), h.length);
  for (let i = 0; i < h.length; i++) assert.ok(Math.abs(back[i] - h[i]) <= 1 / 256 + 1e-6, `${h[i]} -> ${back[i]}`);
});

test('tent one native cell wide: three pixels each side at zoom 14, identity when the pixel is coarser', () => {
  const k = tentKernel(NATIVE_M / mpp(14, -4.3));
  assert.equal(k.R, 4 - 1);
  assert.ok(k.w[0] > 0 && k.w[0] < 0.1 && k.w[3] === 1 && k.w[2] === k.w[4]);
  const id = tentKernel(0.8);
  assert.equal(id.R, 1);
  assert.deepEqual([...id.w], [0, 1, 0]);
});

const field = (W, H, f) => {
  const a = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a[y * W + x] = f(x, y);
  return a;
};

test('smoothing keeps flat ground flat and a plane a plane', () => {
  const k = tentKernel(3.15), W = 40, H = 40;
  const flat = smoothPatch(field(W, H, () => 76.5), W, H, k);
  assert.ok(flat.every((v) => Math.abs(v - 76.5) < 1e-4));
  const plane = smoothPatch(field(W, H, (x, y) => 0.3 * x - 0.2 * y + 50), W, H, k);
  const iw = W - 2 * k.R;
  for (let y = 0; y < H - 2 * k.R; y++)
    for (let x = 0; x < iw; x++) assert.ok(Math.abs(plane[y * iw + x] - (0.3 * (x + k.R) - 0.2 * (y + k.R) + 50)) < 1e-3);
});

test('smoothing rounds a 30 m crease', () => {
  const k = tentKernel(3), W = 30, H = 9;
  const v = field(W, H, (x) => Math.abs(x - 15) * 1.0); // a V-shaped valley, crease at x = 15
  const s = smoothPatch(v, W, H, k);
  const iw = W - 2 * k.R;
  const at = (x) => s[1 * iw + x - k.R];
  assert.ok(at(15) > 0.5, 'the crease is lifted'); // tent * |x| at the kink = 1 (the mean distance)
  assert.ok(Math.abs(at(25) - 10) < 1e-4, 'away from the crease the slope is untouched');
});

test('protected pixels keep their height and do not pull their neighbours', () => {
  const k = tentKernel(3), W = 30, H = 30;
  // land at 80 m, a carved trough (x 12..17) at 70 m
  const src = field(W, H, (x) => (x >= 12 && x <= 17 ? 70 : 80));
  const prot = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 12; x <= 17; x++) prot[y * W + x] = 1;
  const s = smoothPatch(src, W, H, k, prot);
  const iw = W - 2 * k.R;
  for (let y = 0; y < H - 2 * k.R; y++) {
    for (let x = 0; x < iw; x++) {
      const gx = x + k.R;
      const want = gx >= 12 && gx <= 17 ? 70 : 80;
      assert.ok(Math.abs(s[y * iw + x] - want) < 1e-4, `x ${gx}: ${s[y * iw + x]}`);
    }
  }
  // without protection the bank next to the trough is pulled down
  const u = smoothPatch(src, W, H, k);
  assert.ok(u[5 * iw + 11 - k.R] < 79);
});

test('Catmull-Rom passes through the samples and keeps a ramp', () => {
  const W = 8, H = 8;
  const src = field(W, H, (x, y) => 3 * x + 2 * y + ((x * 7 + y * 3) % 5));
  const xs = Float64Array.from([2, 3, 4]), ys = Float64Array.from([2, 5]);
  const out = resampleCR(src, W, H, xs, ys);
  assert.equal(out[0], src[2 * W + 2]);
  assert.equal(out[5], src[5 * W + 4]);
  const ramp = field(W, H, (x, y) => 3 * x + 2 * y);
  const r = resampleCR(ramp, W, H, Float64Array.from([2.25, 3.5]), Float64Array.from([4.75]));
  assert.ok(Math.abs(r[0] - (3 * 2.25 + 2 * 4.75)) < 1e-4 && Math.abs(r[1] - (3 * 3.5 + 2 * 4.75)) < 1e-4);
});

test('child pixel centres in the ancestor patch', () => {
  // zoom 14 tile (2,3) inside zoom 13 tile (1,1), patch margin 2: the first child pixel centre is at 0.25 - 0.5 + 2
  const { xs, ys } = childPositions(14, 2, 3, 13, 1, 1, 2, 0, 4);
  assert.equal(xs[0], (0 * 4 + 0 + 0.5) / 2 - 0.5 + 2);
  assert.equal(ys[0], (3 * 4 + 0.5) / 2 - 4 - 0.5 + 2);
  assert.equal(xs.length, 4);
});

test('a patch from nine tiles, missing neighbours repeat the edge', () => {
  const S = 4;
  const t = (v) => new Float32Array(S * S).fill(v);
  const tiles = [t(1), t(2), t(3), t(4), t(5), null, t(7), t(8), t(9)];
  const p = assemblePatch(tiles, 1, S);
  const P = S + 2;
  assert.equal(p[0], 1);
  assert.equal(p[1], 2);
  assert.equal(p[P + 1], 5);
  assert.equal(p[P + P - 1], 5, 'the missing east neighbour repeats the centre tile');
  assert.equal(assemblePatch([null, null, null, null, null, null, null, null, null], 1, S), null);
});

test('polygon fill by parity, with a hole', () => {
  const W = 10, H = 10, mask = new Uint8Array(W * H);
  const n = fillRings(mask, W, H, [[1, 1, 9, 1, 9, 9, 1, 9], [4, 4, 6, 4, 6, 6, 4, 6]]);
  assert.equal(n, 64 - 4);
  assert.equal(mask[5 * W + 5], 0);
  assert.equal(mask[2 * W + 2], 1);
});

test('thick line and distance', () => {
  const W = 21, H = 21, mask = new Uint8Array(W * H);
  strokeLine(mask, W, H, [0, 10.5, 21, 10.5], 1.5);
  assert.equal(mask[10 * W + 5], 1);
  assert.equal(mask[12 * W + 5], 0);
  const d = chamfer(mask, W, H, (v) => v === 1, 50);
  assert.equal(d[10 * W + 5], 0);
  assert.ok(Math.abs(d[16 * W + 5] - 5) < 1e-6, 'straight down: exact');
  const one = new Uint8Array(W * H);
  one[10 * W + 10] = 1;
  const e = chamfer(one, W, H, (v) => v === 1, 50);
  assert.ok(Math.abs(e[16 * W + 16] - 6 * Math.SQRT2) / (6 * Math.SQRT2) < 0.1, 'diagonal within 10 %');
  const g = dilate(one, W, H);
  assert.equal(g.reduce((s, v) => s + v, 0), 9);
});
