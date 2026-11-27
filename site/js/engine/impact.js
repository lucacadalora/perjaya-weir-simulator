// impact.js (lane b16): what lies inside a wet mask. Pure functions, no DOM, no imports.
// Buildings, roads, rail and places are handed in once with prepare() inside the worker; count(), lines()
// and places() then answer for any mask on the wide or fine grid. CONTRACT 4.8.
//
// Grid object (b11): { name, west, north, cols, rows, cell (deg), lc (Uint8Array) or null, cellAreaKm2(row) }.
// Masks are Uint8Array (1 = wet), row-major from the north-west corner, one byte per grid cell.

const MAX_POINTS = 20000; // CONTRACT 4.5: impact.points carries at most 20,000 buildings
const TILE_Z = 12; // zoom of the buildings index tile key (buildings.json "tile_key")
const TILE_N = 1 << TILE_Z;
const EARTH_R = 6371008.8; // mean Earth radius, metres (geometry, not a researched number)
const RAD = Math.PI / 180;

// Prepared state, kept inside the worker (one per module instance).
let S = { buildings: null, feats: {}, places: null, rasters: new Map() };

// ---------- grid helpers ----------

function gridOf(G, grid) {
  if (G && typeof grid === 'object' && grid && grid.cols) return grid;
  const g = G && (G[grid] || (G.name === grid ? G : null));
  if (!g) throw new Error(`impact: grid '${grid}' is not loaded`);
  return g;
}

function cellDeg(g) { return g.cell || g.cellsize_deg; }

function cellAreaKm2(g, row) {
  if (typeof g.cellAreaKm2 === 'function') return g.cellAreaKm2(row);
  const d = cellDeg(g);
  const lat = g.north - (row + 0.5) * d;
  const w = d * RAD * EARTH_R;
  return (w * w * Math.cos(lat * RAD)) / 1e6;
}

function maskOf(args) {
  const m = args && args.mask;
  if (!m) return null;
  if (m instanceof Uint8Array) return m;
  if (m.mask instanceof Uint8Array) return m.mask;
  return null;
}

/** Bounding box of wet cells: {c0, r0, c1, r1, cells} (inclusive) or null when dry. */
export function maskBBox(g, mask) {
  const { cols, rows } = g;
  let c0 = cols, r0 = rows, c1 = -1, r1 = -1, cells = 0;
  for (let r = 0; r < rows; r++) {
    const o = r * cols;
    let rowHit = false;
    for (let c = 0; c < cols; c++) {
      if (mask[o + c]) {
        cells++;
        rowHit = true;
        if (c < c0) c0 = c;
        if (c > c1) c1 = c;
      }
    }
    if (rowHit) { if (r < r0) r0 = r; r1 = r; }
  }
  return cells ? { c0, r0, c1, r1, cells } : null;
}

function bboxLonLat(g, bb, padCells = 0) {
  const d = cellDeg(g);
  return {
    west: g.west + (bb.c0 - padCells) * d,
    east: g.west + (bb.c1 + 1 + padCells) * d,
    north: g.north - (bb.r0 - padCells) * d,
    south: g.north - (bb.r1 + 1 + padCells) * d,
  };
}

// ---------- tiles ----------

export function lonToTileX(lon) { return Math.floor(((lon + 180) / 360) * TILE_N); }
export function latToTileY(lat) {
  const s = Math.sin(lat * RAD);
  return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE_N);
}
export function tileKey(lon, lat) { return lonToTileX(lon) * 4096 + latToTileY(lat); }

// ---------- buildings ----------

/**
 * Wrap buildings.bin (ArrayBuffer, Buffer or Uint8Array of Float32 triplets lon, lat, footprint m2)
 * with its index json ({index: {key: [offset, count]}}). Returns {n, data: Float32Array, index: Map}.
 */
export function indexBuildings(bin, meta) {
  let buf, off = 0, len;
  if (bin instanceof ArrayBuffer) { buf = bin; len = bin.byteLength; }
  else if (ArrayBuffer.isView(bin)) { buf = bin.buffer; off = bin.byteOffset; len = bin.byteLength; }
  else throw new Error('impact: buildings must be an ArrayBuffer or typed array');
  const n = Math.floor(len / 12);
  let data;
  if (off % 4 === 0) data = new Float32Array(buf, off, n * 3);
  else data = new Float32Array(buf.slice(off, off + n * 12)); // unaligned Buffer slice: copy once
  const index = new Map();
  const src = (meta && meta.index) || {};
  for (const k in src) index.set(Number(k), src[k]);
  return { n, data, index };
}

/**
 * Once, inside the worker. Every layer is optional; a missing layer gives zero, never an error.
 * buildings: {bin, meta} or the result of indexBuildings or an ArrayBuffer (then meta = the index json).
 * roads: FeatureCollection, or {wide: FC, fine: FC}; roads_fine: FC (preferred on the fine grid).
 */
export function prepare(G, { buildings = null, meta = null, roads = null, roads_fine = null, rail = null,
  places = null } = {}) {
  S = { buildings: null, feats: {}, places: null, rasters: new Map() };
  if (buildings) {
    if (buildings.data && buildings.index) S.buildings = buildings;
    else if (buildings.bin) S.buildings = indexBuildings(buildings.bin, buildings.meta || meta);
    else S.buildings = indexBuildings(buildings, meta);
  }
  if (roads && !roads.features && (roads.wide || roads.fine)) {
    if (roads.wide) S.feats.road_wide = packLines(roads.wide, 'road');
    if (roads.fine) S.feats.road_fine = packLines(roads.fine, 'road');
  } else if (roads) S.feats.road_wide = packLines(roads, 'road');
  if (roads_fine) S.feats.road_fine = packLines(roads_fine, 'road');
  if (rail) S.feats.rail = packLines(rail, 'rail');
  if (places) S.places = packPlaces(places);
  return {
    buildings: S.buildings ? S.buildings.n : 0,
    roads: (S.feats.road_wide ? S.feats.road_wide.n : 0) + (S.feats.road_fine ? S.feats.road_fine.n : 0),
    rail: S.feats.rail ? S.feats.rail.n : 0,
    places: S.places ? S.places.length : 0,
  };
}

/** Test hook: forget everything prepared. */
export function reset() { S = { buildings: null, feats: {}, places: null, rasters: new Map() }; }

// ---------- count ----------

function wetTest(mask, depth, minDm) {
  if (depth && minDm > 0) return (i) => mask[i] !== 0 && depth[i] >= minDm;
  return (i) => mask[i] !== 0;
}

/**
 * Buildings inside a mask, their footprint sum, up to max_points positions (evenly thinned when there are more),
 * and hectares by land-cover class. Optional: depth_dm (Int16Array) with min_depth_m to count only deeper water.
 * Returns {buildings, footprint_m2, points: Float32Array [lon, lat, ...], points_total, lc_ha {class: ha},
 * area_ha, cells}.
 */
export function count(G, args = {}) {
  const g = gridOf(G, args.grid || 'fine');
  const mask = maskOf(args);
  const maxPts = Math.max(0, Math.min(MAX_POINTS, args.max_points == null ? MAX_POINTS : args.max_points));
  const empty = { buildings: 0, footprint_m2: 0, points: new Float32Array(0), points_total: 0, lc_ha: {},
    area_ha: 0, cells: 0 };
  if (!mask || mask.length !== g.cols * g.rows) return empty;
  const depth = args.depth_dm || (args.mask && args.mask.depth_dm) || null;
  const minDm = args.min_depth_m > 0 ? Math.round(args.min_depth_m * 10) : 0;
  const wet = wetTest(mask, depth, minDm);
  const bb = args.bbox && args.bbox.length === 4
    ? { c0: args.bbox[0], r0: args.bbox[1], c1: args.bbox[2], r1: args.bbox[3] }
    : maskBBox(g, mask);
  if (!bb) return empty;

  // land cover and wet cells, inside the bbox only
  const lc = g.lc || null;
  const lcKm2 = new Map();
  let cells = 0, areaKm2 = 0;
  for (let r = bb.r0; r <= bb.r1; r++) {
    const a = cellAreaKm2(g, r);
    const o = r * g.cols;
    for (let c = bb.c0; c <= bb.c1; c++) {
      const i = o + c;
      if (!wet(i)) continue;
      cells++;
      areaKm2 += a;
      if (lc) { const k = lc[i]; lcKm2.set(k, (lcKm2.get(k) || 0) + a); }
    }
  }
  const lc_ha = {};
  for (const [k, v] of [...lcKm2.entries()].sort((x, y) => x[0] - y[0])) lc_ha[k] = Math.round(v * 1e4) / 100;

  // buildings through the tile index
  const B = args.buildings || S.buildings;
  let n = 0, foot = 0;
  let hits = new Uint32Array(1024);
  if (B && B.n) {
    const d = cellDeg(g);
    const box = bboxLonLat(g, bb);
    const x0 = lonToTileX(box.west), x1 = lonToTileX(box.east);
    const y0 = latToTileY(box.north), y1 = latToTileY(box.south);
    const D = B.data;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const e = B.index.get(x * 4096 + y);
        if (!e) continue;
        const end = e[0] + e[1];
        for (let b = e[0]; b < end; b++) {
          const lon = D[b * 3], lat = D[b * 3 + 1];
          const c = Math.floor((lon - g.west) / d);
          const r = Math.floor((g.north - lat) / d);
          if (c < bb.c0 || c > bb.c1 || r < bb.r0 || r > bb.r1) continue;
          if (!wet(r * g.cols + c)) continue;
          if (n === hits.length) { const h = new Uint32Array(n * 2); h.set(hits); hits = h; }
          hits[n++] = b;
          foot += D[b * 3 + 2];
        }
      }
    }
  }
  const k = Math.min(n, maxPts);
  const points = new Float32Array(k * 2);
  for (let i = 0; i < k; i++) {
    const b = hits[k === n ? i : Math.floor((i * n) / k)];
    points[i * 2] = B.data[b * 3];
    points[i * 2 + 1] = B.data[b * 3 + 1];
  }
  return { buildings: n, footprint_m2: Math.round(foot), points, points_total: n, lc_ha,
    area_ha: Math.round(areaKm2 * 1e4) / 100, cells };
}

// ---------- lines (roads, rail) ----------

function packLines(fc, kind) {
  const feats = [], bridges = [];
  for (const f of (fc && fc.features) || []) {
    const geom = f && f.geometry;
    if (!geom) continue;
    const parts = geom.type === 'LineString' ? [geom.coordinates]
      : geom.type === 'MultiLineString' ? geom.coordinates : [];
    const p = f.properties || {};
    for (const cs of parts) {
      if (!cs || cs.length < 2) continue;
      const xy = new Float64Array(cs.length * 2);
      let w = Infinity, e = -Infinity, s = Infinity, nn = -Infinity;
      for (let i = 0; i < cs.length; i++) {
        const x = cs[i][0], y = cs[i][1];
        xy[i * 2] = x; xy[i * 2 + 1] = y;
        if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > nn) nn = y;
      }
      const item = { xy, w, e, s, n: nn, cls: p.class == null ? null : p.class, name: p.name || null };
      (p.bridge ? bridges : feats).push(item);
    }
  }
  return { kind, feats, bridges, n: feats.length };
}

function segSteps(x0, y0, x1, y1, d) {
  return Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (d / 3)));
}

function segMetres(x0, y0, x1, y1) {
  const k = Math.cos(((y0 + y1) / 2) * RAD);
  return Math.hypot((x1 - x0) * k, y1 - y0) * RAD * EARTH_R;
}

/** Cells under bridge pieces of one layer on one grid (cached): a road on a bridge is not under water. */
function bridgeCells(g, pack) {
  const key = `${g.name || g.cols + 'x' + g.rows}:${pack.kind}:${pack.bridges.length}`;
  let set = S.rasters.get(key);
  if (set && set.pack === pack) return set.cells;
  const cells = new Set();
  const d = cellDeg(g);
  for (const f of pack.bridges) {
    const xy = f.xy;
    for (let i = 0; i + 3 < xy.length; i += 2) {
      const steps = segSteps(xy[i], xy[i + 1], xy[i + 2], xy[i + 3], d);
      for (let j = 0; j <= steps; j++) {
        const t = j / steps;
        const c = Math.floor((xy[i] + (xy[i + 2] - xy[i]) * t - g.west) / d);
        const r = Math.floor((g.north - (xy[i + 1] + (xy[i + 3] - xy[i + 1]) * t)) / d);
        if (c >= 0 && c < g.cols && r >= 0 && r < g.rows) cells.add(r * g.cols + c);
      }
    }
  }
  S.rasters.set(key, { pack, cells });
  return cells;
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;

/** Walk one layer: wet length in km per class, and the wet pieces as LineStrings. */
function walkLayer(g, pack, wet, box, out) {
  const d = cellDeg(g);
  const br = pack.bridges.length ? bridgeCells(g, pack) : null;
  const wetAt = (x, y) => {
    const c = Math.floor((x - g.west) / d);
    const r = Math.floor((g.north - y) / d);
    if (c < 0 || c >= g.cols || r < 0 || r >= g.rows) return false;
    const i = r * g.cols + c;
    return wet(i) && !(br && br.has(i));
  };
  let total = 0;
  for (const f of pack.feats) {
    if (f.e < box.west || f.w > box.east || f.n < box.south || f.s > box.north) continue;
    const xy = f.xy;
    let run = null, fm = 0;
    const close = () => {
      if (run && run.length >= 2) {
        out.features.push({ type: 'Feature', properties: { kind: pack.kind, class: f.cls, name: f.name },
          geometry: { type: 'LineString', coordinates: run } });
      }
      run = null;
    };
    for (let i = 0; i + 3 < xy.length; i += 2) {
      const x0 = xy[i], y0 = xy[i + 1], x1 = xy[i + 2], y1 = xy[i + 3];
      const steps = segSteps(x0, y0, x1, y1, d);
      const subM = segMetres(x0, y0, x1, y1) / steps;
      for (let j = 0; j < steps; j++) {
        const ta = j / steps, tm = (j + 0.5) / steps;
        if (wetAt(x0 + (x1 - x0) * tm, y0 + (y1 - y0) * tm)) {
          fm += subM;
          if (!run) run = [[r6(x0 + (x1 - x0) * ta), r6(y0 + (y1 - y0) * ta)]];
        } else if (run) {
          const p = [r6(x0 + (x1 - x0) * ta), r6(y0 + (y1 - y0) * ta)];
          const q = run[run.length - 1];
          if (q[0] !== p[0] || q[1] !== p[1]) run.push(p);
          close();
        }
      }
      if (run) run.push([r6(x1), r6(y1)]);
    }
    close();
    if (fm > 0) {
      const k = f.cls || 'other';
      out.by_class[pack.kind][k] = (out.by_class[pack.kind][k] || 0) + fm / 1000;
      total += fm;
    }
  }
  return total / 1000;
}

/**
 * Kilometres of road and rail inside the mask, and the wet pieces as GeoJSON (property `kind` 'road'|'rail').
 * features (optional) overrides the prepared layers: {roads: FC, rail: FC}. Bridged parts never count as wet.
 * Returns {roads_km, rail_km, by_class: {road: {class: km}, rail: {...}}, geojson}.
 */
export function lines(G, args = {}) {
  const g = gridOf(G, args.grid || 'fine');
  const mask = maskOf(args);
  const out = { type: 'FeatureCollection', features: [], by_class: { road: {}, rail: {} } };
  const res = { roads_km: 0, rail_km: 0, by_class: out.by_class, geojson: { type: 'FeatureCollection', features: out.features } };
  if (!mask || mask.length !== g.cols * g.rows) return res;
  const bb = maskBBox(g, mask);
  if (!bb) return res;
  const depth = args.depth_dm || (args.mask && args.mask.depth_dm) || null;
  const wet = wetTest(mask, depth, args.min_depth_m > 0 ? Math.round(args.min_depth_m * 10) : 0);
  const box = bboxLonLat(g, bb, 1);
  let road = null, rail = null;
  if (args.features) {
    if (args.features.roads) road = packLines(args.features.roads, 'road');
    if (args.features.rail) rail = packLines(args.features.rail, 'rail');
  } else {
    const fineGrid = (g.name || args.grid) === 'fine';
    road = fineGrid ? (S.feats.road_fine || S.feats.road_wide) : (S.feats.road_wide || S.feats.road_fine);
    rail = S.feats.rail || null;
  }
  if (road) res.roads_km = walkLayer(g, road, wet, box, out);
  if (rail) res.rail_km = walkLayer(g, rail, wet, box, out);
  const round3 = (o) => { for (const k in o) o[k] = Math.round(o[k] * 1000) / 1000; };
  round3(out.by_class.road); round3(out.by_class.rail);
  res.roads_km = Math.round(res.roads_km * 1000) / 1000;
  res.rail_km = Math.round(res.rail_km * 1000) / 1000;
  return res;
}

// ---------- places ----------

const KIND_RANK = { city: 0, town: 1, village: 2, locality: 3, macrohood: 4, neighborhood: 5, hamlet: 6 };

function packPlaces(fc) {
  const out = [];
  for (const f of (fc && fc.features) || (Array.isArray(fc) ? fc : [])) {
    const p = f.properties || f;
    const g = f.geometry;
    const lon = g ? g.coordinates[0] : f.lon, lat = g ? g.coordinates[1] : f.lat;
    if (!p.name || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    out.push({ name: p.name, kind: p.kind || 'place', lon, lat, population: p.population || null });
  }
  return out;
}

/**
 * Named places inside the mask (inside: true) or within buffer_cells cells of a wet cell (inside: false).
 * places (optional) overrides the prepared layer. Sorted: inside first, then city, town, village, ..., then by
 * population and name. Returns [{name, kind, lon, lat, inside, population}] (at most `max`, default 200).
 */
export function places(G, args = {}) {
  const g = gridOf(G, args.grid || 'fine');
  const mask = maskOf(args);
  const list = args.places ? packPlaces(args.places) : S.places;
  if (!mask || mask.length !== g.cols * g.rows || !list || !list.length) return [];
  const bb = maskBBox(g, mask);
  if (!bb) return [];
  const depth = args.depth_dm || (args.mask && args.mask.depth_dm) || null;
  const wet = wetTest(mask, depth, args.min_depth_m > 0 ? Math.round(args.min_depth_m * 10) : 0);
  const buf = Math.max(0, Math.floor(args.buffer_cells || 0));
  const d = cellDeg(g);
  const box = bboxLonLat(g, bb, buf + 1);
  const found = [];
  for (const p of list) {
    if (p.lon < box.west || p.lon > box.east || p.lat < box.south || p.lat > box.north) continue;
    const c = Math.floor((p.lon - g.west) / d);
    const r = Math.floor((g.north - p.lat) / d);
    if (c < 0 || c >= g.cols || r < 0 || r >= g.rows) continue;
    let inside = wet(r * g.cols + c), near = inside;
    for (let rr = Math.max(0, r - buf); !near && rr <= Math.min(g.rows - 1, r + buf); rr++) {
      for (let cc = Math.max(0, c - buf); cc <= Math.min(g.cols - 1, c + buf); cc++) {
        if ((rr - r) * (rr - r) + (cc - c) * (cc - c) > buf * buf) continue;
        if (wet(rr * g.cols + cc)) { near = true; break; }
      }
    }
    if (near) found.push({ name: p.name, kind: p.kind, lon: p.lon, lat: p.lat, inside, population: p.population });
  }
  const rank = (k) => (k in KIND_RANK ? KIND_RANK[k] : 9);
  found.sort((a, b) => (b.inside - a.inside) || (rank(a.kind) - rank(b.kind))
    || ((b.population || 0) - (a.population || 0)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return found.slice(0, args.max || 200);
}
