// White water for the maker dam's spillways: a foam sheet that follows a floor polyline, a jet off a flip bucket
// and spray. All of it grows with the spill (set(q)) and moves in update(dt). Owner: lane b24.

const GRAV = 9.81;

// A sheet over a floor path [{z, y}] across x0..x1; depthOf(q, i) gives the water depth at point i.
// A path point may carry its own edges `l: [x, z]` and `r: [x, z]` (a curved chute); `inset` pulls them in.
export function flowSheet(THREE, { x0, x1, path, depthOf, tile = 10, inset = 0 }, material) {
  const n = path.length;
  const pos = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2);
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (i) s += Math.hypot(path[i].z - path[i - 1].z, path[i].y - path[i - 1].y);
    const p = path[i];
    for (let j = 0; j < 2; j++) {
      const k = i * 2 + j;
      let x = j ? x1 : x0, z = p.z;
      if (p.l && p.r) {
        const e = j ? p.r : p.l, o = j ? p.l : p.r, f = inset / (Math.hypot(o[0] - e[0], o[1] - e[1]) || 1);
        x = e[0] + (o[0] - e[0]) * f; z = e[1] + (o[1] - e[1]) * f;
      }
      pos[k * 3] = x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = z;
      uv[k * 2] = j; uv[k * 2 + 1] = s / tile;
    }
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, material);
  mesh.renderOrder = 3;
  mesh.visible = false;
  return {
    mesh,
    set(q) {
      mesh.visible = q > 0;
      if (!(q > 0)) return;
      for (let i = 0; i < n; i++) {
        const y = path[i].y + depthOf(q, i);
        pos[i * 6 + 1] = y; pos[i * 6 + 4] = y;
      }
      g.attributes.position.needsUpdate = true;
      g.computeBoundingSphere();
    },
  };
}

// The jet thrown by a flip bucket: a ribbon on a ballistic arc from the lip at angle `lipDeg`, falling until it
// meets the ground (G at the centre line). Speed from the fall between the reservoir and the lip.
export function jet(THREE, { x0, x1, zLip, yLip, yHead, lipDeg, G, xc }, material) {
  const N = 24;
  const pos = new Float32Array(N * 2 * 3), uv = new Float32Array(N * 2 * 2);
  const idx = [];
  for (let i = 0; i < N - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, material);
  mesh.renderOrder = 4;
  mesh.visible = false;
  let landing = { z: zLip, y: yLip };
  return {
    mesh,
    get landing() { return landing; },
    set(q, depth) {
      mesh.visible = q > 0;
      if (!(q > 0)) return;
      const v = Math.sqrt(2 * GRAV * Math.max(1, yHead - yLip)) * 0.8;
      const a = (lipDeg * Math.PI) / 180, vz = v * Math.cos(a), vy = v * Math.sin(a);
      // time to fall to the ground, found by stepping
      let tEnd = 0.2;
      for (let t = 0.2; t < 30; t += 0.1) {
        const z = zLip - vz * t, y = yLip + vy * t - 0.5 * GRAV * t * t;
        tEnd = t;
        if (y <= G(xc, z) + 0.5) break;
      }
      const spread = 0.1 + depth * 0.4; // the jet fans out and thickens as it falls
      for (let i = 0; i < N; i++) {
        const t = (i / (N - 1)) * tEnd;
        const z = zLip - vz * t, y = yLip + depth * 0.5 + vy * t - 0.5 * GRAV * t * t;
        const w = (i / (N - 1)) * spread * 6;
        for (let j = 0; j < 2; j++) {
          const k = i * 2 + j;
          pos[k * 3] = j ? x1 + w : x0 - w; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
          uv[k * 2] = (j ? x1 : x0) / 10; uv[k * 2 + 1] = (t * v) / 10;
        }
        if (i === N - 1) landing = { z, y };
      }
      g.attributes.position.needsUpdate = true;
      g.attributes.uv.needsUpdate = true;
      g.computeVertexNormals();
      g.computeBoundingSphere();
    },
  };
}

// Spray: a cloud of soft white points over a patch (x0..x1, z0..z1) at height y, rising and falling.
export function spray(THREE, { count = 160, seed = 7 } = {}) {
  let a = seed;
  const rand = () => ((a = (a * 16807) % 2147483647) / 2147483647);
  const pos = new Float32Array(count * 3), base = [], life = new Float32Array(count);
  for (let i = 0; i < count; i++) { base.push([rand(), rand(), rand() * 0.5 + 0.5]); life[i] = rand(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  // a round soft dot drawn in code
  const n = 32, d = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const r = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2);
    const k = (y * n + x) * 4;
    d[k] = d[k + 1] = d[k + 2] = 255; d[k + 3] = Math.max(0, 1 - r) ** 1.6 * 255;
  }
  const tex = new THREE.DataTexture(d, n, n, THREE.RGBAFormat);
  tex.needsUpdate = true;
  const mat = new THREE.PointsMaterial({ map: tex, size: 4, transparent: true, opacity: 0.8, depthWrite: false,
    sizeAttenuation: true, color: 0xffffff });
  const points = new THREE.Points(g, mat);
  points.renderOrder = 5;
  points.visible = false;
  let box = { x0: 0, x1: 1, z0: 0, z1: 1, y: 0, h: 4 };
  const place = () => {
    for (let i = 0; i < count; i++) {
      const b = base[i], t = life[i];
      pos[i * 3] = box.x0 + (box.x1 - box.x0) * b[0];
      pos[i * 3 + 2] = box.z0 + (box.z1 - box.z0) * b[1];
      pos[i * 3 + 1] = box.y + box.h * b[2] * Math.sin(Math.PI * t);
    }
    g.attributes.position.needsUpdate = true;
    g.computeBoundingSphere();
  };
  return {
    points, material: mat,
    set(q, patch) {
      points.visible = q > 0;
      if (patch) box = { ...box, ...patch };
      mat.size = box.size || 4;
      if (q > 0) place();
    },
    update(dt) {
      if (!points.visible) return;
      for (let i = 0; i < count; i++) {
        life[i] += dt * (0.5 + base[i][2] * 0.6);
        if (life[i] > 1) { life[i] -= 1; base[i][0] = rand(); base[i][1] = rand(); }
      }
      place();
    },
  };
}
