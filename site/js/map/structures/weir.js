// Bendung Perjaya: the weir in 3D (lane b08). Pure factory, never touches the map (CONTRACT 4.7).
//
// Model frame: metres at true scale; +X along the weir axis from the LEFT (west, Keromongan) bank to the RIGHT (east,
// Perjaya) bank; +Y up; +Z upstream = south (the Komering runs south to north here, CONTRACT A1), so -Z is
// downstream/north. REFERENCE POINT: the centre of the axis (weir.json axis.lon/lat). REFERENCE ELEVATION: project
// EL 0, i.e. a vertex's y IS its project EL. Mount it with el = 0 + params.datum.offset_m and bearing_deg =
// axis.bearing_deg - 90 (the axis runs along +X).
//
// GATE TYPE, decided from the seven reference pictures: vertical-lift roller gates with a low flap on top, not
// radial gates. Why: (1) a tall hoist tower stands on every pier (ref 01, 04): lift gates need their hoists high
// above the leaf, radial gates are worked from low pier-top hoists and need no towers; (2) on the z18 aerial (ref
// 03, 04) the orange-red gate tops run as one straight line in line with the pier slots, with no curved skin plates
// or arms reaching back to trunnions; (3) in the drone photo (ref 01) the leaves between the towers are flat panels
// with horizontal blue girders; (4) the sources speak of lift gates with flaps (UNISMA 2022) and the 1981 design had
// roller gates (JICA). The scouring sluice bays carry the scouring leaf over the under-sluice leaf in one slot.
//
// buildWeir(THREE, weirParams) -> { group, setGates(openings_m[7]), setSluices(openings_m[3]),
//   setLevels({pond_y, tail_y}), setFlows({gate_q[7], sluice_q[3]}), update(dt, t), wake(), triangles, params }
// The water inside the weir is weir/flow.js: a moving 3D surface shaped by the flow through each bay. Gates, levels
// and flows glide to their new values (about half a second), so the leaves travel and the water follows them.
// Without setFlows (a page with no engine) the flow of a bay is estimated from its opening.
// weirParams: the parsed site/data/weir.json (leaves {v, ...}) or the object normaliseWeir() returns.
import { materials, countTriangles } from './weir/parts.js';
import { buildCivil } from './weir/civil.js';
import { gateFactory } from './weir/gates.js';
import { createBayWater } from './weir/flow.js';
import { estimateFlow } from './weir/hydraulics.js';
import { waterKit } from '../water/surface.js';

const v = (leaf, fb) => (leaf && typeof leaf === 'object' && 'v' in leaf ? leaf.v : leaf ?? fb);

const DEFAULT_WATER = { shallow: 0x7fb2cc, body: 0x3f7fa6, deep: 0x1f5a85, foam: 0xf6f8f8 };
function pickColours(w) {
  const out = {};
  if (!w || typeof w !== 'object') return out;
  for (const k of ['shallow', 'body', 'deep', 'foam']) {
    const c = w[k];
    if (typeof c === 'number' && isFinite(c)) out[k] = c;
    else if (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c.trim())) out[k] = parseInt(c.trim().replace('#', ''), 16);
  }
  return out;
}

// FALLBACK values (SETTLE.md item 7) used only when weir.json lacks a key.
export function normaliseWeir(W = {}) {
  if (W && W.__normalised) return W;
  const length = v(W.axis?.length_m, 215.5); // FALLBACK
  const bays = (Array.isArray(W.bays) && W.bays.length ? W.bays : fallbackBays()).map((b, i) => ({
    id: b.id || `B${i + 1}`, kind: b.kind || 'flood',
    width: v(b.width_m, 20), gate_h: v(b.gate_h_m, 2.9), under_h: v(b.under_h_m, 0),
    sill_el: v(b.sill_el, 78.1), basin_len: v(b.basin_len_m, 30), end_sill: v(b.end_sill_m, 2),
    x_left: v(b.x_left_m, 0),
  }));
  const pierW = v(W.piers?.width_m, 3);
  let piers = v(W.piers?.x_centre_m, null);
  if (!Array.isArray(piers)) piers = bays.slice(0, -1).map((b) => b.x_left + b.width + pierW / 2);
  const dv = W.divide_wall;
  let divide = null;
  if (dv) {
    const between = v(dv.between, ['FG7', 'SG1']);
    const iA = bays.findIndex((b) => b.id === between[0]);
    const xd = iA >= 0 ? bays[iA].x_left + bays[iA].width + pierW / 2 : piers[6];
    divide = { x: xd, up: v(dv.upstream_m, 68), down: v(dv.downstream_m, 83), top: v(dv.top_el, 81.5) }; // FALLBACK top 81.5 (weir.json divide_wall.top_el)
  }
  const lv = W.levels || {};
  return {
    __normalised: true, length, bays, piers, pierW,
    abutL: v(W.abutments?.left_width_m, 5.5), abutR: v(W.abutments?.right_width_m, 5.5),
    nose: v(W.piers?.nose, 'round'),
    flapH: v(W.gates?.flap_h_m, 0.6), liftMax: v(W.gates?.lift_max_m, 4.5),
    deckEl: v(W.deck?.el, 83), bandW: v(W.deck?.band_width_m, 12), roadW: v(W.deck?.road_width_m, 6),
    tower: v(W.deck?.tower_footprint_m, [6, 8]), towerH: v(W.deck?.tower_height_m, 7),
    railH: v(W.bridge?.railing_h_m, 1.1), divide,
    basinFloor: v(W.stilling_basin?.floor_el, 73), riverbed: v(lv.riverbed_el, 74),
    pond: v(lv.pond_normal_el, 81), dhwl: v(lv.design_high_water_el, 81),
    maxBasin: Math.max(...bays.map((b) => b.basin_len)),
    // water colours: lane b06's shared palette (WATER from map/water/palette.js) passed in by mount-weir as
    // `water: {shallow, body, deep, foam}` (hex strings or numbers); the defaults are a clear river blue
    water: { ...DEFAULT_WATER, ...pickColours(W.water) },
  };
}

function fallbackBays() { // FALLBACK: SETTLE.md item 7 (7 flood gates 20 m, 5 of 2.9 m and 2 of 3.9 m; 3 sluices 12.5 m)
  const out = []; let x = 5.5;
  for (let i = 0; i < 7; i++) { out.push({ id: `FG${i + 1}`, kind: 'flood', width_m: 20, gate_h_m: i < 5 ? 2.9 : 3.9, sill_el: i < 5 ? 78.1 : 77.1, basin_len_m: i < 3 ? 30 : 40, end_sill_m: i < 3 ? 2 : 3, x_left_m: x }); x += 23; }
  x -= 23; x += 20 + 3;
  for (let i = 0; i < 3; i++) { out.push({ id: `SG${i + 1}`, kind: 'sluice', width_m: 12.5, gate_h_m: 4.2, under_h_m: 2.0, sill_el: 74.8, basin_len_m: 50, end_sill_m: 3, x_left_m: x }); x += 15.5; }
  return out;
}

export function buildWeir(THREE, weirParams) {
  const P = normaliseWeir(weirParams || {});
  const mats = materials(THREE);
  const group = new THREE.Group();
  group.name = 'weir';
  const civil = buildCivil(THREE, P, mats);
  group.add(civil.group);
  const L = civil.layout, X = civil.X;

  // gate leaves, one factory per leaf size
  const facs = new Map();
  const leafFor = (B) => {
    const key = `${B.kind}:${B.width}:${B.gate_h}:${B.under_h}`;
    if (!facs.has(key)) facs.set(key, gateFactory(THREE, mats, B.kind === 'sluice'
      ? { width: B.width, height: B.gate_h, underHeight: B.under_h }
      : { width: B.width, height: B.gate_h, flapH: P.flapH }));
    return facs.get(key);
  };
  const ropeGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 5);
  ropeGeo.translate(0, 0.5, 0);

  const bays = P.bays.map((B) => {
    const fac = leafFor(B);
    const leaf = fac.make();
    const xc = X(B.x_left + B.width / 2);
    leaf.position.set(xc, B.sill_el, L.zGate);
    group.add(leaf);
    const ropes = [-1, 1].map((s) => {
      const r = new THREE.Mesh(ropeGeo, mats.rope);
      r.position.set(xc + s * (B.width / 2 - 1.2), 0, L.zGate);
      group.add(r);
      return r;
    });
    return { B, leaf, ropes, xc, maxOpen: P.liftMax, h: fac.height };
  });
  const nb = bays.length;
  const floodIdx = bays.map((b, i) => (b.B.kind !== 'sluice' ? i : -1)).filter((i) => i >= 0);
  const sluiceIdx = bays.map((b, i) => (b.B.kind === 'sluice' ? i : -1)).filter((i) => i >= 0);

  // the water: weir/flow.js draws it from the state below (the map's own water lane draws the river beyond)
  const water = createBayWater(THREE, P, civil);
  group.add(water.group);
  const kit = waterKit(THREE);
  const x0 = X(0), x1 = X(P.length);

  // where things are going (want) and where they are now (now): openings, flows (null = estimate), levels
  const want = { a: new Array(nb).fill(0), q: new Array(nb).fill(null), H: P.pond, T: P.riverbed + 1.5 };
  const now = { a: new Array(nb).fill(0), q: new Array(nb).fill(0), H: want.H, T: want.T };
  const flowOf = (i) => {
    const B = bays[i].B;
    const q = want.q[i];
    return q != null && isFinite(q) ? Math.max(0, q) : estimateFlow({ a: want.a[i], width: B.width, H: want.H, T: want.T, sill: B.sill_el });
  };
  let settled = false;

  function place(i) {
    const b = bays[i], B = b.B;
    const o = now.a[i];
    b.leaf.position.y = B.sill_el + o;
    const top = B.sill_el + o + b.h;
    for (const r of b.ropes) { r.position.y = top; r.scale.y = Math.max(0.05, L.houseFloor - 0.45 - top); }
  }
  // move `now` towards `want` by the share k (1 = jump there); true while anything is still moving
  function glide(k) {
    let moving = false;
    const step = (cur, to, eps) => {
      const d = to - cur;
      if (Math.abs(d) <= eps || k >= 1) return to;
      moving = true;
      return cur + d * k;
    };
    for (let i = 0; i < nb; i++) {
      now.a[i] = step(now.a[i], Math.max(0, Math.min(bays[i].maxOpen, want.a[i])), 0.004);
      now.q[i] = step(now.q[i], flowOf(i), 0.02);
      place(i);
    }
    now.H = step(now.H, want.H, 0.003);
    now.T = step(now.T, want.T, 0.003);
    water.set(now);
    return moving;
  }
  glide(1);

  let t = 0;
  const api = {
    group, params: P,
    setGates(openings) { if (!Array.isArray(openings) && !ArrayBuffer.isView(openings)) return; floodIdx.forEach((bi, i) => { if (openings[i] != null && isFinite(openings[i])) want.a[bi] = +openings[i]; }); settled = false; },
    setSluices(openings) { if (!Array.isArray(openings) && !ArrayBuffer.isView(openings)) return; sluiceIdx.forEach((bi, i) => { if (openings[i] != null && isFinite(openings[i])) want.a[bi] = +openings[i]; }); settled = false; },
    setLevels({ pond_y, tail_y } = {}) {
      if (pond_y != null && isFinite(pond_y)) want.H = +pond_y;
      if (tail_y != null && isFinite(tail_y)) want.T = +tail_y;
      settled = false;
    },
    // the flow through every bay in m3/s (the engine's gate_q and sluice_q); null or missing = estimate it
    setFlows({ gate_q, sluice_q } = {}) {
      floodIdx.forEach((bi, i) => { want.q[bi] = gate_q && isFinite(gate_q[i]) ? +gate_q[i] : null; });
      sluiceIdx.forEach((bi, i) => { want.q[bi] = sluice_q && isFinite(sluice_q[i]) ? +sluice_q[i] : null; });
      settled = false;
    },
    // jump straight to the values set (no glide): for a first frame or a still picture
    settle() { glide(1); settled = true; },
    // dt: seconds since the last frame; t: the frame clock's time (a page without one leaves it out)
    update(dt, time) {
      if (!(dt > 0)) dt = 0;
      t += dt;
      kit.setTime(Number.isFinite(time) ? time : t);
      if (!settled) settled = !glide(dt > 0 ? 1 - Math.exp(-dt / 0.45) : 1);
    },
    wake: () => water.wake(),
    water: () => ({ ...water.info(), H: now.H, T: now.T }),
    get triangles() { return countTriangles(group); },
    footprint: { x0, x1, zUp: water.footprint.zUp, zDown: water.footprint.zDown },
  };
  return api;
}
