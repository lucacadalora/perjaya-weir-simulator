// Flood water, flood tint and reservoir outline. Owner: lane b07 (flood water: lane w, 24 Nov 2026). CONTRACT 4.4, 4.5.
// Flooded land is drawn as water: a 3D sheet with the river's own moving surface (water/surface.js, the same kit as
// the river), its surface at ground + flood depth, so it lies thin and see-through where the flood is shallow and
// muddy and opaque where it is deep, ripples drifting down the water's slope. The draped picture below it keeps
// the crisp line round the flooded ground (and the whole tint when there is no 3D scene). Display only.
// Reads the fields `flood.mask` (fine grid) and `reservoir.mask:<active dam>` (wide grid); draws each into a canvas
// at 2 to 3 times the grid resolution (bilinear + a little blur, so 30 m cells do not look blocky), cropped to the
// wet cells' box, and hands it to a MapLibre `image` source with `updateImage` (a `canvas` source shows nothing on
// terrain in MapLibre 5.24.1: plan/T1-render-findings.md). Never computes a mask (s01 and b15 do).
//
// Sources / layers it adds: 'b07-flood' (raster 'b07-flood'), 'b07-res' (raster 'b07-res'), below 'three' when present.
// window.__b07 = { flood: {version, ms, px, box}, res: {...} } for tests.

import { RIVER } from './water/palette.js';
import { createSheet } from './water/sheet.js';

// Colours (proposed CONTRACT A10): the river's own flood look (palette RIVER.flood), so the legend shows what the
// 3D flood water looks like; the line round the flooded ground is light, so it reads on the satellite base too.
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export function tweak(hex, dSat, dLight) {
  const [r, g, b] = hexRgb(hex).map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0, sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  sat = Math.min(1, Math.max(0, sat + dSat));
  const L = Math.min(1, Math.max(0, l + dLight));
  const C = (1 - Math.abs(2 * L - 1)) * sat, X = C * (1 - Math.abs(((h / 60) % 2) - 1)), m = L - C / 2;
  const [a, bb, c] = h < 60 ? [C, X, 0] : h < 120 ? [X, C, 0] : h < 180 ? [0, C, X] : h < 240 ? [0, X, C] : h < 300 ? [X, 0, C] : [C, 0, X];
  return [a, bb, c].map((v) => Math.round((v + m) * 255));
}

// Depth steps (decimetres): under 0.5 m, 0.5 to 2 m, over 2 m. Shallow flood carries a fine hatch (FLOOD_HATCH).
export const FLOOD_STEPS = [
  { id: 'shallow', max_dm: 5, rgb: tweak(RIVER.flood.shallow, 0.05, 0.08), a: 0.86, key: 'impact.legend.shallow', en: 'Flooded, under 0.5 m' },
  { id: 'mid', max_dm: 20, rgb: tweak(RIVER.flood.body, 0.05, 0.02), a: 0.88, key: 'impact.legend.mid', en: 'Flooded, 0.5 to 2 m' },
  { id: 'deep', max_dm: Infinity, rgb: tweak(RIVER.flood.deep, 0.05, -0.02), a: 0.9, key: 'impact.legend.deep', en: 'Flooded, over 2 m' },
];
export const FLOOD_EDGE = { rgb: tweak(RIVER.floodFoam, 0.1, -0.02), a: 1 }; // the crisp line round the flooded ground
export const FLOOD_HATCH = { rgb: tweak(RIVER.flood.body, 0.1, -0.06), a: 0.95, period: 7 }; // period in picture px
export const RES_STYLE = { fill: [...tweak(RIVER.normal.body, 0.05, 0), 0.16], edge: [...tweak(RIVER.normal.deep, 0.05, -0.05), 0.9] };

const MAX_SIDE = 2048; // longest side of the picture handed to the map (px)
const MAX_PIX = 2.4e6; // and its pixel count
const PAD = 2; // cells of margin around the wet box, so the soft edge is not cut

// --- pure helpers (no DOM) ---

// Box [c0, r0, c1, r1] (inclusive) of the non-zero cells of a mask laid over a cols-wide grid, or null.
export function wetBox(mask, cols) {
  const rows = (mask.length / cols) | 0;
  let r0 = -1, r1 = -1, c0 = cols, c1 = -1;
  for (let r = 0; r < rows; r++) {
    const o = r * cols;
    let first = -1, last = -1;
    for (let c = 0; c < cols; c++) if (mask[o + c]) { first = c; break; }
    if (first < 0) continue;
    for (let c = cols - 1; c >= first; c--) if (mask[o + c]) { last = c; break; }
    if (r0 < 0) r0 = r;
    r1 = r;
    if (first < c0) c0 = first;
    if (last > c1) c1 = last;
  }
  return r0 < 0 ? null : [c0, r0, c1, r1];
}

const stepOf = (dm) => (dm < FLOOD_STEPS[0].max_dm ? 0 : dm < FLOOD_STEPS[1].max_dm ? 1 : 2);

// RGBA pixels (premultiplied-free, one pixel per cell) for the cells [c0-pad .. c1+pad] x [r0-pad .. r1+pad].
// style 'flood': colour by depth step (depth null = the middle step); 'res': light fill, strong colour on edge cells.
// The mask is over the whole grid (stride = cols) or over `local` = {c0, r0, w} only.
export function paintCells({ mask, depth, cols, rows, box, pad = PAD, style = 'flood', local = null }) {
  const [c0, r0, c1, r1] = box;
  const x0 = c0 - pad, y0 = r0 - pad;
  const w = c1 - c0 + 1 + 2 * pad, h = r1 - r0 + 1 + 2 * pad;
  const px = new Uint8ClampedArray(w * h * 4);
  const step = new Int8Array(w * h).fill(-1); // depth step per cell, -1 = dry
  const at = local
    ? (c, r) => (c < local.c0 || r < local.r0 || c >= local.c0 + local.w || r >= local.r0 + local.h ? 0 : mask[(r - local.r0) * local.w + (c - local.c0)])
    : (c, r) => (c < 0 || r < 0 || c >= cols || r >= rows ? 0 : mask[r * cols + c]);
  const lut = FLOOD_STEPS.map((s) => [s.rgb[0], s.rgb[1], s.rgb[2], Math.round(s.a * 255)]);
  const fill = [...RES_STYLE.fill.slice(0, 3), Math.round(RES_STYLE.fill[3] * 255)];
  const edge = [...RES_STYLE.edge.slice(0, 3), Math.round(RES_STYLE.edge[3] * 255)];
  const edge2 = [...RES_STYLE.edge.slice(0, 3), Math.round(RES_STYLE.edge[3] * 0.55 * 255)];
  for (let y = 0; y < h; y++) {
    const r = y0 + y;
    for (let x = 0; x < w; x++) {
      const c = x0 + x;
      if (!at(c, r)) continue;
      let col;
      if (style === 'res') {
        // a two-cell band on the shore: the outline still reads at basin zoom, where a wide cell is about 1 px
        const e1 = !at(c - 1, r) || !at(c + 1, r) || !at(c, r - 1) || !at(c, r + 1);
        const e2 = !e1 && (!at(c - 2, r) || !at(c + 2, r) || !at(c, r - 2) || !at(c, r + 2));
        col = e1 ? edge : e2 ? edge2 : fill;
      } else {
        const st = depth ? stepOf(depth[r * cols + c]) : 1;
        step[y * w + x] = st;
        col = lut[st];
      }
      const k = (y * w + x) * 4;
      px[k] = col[0]; px[k + 1] = col[1]; px[k + 2] = col[2]; px[k + 3] = col[3];
    }
  }
  return { px, step, w, h, x0, y0 };
}

// The flood picture at s times the cell size, in plain JS (no canvas filter): coverage and colour are bilinear between
// cell centres, the ground counts as flooded where coverage >= 0.5 (a smooth shore, not 30 m stairs), a crisp edge line
// `edge` px wide runs inside the shore, and shallow cells carry a diagonal hatch. Returns RGBA (not premultiplied).
// fill = false: the edge line only (the 3D flood water draws the rest).
export function shadeFlood(p, s, edgePx = Math.max(1, Math.round(s * 0.7)), fill = true) {
  const W = Math.max(1, Math.round(p.w * s)), H = Math.max(1, Math.round(p.h * s));
  const out = new Uint8ClampedArray(W * H * 4);
  const inside = new Uint8Array(W * H);
  const { px, step, w, h } = p;
  const ea = Math.round(FLOOD_EDGE.a * 255), ha = Math.round(FLOOD_HATCH.a * 255);
  for (let Y = 0; Y < H; Y++) {
    const v = (Y + 0.5) / s - 0.5, y0 = Math.max(0, Math.min(h - 1, Math.floor(v))), y1 = Math.min(h - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, v - y0));
    for (let X = 0; X < W; X++) {
      const u = (X + 0.5) / s - 0.5, x0 = Math.max(0, Math.min(w - 1, Math.floor(u))), x1 = Math.min(w - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, u - x0));
      const i00 = y0 * w + x0, i10 = y0 * w + x1, i01 = y1 * w + x0, i11 = y1 * w + x1;
      const w00 = (1 - fx) * (1 - fy) * (step[i00] >= 0), w10 = fx * (1 - fy) * (step[i10] >= 0);
      const w01 = (1 - fx) * fy * (step[i01] >= 0), w11 = fx * fy * (step[i11] >= 0);
      const cov = w00 + w10 + w01 + w11;
      if (cov < 0.5) continue;
      const k = (Y * W + X) * 4;
      for (let ch = 0; ch < 4; ch++) {
        out[k + ch] = (px[i00 * 4 + ch] * w00 + px[i10 * 4 + ch] * w10 + px[i01 * 4 + ch] * w01 + px[i11 * 4 + ch] * w11) / cov;
      }
      inside[Y * W + X] = 1;
      if (!fill) {
        out[k + 3] = 0;
        continue;
      }
      const near = step[Math.min(h - 1, Math.round(v)) * w + Math.min(w - 1, Math.max(0, Math.round(u)))];
      if (near === 0 && (X + Y) % FLOOD_HATCH.period === 0) {
        out[k] = FLOOD_HATCH.rgb[0]; out[k + 1] = FLOOD_HATCH.rgb[1]; out[k + 2] = FLOOD_HATCH.rgb[2]; out[k + 3] = ha;
      }
    }
  }
  const e = FLOOD_EDGE.rgb;
  for (let Y = 0; Y < H; Y++) {
    for (let X = 0; X < W; X++) {
      const i = Y * W + X;
      if (!inside[i]) continue;
      let edge = false;
      for (let d = 1; d <= edgePx && !edge; d++) {
        edge = X < d || Y < d || X + d >= W || Y + d >= H || !inside[i - d] || !inside[i + d] || !inside[i - d * W] || !inside[i + d * W];
      }
      if (edge) {
        const k = i * 4;
        out[k] = e[0]; out[k + 1] = e[1]; out[k + 2] = e[2]; out[k + 3] = ea;
      }
    }
  }
  return { px: out, w: W, h: H };
}

// Coarse blocks of flooded cells (block x block cells) as lon/lat points with their wet share, for the basin view,
// where a 30 m tint is too small to see.
export function floodBlocks(mask, g, box, block = 20) {
  const pts = [];
  const cs = g.cellsize_deg || (g.east - g.west) / g.cols;
  for (let br = Math.floor(box[1] / block) * block; br <= box[3]; br += block) {
    for (let bc = Math.floor(box[0] / block) * block; bc <= box[2]; bc += block) {
      let n = 0;
      for (let r = br; r < Math.min(g.rows, br + block); r++) for (let c = bc; c < Math.min(g.cols, bc + block); c++) n += mask[r * g.cols + c] ? 1 : 0;
      if (n) pts.push({ lon: g.west + (bc + block / 2) * cs, lat: g.north - (br + block / 2) * cs, share: n / (block * block) });
    }
  }
  return pts;
}

// Upscale factor: 3 when it fits, never under 1.
export function scaleFor(w, h) {
  return Math.max(1, Math.min(3, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_PIX / (w * h))));
}

// Lon/lat corners (top-left, top-right, bottom-right, bottom-left) of cells x0..x0+w, y0..y0+h of a grid header.
export function cornersOf(g, x0, y0, w, h) {
  const cs = g.cellsize_deg || (g.east - g.west) / g.cols;
  const W = g.west + x0 * cs, E = g.west + (x0 + w) * cs;
  const N = g.north - y0 * cs, S = g.north - (y0 + h) * cs;
  return [[W, N], [E, N], [E, S], [W, S]];
}

// --- flood water (lane w, 24 Nov 2026) ---

// Display choices: how far past the wet cells the water surface reaches (the terrain cuts it there), how fast the
// flood water drifts down its own slope, how much bigger than the wet box a sheet is built (a growing flood reuses it).
export const FLOOD_WATER = Object.freeze({ ring: 3, under: 14, speed_ms: 0.45, depth_m: 1.0, grow: 0.25, min_grow: 24, lift_m: 0.04 });

// The flood's water surface over a box of the grid, for drawing. Pure.
//   mask, depth_dm: the flood field over the whole grid (cols x rows); ground: heights (m) over the box only
//   box [c0, r0, c1, r1] (inclusive). Returns over the box: surface (m) = ground + depth on wet cells, carried
//   `ring` cells past the wet edge (their wet neighbours' mean, so the terrain cuts the water, not the mask), and
//   up to `under` cells further where the ground lies below that surface: the normal river channel, which the flood
//   extent leaves out (A7 point 3) but which is under the same flood water;
//   mask bytes (255 = water may show); flow RGBA bytes: the way down the water surface (R east, G south, 128 = 0),
//   B = 255 where it moves, as water/flowfield.js encodes it.
export function floodSurface({ mask, depth_dm, cols, ground, box, ring = FLOOD_WATER.ring, under = FLOOD_WATER.under }) {
  const [c0, r0, c1, r1] = box;
  const w = c1 - c0 + 1;
  const h = r1 - r0 + 1;
  const surf = new Float32Array(w * h).fill(NaN);
  const show = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gi = (r0 + y) * cols + c0 + x;
    if (!mask[gi]) continue;
    const d = depth_dm ? Math.max(0, depth_dm[gi]) / 10 : 0.5; // no depth known: half a metre
    surf[y * w + x] = ground[y * w + x] + d;
    show[y * w + x] = 255;
  }
  // carry the surface out past the edge, one ring at a time (only the cells next to the last ring are looked at)
  let front = [];
  for (let i = 0; i < w * h; i++) if (show[i]) front.push(i);
  const seen = new Uint8Array(w * h);
  for (let k = 0; k < ring + under && front.length; k++) {
    const add = [];
    for (const i of front) {
      const x = i % w;
      const y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (show[j] || seen[j]) continue;
        let sum = 0;
        let n = 0;
        for (let ey = -1; ey <= 1; ey++) for (let ex = -1; ex <= 1; ex++) {
          const ax = xx + ex;
          const ay = yy + ey;
          if (ax < 0 || ay < 0 || ax >= w || ay >= h || !show[ay * w + ax]) continue;
          sum += surf[ay * w + ax];
          n++;
        }
        // past the first rings only ground under the water carries it on (the river's own channel)
        if (k >= ring && !(ground[j] < sum / n - 0.05)) continue;
        seen[j] = 1;
        add.push(j, sum / n);
      }
    }
    front = [];
    for (let q = 0; q < add.length; q += 2) {
      surf[add[q]] = add[q + 1];
      show[add[q]] = 255;
      front.push(add[q]);
    }
  }
  // everything else: under the ground, never drawn
  for (let i = 0; i < w * h; i++) if (!show[i]) surf[i] = ground[i] - 2;
  // the way down the surface (central differences over wet and ring cells); flat water stays still
  const flow = new Uint8Array(w * h * 4);
  const at = (x, y, i) => (x >= 0 && y >= 0 && x < w && y < h && show[y * w + x] ? surf[y * w + x] : surf[i]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const o = i * 4;
    flow[o] = flow[o + 1] = 128;
    flow[o + 3] = 255;
    if (!show[i]) continue;
    const gx = at(x + 1, y, i) - at(x - 1, y, i);
    const gy = at(x, y + 1, i) - at(x, y - 1, i);
    const g = Math.hypot(gx, gy);
    if (!(g > 1e-4)) continue;
    flow[o] = Math.round(128 - (gx / g) * 127);
    flow[o + 1] = Math.round(128 - (gy / g) * 127);
    flow[o + 2] = 255;
  }
  return { surface: surf, mask: show, flow, w, h };
}

// The 3D flood water: one sheet over the flood's box (grown, so a rising flood reuses it), rebuilt only when the
// flood outgrows it; otherwise its mask, surface and current are copied in. Hidden when nothing is flooded.
function floodWater(ctx) {
  const s3 = ctx.scene3d;
  if (!s3 || !s3.THREE || typeof s3.add !== 'function') return null;
  const THREE = s3.THREE;
  let dem = null;
  let cur = null; // {sheet, handle, box, w, h}
  const stats = { version: null, box: null, rebuilds: 0, ms: null };
  const demP = () => (dem ||= ctx.data.bin('grid/fine.dem.i16').then((b) => new Int16Array(b)).catch((e) => ((dem = null), Promise.reject(e))));

  function hide() {
    if (cur) cur.sheet.mesh.visible = false;
    stats.version = null;
    s3.requestRender();
  }
  async function show(f, g, box) {
    const t0 = performance.now();
    let D;
    try {
      D = await demP();
    } catch (e) {
      return false;
    }
    const inside = cur && box[0] >= cur.box[0] && box[1] >= cur.box[1] && box[2] <= cur.box[2] && box[3] <= cur.box[3];
    const win = inside ? cur.box : grow(box, g);
    const w = win[2] - win[0] + 1;
    const h = win[3] - win[1] + 1;
    const ground = new Float32Array(w * h);
    let gmin = Infinity;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = D[(win[1] + y) * g.cols + win[0] + x];
      const m = v === -32768 ? 0 : v / 10;
      ground[y * w + x] = m;
      if (m < gmin) gmin = m;
    }
    const fs = floodSurface({ mask: f.mask, depth_dm: f.depth_dm || null, cols: g.cols, ground, box: win });
    const base = Math.floor(gmin);
    if (!inside) {
      if (cur) {
        cur.handle.remove();
        cur.sheet.dispose();
      }
      const cs = g.cellsize_deg || (g.east - g.west) / g.cols;
      const d = { west: g.west + win[0] * cs, east: g.west + (win[2] + 1) * cs, north: g.north - win[1] * cs, south: g.north - (win[3] + 1) * cs };
      const [x0, , z0] = s3.toLocal(d.west, d.north, 0);
      const [x1, , z1] = s3.toLocal(d.east, d.south, 0);
      // hug mode with a shifted surface: the sheet lies on `floor` (the flood surface) wherever it is drawn
      const sheet = createSheet(THREE, {
        cols: w, rows: h, ground, groundMin: gmin, mask: fs.mask, width_m: Math.abs(x1 - x0), height_m: Math.abs(z1 - z0),
        name: 'flood-water', floor: fs.surface, lift: FLOOD_WATER.lift_m, minDepth: 0, hugShift: true, hugRef: base,
        depthScale: 3, flow: { data: fs.flow, cols: w, rows: h }, wet: false,
      });
      sheet.mesh.renderOrder = 4; // under the river sheets where the two overlap at the river's edge
      const handle = s3.add(sheet.mesh, { lon: (d.west + d.east) / 2, lat: (d.north + d.south) / 2, el: base });
      sheet.setLevel(base);
      cur = { sheet, handle, box: win, w, h };
      stats.rebuilds++;
    } else {
      cur.sheet.setMask(fs.mask);
      cur.sheet.setFloor(fs.surface);
      cur.sheet.setFlowData(fs.flow);
    }
    cur.sheet.setFlow(FLOOD_WATER.speed_ms, FLOOD_WATER.depth_m);
    cur.sheet.mesh.visible = true;
    Object.assign(stats, { version: f.version ?? null, box: win, ms: Math.round(performance.now() - t0) });
    s3.requestRender();
    return true;
  }
  // the clock: the shared kit's time comes from the river's own frame function (water.js); nothing to do here
  return { show, hide, stats };
}

function grow(b, g) {
  const pc = Math.max(FLOOD_WATER.min_grow, Math.ceil((b[2] - b[0] + 1) * FLOOD_WATER.grow));
  const pr = Math.max(FLOOD_WATER.min_grow, Math.ceil((b[3] - b[1] + 1) * FLOOD_WATER.grow));
  return [Math.max(0, b[0] - pc), Math.max(0, b[1] - pr), Math.min(g.cols - 1, b[2] + pc), Math.min(g.rows - 1, b[3] + pr)];
}

// --- browser part ---

const BLANK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function floodCanvas(p, fill = true) {
  const q = shadeFlood(p, scaleFor(p.w, p.h), undefined, fill);
  const c = document.createElement('canvas');
  c.width = q.w;
  c.height = q.h;
  c.getContext('2d').putImageData(new ImageData(q.px, q.w, q.h), 0, 0);
  return c;
}

function toCanvas(p) {
  const small = document.createElement('canvas');
  small.width = p.w;
  small.height = p.h;
  small.getContext('2d').putImageData(new ImageData(p.px, p.w, p.h), 0, 0);
  const s = scaleFor(p.w, p.h);
  const big = document.createElement('canvas');
  big.width = Math.max(1, Math.round(p.w * s));
  big.height = Math.max(1, Math.round(p.h * s));
  const g = big.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  if ('filter' in g) g.filter = 'blur(' + (0.45 * s).toFixed(2) + 'px)'; // a soft edge, about half a cell
  g.drawImage(small, 0, 0, big.width, big.height);
  return big;
}

// Hand a canvas straight to an image source, skipping the PNG encode and decode of updateImage (which cost about
// 1.2 s for a 1850 x 1710 picture on the test machine). This does what ImageSource.updateImage does once its picture
// has loaded (MapLibre 5.24.1: image = picture, setCoordinates, texture = null so prepare() uploads the new one).
// Returns false when the source does not look like that, and the caller falls back to updateImage.
function setDirect(src, canvas, coords) {
  if (!src || src.type !== 'image' || typeof src.setCoordinates !== 'function' || !src.map || !src.options) return false;
  try {
    if (src._request && src._request.abort) src._request.abort();
    src._request = null;
    src.image = canvas;
    src.options.url = null;
    src.setCoordinates(coords);
    src.texture = null;
    return true;
  } catch (e) {
    return false;
  }
}

const encode = (canvas) =>
  new Promise((res) => {
    if (canvas.toBlob) canvas.toBlob((b) => res(b ? URL.createObjectURL(b) : canvas.toDataURL('image/png')), 'image/png');
    else res(canvas.toDataURL('image/png'));
  });

// One draped picture: an image source + raster layer, redrawn on demand; the newest request wins.
function makeDrape(ctx, id, opacity) {
  const map = ctx.map;
  let url = null, busy = false, next = null;
  const stats = { version: null, ms: null, encode_ms: null, px: null, box: null, shown: false };
  map.addSource(id, { type: 'image', url: BLANK, coordinates: [[104.2, -4.1], [104.55, -4.1], [104.55, -4.5], [104.2, -4.5]] });
  const layer = { id, type: 'raster', source: id, layout: { visibility: 'none' },
    paint: { 'raster-opacity': opacity, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } };
  map.addLayer(layer, map.getLayer('three') ? 'three' : undefined);
  const useFast = !(ctx.query && ctx.query.get && ctx.query.get('b07encode') === '1');
  // the blank picture must have loaded before a direct hand-over, or its late arrival would replace ours
  const ready = new Promise((res) => {
    const t0 = performance.now();
    const poll = () => {
      const s = map.getSource(id);
      if (s && s.loaded && s.loaded()) return res(true);
      if (performance.now() - t0 > 5000) return res(false);
      setTimeout(poll, 25);
    };
    poll();
  });

  async function run(job) {
    busy = true;
    const t0 = performance.now();
    try {
      if (!job) {
        map.setLayoutProperty(id, 'visibility', 'none');
        Object.assign(stats, { version: null, shown: false, box: null, px: null });
      } else {
        const p = job.paint();
        stats.paint_ms = Math.round(performance.now() - t0);
        if (p) {
          const canvas = job.kind === 'flood' ? floodCanvas(p, job.fill !== false) : toCanvas(p);
          stats.canvas_ms = Math.round(performance.now() - t0) - stats.paint_ms;
          const coords = cornersOf(job.g, p.x0, p.y0, p.w, p.h);
          const t1 = performance.now();
          if (useFast && (await ready) && setDirect(map.getSource(id), canvas, coords)) {
            stats.path = 'direct';
          } else {
            const u = await encode(canvas);
            map.getSource(id)?.updateImage({ url: u, coordinates: coords });
            const old = url;
            url = u;
            if (old && old.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(old), 2000);
            stats.path = 'encode';
          }
          stats.encode_ms = Math.round(performance.now() - t1);
          map.setLayoutProperty(id, 'visibility', 'visible');
          Object.assign(stats, { version: job.version, shown: true, box: job.box, px: [canvas.width, canvas.height] });
        }
      }
      stats.ms = Math.round(performance.now() - t0);
      map.triggerRepaint();
    } catch (e) {
      ctx.log('b07 drape failed', id, e && e.message);
    }
    busy = false;
    if (next !== null) {
      const j = next;
      next = null;
      run(j === 'clear' ? null : j);
    }
  }
  return {
    stats,
    draw(job) {
      if (busy) next = job || 'clear';
      else run(job);
    },
  };
}

async function gridMeta(ctx, name) {
  const f = ctx.fields && ctx.fields.get('grid.meta:' + name);
  if (f && f.cols) return f;
  return ctx.data.json('grid/' + name + '.json');
}

export async function init(ctx) {
  const map = ctx.map;
  if (!map || !ctx.fields || typeof map.addSource !== 'function') return;
  const stats = (window.__b07 = window.__b07 || {});
  const flood = makeDrape(ctx, 'b07-flood', 1);
  const res = makeDrape(ctx, 'b07-res', 1);
  // basin view: the flooded blocks as marks that fade out where the tint itself reads (zoom 12 to 13)
  map.addSource('b07-flood-lo', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'b07-flood-lo', type: 'circle', source: 'b07-flood-lo', maxzoom: 13,
    paint: { 'circle-color': 'rgb(' + FLOOD_STEPS[1].rgb.join(',') + ')', 'circle-stroke-color': 'rgb(' + FLOOD_EDGE.rgb.join(',') + ')',
      'circle-stroke-width': 1.2, 'circle-pitch-alignment': 'map',
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, ['+', 2, ['*', 3, ['get', 'share']]], 12, ['+', 5, ['*', 6, ['get', 'share']]]],
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 11.8, 0.9, 13, 0],
      'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 11.8, 1, 13, 0] } }, map.getLayer('three') ? 'three' : undefined);
  const setBlocks = (pts) => {
    stats.blocks = pts.length;
    map.getSource('b07-flood-lo')?.setData({ type: 'FeatureCollection',
      features: pts.map((b) => ({ type: 'Feature', properties: { share: b.share }, geometry: { type: 'Point', coordinates: [b.lon, b.lat] } })) });
  };
  stats.flood = flood.stats;
  stats.res = res.stats;

  let fine = null, wide = null;
  try { fine = await gridMeta(ctx, 'fine'); } catch (e) { ctx.log('b07: fine grid header missing'); }

  // flood water (3D, the river's own surface) and the line round it; the whole tint only without a 3D scene
  const water = floodWater(ctx);
  stats.water = water ? water.stats : null;
  let lastFlood = undefined;
  const onFlood = (f) => {
    if (!fine) return;
    const v = f && f.mask && f.mask.length === fine.cols * fine.rows ? f : null;
    const ver = v ? v.version ?? -1 : null;
    if (v && ver === lastFlood && ver !== -1) return;
    lastFlood = ver;
    const box = v ? wetBox(v.mask, fine.cols) : null;
    if (!box) {
      waiting = null;
      setBlocks([]);
      flood.draw(null);
      return water && water.hide();
    }
    setBlocks(floodBlocks(v.mask, fine, box));
    const paint = () => paintCells({ mask: v.mask, depth: v.depth_dm || null, cols: fine.cols, rows: fine.rows, box });
    if (!water) return flood.draw({ kind: 'flood', version: ver, box, g: fine, paint });
    pour({ v, ver, box, paint });
  };
  // one flood at a time into the 3D water; while one is being poured the newest waiting one wins
  let pouring = false;
  let waiting = null;
  const pour = (job) => {
    if (pouring) return void (waiting = job);
    pouring = true;
    const { v, ver, box, paint } = job;
    water.show(v, fine, box)
      .then((ok) => flood.draw({ kind: 'flood', version: ver, box, g: fine, paint, fill: !ok }), (e) => {
        ctx.log('b07 flood water failed', e && e.message);
        flood.draw({ kind: 'flood', version: ver, box, g: fine, paint });
      })
      .then(() => {
        pouring = false;
        if (lastFlood === null) water.hide(); // the flood went while this one was being poured
        if (waiting) {
          const j = waiting;
          waiting = null;
          if (lastFlood === j.ver) pour(j);
        }
      });
  };
  ctx.fields.on('flood.mask', onFlood);
  if (ctx.fields.get('flood.mask')) onFlood(ctx.fields.get('flood.mask'));

  // the active maker dam's reservoir, as a soft outline
  let offRes = null, lastRes = undefined;
  const onRes = async (r) => {
    if (!r || !r.mask) { lastRes = null; return res.draw(null); }
    if (!wide) {
      try { wide = await gridMeta(ctx, 'wide'); } catch (e) { return; }
    }
    if (r.version != null && r.version === lastRes) return;
    lastRes = r.version;
    const bb = r.bbox;
    const isLocal = bb && r.mask.length === (bb[2] - bb[0] + 1) * (bb[3] - bb[1] + 1);
    if (!isLocal && r.mask.length !== wide.cols * wide.rows) return res.draw(null);
    const local = isLocal ? { c0: bb[0], r0: bb[1], w: bb[2] - bb[0] + 1, h: bb[3] - bb[1] + 1 } : null;
    const box = isLocal ? bb : wetBox(r.mask, wide.cols);
    if (!box) return res.draw(null);
    res.draw({ version: r.version, box, g: wide,
      paint: () => paintCells({ mask: r.mask, cols: wide.cols, rows: wide.rows, box, style: 'res', local }) });
  };
  const follow = (id) => {
    if (offRes) offRes();
    offRes = null;
    lastRes = undefined;
    if (!id) return res.draw(null);
    const name = 'reservoir.mask:' + id;
    offRes = ctx.fields.on(name, onRes);
    onRes(ctx.fields.get(name));
  };
  ctx.store.on('maker.active', follow);
  follow(ctx.store.get('maker.active'));
}
