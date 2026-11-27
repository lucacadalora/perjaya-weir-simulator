// engine/flood.js (lane b15): river flood extent from the height above the main river (HAND method).
//
// Pure functions, no DOM. Constants come from `floodParams` (params.json flood group or its flat copy) and the weir
// engine's `weirParams`; the few defaults below are marked FALLBACK and are used only while params.json lacks a key.
// Rulings: CONTRACT A7 points 2 and 3 (one tail rating; rises, not levels; only ground beyond the normal river).
//
//   stageAt(q_m3s, floodParams, weirParams) -> rise_m | null
//     the weir engine's tail level (weir.tailwater) minus flood.ref_tail_el, never negative; null without a rating.
//   prepare(G, {grid:'fine', river_poly})   once in the worker: rasterises the river outline onto the grid.
//   extent(G, {grid:'fine', stage_m, stage_up_m, floodParams, river_mask})
//     stage_m: rise of the tail over flood.ref_tail_el (below the weir); stage_up_m: rise of the pond over the normal
//     pond (above the weir). Both in metres, computed by the caller (lane s01). A rise of 0 floods nothing.
//     -> {mask: Uint8Array (1 wet), depth_dm: Int16Array, cells, area_km2, volume_m3, depth_max_m,
//         area_up_km2, area_down_km2, bbox:[c0,r0,c1,r1]|null}
//     wet = height above the main river <= the rise of its side of the weir, connected (8 neighbours) to the main
//     river (the Komering through the weir, never another river in the box); depth = rise - height; cells under
//     min_depth_m are dry; one light 3x3 majority pass. The normal river (land cover class 80, permanent water, and
//     the river outline) carries the connection but is never in the mask, depth, area or volume.
//   handFromDem(dem, dir, acc, cols, rows, threshold) -> Float64Array  (the HAND method itself, used in tests)
//
// What a 30 m surface model cannot show: the river bed under the water on the day it was flown, levees and dykes
// narrower than about 30 m, culverts and drains, and ground under trees and roofs (HAND is measured to tree tops
// and roofs, so wooded and built-up cells look higher and drier than they are). One rise per side of the weir: no
// backwater slope and no flood timing. Not a flood forecast.
import { tailwater } from './weir.js';

// D8 codes as in the grid header (dir_codes): code -> [dc, dr]
const D8 = new Map([[1, [1, 0]], [2, [1, 1]], [4, [0, 1]], [8, [-1, 1]], [16, [-1, 0]], [32, [-1, -1]],
  [64, [0, -1]], [128, [1, -1]]]);

const FALLBACK = { // FALLBACK until params.json carries the key
  ref_tail_el: 78.2,         // FALLBACK flight-day tail EL (weir.tail_flight_el, b18 [C]); b18 adds flood.ref_tail_el
  min_river_km2: 1000,       // FALLBACK seeds: drainage cells with at least this upstream area (the Komering) [A]
  hand_nodata: -32768,
  water_class: 80,           // WorldCover permanent water bodies (grid/lc.json)
  filter: 1,                 // 1 = light majority filter on, 0 = off
  min_depth_m: 0,            // cells shallower than this are not wet (params: flood.min_depth_m)
  max_stage_m: 30,
};

// params.json (lane b18) names first, then this file's older names
const ALIAS = { max_stage_m: 'stage_max_m', min_river_km2: 'river_seed_km2' };

/** Read a flood parameter from a flat or grouped params object; `{v}` leaves are unwrapped. */
export function param(fp, key) {
  if (fp) {
    const names = ALIAS[key] ? [ALIAS[key], key] : [key];
    for (const k of names.flatMap((nm) => [nm, 'flood.' + nm, 'flood_' + nm])) {
      let x = fp[k];
      if (x == null && fp.flood && typeof fp.flood === 'object') x = fp.flood[k];
      if (x != null && typeof x === 'object' && !Array.isArray(x) && 'v' in x) x = x.v;
      if (x != null) return x;
    }
    if (key === 'ref_tail_el') { // until b18 adds flood.ref_tail_el: the flight-day tail level
      let x = fp['weir.tail_flight_el'] ?? (fp.weir && fp.weir.tail_flight_el);
      if (x != null && typeof x === 'object' && 'v' in x) x = x.v;
      if (x != null) return x;
    }
  }
  return FALLBACK[key];
}

/** Rise (m) of the tail over flood.ref_tail_el for a flow below the weir, from the weir engine's tail rating. */
export function stageAt(q, fp, weirParams) {
  if (!weirParams || !weirParams.tail) return null;
  if (!Number.isFinite(q) || q <= 0) return 0;
  const tail = tailwater(q, weirParams);
  if (!Number.isFinite(tail)) return null;
  return Math.max(0, Math.min(+param(fp, 'max_stage_m'), tail - +param(fp, 'ref_tail_el')));
}

/**
 * HAND from a DEM, D8 directions (codes as above) and accumulation: drainage = acc >= threshold;
 * hand = z - z(first drainage cell along D8, or the last cell where D8 stops). Paths leaving the grid get NaN.
 */
export function handFromDem(dem, dir, acc, cols, rows, threshold) {
  const n = cols * rows, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let p = i, steps = 0;
    while (!(acc[p] >= threshold)) {
      const o = D8.get(dir[p]);
      if (!o) break;                      // no flow: the cell is its own end (as r13's toy)
      if (steps++ > n) { p = -1; break; }
      const c = (p % cols) + o[0], r = ((p / cols) | 0) + o[1];
      if (c < 0 || r < 0 || c >= cols || r >= rows) { p = -1; break; }
      p = r * cols + c;
    }
    out[i] = p < 0 ? NaN : dem[i] - dem[p];
  }
  return out;
}

// ---------- the river outline on the grid ----------

/** Rasterise (Multi)Polygon features onto a grid: cells whose centre is inside (even-odd, holes respected). */
export function rasterisePolygons(g, geojson) {
  const { cols, rows, west, north, cell } = g, out = new Uint8Array(cols * rows);
  const feats = geojson && (geojson.features || (geojson.type ? [geojson] : []));
  for (const f of feats || []) {
    const geom = f && (f.geometry || f);
    if (!geom) continue;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
    for (const rings of polys) {
      let r0 = rows, r1 = -1;
      for (const ring of rings) for (const [, la] of ring) {
        const r = (north - la) / cell - 0.5;
        if (r < r0) r0 = r; if (r > r1) r1 = r;
      }
      r0 = Math.max(0, Math.ceil(r0)); r1 = Math.min(rows - 1, Math.floor(r1));
      for (let r = r0; r <= r1; r++) {
        const y = north - (r + 0.5) * cell, xs = [];
        for (const ring of rings) {
          for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
            const [xa, ya] = ring[m], [xb, yb] = ring[k];
            if ((ya > y) !== (yb > y)) xs.push(xa + (y - ya) / (yb - ya) * (xb - xa));
          }
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const c0 = Math.max(0, Math.ceil((xs[k] - west) / cell - 0.5));
          const c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - west) / cell - 0.5));
          for (let c = c0; c <= c1; c++) out[r * cols + c] = 1;
        }
      }
    }
  }
  return out;
}

const RIVER = new WeakMap(); // grid -> Uint8Array of the river outline

/** Called once (in the worker) with the river outline; every later extent on that grid leaves it out. */
export function prepare(G, { grid = 'fine', river_poly = null } = {}) {
  const g = G && G[grid];
  if (!g || !river_poly) return { river_cells: 0 };
  const m = rasterisePolygons(g, river_poly);
  RIVER.set(g, m);
  let k = 0; for (let i = 0; i < m.length; i++) k += m[i];
  return { river_cells: k };
}

// ---------- per-grid preparation (cached) ----------

const PREP = new WeakMap();

function weirCell(g, fp) {
  const lon = +param(fp, 'weir_lon'), lat = +param(fp, 'weir_lat');
  const toCell = (lo, la) => {
    const c = Math.floor((lo - g.west) / g.cell), r = Math.floor((g.north - la) / g.cell);
    return c >= 0 && r >= 0 && c < g.cols && r < g.rows ? r * g.cols + c : -1;
  };
  if (Number.isFinite(lon) && Number.isFinite(lat)) return toCell(lon, lat);
  const w = g.meta && g.meta.weir;
  if (w && Number.isInteger(w.col) && Number.isInteger(w.row)) return w.row * g.cols + w.col;
  return toCell(104.38101, -4.30512); // FALLBACK the weir (lead addendum); the grid header carries it too
}

function downIdx(g, p) {
  const o = D8.get(g.dir[p]);
  if (!o) return -1;
  const c = (p % g.cols) + o[0], r = ((p / g.cols) | 0) + o[1];
  return c < 0 || r < 0 || c >= g.cols || r >= g.rows ? -1 : r * g.cols + c;
}

/** Cells whose D8 path runs through `target` (target included). */
function upstreamOf(g, target) {
  const { cols, rows, dir } = g, n = cols * rows, up = new Uint8Array(n);
  if (target < 0) return up;
  const q = new Int32Array(n);
  let head = 0, tail = 0;
  up[target] = 1; q[tail++] = target;
  while (head < tail) {
    const p = q[head++], pc = p % cols, pr = (p / cols) | 0;
    for (const [code, [dc, dr]] of D8) {
      const c = pc - dc, r = pr - dr; // the neighbour that would flow into p with this code
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      const i = r * cols + c;
      if (!up[i] && dir[i] === code) { up[i] = 1; q[tail++] = i; }
    }
  }
  return up;
}

function prepGrid(g, fp) {
  const key = [param(fp, 'weir_lon'), param(fp, 'weir_lat'), param(fp, 'min_river_km2'),
    param(fp, 'hand_nodata')].join('|');
  const hit = PREP.get(g);
  if (hit && hit.key === key) return hit;
  const { cols, rows, hand, dem, acc } = g, n = cols * rows;
  const nod = +param(fp, 'hand_nodata'), minKm2 = +param(fp, 'min_river_km2');
  const weir = g.dir ? weirCell(g, fp) : -1;
  const up = weir >= 0 ? upstreamOf(g, weir) : new Uint8Array(n);
  // main river: the D8 path below the weir and the large drainage cells above it (the Komering only, so another
  // river in the box never takes the Komering's rise). Without a weir in the grid: every large drainage cell.
  const main = new Uint8Array(n);
  if (weir >= 0) {
    for (let i = 0; i < n; i++) if (up[i] && hand[i] === 0 && (!acc || acc[i] >= minKm2)) main[i] = 1;
    for (let p = weir, k = 0; p >= 0 && k < n; p = downIdx(g, p), k++) main[p] = 1;
  } else {
    for (let i = 0; i < n; i++) if (hand[i] === 0 && (!acc || acc[i] >= minKm2)) main[i] = 1;
  }
  const seeds = [];
  for (let i = 0; i < n; i++) if (main[i]) seeds.push(i);
  // height above the MAIN river (dm): ground minus the main-river cell its D8 path reaches; the grid's own HAND
  // measures to the nearest stream of 50 km2, which would give every tributary the Komering's rise.
  let handMain = hand;
  if (weir >= 0 && dem) {
    handMain = new Int16Array(n);
    const reach = new Int32Array(n).fill(-2), path = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      if (reach[i] !== -2) continue;
      let len = 0, p = i, t = -1;
      while (true) {
        if (main[p]) { t = p; break; }
        if (reach[p] !== -2) { t = reach[p]; break; }
        if (len >= n) break;
        path[len++] = p;
        const q = downIdx(g, p);
        if (q < 0) break;
        p = q;
      }
      for (let k = 0; k < len; k++) reach[path[k]] = t;
      if (main[i]) reach[i] = i;
    }
    for (let i = 0; i < n; i++) {
      const t = reach[i];
      if (t < 0 || dem[i] === -32768 || dem[t] === -32768 || hand[i] === nod) { handMain[i] = nod; continue; }
      handMain[i] = Math.max(0, Math.min(32767, dem[i] - dem[t]));
    }
  }
  const res = { key, weir, up, main, handMain, seeds: Int32Array.from(seeds), nod };
  PREP.set(g, res);
  return res;
}

// ---------- extent ----------

const EMPTY = (n) => ({ mask: new Uint8Array(n), depth_dm: new Int16Array(n), cells: 0, area_km2: 0, volume_m3: 0,
  depth_max_m: 0, area_up_km2: 0, area_down_km2: 0, bbox: null });

/** Ground flooded beyond the normal river for a rise below the weir and a rise above it (metres). */
export function extent(G, { grid = 'fine', stage_m = 0, stage_up_m = 0, floodParams = null, river_mask = null } = {}) {
  const g = G && G[grid];
  if (!g || !g.hand) throw new Error(`flood.extent: grid ${grid} has no HAND`);
  const { cols, rows } = g, n = cols * rows;
  const maxS = +param(floodParams, 'max_stage_m');
  const sDn = Math.min(maxS, Math.max(0, +stage_m || 0)) * 10;     // dm
  const sUp = Math.min(maxS, Math.max(0, +stage_up_m || 0)) * 10;  // dm
  if (sDn <= 0 && sUp <= 0) return EMPTY(n);
  const P = prepGrid(g, floodParams);
  const nod = P.nod, up = P.up, hand = P.handMain;
  const minDm = Math.max(0, +param(floodParams, 'min_depth_m') || 0) * 10;
  const lc = g.lc, wcls = +param(floodParams, 'water_class');
  const outline = river_mask && river_mask.length === n ? river_mask : RIVER.get(g) || null;
  const isRiver = (i) => (lc && lc[i] === wcls) || (outline && outline[i] === 1);

  // depth in dm for one cell, or -1 when it is not wet; normal-river cells pass for the connection at any rise
  const depthDm = (i) => {
    const h = hand[i];
    if (h === nod) return isRiver(i) ? 0 : -1;
    const s = up[i] ? sUp : sDn;
    if (s > 0 && h <= s - minDm) return s - h;
    return isRiver(i) ? 0 : -1;
  };

  const mask = new Uint8Array(n), depth = new Int16Array(n), q = new Int32Array(n);
  let head = 0, tail = 0;
  for (const i of P.seeds) {
    const d = depthDm(i);
    if (d >= 0) { mask[i] = 1; depth[i] = Math.min(32767, Math.round(d)); q[tail++] = i; }
  }
  while (head < tail) {
    const p = q[head++], pc = p % cols, pr = (p / cols) | 0;
    for (let dr = -1; dr <= 1; dr++) {
      const r = pr + dr;
      if (r < 0 || r >= rows) continue;
      for (let dc = -1; dc <= 1; dc++) {
        const c = pc + dc;
        if ((dr === 0 && dc === 0) || c < 0 || c >= cols) continue;
        const i = r * cols + c;
        if (mask[i]) continue;
        const d = depthDm(i);
        if (d >= 0) { mask[i] = 1; depth[i] = Math.min(32767, Math.round(d)); q[tail++] = i; }
      }
    }
  }
  if (+param(floodParams, 'filter')) majority(g, hand, P.main, mask, depth, depthDm, nod, isRiver);
  for (let i = 0; i < n; i++) if (mask[i] && isRiver(i)) { mask[i] = 0; depth[i] = 0; } // the normal river: never returned
  return summarise(g, mask, depth, up);
}
// Light 3x3 majority filter: drop wet cells with at most one wet neighbour (unless they sit on the main river),
// fill dry cells with seven or more neighbours of flooded ground (river cells do not count for the fill),
// one pass, on a copy, inside the wet box.
function majority(g, hand, main, mask, depth, depthDm, nod, isRiver) {
  const { cols, rows } = g;
  let c0 = cols, r0 = rows, c1 = -1, r1 = -1;
  for (let i = 0; i < mask.length; i++) if (mask[i]) {
    const c = i % cols, r = (i / cols) | 0;
    if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
  }
  if (c1 < 0) return;
  c0 = Math.max(0, c0 - 1); r0 = Math.max(0, r0 - 1); c1 = Math.min(cols - 1, c1 + 1); r1 = Math.min(rows - 1, r1 + 1);
  const w = c1 - c0 + 1, h = r1 - r0 + 1, src = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) { // 1 wet ground, 2 normal river (wet for the connection)
    const i = (r + r0) * cols + c + c0;
    src[r * w + c] = mask[i] ? (isRiver(i) ? 2 : 1) : 0;
  }
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      let k = 0, kg = 0;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= h) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (!(dr || dc) || cc < 0 || cc >= w) continue;
          const v = src[rr * w + cc];
          if (v) k++;
          if (v === 1) kg++;
        }
      }
      const i = (r + r0) * cols + c + c0;
      if (src[r * w + c]) {
        if (k <= 1 && !main[i]) { mask[i] = 0; depth[i] = 0; }
      } else if (kg >= 7 && hand[i] !== nod) { // holes in flooded ground only, never islands in the river
        mask[i] = 1; depth[i] = Math.max(0, Math.min(32767, Math.round(depthDm(i))));
      }
    }
  }
}

function summarise(g, mask, depth, up) {
  const { cols } = g;
  let cells = 0, area = 0, areaUp = 0, vol = 0, dmax = 0, c0 = Infinity, r0 = Infinity, c1 = -1, r1 = -1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const r = (i / cols) | 0, c = i - r * cols, a = g.cellAreaKm2(r);
    cells++; area += a; if (up[i]) areaUp += a;
    vol += depth[i] * 0.1 * a * 1e6;
    if (depth[i] > dmax) dmax = depth[i];
    if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
  }
  return { mask, depth_dm: depth, cells, area_km2: area, volume_m3: vol, depth_max_m: dmax / 10,
    area_up_km2: areaUp, area_down_km2: area - areaUp, bbox: cells ? [c0, r0, c1, r1] : null };
}
