// Smooth terrain for close views (lane g, 24 Nov 2026). Pure functions: no DOM, no fetch. Used by the ground worker
// (ground/worker.js through ground/core.js), by terrain-sampler.js and by node tests.
//
// Why: the terrain tiles are the 30 m surface model (GLO-30) resampled BILINEAR to web mercator. Bilinear between 30 m
// samples is a quilt of flat-ish patches with a crease every 30 m, and MapLibre draws exactly that, so up close the
// banks show 30 m facets. A tent filter one native cell wide turns the bilinear surface into the cubic B-spline of the
// same 30 m samples (tent * tent = cubic B-spline): smooth slopes, same heights on flat ground, same river level on a
// flat river. Tiles that do not exist on disk (outside the fine box) are made from their ancestor with a Catmull-Rom
// cubic instead of bilinear, then filtered the same way.
// The carved river bed and the weir pit (feat/carve.json, lane g07) are PROTECTED: those pixels keep their exact
// heights and are left out of their neighbours' averages (normalized convolution), so the bed does not rise, the bank
// tops are not pulled down by the bed, and the weir pit keeps its floor.

export const EARTH_C = 40075016.686; // web mercator circumference at the equator, metres (WGS84 a * 2 pi)
export const NATIVE_M = 30; // GLO-30 cell, metres (1 arc-second, 30.8 m at 4.3 S; the tent width, rounded)
export const SMOOTH_FROM = 13; // zooms below this are drawn as they are on disk (their pixels are 38 m or more)
const D2R = Math.PI / 180;

export const lonToU = (lon) => (lon + 180) / 360; // 0..1 across the mercator world
export const latToV = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) / Math.PI) / 2; // 0 north .. 1 south
export const uToLon = (u) => u * 360 - 180;
export const vToLat = (v) => Math.atan(Math.sinh(Math.PI * (1 - 2 * v))) / D2R;
export const lonToTileX = (lon, z) => lonToU(lon) * 2 ** z;
export const latToTileY = (lat, z) => latToV(lat) * 2 ** z;
// metres per pixel of a 256 px tile at zoom z and latitude lat
export const mpp = (z, lat) => (EARTH_C * Math.cos(lat * D2R)) / (256 * 2 ** z);

// Which terrain tiles exist on disk (tiles.json). Every zoom from minzoom to 12 covers the whole `bounds`; a deeper zoom
// exists only inside its range: `manifest["13"] = {x: [min, max], y: [min, max]}`, else the range derived from
// `fine_bounds_z13` / `fine_bounds_z14`. inBounds(z, x, y): the tile touches `bounds` (any zoom up to maxzoom; such a
// tile can always be drawn, from disk or from an ancestor).
const FULL_MAX = 12;
export function tileAvailability(tj) {
  const minz = tj.minzoom ?? 6;
  const ranges = {};
  if (tj.manifest && typeof tj.manifest === 'object') {
    for (const [k, r] of Object.entries(tj.manifest)) if (r && r.x && r.y) ranges[+k] = r;
  } else {
    for (const k of Object.keys(tj)) {
      const m = /^fine_bounds_z(\d+)$/.exec(k);
      if (!m) continue;
      const z = +m[1], b = tj[k];
      ranges[z] = {
        x: [Math.floor(lonToTileX(b[0], z)), Math.floor(lonToTileX(b[2], z))],
        y: [Math.floor(latToTileY(b[3], z)), Math.floor(latToTileY(b[1], z))],
      };
    }
  }
  const listed = Object.keys(ranges).map(Number);
  const fullMax = Math.min(FULL_MAX, tj.maxzoom ?? FULL_MAX);
  const maxzoom = Math.max(fullMax, ...listed);
  const b = tj.bounds || [-180, -85, 180, 85];
  const inBounds = (z, x, y) =>
    z >= minz && z <= maxzoom &&
    x >= Math.floor(lonToTileX(b[0], z)) && x <= Math.floor(lonToTileX(b[2], z)) &&
    y >= Math.floor(latToTileY(b[3], z)) && y <= Math.floor(latToTileY(b[1], z));
  function has(z, x, y) {
    if (z < minz || z > maxzoom) return false;
    if (z <= fullMax) return inBounds(z, x, y);
    const r = ranges[z];
    return !!r && x >= r.x[0] && x <= r.x[1] && y >= r.y[0] && y <= r.y[1];
  }
  return { minzoom: minz, maxzoom, fullMax, ranges, bounds: b, has, inBounds };
}

// Terrarium <-> heights (metres) on RGBA bytes
export function decodeTerrariumRGBA(px, n, out = new Float32Array(n)) {
  for (let i = 0; i < n; i++) out[i] = px[4 * i] * 256 + px[4 * i + 1] + px[4 * i + 2] / 256 - 32768;
  return out;
}
export function encodeTerrariumRGBA(h, n, out = new Uint8ClampedArray(4 * n)) {
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(65535.99, h[i] + 32768));
    const iv = Math.floor(v);
    out[4 * i] = iv >> 8;
    out[4 * i + 1] = iv & 255;
    out[4 * i + 2] = Math.floor((v - iv) * 256);
    out[4 * i + 3] = 255;
  }
  return out;
}

// The tent of half-width hw pixels (one native cell): weights at -R..R. hw <= 1 gives the identity.
export function tentKernel(hw) {
  const R = Math.max(1, Math.ceil(hw - 1e-9) - 1); // the last tap with a weight above zero
  const w = new Float32Array(2 * R + 1);
  for (let d = -R; d <= R; d++) w[d + R] = Math.max(0, 1 - Math.abs(d) / Math.max(hw, 1));
  return { R, w };
}

// Normalized separable convolution of a padded patch (W x H, pad R on every side) -> the inner (W-2R) x (H-2R).
// protect (Uint8Array W x H or null): 1 = keep this pixel's own height and leave it out of every average.
export function smoothPatch(src, W, H, kernel, protect = null) {
  const { R, w } = kernel;
  const iw = W - 2 * R, ih = H - 2 * R;
  const S = new Float32Array(iw * H), M = new Float32Array(iw * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < iw; x++) {
      let s = 0, m = 0;
      for (let k = 0; k <= 2 * R; k++) {
        const i = row + x + k;
        const wk = protect && protect[i] ? 0 : w[k];
        s += wk * src[i];
        m += wk;
      }
      S[y * iw + x] = s;
      M[y * iw + x] = m;
    }
  }
  const out = new Float32Array(iw * ih);
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const c = (y + R) * W + x + R;
      if (protect && protect[c]) {
        out[y * iw + x] = src[c];
        continue;
      }
      let s = 0, m = 0;
      for (let k = 0; k <= 2 * R; k++) {
        const j = (y + k) * iw + x;
        s += w[k] * S[j];
        m += w[k] * M[j];
      }
      out[y * iw + x] = m > 1e-6 ? s / m : src[c];
    }
  }
  return out;
}

// Catmull-Rom weights for a fraction t (they sum to 1; the curve passes through the samples)
function crWeights(t, o, k) {
  const t2 = t * t, t3 = t2 * t;
  o[k] = 0.5 * (-t3 + 2 * t2 - t);
  o[k + 1] = 0.5 * (3 * t3 - 5 * t2 + 2);
  o[k + 2] = 0.5 * (-3 * t3 + 4 * t2 + t);
  o[k + 3] = 0.5 * (t3 - t2);
}

// Resample a grid (W x H) at the positions xs (columns) x ys (rows), in the grid's pixel-centre coordinates (pixel
// i sits at i), with a Catmull-Rom cubic; indices outside the grid are clamped. -> Float32Array ys.length x xs.length
export function resampleCR(src, W, H, xs, ys, out = new Float32Array(xs.length * ys.length)) {
  const nx = xs.length, ny = ys.length;
  const xi = new Int32Array(4 * nx), xw = new Float32Array(4 * nx);
  for (let i = 0; i < nx; i++) {
    const f = Math.floor(xs[i]);
    crWeights(xs[i] - f, xw, 4 * i);
    for (let k = 0; k < 4; k++) xi[4 * i + k] = Math.min(W - 1, Math.max(0, f - 1 + k));
  }
  const yw = new Float32Array(4);
  for (let j = 0; j < ny; j++) {
    const f = Math.floor(ys[j]);
    crWeights(ys[j] - f, yw, 0);
    const r0 = Math.min(H - 1, Math.max(0, f - 1)) * W, r1 = Math.min(H - 1, Math.max(0, f)) * W;
    const r2 = Math.min(H - 1, Math.max(0, f + 1)) * W, r3 = Math.min(H - 1, Math.max(0, f + 2)) * W;
    for (let i = 0; i < nx; i++) {
      let s = 0;
      for (let k = 0; k < 4; k++) {
        const c = xi[4 * i + k];
        s += xw[4 * i + k] * (yw[0] * src[r0 + c] + yw[1] * src[r1 + c] + yw[2] * src[r2 + c] + yw[3] * src[r3 + c]);
      }
      out[j * nx + i] = s;
    }
  }
  return out;
}

// A tile's pixel centres in the coordinates of an ancestor patch: tile (z, x, y), ancestor (az, ax, ay) whose tile
// starts at index m of a patch (m = the patch's margin). With pad p, positions run -p .. 256+p-1.
export function childPositions(z, x, y, az, ax, ay, m, p = 0, size = 256) {
  const k = 2 ** (z - az);
  const xs = new Float64Array(size + 2 * p), ys = new Float64Array(size + 2 * p);
  for (let i = -p; i < size + p; i++) {
    xs[i + p] = ((x * size + i + 0.5) / k - ax * size) - 0.5 + m;
    ys[i + p] = ((y * size + i + 0.5) / k - ay * size) - 0.5 + m;
  }
  return { xs, ys };
}

// Assemble a patch (size + 2m)^2 around tile (x, y) from the tile and its 8 neighbours (tiles = 3 x 3 array, row-major
// from the north-west, each a Float32Array size^2 or null). Missing neighbours repeat the nearest available edge.
export function assemblePatch(tiles, m, size = 256) {
  const P = size + 2 * m;
  const out = new Float32Array(P * P);
  const c = tiles[4];
  if (!c) return null;
  for (let py = 0; py < P; py++) {
    const gy = py - m; // -m .. size+m-1 in the centre tile's pixels
    const ty = gy < 0 ? 0 : gy >= size ? 2 : 1;
    const ly = gy - (ty - 1) * size;
    for (let px = 0; px < P; px++) {
      const gx = px - m;
      const tx = gx < 0 ? 0 : gx >= size ? 2 : 1;
      const lx = gx - (tx - 1) * size;
      const t = tiles[ty * 3 + tx];
      if (t) out[py * P + px] = t[ly * size + lx];
      else {
        // clamp into the centre tile (or an existing edge neighbour)
        const cx = Math.min(size - 1, Math.max(0, gx)), cy = Math.min(size - 1, Math.max(0, gy));
        const ex = tiles[ty * 3 + 1], ey = tiles[3 + tx];
        if (ty !== 1 && tx !== 1 && ex) out[py * P + px] = ex[ly * size + cx];
        else if (ty !== 1 && tx !== 1 && ey) out[py * P + px] = ey[cy * size + lx];
        else out[py * P + px] = c[cy * size + cx];
      }
    }
  }
  return out;
}

// Even-odd fill of polygons into a mask. rings: arrays of [x0, y0, x1, y1, ...] in the mask's pixel coordinates (pixel
// i covers i .. i+1, its centre is i + 0.5). All rings of one call form one shape (holes by parity).
export function fillRings(mask, W, H, rings, value = 1) {
  const edges = [];
  for (const r of rings) {
    const n = r.length >> 1;
    for (let k = 0; k < n; k++) {
      const x0 = r[2 * k], y0 = r[2 * k + 1], x1 = r[2 * ((k + 1) % n)], y1 = r[2 * ((k + 1) % n) + 1];
      if (y0 === y1) continue;
      const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
      if (hi < 0.5 || lo > H - 0.5) continue;
      edges.push(x0, y0, x1, y1);
    }
  }
  if (!edges.length) return 0;
  const xs = [];
  let filled = 0;
  for (let y = 0; y < H; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let e = 0; e < edges.length; e += 4) {
      const y0 = edges[e + 1], y1 = edges[e + 3];
      if ((y0 <= yc && yc < y1) || (y1 <= yc && yc < y0)) xs.push(edges[e] + ((yc - y0) / (y1 - y0)) * (edges[e + 2] - edges[e]));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k] - 0.5)), b = Math.min(W - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      for (let x = a; x <= b; x++) {
        mask[y * W + x] = value;
        filled++;
      }
    }
  }
  return filled;
}

// Thick polyline: every pixel whose centre lies within hw pixels of the line. pts = [x0, y0, x1, y1, ...]
export function strokeLine(mask, W, H, pts, hw, value = 1) {
  let n = 0;
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const ax = pts[k], ay = pts[k + 1], bx = pts[k + 2], by = pts[k + 3];
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - hw)), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + hw));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - hw)), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + hw));
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - ax, py = y + 0.5 - ay;
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / L2));
        const ex = px - t * dx, ey = py - t * dy;
        if (ex * ex + ey * ey <= hw * hw && mask[y * W + x] !== value) {
          mask[y * W + x] = value;
          n++;
        }
      }
    }
  }
  return n;
}

// Distance (pixels) from every cell to the nearest cell where isSrc(mask value) holds: two-pass 3-4 chamfer
// (within about 8 % of the true distance), capped at cap pixels.
export function chamfer(mask, W, H, isSrc, cap = 1e9) {
  const BIG = 3 * cap + 3;
  const d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = isSrc(mask[i]) ? 0 : BIG;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - W] + 3);
        if (x > 0) v = Math.min(v, d[i - W - 1] + 4);
        if (x < W - 1) v = Math.min(v, d[i - W + 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < W - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < H - 1) {
        v = Math.min(v, d[i + W] + 3);
        if (x < W - 1) v = Math.min(v, d[i + W + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + W - 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < W * H; i++) d[i] = Math.min(cap, d[i] / 3);
  return d;
}

// grow a 0/1 mask by one pixel (8 neighbours)
export function dilate(mask, W, H) {
  const out = mask.slice();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < W) out[yy * W + xx] = 1;
        }
      }
    }
  }
  return out;
}

// Running-mean blur of radius r pixels, rows then columns, edges clamped (two calls make a tent of radius 2r).
export function boxBlur(src, W, H, r) {
  if (r < 1) return src;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H), n = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let s = 0;
    for (let k = -r; k <= r; k++) s += src[row + Math.min(W - 1, Math.max(0, k))];
    for (let x = 0; x < W; x++) {
      tmp[row + x] = s / n;
      s += src[row + Math.min(W - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[Math.min(H - 1, Math.max(0, k)) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = s / n;
      s += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
    }
  }
  return out;
}
