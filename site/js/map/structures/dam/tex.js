// Textures for the maker dam, drawn in code (no image files, works in node too). Owner: lane b24.
// Every texture is a small tileable DataTexture; the meshes map it in world metres (see the uv notes in each file).
// Look constants only: colours and pattern sizes, no researched number.

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// tileable value noise, 0..1
function noiseField(n, cells, rand) {
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rand();
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const fx = (x / n) * cells, fy = (y / n) * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const v = (i, j) => g[((j % cells) * cells) + (i % cells)];
      const a = v(x0, y0) + (v(x0 + 1, y0) - v(x0, y0)) * sx;
      const b = v(x0, y0 + 1) + (v(x0 + 1, y0 + 1) - v(x0, y0 + 1)) * sx;
      out[y * n + x] = a + (b - a) * sy;
    }
  }
  return out;
}

function fbm(n, rand, octaves = [[4, 0.5], [8, 0.3], [32, 0.2]]) {
  const out = new Float32Array(n * n);
  for (const [c, w] of octaves) {
    const f = noiseField(n, c, rand);
    for (let i = 0; i < out.length; i++) out[i] += f[i] * w;
  }
  return out;
}

function make(THREE, n, data, { alpha = false } = {}) {
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  if (!alpha) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
function put(d, i, r, g, b, a = 255) {
  d[i * 4] = clamp255(r); d[i * 4 + 1] = clamp255(g); d[i * 4 + 2] = clamp255(b); d[i * 4 + 3] = clamp255(a);
}

// Riprap: angular stones (tileable Voronoi cells), grey-brown with dark gaps. One tile = about 5 m.
function riprap(THREE, seed = 11, tone = [128, 124, 116]) {
  const n = 128, rand = rng(seed), d = new Uint8Array(n * n * 4);
  const seeds = [];
  for (let i = 0; i < 70; i++) seeds.push([rand() * n, rand() * n, 0.72 + rand() * 0.5, rand()]);
  const nz = fbm(n, rand, [[16, 0.6], [64, 0.4]]);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let d1 = 1e9, d2 = 1e9, best = null;
      for (const s of seeds) {
        let dx = Math.abs(x - s[0]), dy = Math.abs(y - s[1]);
        if (dx > n / 2) dx = n - dx;
        if (dy > n / 2) dy = n - dy;
        const dd = Math.max(dx * 0.9 + dy * 0.35, dy * 0.95 + dx * 0.3); // angular, not round
        if (dd < d1) { d2 = d1; d1 = dd; best = s; } else if (d2 > dd) d2 = dd;
      }
      const edge = d2 - d1;
      const shade = best[2] * (edge < 1.3 ? 0.35 + edge * 0.25 : 1) * (0.86 + nz[y * n + x] * 0.28);
      const warm = best[3] * 14 - 7;
      put(d, y * n + x, tone[0] * shade + warm, tone[1] * shade + warm * 0.6, tone[2] * shade);
    }
  }
  return make(THREE, n, d);
}

// Grass on the downstream face: mown stripes running down the slope, small tufts. One tile = about 12 m.
function grass(THREE, seed = 21) {
  const n = 128, rand = rng(seed), d = new Uint8Array(n * n * 4);
  const nz = fbm(n, rand);
  const fine = noiseField(n, 64, rand);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const stripe = Math.floor(x / 16) % 2 ? 1.05 : 0.95;
      const v = (0.82 + nz[i] * 0.3) * stripe * (0.9 + fine[i] * 0.2);
      put(d, i, 104 * v, 138 * v, 70 * v);
    }
  }
  return make(THREE, n, d);
}

// Gravel berm with a concrete gutter along its inner edge (v near 0.15). One tile = 8 m by the berm width.
function gravel(THREE, seed = 31) {
  const n = 128, rand = rng(seed), d = new Uint8Array(n * n * 4);
  const nz = fbm(n, rand, [[32, 0.5], [64, 0.5]]);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x, v = y / n;
      if (v > 0.1 && v < 0.24) {
        const s = v < 0.13 || v > 0.21 ? 0.78 : 0.62;
        put(d, i, 196 * s, 194 * s, 186 * s);
      } else {
        const s = 0.8 + nz[i] * 0.35;
        put(d, i, 178 * s, 168 * s, 150 * s);
      }
    }
  }
  return make(THREE, n, d);
}

// Concrete: lift lines every tenth of the tile (1.5 m with a 15 m tile) and a dark monolith joint at the tile edge.
function concrete(THREE, seed = 41, { joints = true, tone = [198, 195, 186] } = {}) {
  const n = 256, rand = rng(seed), d = new Uint8Array(n * n * 4);
  const nz = fbm(n, rand, [[4, 0.4], [16, 0.35], [64, 0.25]]);
  const streak = noiseField(n, 48, rand);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      let s = 0.86 + nz[i] * 0.2;
      const lift = y % (n / 10);
      if (lift === 0) s *= 0.86;
      else if (lift === 1) s *= 0.94;
      // rain streaks hang down from each lift line
      s *= 1 - Math.max(0, streak[(y >> 3) * 0 + x] - 0.62) * 0.35 * (1 - lift / (n / 10));
      if (joints && (x < 2 || x > n - 2)) s *= 0.42;
      put(d, i, tone[0] * s, tone[1] * s, tone[2] * s);
    }
  }
  return make(THREE, n, d);
}

// Asphalt road across the crest: v runs across the road (0..1), u along it (one tile = 12 m): edge lines and a
// dashed centre line.
function asphalt(THREE, seed = 51) {
  const n = 128, rand = rng(seed), d = new Uint8Array(n * n * 4);
  const nz = fbm(n, rand, [[32, 0.5], [128, 0.5]]);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x, v = y / n, u = x / n;
      let r = 74, g = 76, b = 78;
      const s = 0.86 + nz[i] * 0.28;
      const edge = (v > 0.06 && v < 0.085) || (v > 0.915 && v < 0.94);
      const centre = v > 0.49 && v < 0.51 && u < 0.5;
      if (edge || centre) { r = 222; g = 220; b = 210; }
      put(d, i, r * s, g * s, b * s);
    }
  }
  return make(THREE, n, d);
}

// White water: streaks along v (the flow), brighter at random columns, with alpha. Scrolled in update(dt).
function foam(THREE, seed = 61) {
  const n = 128, rand = rng(seed), d = new Uint8Array(n * n * 4);
  const cols = new Float32Array(n);
  for (let x = 0; x < n; x++) cols[x] = rand();
  const nz = fbm(n, rand, [[8, 0.4], [32, 0.6]]);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const c = (cols[x] + cols[(x + 1) % n] + cols[(x + n - 1) % n]) / 3;
      const k = Math.min(1, 0.45 + c * 0.35 + nz[(Math.floor(y / 4) * 4 % n) * n + x] * 0.45);
      const white = 200 + k * 55;
      put(d, i, white - 18 * (1 - k), white - 8 * (1 - k), white, 120 + k * 135);
    }
  }
  return make(THREE, n, d, { alpha: true });
}

// Pond water near the structure: deep green-blue with soft ripples.
function pond(THREE, seed = 71) {
  const n = 128, rand = rng(seed), d = new Uint8Array(n * n * 4);
  const nz = fbm(n, rand, [[8, 0.5], [32, 0.5]]);
  for (let i = 0; i < n * n; i++) {
    const s = 0.9 + nz[i] * 0.2;
    put(d, i, 62 * s, 104 * s, 112 * s, 235);
  }
  return make(THREE, n, d, { alpha: true });
}

export function makeTextures(THREE) {
  return {
    riprap: riprap(THREE, 11),
    riprapWet: riprap(THREE, 12, [96, 100, 90]),
    grass: grass(THREE),
    gravel: gravel(THREE),
    concrete: concrete(THREE),
    concretePlain: concrete(THREE, 43, { joints: false, tone: [204, 200, 190] }),
    asphalt: asphalt(THREE),
    foam: foam(THREE),
    pond: pond(THREE),
  };
}
