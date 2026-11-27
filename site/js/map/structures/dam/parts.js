// Small parts shared by both dam types: kerbs and parapets, guard rails, lamp posts, round-nosed piers and the
// bridge deck. Owner: lane b24. Same frame as dam.js (X along the crest, Y up from base_el, +Z upstream).

// a straight run along X from x0 to x1 (a kerb, a parapet, a rail): w across (z), h tall, bottom at y
export function runX(THREE, x0, x1, z, y, w, h, material) {
  const L = x1 - x0;
  if (!(L > 0.2)) return null;
  const m = new THREE.Mesh(new THREE.BoxGeometry(L, h, w), material);
  m.position.set((x0 + x1) / 2, y + h / 2, z);
  return m;
}

// posts every `step` along X with a top rail (a guard rail or a bridge railing)
export function railing(THREE, group, x0, x1, z, y, { step = 2.5, h = 1.0, material }) {
  const n = Math.max(2, Math.floor((x1 - x0) / step) + 1);
  const post = new THREE.BoxGeometry(0.14, h, 0.14);
  const inst = new THREE.InstancedMesh(post, material, n);
  const M = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    M.makeTranslation(x0 + ((x1 - x0) * i) / (n - 1), y + h / 2, z);
    inst.setMatrixAt(i, M);
  }
  inst.instanceMatrix.needsUpdate = true;
  group.add(inst);
  const top = runX(THREE, x0, x1, z, y + h - 0.1, 0.12, 0.1, material);
  const mid = runX(THREE, x0, x1, z, y + h * 0.5, 0.06, 0.08, material);
  if (top) group.add(top);
  if (mid) group.add(mid);
  return 2 * n * 12 / 2 + 24;
}

// lamp posts along X every `step`, standing at z on height y, arm reaching toward the road (sign of `toward`)
export function lamps(THREE, group, x0, x1, z, y, { step = 40, toward = -1, material, lampMaterial }) {
  const n = Math.floor((x1 - x0) / step);
  if (n < 1) return 0;
  const pole = new THREE.CylinderGeometry(0.08, 0.12, 8, 6);
  pole.translate(0, 4, 0);
  const arm = new THREE.BoxGeometry(0.08, 0.08, 1.6);
  arm.translate(0, 7.9, toward * 0.8);
  const head = new THREE.BoxGeometry(0.3, 0.14, 0.6);
  head.translate(0, 7.85, toward * 1.55);
  const ip = new THREE.InstancedMesh(pole, material, n), ia = new THREE.InstancedMesh(arm, material, n);
  const ih = new THREE.InstancedMesh(head, lampMaterial || material, n);
  const M = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    M.makeTranslation(x0 + step * (i + 0.5) + ((x1 - x0) - step * n) / 2, y, z);
    ip.setMatrixAt(i, M); ia.setMatrixAt(i, M); ih.setMatrixAt(i, M);
  }
  for (const m of [ip, ia, ih]) { m.instanceMatrix.needsUpdate = true; group.add(m); }
  return n * (24 + 12 + 12);
}

// a pier with round noses at both ends (upstream nose at +Z), `w` wide in X, from zDown to zUp, bottom y0 to top y1
export function pier(THREE, x, w, zDown, zUp, y0, y1, material, { sharpUp = false } = {}) {
  const r = w / 2;
  const s = new THREE.Shape();
  // shape plane: (sx, sy) = (x, -z) because the extrusion is turned to stand up (rotateX -90 deg maps sy to -z)
  const a = -zUp + r, b = -zDown - r;
  s.moveTo(-r, a);
  s.lineTo(-r, b);
  s.absarc(0, b, r, Math.PI, 0, true);
  s.lineTo(r, a);
  if (sharpUp) { s.lineTo(0, a - r * 1.8); s.lineTo(-r, a); } else s.absarc(0, a, r, 0, Math.PI, true);
  const g = new THREE.ExtrudeGeometry(s, { depth: y1 - y0, bevelEnabled: false, curveSegments: 5 });
  g.rotateX(-Math.PI / 2);
  g.translate(x, y0, 0);
  // uv in metres for the concrete tile
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + p.getZ(i)) / 15, p.getY(i) / 15);
  return new THREE.Mesh(g, material);
}

// the road deck of a bridge: a slab x0..x1, z0..z1, top at y, with asphalt on top (uv across the road)
export function deck(THREE, group, x0, x1, z0, z1, y, { thick = 0.9, concrete, asphalt }) {
  const slab = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, thick, z1 - z0), concrete);
  slab.position.set((x0 + x1) / 2, y - thick / 2 - 0.02, (z0 + z1) / 2);
  group.add(slab);
  const top = new THREE.PlaneGeometry(x1 - x0, z1 - z0 - 1.2);
  top.rotateX(-Math.PI / 2);
  const uv = top.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * (x1 - x0)) / 12, uv.getY(i));
  const road = new THREE.Mesh(top, asphalt);
  road.position.set((x0 + x1) / 2, y + 0.01, (z0 + z1) / 2);
  group.add(road);
  return 14;
}
