// Ground core (lane g, 24 Nov 2026): smooth terrain tiles and close-zoom ground tiles from the data on disk.
// Runs in the ground worker (ground/worker.js); terrain-sampler.js runs the terrain half on the main thread when no
// worker can start. No DOM here: every fetch and image decode goes through `io` (ground/io.js).
//
//   drawn(z, x, y)  -> Float32Array 256 x 256 heights (model metres) as the 3D map draws them: tiles of zoom 13 and 14
//                      smoothed (dem.js), coarser zooms as on disk. null outside the terrain's bounds.
//   ground(z, x, y) -> Uint8ClampedArray 256 x 256 RGBA, the ground's colour lit by the scene's sun (look.js).
//
// Inputs, all already in the site: terrain tiles (tiles/terrain), land cover (tiles/lc10 at zoom 14 inside the fine
// box, grid/wide.lc.u8 elsewhere), height above the nearest river (grid/fine.hand.i16, grid/wide.hand.i16, read by row
// bands with HTTP Range), water outlines (feat/river_poly.geojson, feat/lakes.geojson, river lines with their width
// from feat/rivers.geojson), the carved bed's outline (feat/carve.json) and the weir's axis and office (weir.json).

import {
  tileAvailability, SMOOTH_FROM, NATIVE_M, EARTH_C, mpp, lonToU, latToV, vToLat, uToLon,
  tentKernel, smoothPatch, resampleCR, childPositions, assemblePatch, fillRings, strokeLine, chamfer, dilate, boxBlur,
} from './dem.js';
import { shadeTile, vnoise, smooth } from './look.js';

const T = 256;
const DEM_Z = 14; // the deepest terrain zoom: ground tiles take their heights from it
const LAT0 = -4.3; // the basin's latitude: world metres for the procedural detail use this scale (DISPLAY)
const M0 = EARTH_C * Math.cos((LAT0 * Math.PI) / 180); // metres across the mercator world at LAT0
const U0 = lonToU(104), V0 = latToV(LAT0); // origin of the detail's metres (keeps the numbers small)

// LC10 palette (tiles/lc10/tiles.json) -> WorldCover class
const LC10 = { '#cfe3bf': 10, '#dbe8c4': 20, '#e3edc8': 30, '#f1efc6': 40, '#e6e0d8': 50, '#efe6d0': 60, '#c6def0': 80,
  '#b6dcd3': 90, '#a9d4c4': 95, '#e8eedb': 100 };

class LRU {
  constructor(max) {
    this.max = max;
    this.m = new Map();
  }
  get(k) {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k, v) {
    this.m.set(k, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
    return v;
  }
}

const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

// The class of a point between four land-cover pixels (a b / c d, weights wx, wy): the class with the most bilinear
// weight, after a little noise per class (lam metres), so edges are rounded and wobble like real field and forest
// edges (DISPLAY CHOICE: noise 0.3 of a pixel's weight).
export function softPick(a, b, c, d, wx, wy, X, Y, lam, m = 0) {
  if (a === b && a === c && a === d) return a;
  const ks = [a, b, c, d], ws = [(1 - wx) * (1 - wy), wx * (1 - wy), (1 - wx) * wy, wx * wy];
  let best = 0, bw = -1;
  for (let q = 0; q < 4; q++) {
    const kq = ks[q];
    if (!kq) continue;
    let wsum = 0;
    for (let r = 0; r < 4; r++) if (ks[r] === kq) wsum += ws[r];
    // the edge wobbles at three scales (finer ones only where a pixel can show them), so it reads as a ragged
    // natural edge, not a cut-out blob
    wsum += 0.28 * vnoise(X / lam, Y / lam, kq * 13 + 1);
    if (lam / 4 > 2 * m) wsum += 0.16 * vnoise((4 * X) / lam, (4 * Y) / lam, kq * 13 + 5);
    if (lam / 14 > 2 * m) wsum += 0.1 * vnoise((14 * X) / lam, (14 * Y) / lam, kq * 13 + 9);
    if (wsum > bw) (bw = wsum), (best = kq);
  }
  return best;
}

// cfg: {tj, terrainUrl (template with {z}/{x}/{y}), dataUrl(path) -> absolute URL, small (true: smaller caches)}
export function createCore(io, cfg) {
  const avail = tileAvailability(cfg.tj);
  const small = !!cfg.small;
  const rawC = new LRU(small ? 24 : 48), baseC = new LRU(small ? 16 : 32), drawnC = new LRU(small ? 24 : 48);
  const lcC = new LRU(24), bandC = new LRU(96);
  const turl = (z, x, y) => cfg.terrainUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);

  // ---------- terrain ----------
  function raw(z, x, y) {
    if (!avail.has(z, x, y)) return Promise.resolve(null);
    const k = z + '/' + x + '/' + y;
    let p = rawC.get(k);
    if (!p) {
      p = rawC.set(k, io.terrain(turl(z, x, y)).catch(() => null));
      p.then((v) => v || rawC.m.delete(k));
    }
    return p;
  }
  const around = (fn, z, x, y) => {
    const out = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out.push(fn(z, x + dx, y + dy));
    return Promise.all(out);
  };

  // the field a zoom-13/14 tile is smoothed from: the file on disk, else a Catmull-Rom cubic of its deepest ancestor
  function base(z, x, y) {
    if (!avail.inBounds(z, x, y)) return Promise.resolve(null);
    if (avail.has(z, x, y)) return raw(z, x, y);
    const k = z + '/' + x + '/' + y;
    let p = baseC.get(k);
    if (p) return p;
    p = (async () => {
      let az = z - 1, ax = x >> 1, ay = y >> 1;
      while (az >= avail.minzoom && !avail.has(az, ax, ay)) (az--, (ax >>= 1), (ay >>= 1));
      if (az < avail.minzoom) return null;
      const m = 2;
      const patch = assemblePatch(await around(raw, az, ax, ay), m);
      if (!patch) return null;
      const { xs, ys } = childPositions(z, x, y, az, ax, ay, m);
      return resampleCR(patch, T + 2 * m, T + 2 * m, xs, ys);
    })().catch(() => null);
    baseC.set(k, p);
    return p;
  }

  // the carved bed (outline polygons) and the weir pit: kept exactly as on disk
  let carveP = null;
  const carve = () =>
    carveP ||
    (carveP = io.json(cfg.dataUrl('feat/carve.json')).then((cv) => {
      const polys = [];
      const P = (cv && cv.polygons) || {};
      for (const g of Object.values(P)) {
        if (!g || !g.coordinates) continue;
        const list = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
        for (const rings of list) polys.push(rings.map((r) => r.flatMap(([lon, lat]) => [lonToU(lon), latToV(lat)])));
      }
      if (!polys.length) return null;
      let u0 = 1, v0 = 1, u1 = 0, v1 = 0;
      for (const rings of polys) for (const r of rings) for (let i = 0; i < r.length; i += 2) {
        u0 = Math.min(u0, r[i]); u1 = Math.max(u1, r[i]); v0 = Math.min(v0, r[i + 1]); v1 = Math.max(v1, r[i + 1]);
      }
      const ax = cv.axis && cv.axis.a && cv.axis.b ? [(cv.axis.a[0] + cv.axis.b[0]) / 2, (cv.axis.a[1] + cv.axis.b[1]) / 2] : null;
      const pit = cv.levels_model_m && Number.isFinite(cv.levels_model_m.weir_pit) ? cv.levels_model_m.weir_pit : null;
      return { polys, box: [u0, v0, u1, v1], axis: ax && [lonToU(ax[0]), latToV(ax[1])], pit };
    }).catch(() => null));

  const PIT_TOL = 0.3; // metres above the pit floor still counted as the pit (the floor is one flat level)
  const PIT_R = 300; // metres from the axis centre within which the pit is looked for (the weir is 215.5 m long)
  async function protectMask(z, x, y, R, patch) {
    const cv = await carve();
    if (!cv) return null;
    const S = T * 2 ** z, P = T + 2 * R;
    const pad = 300 / M0; // 300 m in world units
    const tu0 = (x * T - R) / S, tv0 = (y * T - R) / S, tu1 = ((x + 1) * T + R) / S, tv1 = ((y + 1) * T + R) / S;
    if (tu1 < cv.box[0] - pad || tu0 > cv.box[2] + pad || tv1 < cv.box[1] - pad || tv0 > cv.box[3] + pad) return null;
    const mask = new Uint8Array(P * P);
    let any = 0;
    for (const rings of cv.polys) any += fillRings(mask, P, P, rings.map((r) => r.map((v, i) => (i & 1 ? v * S - (y * T - R) : v * S - (x * T - R)))));
    if (cv.axis && cv.pit != null) {
      const cx = cv.axis[0] * S - (x * T - R), cy = cv.axis[1] * S - (y * T - R);
      const rpx = PIT_R / mpp(z, LAT0);
      for (let j = Math.max(0, Math.floor(cy - rpx)); j < Math.min(P, Math.ceil(cy + rpx)); j++) {
        for (let i = Math.max(0, Math.floor(cx - rpx)); i < Math.min(P, Math.ceil(cx + rpx)); i++) {
          const dx = i + 0.5 - cx, dy = j + 0.5 - cy;
          if (dx * dx + dy * dy <= rpx * rpx && patch[j * P + i] <= cv.pit + PIT_TOL) {
            mask[j * P + i] = 1;
            any++;
          }
        }
      }
    }
    return any ? dilate(mask, P, P) : null;
  }

  // what the 3D map draws
  function drawn(z, x, y) {
    if (!avail.inBounds(z, x, y)) return Promise.resolve(null);
    if (z < SMOOTH_FROM) return base(z, x, y);
    const k = z + '/' + x + '/' + y;
    let p = drawnC.get(k);
    if (p) return p;
    p = (async () => {
      const lat = vToLat((y + 0.5) / 2 ** z);
      const kern = tentKernel(NATIVE_M / mpp(z, lat));
      const R = kern.R;
      const patch = assemblePatch(await around(base, z, x, y), R);
      if (!patch) return null;
      const prot = await protectMask(z, x, y, R, patch);
      const out = smoothPatch(patch, T + 2 * R, T + 2 * R, kern, prot);
      out.w = T;
      return out;
    })().catch(() => null);
    drawnC.set(k, p);
    p.then((v) => v || drawnC.m.delete(k));
    return p;
  }

  // ---------- land cover ----------
  let lcTjP = null;
  const lcTj = () => lcTjP || (lcTjP = io.json(cfg.dataUrl('tiles/lc10/tiles.json')).catch(() => null));
  async function lc10(x, y) {
    const k = x + '/' + y;
    let p = lcC.get(k);
    if (p) return p;
    const tj = await lcTj();
    const b = tj && tj.bounds;
    if (!b || (tj.maxzoom ?? 0) < DEM_Z || (tj.minzoom ?? 99) > DEM_Z) return null;
    p = lcC.get(k);
    if (p) return p;
    const tx0 = Math.floor(lonToU(b[0]) * 2 ** DEM_Z), tx1 = Math.floor(lonToU(b[2]) * 2 ** DEM_Z);
    const ty0 = Math.floor(latToV(b[3]) * 2 ** DEM_Z), ty1 = Math.floor(latToV(b[1]) * 2 ** DEM_Z);
    if (x < tx0 || x > tx1 || y < ty0 || y > ty1) return null;
    p = io.image(cfg.dataUrl('tiles/lc10/' + DEM_Z + '/' + x + '/' + y + '.png')).then((img) => {
      if (!img) return null;
      const n = img.width * img.height, d = img.data, out = new Uint8Array(n);
      const memo = new Map();
      for (let i = 0; i < n; i++) {
        if (d[4 * i + 3] < 128) continue;
        const key = (d[4 * i] << 16) | (d[4 * i + 1] << 8) | d[4 * i + 2];
        let c = memo.get(key);
        if (c === undefined) {
          c = LC10[hex(d[4 * i], d[4 * i + 1], d[4 * i + 2])];
          if (c === undefined) c = nearestLc(d[4 * i], d[4 * i + 1], d[4 * i + 2]);
          memo.set(key, c);
        }
        out[i] = c;
      }
      return out;
    }).catch(() => null);
    lcC.set(k, p);
    return p;
  }
  const lcRGB = Object.entries(LC10).map(([h, c]) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), c]);
  function nearestLc(r, g, b) {
    let best = 1e9, bc = 0;
    for (const [R, G, B, c] of lcRGB) {
      const d = (R - r) ** 2 + (G - g) ** 2 + (B - b) ** 2;
      if (d < best) (best = d), (bc = c);
    }
    return best < 600 ? bc : 0;
  }

  // ---------- grids by row bands ----------
  const metaP = {};
  const gridMeta = (name) =>
    metaP[name] || (metaP[name] = io.json(cfg.dataUrl('grid/' + name + '.json')).catch(() => null));
  const BAND = 48;
  // rows r0..r1 (inclusive) of a grid file (cols wide, bytes per cell bpc) -> {r0, rows, a: typed array}
  async function rows(file, cols, nrows, bpc, Ctor, r0, r1) {
    r0 = Math.max(0, r0);
    r1 = Math.min(nrows - 1, r1);
    if (r1 < r0) return null;
    const b0 = Math.floor(r0 / BAND), b1 = Math.floor(r1 / BAND);
    const bands = [];
    for (let b = b0; b <= b1; b++) {
      const k = file + ':' + b;
      let p = bandC.get(k);
      if (!p) {
        const s = b * BAND * cols * bpc, e = Math.min(nrows, (b + 1) * BAND) * cols * bpc;
        p = bandC.set(k, io.bytes(cfg.dataUrl('grid/' + file), s, e).then((res) => (res ? new Ctor(res.buf.slice(s - res.offset, e - res.offset)) : null)).catch(() => null));
        p.then((v) => v || bandC.m.delete(k));
      }
      bands.push(p);
    }
    const got = await Promise.all(bands);
    if (got.some((g) => !g)) return null;
    return { r0: b0 * BAND, a: got, cols, band: BAND };
  }
  const cell = (R, r, c) => {
    const bi = Math.floor((r - R.r0) / R.band);
    const g = R.a[bi];
    return g ? g[(r - R.r0 - bi * R.band) * R.cols + c] : undefined;
  };

  // HAND (metres above the nearest river) for every pixel of a tile, bilinear; NaN where unknown
  async function handField(lonAt, latAt, N) {
    const out = new Float32Array(N * N).fill(NaN);
    const lonA = lonAt(0), lonB = lonAt(N - 1), latA = latAt(0), latB = latAt(N - 1);
    for (const name of ['fine', 'wide']) {
      const m = await gridMeta(name);
      if (!m || !m.files || !m.files.hand) continue;
      const cs = m.cellsize_deg;
      const inside = lonA > m.west + cs && lonB < m.east - cs && latB > m.south + cs && latA < m.north - cs;
      if (!inside && name === 'fine') continue;
      const c0 = Math.floor((lonA - m.west) / cs - 0.5) - 1, c1 = Math.ceil((lonB - m.west) / cs - 0.5) + 1;
      const r0 = Math.floor((m.north - latA) / cs - 0.5) - 1, r1 = Math.ceil((m.north - latB) / cs - 0.5) + 1;
      const G = await rows(m.files.hand, m.cols, m.rows, 2, Int16Array, r0, r1);
      if (!G) continue;
      for (let j = 0; j < N; j++) {
        const fr = (m.north - latAt(j)) / cs - 0.5;
        const r = Math.floor(fr), tr = fr - r;
        if (r < 0 || r + 1 >= m.rows) continue;
        for (let i = 0; i < N; i++) {
          const fc = (lonAt(i) - m.west) / cs - 0.5;
          const c = Math.floor(fc), tc = fc - c;
          if (c < 0 || c + 1 >= m.cols) continue;
          const a = cell(G, r, c), b = cell(G, r, c + 1), d = cell(G, r + 1, c), e = cell(G, r + 1, c + 1);
          if (a === -32768 || b === -32768 || d === -32768 || e === -32768 || a === undefined) continue;
          out[j * N + i] = ((a * (1 - tc) + b * tc) * (1 - tr) + (d * (1 - tc) + e * tc) * tr) / 10;
        }
      }
      return out;
    }
    return out;
  }

  // wide land cover (90 m) nearest, with the given warp, where the 10 m picture has nothing
  let lcMetaP = null;
  const lcMeta = () => lcMetaP || (lcMetaP = io.json(cfg.dataUrl('grid/lc.json')).catch(() => null));
  async function wideLc(cls, lonAt, latAt, N, X0, Y0, m) {
    const meta = await lcMeta();
    const w = meta && meta.wide;
    if (!w) return;
    const cs = w.cell_deg;
    const r0 = Math.floor((w.north - latAt(0)) / cs) - 2, r1 = Math.ceil((w.north - latAt(N - 1)) / cs) + 2;
    const G = await rows(w.file, w.cols, w.rows, 1, Uint8Array, r0, r1);
    if (!G) return;
    for (let j = 0; j < N; j++) {
      const Y = Y0 - j * m;
      const fr = (w.north - latAt(j)) / cs - 0.5;
      const r = Math.floor(fr), wy = fr - r;
      if (r < 0 || r + 1 >= w.rows) continue;
      for (let i = 0; i < N; i++) {
        const p = j * N + i;
        if (cls[p]) continue;
        const fc = (lonAt(i) - w.west) / cs - 0.5;
        const c = Math.floor(fc), wx = fc - c;
        if (c < 0 || c + 1 >= w.cols) continue;
        const v = (rr, cc) => cell(G, rr, cc) || 0;
        cls[p] = softPick(v(r, c), v(r, c + 1), v(r + 1, c), v(r + 1, c + 1), wx, wy, X0 + i * m, Y, 90, m);
      }
    }
  }

  // ---------- water outlines ----------
  let waterP = null;
  const water = () =>
    waterP ||
    (waterP = Promise.all(['feat/river_poly.geojson', 'feat/lakes.geojson', 'feat/rivers.geojson'].map((p) => io.json(cfg.dataUrl(p)).catch(() => null))).then(([rp, lk, rv]) => {
      const polys = [], lines = [];
      const box = (arr) => {
        let u0 = 1, v0 = 1, u1 = 0, v1 = 0;
        for (let i = 0; i < arr.length; i += 2) {
          u0 = Math.min(u0, arr[i]); u1 = Math.max(u1, arr[i]); v0 = Math.min(v0, arr[i + 1]); v1 = Math.max(v1, arr[i + 1]);
        }
        return [u0, v0, u1, v1];
      };
      const addPoly = (g, natural) => {
        if (!g) return;
        const list = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : [];
        for (const rings of list) {
          const rs = rings.map((r) => Float64Array.from(r.flatMap(([lon, lat]) => [lonToU(lon), latToV(lat)])));
          if (rs.length && rs[0].length >= 6) polys.push({ rings: rs, box: box(rs[0]), natural });
        }
      };
      for (const f of (rp && rp.features) || []) addPoly(f.geometry, (f.properties || {}).kind === 'river');
      for (const f of (lk && lk.features) || []) {
        const kind = (f.properties || {}).kind;
        // natural banks: rivers, lakes and big reservoirs; small 'reservoirs' are built basins (the settling basins)
        const g = f.geometry;
        const ring = g && (g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null);
        const big = ring && Math.hypot(Math.max(...ring.map((p) => p[0])) - Math.min(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1])) - Math.min(...ring.map((p) => p[1]))) > 0.004;
        addPoly(g, kind === 'river' || kind === 'lake' || (kind === 'reservoir' && big));
      }
      for (const f of (rv && rv.features) || []) {
        const p = f.properties || {};
        if ((p.kind !== 'river' && p.kind !== 'stream') || p.poly === 1 || !f.geometry || f.geometry.type !== 'LineString') continue;
        // half width: the line's own width (rivers.geojson `w`, metres), else 6 m for a river and 2 m for a stream (DISPLAY)
        const hw = Number.isFinite(p.w) ? p.w / 2 : p.kind === 'river' ? 6 : 2;
        const pts = Float64Array.from(f.geometry.coordinates.flatMap(([lon, lat]) => [lonToU(lon), latToV(lat)]));
        lines.push({ pts, box: box(pts), hw });
      }
      polys.sort((a, b) => a.natural - b.natural); // other water first, rivers over it
      return { polys, lines };
    }));

  // ---------- the weir's zones: riprap and the compound ----------
  let zonesP = null;
  const zones = () =>
    zonesP ||
    (zonesP = Promise.all([io.json(cfg.dataUrl('weir.json')).catch(() => null), water()]).then(([wj]) => {
      const v = (o, d) => (o && o.v !== undefined ? o.v : o !== undefined && o !== null ? o : d);
      const ax = (wj && wj.axis) || {};
      // the axis ends and the office point are facts in weir.json (status R); the fallbacks are the same numbers
      const we = v(ax.west_end, [104.38003, -4.30513]), ee = v(ax.east_end, [104.38198, -4.3051]);
      const office = v(wj && wj.office && wj.office.point, [104.38245, -4.30494]);
      // the flushing channel's outlet: where OpenStreetMap's Saluran Bilas line ends at the river (brief: 104.38111 E,
      // 4.30385 S), and the line's last 100 m before it
      const outlet = [104.38111, -4.30385], outletIn = [104.38215, -4.30386];
      const W = (lon, lat) => [(lonToU(lon) - U0) * M0, (V0 - latToV(lat)) * M0];
      // DISPLAY CHOICES (no drawing gives the riprap's extent): 70 m of bank around each abutment, 35 m around the outlet
      const rip = [
        { a: W(...we), b: W(...we), r: 70 },
        { a: W(...ee), b: W(...ee), r: 70 },
        { a: W(...outlet), b: W(...outletIn), r: 35 },
      ];
      // the operator's compound: about 60 m around the office (DISPLAY CHOICE)
      const yard = [{ a: W(...office), b: W(...office), r: 60 }];
      return { rip, yard };
    }));
  const segDist = (X, Y, s) => {
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((X - s.a[0]) * dx + (Y - s.a[1]) * dy) / L2)) : 0;
    return Math.hypot(X - s.a[0] - t * dx, Y - s.a[1] - t * dy);
  };

  // ---------- one ground tile ----------
  async function ground(z, x, y) {
    if (z < DEM_Z || !avail.inBounds(Math.min(z, avail.maxzoom), x >> Math.max(0, z - avail.maxzoom), y >> Math.max(0, z - avail.maxzoom))) return null;
    const N = T, S = T * 2 ** z;
    const m = M0 / S; // metres per pixel (at LAT0; the detail's scale)
    const X0 = ((x * T + 0.5) / S - U0) * M0, Y0 = (V0 - (y * T + 0.5) / S) * M0;
    const lonAt = (i) => uToLon((x * T + i + 0.5) / S);
    const latA = vToLat((y * T + 0.5) / S), latB = vToLat((y * T + N - 0.5) / S);
    const latAt = (j) => latA + ((latB - latA) * j) / (N - 1);

    // heights: the drawn zoom-14 surface, Catmull-Rom between its pixels, one pixel of border for the slopes
    const k = 2 ** (z - DEM_Z), tx = Math.floor(x / k), ty = Math.floor(y / k);
    const mD = 3;
    const [dem, lcs, hand, wat, zn] = await Promise.all([
      around(drawn, DEM_Z, tx, ty).then((t) => assemblePatch(t, mD)),
      around((zz, xx, yy) => lc10(xx, yy), DEM_Z, tx, ty),
      handField(lonAt, latAt, N),
      water(),
      zones(),
    ]);
    if (!dem) return null;
    const { xs, ys } = childPositions(z, x, y, DEM_Z, tx, ty, mD, 1);
    const H = resampleCR(dem, T + 2 * mD, T + 2 * mD, xs, ys);

    // land cover: the 10 m picture with soft class edges (bilinear class weights plus a little noise per class), so
    // its square pixels read as natural edges
    const cls = new Uint8Array(N * N);
    if (lcs[4]) {
      const get = (gx, gy) => {
        const t = lcs[(gy < 0 ? 0 : gy >= T ? 2 : 1) * 3 + (gx < 0 ? 0 : gx >= T ? 2 : 1)] || lcs[4];
        return t[(((gy % T) + T) % T) * T + (((gx % T) + T) % T)];
      };
      for (let j = 0; j < N; j++) {
        const Y = Y0 - j * m;
        const fy = (y * T + j + 0.5) / k - ty * T - 0.5;
        const gy = Math.floor(fy), wy = fy - gy;
        for (let i = 0; i < N; i++) {
          const X = X0 + i * m;
          const fx = (x * T + i + 0.5) / k - tx * T - 0.5;
          const gx = Math.floor(fx), wx = fx - gx;
          cls[j * N + i] = softPick(get(gx, gy), get(gx + 1, gy), get(gx, gy + 1), get(gx + 1, gy + 1), wx, wy, X, Y, 14, m);
        }
      }
    }
    await wideLc(cls, lonAt, latAt, N, X0, Y0, m);

    // water: outlines rasterized with a margin, distance to the water and into it
    const P = Math.min(64, Math.max(4, Math.ceil(40 / m)));
    const G = N + 2 * P;
    const mask = new Uint8Array(G * G);
    const u0 = (x * T - P) / S, v0 = (y * T - P) / S, u1 = ((x + 1) * T + P) / S, v1 = ((y + 1) * T + P) / S;
    const toPx = (r) => {
      const o = new Float64Array(r.length);
      for (let q = 0; q < r.length; q += 2) {
        o[q] = r[q] * S - (x * T - P);
        o[q + 1] = r[q + 1] * S - (y * T - P);
      }
      return o;
    };
    let anyWater = false;
    for (const pl of wat.polys) {
      const b = pl.box;
      if (b[2] < u0 || b[0] > u1 || b[3] < v0 || b[1] > v1) continue;
      if (fillRings(mask, G, G, pl.rings.map(toPx), pl.natural ? 1 : 2)) anyWater = true;
    }
    for (const ln of wat.lines) {
      const hwU = ln.hw / M0;
      const b = ln.box;
      if (b[2] + hwU < u0 || b[0] - hwU > u1 || b[3] + hwU < v0 || b[1] - hwU > v1) continue;
      if (strokeLine(mask, G, G, toPx(ln.pts), ln.hw / m, 1)) anyWater = true;
    }
    let wIn = null, dOut = null, dIn = null;
    if (anyWater) {
      const capPx = P;
      const dO = chamfer(mask, G, G, (v) => v === 1, capPx);
      const dI = chamfer(mask, G, G, (v) => v !== 1, capPx);
      // signed distance (px, negative in the water), blurred over about 10 m so the 10 m steps of the satellite
      // outline read as a natural shore (DISPLAY CHOICE)
      let sd = new Float32Array(G * G);
      for (let g = 0; g < G * G; g++) sd[g] = dO[g] - dI[g];
      const r = Math.min(Math.floor(P / 3), Math.round(5 / m));
      if (r >= 1) sd = boxBlur(boxBlur(sd, G, G, r), G, G, r);
      wIn = new Uint8Array(N * N);
      dOut = new Float32Array(N * N);
      dIn = new Float32Array(N * N);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const g = (j + P) * G + i + P, p = j * N + i;
          const v = sd[g];
          wIn[p] = mask[g] === 2 && v >= 0 ? 2 : v < 0 ? 1 : 0;
          dOut[p] = v >= capPx - 2 * r - 1 ? Infinity : Math.max(0, v) * m;
          dIn[p] = Math.max(0, -v) * m;
        }
      }
    }

    // zones
    let rip = null, yard = null;
    const tile = { a: [X0 + (N / 2) * m, Y0 - (N / 2) * m] };
    const half = (N / 2) * m * Math.SQRT2;
    for (const s of zn.rip) {
      if (segDist(tile.a[0], tile.a[1], s) > s.r + half) continue;
      rip = rip || new Float32Array(N * N);
      for (let j = 0; j < N; j++) {
        const Y = Y0 - j * m;
        for (let i = 0; i < N; i++) {
          const p = j * N + i;
          const X = X0 + i * m;
          const d = segDist(X, Y, s);
          if (d > s.r + 10) continue;
          const nz = 4 * vnoise(X / 9, Y / 9, 191);
          const inZone = smooth(s.r + 6, s.r - 6, d + nz);
          // on the bank face: from under the water's edge up to about 14 m inland (DISPLAY)
          const dO = dOut ? dOut[p] : Infinity;
          const onBank = wIn && wIn[p] === 1 ? smooth(9, 4, dIn[p] + nz) : smooth(16, 9, dO + nz);
          rip[p] = Math.max(rip[p], inZone * onBank);
        }
      }
    }
    for (const s of zn.yard) {
      if (segDist(tile.a[0], tile.a[1], s) > s.r + half) continue;
      yard = yard || new Float32Array(N * N);
      for (let j = 0; j < N; j++) {
        const Y = Y0 - j * m;
        for (let i = 0; i < N; i++) {
          const X = X0 + i * m;
          const d = segDist(X, Y, s);
          if (d > s.r + 20) continue;
          yard[j * N + i] = Math.max(yard[j * N + i], 0.85 * smooth(s.r + 8, s.r - 12, d + 10 * vnoise(X / 25, Y / 25, 197)));
        }
      }
    }

    const out = new Uint8ClampedArray(N * N * 4);
    shadeTile({ N, m, X0, Y0, H, cls, hand, wat: wIn, dOut, dIn, rip, yard }, out);
    return out;
  }

  return { avail, drawn, ground, raw };
}
