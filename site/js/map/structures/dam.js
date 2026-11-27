// The maker dam in 3D (CONTRACT 4.7). Owner: lane b24. A pure factory: it never touches the map, so the model can
// be built and turned around alone (site/dev/b24.html).
//
//   buildDam(THREE, { profile:[{d_m, ground_m}], crest_el, base_el, type 'embankment'|'gravity', crest_width_m,
//                     spill_width_m, ground?(d_m, z_m) -> el, origin_d_m?, water?{shallow, body, deep, foam} })
//     -> { group, setSpill(q_m3s), update(dt), info, tris, dispose() }
//
// Model frame: metres at true scale. X runs along the dam line from bank a (left bank, looking downstream) to bank b,
// with X = d_m - origin_d_m (origin_d_m defaults to the middle of the profile). Y = elevation - base_el, so the
// mount places the model at el = base_el. +Z points UPSTREAM (-Z downstream). Mounted with
// bearing_deg = line.bearing_deg - 90 (the line's bearing runs a -> b), the model's -Z points downstream.
// `profile` is reservoir.damLine's ground along the line (model metres); `ground(d_m, z_m)` (optional) gives the
// ground anywhere under the footprint (z_m = metres upstream of the line) so the base follows the real ground
// up and down the valley as well as across it.
// crest_el is the level at which the lake spills (the reservoir engine's crest): the embankment's ungated ogee and
// the top of the gravity dam's gates sit there; the dam crest stands a freeboard above it.

import { makeGround } from './dam/section.js';
import { makeTextures } from './dam/tex.js';
import { buildEmbankment } from './dam/embankment.js';
import { buildGravity } from './dam/gravity.js';

function materials(THREE, tex, water) {
  const L = (opts) => new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, ...opts });
  const rep = (t) => t;
  const m = {
    riprap: L({ map: rep(tex.riprap) }),
    riprapWet: L({ map: tex.riprapWet }),
    toe: L({ map: tex.riprap, color: 0xd8d4cc }),
    grass: L({ map: tex.grass }),
    berm: L({ map: tex.gravel }),
    shoulder: L({ map: tex.gravel, color: 0xe6e0d4 }),
    road: L({ map: tex.asphalt }),
    conc: L({ map: tex.concrete }),
    spill: L({ map: tex.concrete, color: 0xf2efe8 }),
    spillWall: L({ map: tex.concretePlain }),
    crestEdge: L({ map: tex.concretePlain, color: 0xe8e4dc }),
    chuteFloor: L({ map: tex.concretePlain, color: 0xe2ddd2 }),
    wall: L({ map: tex.concretePlain }),
    concretePlain: L({ map: tex.concretePlain }),
    pier: L({ map: tex.concretePlain, color: 0xf4f1ea }),
    kerb: L({ color: 0xdcd8cf }),
    steel: L({ color: 0x5f6a72 }),
    gate: L({ color: 0x3f6e8c }),
    lamp: new THREE.MeshBasicMaterial({ color: 0xfff4d6 }),
    house: L({ color: 0xe9e2d0 }),
    roof: L({ color: 0x8a4b3a }),
    foam: new THREE.MeshBasicMaterial({ map: tex.foam, transparent: true, opacity: 0, depthWrite: false, color: new THREE.Color(water.foam),
      side: THREE.DoubleSide }),
  };
  m.default = m.concretePlain;
  return m;
}

export function buildDam(THREE, opts = {}) {
  const profile = Array.isArray(opts.profile) ? opts.profile : [];
  const ds = profile.map((p) => p.d_m).filter(Number.isFinite);
  const dMin = ds.length ? Math.min(...ds) : 0, dMax = ds.length ? Math.max(...ds) : 100;
  // the base is the dam foot from the reservoir engine (its fill and curve start there); else the profile's lowest
  let base = Number.isFinite(opts.base_el) ? opts.base_el : Infinity;
  if (!Number.isFinite(base)) for (const p of profile) if (Number.isFinite(p.ground_m)) base = Math.min(base, p.ground_m);
  if (!Number.isFinite(base)) base = 0;
  const origin = Number.isFinite(opts.origin_d_m) ? opts.origin_d_m : (dMin + dMax) / 2;
  const G = makeGround(profile, base, origin, opts.ground);
  let crest = Number.isFinite(opts.crest_el) ? opts.crest_el : base + 30;
  // the line's ends are where the ground reaches the crest; the deepest point is the river
  let xDeep = 0, gMin = Infinity;
  for (const p of profile) if (p.ground_m < gMin) { gMin = p.ground_m; xDeep = p.d_m - origin; }
  if (typeof opts.ground === 'function') {
    // the river from the finer ground the mount sampled: lowest point on the axis inside the line
    let best = Infinity;
    for (let d = dMin; d <= dMax; d += 3) { const g = G(d - origin, 0); if (g < best) { best = g; xDeep = d - origin; } }
  }
  const Ys = Math.max(2, crest - base);
  // the banks: where the ground on the axis reaches the spill level, walking out from the river
  const bank = (dir) => {
    let x = xDeep;
    for (let i = 0; i < 8000; i++, x += dir) if (G(x, 0) >= Ys) return x;
    return dir < 0 ? dMin - origin : dMax - origin;
  };
  const P = {
    G, Ys, xDeep, xa: bank(-1), xb: bank(1),
    crest_width_m: Number.isFinite(opts.crest_width_m) ? opts.crest_width_m : 0,
    spill_width_m: Number.isFinite(opts.spill_width_m) && opts.spill_width_m > 2 ? opts.spill_width_m : 30, // FALLBACK when no width came
  };
  const tex = makeTextures(THREE);
  // water colours: lane b06's shared palette passed in by the mount (A8.1); these defaults match it
  const water = { shallow: '#7fb2cc', body: '#3f7fa6', deep: '#1f5a85', foam: '#ffffff', ...(opts.water || {}) };
  const mats = materials(THREE, tex, water);
  const type = opts.type === 'gravity' ? 'gravity' : 'embankment';
  const body = type === 'gravity' ? buildGravity(THREE, P, mats, tex) : buildEmbankment(THREE, P, mats, tex);
  const group = new THREE.Group();
  group.name = 'maker-dam';
  group.add(body.group);
  let q = 0;
  body.setSpill(0);
  return {
    group,
    info: { ...body.info, origin_d_m: origin, base_el: base, crest_el: crest, type },
    get tris() { return countTris(group); },
    setSpill(qm3s) {
      const v = Number.isFinite(qm3s) && qm3s > 0 ? qm3s : 0;
      if (v === q) return;
      q = v;
      body.setSpill(q);
      // a thin spill reads as clear shallow water, a big one as white water
      mats.foam.color.set(water.shallow).lerp(new THREE.Color(water.foam), Math.min(1, 0.35 + q / 300));
    },
    update(dt) { if (q > 0 && dt > 0) body.update(Math.min(dt, 0.25)); },
    dispose() {
      group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      for (const k of Object.keys(mats)) mats[k].dispose();
      for (const k of Object.keys(tex)) tex[k].dispose();
    },
  };
}

export function countTris(root) {
  let n = 0;
  root.traverse((o) => {
    if (!o.geometry || !o.visible && o.isPoints) return;
    if (o.isPoints) return;
    const g = o.geometry;
    const per = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    n += per * (o.isInstancedMesh ? o.count : 1);
  });
  return Math.round(n);
}
