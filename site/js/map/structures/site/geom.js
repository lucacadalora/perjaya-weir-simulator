// Weir surroundings (lane b09): small pure geometry helpers. No map, no DOM.
// Frame: metres, +X east, +Y up (model metres), +Z south. Plan points are [x, z].

// Accumulates flat-shaded triangles with a colour per triangle, then makes one BufferGeometry (one draw call).
export class TriBuilder {
  constructor() { this.p = []; this.c = []; }
  tri(a, b, c, col) {
    // a, b, c: [x, y, z]; wound counter-clockwise seen from the side that should be lit
    this.p.push(...a, ...b, ...c);
    const r = ((col >> 16) & 255) / 255, g = ((col >> 8) & 255) / 255, bl = (col & 255) / 255;
    for (let i = 0; i < 3; i++) this.c.push(r, g, bl);
  }
  quad(a, b, c, d, col) { this.tri(a, b, c, col); this.tri(a, c, d, col); }
  // thin things seen from either side: the materials are double-sided, so one winding is enough
  quad2(a, b, c, d, col) { this.quad(a, b, c, d, col); }
  get triangles() { return this.p.length / 9; }
  geometry(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeVertexNormals();
    return g;
  }
}

export const signedArea = (ring) => {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % n];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
};

export const centroid = (ring) => {
  let x = 0, z = 0;
  for (const p of ring) { x += p[0]; z += p[1]; }
  return [x / ring.length, z / ring.length];
};

// open ring (no repeated last point)
export const openRing = (ring) => {
  const r = ring.slice();
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  return r;
};

// Chaikin corner cutting on a closed ring
export function chaikin(ring, iterations = 2) {
  let r = ring;
  for (let k = 0; k < iterations; k++) {
    const out = [];
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    r = out;
  }
  return r;
}

// Chaikin on an open polyline (keeps both ends)
export function chaikinLine(line, iterations = 2) {
  let r = line;
  for (let k = 0; k < iterations; k++) {
    if (r.length < 3) return r;
    const out = [r[0]];
    for (let i = 0; i < r.length - 1; i++) {
      const a = r[i], b = r[i + 1];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out.push(r[r.length - 1]);
    r = out;
  }
  return r;
}

// points every `step` metres along a polyline (keeps the vertices)
export function densify(line, step) {
  const out = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const [x0, z0] = line[i - 1], [x1, z1] = line[i];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / step));
    for (let k = 1; k <= n; k++) out.push([x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n]);
  }
  return out;
}

export const lineLength = (line) => {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return s;
};

// unit left-hand normals (seen from above with +X east and +Z south, "left" of the direction of travel) per vertex,
// mitred and clamped
export function normals(line) {
  const n = line.length, out = [];
  const seg = (i) => {
    const dx = line[i + 1][0] - line[i][0], dz = line[i + 1][1] - line[i][1], l = Math.hypot(dx, dz) || 1;
    return [dz / l, -dx / l];
  };
  for (let i = 0; i < n; i++) {
    const a = seg(Math.max(0, i - 1)), b = seg(Math.min(n - 2, i));
    let nx = a[0] + b[0], nz = a[1] + b[1];
    const l = Math.hypot(nx, nz) || 1;
    nx /= l; nz /= l;
    const cos = Math.max(0.5, nx * b[0] + nz * b[1]);
    out.push([nx / cos, nz / cos]);
  }
  return out;
}

export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// distance from a point to a polyline
export function distToLine(x, z, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, az] = line[i - 1], [bx, bz] = line[i];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

// tiny deterministic random numbers so pictures are the same on every run
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

export function hash2(x, z) {
  let h = (Math.round(x * 10) * 73856093) ^ (Math.round(z * 10) * 19349663);
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// minimum-area oriented rectangle of a small ring: {cx, cz, ux, uz (unit long axis), len, wid}
export function orientedRect(ring) {
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    if (l < 0.5) continue;
    const ux = dx / l, uz = dz / l;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of ring) {
      const u = p[0] * ux + p[1] * uz, v = -p[0] * uz + p[1] * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uz, u0, u1, v0, v1 };
  }
  if (!best) return null;
  let { ux, uz, u0, u1, v0, v1 } = best;
  if (v1 - v0 > u1 - u0) { // make u the long axis
    [ux, uz] = [-uz, ux];
    [u0, u1, v0, v1] = [v0, v1, -u1, -u0];
  }
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  return { cx: cu * ux - cv * uz, cz: cu * uz + cv * ux, ux, uz, len: u1 - u0, wid: v1 - v0 };
}
