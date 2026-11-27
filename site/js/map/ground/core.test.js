// node --test site/js/map/ground/core.test.js
// The core with made-up tiles: smoothing keeps flat ground and the protected carve exact, a tile that is not on disk
// is made from its ancestor, and a ground tile comes out whole.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore, softPick } from './core.js';
import { lonToTileX, latToTileY, lonToU, latToV } from './dem.js';

const W0 = 104.381, S0 = -4.305; // the weir
const tx = (z) => Math.floor(lonToTileX(W0, z)), ty = (z) => Math.floor(latToTileY(S0, z));
const TJ = {
  minzoom: 12, maxzoom: 12, bounds: [104.3, -4.4, 104.45, -4.2],
  // zoom 13 and 14 on disk only for the weir's own tile (and at 14 its east neighbour)
  manifest: { 13: { x: [tx(13), tx(13)], y: [ty(13), ty(13)] }, 14: { x: [tx(14), tx(14) + 1], y: [ty(14), ty(14)] } },
};
// a trench 10 m deep in flat land at 80 m, between these longitudes (the "carved bed")
const TR = [104.3805, 104.3815];
const height = (u, v) => {
  const lon = u * 360 - 180, lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * v))) * 180) / Math.PI;
  return lon > TR[0] && lon < TR[1] && lat > -4.315 && lat < -4.306 ? 70 : 80; // flat land with the trench (well inside the tile on disk)
};
const CARVE = {
  polygons: { pond: { type: 'Polygon', coordinates: [[[TR[0], -4.315], [TR[1], -4.315], [TR[1], -4.306], [TR[0], -4.306], [TR[0], -4.315]]] } },
  levels_model_m: { weir_pit: 60 },
  axis: { a: [104.38, -4.305], b: [104.382, -4.305] },
};

function fakeIO(fn = height) {
  const calls = { terrain: 0 };
  return {
    calls,
    async terrain(url) {
      calls.terrain++;
      const [z, x, y] = /(\d+)\/(\d+)\/(\d+)/.exec(url).slice(1).map(Number);
      const n = 256, out = new Float32Array(n * n), S = n * 2 ** z;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out[j * n + i] = fn((x * n + i + 0.5) / S, (y * n + j + 0.5) / S);
      out.w = n;
      return out;
    },
    async image() {
      return null;
    },
    async bytes() {
      return null;
    },
    async json(url) {
      if (url.includes('carve.json')) return CARVE;
      throw new Error('not in this test');
    },
  };
}
const make = (io) => createCore(io, { tj: TJ, terrainUrl: 't/{z}/{x}/{y}.png', dataUrl: (p) => 'd/' + p });

test('flat land stays flat, the carved trench keeps its exact bed and banks', async () => {
  const core = make(fakeIO());
  const z = 14, x = tx(14), y = ty(14);
  const d = await core.drawn(z, x, y);
  const raw = await core.raw(z, x, y);
  assert.equal(d.length, 256 * 256);
  let trench = 0;
  for (let j = 0; j < 256; j++) {
    for (let i = 0; i < 256; i++) {
      const p = j * 256 + i, v = (y * 256 + j + 0.5) / (256 * 2 ** z);
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * v))) * 180) / Math.PI;
      if (raw[p] === 70) {
        trench++;
        assert.equal(d[p], 70, 'the bed is not lifted');
      }
      if (raw[p] === 80) assert.ok(Math.abs(d[p] - 80) < 2e-3, `land at ${i},${j} pulled to ${d[p]}`);
    }
  }
  assert.ok(trench > 100, 'the trench is in the tile');
});

test('without the carve outline the trench would be smoothed (the protection matters)', async () => {
  const io = fakeIO();
  io.json = async () => {
    throw new Error('no carve');
  };
  const core = make(io);
  const d = await core.drawn(14, tx(14), ty(14));
  const raw = await core.raw(14, tx(14), ty(14));
  let moved = 0;
  for (let p = 0; p < d.length; p++) if (Math.abs(d[p] - raw[p]) > 0.5) moved++;
  assert.ok(moved > 100);
});

test('a tile not on disk is made from its ancestor with a cubic that keeps a ramp', async () => {
  const ramp = (u, v) => 50 + 1e6 * (u - lonToU(W0)) - 5e5 * (v - latToV(S0));
  const io = fakeIO(ramp);
  const core = make(io);
  const z = 14, x = tx(14) - 3, y = ty(14) + 2; // not on disk: from zoom 12
  const d = await core.drawn(z, x, y);
  const S = 256 * 2 ** z;
  for (const [i, j] of [[0, 0], [128, 64], [255, 255], [17, 200]]) {
    const want = ramp((x * 256 + i + 0.5) / S, (y * 256 + j + 0.5) / S);
    assert.ok(Math.abs(d[j * 256 + i] - want) < 0.02, `${i},${j}: ${d[j * 256 + i]} vs ${want}`);
  }
  assert.equal(await core.drawn(14, 0, 0), null, 'outside the bounds: nothing');
});

test('a ground tile comes out whole and opaque, even with no land cover or rivers to read', async () => {
  const core = make(fakeIO());
  const px = await core.ground(17, tx(17), ty(17));
  assert.equal(px.length, 256 * 256 * 4);
  for (let p = 0; p < 256 * 256; p += 97) assert.equal(px[4 * p + 3], 255);
  assert.equal(await core.ground(13, tx(13), ty(13)), null, 'no ground tile below zoom 14');
});

test('soft class pick: one class stays, the nearest corner wins a tie-free blend', () => {
  assert.equal(softPick(10, 10, 10, 10, 0.3, 0.6, 1, 2, 14), 10);
  assert.equal(softPick(10, 30, 10, 30, 0.02, 0.5, 1, 2, 14), 10);
  assert.equal(softPick(10, 30, 10, 30, 0.98, 0.5, 1, 2, 14), 30);
  assert.equal(softPick(0, 0, 0, 40, 0.1, 0.1, 1, 2, 14), 40, 'no-data corners never win');
});
