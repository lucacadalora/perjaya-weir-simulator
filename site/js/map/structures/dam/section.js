// Shared geometry helpers for the maker dam: the ground function, the toe solver and a mesh collector.
// Owner: lane b24. Frame (see dam.js): X along the dam line from bank a to bank b (origin at the line middle),
// Y = elevation - base_el (metres), +Z upstream.

// Ground under the model, relative to base_el. From `ground(d_m, z_m)` (absolute model metres) when the mount
// sampled the terrain, else from the profile along the axis, the same at every z, extrapolated past the ends.
export function makeGround(profile, base_el, origin_d, ground) {
  const pts = (profile || []).filter((p) => Number.isFinite(p.d_m) && Number.isFinite(p.ground_m))
    .sort((p, q) => p.d_m - q.d_m);
  const n = pts.length;
  const endSlope = (i0, dir) => {
    // rise per metre going outward over about 60 m, never flatter than 0.25 (the valley side keeps rising)
    const p = pts[i0];
    let j = i0;
    while (j - dir >= 0 && j - dir < n && Math.abs(pts[j - dir].d_m - p.d_m) < 60) j -= dir;
    const q = pts[j];
    const s = q === p ? 0 : (p.ground_m - q.ground_m) / Math.abs(p.d_m - q.d_m);
    return Math.max(0.25, s);
  };
  const s0 = n ? endSlope(0, -1) : 0.25, s1 = n ? endSlope(n - 1, 1) : 0.25;
  const axis = (d) => {
    if (!n) return base_el;
    if (d <= pts[0].d_m) return pts[0].ground_m + (pts[0].d_m - d) * s0;
    if (d >= pts[n - 1].d_m) return pts[n - 1].ground_m + (d - pts[n - 1].d_m) * s1;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].d_m <= d) lo = m; else hi = m; }
    const a = pts[lo], b = pts[hi], t = (d - a.d_m) / Math.max(1e-9, b.d_m - a.d_m);
    return a.ground_m + (b.ground_m - a.ground_m) * t;
  };
  if (typeof ground === 'function') {
    return (x, z) => {
      const v = ground(x + origin_d, z);
      return (Number.isFinite(v) ? v : axis(x + origin_d)) - base_el;
    };
  }
  return (x) => axis(x + origin_d) - base_el;
}

// One side of a section: `tpl` is a polyline [{z, y, v}] from the crest edge outward and down, ending deep below
// the ground. Returns the same number of points + 2: the points above ground, the toe (where the line meets the
// ground; every later point collapses onto it) and a skirt 3 m under the ground so no gap shows at the toe.
export function solveSide(tpl, x, G) {
  const out = [];
  const f = (p) => p.y - G(x, p.z);
  let k = -1;
  if (f(tpl[0]) <= 0) k = -2; // the crest itself is under the hill: the whole side collapses
  else {
    for (let i = 0; i < tpl.length - 1; i++) if (f(tpl[i + 1]) <= 0) { k = i; break; }
    if (k < 0) k = tpl.length - 2;
  }
  let toe;
  if (k === -2) toe = { ...tpl[0] };
  else {
    const a = tpl[k], b = tpl[k + 1];
    let lo = 0, hi = 1;
    for (let it = 0; it < 14; it++) {
      const m = (lo + hi) / 2;
      const p = { z: a.z + (b.z - a.z) * m, y: a.y + (b.y - a.y) * m };
      if (f(p) > 0) lo = m; else hi = m;
    }
    const t = (lo + hi) / 2;
    toe = { z: a.z + (b.z - a.z) * t, y: a.y + (b.y - a.y) * t, v: a.v + (b.v - a.v) * t };
  }
  for (let i = 0; i < tpl.length; i++) out.push(i <= k ? tpl[i] : toe);
  out.push(toe);
  // skirt: continue the last real slope 3 m down (straight down on a flat berm)
  const a = k >= 0 ? tpl[k] : tpl[0], b = k >= 0 ? tpl[k + 1] : tpl[1];
  const dz = b.z - a.z, dy = b.y - a.y;
  const s = dy < -1e-6 ? 3 / -dy : 0;
  out.push({ z: toe.z + dz * s, y: toe.y - 3, v: toe.v + 3 });
  return out;
}

// Collects quads and triangles per material key, then makes one mesh per key.
export class MeshBag {
  constructor() { this.parts = new Map(); }
  part(key) {
    let p = this.parts.get(key);
    if (!p) { p = { pos: [], uv: [], idx: [] }; this.parts.set(key, p); }
    return p;
  }
  vert(key, x, y, z, u, v) {
    const p = this.part(key);
    p.pos.push(x, y, z); p.uv.push(u, v);
    return p.pos.length / 3 - 1;
  }
  // a, b, c, d counter-clockwise seen from the front: each [x, y, z, u, v]
  quad(key, a, b, c, d) {
    const p = this.part(key);
    const i = p.pos.length / 3;
    for (const q of [a, b, c, d]) { p.pos.push(q[0], q[1], q[2]); p.uv.push(q[3], q[4]); }
    p.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }
  tri(key, a, b, c) {
    const p = this.part(key);
    const i = p.pos.length / 3;
    for (const q of [a, b, c]) { p.pos.push(q[0], q[1], q[2]); p.uv.push(q[3], q[4]); }
    p.idx.push(i, i + 1, i + 2);
  }
  // strips between consecutive sections: secs[i] = { x, pts:[{z, y, v}] }, bands[k] = key of band k..k+1;
  // uvOf(key, x, pt, k) -> [u, v]. Faces point outward when pts run from upstream (+z) over the crest to downstream.
  strips(secs, bands, uvOf) {
    for (let i = 0; i < secs.length - 1; i++) {
      const A = secs[i], B = secs[i + 1];
      for (let k = 0; k < bands.length; k++) {
        const key = bands[k];
        if (!key) continue;
        const a0 = A.pts[k], a1 = A.pts[k + 1], b0 = B.pts[k], b1 = B.pts[k + 1];
        const same = (p, q) => Math.abs(p.z - q.z) < 1e-4 && Math.abs(p.y - q.y) < 1e-4;
        if (same(a0, a1) && same(b0, b1)) continue; // collapsed beyond the toe
        const P = (sec, p) => [sec.x, p.y, p.z, ...uvOf(key, sec.x, p, k)];
        this.quad(key, P(A, a0), P(B, b0), P(B, b1), P(A, a1));
      }
    }
  }
  build(THREE, materials, group) {
    let tris = 0;
    for (const [key, p] of this.parts) {
      if (!p.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(p.uv, 2));
      g.setIndex(p.idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, materials[key] || materials.default);
      m.name = 'dam-' + key;
      group.add(m);
      tris += p.idx.length / 3;
    }
    return tris;
  }
}

// a vertical wall following a path in plan: pts [{x, z, yBot, yTop, v}] (v = distance along); thickness t to the
// left of the direction of travel when `side` is 1 (right when -1). Faces: inner, top, outer, ends.
export function wallAlong(bag, key, pts, t, side = 1, tile = 15) {
  const n = pts.length;
  const off = [];
  for (let i = 0; i < n; i++) {
    const p = pts[Math.max(0, i - 1)], q = pts[Math.min(n - 1, i + 1)];
    const dx = q.x - p.x, dz = q.z - p.z, L = Math.hypot(dx, dz) || 1;
    off.push([(-dz / L) * t * side, (dx / L) * t * side]);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i], b = pts[i + 1], oa = off[i], ob = off[i + 1];
    const A = (p, o, y, u) => [p.x + o[0], y, p.z + o[1], u, y / tile];
    const z0 = [0, 0];
    const ua = a.v / tile, ub = b.v / tile;
    // face on the path line
    bag.quad(key, A(a, z0, a.yBot, ua), A(b, z0, b.yBot, ub), A(b, z0, b.yTop, ub), A(a, z0, a.yTop, ua));
    // the far face
    bag.quad(key, A(b, ob, b.yBot, ub), A(a, oa, a.yBot, ua), A(a, oa, a.yTop, ua), A(b, ob, b.yTop, ub));
    // top
    bag.quad(key, A(a, z0, a.yTop, ua), A(b, z0, b.yTop, ub), A(b, ob, b.yTop, ub), A(a, oa, a.yTop, ua));
  }
  // end caps
  for (const [i, o] of [[0, off[0]], [n - 1, off[n - 1]]]) {
    const p = pts[i];
    const P = (dx, dz, y) => [p.x + dx, y, p.z + dz, (dx + dz) / tile, y / tile];
    bag.quad(key, P(0, 0, p.yBot), P(o[0], o[1], p.yBot), P(o[0], o[1], p.yTop), P(0, 0, p.yTop));
  }
}
