// impact.test.js (lane b16): hand-countable cases, a brute-force check, and a timing run on the real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as impact from './impact.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', '..', 'data');
const RAD = Math.PI / 180;
const R = 6371008.8;

function makeGrid(name, west, north, cols, rows, cell, lcFill = 40) {
  const lc = new Uint8Array(cols * rows).fill(lcFill);
  return { name, west, north, east: west + cols * cell, south: north - rows * cell, cols, rows, cell, lc,
    cellAreaKm2: (row) => { const lat = north - (row + 0.5) * cell; const w = cell * RAD * R; return w * w * Math.cos(lat * RAD) / 1e6; } };
}

/** Pack buildings [[lon, lat, m2], ...] the way buildings.bin is packed: sorted by zoom-12 tile key. */
function packBuildings(list) {
  const keyed = list.map((b) => ({ b, k: impact.tileKey(b[0], b[1]) })).sort((x, y) => x.k - y.k);
  const data = new Float32Array(keyed.length * 3);
  const index = {};
  keyed.forEach(({ b, k }, i) => {
    data.set(b, i * 3);
    if (!index[k]) index[k] = [i, 0];
    index[k][1]++;
  });
  return { bin: data.buffer, meta: { index } };
}

function blockMask(g, c0, c1, r0, r1) {
  const m = new Uint8Array(g.cols * g.rows);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) m[r * g.cols + c] = 1;
  return m;
}

const centre = (g, c, r) => [g.west + (c + 0.5) * g.cell, g.north - (r + 0.5) * g.cell];
const line = (coords, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });
const fc = (features) => ({ type: 'FeatureCollection', features });

test('hand count: 4 of 7 buildings, footprint, land cover, cells', () => {
  const g = makeGrid('fine', 104.0, -4.0, 10, 10, 0.01);
  g.lc[4 * 10 + 3] = 50; // one built-up cell inside the mask
  const G = { fine: g };
  const mask = blockMask(g, 2, 4, 3, 5); // 3 x 3 = 9 cells
  const inside = [[2, 3, 100], [3, 4, 200], [4, 5, 300], [4, 3, 400]];
  const outside = [[1, 3, 1000], [5, 4, 1000], [3, 6, 1000]];
  const list = [...inside, ...outside].map(([c, r, a]) => [...centre(g, c, r), a]);
  impact.prepare(G, { buildings: packBuildings(list) });
  const res = impact.count(G, { grid: 'fine', mask });
  assert.equal(res.buildings, 4);
  assert.equal(res.footprint_m2, 1000);
  assert.equal(res.points.length, 8);
  assert.equal(res.cells, 9);
  let km2 = 0, k50 = g.cellAreaKm2(4);
  for (let r = 3; r <= 5; r++) km2 += 3 * g.cellAreaKm2(r);
  assert.ok(Math.abs(res.area_ha - km2 * 100) < 0.01);
  assert.ok(Math.abs(res.lc_ha[50] - k50 * 100) < 0.01);
  assert.ok(Math.abs(res.lc_ha[40] - (km2 - k50) * 100) < 0.01);
});

test('min depth: shallow cells do not count', () => {
  const g = makeGrid('fine', 104.0, -4.0, 10, 10, 0.01);
  const G = { fine: g };
  const mask = blockMask(g, 2, 4, 3, 5);
  const depth = new Int16Array(100).fill(1);
  depth[4 * 10 + 3] = 5; // only the centre cell is 0.5 m deep
  impact.prepare(G, { buildings: packBuildings([[...centre(g, 3, 4), 50], [...centre(g, 2, 3), 70]]) });
  const res = impact.count(G, { grid: 'fine', mask, depth_dm: depth, min_depth_m: 0.3 });
  assert.equal(res.buildings, 1);
  assert.equal(res.footprint_m2, 50);
  assert.equal(res.cells, 1);
});

test('points are capped and thinned evenly', () => {
  const g = makeGrid('fine', 104.0, -4.0, 10, 10, 0.01);
  const G = { fine: g };
  const list = [];
  for (let i = 0; i < 30; i++) list.push([104.025 + i * 0.0005, -4.045, 10]);
  impact.prepare(G, { buildings: packBuildings(list) });
  const res = impact.count(G, { grid: 'fine', mask: blockMask(g, 0, 9, 0, 9), max_points: 10 });
  assert.equal(res.buildings, 30);
  assert.equal(res.points_total, 30);
  assert.equal(res.points.length, 20);
  const big = impact.count(G, { grid: 'fine', mask: blockMask(g, 0, 9, 0, 9), max_points: 1e9 });
  assert.equal(big.points.length, 60); // never above the hard cap, never above the count
});

test('dry mask, missing layers and missing mask give zeros, not errors', () => {
  const g = makeGrid('fine', 104.0, -4.0, 10, 10, 0.01);
  const G = { fine: g };
  impact.reset();
  const dry = new Uint8Array(100);
  assert.equal(impact.count(G, { grid: 'fine', mask: dry }).buildings, 0);
  const wet = blockMask(g, 2, 4, 3, 5);
  assert.equal(impact.count(G, { grid: 'fine', mask: wet }).buildings, 0);
  assert.equal(impact.count(G, { grid: 'fine', mask: wet }).cells, 9);
  assert.equal(impact.lines(G, { grid: 'fine', mask: wet }).roads_km, 0);
  assert.deepEqual(impact.places(G, { grid: 'fine', mask: wet }), []);
  assert.equal(impact.count(G, { grid: 'fine' }).buildings, 0);
});

test('hand count lines: road across 3 wet cells, rail with a bridge over the middle cell', () => {
  const g = makeGrid('fine', 104.0, -4.0, 10, 10, 0.01);
  const G = { fine: g };
  const mask = blockMask(g, 2, 4, 3, 5);
  const lat = -4.045;
  const roads = fc([line([[104.0, lat], [104.1, lat]], { class: 'primary', name: 'Jalan Uji' })]);
  const rail = fc([
    line([[104.035, -4.0], [104.035, -4.1]], { class: 'standard_gauge' }),
    line([[104.035, -4.041], [104.035, -4.049]], { class: 'standard_gauge', bridge: true }),
  ]);
  impact.prepare(G, { roads_fine: roads, rail });
  const res = impact.lines(G, { grid: 'fine', mask });
  const roadKm = 0.03 * RAD * R * Math.cos(lat * RAD) / 1000;
  const railKm = 0.02 * RAD * R / 1000;
  assert.ok(Math.abs(res.roads_km - roadKm) < 0.002, `${res.roads_km} vs ${roadKm}`);
  assert.ok(Math.abs(res.rail_km - railKm) < 0.002, `${res.rail_km} vs ${railKm}`);
  assert.ok(Math.abs(res.by_class.road.primary - roadKm) < 0.002);
  const roadsGj = res.geojson.features.filter((f) => f.properties.kind === 'road');
  const railGj = res.geojson.features.filter((f) => f.properties.kind === 'rail');
  assert.equal(roadsGj.length, 1);
  assert.equal(railGj.length, 2); // split by the bridge
  const cs = roadsGj[0].geometry.coordinates;
  assert.ok(Math.abs(cs[0][0] - 104.02) < 1e-6 && Math.abs(cs[cs.length - 1][0] - 104.05) < 1e-6);
  assert.equal(roadsGj[0].properties.name, 'Jalan Uji');
  // features override, and the wide grid falls back to the only road layer it has
  const ov = impact.lines(G, { grid: 'fine', mask, features: { roads } });
  assert.equal(ov.rail_km, 0);
  assert.ok(Math.abs(ov.roads_km - roadKm) < 0.002);
});

test('hand count places: inside, within the buffer, outside it', () => {
  const g = makeGrid('fine', 104.0, -4.0, 10, 10, 0.01);
  const G = { fine: g };
  const mask = blockMask(g, 2, 4, 3, 5);
  const pt = (name, kind, c, r, population) => ({ type: 'Feature', properties: { name, kind, population },
    geometry: { type: 'Point', coordinates: centre(g, c, r) } });
  impact.prepare(G, { places: fc([pt('Desa Dalam', 'village', 3, 4), pt('Kota Dekat', 'town', 6, 4, 5000),
    pt('Jauh', 'village', 9, 9), pt(null, 'hamlet', 3, 3)]) });
  assert.deepEqual(impact.places(G, { grid: 'fine', mask }).map((p) => p.name), ['Desa Dalam']);
  assert.deepEqual(impact.places(G, { grid: 'fine', mask, buffer_cells: 1 }).map((p) => p.name), ['Desa Dalam']);
  const two = impact.places(G, { grid: 'fine', mask, buffer_cells: 2 });
  assert.deepEqual(two.map((p) => [p.name, p.inside]), [['Desa Dalam', true], ['Kota Dekat', false]]);
});

// ---------- brute force ----------

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function bruteCount(g, mask, data) {
  let n = 0, foot = 0;
  for (let b = 0; b < data.length / 3; b++) {
    const c = Math.floor((data[b * 3] - g.west) / g.cell), r = Math.floor((g.north - data[b * 3 + 1]) / g.cell);
    if (c < 0 || c >= g.cols || r < 0 || r >= g.rows || !mask[r * g.cols + c]) continue;
    n++; foot += data[b * 3 + 2];
  }
  return { n, foot: Math.round(foot) };
}

function bruteLineKm(g, mask, fcol) {
  let m = 0; const N = 400; // dense sampling, independent of the engine's step
  for (const f of fcol.features) {
    if (f.properties.bridge) continue;
    const cs = f.geometry.coordinates;
    for (let i = 0; i + 1 < cs.length; i++) {
      const [x0, y0] = cs[i], [x1, y1] = cs[i + 1];
      const segM = Math.hypot((x1 - x0) * Math.cos((y0 + y1) / 2 * RAD), y1 - y0) * RAD * R;
      for (let j = 0; j < N; j++) {
        const t = (j + 0.5) / N, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
        const c = Math.floor((x - g.west) / g.cell), r = Math.floor((g.north - y) / g.cell);
        if (c >= 0 && c < g.cols && r >= 0 && r < g.rows && mask[r * g.cols + c]) m += segM / N;
      }
    }
  }
  return m / 1000;
}

test('brute force: random blobs, 20,000 buildings over many tiles', () => {
  const g = makeGrid('wide', 104.0, -4.0, 120, 100, 0.01); // 1.2 x 1.0 degrees, about 14 x 12 tiles
  const G = { wide: g };
  const rand = rng(7);
  const mask = new Uint8Array(g.cols * g.rows);
  for (let k = 0; k < 12; k++) {
    const cc = rand() * g.cols, rc = rand() * g.rows, rad = 3 + rand() * 12;
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) if ((c - cc) ** 2 + (r - rc) ** 2 < rad * rad) mask[r * g.cols + c] = 1;
  }
  const list = [];
  for (let i = 0; i < 20000; i++) list.push([104.0 + rand() * 1.2, -4.0 - rand() * 1.0, Math.round(20 + rand() * 300)]);
  const packed = packBuildings(list);
  const roads = fc(Array.from({ length: 40 }, () => line(Array.from({ length: 6 }, () => [104 + rand() * 1.2, -4 - rand()]), { class: 'tertiary' })));
  impact.prepare(G, { buildings: packed, roads });
  const res = impact.count(G, { grid: 'wide', mask, max_points: 20000 });
  const bf = bruteCount(g, mask, new Float32Array(packed.bin));
  assert.ok(bf.n > 500, `blobs too small: ${bf.n}`);
  assert.equal(res.buildings, bf.n);
  assert.ok(Math.abs(res.footprint_m2 - bf.foot) <= 1);
  const ln = impact.lines(G, { grid: 'wide', mask });
  const bk = bruteLineKm(g, mask, roads);
  assert.ok(bk > 5);
  assert.ok(Math.abs(ln.roads_km - bk) / bk < 0.02, `${ln.roads_km} vs ${bk}`);
});

// ---------- the real data ----------

function loadFine() {
  const p = (f) => path.join(DATA, f);
  const need = ['grid/fine.json', 'grid/fine.hand.i16', 'grid/fine.lc.u8', 'feat/buildings.bin', 'feat/buildings.json'];
  if (!need.every((f) => fs.existsSync(p(f)))) return null;
  const h = JSON.parse(fs.readFileSync(p('grid/fine.json'), 'utf8'));
  const g = makeGrid('fine', h.west, h.north, h.cols, h.rows, h.cellsize_deg);
  const lcb = fs.readFileSync(p('grid/fine.lc.u8'));
  g.lc = new Uint8Array(lcb.buffer, lcb.byteOffset, lcb.byteLength);
  const hb = fs.readFileSync(p('grid/fine.hand.i16'));
  const hand = new Int16Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.byteLength));
  return { g, hand, bin: fs.readFileSync(p('feat/buildings.bin')), meta: JSON.parse(fs.readFileSync(p('feat/buildings.json'), 'utf8')) };
}

test('real data: fine box, cells under 3 m above drainage, under 200 ms and equal to brute force', (t) => {
  const D = loadFine();
  if (!D) { t.skip('real data not on disk'); return; }
  const { g, hand, bin, meta } = D;
  const G = { fine: g };
  const mask = new Uint8Array(g.cols * g.rows);
  for (let i = 0; i < mask.length; i++) if (hand[i] !== -32768 && hand[i] <= 30) mask[i] = 1;
  const rf = (f) => { const q = path.join(DATA, 'feat', f); return fs.existsSync(q) ? JSON.parse(fs.readFileSync(q, 'utf8')) : null; };
  impact.prepare(G, { buildings: { bin, meta }, roads_fine: rf('roads_fine.geojson'), rail: rf('rail.geojson'), places: rf('places.geojson') });
  impact.count(G, { grid: 'fine', mask }); // warm
  const t0 = performance.now();
  const res = impact.count(G, { grid: 'fine', mask });
  const ms = performance.now() - t0;
  const t1 = performance.now();
  const ln = impact.lines(G, { grid: 'fine', mask });
  const msL = performance.now() - t1;
  const pl = impact.places(G, { grid: 'fine', mask, buffer_cells: 3 });
  const bin32 = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  const bf = bruteCount(g, mask, bin32);
  t.diagnostic(`cells ${res.cells}, ${res.area_ha} ha, buildings ${res.buildings} (brute ${bf.n}), points ${res.points.length / 2}, count ${ms.toFixed(1)} ms, lines ${msL.toFixed(1)} ms: roads ${ln.roads_km} km, rail ${ln.rail_km} km, ${ln.geojson.features.length} pieces, places ${pl.length}`);
  assert.equal(res.buildings, bf.n);
  assert.ok(Math.abs(res.footprint_m2 - bf.foot) <= 2);
  assert.ok(res.points.length / 2 <= 20000);
  assert.ok(ms < 200, `count took ${ms} ms`);
  assert.ok(res.buildings > 0);
});
