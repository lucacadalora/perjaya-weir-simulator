// Terrain tiles: which exist, a MapLibre protocol that never asks for a missing one, and heights (ctx.sampler).
// Owner: lane b04; smooth close terrain and the ground tiles by lane g (24 Nov 2026).
//
// Availability rule (tiles.json): every zoom from minzoom to 12 covers the whole `bounds`. A deeper zoom exists only
// inside its range: `manifest["13"] = {x: [min, max], y: [min, max]}` when the file has a manifest, else the range
// derived from `fine_bounds_z13` / `fine_bounds_z14`. The deepest zoom is the highest one listed.
//
// Protocol `pjterrain://{z}/{x}/{y}`: zooms up to 12 are fetched as they are (with the release stamp). Zooms 13 and 14
// (the close views) are SMOOTHED (ground/dem.js): the 30 m surface model resampled bilinear shows a crease every 30 m,
// so each tile is filtered into the cubic B-spline of the same 30 m samples; a tile that is not on disk is first made
// from its deepest ancestor with a Catmull-Rom cubic. The carved river bed and the weir pit (feat/carve.json) keep
// their exact heights. This runs in a small pool of workers (ground/worker.js), which also draws the ground tiles
// (`groundTile`, protocol 'pjground', mounted by ground/mount.js); with no worker it runs here.
//
// ctx.sampler: elevation(lon, lat) -> Promise<number|null> in model metres (the terrain's own heights, what the 3D map
// draws at exaggeration 1 in a close view), bilinear between the pixels of the deepest zoom (14, smoothed) anywhere
// inside `bounds`; null outside. Independent of the view. elevations([[lon, lat], ...]) -> Promise<Array>.
// elevationSync(lon, lat) -> number|null when that tile is decoded.

import { tileAvailability, SMOOTH_FROM } from './ground/dem.js';
import { createCore } from './ground/core.js';
import { createIO, encodeTerrariumPng } from './ground/io.js';
import { lonToTileX, latToTileY } from './geo.js';

export { tileAvailability };

const MAX_TILES = 96; // decoded tiles kept (each 256 x 256 floats = 256 kB)
const READY_MS = 8000; // a worker that has not said ready by then is given up for the main thread

const canvas = (w, h) =>
  typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });

export async function decodeTerrarium(blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const cv = canvas(bmp.width, bmp.height);
  const c2 = cv.getContext('2d', { willReadFrequently: true });
  c2.drawImage(bmp, 0, 0);
  const px = c2.getImageData(0, 0, bmp.width, bmp.height).data;
  const n = bmp.width * bmp.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = px[4 * i] * 256 + px[4 * i + 1] + px[4 * i + 2] / 256 - 32768;
  out.w = bmp.width;
  bmp.close && bmp.close();
  return out;
}

export async function encodeTerrarium(h, w) {
  const cv = canvas(w, w);
  const c2 = cv.getContext('2d');
  const img = c2.createImageData(w, w);
  const d = img.data;
  for (let i = 0; i < w * w; i++) {
    const v = Math.max(0, Math.min(65535.99, h[i] + 32768));
    const iv = Math.floor(v);
    d[4 * i] = iv >> 8;
    d[4 * i + 1] = iv & 255;
    d[4 * i + 2] = Math.floor((v - iv) * 256);
    d[4 * i + 3] = 255;
  }
  c2.putImageData(img, 0, 0);
  const blob = cv.convertToBlob ? await cv.convertToBlob({ type: 'image/png' }) : await new Promise((r) => cv.toBlob(r, 'image/png'));
  return blob.arrayBuffer();
}

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

// The worker pool: worker 0 answers the terrain, the others (when there are any) draw ground tiles.
function workerPool(cfg) {
  if (typeof Worker === 'undefined' || typeof navigator === 'undefined') return null;
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  const n = cores >= 8 && mem >= 4 ? 3 : cores >= 4 ? 2 : 1;
  const ws = [];
  try {
    for (let i = 0; i < n; i++) ws.push(new Worker(new URL('./ground/worker.js', import.meta.url), { type: 'module' }));
  } catch (e) {
    ws.forEach((w) => w.terminate());
    return null;
  }
  let seq = 0, broken = false;
  const pend = new Map(); // id -> resolve
  const fail = () => {
    if (broken) return;
    broken = true;
    for (const done of pend.values()) done({ ok: false, error: 'worker stopped' });
    pend.clear();
    ws.forEach((w) => w.terminate());
  };
  const ready = new Promise((res) => {
    let left = ws.length, ok = true;
    const timer = setTimeout(() => res(false), READY_MS);
    ws.forEach((w) => {
      w.onmessage = (ev) => {
        const d = ev.data || {};
        if (d.op === 'ready') {
          ok = ok && !!d.ok;
          if (--left === 0) (clearTimeout(timer), res(ok));
          return;
        }
        const done = pend.get(d.id);
        if (done) (pend.delete(d.id), done(d));
      };
      w.onerror = (e) => {
        e && e.preventDefault && e.preventDefault();
        clearTimeout(timer);
        res(false);
        fail();
      };
      w.postMessage({ op: 'init', ...cfg, small: true });
    });
  }).then((ok) => (ok || fail(), ok));
  function ask(i, msg, signal) {
    if (broken) return Promise.resolve({ ok: false });
    return new Promise((resolve) => {
      const id = ++seq;
      pend.set(id, resolve);
      ws[i].postMessage({ ...msg, id });
      if (signal) signal.addEventListener('abort', () => pend.has(id) && ws[i].postMessage({ op: 'cancel', id }), { once: true });
    });
  }
  return { ready, n: ws.length, ask, get broken() { return broken; } };
}

// one shared tile store: url template (with stamp), availability, decoded-height cache
export function createTerrainStore({ tilesUrl, tj }) {
  const avail = tileAvailability(tj);
  const tileSize = tj.tileSize || 256;
  const cache = new Map(); // key -> Promise<Float32Array|null>
  const sync = new Map(); // key -> Float32Array
  const url = (z, x, y) => tilesUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);

  // where the data folder is: the terrain template is <data>/tiles/terrain/{z}/{x}/{y}.png?v=<stamp>
  const q = tilesUrl.indexOf('?');
  const path = q >= 0 ? tilesUrl.slice(0, q) : tilesUrl;
  const stamp = (/[?&]v=([^&]+)/.exec(tilesUrl) || [])[1] || '';
  const m = /^(.*\/)tiles\/terrain\/\{z\}\/\{x\}\/\{y\}\.png$/.exec(path);
  const dataBase = m ? m[1] : typeof location !== 'undefined' ? new URL('./data/', location.href).href : './data/';
  const cfg = { tj, terrainUrl: tilesUrl, dataBase, stamp };
  // ?ground=0 turns the smoothing and the ground tiles off (the terrain as on disk, as before 24 Nov 2026)
  const off = typeof location !== 'undefined' && /[?&]ground=0(&|$)/.test(location.search);
  // the pool starts on the first close tile or ground request, not while the map itself starts
  let poolV;
  const getPool = () => (poolV === undefined ? (poolV = off ? null : workerPool(cfg)) : poolV);
  let main = null; // the same core on this thread, when no worker runs
  const stats = { pool: 'later', dem: 0, demOk: 0, ground: 0, groundOk: 0, main: 0, fail: 0 };

  // smoothed heights (and the Terrarium PNG when asked) of a zoom-13/14 tile
  async function smoothed(z, x, y, png, signal) {
    const pool = getPool();
    if (pool && (await pool.ready) && !pool.broken) {
      stats.dem++;
      const d = await pool.ask(0, { op: 'dem', z, x, y, png }, signal);
      if (d.cancelled || (signal && signal.aborted)) throw abortError();
      if (d.ok) {
        stats.demOk++;
        d.h.w = tileSize;
        return d;
      }
      if (!pool.broken) return null;
    }
    stats.main++;
    main = main || createCore(createIO(), { ...cfg, dataUrl: (p) => dataBase + p + (stamp ? '?v=' + stamp : ''), small: true });
    const h = await main.drawn(z, x, y);
    if (!h) return null;
    return { h, png: png ? await encodeTerrariumPng(h, tileSize) : null };
  }

  function remember(key, p) {
    cache.set(key, p);
    p.then((v) => (v ? cache.get(key) === p && sync.set(key, v) : cache.delete(key)));
    while (cache.size > MAX_TILES) {
      const old = cache.keys().next().value;
      cache.delete(old);
      sync.delete(old);
    }
    return p;
  }

  // heights of a tile as the 3D map draws it (zoom 13 and 14 smoothed; any tile inside the bounds)
  function heights(z, x, y) {
    const key = z + '/' + x + '/' + y;
    let p = cache.get(key);
    if (p) {
      cache.delete(key);
      cache.set(key, p);
      return p;
    }
    if (!avail.inBounds(z, x, y)) return Promise.resolve(null);
    if (z < SMOOTH_FROM || off) {
      if (!avail.has(z, x, y)) return Promise.resolve(null);
      p = fetch(url(z, x, y))
        .then((r) => (r.ok ? r.blob().then(decodeTerrarium) : null))
        .catch(() => null);
    } else p = smoothed(z, x, y, false).then((d) => (d ? d.h : null)).catch(() => null);
    return remember(key, p);
  }

  // a missing coarse tile made from its deepest existing ancestor (bilinear); zooms 13 and up go through smoothed()
  async function synth(z, x, y) {
    let az = z - 1, ax = x >> 1, ay = y >> 1;
    while (az >= avail.minzoom && !avail.has(az, ax, ay)) (az--, (ax >>= 1), (ay >>= 1));
    if (az < avail.minzoom) return null;
    const src = await heights(az, ax, ay);
    if (!src) return null;
    const k = 2 ** (z - az), w = tileSize, sw = src.w;
    const ox = (x - ax * k) * (sw / k), oy = (y - ay * k) * (sw / k);
    const out = new Float32Array(w * w);
    for (let j = 0; j < w; j++) {
      const fy = Math.min(sw - 1, Math.max(0, oy + ((j + 0.5) * sw) / (k * w) - 0.5));
      const j0 = Math.min(sw - 2, Math.floor(fy)), ty = fy - j0;
      for (let i = 0; i < w; i++) {
        const fx = Math.min(sw - 1, Math.max(0, ox + ((i + 0.5) * sw) / (k * w) - 0.5));
        const i0 = Math.min(sw - 2, Math.floor(fx)), tx = fx - i0;
        const a = src[j0 * sw + i0], b = src[j0 * sw + i0 + 1], c = src[(j0 + 1) * sw + i0], d = src[(j0 + 1) * sw + i0 + 1];
        out[j * w + i] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
      }
    }
    return encodeTerrarium(out, w);
  }

  // MapLibre protocol handler for 'pjterrain://{z}/{x}/{y}'
  async function load(params, abort) {
    const mm = /(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!mm) throw new Error('bad terrain tile address');
    const [z, x, y] = [+mm[1], +mm[2], +mm[3]];
    if (z >= SMOOTH_FROM && !off) {
      const d = await smoothed(z, x, y, true, abort && abort.signal);
      if (!d) throw new Error('no terrain for this tile');
      const key = z + '/' + x + '/' + y;
      if (!cache.has(key)) remember(key, Promise.resolve(d.h));
      return { data: d.png };
    }
    if (avail.has(z, x, y)) {
      const r = await fetch(url(z, x, y), { signal: abort && abort.signal });
      if (r.ok) return { data: await r.arrayBuffer() };
    }
    const data = await synth(z, x, y);
    if (!data) throw new Error('no terrain for this tile');
    return { data };
  }

  // MapLibre protocol handler for 'pjground://{z}/{x}/{y}' (ground/mount.js): a JPEG of the lit ground
  async function groundTile(params, abort) {
    const mm = /(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!mm) throw new Error('bad ground tile address');
    const [z, x, y] = [+mm[1], +mm[2], +mm[3]];
    const pool = getPool();
    if (!pool || !(await pool.ready) || pool.broken) throw new Error('ground tiles need a worker');
    const sh = Math.max(0, z - 14);
    const i = pool.n > 1 ? 1 + ((((x >> sh) * 7 + (y >> sh) * 13) % (pool.n - 1)) + (pool.n - 1)) % (pool.n - 1) : 0;
    stats.ground++;
    const d = await pool.ask(i, { op: 'ground', z, x, y }, abort && abort.signal);
    if (d.cancelled || (abort && abort.signal && abort.signal.aborted)) throw abortError();
    if (!d.ok) throw (stats.fail++, new Error('no ground for this tile'));
    stats.groundOk++;
    return { data: d.img };
  }

  // can there be ground tiles? (a module worker with OffscreenCanvas; asked only when the ground layer mounts)
  const groundReady = () => {
    const pool = getPool();
    return pool ? pool.ready.then((ok) => ((stats.pool = ok && !pool.broken ? 'ready' : 'broken'), ok && !pool.broken)) : Promise.resolve(false);
  };
  return { avail, tileSize, heights, sync, load, groundTile, groundReady, smooth: !off, stats };
}

export function createSampler(store) {
  const { avail, tileSize, heights, sync } = store;
  const inBox = (b, lon, lat) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];

  function corners(z, lon, lat) {
    const fx = lonToTileX(lon, z) * tileSize - 0.5, fy = latToTileY(lat, z) * tileSize - 0.5;
    const i0 = Math.floor(fx), j0 = Math.floor(fy);
    const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([di, dj]) => {
      const gi = i0 + di, gj = j0 + dj, tX = Math.floor(gi / tileSize), tY = Math.floor(gj / tileSize);
      return { tX, tY, i: gi - tX * tileSize, j: gj - tY * tileSize };
    });
    return { pts, tx: fx - i0, ty: fy - j0 };
  }
  const blend = (v, tx, ty) => (v[0] * (1 - tx) + v[1] * tx) * (1 - ty) + (v[2] * (1 - tx) + v[3] * tx) * ty;
  // deepest zoom where all four neighbours can be drawn (any tile inside the bounds can, from disk or smoothed)
  const can = store.smooth === false ? avail.has : avail.inBounds;
  function zoomFor(lon, lat) {
    for (let z = avail.maxzoom; z > avail.minzoom; z--) {
      const { pts } = corners(z, lon, lat);
      if (pts.every((p) => can(z, p.tX, p.tY))) return z;
    }
    return avail.minzoom;
  }

  async function elevation(lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !inBox(avail.bounds, lon, lat)) return null;
    const z = zoomFor(lon, lat);
    const { pts, tx, ty } = corners(z, lon, lat);
    const v = [];
    for (const p of pts) {
      const t = await heights(z, p.tX, p.tY);
      if (!t) return null;
      v.push(t[p.j * t.w + p.i]);
    }
    return blend(v, tx, ty);
  }

  return {
    elevation,
    elevations: (list) => Promise.all(list.map(([lon, lat]) => elevation(lon, lat))),
    elevationSync(lon, lat) {
      if (!inBox(avail.bounds, lon, lat)) return null;
      const z = zoomFor(lon, lat);
      const { pts, tx, ty } = corners(z, lon, lat);
      const v = [];
      for (const p of pts) {
        const t = sync.get(z + '/' + p.tX + '/' + p.tY);
        if (!t) return null;
        v.push(t[p.j * t.w + p.i]);
      }
      return blend(v, tx, ty);
    },
    maxzoom: avail.maxzoom,
    cacheSize: () => sync.size,
  };
}
