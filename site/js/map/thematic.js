// Thematic layers. Owner: lane b23. CONTRACT 4.4 (`view.layers`), 4.5, A1, A4.
// The weir's catchment outline with its area, the sub-catchments, the streams with width by upstream area, the main
// canal emphasised and named, and named markers for the upstream level gauge, Martapura, the two bridges, the canal
// head, the planned upstream dam site and the lake outlet. Each group follows a view.layers flag:
//   catchment -> outlines, area labels, streams, the active maker dam's catchment
//   canals    -> the main canal and its name
//   gauge     -> the upstream level gauge
//   labels    -> the other markers
// Lines and fills go under the 3D layer, above lane b05's base lines (map.addLayer(layer, 'three')). Names go on top
// of everything, above b05's names, so MapLibre places ours first; no layer allows overlap, so a name never covers
// another name. Sources: b23-catch, b23-catch-labels, b23-streams, b23-canal, b23-markers, b23-maker-catch.

const FONT = ['Noto Sans Regular'];
const FONT_M = ['Noto Sans Medium'];
const HALO = '#ffffff';
const INK = '#1d2833';
const CATCH = '#5b3f8c'; // catchment outlines: violet, apart from water blue, canal teal and road colours
const WATER = '#2f74b8';
const CANAL = '#0b8a7f';
const AMBER = '#b86e00';
const BRIDGES_SPLIT_Z = 14;
const CANAL_HEAD_MAX_Z = 14.5;
const zoomed = (pairs) => ['interpolate', ['linear'], ['zoom'], ...pairs];

// FALLBACK places not (yet) in presets.json / weir.json / catchments.geojson; asked lane b18 to add them.
const FALLBACK = {
  gauge_up_km: 7.6, // FALLBACK AWLR Peracak: river km upstream of the weir (lead's brief; asked b18 for a fact)
  weir: [104.38101, -4.30512],
  canal_head: [104.3855, -4.302],
  rail_bridge: [104.34868, -4.32338],
  road_bridge: [104.3478, -4.3252],
  martapura: [104.36, -4.32],
  ranau_outlet: [103.91944, -4.81111],
  tiga_dihaji: [103.87687, -4.62893],
};

// ---------- pure helpers (no map, no DOM) ----------

const kx = (lat) => Math.cos((lat * Math.PI) / 180);

/** Point at `km` along profile.json rows [km, surface, envelope, lon, lat, km2] (linear between rows). */
export function pointAtKm(profile, km) {
  const rows = profile?.rows;
  const cols = profile?.columns || ['km', 'surface_m', 'lower_envelope_m', 'lon', 'lat', 'km2'];
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const iK = cols.indexOf('km');
  const iLon = cols.indexOf('lon');
  const iLat = cols.indexOf('lat');
  if (km <= rows[0][iK] || km >= rows[rows.length - 1][iK]) return null;
  let lo = 0;
  let hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][iK] <= km) lo = mid;
    else hi = mid;
  }
  const a = rows[lo];
  const b = rows[hi];
  const f = (km - a[iK]) / (b[iK] - a[iK] || 1);
  return [a[iLon] + (b[iLon] - a[iLon]) * f, a[iLat] + (b[iLat] - a[iLat]) * f];
}

/** Ray-casting point-in-ring test. */
export function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const outerRings = (geom) =>
  !geom ? [] : geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.type === 'MultiPolygon' ? geom.coordinates.map((p) => p[0]) : [];
const inGeom = (geom, x, y) => outerRings(geom).some((r) => inRing(r, x, y));

function ringBox(rings) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings) for (const [x, y] of r) {
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
  }
  return b;
}

// Squared distance (in east-west-corrected degrees) from p to segment ab.
function segDist2(px, py, ax, ay, bx, by, k) {
  const dx = (bx - ax) * k;
  const dy = by - ay;
  const qx = (px - ax) * k;
  const qy = py - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, (qx * dx + qy * dy) / l2)) : 0;
  const ex = qx - t * dx;
  const ey = qy - t * dy;
  return ex * ex + ey * ey;
}

/**
 * A good place for a polygon's name: the point inside `geom` and outside every `holes` geometry that lies farthest
 * from all their edges (grid search, `n` by `n`, then one finer pass around the best cell).
 */
export function labelPoint(geom, holes = [], n = 40) {
  const rings = outerRings(geom);
  if (!rings.length) return null;
  const holeRings = holes.flatMap(outerRings);
  const box = ringBox(rings);
  const k = kx((box[1] + box[3]) / 2);
  const edges = [...rings, ...holeRings];
  const score = (x, y) => {
    if (!rings.some((r) => inRing(r, x, y))) return -1;
    if (holeRings.some((r) => inRing(r, x, y))) return -1;
    let m = Infinity;
    for (const r of edges) for (let i = 1; i < r.length; i++) {
      const d = segDist2(x, y, r[i - 1][0], r[i - 1][1], r[i][0], r[i][1], k);
      if (d < m) m = d;
    }
    return m;
  };
  let best = null;
  let bestS = -1;
  const pass = (x0, y0, x1, y1) => {
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const y = y0 + ((y1 - y0) * j) / n;
      const s = score(x, y);
      if (s > bestS) {
        bestS = s;
        best = [x, y];
      }
    }
  };
  pass(box[0], box[1], box[2], box[3]);
  if (best) {
    const hx = (box[2] - box[0]) / n;
    const hy = (box[3] - box[1]) / n;
    pass(best[0] - hx, best[1] - hy, best[0] + hx, best[1] + hy);
  }
  return best;
}

/** Keep every `step`-th vertex of long rings (labelPoint speed only; the drawn outline stays as it is). */
export function thinGeom(geom, maxPts = 600) {
  const thin = (r) => {
    if (r.length <= maxPts) return r;
    const step = Math.ceil(r.length / maxPts);
    const out = r.filter((_, i) => i % step === 0);
    out.push(r[r.length - 1]);
    return out;
  };
  if (geom?.type === 'Polygon') return { type: 'Polygon', coordinates: [thin(geom.coordinates[0])] };
  if (geom?.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: geom.coordinates.map((p) => [thin(p[0])]) };
  return geom;
}

/** Length of a LineString in km (flat-earth, fine at this size). */
export function lineKm(coords) {
  let s = 0;
  for (let i = 1; i < coords.length; i++) {
    const k = kx(coords[i][1]);
    s += Math.hypot((coords[i][0] - coords[i - 1][0]) * k, coords[i][1] - coords[i - 1][1]) * 111.195;
  }
  return s;
}

/** The canal feature that starts nearest the canal head (and is the longest of those within `tolKm`). */
export function findMainCanal(rivers, head, tolKm = 0.6) {
  let best = null;
  let bestLen = 0;
  for (const f of rivers?.features || []) {
    if (f.properties?.kind !== 'canal' || f.geometry?.type !== 'LineString') continue;
    const c = f.geometry.coordinates;
    const d = Math.min(...[c[0], c[c.length - 1]].map((p) => Math.hypot((p[0] - head[0]) * kx(head[1]), p[1] - head[1]) * 111.195));
    if (d > tolKm) continue;
    const len = lineKm(c);
    if (len > bestLen) {
      bestLen = len;
      best = f;
    }
  }
  return best ? { feature: best, km: bestLen } : null;
}

/** Which catchments sit inside which: a polygon is a child of a larger one when its outlet lies inside it. */
export function nestCatchments(features) {
  const list = features.filter((f) => f?.geometry && f.properties);
  return list.map((f) => {
    const a = f.properties.area_km2 || 0;
    const kids = list.filter((g) => g !== f && (g.properties.area_km2 || 0) < a &&
      inGeom(f.geometry, g.properties.outlet_lon, g.properties.outlet_lat));
    // keep only direct children (not grandchildren)
    const direct = kids.filter((g) => !kids.some((h) => h !== g && (h.properties.area_km2 || 0) > (g.properties.area_km2 || 0) &&
      inGeom(h.geometry, g.properties.outlet_lon, g.properties.outlet_lat)));
    return { feature: f, children: direct };
  });
}

// ---------- marker icons (drawn once on a canvas, 2x for sharp edges) ----------

function drawIcon(kind) {
  const s = 2;
  const size = kind === 'dam' ? 22 : 18;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size * s;
  const g = cv.getContext('2d');
  g.scale(s, s);
  const c = size / 2;
  g.lineJoin = 'round';
  const ringed = (fill, path) => {
    g.beginPath();
    path();
    g.lineWidth = 4;
    g.strokeStyle = '#ffffff';
    g.stroke();
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = 1.2;
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.stroke();
  };
  if (kind === 'gauge') {
    // a staff gauge: a blue pin-triangle pointing down at the river
    ringed(WATER, () => { g.moveTo(c - 6, c - 5); g.lineTo(c + 6, c - 5); g.lineTo(c, c + 6); g.closePath(); });
  } else if (kind === 'bridge') {
    ringed(INK, () => g.rect(c - 6, c - 2.5, 12, 5));
  } else if (kind === 'canal') {
    ringed(CANAL, () => g.rect(c - 4.5, c - 4.5, 9, 9));
  } else if (kind === 'outlet') {
    ringed(WATER, () => g.arc(c, c, 5, 0, Math.PI * 2));
    g.beginPath();
    g.arc(c, c, 2, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
  } else if (kind === 'dam') {
    // a dam section (trapezoid) in amber: planned, under construction
    ringed(AMBER, () => { g.moveTo(c - 8, c + 5); g.lineTo(c - 2.5, c - 6); g.lineTo(c + 2.5, c - 6); g.lineTo(c + 8, c + 5); g.closePath(); });
  } else {
    ringed(INK, () => g.arc(c, c, 4.5, 0, Math.PI * 2));
  }
  return { img: g.getImageData(0, 0, size * s, size * s), ratio: s };
}

function addIcons(map) {
  for (const k of ['place', 'gauge', 'bridge', 'canal', 'outlet', 'dam']) {
    const id = 'b23-' + k;
    if (map.hasImage(id)) continue;
    const { img, ratio } = drawIcon(k);
    map.addImage(id, { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer) }, { pixelRatio: ratio });
  }
}

// ---------- layers ----------

const EMPTY = { type: 'FeatureCollection', features: [] };
const halo = { 'text-color': INK, 'text-halo-color': HALO, 'text-halo-width': 2, 'text-halo-blur': 0.2 };

// [layer, group (view.layers flag), place: 'under' (below the 3D layer) or 'top' (names)]
function layerDefs(t) {
  const areaW = (a, b, c, d) => ['interpolate', ['linear'], ['ln', ['max', 25, ['get', 'km2']]], Math.log(25), a, Math.log(300), b, Math.log(1500), c, Math.log(4500), d];
  const isWeir = ['==', ['get', 'role'], 'weir'];
  return [
    [{ id: 'b23-catch-fill', type: 'fill', source: 'b23-catch', filter: isWeir, maxzoom: 12.5,
      paint: { 'fill-color': CATCH, 'fill-opacity': zoomed([6, 0.08, 10, 0.05, 12.5, 0]) } }, 'catchment', 'under'],
    [{ id: 'b23-streams', type: 'line', source: 'b23-streams', maxzoom: 13,
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'km2'] },
      paint: { 'line-color': WATER,
        'line-width': zoomed([6, areaW(0.35, 0.9, 1.8, 2.8), 9, areaW(0.6, 1.5, 3, 4.5), 12, areaW(1, 2.2, 4, 6)]),
        'line-opacity': zoomed([6, 0.9, 10.5, 0.8, 13, 0]) } }, 'catchment', 'under'],
    [{ id: 'b23-catch-case', type: 'line', source: 'b23-catch', layout: { 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-opacity': zoomed([6, 0.85, 12, 0.6, 14.5, 0.15]),
        'line-width': zoomed([6, ['case', isWeir, 4.5, 2.6], 10, ['case', isWeir, 6, 3.2], 14, ['case', isWeir, 5, 3.2]]) } }, 'catchment', 'under'],
    [{ id: 'b23-subcatch-line', type: 'line', source: 'b23-catch', filter: ['!', isWeir], layout: { 'line-join': 'round' },
      paint: { 'line-color': CATCH, 'line-opacity': zoomed([6, 0.95, 12, 0.8, 14.5, 0.25]),
        'line-width': zoomed([6, 1.7, 10, 2.2]), 'line-dasharray': [2.5, 1.5] } }, 'catchment', 'under'],
    [{ id: 'b23-catch-line', type: 'line', source: 'b23-catch', filter: isWeir, layout: { 'line-join': 'round' },
      paint: { 'line-color': CATCH, 'line-opacity': zoomed([6, 1, 12, 0.85, 14.5, 0.25]),
        'line-width': zoomed([6, 2.2, 10, 3, 14, 2.4]) } }, 'catchment', 'under'],
    [{ id: 'b23-maker-fill', type: 'fill', source: 'b23-maker-catch',
      paint: { 'fill-color': AMBER, 'fill-opacity': zoomed([6, 0.12, 12, 0.06, 14, 0]) } }, 'catchment', 'under'],
    [{ id: 'b23-maker-line', type: 'line', source: 'b23-maker-catch', layout: { 'line-join': 'round' },
      paint: { 'line-color': AMBER, 'line-width': zoomed([6, 2, 10, 2.8]), 'line-opacity': zoomed([6, 1, 13, 0.8, 15, 0.3]) } }, 'catchment', 'under'],
    [{ id: 'b23-canal-case', type: 'line', source: 'b23-canal', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': zoomed([7, 2.6, 10, 4.5, 13, 7, 16, 12]) } }, 'canals', 'under'],
    [{ id: 'b23-canal', type: 'line', source: 'b23-canal', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': CANAL, 'line-width': zoomed([7, 1.4, 10, 2.6, 13, 4.2, 16, 8]) } }, 'canals', 'under'],
    // names, bottom to top (the top layer is placed first and wins)
    [{ id: 'b23-catch-label', type: 'symbol', source: 'b23-catch-labels', minzoom: 6, maxzoom: 12,
      layout: { 'text-field': ['get', 'label'], 'text-font': FONT_M, 'text-size': ['case', ['==', ['get', 'role'], 'weir'], 14, 12.5],
        'text-max-width': 11, 'text-line-height': 1.25, 'text-padding': 6, 'text-pitch-alignment': 'viewport',
        'symbol-sort-key': ['case', ['==', ['get', 'role'], 'weir'], 0, 1] },
      paint: { ...halo, 'text-color': CATCH } }, 'catchment', 'top'],
    [{ id: 'b23-maker-label', type: 'symbol', source: 'b23-maker-catch', filter: ['has', 'label'], minzoom: 6, maxzoom: 13,
      layout: { 'text-field': ['get', 'label'], 'text-font': FONT_M, 'text-size': 13, 'text-max-width': 11, 'text-padding': 6,
        'text-pitch-alignment': 'viewport' },
      paint: { ...halo, 'text-color': '#8a5200' } }, 'catchment', 'top'],
    [{ id: 'b23-canal-label', type: 'symbol', source: 'b23-canal', minzoom: 10,
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'label'], 'text-font': FONT_M,
        'text-size': zoomed([10, 12, 14, 13.5, 16, 15]), 'text-max-angle': 30, 'symbol-spacing': 520, 'text-padding': 4,
        'text-pitch-alignment': 'viewport', 'text-rotation-alignment': 'map', 'text-letter-spacing': 0.03 },
      paint: { ...halo, 'text-color': '#075f57' } }, 'canals', 'top'],
    // the two bridges stand 230 m apart: one shared marker below zoom 14, two markers from zoom 14
    // the canal head's marker only up to zoom 14.5: closer in, the canal's line name and b09's part labels name it (A8.3)
    ...[['labels', 'far', 0, BRIDGES_SPLIT_Z], ['labels', 'near', BRIDGES_SPLIT_Z, 24], ['labels', 'head', 0, CANAL_HEAD_MAX_Z],
      ['gauge', 'all', 0, 24]].map(([grp, scope, z0, z1]) => [{
      id: grp === 'gauge' ? 'b23-marker-gauge' : 'b23-markers-' + scope, type: 'symbol', source: 'b23-markers',
      minzoom: z0, maxzoom: z1,
      filter: ['all', ['==', ['get', 'group'], grp],
        scope === 'head' ? ['==', ['get', 'scope'], 'head'] : ['in', ['get', 'scope'], ['literal', grp === 'gauge' ? ['all'] : ['all', scope]]]],
      layout: { 'icon-image': ['get', 'icon'], 'icon-size': 1, 'icon-padding': 2,
        'text-field': ['get', 'label'], 'text-font': FONT_M, 'text-size': zoomed([6, 12.5, 12, 13.5, 16, 14.5]),
        'text-max-width': 12, 'text-line-height': 1.2, 'text-padding': 3, 'text-justify': 'auto',
        'text-variable-anchor': ['left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right'],
        'text-radial-offset': 0.95, 'symbol-sort-key': ['get', 'rank'],
        'text-pitch-alignment': 'viewport', 'icon-pitch-alignment': 'viewport', 'icon-rotation-alignment': 'viewport' },
      paint: { ...halo, 'text-color': ['coalesce', ['get', 'color'], INK] } }, grp, 'top']),
  ];
}

// ---------- data ----------

const pt = (lonlat, props) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: lonlat } });
const safe = (p) => p.then((v) => v, () => null);

// The gauge's river distance above the weir: a facts.json entry about the Peracak gauge in km when lane b18 adds one.
function gaugeKm(facts) {
  for (const [k, f] of Object.entries(facts || {})) {
    if (/peracak|awlr/i.test(k) && f?.unit === 'km' && Number.isFinite(f.v)) return f.v;
  }
  return FALLBACK.gauge_up_km;
}

async function loadInputs(ctx) {
  const j = (p) => safe(ctx.data.json(p));
  const [presets, weir, facts, catchments, profile, rivers] = await Promise.all([
    j('presets.json'), j('weir.json'), j('facts.json'), j('feat/catchments.geojson'), j('feat/profile.json'), j('feat/rivers.geojson'),
  ]);
  return { presets: Array.isArray(presets) ? presets : [], weir, facts: facts?.facts || {}, catchments, profile, rivers };
}

// Catchment polygons with their role and a label point each (inside the polygon, outside its sub-catchments).
function buildCatchments(inp) {
  const feats = (inp.catchments?.features || []).filter((f) => f.geometry && f.properties?.key);
  const nested = nestCatchments(feats.map((f) => ({ ...f, geometry: thinGeom(f.geometry) })));
  const polys = feats.map((f) => ({ ...f, properties: { key: f.properties.key, role: f.properties.key === 'weir' ? 'weir' : 'sub' } }));
  const anchors = nested.map(({ feature, children }) => ({
    key: feature.properties.key,
    area: feature.properties.area_km2,
    at: labelPoint(feature.geometry, children.map((c) => c.geometry)),
  }));
  return { polys: { type: 'FeatureCollection', features: polys }, anchors };
}

function catchLabels(ctx, inp, anchors) {
  const { t, fmt } = ctx;
  const sourced = { weir: inp.facts.catchment_area?.v, tiga_dihaji: inp.facts.tiga_dihaji_catchment?.v };
  const names = {
    weir: t('thematic.catch_weir', 'Komering catchment above Perjaya Weir'),
    muaradua: t('thematic.catch_muaradua', 'Upper Komering at Muaradua'),
    ranau_outlet: t('thematic.catch_ranau', 'Lake Ranau catchment'),
    tiga_dihaji: t('thematic.catch_tiga_dihaji', 'Tiga Dihaji dam catchment'),
  };
  const features = anchors.filter((a) => a.at).map((a) => pt(a.at, {
    role: a.key === 'weir' ? 'weir' : 'sub',
    label: (names[a.key] || a.key) + '\n' + fmt.area(sourced[a.key] ?? a.area),
  }));
  return { type: 'FeatureCollection', features };
}

function presetAt(inp, ids) {
  for (const id of ids) {
    const p = inp.presets.find((x) => x.id === id);
    if (p && Number.isFinite(p.lon) && Number.isFinite(p.lat)) return p;
  }
  return null;
}

// The markers: [lon, lat] from presets, weir.json, catchments.geojson or profile.json first, FALLBACK last.
function buildMarkers(ctx, inp) {
  const { t, fmt } = ctx;
  const lang = ctx.store.get('lang') === 'en' ? 'en' : 'id';
  const pName = (p) => p?.name?.[lang] || p?.name?.id || null;
  const out = [];
  const add = (id, at, group, icon, rank, label, color, scope) =>
    at && out.push(pt(at, { id, group, icon: 'b23-' + icon, rank, label, scope: scope || 'all', ...(color ? { color } : {}) }));

  // upstream level gauge: walk up the main stem from the weir's mark in profile.json
  const weirKm = inp.profile?.marks_km?.weir;
  const gp = presetAt(inp, ['awlr-peracak', 'gauge-peracak', 'peracak-gauge']);
  const gaugeAt = gp ? [gp.lon, gp.lat] : Number.isFinite(weirKm) ? pointAtKm(inp.profile, weirKm - inp.gaugeKm) : null;
  add('gauge', gaugeAt, 'gauge', 'gauge', 0,
    t('thematic.gauge_approx', 'Peracak water-level station (about {km} upstream; place approximate)', { km: fmt.len(inp.gaugeKm * 1000) }), '#1d5b94');

  const head = presetAt(inp, ['canal-head']);
  const headAt = head ? [head.lon, head.lat] : inp.weir?.canal_head?.point?.v || FALLBACK.canal_head;
  add('canal-head', headAt, 'labels', 'canal', 1, pName(head) || t('thematic.canal_head', 'Komering main canal head'), '#075f57', 'head');

  const rail = presetAt(inp, ['rail-bridge']);
  const railAt = rail ? [rail.lon, rail.lat] : FALLBACK.rail_bridge;
  const road = presetAt(inp, ['road-bridge']);
  const roadAt = road ? [road.lon, road.lat] : FALLBACK.road_bridge;
  add('rail-bridge', railAt, 'labels', 'bridge', 2, pName(rail) || t('thematic.rail_bridge', 'Komering rail bridge'), null, 'near');
  add('road-bridge', roadAt, 'labels', 'bridge', 3, pName(road) || t('thematic.road_bridge', 'Komering road bridge'), null, 'near');
  add('bridges', [(railAt[0] + roadAt[0]) / 2, (railAt[1] + roadAt[1]) / 2], 'labels', 'bridge', 2,
    t('thematic.bridges', 'Komering rail and road bridges'), null, 'far');

  const mp = presetAt(inp, ['martapura']);
  add('martapura', mp ? [mp.lon, mp.lat] : FALLBACK.martapura, 'labels', 'place', 4, pName(mp) || 'Martapura');

  const ranau = (inp.catchments?.features || []).find((f) => f.properties?.key === 'ranau_outlet')?.properties;
  const outAt = ranau && Number.isFinite(ranau.outlet_lon) ? [ranau.outlet_lon, ranau.outlet_lat] : FALLBACK.ranau_outlet;
  add('ranau-outlet', outAt, 'labels', 'outlet', 1, t('thematic.ranau_outlet', 'Lake Ranau outlet'), '#1d5b94');

  const td = presetAt(inp, ['tiga-dihaji']);
  add('tiga-dihaji', td ? [td.lon, td.lat] : FALLBACK.tiga_dihaji, 'labels', 'dam', 1,
    t('thematic.tiga_dihaji', 'Tiga Dihaji Dam\n(under construction)'), '#8a5200');
  return { type: 'FeatureCollection', features: out };
}

function buildCanal(ctx, inp, headAt) {
  const found = findMainCanal(inp.rivers, headAt);
  if (!found) return EMPTY;
  const lang = ctx.store.get('lang') === 'en' ? 'en' : 'id';
  const label = inp.facts.main_canal?.label?.[lang] || ctx.t('thematic.main_canal', 'Komering main canal');
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { label, km: found.km }, geometry: found.feature.geometry }] };
}

// The active maker dam's catchment outline (field catchment.mask:<id>, written by s01) with its name and area.
function makerCatch(ctx) {
  const { store, fields } = ctx;
  if (store.get('mode') !== 'maker') return EMPTY;
  const id = store.get('maker.active');
  if (!id || !fields) return EMPTY;
  const f = fields.get('catchment.mask:' + id);
  const o = f?.outline;
  if (!o) return EMPTY;
  const geoms = o.type === 'FeatureCollection' ? o.features.map((x) => x.geometry) : o.type === 'Feature' ? [o.geometry] : [o];
  const polys = geoms.filter((g) => g && /Polygon$/.test(g.type));
  if (!polys.length) return EMPTY;
  const dam = (store.get('maker.dams') || []).find((d) => d.id === id);
  const area = f.area_km2 ?? dam?.catchment_km2;
  const features = polys.map((geometry) => ({ type: 'Feature', properties: {}, geometry }));
  const big = polys.reduce((a, b) => (JSON.stringify(b).length > JSON.stringify(a).length ? b : a));
  const at = labelPoint(thinGeom(big));
  if (at) {
    features.push(pt(at, { label: ctx.t('thematic.maker_catch', 'Catchment of {name}', { name: dam?.name || ctx.t('thematic.your_dam', 'your dam') }) +
      '\n' + ctx.fmt.area(area) }));
  }
  return { type: 'FeatureCollection', features };
}

// ---------- module ----------

export async function init(ctx) {
  const map = ctx.map;
  if (!map || !ctx.store) return;
  // map/map resolves after the style 'load' event; isStyleLoaded() is false while sources load, so ask the style itself
  if (map.style && !map.style._loaded) await new Promise((res) => map.once('load', res));
  // Boot must not wait for our six data files on a slow renderer: load and draw after init returns.
  setup(ctx, map).catch((e) => console.warn('[thematic] ' + (e?.message || e)));
}

async function setup(ctx, map) {
  const store = ctx.store;
  const inp = await loadInputs(ctx);
  inp.gaugeKm = gaugeKm(inp.facts);

  const cat = buildCatchments(inp);
  const headFeat = () => buildMarkers(ctx, inp).features.find((f) => f.properties.id === 'canal-head')?.geometry.coordinates || FALLBACK.canal_head;
  const srcData = {
    'b23-catch': cat.polys,
    'b23-catch-labels': catchLabels(ctx, inp, cat.anchors),
    'b23-canal': buildCanal(ctx, inp, headFeat()),
    'b23-markers': buildMarkers(ctx, inp),
    'b23-maker-catch': makerCatch(ctx),
  };
  for (const [id, data] of Object.entries(srcData)) if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data, tolerance: 0.4 });
  if (!map.getSource('b23-streams')) {
    const url = new URL(ctx.data.url('feat/streams.geojson'), location.href).href;
    map.addSource('b23-streams', { type: 'geojson', data: url, tolerance: 0.5 });
  }
  addIcons(map);

  const groups = new Map(); // layer id -> view.layers flag
  const tops = [];
  for (const [spec, group, place] of layerDefs(ctx.t)) {
    groups.set(spec.id, group);
    if (map.getLayer(spec.id)) continue;
    try {
      if (place === 'top') {
        map.addLayer(spec);
        tops.push(spec.id);
      } else {
        map.addLayer(spec, map.getLayer('three') ? 'three' : undefined);
      }
    } catch (e) {
      console.warn('[thematic] layer ' + spec.id + ': ' + e.message);
    }
  }

  const applyFlags = () => {
    const flags = store.get('view.layers') || {};
    for (const [id, group] of groups) {
      if (!map.getLayer(id)) continue;
      map.setLayoutProperty(id, 'visibility', flags[group] === false ? 'none' : 'visible');
    }
  };
  // Our names stay the top layers, so they are placed before (and never under) any other name.
  const raise = () => {
    for (const id of tops) if (map.getLayer(id)) map.moveLayer(id);
  };
  const relabel = () => {
    map.getSource('b23-catch-labels')?.setData(catchLabels(ctx, inp, cat.anchors));
    map.getSource('b23-markers')?.setData(buildMarkers(ctx, inp));
    map.getSource('b23-canal')?.setData(buildCanal(ctx, inp, headFeat()));
    map.getSource('b23-maker-catch')?.setData(makerCatch(ctx));
  };
  const refreshMaker = () => map.getSource('b23-maker-catch')?.setData(makerCatch(ctx));

  applyFlags();
  store.on('view.layers', applyFlags);
  store.on('lang', relabel);
  store.on('mode', refreshMaker);
  let offField = null;
  let fieldFor = null;
  store.on('maker', () => {
    const id = store.get('maker.active');
    if (id !== fieldFor) {
      offField?.();
      offField = id && ctx.fields ? ctx.fields.on('catchment.mask:' + id, refreshMaker) : null;
      fieldFor = id;
    }
    refreshMaker();
  });
  store.listen('app:ready', raise);

  ctx.thematic = {
    layers: () => [...groups.keys()],
    markers: () => buildMarkers(ctx, inp).features.map((f) => ({ ...f.properties, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })),
    raise,
    refresh: relabel,
  };
}
