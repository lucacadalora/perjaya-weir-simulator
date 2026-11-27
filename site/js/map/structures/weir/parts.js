// Bendung Perjaya 3D model: shared helpers (lane b08).
// Pure: takes THREE as an argument, never touches the map or the DOM except a canvas for procedural textures
// (skipped quietly when no document exists).

// Colours read from the reference pictures (light grey weathered concrete, grey hoist-house roofs, blue steel
// railings and girders, an orange-red line along the gate tops, brown Komering water).
export const COLOURS = {
  concrete: 0xc9c6bd,
  concreteDark: 0xa9a69d,
  roof: 0x8e9296,
  glass: 0x2d3a44,
  steelSkin: 0x8d9ea9,
  steelBlue: 0x3d6fa6,
  gateTop: 0xd2502a,
  rail: 0x4a7db5,
  asphalt: 0x6c6c68,
  rope: 0x333333,
  water: 0x7b6a48,
  foam: 0xf4f1ea,
};

let texCache = null;

function canvas(w, h) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// tiny deterministic noise so pictures are stable between runs
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function concreteCanvas() {
  const c = canvas(256, 256);
  if (!c) return null;
  const g = c.getContext('2d');
  const r = rng(7);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1400; i++) { // fine speckle, low contrast
    const v = 232 + Math.floor(r() * 23);
    g.fillStyle = `rgb(${v},${v},${v - 3})`;
    g.fillRect(r() * 256, r() * 256, 1 + r() * 2, 1 + r() * 2);
  }
  for (let i = 0; i < 9; i++) { // broad weathering patches
    const x = r() * 256, y = r() * 256, rad = 30 + r() * 60;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, 'rgba(150,146,132,0.16)'); gr.addColorStop(1, 'rgba(150,146,132,0)');
    g.fillStyle = gr; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  for (let i = 0; i < 26; i++) { // rain streaks running down
    const x = r() * 256, len = 40 + r() * 160, y = r() * 80;
    const grad = g.createLinearGradient(0, y, 0, y + len);
    grad.addColorStop(0, 'rgba(90,88,80,0.22)'); grad.addColorStop(1, 'rgba(90,88,80,0)');
    g.fillStyle = grad; g.fillRect(x, y, 1.5 + r() * 4, len);
  }
  g.strokeStyle = 'rgba(120,118,110,0.25)'; g.lineWidth = 1; // form-work lift lines
  for (let y = 0; y < 256; y += 64) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(256, y + 0.5); g.stroke(); }
  return c;
}

function foamCanvas() {
  const c = canvas(128, 256);
  if (!c) return null;
  const g = c.getContext('2d');
  const r = rng(11);
  g.fillStyle = '#000'; g.fillRect(0, 0, 128, 256);
  for (let i = 0; i < 520; i++) { // streaks stretched along the flow (v), wrapping top to bottom
    const x = r() * 128, y = r() * 256, rw = 0.8 + r() * 3.5, rl = 6 + r() * 26, a = 0.2 + r() * 0.65;
    g.fillStyle = `rgba(255,255,255,${a})`;
    for (const dy of [-256, 0, 256]) { g.beginPath(); g.ellipse(x, y + dy, rw, rl, 0, 0, Math.PI * 2); g.fill(); }
  }
  return c;
}

export function textures(THREE) {
  if (texCache && texCache.THREE === THREE) return texCache;
  const mk = (cv, repeat) => {
    if (!cv) return null;
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (repeat) t.repeat.set(repeat[0], repeat[1]);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  texCache = { THREE, concrete: mk(concreteCanvas()), foam: mk(foamCanvas(), [3, 1.5]) };
  if (texCache.foam) texCache.foam.colorSpace = THREE.NoColorSpace;
  return texCache;
}

export function materials(THREE) {
  const tx = textures(THREE);
  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...o });
  return {
    concrete: std(COLOURS.concrete, { map: tx.concrete || null }),
    concreteDark: std(COLOURS.concreteDark, { map: tx.concrete || null }),
    roof: std(COLOURS.roof, { roughness: 0.9 }),
    glass: std(COLOURS.glass, { roughness: 0.3, metalness: 0.2 }),
    steelSkin: std(COLOURS.steelSkin, { roughness: 0.55, metalness: 0.35 }),
    steelBlue: std(COLOURS.steelBlue, { roughness: 0.5, metalness: 0.3 }),
    gateTop: std(COLOURS.gateTop, { roughness: 0.5, metalness: 0.2, side: THREE.DoubleSide }),
    rail: std(COLOURS.rail, { roughness: 0.5, metalness: 0.3 }),
    asphalt: std(COLOURS.asphalt, { roughness: 0.95 }),
    rope: std(COLOURS.rope, { roughness: 0.6, metalness: 0.5 }),
  };
}

// World-space box projection of UVs (1 texture tile = `size` metres), so one concrete texture reads at the same
// scale on every face of every merged part.
export function worldUV(geom, size = 6) {
  const p = geom.attributes.position, n = geom.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ay >= ax && ay >= az) { u = p.getX(i); v = p.getZ(i); }
    else if (ax >= az) { u = p.getZ(i); v = p.getY(i); }
    else { u = p.getX(i); v = p.getY(i); }
    uv[i * 2] = u / size; uv[i * 2 + 1] = v / size;
  }
  geom.setAttribute('uv', new geom.attributes.position.constructor(uv, 2));
  return geom;
}

// Merge geometries (each already placed with its matrix) into one non-indexed geometry with position, normal, uv.
export function merge(THREE, parts) {
  const list = parts.filter(Boolean).map((g) => {
    let x = g.index ? g.toNonIndexed() : g;
    if (!x.attributes.normal) x.computeVertexNormals();
    if (!x.attributes.uv) x.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(x.attributes.position.count * 2), 2));
    return x;
  });
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    uv.set(g.attributes.uv.array, o * 2);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

// A box placed by its min/max corners (for beams, slabs and walls that are parts of a modelled structure).
export function slab(THREE, x0, y0, z0, x1, y1, z1) {
  const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

// A plan shape (points [x, z] in the model's XZ plane) extruded upward from y0 to y1.
export function prismXZ(THREE, pts, y0, y1) {
  const s = new THREE.Shape();
  pts.forEach(([x, z], i) => (i ? s.lineTo(x, -z) : s.moveTo(x, -z)));
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: y1 - y0, bevelEnabled: false, curveSegments: 6 });
  g.rotateX(-Math.PI / 2); // shape y -> -z, extrude +z -> +y
  g.translate(0, y0, 0);
  return g;
}

// A section shape (points [z, y]) extruded along X from x0 to x1.
export function prismZY(THREE, pts, x0, x1) {
  const s = new THREE.Shape();
  pts.forEach(([z, y], i) => (i ? s.lineTo(-z, y) : s.moveTo(-z, y)));
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: x1 - x0, bevelEnabled: false, curveSegments: 4 });
  g.rotateY(Math.PI / 2); // (-z, y, d) -> (d, y, z): a proper rotation, winding kept
  g.translate(x0, 0, 0);
  return g;
}

// Pier plan: a body of `width` x `len` (z from zTail to zNose-taper) with a pointed-round nose upstream (+Z) and a
// tapered tail downstream; gate slots (`slotZ`, depth 0.35 m, width 0.5 m) cut into both side faces.
export function pierPlan(cx, width, zTail, zNose, nose = 'round', slotZ = null) {
  const h = width / 2, noseLen = width * 0.9, tailLen = width * 0.6;
  const zb0 = zTail + tailLen, zb1 = zNose - noseLen;
  const pts = [];
  // right side (east, +x) from tail to nose
  pts.push([cx + h * 0.35, zTail]);
  pts.push([cx + h, zb0]);
  if (slotZ != null && slotZ > zb0 + 0.4 && slotZ < zb1 - 0.4) {
    pts.push([cx + h, slotZ - 0.25], [cx + h - 0.35, slotZ - 0.25], [cx + h - 0.35, slotZ + 0.25], [cx + h, slotZ + 0.25]);
  }
  pts.push([cx + h, zb1]);
  const seg = 7; // nose: two arcs meeting at a point (a pointed, rounded cutwater)
  for (let i = 1; i < seg; i++) {
    const a = (i / seg) * (Math.PI / 2);
    pts.push([cx + h * Math.cos(a) * (nose === 'round' ? 1 : 1 - i / seg), zb1 + noseLen * Math.sin(a)]);
  }
  pts.push([cx, zNose]);
  for (let i = seg - 1; i >= 1; i--) {
    const a = (i / seg) * (Math.PI / 2);
    pts.push([cx - h * Math.cos(a) * (nose === 'round' ? 1 : 1 - i / seg), zb1 + noseLen * Math.sin(a)]);
  }
  pts.push([cx - h, zb1]);
  if (slotZ != null && slotZ > zb0 + 0.4 && slotZ < zb1 - 0.4) {
    pts.push([cx - h, slotZ + 0.25], [cx - h + 0.35, slotZ + 0.25], [cx - h + 0.35, slotZ - 0.25], [cx - h, slotZ - 0.25]);
  }
  pts.push([cx - h, zb0]);
  pts.push([cx - h * 0.35, zTail]);
  return pts;
}

export function countTriangles(obj) {
  let n = 0;
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    const t = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    n += o.isInstancedMesh ? t * o.count : t;
  });
  return Math.round(n);
}
