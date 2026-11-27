// Reservoir engine (lane b12): dam line, reservoir fill, storage curve, interpolators, level-pool routing.
// Pure functions, no DOM. Grid functions take G = { wide, fine } first and name their grid by string.
// Levels (`*_el`) are in the same metres as the grid's surface heights plus nothing, unless the caller passes
// `offset_m` (CONTRACT 2.3: model = EL + offset); the engine never knows the offset by itself.
// Every number below that is not an argument is geometry (earth radius, D8 layout) or a numeric tolerance.

const M_PER_DEG = 111320; // metres per degree of latitude (spherical earth, geometry only)
const NODATA = -32768;

// D8 codes as in site/data/grid/*.json: 1 E, 2 SE, 4 S, 8 SW, 16 W, 32 NW, 64 N, 128 NE.
const D8 = [
  [1, 0, 1], [2, 1, 1], [4, 1, 0], [8, 1, -1], [16, 0, -1], [32, -1, -1], [64, -1, 0], [128, -1, 1],
]; // [code, drow, dcol]
const D8_BY_CODE = new Map(D8.map(([c, dr, dc]) => [c, [dr, dc]]));

function pickGrid(G, name) {
  const g = G && (G[name || 'wide'] || (G.dem ? G : null));
  if (!g || !g.dem) throw new Error(`reservoir: grid '${name}' not loaded`);
  return g;
}

function cellDeg(g) { return g.cell != null ? g.cell : g.cellsize_deg; }

function cellAreaKm2(g, row) {
  if (typeof g.cellAreaKm2 === 'function') return g.cellAreaKm2(row);
  const c = cellDeg(g);
  const lat = g.north - (row + 0.5) * c;
  return (c * M_PER_DEG) * (c * M_PER_DEG * Math.cos(lat * Math.PI / 180)) / 1e6;
}

// metres per cell, east and north, at a row
function cellMetres(g, row) {
  const c = cellDeg(g);
  const lat = g.north - (row + 0.5) * c;
  return { dx: c * M_PER_DEG * Math.cos(lat * Math.PI / 180), dy: c * M_PER_DEG };
}

function zAt(g, idx) { // metres or NaN
  const v = g.dem[idx];
  return v === NODATA ? NaN : v / 10;
}

// bilinear ground height at fractional cell coordinates (col, row measured at cell centres)
function groundAt(g, fc, fr) {
  const c0 = Math.floor(fc), r0 = Math.floor(fr);
  if (c0 < 0 || r0 < 0 || c0 >= g.cols - 1 || r0 >= g.rows - 1) {
    const c = Math.min(g.cols - 1, Math.max(0, Math.round(fc)));
    const r = Math.min(g.rows - 1, Math.max(0, Math.round(fr)));
    if (fc < -0.5 || fr < -0.5 || fc > g.cols - 0.5 || fr > g.rows - 0.5) return NaN;
    return zAt(g, r * g.cols + c);
  }
  const tx = fc - c0, ty = fr - r0, i = r0 * g.cols + c0;
  const a = zAt(g, i), b = zAt(g, i + 1), c = zAt(g, i + g.cols), d = zAt(g, i + g.cols + 1);
  if ([a, b, c, d].some(Number.isNaN)) return zAt(g, Math.round(fr) * g.cols + Math.round(fc));
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

function fracToLonLat(g, fc, fr) {
  const c = cellDeg(g);
  return { lon: g.west + (fc + 0.5) * c, lat: g.north - (fr + 0.5) * c };
}

function lonLatToFrac(g, lon, lat) {
  const c = cellDeg(g);
  return { fc: (lon - g.west) / c - 0.5, fr: (g.north - lat) / c - 0.5 };
}

function downstreamIdx(g, idx) {
  if (!g.dir) return -1;
  const off = D8_BY_CODE.get(g.dir[idx]);
  if (!off) return -1;
  const r = Math.floor(idx / g.cols) + off[0], c = (idx % g.cols) + off[1];
  if (r < 0 || c < 0 || r >= g.rows || c >= g.cols) return -1;
  return r * g.cols + c;
}

// the inflowing neighbour with the largest upstream area (or the lowest one when acc is absent)
function upstreamIdx(g, idx) {
  if (!g.dir) return -1;
  const r = Math.floor(idx / g.cols), c = idx % g.cols;
  let best = -1, bestScore = -Infinity;
  for (const [code, dr, dc] of D8) {
    const rr = r - dr, cc = c - dc; // neighbour that would flow to us with this code
    if (rr < 0 || cc < 0 || rr >= g.rows || cc >= g.cols) continue;
    const j = rr * g.cols + cc;
    if (g.dir[j] !== code) continue;
    const score = g.acc ? g.acc[j] : -zAt(g, j);
    if (score > bestScore) { bestScore = score; best = j; }
  }
  return best;
}

// smoothed downstream direction at idx as a unit vector in metres (east, north)
function streamDirection(g, idx, smooth_m) {
  const r0 = Math.floor(idx / g.cols);
  const { dx, dy } = cellMetres(g, r0);
  const steps = Math.max(2, Math.round(smooth_m / Math.min(dx, dy)));
  let down = idx, up = idx;
  for (let k = 0; k < steps; k++) { const n = downstreamIdx(g, down); if (n < 0) break; down = n; }
  for (let k = 0; k < steps; k++) { const n = upstreamIdx(g, up); if (n < 0) break; up = n; }
  if (down === up) return null;
  const ex = ((down % g.cols) - (up % g.cols)) * dx;
  const ny = -(Math.floor(down / g.cols) - Math.floor(up / g.cols)) * dy;
  const L = Math.hypot(ex, ny);
  return L > 0 ? { e: ex / L, n: ny / L } : null;
}

function bearingOf(e, n) { return (Math.atan2(e, n) * 180 / Math.PI + 360) % 360; }

/**
 * damLine(G, {grid, idx, crest_el, offset_m, max_side_m, smooth_m, dir_deg})
 * A straight dam across the valley at idx, at right angles to the smoothed stream direction, marched both ways
 * until the ground reaches the crest. ok:false with a reason when it does not close within max_side_m each side.
 */
export function damLine(G, args) {
  const { grid = 'wide', idx, crest_el, offset_m = 0, max_side_m = 4000, smooth_m = 500 } = args || {};
  const g = pickGrid(G, grid);
  const crest = crest_el + offset_m;
  const fail = (reason, extra) => ({ ok: false, reason, a: null, b: null, length_m: 0, bearing_deg: null,
    height_m: 0, base_el: null, profile: [], idx, ...extra });
  if (!(idx >= 0 && idx < g.cols * g.rows)) return fail('bad_cell');
  if (!Number.isFinite(crest)) return fail('bad_crest');
  let down = null;
  if (Number.isFinite(args.dir_deg)) {
    const t = args.dir_deg * Math.PI / 180; down = { e: Math.sin(t), n: Math.cos(t) };
  } else down = streamDirection(g, idx, smooth_m);
  if (!down) return fail('no_stream_direction');
  const row = Math.floor(idx / g.cols), col = idx % g.cols;
  const { dx, dy } = cellMetres(g, row);
  // across-valley unit vector: left bank looking downstream is (-n, e) rotated... use right-hand normal
  const ax = { e: -down.n, n: down.e }; // 90 degrees anticlockwise from downstream = left bank side
  const step = Math.min(dx, dy) / 2;
  const base = groundAt(g, col, row);
  if (!Number.isFinite(base)) return fail('no_ground');
  if (base >= crest) return fail('crest_below_ground', { base_el: base - offset_m });
  const march = (sign) => {
    const pts = [];
    let prevD = 0, prevZ = base;
    for (let d = step; d <= max_side_m + 1e-9; d += step) {
      const fc = col + sign * ax.e * d / dx, fr = row - sign * ax.n * d / dy;
      const z = groundAt(g, fc, fr);
      if (!Number.isFinite(z)) return { ok: false, reason: 'off_grid' };
      if (z >= crest) { // interpolate the crossing
        const t = (crest - prevZ) / (z - prevZ);
        const dEnd = prevD + t * (d - prevD);
        pts.push({ d: dEnd, z: crest });
        return { ok: true, pts, end: dEnd };
      }
      pts.push({ d, z }); prevD = d; prevZ = z;
    }
    return { ok: false, reason: 'valley_open' };
  };
  const L = march(+1), R = march(-1);
  if (!L.ok || !R.ok) return fail(!L.ok ? `${L.reason}_left` : `${R.reason}_right`, { dir_deg: bearingOf(down.e, down.n) });
  const toLonLat = (sign, d) => fracToLonLat(g, col + sign * ax.e * d / dx, row - sign * ax.n * d / dy);
  const a = toLonLat(+1, L.end), b = toLonLat(-1, R.end);
  const length = L.end + R.end;
  const profile = [];
  for (let i = L.pts.length - 1; i >= 0; i--) profile.push({ d_m: L.end - L.pts[i].d, ground_m: L.pts[i].z - offset_m });
  profile.push({ d_m: L.end, ground_m: base - offset_m });
  for (const p of R.pts) profile.push({ d_m: L.end + p.d, ground_m: p.z - offset_m });
  let minZ = Infinity;
  for (const p of profile) minZ = Math.min(minZ, p.ground_m);
  return {
    ok: true, a, b, length_m: length, bearing_deg: bearingOf(-ax.e, -ax.n), // from a (left bank) to b (right bank)
    height_m: crest_el - minZ, base_el: minZ, profile,
    idx, grid, dir_deg: bearingOf(down.e, down.n), crest_el,
  };
}

// ---- wall and seed --------------------------------------------------------------------------------------------

// mark the dam line's cells (dense sampling, so the wall is at least 8-connected and stops a 4-connected fill),
// extended by `extend` cells beyond each end
function rasterWall(g, line, extend = 2) {
  const wall = new Uint8Array(g.cols * g.rows);
  const pa = lonLatToFrac(g, line.a.lon, line.a.lat), pb = lonLatToFrac(g, line.b.lon, line.b.lat);
  const len = Math.hypot(pb.fc - pa.fc, pb.fr - pa.fr) || 1;
  const ux = (pb.fc - pa.fc) / len, uy = (pb.fr - pa.fr) / len;
  const n = Math.ceil((len + 2 * extend) * 4) + 1;
  for (let k = 0; k <= n; k++) {
    const s = -extend + k * (len + 2 * extend) / n;
    const c = Math.round(pa.fc + ux * s), r = Math.round(pa.fr + uy * s);
    if (c >= 0 && r >= 0 && c < g.cols && r < g.rows) wall[r * g.cols + c] = 1;
  }
  return wall;
}

// the lowest non-wall cell close to idx on the upstream side of the line
function findSeed(g, idx, line, wall) {
  const row = Math.floor(idx / g.cols), col = idx % g.cols;
  let down = null;
  if (Number.isFinite(line && line.dir_deg)) {
    const t = line.dir_deg * Math.PI / 180; down = { e: Math.sin(t), n: Math.cos(t) };
  } else down = streamDirection(g, idx, 500);
  // first try the river itself: walk upstream until off the wall
  let u = idx;
  for (let k = 0; k < 8 && u >= 0 && wall[u]; k++) u = upstreamIdx(g, u);
  if (u >= 0 && !wall[u] && Number.isFinite(zAt(g, u))) {
    if (!down) return u;
    const dc = (u % g.cols) - col, dr = Math.floor(u / g.cols) - row;
    if (dc * down.e - dr * down.n < 0) return u;
  }
  if (!down) return -1;
  let best = -1, bestZ = Infinity;
  for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) {
    const r = row + dr, c = col + dc;
    if (r < 0 || c < 0 || r >= g.rows || c >= g.cols) continue;
    const j = r * g.cols + c;
    if (wall[j] || dc * down.e - dr * down.n >= 0) continue;
    const z = zAt(g, j);
    if (z < bestZ) { bestZ = z; best = j; }
  }
  return best;
}

function lineFor(G, g, args, level) {
  if (args.line && args.line.ok && args.line.a && args.line.b) return args.line;
  const l = damLine(G, { grid: args.grid, idx: args.idx, crest_el: level, offset_m: 0, dir_deg: args.dir_deg });
  return l.ok ? l : null;
}

// `line: false` means no wall and the seed is idx itself (a natural basin, or a test)
function wallAndSeed(G, g, args, level) {
  const N = g.cols * g.rows;
  if (args.line === false) return { wall: new Uint8Array(N), seed: args.idx >= 0 && args.idx < N ? args.idx : -1 };
  const line = lineFor(G, g, args, level);
  if (!line) return { reason: 'no_line' };
  const wall = rasterWall(g, line);
  return { wall, seed: findSeed(g, args.idx, line, wall), line };
}

// cells the water must not reach from the pond: the river below the dam (traced down the flow directions) and,
// when there is a dam, the edge of the grid. Reaching one means the pond spills round the dam or leaves the box.
function escapeCells(g, idx, wall) {
  const esc = new Uint8Array(g.cols * g.rows);
  let i = idx;
  for (let k = 0; k < 20000 && i >= 0; k++) { if (!wall[i]) esc[i] = 1; i = downstreamIdx(g, i); }
  return esc;
}

// priority flood from the seed: every reached cell gets its lowest connecting pass height (decimetres). Stops at
// the top level, or at the first escape cell (its pass is the rim). Cells come out in nondecreasing pass order.
function priorityFlood(g, wall, seed, topDm, escape, edges) {
  const N = g.cols * g.rows, C = g.cols, R = g.rows;
  const lo = g.dem[seed], nb = Math.max(1, Math.ceil(topDm) - lo + 1);
  const head = new Int32Array(nb).fill(-1);
  const next = new Int32Array(N);
  const seen = new Uint8Array(N);
  const order = new Int32Array(N);
  const passOf = new Int32Array(N);
  let no = 0, rimDm = Infinity, leak = null;
  const push = (j, p) => { const b = p - lo; next[j] = head[b]; head[b] = j; passOf[j] = p; };
  seen[seed] = 1; push(seed, lo);
  outer: for (let b = 0; b < nb; b++) {
    while (head[b] >= 0) {
      const i = head[b]; head[b] = next[i];
      const p = passOf[i];
      const r = (i / C) | 0, c = i - r * C;
      // 'spill': the water got over a saddle and runs down the other side (or down the river below the dam);
      // 'edge': the pond itself rises to the edge of the grid, so what lies beyond is unknown
      if (escape && escape[i]) { rimDm = p; leak = 'spill'; break outer; }
      if (edges && (r === 0 || c === 0 || r === R - 1 || c === C - 1)) {
        rimDm = p; leak = g.dem[i] < p ? 'spill' : 'edge'; break outer;
      }
      order[no++] = i;
      const visit = (j) => {
        if (seen[j] || wall[j]) return;
        const v = g.dem[j];
        if (v === NODATA || !(v < topDm)) return;
        seen[j] = 1; push(j, v > p ? v : p);
      };
      if (c > 0) visit(i - 1);
      if (c < C - 1) visit(i + 1);
      if (r > 0) visit(i - C);
      if (r < R - 1) visit(i + C);
    }
  }
  if (leak) while (no > 0 && passOf[order[no - 1]] >= rimDm) no--; // nothing at or above the rim stays in
  return { order, passOf, no, rimDm, leak };
}

// The pond's cells and their effective ground. The flood runs to the dam's crest when the line carries one (so the
// curve and every fill share one set of cells), else to the level asked. The base is the lowest ground along the dam
// line (the dam foot on the river bed), never above the seed. Effective ground = max(ground, base), and the seed
// cell sits at the base: an empty lake reads the river bed at the dam and the volume rises strictly from it.
// Hollows inside the pond (pits of the surface model) hold water from their own ground up, not as a sudden step
// when the level reaches their rim.
function pondFor(G, g, args, level, offset_m) {
  const { wall, seed, reason, line } = wallAndSeed(G, g, args, level);
  if (reason) return { reason };
  if (seed < 0) return { reason: 'no_seed' };
  const zSeed = g.dem[seed] / 10;
  let base = Number.isFinite(args.base_el) ? args.base_el + offset_m
    : (line && Number.isFinite(line.base_el) ? line.base_el + offset_m : zSeed);
  base = Math.min(base, zSeed);
  if (!(base < level)) return { reason: 'level_below_base', base };
  let top = level;
  if (line && Number.isFinite(line.crest_el)) top = Math.max(top, line.crest_el + offset_m);
  const dam = args.line !== false;
  const escape = dam ? escapeCells(g, args.idx, wall) : null;
  const f = priorityFlood(g, wall, seed, top * 10, escape, dam);
  // cells sorted by effective ground (counting sort on decimetres; bucket 0 holds everything clamped to the base)
  const baseDm = base * 10, b0 = Math.floor(baseDm);
  const key = (i) => (i === seed ? 0 : Math.max(0, g.dem[i] - b0));
  let maxK = 0;
  for (let q = 0; q < f.no; q++) { const k = key(f.order[q]); if (k > maxK) maxK = k; }
  const count = new Int32Array(maxK + 2);
  for (let q = 0; q < f.no; q++) count[key(f.order[q]) + 1]++;
  for (let k = 0; k <= maxK; k++) count[k + 1] += count[k];
  const cells = new Int32Array(f.no);
  for (let q = 0; q < f.no; q++) { const i = f.order[q]; cells[count[key(i)]++] = i; }
  const zEff = (i) => (i === seed ? base : Math.max(g.dem[i] / 10, base));
  const rim = f.leak ? f.rimDm / 10 : Infinity;
  return { seed, base, cells, n: f.no, zEff, rim, leak: f.leak };
}

const empty = (n) => ({ mask: new Uint8Array(n), cells: 0, area_km2: 0, volume_m3: 0, mean_depth_m: 0,
  max_depth_m: 0, bbox: null, rim_el: null, leak: null });

/**
 * fillReservoir(G, {grid, idx, level_el, line, offset_m, base_el?})
 * The pond behind the dam line (a wall) at a level: cells 4-connected to a seed just upstream of the line, below
 * the crest, whose effective ground (see pondFor) is below the level. When the pond would reach the river below the
 * dam or the grid edge first, it is held at that rim: `leak` says how ('spill' round the dam or over a saddle, or
 * 'edge' of the grid), `rim_el` the level. `base_el` in the result is the dam foot the lake starts from.
 * `line: false` fills from idx with no wall and no rim.
 */
export function fillReservoir(G, args) {
  const { grid = 'wide', level_el, offset_m = 0 } = args || {};
  const g = pickGrid(G, grid);
  const N = g.cols * g.rows, C = g.cols;
  const level = level_el + offset_m;
  if (!Number.isFinite(level)) return { ...empty(N), reason: 'bad_level' };
  const p = pondFor(G, g, { ...args, grid }, level, offset_m);
  if (p.reason) return { ...empty(N), reason: p.reason, base_el: Number.isFinite(p.base) ? p.base - offset_m : null };
  const top = Math.min(level, p.rim);
  const mask = new Uint8Array(N);
  let n = 0, area = 0, vol = 0, maxD = 0, c0 = C, r0 = g.rows, c1 = -1, r1 = -1;
  for (let q = 0; q < p.n; q++) {
    const i = p.cells[q], z = p.zEff(i);
    if (!(z < top)) break;
    const r = (i / C) | 0, c = i - r * C;
    const a = cellAreaKm2(g, r), d = top - z;
    mask[i] = 1; n++;
    area += a; vol += a * 1e6 * d;
    if (d > maxD) maxD = d;
    if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
  }
  const held = p.leak && p.rim < level;
  return { mask, cells: n, area_km2: area, volume_m3: vol, mean_depth_m: area > 0 ? vol / (area * 1e6) : 0,
    max_depth_m: maxD, bbox: n ? [c0, r0, c1, r1] : null, level_el: top - offset_m, base_el: p.base - offset_m,
    rim_el: p.leak ? p.rim - offset_m : null, leak: held ? p.leak : null, seed: p.seed };
}

/**
 * storageCurve(G, {grid, idx, crest_el, line, steps, base_el, offset_m})
 * Levels from the dam foot (lowest ground along the line, see pondFor) to the crest, or to the rim when the pond
 * spills round the dam first (then `leak` and `rim_el` are set), every 0.1 m by default (or `steps` levels).
 * V(h) = sum area x (h - effective ground), A(h) = sum area, over the pond's cells below h; V rises strictly.
 */
export function storageCurve(G, args) {
  const { grid = 'wide', crest_el, offset_m = 0 } = args || {};
  const g = pickGrid(G, grid);
  const C = g.cols;
  const crest = crest_el + offset_m;
  const out = { level_el: [], area_km2: [], volume_m3: [], cells: 0, base_el: null, rim_el: null, leak: null };
  if (!Number.isFinite(crest)) return { ...out, reason: 'bad_crest' };
  const p = pondFor(G, g, { ...args, grid }, crest, offset_m);
  if (p.reason) return { ...out, reason: p.reason };
  const top = Math.min(crest, p.rim);
  const baseM = p.base;
  let steps = args.steps;
  if (!(steps >= 2)) steps = Math.min(4001, Math.max(2, Math.round((top - baseM) / 0.1) + 1));
  let q = 0, sumA = 0, sumAZ = 0;
  for (let k = 0; k < steps; k++) {
    const h = baseM + (top - baseM) * k / (steps - 1);
    while (q < p.n && p.zEff(p.cells[q]) < h) {
      const i = p.cells[q++];
      const a = cellAreaKm2(g, (i / C) | 0);
      sumA += a; sumAZ += a * p.zEff(i);
    }
    out.level_el.push(h - offset_m);
    out.area_km2.push(sumA);
    out.volume_m3.push(Math.max(0, (sumA * h - sumAZ) * 1e6));
  }
  out.cells = q;
  out.base_el = baseM - offset_m;
  if (p.leak && p.rim < crest) { out.leak = p.leak; out.rim_el = p.rim - offset_m; }
  return out;
}

// ---- interpolators --------------------------------------------------------------------------------------------

function seg(xs, x) { // index k with xs[k] <= x < xs[k+1], clamped
  let lo = 0, hi = xs.length - 1;
  if (x <= xs[0]) return 0;
  if (x >= xs[hi]) return Math.max(0, hi - 1);
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  return lo;
}

/** volume (m3) at a level; 0 below the curve, extended with the top area above it */
export function volumeAt(curve, level_el) {
  const L = curve && curve.level_el, V = curve && curve.volume_m3, A = curve && curve.area_km2;
  if (!L || !L.length || !Number.isFinite(level_el)) return 0;
  const n = L.length - 1;
  if (level_el <= L[0]) return 0;
  if (level_el >= L[n]) return V[n] + A[n] * 1e6 * (level_el - L[n]);
  const k = seg(L, level_el), t = (level_el - L[k]) / (L[k + 1] - L[k] || 1);
  return V[k] + t * (V[k + 1] - V[k]);
}

/** water surface area (km2) at a level */
export function areaAt(curve, level_el) {
  const L = curve && curve.level_el, A = curve && curve.area_km2;
  if (!L || !L.length || !Number.isFinite(level_el)) return 0;
  const n = L.length - 1;
  if (level_el <= L[0]) return 0;
  if (level_el >= L[n]) return A[n];
  const k = seg(L, level_el), t = (level_el - L[k]) / (L[k + 1] - L[k] || 1);
  return A[k] + t * (A[k + 1] - A[k]);
}

/** level at a volume; the curve's lowest level when empty, extended with the top area above the top */
export function levelAt(curve, volume_m3) {
  const L = curve && curve.level_el, V = curve && curve.volume_m3, A = curve && curve.area_km2;
  if (!L || !L.length) return NaN;
  const n = L.length - 1;
  if (!(volume_m3 > 0)) return L[0];
  if (volume_m3 >= V[n]) return A[n] > 0 ? L[n] + (volume_m3 - V[n]) / (A[n] * 1e6) : L[n];
  const k = seg(V, volume_m3);
  // volumes may repeat while the area is still 0: step to the last equal entry
  let j = k; while (j + 1 < n && V[j + 1] <= volume_m3) j++;
  const dv = V[j + 1] - V[j];
  return dv > 0 ? L[j] + (volume_m3 - V[j]) / dv * (L[j + 1] - L[j]) : L[j + 1];
}

// ---- routing --------------------------------------------------------------------------------------------------

/** spill over a free crest, Q = Cd B h^1.5 */
export function spillFlow(head_m, width_m, cd) {
  return head_m > 0 && width_m > 0 && cd > 0 ? cd * width_m * Math.pow(head_m, 1.5) : 0;
}

/** head over the crest at which the spill equals q (the pool's equilibrium for a steady inflow) */
export function spillHeadFor(q_m3s, width_m, cd) {
  return q_m3s > 0 && width_m > 0 && cd > 0 ? Math.pow(q_m3s / (cd * width_m), 2 / 3) : 0;
}

/** open-water evaporation in m3 per day from a pan rate, a pan coefficient and an area */
export function evapLoss({ pan_mm_d, pan_coef = 1, area_km2 }) {
  return (pan_mm_d > 0 && area_km2 > 0) ? pan_mm_d / 1000 * pan_coef * area_km2 * 1e6 : 0;
}

/**
 * levelPoolStep({v1_m3, i1_m3s, i2_m3s, dt_s, outflow(v) -> m3s, method 'puls'|'euler', tol})
 * Puls (trapezoid): V2 = V1 + dt ((I1 + I2)/2 - (O(V1) + O(V2))/2), solved by bisection on V2 (O rises with V).
 * Euler: V2 = V1 + dt (I1 - O(V1)). The volume never goes negative: the outflow is then cut to what is there.
 * Returns {v2_m3, o1_m3s, o2_m3s, o_mean_m3s, cut}.
 */
export function levelPoolStep({ v1_m3, i1_m3s, i2_m3s = i1_m3s, dt_s, outflow, method = 'puls', tol = 1e-9 }) {
  const v1 = Math.max(0, v1_m3 || 0);
  const o1 = outflow(v1);
  if (method === 'euler') {
    const v2 = v1 + dt_s * (i1_m3s - o1);
    if (v2 >= 0) return { v2_m3: v2, o1_m3s: o1, o2_m3s: outflow(v2), o_mean_m3s: o1, cut: false };
    return { v2_m3: 0, o1_m3s: o1, o2_m3s: outflow(0), o_mean_m3s: v1 / dt_s + i1_m3s, cut: true };
  }
  const iMean = (i1_m3s + i2_m3s) / 2;
  const f = (v2) => v2 - v1 - dt_s * (iMean - (o1 + outflow(v2)) / 2);
  if (f(0) >= 0) { // even an empty pond at the end cannot pay the outflow: empty it, cut the outflow
    return { v2_m3: 0, o1_m3s: o1, o2_m3s: outflow(0), o_mean_m3s: v1 / dt_s + iMean, cut: true };
  }
  let lo = 0, hi = Math.max(v1 + dt_s * Math.max(iMean, 0), 1);
  while (f(hi) < 0) hi *= 2;
  for (let k = 0; k < 200 && hi - lo > tol * Math.max(1, hi); k++) {
    const m = (lo + hi) / 2;
    if (f(m) < 0) lo = m; else hi = m;
  }
  const v2 = (lo + hi) / 2, o2 = outflow(v2);
  return { v2_m3: v2, o1_m3s: o1, o2_m3s: o2, o_mean_m3s: (o1 + o2) / 2, cut: false };
}

/**
 * routeStep({curve, volume_m3, crest_el, spill_width_m, spill_cd, release_m3s, evap_mm_day, pan_coef, method},
 *           inflow_m3s, dt_s) -> {volume_m3, level_el, release_m3s, spill_m3s, evap_m3s}
 * Level-pool step with a constant inflow over the step; outflow = constant release + free spill over the crest +
 * open-water evaporation (evap_mm_day x pan_coef x area). Rates returned are the step means. Never negative.
 */
export function routeStep(state, inflow_m3s, dt_s) {
  const { curve, crest_el, spill_width_m = 0, spill_cd = 0, release_m3s = 0, evap_mm_day = 0, pan_coef = 1,
    method = 'puls' } = state || {};
  const evapRate = Math.max(0, evap_mm_day) * pan_coef / 1000 / 86400; // m per second
  const parts = (v) => {
    const h = levelAt(curve, v);
    const spill = Number.isFinite(crest_el) ? spillFlow(h - crest_el, spill_width_m, spill_cd) : 0;
    const evap = v > 0 ? evapRate * areaAt(curve, h) * 1e6 : 0;
    const rel = v > 0 ? Math.max(0, release_m3s) : 0;
    return { h, spill, evap, rel };
  };
  const outflow = (v) => { const p = parts(v); return p.spill + p.evap + p.rel; };
  const inflow = Math.max(0, inflow_m3s || 0);
  const r = levelPoolStep({ v1_m3: state.volume_m3, i1_m3s: inflow, i2_m3s: inflow, dt_s, outflow, method });
  const p1 = parts(Math.max(0, state.volume_m3 || 0)), p2 = parts(r.v2_m3);
  const w = method === 'euler' ? [1, 0] : [0.5, 0.5];
  let spill = w[0] * p1.spill + w[1] * p2.spill;
  let evap = w[0] * p1.evap + w[1] * p2.evap;
  let rel = w[0] * p1.rel + w[1] * p2.rel;
  if (r.cut) { // share what water there was in proportion to the wanted outflows
    const want = spill + evap + rel;
    const k = want > 0 ? r.o_mean_m3s / want : 0;
    spill *= k; evap *= k; rel *= k;
  }
  return { volume_m3: r.v2_m3, level_el: p2.h, release_m3s: rel, spill_m3s: spill, evap_m3s: evap };
}
