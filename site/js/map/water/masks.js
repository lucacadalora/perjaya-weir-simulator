// Water masks and ground crops. Owner: lane b06. Pure functions: no DOM, no three.js, no map.
// A "crop" is a window of a terrain grid (CONTRACT 4.8 grid header: west, north, cols, rows, cell size in degrees,
// row-major from the north-west corner, dem in decimetres). Everything here runs once per mask, never per frame.

const NODATA = -32768;

export function cellSize(meta) {
  return meta.cell ?? meta.cellsize_deg;
}

// The box of cells [c0, r0, c1, r1] (inclusive) in degrees: {west, east, north, south}.
export function bboxDegrees(meta, bbox) {
  const c = cellSize(meta);
  const [c0, r0, c1, r1] = bbox;
  return { west: meta.west + c0 * c, east: meta.west + (c1 + 1) * c, north: meta.north - r0 * c, south: meta.north - (r1 + 1) * c };
}

// Cell box around a lon/lat window, clamped to the grid.
export function bboxFromDegrees(meta, west, south, east, north) {
  const c = cellSize(meta);
  const cl = (v, n) => Math.max(0, Math.min(n - 1, v));
  return [cl(Math.floor((west - meta.west) / c), meta.cols), cl(Math.floor((meta.north - north) / c), meta.rows),
    cl(Math.floor((east - meta.west) / c), meta.cols), cl(Math.floor((meta.north - south) / c), meta.rows)];
}

// Ground heights (metres) of a crop, with nodata filled by the crop's lowest valid value.
// Returns {ground: Float32Array, cols, rows, min, max}.
export function cropGround(dem, meta, bbox) {
  const [c0, r0, c1, r1] = bbox;
  const cols = c1 - c0 + 1;
  const rows = r1 - r0 + 1;
  const ground = new Float32Array(cols * rows);
  let min = Infinity;
  let max = -Infinity;
  for (let r = 0; r < rows; r++) {
    const src = (r0 + r) * meta.cols + c0;
    for (let c = 0; c < cols; c++) {
      const v = dem[src + c];
      const m = v === NODATA ? NaN : v / 10;
      ground[r * cols + c] = m;
      if (m < min) min = m;
      if (m > max) max = m;
    }
  }
  if (!Number.isFinite(min)) min = max = 0;
  for (let i = 0; i < ground.length; i++) if (Number.isNaN(ground[i])) ground[i] = min;
  return { ground, cols, rows, min, max };
}

// A reservoir mask from the field `reservoir.mask:<id>` may cover the whole grid or only its bbox (inclusive or
// exclusive end). Return the bbox window as Uint8Array (cols * rows), or null when the size matches neither.
export function cropMask(mask, meta, bbox) {
  const [c0, r0, c1, r1] = bbox;
  const cols = c1 - c0 + 1;
  const rows = r1 - r0 + 1;
  if (mask.length === cols * rows) return mask;
  const out = new Uint8Array(cols * rows);
  if (mask.length === meta.cols * meta.rows) {
    for (let r = 0; r < rows; r++) out.set(mask.subarray((r0 + r) * meta.cols + c0, (r0 + r) * meta.cols + c0 + cols), r * cols);
    return out;
  }
  if (mask.length === (cols - 1) * (rows - 1)) {
    // exclusive end: one row and column short; the last row and column stay dry
    for (let r = 0; r < rows - 1; r++) out.set(mask.subarray(r * (cols - 1), (r + 1) * (cols - 1)), r * cols);
    return out;
  }
  return null;
}

// 0/1 mask -> 0/255 bytes for a texture, softened by a 3 x 3 box so the linear-filtered edge at 0.5 runs as a
// rounded line instead of cell steps. A wet cell never drops under 0.55 and a dry one never rises over 0.45, so
// no cell changes side; only the line between them is smoothed. Written into `out` when given (same size).
export function maskBytes(mask, out, cols = 0) {
  const b = out && out.length === mask.length ? out : new Uint8Array(mask.length);
  if (!cols) {
    for (let i = 0; i < mask.length; i++) b[i] = mask[i] ? 255 : 0;
    return b;
  }
  const rows = mask.length / cols;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let n = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr >= 0 && cc >= 0 && rr < rows && cc < cols && mask[rr * cols + cc]) n++;
    }
    const f = n / 9;
    b[r * cols + c] = Math.round(255 * (mask[r * cols + c] ? Math.max(0.55, f) : Math.min(0.45, f)));
  }
  return b;
}

// Mark the cells a polyline passes through (lines: array of [[lon, lat], ...]) inside a crop.
export function rasterLines(lines, meta, bbox) {
  const c = cellSize(meta);
  const [c0, r0, c1, r1] = bbox;
  const cols = c1 - c0 + 1;
  const rows = r1 - r0 + 1;
  const hit = new Uint8Array(cols * rows);
  const mark = (lon, lat) => {
    const col = Math.floor((lon - meta.west) / c) - c0;
    const row = Math.floor((meta.north - lat) / c) - r0;
    if (col >= 0 && row >= 0 && col < cols && row < rows) hit[row * cols + col] = 1;
  };
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const [x0, y0] = line[i - 1];
      const [x1, y1] = line[i];
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / (c * 0.5)));
      for (let k = 0; k <= n; k++) mark(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);
    }
  }
  return hit;
}

// Fill polygons (rings: array of polygons, each an array of rings [[lon, lat], ...]) into a crop, even-odd rule,
// by cell centre, one scanline per row.
export function rasterPolygons(polys, meta, bbox) {
  const c = cellSize(meta);
  const [c0, r0, c1, r1] = bbox;
  const cols = c1 - c0 + 1;
  const rows = r1 - r0 + 1;
  const out = new Uint8Array(cols * rows);
  const rowOf = (lat) => (meta.north - lat) / c - r0 - 0.5; // fractional row whose centre lies at lat
  for (const rings of polys) {
    // each edge adds its crossing x to the rows whose centre line it crosses (no row scans every edge)
    const hits = Array.from({ length: rows }, () => []);
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi === yj) continue;
        const ra = rowOf(Math.max(yi, yj));
        const rb = rowOf(Math.min(yi, yj));
        for (let r = Math.max(0, Math.ceil(ra)); r <= Math.min(rows - 1, Math.floor(rb)); r++) {
          const lat = meta.north - (r0 + r + 0.5) * c;
          if (yi > lat !== yj > lat) hits[r].push(xi + ((lat - yi) * (xj - xi)) / (yj - yi));
        }
      }
    }
    for (let r = 0; r < rows; r++) {
      const xs = hits[r];
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const ca = Math.max(0, Math.ceil((xs[k] - meta.west) / c - 0.5) - c0);
        const cb = Math.min(cols - 1, Math.floor((xs[k + 1] - meta.west) / c - 0.5) - c0);
        for (let cc = ca; cc <= cb; cc++) out[r * cols + cc] ^= 1;
      }
    }
  }
  return out;
}

// The river channel: grow from the centreline cells into neighbours whose ground is at most `rise_m` above the
// centreline cell they grew from, for at most `max_steps` cells. Level-independent (computed once).
export function channelMask(ground, cols, rows, seeds, { rise_m, max_steps }) {
  const out = new Uint8Array(cols * rows);
  const ref = new Float32Array(cols * rows);
  let front = [];
  for (let i = 0; i < seeds.length; i++) if (seeds[i]) { out[i] = 1; ref[i] = ground[i]; front.push(i); }
  for (let step = 0; step < max_steps && front.length; step++) {
    const next = [];
    for (const i of front) {
      const r = (i / cols) | 0;
      const c = i - r * cols;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const j = rr * cols + cc;
        if (out[j] || ground[j] > ref[i] + rise_m) continue;
        out[j] = 1;
        ref[j] = ref[i];
        next.push(j);
      }
    }
    front = next;
  }
  return out;
}

// Split a mask by a straight axis through (ax, ay) in cell units with bearing (degrees clockwise from north).
// `gap` cells on side a and `gapB` cells on side b of the axis stay dry. Returns {a, b} where `a` is the side the normal points to:
// the normal is the axis direction turned 90 degrees clockwise (for an east-west axis, bearing 90, that is south).
export function splitByAxis(mask, cols, rows, ax, ay, bearing_deg, gap = 0, gapB = gap) {
  const t = (bearing_deg * Math.PI) / 180;
  // in cell space x = col (east), y = row (south); axis direction (sin t, -cos t); clockwise normal (cos t, sin t)
  const nx = Math.cos(t);
  const ny = Math.sin(t);
  const a = new Uint8Array(mask.length);
  const b = new Uint8Array(mask.length);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    if (!mask[i]) continue;
    const d = (c + 0.5 - ax) * nx + (r + 0.5 - ay) * ny;
    if (d > gap) a[i] = 1;
    else if (d < -gapB) b[i] = 1;
  }
  return { a, b };
}

// Median ground under a mask (used to tell the pond side from the tail side: the pond side is higher).
export function medianUnder(ground, mask) {
  const v = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) v.push(ground[i]);
  if (!v.length) return null;
  v.sort((x, y) => x - y);
  return v[v.length >> 1];
}

// A smoothed river surface for a channel sheet: for every channel cell, a low percentile of the channel cells
// within `radius` cells (the surface model's river is noisy: banks, trees, bridges), then spread outwards to the
// cells around the channel so a sheet's vertices just outside the mask do not climb the banks.
export function riverFloor(ground, cols, rows, channel, { radius = 3, pct = 0.3, spread = 4 } = {}) {
  const out = new Float32Array(cols * rows).fill(NaN);
  const buf = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    if (!channel[i]) continue;
    buf.length = 0;
    for (let dr = -radius; dr <= radius; dr++) for (let dc = -radius; dc <= radius; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      const j = rr * cols + cc;
      if (channel[j]) buf.push(ground[j]);
    }
    buf.sort((a, b) => a - b);
    out[i] = buf[Math.floor((buf.length - 1) * pct)];
  }
  for (let s = 0; s < spread; s++) {
    const prev = out.slice();
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!Number.isNaN(prev[i])) continue;
      let sum = 0;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const v = prev[rr * cols + cc];
        if (!Number.isNaN(v)) { sum += v; n++; }
      }
      if (n) out[i] = sum / n;
    }
  }
  for (let i = 0; i < out.length; i++) if (Number.isNaN(out[i])) out[i] = ground[i];
  return out;
}

// Grow a 0/1 mask by `radius` cells (two-pass chamfer distance, 3-4 weights): about 30 ms for a million cells.
export function dilate(mask, cols, rows, radius) {
  const INF = 1e9;
  const d = new Float32Array(cols * rows);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
  const a = 1;
  const b = Math.SQRT2;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    let v = d[i];
    if (c > 0) v = Math.min(v, d[i - 1] + a);
    if (r > 0) {
      v = Math.min(v, d[i - cols] + a);
      if (c > 0) v = Math.min(v, d[i - cols - 1] + b);
      if (c < cols - 1) v = Math.min(v, d[i - cols + 1] + b);
    }
    d[i] = v;
  }
  for (let r = rows - 1; r >= 0; r--) for (let c = cols - 1; c >= 0; c--) {
    const i = r * cols + c;
    let v = d[i];
    if (c < cols - 1) v = Math.min(v, d[i + 1] + a);
    if (r < rows - 1) {
      v = Math.min(v, d[i + cols] + a);
      if (c < cols - 1) v = Math.min(v, d[i + cols + 1] + b);
      if (c > 0) v = Math.min(v, d[i + cols - 1] + b);
    }
    d[i] = v;
  }
  const out = new Uint8Array(cols * rows);
  for (let i = 0; i < d.length; i++) out[i] = d[i] <= radius ? 1 : 0;
  return out;
}

// Polygons (each an array of rings) out of a GeoJSON Feature, FeatureCollection, Polygon, MultiPolygon or bare rings.
export function polygonsOf(x) {
  if (!x) return [];
  if (Array.isArray(x)) {
    if (!x.length) return [];
    if (typeof x[0][0] === 'number') return [[x]]; // one ring
    if (typeof x[0][0][0] === 'number') return [x]; // one polygon
    return x.flatMap((p) => polygonsOf(p));
  }
  if (x.type === 'FeatureCollection') return (x.features || []).flatMap((f) => polygonsOf(f));
  if (x.type === 'Feature') return polygonsOf(x.geometry);
  if (x.type === 'Polygon') return [x.coordinates];
  if (x.type === 'MultiPolygon') return x.coordinates;
  if (x.geometry || x.coordinates) return polygonsOf(x.geometry || { type: x.type, coordinates: x.coordinates });
  return [];
}

// The degree box of a list of polygons: [west, south, east, north] or null.
export function polygonsBox(polys) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const rings of polys) for (const ring of rings) for (const [x, y] of ring) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}
