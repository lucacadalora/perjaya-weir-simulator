// Grid engine (lane b11). Pure functions over the terrain and hydrology grids, CONTRACT 4.8.
// No DOM, no window, no imports. Runs in the worker and in node tests.
//
// Grid object: { name, west, south, east, north, cols, rows, cell (degrees), dem (Int16Array, dm),
//   dir (Uint8Array, D8), acc (Float32Array, km2) | null, hand (Int16Array, dm) | null, lc (Uint8Array) | null,
//   meta (the json header), d8 {dc, dr, ok} (code -> neighbour offset, read from meta.dir_codes),
//   rowAreaKm2 (Float64Array), cellAreaKm2(row) }
// Row-major from the north-west corner. Cell centres: lon = west + (col + 0.5) cell, lat = north - (row + 0.5) cell.
//
// Functions that need a grid by name take G = { wide, fine, ... } first and an args object naming `grid`.

const WGS84_A = 6378137.0; // ellipsoid constants (geodesy, not research numbers)
const WGS84_E2 = 0.00669437999014;
const DEG = Math.PI / 180;

// Direction letters as written in the header's dir_codes -> [dc, dr] (dr grows southward).
const LETTER = { E: [1, 0], SE: [1, 1], S: [0, 1], SW: [-1, 1], W: [-1, 0], NW: [-1, -1], N: [0, -1], NE: [1, -1] };

export function d8Table(dirCodes) {
  const dc = new Int8Array(256);
  const dr = new Int8Array(256);
  const ok = new Uint8Array(256);
  if (!dirCodes || typeof dirCodes !== 'object') throw new Error('grid header has no dir_codes');
  for (const [code, name] of Object.entries(dirCodes)) {
    const off = LETTER[String(name).trim().toUpperCase()];
    const c = Number(code);
    if (!off || !(c >= 0 && c < 256)) continue;
    dc[c] = off[0];
    dr[c] = off[1];
    ok[c] = 1;
  }
  return { dc, dr, ok };
}

// Area of one cell (km2) in each row, on the WGS84 ellipsoid: M(phi) N(phi) cos(phi) dphi dlambda.
function rowAreas(north, cell, rows) {
  const out = new Float64Array(rows);
  const d = cell * DEG;
  for (let r = 0; r < rows; r++) {
    const phi = (north - (r + 0.5) * cell) * DEG;
    const s2 = Math.sin(phi) ** 2;
    const w = 1 - WGS84_E2 * s2;
    const M = (WGS84_A * (1 - WGS84_E2)) / (w * Math.sqrt(w));
    const N = WGS84_A / Math.sqrt(w);
    out[r] = (M * N * Math.cos(phi) * d * d) / 1e6;
  }
  return out;
}

// Build a grid object from a header and typed arrays (used by loadGrid and by tests with synthetic grids).
export function makeGrid(meta, arrays) {
  const cols = meta.cols | 0;
  const rows = meta.rows | 0;
  const cell = Number(meta.cellsize_deg ?? meta.cell ?? meta.cell_deg);
  const n = cols * rows;
  const need = (a, what) => {
    if (a && a.length !== n) throw new Error(`grid ${meta.name}: ${what} has ${a.length} cells, expected ${n}`);
    return a || null;
  };
  const g = {
    name: meta.name,
    west: Number(meta.west),
    south: Number(meta.south),
    east: Number(meta.east),
    north: Number(meta.north),
    cols,
    rows,
    cell,
    dem: need(arrays.dem, 'dem'),
    dir: need(arrays.dir, 'dir'),
    acc: need(arrays.acc, 'acc'),
    hand: need(arrays.hand, 'hand'),
    lc: need(arrays.lc, 'lc'),
    meta,
    d8: d8Table(meta.dir_codes),
    demNodata: meta.nodata && meta.nodata.dem != null ? Number(meta.nodata.dem) : -32768,
    rowAreaKm2: rowAreas(Number(meta.north), cell, rows),
  };
  g.cellAreaKm2 = (row) => g.rowAreaKm2[Math.min(rows - 1, Math.max(0, row | 0))];
  return g;
}

const asJson = (v) => {
  if (v == null) return null;
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return JSON.parse(new TextDecoder().decode(v));
  if (typeof v === 'string') return JSON.parse(v);
  return v;
};
const buf = (v) => (v instanceof ArrayBuffer ? v : v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));

// loadGrid(name, fetchBinary[, opts]): fetchBinary(path relative to site/data/) -> Promise<ArrayBuffer>
// (it may also resolve a parsed object for .json paths). Loads grid/<name>.json, then every pack it lists, plus the
// land cover named in grid/lc.json. opts: { layers: ['dem','dir','acc','hand','lc'], onProgress({name, layer, done, total}) }.
// Missing optional layers (acc, hand, lc) load as null; dem and dir are required.
export async function loadGrid(name, fetchBinary, opts = {}) {
  const meta = asJson(await fetchBinary(`grid/${name}.json`));
  if (!meta || meta.name !== name) throw new Error(`grid ${name}: header missing or for another grid`);
  const want = opts.layers || ['dem', 'dir', 'acc', 'hand', 'lc'];
  const files = { ...(meta.files || {}) };
  if (want.includes('lc') && !files.lc) {
    try {
      const lcMeta = asJson(await fetchBinary('grid/lc.json'));
      const entry = lcMeta && lcMeta[name];
      if (entry && entry.file && entry.cols === meta.cols && entry.rows === meta.rows) {
        files.lc = entry.file;
        meta.lc = { classes: lcMeta.classes, nodata: lcMeta.nodata, ...entry };
      }
    } catch {
      // land cover is optional
    }
  }
  const Types = { dem: Int16Array, dir: Uint8Array, acc: Float32Array, hand: Int16Array, lc: Uint8Array };
  const layers = want.filter((k) => files[k] && Types[k]);
  let done = 0;
  const arrays = {};
  await Promise.all(
    layers.map(async (k) => {
      try {
        arrays[k] = new Types[k](buf(await fetchBinary(`grid/${files[k]}`)));
      } catch (e) {
        if (k === 'dem' || k === 'dir') throw e;
        arrays[k] = null;
      }
      done++;
      if (opts.onProgress) opts.onProgress({ name, layer: k, done, total: layers.length });
    }),
  );
  return makeGrid(meta, arrays);
}

export function lonLatToCell(g, lon, lat) {
  const col = Math.floor((lon - g.west) / g.cell);
  const row = Math.floor((g.north - lat) / g.cell);
  if (!(col >= 0 && col < g.cols && row >= 0 && row < g.rows)) return null;
  return { col, row, idx: row * g.cols + col };
}

export function cellToLonLat(g, col, row) {
  return { lon: g.west + (col + 0.5) * g.cell, lat: g.north - (row + 0.5) * g.cell };
}

// Surface elevation in metres, bilinear between cell centres; nodata cells are left out of the weights.
export function elevationAt(g, lon, lat) {
  const x = (lon - g.west) / g.cell - 0.5;
  const y = (g.north - lat) / g.cell - 0.5;
  if (!(x > -0.5 && y > -0.5 && x < g.cols - 0.5 && y < g.rows - 0.5)) return null;
  const c0 = Math.max(0, Math.min(g.cols - 1, Math.floor(x)));
  const r0 = Math.max(0, Math.min(g.rows - 1, Math.floor(y)));
  const c1 = Math.min(g.cols - 1, c0 + 1);
  const r1 = Math.min(g.rows - 1, r0 + 1);
  const fx = Math.max(0, Math.min(1, x - c0));
  const fy = Math.max(0, Math.min(1, y - r0));
  let sum = 0;
  let wsum = 0;
  const add = (c, r, w) => {
    const v = g.dem[r * g.cols + c];
    if (v === g.demNodata || w <= 0) return;
    sum += v * w;
    wsum += w;
  };
  add(c0, r0, (1 - fx) * (1 - fy));
  add(c1, r0, fx * (1 - fy));
  add(c0, r1, (1 - fx) * fy);
  add(c1, r1, fx * fy);
  return wsum > 0 ? sum / wsum / 10 : null;
}

// The cell a cell drains to, or -1 (outlet, sea, nodata or off the box).
export function downstream(g, idx) {
  const code = g.dir[idx];
  if (!g.d8.ok[code] || code === 0) return -1;
  const col = (idx % g.cols) + g.d8.dc[code];
  const row = ((idx / g.cols) | 0) + g.d8.dr[code];
  if (col < 0 || col >= g.cols || row < 0 || row >= g.rows) return -1;
  return row * g.cols + col;
}

function gridOf(G, name) {
  const g = G && (G[name || 'wide'] || (G.cols && G.dir ? G : null));
  if (!g) throw new Error(`grid ${name || 'wide'} is not loaded`);
  return g;
}

// Metres per cell step in x and y for a row (ellipsoid radii at the row's latitude).
function rowScale(g, row) {
  const phi = (g.north - (row + 0.5) * g.cell) * DEG;
  const w = 1 - WGS84_E2 * Math.sin(phi) ** 2;
  const M = (WGS84_A * (1 - WGS84_E2)) / (w * Math.sqrt(w));
  const N = WGS84_A / Math.sqrt(w);
  return { mx: N * Math.cos(phi) * g.cell * DEG, my: M * g.cell * DEG };
}

// Upstream area (km2, the cell itself included) from the D8 directions alone.
export function accumulate(g) {
  const n = g.cols * g.rows;
  const down = new Int32Array(n);
  const indeg = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = downstream(g, i);
    down[i] = d;
    if (d >= 0) indeg[d]++;
  }
  const acc = new Float32Array(n);
  const area = new Float64Array(n);
  for (let r = 0; r < g.rows; r++) area.fill(g.rowAreaKm2[r], r * g.cols, (r + 1) * g.cols);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue[tail++] = i;
  while (head < tail) {
    const i = queue[head++];
    const d = down[i];
    if (d >= 0) {
      area[d] += area[i];
      if (--indeg[d] === 0) queue[tail++] = d;
    }
  }
  for (let i = 0; i < n; i++) acc[i] = area[i];
  return acc;
}

// For each of the 8 neighbour offsets, the D8 code that drains that neighbour back into the centre cell.
function inflowCodes(g) {
  if (g._inflow) return g._inflow;
  const out = [];
  for (let c = 1; c < 256; c++) {
    if (!g.d8.ok[c]) continue;
    out.push({ dx: -g.d8.dc[c], dy: -g.d8.dr[c], code: c });
  }
  g._inflow = out;
  return out;
}

// Every cell that drains through `idx` (the cell itself included).
export function catchment(G, { grid, idx } = {}) {
  const g = gridOf(G, grid);
  const n = g.cols * g.rows;
  if (!(idx >= 0 && idx < n)) throw new Error('catchment: cell index outside the grid');
  const mask = new Uint8Array(n);
  const stack = new Int32Array(n);
  const inflow = inflowCodes(g);
  let sp = 0;
  stack[sp++] = idx;
  mask[idx] = 1;
  let cells = 0;
  let area = 0;
  let c0 = g.cols;
  let r0 = g.rows;
  let c1 = -1;
  let r1 = -1;
  while (sp > 0) {
    const i = stack[--sp];
    const col = i % g.cols;
    const row = (i / g.cols) | 0;
    cells++;
    area += g.rowAreaKm2[row];
    if (col < c0) c0 = col;
    if (col > c1) c1 = col;
    if (row < r0) r0 = row;
    if (row > r1) r1 = row;
    for (let k = 0; k < inflow.length; k++) {
      const f = inflow[k];
      const nc = col + f.dx;
      const nr = row + f.dy;
      if (nc < 0 || nc >= g.cols || nr < 0 || nr >= g.rows) continue;
      const j = nr * g.cols + nc;
      if (mask[j] || g.dir[j] !== f.code) continue;
      mask[j] = 1;
      stack[sp++] = j;
    }
  }
  return { mask, cells, area_km2: area, bbox: [c0, r0, c1, r1] };
}

// The nearest cell within radius_cells whose upstream area is at least min_km2 (ties: the larger river).
// Returns { ok, idx, col, row, lon, lat, acc_km2, dist_m } or null when the point is off the grid.
// ok is false when no cell is big enough; the cell is then the largest one in reach.
export function snapToStream(G, { grid, lon, lat, min_km2 = 1, radius_cells = 10 } = {}) {
  const g = gridOf(G, grid);
  if (!g.acc) g.acc = accumulate(g);
  const at = lonLatToCell(g, lon, lat);
  if (!at) return null;
  const { mx, my } = rowScale(g, at.row);
  const x0 = (lon - g.west) / g.cell - 0.5;
  const y0 = (g.north - lat) / g.cell - 0.5;
  const R = Math.max(0, radius_cells | 0);
  let best = -1;
  let bestD = Infinity;
  let bestA = -1;
  let big = -1;
  let bigA = -1;
  let bigD = Infinity;
  for (let r = Math.max(0, at.row - R); r <= Math.min(g.rows - 1, at.row + R); r++) {
    for (let c = Math.max(0, at.col - R); c <= Math.min(g.cols - 1, at.col + R); c++) {
      if ((r - at.row) ** 2 + (c - at.col) ** 2 > R * R + 0.5) continue;
      const i = r * g.cols + c;
      const a = g.acc[i];
      const d = Math.hypot((c - x0) * mx, (r - y0) * my);
      if (a >= min_km2 && (d < bestD - 1e-6 || (Math.abs(d - bestD) <= 1e-6 && a > bestA))) {
        best = i;
        bestD = d;
        bestA = a;
      }
      if (a > bigA || (a === bigA && d < bigD)) {
        big = i;
        bigA = a;
        bigD = d;
      }
    }
  }
  const ok = best >= 0;
  const idx = ok ? best : big;
  const col = idx % g.cols;
  const row = (idx / g.cols) | 0;
  const p = cellToLonLat(g, col, row);
  return { ok, idx, col, row, lon: p.lon, lat: p.lat, acc_km2: g.acc[idx], dist_m: ok ? bestD : bigD };
}

// Follow D8 from idx: cell indices, distance from the start (km) and surface elevation (m) of each cell.
export function traceDownstream(G, { grid, idx, max_steps } = {}) {
  const g = gridOf(G, grid);
  const limit = Math.max(1, max_steps ?? g.cols + g.rows) | 0;
  const ids = [];
  const dist = [];
  const el = [];
  let i = idx;
  let km = 0;
  while (i >= 0 && ids.length <= limit) {
    ids.push(i);
    dist.push(km);
    const v = g.dem[i];
    el.push(v === g.demNodata ? NaN : v / 10);
    const j = downstream(g, i);
    if (j < 0) break;
    const row = (i / g.cols) | 0;
    const { mx, my } = rowScale(g, row);
    km += Math.hypot(((j % g.cols) - (i % g.cols)) * mx, (((j / g.cols) | 0) - row) * my) / 1000;
    i = j;
  }
  return { idx: Int32Array.from(ids), dist_km: Float32Array.from(dist), el_m: Float32Array.from(el) };
}

// ---- outlines ------------------------------------------------------------------------------------------------
// Directions on the corner lattice (x = col, y = row, y grows south): 0 E, 1 S, 2 W, 3 N.
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

function simplifyRing(pts, tol) {
  // pts: flat [x0, y0, x1, y1, ...] open ring (no repeat). Douglas-Peucker on the two halves of the ring.
  const n = pts.length / 2;
  if (tol <= 0 || n < 8) return pts;
  let far = 0;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = (pts[2 * i] - pts[0]) ** 2 + (pts[2 * i + 1] - pts[1]) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[far] = keep[n] = 1;
  const px = (i) => pts[2 * (i % n)];
  const py = (i) => pts[2 * (i % n) + 1];
  const stack = [0, far, far, n];
  const t2 = tol * tol;
  while (stack.length) {
    const b = stack.pop();
    const a = stack.pop();
    if (b - a < 2) continue;
    const ax = px(a);
    const ay = py(a);
    const vx = px(b) - ax;
    const vy = py(b) - ay;
    const L = vx * vx + vy * vy;
    let worst = -1;
    let worstD = -1;
    for (let i = a + 1; i < b; i++) {
      const wx = px(i) - ax;
      const wy = py(i) - ay;
      const cr = vx * wy - vy * wx;
      const d = L > 0 ? (cr * cr) / L : wx * wx + wy * wy;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worstD > t2) {
      keep[worst] = 1;
      stack.push(a, worst, worst, b);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
  return out.length >= 6 ? out : pts;
}

function ringArea(pts) {
  let s = 0;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) s += pts[2 * j] * pts[2 * i + 1] - pts[2 * i] * pts[2 * j + 1];
  return s / 2; // lattice coordinates, y down: outer rings come out positive
}

function inRing(pts, x, y) {
  let inside = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[2 * i];
    const yi = pts[2 * i + 1];
    const xj = pts[2 * j];
    const yj = pts[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// maskOutline(G, {grid, mask, simplify, bbox}) -> GeoJSON MultiPolygon (lon/lat, outer rings counter-clockwise).
// mask: Uint8Array over the whole grid (non-zero = in), or over bbox [c0, r0, c1, r1] only when its length says so.
// Cells touching only at a corner are separate polygons. simplify: Douglas-Peucker tolerance in cells (0 = exact).
export function maskOutline(G, { grid, mask, simplify = 0, bbox } = {}) {
  const g = gridOf(G, grid);
  if (!mask) throw new Error('maskOutline: no mask');
  let c0 = 0;
  let r0 = 0;
  let c1 = g.cols - 1;
  let r1 = g.rows - 1;
  let stride = g.cols;
  let local = false;
  if (bbox && mask.length === (bbox[2] - bbox[0] + 1) * (bbox[3] - bbox[1] + 1)) {
    [c0, r0, c1, r1] = bbox;
    stride = c1 - c0 + 1;
    local = true;
  } else if (mask.length !== g.cols * g.rows) {
    throw new Error('maskOutline: mask size does not match the grid');
  } else if (bbox) {
    [c0, r0, c1, r1] = bbox;
  }
  const W = c1 - c0 + 1;
  const H = r1 - r0 + 1;
  const at = (c, r) => (c < 0 || r < 0 || c >= W || r >= H ? 0 : mask[local ? r * stride + c : (r + r0) * stride + (c + c0)]);
  // Directed boundary edges, mask on the right of the direction of travel. Vertex v = y * (W + 1) + x.
  const VW = W + 1;
  const out1 = new Int32Array(VW * (H + 1)).fill(-1); // first outgoing edge direction at a vertex
  const out2 = new Int8Array(VW * (H + 1)).fill(-1); // second (saddle vertices only)
  let edges = 0;
  const addEdge = (x, y, d) => {
    const v = y * VW + x;
    if (out1[v] < 0) out1[v] = d;
    else out2[v] = d;
    edges++;
  };
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (!at(c, r)) continue;
      if (!at(c, r - 1)) addEdge(c, r, 0);
      if (!at(c + 1, r)) addEdge(c + 1, r, 1);
      if (!at(c, r + 1)) addEdge(c + 1, r + 1, 2);
      if (!at(c - 1, r)) addEdge(c, r + 1, 3);
    }
  }
  const take = (v, d) => {
    if (out1[v] === d) out1[v] = out2[v] >= 0 ? out2[v] : -1, (out2[v] = -1);
    else if (out2[v] === d) out2[v] = -1;
  };
  const rings = [];
  let left = edges;
  for (let v0 = 0; v0 < out1.length && left > 0; v0++) {
    while (out1[v0] >= 0) {
      let v = v0;
      let d = out1[v0];
      const pts = [];
      let prev = -1;
      for (;;) {
        take(v, d);
        left--;
        if (d !== prev) pts.push(v % VW, (v / VW) | 0);
        prev = d;
        v += DY[d] * VW + DX[d];
        if (v === v0 && out1[v] !== (d + 1) % 4 && out2[v] !== (d + 1) % 4) break;
        const right = (d + 1) % 4;
        const a = out1[v];
        const b = out2[v];
        if (a < 0) break; // should not happen on a closed lattice boundary
        d = b >= 0 && (a === right || b === right) ? right : a;
      }
      if (pts.length >= 6 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) pts.length -= 2;
      if (pts.length >= 6) rings.push(pts);
    }
  }
  // Classify on the exact rings, then simplify.
  const outers = [];
  const holes = [];
  for (const pts of rings) {
    const a = ringArea(pts);
    if (a > 0) outers.push({ pts, a, box: ringBox(pts), holes: [] });
    else holes.push(pts);
  }
  outers.sort((p, q) => p.a - q.a);
  for (const h of holes) {
    // a point at the centre of the outside cell on the left of the hole's first edge
    const dx = Math.sign(h[2] - h[0]);
    const dy = Math.sign(h[3] - h[1]);
    const x = (h[0] + h[2]) / 2 + dy * 0.5;
    const y = (h[1] + h[3]) / 2 - dx * 0.5;
    const home = outers.find((o) => x > o.box[0] && x < o.box[2] && y > o.box[1] && y < o.box[3] && inRing(o.pts, x, y));
    if (home) home.holes.push(h);
  }
  const tol = Math.max(0, Number(simplify) || 0);
  const toLL = (pts) => {
    const s = simplifyRing(pts, tol);
    const ring = [];
    for (let i = 0; i < s.length; i += 2) ring.push([g.west + (s[i] + c0) * g.cell, g.north - (s[i + 1] + r0) * g.cell]);
    ring.reverse(); // lattice rings run clockwise on the map; GeoJSON wants outer rings counter-clockwise
    ring.push(ring[0].slice());
    return ring;
  };
  const coordinates = outers.sort((p, q) => q.a - p.a).map((o) => [toLL(o.pts), ...o.holes.map((h) => toLL(h))]);
  return { type: 'MultiPolygon', coordinates };
}

function ringBox(pts) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < x0) x0 = pts[i];
    if (pts[i] > x1) x1 = pts[i];
    if (pts[i + 1] < y0) y0 = pts[i + 1];
    if (pts[i + 1] > y1) y1 = pts[i + 1];
  }
  return [x0, y0, x1, y1];
}
