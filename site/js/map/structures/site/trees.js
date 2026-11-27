// Weir surroundings (lane b09): instanced trees. Two kinds, simple but tree-shaped: a broadleaf tree (trunk and a
// lumpy crown of two blobs) for the river banks, and a palm (slim trunk, drooping fronds) for the operator's park.
// INDICATIVE: every tree position is drawn (along the banks and in the park as seen on the pictures), not mapped.
import { TriBuilder, rng } from './geom.js';

function broadleaf(THREE) {
  const B = new TriBuilder();
  const trunk = 0x6b5640, n = 6, r0 = 0.45, r1 = 0.25, h = 4.6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
    B.quad([Math.cos(a) * r0, -2, Math.sin(a) * r0], [Math.cos(b) * r0, -2, Math.sin(b) * r0],
      [Math.cos(b) * r1, h, Math.sin(b) * r1], [Math.cos(a) * r1, h, Math.sin(a) * r1], trunk);
  }
  const blob = (cx, cy, cz, rx, ry, col) => {
    const g = new THREE.IcosahedronGeometry(1, 0).toNonIndexed();
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i += 3) {
      const v = (k) => [cx + p.getX(i + k) * rx, cy + p.getY(i + k) * ry, cz + p.getZ(i + k) * rx];
      B.tri(v(0), v(1), v(2), col);
    }
    g.dispose();
  };
  blob(0, 7.2, 0, 3.8, 3.0, 0x4f7a3a);
  blob(1.4, 8.6, -0.9, 2.6, 2.2, 0x5d8a43);
  return B.geometry(THREE);
}

function palm(THREE) {
  const B = new TriBuilder();
  const trunk = 0x8a7a63, n = 5, h = 9;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2, r0 = 0.32, r1 = 0.22;
    B.quad([Math.cos(a) * r0, -2, Math.sin(a) * r0], [Math.cos(b) * r0, -2, Math.sin(b) * r0],
      [Math.cos(b) * r1, h, Math.sin(b) * r1], [Math.cos(a) * r1, h, Math.sin(a) * r1], trunk);
  }
  const fronds = 9, L = 4.6;
  for (let k = 0; k < fronds; k++) {
    const a = (k / fronds) * Math.PI * 2 + (k % 2) * 0.2, ca = Math.cos(a), sa = Math.sin(a);
    const w = 0.9, lift = k % 2 ? 0.9 : 0.4;
    const P = (d, s, y) => [ca * d - sa * s, h + y, sa * d + ca * s];
    const col = k % 3 ? 0x4e7d34 : 0x5f8f3e;
    // two segments: up and out, then drooping to the tip
    B.quad(P(0, 0, 0.2), P(L * 0.5, -w, lift), P(L * 0.5, 0, lift + 0.25), P(0, 0, 0.2), col);
    B.tri(P(0, 0, 0.2), P(L * 0.5, 0, lift + 0.25), P(L * 0.5, w, lift), col);
    B.tri(P(L * 0.5, -w, lift), P(L, 0, lift - 1.8), P(L * 0.5, 0, lift + 0.25), col);
    B.tri(P(L * 0.5, 0, lift + 0.25), P(L, 0, lift - 1.8), P(L * 0.5, w, lift), col);
  }
  return B.geometry(THREE);
}

// list: [{x, y, z, kind 'broad'|'palm', s (scale)}]
export function buildTrees(THREE, list) {
  const group = new THREE.Group();
  group.name = 'b09-trees';
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  let triangles = 0;
  for (const [kind, make] of [['broad', broadleaf], ['palm', palm]]) {
    const items = list.filter((t) => t.kind === kind);
    if (!items.length) continue;
    const geo = make(THREE);
    const mesh = new THREE.InstancedMesh(geo, mat, items.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const col = new THREE.Color();
    const r = rng(items.length * 7 + (kind === 'palm' ? 3 : 1));
    items.forEach((t, i) => {
      e.set((r() - 0.5) * 0.08, r() * Math.PI * 2, (r() - 0.5) * 0.08);
      q.setFromEuler(e);
      const sc = t.s || 1;
      s.set(sc, sc * (0.9 + r() * 0.2), sc);
      p.set(t.x, t.y, t.z);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      const k = 0.85 + r() * 0.25;
      mesh.setColorAt(i, col.setRGB(k, k * (0.95 + r() * 0.1), k * 0.95));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.name = 'b09-trees-' + kind;
    group.add(mesh);
    triangles += (geo.getAttribute('position').count / 3) * items.length;
  }
  return { group, triangles };
}
