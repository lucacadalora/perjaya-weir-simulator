// Water surfaces. Owner: lane b06. CONTRACT 4.4, 4.5, 4.7 and amendment A3.
// - Maker mode: for every dam with a `reservoir.mask:<id>` field, a sheet at the dam's level over the mask's box.
// - The weir: two sheets in the river channel, the pond upstream of the axis at weir.pond_el and the tailwater
//   downstream at weir.tail_el (project EL, turned into model metres with params.datum.offset_m).
// The terrain in the depth buffer draws the shoreline; masks only keep water out of hollows that do not belong.
// Exposes ctx.water = { sheets(), weirInfo() } for test pages; nothing else binds to it.

import { createSheet } from './water/sheet.js';
import { readCarve, buildCarveSheets } from './water/carve.js';
import { bboxDegrees, bboxFromDegrees, cropGround, cropMask, maskBytes, rasterLines, rasterPolygons, riverFloor, channelMask, splitByAxis } from './water/masks.js';
import { JOIN } from './water/join.js';
import { waterKit } from './water/surface.js';

// Display choices (not researched numbers): how far around the weir the river sheets reach, and how the channel
// is grown from the mapped centreline on the 30 m grid.
const WEIR_REACH_DEG = { up: 0.055, down: 0.035, side: 0.03 };
const CHANNEL = { rise_m: 3, max_steps: 2 }; // about 70 m either side of the mapped river line (lead, 23 Nov)
const OUTLINE_SUB = 3; // river outline mask: 3 x 3 sub-cells per 30 m ground cell
// The weir's own water (lane b08, structures/weir/flow.js) covers the bays between the lines of water/join.js; the
// river sheets stop exactly on those lines (a cut in the shader). The masks only need to be solid there, so they
// reach a little further in than the lines.
const WEIR_DRY_M = { up: 0, down: Math.max(0, JOIN.down - 12) };
// The terrain is dug out under the weir model's footprint (lane g07, carve.json weir_pit; the footprint is the
// model's: its length, 23.5 m upstream and 58 m downstream of the axis). The river's outline is narrower than the
// weir there, so the masks take that pit in, between the abutments only (behind them is the bank).
const WEIR_PIT_M = { up: 33.5, down: 68 };
// The pocket of the pond in front of the intake on the right bank, behind the divide wall: it runs from the last
// 45 m of the weir's length to the intake's face and to the far end of the intake (lane b09 opens the surface model
// there, structures/site.js). Metres; the intake's place comes from weir.json.
const WEIR_POCKET_M = { back: 45, clear: 1.5, up0: 19, beyond: 11 };

const v = (x) => (x && typeof x === 'object' && 'v' in x ? x.v : x);
const num = (x) => (Number.isFinite(Number(v(x))) && v(x) !== null && v(x) !== '' ? Number(v(x)) : null);

export async function init(ctx) {
  const s3 = ctx.scene3d;
  if (!ctx.map || !s3 || !s3.THREE) return;
  const THREE = s3.THREE;
  const store = ctx.store;
  const live = new Set(); // every sheet that is in the scene: {sheet, handle, kind, id}
  const grids = {};

  function loadGrid(name) {
    if (!grids[name]) {
      grids[name] = Promise.all([ctx.data.json('grid/' + name + '.json'), ctx.data.bin('grid/' + name + '.dem.i16')])
        .then(([meta, buf]) => ({ meta, dem: new Int16Array(buf) }));
      grids[name].catch(() => delete grids[name]);
    }
    return grids[name];
  }

  // a sheet over a cell box of a grid, placed in the scene; returns {sheet, handle}
  function placeSheet(meta, bbox, ground, maskB, name, opts = {}) {
    const d = bboxDegrees(meta, bbox);
    const [x0, , z0] = s3.toLocal(d.west, d.north, 0);
    const [x1, , z1] = s3.toLocal(d.east, d.south, 0);
    const sheet = createSheet(THREE, {
      cols: ground.cols, rows: ground.rows, ground: ground.ground, groundMin: ground.min, mask: maskB,
      width_m: Math.abs(x1 - x0), height_m: Math.abs(z1 - z0), name, ...opts,
    });
    sheet.mesh.visible = false;
    if (sheet.fitTerrain) sheet.fitTerrain(ctx.sampler, d).then(() => s3.requestRender(), () => {}); // lane w hook: the ground under the water = the drawn terrain
    const handle = s3.add(sheet.mesh, { lon: (d.west + d.east) / 2, lat: (d.north + d.south) / 2, el: 0 });
    return { sheet, handle, width_m: Math.abs(x1 - x0), height_m: Math.abs(z1 - z0) };
  }

  function setLevel(entry, level) {
    if (!entry) return;
    const ok = Number.isFinite(level);
    if (ok && entry.sheet.level !== level) {
      entry.sheet.setLevel(level);
      entry.handle.set({ el: level });
    }
    entry.sheet.mesh.visible = ok && entry.shown !== false;
    s3.requestRender();
  }

  // ---------- moving water: time comes only from the frame clock (lead addendum) ----------
  const kit = waterKit(THREE);
  if (kit.follow) kit.follow(store); // lane w hook: the river's colour follows its flow (flow.q_in)
  s3.onFrame((dt, t) => {
    kit.setTime(t);
    frameWeir(dt);
  });

  // ---------- maker reservoirs ----------
  const reservoirs = new Map(); // dam id -> {sheet, handle, key, offField, version}

  function dropReservoir(id) {
    const r = reservoirs.get(id);
    if (!r) return;
    r.offField && r.offField();
    if (r.entry) {
      r.entry.handle.remove();
      r.entry.sheet.dispose();
      live.delete(r.entry);
    }
    reservoirs.delete(id);
  }

  function damLevel(id, field) {
    const dam = (store.get('maker.dams') || []).find((d) => d && d.id === id);
    const l = dam && Number.isFinite(dam.level_el) ? dam.level_el : field && Number.isFinite(field.level_el) ? field.level_el : null;
    return l;
  }

  async function applyReservoirField(id, f) {
    const r = reservoirs.get(id);
    if (!r) return;
    if (!f || !f.mask || !Array.isArray(f.bbox)) {
      if (r.entry) r.entry.sheet.mesh.visible = false;
      return;
    }
    if (r.entry && r.version === f.version && f.version != null) return;
    let g;
    try {
      g = await loadGrid(f.grid || 'wide');
    } catch (e) {
      ctx.log('water: grid not there', e);
      return;
    }
    if (reservoirs.get(id) !== r) return; // removed meanwhile
    // the sheet covers the mask's box with room to grow, so a rising lake reuses its textures (only the mask
    // bytes are copied); a new sheet is built only when the lake outgrows that window
    const inside = r.crop && f.bbox[0] >= r.crop[0] && f.bbox[1] >= r.crop[1] && f.bbox[2] <= r.crop[2] && f.bbox[3] <= r.crop[3];
    const win = inside ? r.crop : growBox(f.bbox, g.meta);
    const full = cropMask(f.mask, g.meta, win);
    const crop = full || embedMask(cropMask(f.mask, g.meta, f.bbox), f.bbox, win);
    if (!crop) {
      ctx.log('water: mask size does not fit its bbox', id);
      return;
    }
    if (r.entry && inside) {
      maskBytes(crop, r.bytes, win[2] - win[0] + 1);
      r.entry.sheet.setMask(r.bytes);
    } else {
      if (r.entry) {
        r.entry.handle.remove();
        r.entry.sheet.dispose();
        live.delete(r.entry);
      }
      const ground = cropGround(g.dem, g.meta, win);
      r.bytes = maskBytes(crop, null, win[2] - win[0] + 1);
      r.entry = placeSheet(g.meta, win, ground, r.bytes, 'reservoir:' + id, { depthScale: 12 });
      r.entry.kind = 'reservoir';
      r.entry.id = id;
      r.crop = win;
      r.rebuilds = (r.rebuilds || 0) + 1;
      live.add(r.entry);
    }
    r.version = f.version;
    r.entry.shown = store.get('mode') === 'maker';
    setLevel(r.entry, damLevel(id, f));
  }

  function syncDams() {
    const dams = (store.get('maker.dams') || []).filter((d) => d && d.id != null);
    const ids = new Set(dams.map((d) => d.id));
    for (const id of [...reservoirs.keys()]) if (!ids.has(id)) dropReservoir(id);
    for (const d of dams) {
      let r = reservoirs.get(d.id);
      if (!r) {
        r = { entry: null, key: null, version: undefined };
        reservoirs.set(d.id, r);
        const name = 'reservoir.mask:' + d.id;
        r.offField = ctx.fields.on(name, (f) => applyReservoirField(d.id, f));
        const now = ctx.fields.get(name);
        if (now) applyReservoirField(d.id, now);
      } else if (r.entry) {
        setLevel(r.entry, damLevel(d.id, ctx.fields.get('reservoir.mask:' + d.id)));
      }
    }
  }
  store.on('maker.dams', syncDams, { immediate: true });
  store.on('mode', (mode) => {
    for (const r of reservoirs.values()) if (r.entry) {
      r.entry.shown = mode === 'maker';
      setLevel(r.entry, r.entry.sheet.level);
    }
  });

  // ---------- the weir: pond and tailwater in the river channel ----------
  const weir = { pond: null, tail: null, offset: 0, info: null };
  ctx.water = {
    sheets: () => [...live].map((e) => ({ kind: e.kind, id: e.id, level: e.sheet.level, visible: e.sheet.mesh.visible, rebuilds: e.kind === 'reservoir' ? reservoirs.get(e.id)?.rebuilds : undefined, cols: e.sheet.cols, rows: e.sheet.rows })),
    weirInfo: () => weir.info,
  };

  buildWeirSheets(ctx, { loadGrid, placeSheet, setLevel, live, weir }).catch((e) => {
    ctx.log('water: weir sheets not built', e);
  });

  // ---------- the river's current and the white water below the weir ----------
  // Mid-channel speed = flow / (width x mean depth), from the store's own numbers; it only steers how fast the
  // ripples and the foam travel. The white water each bay sends on comes from the weir model (lane b08).
  const cur = { pond: 0, tail: 0 };
  function frameWeir(dt) {
    const h = weir.hyd;
    if (!h || !weir.pond || !weir.tail) return;
    const w = store.get('weir') || {};
    const f = store.get('flow') || {};
    const pondDepth = Number.isFinite(w.pond_el) ? Math.max(0.5, w.pond_el - h.bed_up) : null;
    const tailDepth = Number.isFinite(w.tail_el) ? Math.max(0.3, w.tail_el - h.bed_down) : null;
    const qUp = Number.isFinite(f.q_in) ? f.q_in : Number.isFinite(w.q_down) ? w.q_down : 0;
    const qDown = Number.isFinite(w.q_down) ? w.q_down : 0;
    const want = {
      pond: pondDepth ? Math.min(4, qUp / (h.width_up * pondDepth)) : 0,
      tail: tailDepth ? Math.min(4, qDown / (h.width_down * tailDepth)) : 0,
    };
    const k = dt > 0 ? 1 - Math.exp(-dt / 1.2) : 1; // a change of speed eases in, so the ripples never jump
    cur.pond += (want.pond - cur.pond) * k;
    cur.tail += (want.tail - cur.tail) * k;
    weir.pond.sheet.setFlow(cur.pond, pondDepth || 3);
    weir.tail.sheet.setFlow(cur.tail, tailDepth || 2);
    const wm = ctx.weirModel && ctx.weirModel.model;
    const ax = weir.tail.axis;
    if (wm && typeof wm.wake === 'function' && ax) {
      const wk = wm.wake();
      weir.tail.sheet.setWake(ax.x, ax.z, ax.dx, ax.dz, wk.z0, wk.bays);
    }
  }

  // ---------- touch the water: rings spread from the pointer ----------
  touchWater(ctx, { kit, live, weir });
}

// Where a pointer position meets the water: the ray from the eye through the pointer is cut with each water
// surface's level (not with the ground under it, which lies metres below). Rings start there.
function touchWater(ctx, { kit, live, weir }) {
  const s3 = ctx.scene3d;
  const map = ctx.map;
  const THREE = s3.THREE;
  if (!s3.camera || !map || typeof map.on !== 'function') return;
  const a = new THREE.Vector4();
  const b = new THREE.Vector4();
  const local = new THREE.Vector3();
  function hit(e) {
    const cv = map.getCanvas();
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!e || !e.point || !(w > 0) || !(h > 0)) return null;
    const nx = (e.point.x / w) * 2 - 1;
    const ny = 1 - (e.point.y / h) * 2;
    const inv = s3.camera.projectionMatrixInverse;
    a.set(nx, ny, -1, 1).applyMatrix4(inv);
    b.set(nx, ny, 1, 1).applyMatrix4(inv);
    if (Math.abs(a.w) < 1e-12 || Math.abs(b.w) < 1e-12) return null;
    a.multiplyScalar(1 / a.w);
    b.multiplyScalar(1 / b.w);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    if (Math.abs(dy) < 1e-9) return null;
    let best = null;
    const tryPlane = (y, wet) => {
      const t = (y - a.y) / dy;
      if (!(t > 0) || (best && t >= best.t)) return;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      if (wet(x, z)) best = { t, x, z };
    };
    for (const e2 of live) {
      const lvl = e2.sheet.level;
      if (lvl == null || !e2.sheet.mesh.visible) continue;
      const o = e2.handle.object.position;
      tryPlane(lvl, (x, z) => e2.sheet.wetAt(x - o.x, z - o.z));
    }
    const wm = ctx.weirModel;
    if (wm && wm.model && typeof wm.model.water === 'function') {
      const st = wm.model.water();
      const fp = wm.model.footprint;
      const inside = (up) => (x, z) => {
        local.set(x, 0, z);
        wm.handle.object.worldToLocal(local);
        return local.x > fp.x0 && local.x < fp.x1 && (up ? local.z > 4 && local.z < fp.zUp + 4 : local.z < 4 && local.z > fp.zDown - 4);
      };
      if (Number.isFinite(st.H)) tryPlane(st.H + wm.offset, inside(true));
      if (Number.isFinite(st.T)) tryPlane(st.T + wm.offset, inside(false));
    }
    return best;
  }
  let last = { x: 1e9, z: 1e9, t: -1e9 };
  map.on('mousemove', (e) => {
    if (e.originalEvent && e.originalEvent.buttons) return; // dragging the map, not touching the water
    const now = kit.time;
    if (now - last.t < 0.3) return;
    const p = hit(e);
    if (!p || Math.hypot(p.x - last.x, p.z - last.z) < 6) return;
    kit.ripple(p.x, p.z, 0.6);
    last = { x: p.x, z: p.z, t: now };
    s3.requestRender();
  });
  map.on('click', (e) => {
    const p = hit(e);
    if (!p) return;
    kit.ripple(p.x, p.z, 1.7);
    last = { x: p.x, z: p.z, t: kit.time };
    s3.requestRender();
  });
  ctx.water.touch = (x, z, strength) => kit.ripple(x, z, strength); // scene metres; for films and test pages
}

async function buildWeirSheets(ctx, { loadGrid, placeSheet, setLevel, live, weir }) {
  const store = ctx.store;
  const soft = (p) => p.catch(() => null);
  const [g, rivers, weirJson, params, outline] = await Promise.all([
    loadGrid('fine'), soft(ctx.data.json('feat/rivers.geojson')), soft(ctx.data.json('weir.json')), soft(ctx.data.json('params.json')),
    soft(ctx.data.json('feat/river_poly.geojson')), // the river's own outline (lane g06), when it exists
  ]);
  const carve = readCarve(await soft(ctx.data.json('feat/carve.json'))); // the carved bed (lane g07), when it exists
  const meta = g.meta;
  const ax = (weirJson && weirJson.axis) || {};
  const lon = num(ax.lon) ?? meta.weir?.feature?.lon ?? meta.weir?.lon; // FALLBACK: the grid header's weir point
  const lat = num(ax.lat) ?? meta.weir?.feature?.lat ?? meta.weir?.lat;
  const bearing = num(ax.bearing_deg) ?? 90; // FALLBACK: CONTRACT A1, the axis runs east to west
  const offset = num(params?.datum?.offset_m) ?? num(params?.flat?.['datum.offset_m']) ?? num(params?.flat?.datum_offset_m) ?? 0; // FALLBACK: 0 (SETTLED, status A)
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
  weir.offset = offset;
  // the pond is upstream: the side the flow comes from (weir.json flow_bearing_deg; A1: the river runs north)
  const fb = num(ax.flow_bearing_deg);
  const t = (bearing * Math.PI) / 180;
  const pondSide = Number.isFinite(fb)
    ? Math.cos(t) * Math.sin((fb * Math.PI) / 180) - Math.sin(t) * Math.cos((fb * Math.PI) / 180) < 0 ? 'a' : 'b'
    : 'a'; // FALLBACK: A1, the normal of an east-west axis points south, upstream
  const toModel = (el) => (Number.isFinite(el) ? el + offset : null);
  // for the current's speed: bed levels (project EL) and channel widths; FALLBACKS are the weir.json values
  const lvJ = (weirJson && weirJson.levels) || {};
  const flat = (params && params.flat) || {};
  weir.hyd = {
    bed_up: num(lvJ.riverbed_el) ?? 74, // FALLBACK: weir.json levels.riverbed_el
    bed_down: num(lvJ.tail_bed_el) ?? num(lvJ.riverbed_el) ?? 74, // FALLBACK
    width_up: num(ax.length_m) ?? 215.5, // FALLBACK: the weir's own length
    width_down: num(flat['weir.tail_width_m']) ?? num(ax.length_m) ?? 215.5, // FALLBACK
  };
  const follow = () => {
    store.on('weir.pond_el', (el) => setLevel(weir.pond, toModel(el)), { immediate: true });
    store.on('weir.tail_el', (el) => setLevel(weir.tail, toModel(el)), { immediate: true });
  };
  if (carve) {
    const half = (num(ax.length_m) ?? 215.5) / 2; // FALLBACK length: weir.json
    const inJ = (weirJson && weirJson.intake) || {};
    // the intake as lane b09 places it (site/layout.js): its face 6 m this side of its centre line, its centre
    // -y_m upstream, half its width either way. FALLBACKS: weir.json intake x_m 226, y_m -30, width_m 49.5
    const face = (num(inJ.x_m) ?? 226) - half - 6;
    const far = -(num(inJ.y_m) ?? -30) + (num(inJ.width_m) ?? 49.5) / 2;
    const pit = { half, up: WEIR_PIT_M.up, down: WEIR_PIT_M.down,
      pocket: { a0: half - WEIR_POCKET_M.back, a1: face - WEIR_POCKET_M.clear, up0: WEIR_POCKET_M.up0, up1: far + WEIR_POCKET_M.beyond } };
    const r = buildCarveSheets(carve, { meta: g.meta, dem: g.dem, lon, lat, bearing, pondSide, dry: WEIR_DRY_M, pit, placeSheet, live });
    weir.pond = r.pond;
    weir.tail = r.tail;
    weir.info = { lon, lat, bearing, offset, pondSide, ...r.info };
    follow();
    return;
  }

  const R = WEIR_REACH_DEG;
  // the river runs south to north at the weir (A1): upstream is south
  const bbox = bboxFromDegrees(meta, lon - R.side, lat - R.up, lon + R.side, lat + R.down);
  const ground = cropGround(g.dem, meta, bbox);
  const lines = [];
  for (const f of (rivers && rivers.features) || []) {
    const p = f.properties || {};
    if (p.kind !== 'river' || !/komering/i.test(p.name || '')) continue;
    const geom = f.geometry || {};
    if (geom.type === 'LineString') lines.push(geom.coordinates);
    else if (geom.type === 'MultiLineString') lines.push(...geom.coordinates);
  }
  const polys = [];
  for (const f of (outline && outline.features) || []) {
    if ((f.properties || {}).kind !== 'river') continue;
    const geom = f.geometry || {};
    if (geom.type === 'Polygon') polys.push(geom.coordinates);
    else if (geom.type === 'MultiPolygon') polys.push(...geom.coordinates);
  }
  // the mask may be finer than the ground grid (the textures share their 0..1 coordinates): the river outline is
  // drawn at a third of a cell (about 10 m, the picture it was cut from); the line corridor at whole cells
  const c = meta.cell ?? meta.cellsize_deg;
  const C = ground.cols;
  const Rw = ground.rows;
  let S = 1;
  let fine = null;
  let source = 'river_poly';
  if (polys.length) {
    S = OUTLINE_SUB;
    const sub = { west: meta.west + bbox[0] * c, north: meta.north - bbox[1] * c, cols: C * S, rows: Rw * S, cellsize_deg: c / S };
    fine = rasterPolygons(polys, sub, [0, 0, C * S - 1, Rw * S - 1]);
    if (!fine.some((x) => x)) (fine = null), (S = 1);
  }
  let channel;
  if (fine) {
    channel = new Uint8Array(C * Rw); // a ground cell is channel when any of its sub-cells is wet
    for (let r = 0; r < Rw * S; r++) for (let q = 0; q < C * S; q++) if (fine[r * C * S + q]) channel[((r / S) | 0) * C + ((q / S) | 0)] = 1;
  } else {
    if (!lines.length) return;
    channel = channelMask(ground.ground, C, Rw, rasterLines(lines, meta, bbox), CHANNEL);
    fine = channel;
    source = 'corridor';
  }
  const MC = C * S;
  const MR = Rw * S;
  const axCol = (lon - meta.west) / c - bbox[0];
  const axRow = (meta.north - lat) / c - bbox[1];
  const cellM = (c * Math.PI * 6378137) / 180 / S; // metres per mask cell (north-south)
  const gapUp = WEIR_DRY_M.up / cellM;
  const gapDown = WEIR_DRY_M.down / cellM;
  const gapA = pondSide === 'a' ? gapUp : gapDown;
  const gapB = pondSide === 'a' ? gapDown : gapUp;
  const sides = splitByAxis(fine, MC, MR, axCol * S, axRow * S, bearing, gapA, gapB);
  const base = { pond: sides[pondSide], tail: sides[pondSide === 'a' ? 'b' : 'a'] };
  const bytes = { pond: maskBytes(base.pond, null, MC), tail: maskBytes(base.tail, null, MC) };
  // the surface model shows the river's own surface (flown on one day), not its bed: the channel sheets never sink
  // below that smoothed surface, and rise flat above it when the level is higher
  const floor = riverFloor(ground.ground, C, Rw, channel);
  const hug = { depthScale: 6, floor, lift: 0.6, minDepth: 2.5, maskCols: MC, maskRows: MR };
  weir.pond = placeSheet(meta, bbox, ground, bytes.pond, 'weir:pond', hug);
  weir.tail = placeSheet(meta, bbox, ground, bytes.tail, 'weir:tail', hug);
  weir.pond.kind = 'weir-pond';
  weir.tail.kind = 'weir-tail';
  // the sheets stop on the lines where the weir's own water takes over (water/join.js)
  for (const k of ['pond', 'tail']) {
    const e = weir[k];
    const sgn = (k === 'pond') === (pondSide === 'a') ? 1 : -1;
    const axm = ((axCol * S) / MC - 0.5) * e.width_m;
    const azm = ((axRow * S) / MR - 0.5) * e.height_m;
    const cut = k === 'pond' ? JOIN.up : JOIN.down;
    e.sheet.setCut(axm + sgn * Math.cos(t) * cut, azm + sgn * Math.sin(t) * cut, sgn * Math.cos(t), sgn * Math.sin(t), JOIN.flat);
    e.axis = { x: axm, z: azm, dx: Math.sin(t), dz: -Math.cos(t) };
  }
  live.add(weir.pond);
  live.add(weir.tail);
  const count = (m) => m.reduce((a, x) => a + x, 0);
  weir.info = { lon, lat, bearing, offset, bbox, source, pondSide, cols: C, rows: Rw, mask_sub: S,
    pond_cells: count(base.pond), tail_cells: count(base.tail) };

  follow();

  // wet cells of the flood extent join the river on each side (same crop: the textures are reused)
  const [c0, r0] = bbox;
  const tmp = new Uint8Array(MC * MR);
  const onFlood = (f) => {
    const add = f && f.mask && f.mask.length === meta.cols * meta.rows ? f.mask : null;
    for (const k of ['pond', 'tail']) {
      const m = base[k];
      const other = base[k === 'pond' ? 'tail' : 'pond'];
      for (let r = 0; r < MR; r++) for (let q = 0; q < MC; q++) {
        const i = r * MC + q;
        let wet = m[i];
        if (!wet && add && add[(r0 + ((r / S) | 0)) * meta.cols + c0 + ((q / S) | 0)] && !other[i]) {
          const d = splitSide(q, r, axCol * S, axRow * S, bearing);
          const sideA = d > gapA;
          const sideB = d < -gapB;
          wet = k === 'pond' ? (pondSide === 'a' ? sideA : sideB) : pondSide === 'a' ? sideB : sideA;
        }
        tmp[i] = wet ? 1 : 0;
      }
      weir[k].sheet.setMask(maskBytes(tmp, bytes[k], MC));
    }
    ctx.scene3d.requestRender();
  };
  ctx.fields.on('flood.mask', onFlood);
  if (ctx.fields.get('flood.mask')) onFlood(ctx.fields.get('flood.mask'));
}

// a cell box grown by half its size (at least 24 cells) on every side, clamped to the grid
function growBox(b, meta) {
  const pc = Math.max(24, Math.ceil((b[2] - b[0] + 1) / 2));
  const pr = Math.max(24, Math.ceil((b[3] - b[1] + 1) / 2));
  return [Math.max(0, b[0] - pc), Math.max(0, b[1] - pr), Math.min(meta.cols - 1, b[2] + pc), Math.min(meta.rows - 1, b[3] + pr)];
}

// a mask that covers only `inner` placed into the larger window `outer`
function embedMask(m, inner, outer) {
  if (!m) return null;
  const ic = inner[2] - inner[0] + 1;
  const oc = outer[2] - outer[0] + 1;
  const out = new Uint8Array(oc * (outer[3] - outer[1] + 1));
  for (let r = 0; r < inner[3] - inner[1] + 1; r++) out.set(m.subarray(r * ic, (r + 1) * ic), (inner[1] - outer[1] + r) * oc + inner[0] - outer[0]);
  return out;
}

function splitSide(c, r, ax, ay, bearing) {
  const t = (bearing * Math.PI) / 180;
  return (c + 0.5 - ax) * Math.cos(t) + (r + 0.5 - ay) * Math.sin(t);
}
