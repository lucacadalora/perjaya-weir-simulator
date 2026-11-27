// The look of a water surface, shared by every piece of water that should read as one river: the river sheets
// (water/shader.js) and the water inside the weir (structures/weir/flow.js). Owner: lane b06.
//
// One kit per three.js build: a tileable ripple texture made here (no file, no other host), the uniforms every
// water material shares (time, eye, colours, sky, sun, pointer ripples) and the GLSL that turns
// (position, current, depth, foam) into a colour. Because the ripples are computed from scene metres and the
// same clock everywhere, two meshes that meet (a river sheet and a weir bay) show one unbroken surface.
//
// The colour is the river's real one (palette.js RIVER, proposed CONTRACT A10): a sediment-laden river, olive-brown
// at an ordinary flow, greener and clearer at low flow, chocolate brown in a flood. The flow sets it (setFlow); it
// glides to a new look over a few seconds of the frame clock. Display only: nothing here feeds a number.
//
//   const kit = waterKit(THREE);
//   kit.uniforms            spread into a ShaderMaterial's uniforms (shared objects: one update reaches all)
//   kit.glsl                fragment chunk: waterSlope(), pointerSlope(), silt(), lapFoam(), waterEye(), shadeWater()
//   kit.setTime(t)          seconds from the frame clock
//   kit.setFlow(q)          the river's flow in m3/s: sets how muddy the water looks (turbidityFor)
//   kit.follow(store)       reads the flow from the store on every setTime (flow.q_in, else weir.q_down)
//   kit.setTurbidity(t)     0 clear .. 1 flood, at once (films, test pages)
//   kit.watch(mesh)         keeps the eye position current while that mesh is drawn
//   kit.ripple(x, z, k)     a ring spreading from scene point (x, z); k = strength (1 = a tap)

import { RIVER } from './palette.js';

const SKY_HORIZON = '#eef4f6'; // the pale sky of the map near the horizon
const SKY_ZENITH = '#a9cbe4'; // and overhead
const SUN = [0.45, 1.0, -0.3]; // towards the sun in scene axes (x east, y up, z south): the scene's own light
const RIPPLES = 12; // pointer rings alive at once
export const RIPPLE_LIFE_S = 6;

// How muddy the river looks at a flow (display choice, not a sediment model): on a log scale from 60 m3/s (a
// dry-season flow, about twice the maintenance flow: the clear look) to 1,500 m3/s (most of a design flood: the
// flood look). An ordinary flow of about 250 m3/s comes out near NORMAL_AT, the normal look.
export const TURBIDITY = Object.freeze({ q_clear: 60, q_flood: 1500, normal_at: 0.45, glide_s: 2.5 });

// 0 (clear) .. 1 (flood) for a flow in m3/s; null when the flow is not known (the caller keeps what it had)
export function turbidityFor(q) {
  if (q == null || !Number.isFinite(Number(q))) return null;
  if (q <= TURBIDITY.q_clear) return 0;
  const t = Math.log(q / TURBIDITY.q_clear) / Math.log(TURBIDITY.q_flood / TURBIDITY.q_clear);
  return Math.max(0, Math.min(1, t));
}

const rgb01 = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

// The river's colours at turbidity t, mixed from the palette's three looks (clear, normal at TURBIDITY.normal_at,
// flood). Colours as [r, g, b] 0..1 (screen values: the water shaders write them as they are); see_m is mixed on a
// log scale, so the bed fades from view smoothly as the mud comes. Pure (no three.js).
export function riverLook(t, river = RIVER) {
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : TURBIDITY.normal_at));
  const n = TURBIDITY.normal_at;
  const [a, b, k] = x <= n ? [river.clear, river.normal, x / n] : [river.normal, river.flood, (x - n) / (1 - n)];
  const mix = (p, q) => {
    const A = rgb01(p);
    const B = rgb01(q);
    return A.map((v, i) => v + (B[i] - v) * k);
  };
  const fa = rgb01(river.foam);
  const fb = rgb01(river.floodFoam || river.foam);
  const fk = Math.max(0, (x - n) / (1 - n));
  return {
    t: x,
    shallow: mix(a.shallow, b.shallow),
    body: mix(a.body, b.body),
    deep: mix(a.deep, b.deep),
    see_m: Math.exp(Math.log(a.see_m) + (Math.log(b.see_m) - Math.log(a.see_m)) * k),
    foam: fa.map((v, i) => v + (fb[i] - v) * fk),
  };
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// RGBA8, tileable. R, G: slope of a wave field (d/du, d/dv) scaled so its rms is about 0.33; B: its height;
// A: a blotchy pattern for breaking foam up. Pure (no DOM), so it also runs under node.
export function rippleBytes(N = 256, seed = 7) {
  const r = rng(seed);
  const cosT = new Float32Array(N);
  const sinT = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    cosT[i] = Math.cos((2 * Math.PI * i) / N);
    sinT[i] = Math.sin((2 * Math.PI * i) / N);
  }
  // waves with whole-number wave vectors (so the tile repeats), lengths from half the tile down to 1/28 of it
  const waves = [];
  while (waves.length < 44) {
    const m = 2 * Math.pow(14, r());
    const th = r() * Math.PI * 2;
    const kx = Math.round(m * Math.cos(th));
    const ky = Math.round(m * Math.sin(th));
    if (!kx && !ky) continue;
    const ph = r() * Math.PI * 2;
    waves.push({ kx, ky, a: Math.pow(Math.hypot(kx, ky), -1.15), c: Math.cos(ph), s: Math.sin(ph) });
  }
  const h = new Float32Array(N * N);
  const sx = new Float32Array(N * N);
  const sy = new Float32Array(N * N);
  for (const w of waves) {
    for (let j = 0; j < N; j++) {
      const base = (((w.ky * j) % N) + N) % N;
      const step = ((w.kx % N) + N) % N;
      let idx = base;
      const row = j * N;
      for (let i = 0; i < N; i++) {
        const co = cosT[idx] * w.c - sinT[idx] * w.s; // cos(arg + phase)
        const si = sinT[idx] * w.c + cosT[idx] * w.s;
        h[row + i] += w.a * co;
        sx[row + i] -= w.a * w.kx * si;
        sy[row + i] -= w.a * w.ky * si;
        idx += step;
        if (idx >= N) idx -= N;
      }
    }
  }
  let hMax = 1e-9;
  let ss = 0;
  for (let i = 0; i < N * N; i++) {
    if (Math.abs(h[i]) > hMax) hMax = Math.abs(h[i]);
    ss += sx[i] * sx[i] + sy[i] * sy[i];
  }
  const k = 1 / (3 * Math.sqrt(ss / (2 * N * N))); // 3 rms fills the byte range

  // foam pattern: value noise on wrapped lattices of 6, 12, 24 and 48 cells
  const f = new Float32Array(N * N);
  let amp = 1;
  let total = 0;
  for (const cells of [6, 12, 24, 48]) {
    const lat = new Float32Array(cells * cells);
    for (let i = 0; i < lat.length; i++) lat[i] = r();
    for (let j = 0; j < N; j++) {
      const v = (j / N) * cells;
      const j0 = Math.floor(v);
      const fv = v - j0;
      const wv = fv * fv * (3 - 2 * fv);
      for (let i = 0; i < N; i++) {
        const u = (i / N) * cells;
        const i0 = Math.floor(u);
        const fu = u - i0;
        const wu = fu * fu * (3 - 2 * fu);
        const a = lat[(j0 % cells) * cells + (i0 % cells)];
        const b = lat[(j0 % cells) * cells + ((i0 + 1) % cells)];
        const c = lat[((j0 + 1) % cells) * cells + (i0 % cells)];
        const d = lat[((j0 + 1) % cells) * cells + ((i0 + 1) % cells)];
        f[j * N + i] += amp * (a + (b - a) * wu + (c - a) * wv + (a - b - c + d) * wu * wv);
      }
    }
    total += amp;
    amp *= 0.55;
  }
  let fMin = Infinity;
  let fMax = -Infinity;
  for (let i = 0; i < N * N; i++) {
    f[i] /= total;
    if (f[i] < fMin) fMin = f[i];
    if (f[i] > fMax) fMax = f[i];
  }
  const out = new Uint8Array(N * N * 4);
  const byte = (x) => Math.max(0, Math.min(255, Math.round(x * 127.5 + 127.5)));
  for (let i = 0; i < N * N; i++) {
    out[i * 4] = byte(sx[i] * k);
    out[i * 4 + 1] = byte(sy[i] * k);
    out[i * 4 + 2] = byte(h[i] / hMax);
    out[i * 4 + 3] = Math.round(((f[i] - fMin) / (fMax - fMin)) * 255);
  }
  return out;
}

// Fragment chunk. Positions are scene metres (x east, z south), `vel` is the current in m/s in those axes.
const GLSL = /* glsl */ `
uniform sampler2D uNoise;
uniform float uTime;
uniform vec3 uEyeW;         // camera position in scene metres (a direction when uEyeIsDir is 1)
uniform float uEyeIsDir;
uniform vec3 uDeep;         // the river's colours now (kit.setFlow mixes palette RIVER's three looks)
uniform vec3 uBody;
uniform vec3 uShallow;
uniform vec3 uBed;          // wet sand and mud under the shallowest water
uniform float uSee;         // metres the eye sees into the water before the bed is lost
uniform vec3 uBank;         // what the water reflects where a bank stands in the way
uniform float uTurb;        // 0 clear .. 1 flood
uniform vec3 uFoamCol;
uniform vec3 uSkyH;
uniform vec3 uSkyZ;
uniform vec3 uSun;
uniform vec4 uRip[${RIPPLES}];        // xy: scene x and z of a pointer ring, z: its start time, w: its strength

vec2 wsl(vec2 uv) { return texture2D(uNoise, uv).rg * 2.0 - 1.0; }

// Slope of the surface (d height / dx, d height / dz). Wind ripples are always there; the current carries a second
// field along with it (two copies that hand over to each other, so the pattern travels without ever smearing);
// rough 0..1 = how broken the water is. fpat returns a travelling 0..1 pattern for breaking foam up.
vec2 wturn(vec2 q) { return vec2(0.7986 * q.x + 0.6018 * q.y, -0.6018 * q.x + 0.7986 * q.y); }   // by 37 degrees
vec2 wback(vec2 q) { return vec2(0.7986 * q.x - 0.6018 * q.y, 0.6018 * q.x + 0.7986 * q.y); }

vec2 waterSlope(vec2 p, vec2 vel, float rough, out float fpat) {
  float t = uTime;
  // slow patches of livelier and calmer water, so the ripple tiles never read as a pattern
  float big = texture2D(uNoise, p / 171.0 + t * vec2(0.0021, 0.0009)).b * 0.5 + 0.5;
  vec2 s = wsl(p / 41.0 + t * vec2(0.010, 0.004)) * 0.55;
  s += wback(wsl(wturn(p) / 15.3 + t * vec2(-0.017, 0.026))) * 0.5;
  s += wsl(p / 6.1 + t * vec2(0.045, -0.031)) * 0.38;
  s *= 0.075 * (0.55 + 0.9 * big) * (1.0 - 0.5 * rough);
  float sp = length(vel);
  const float cyc = 3.2;
  float ph0 = fract(t / cyc);
  float ph1 = fract(t / cyc + 0.5);
  float w0 = 1.0 - abs(2.0 * ph0 - 1.0);
  vec2 u0 = p - vel * ((ph0 - 0.5) * cyc);
  vec2 u1 = p - vel * ((ph1 - 0.5) * cyc);
  vec4 a0 = texture2D(uNoise, u0 / 17.3);
  vec4 a1 = texture2D(uNoise, u1 / 17.3 + 0.5);
  vec4 c0 = texture2D(uNoise, wturn(u0) / 7.9 + 0.37);
  vec4 c1 = texture2D(uNoise, wturn(u1) / 7.9 + 0.81);
  vec2 f0 = (a0.rg * 2.0 - 1.0) + 0.6 * wback(c0.rg * 2.0 - 1.0);
  vec2 f1 = (a1.rg * 2.0 - 1.0) + 0.6 * wback(c1.rg * 2.0 - 1.0);
  float amp = ((0.035 + 0.24 * rough) * smoothstep(0.03, 1.2, sp) + 0.16 * rough) * (0.6 + 0.8 * big);
  s += mix(f1, f0, w0) * amp;
  fpat = mix(0.5 * (a1.a + c1.a), 0.5 * (a0.a + c0.a), w0);
  fpat = clamp((fpat - 0.5) * 1.35 + 0.5, 0.0, 1.0);   // two layers averaged lose contrast: give it back
  return s;
}

// Rings that spread from where the pointer touched the water.
vec2 pointerSlope(vec2 p) {
  vec2 s = vec2(0.0);
  for (int i = 0; i < ${RIPPLES}; i++) {
    vec4 r = uRip[i];
    float age = uTime - r.z;
    if (r.w <= 0.0 || age < 0.0 || age > ${RIPPLE_LIFE_S.toFixed(1)}) continue;
    vec2 dv = p - r.xy;
    float dist = length(dv) + 0.001;
    float x = dist - 2.4 * age;                       // the ring's front travels at 2.4 m/s
    float env = exp(-x * x / (3.0 + 5.0 * age)) * exp(-0.75 * age) * r.w / (1.0 + 0.05 * dist);
    float k = 6.2831853 / (1.5 + 0.55 * age);         // the waves lengthen as the ring opens
    s += (dv / dist) * cos(k * x) * env * 0.55;
  }
  return s;
}

// The way from a point of the surface to the eye (unit; a far camera gives one direction for every point).
vec3 waterEye(vec3 wpos) {
  vec3 V = uEyeIsDir > 0.5 ? normalize(uEyeW) : normalize(uEyeW - wpos);
  V.y = abs(V.y);
  return V;
}

// Patches of muddier (+) and clearer (-) water drifting with the current, -1..1: a sediment-laden river is never
// one flat colour. Two copies that hand over, like the ripples, so the patches travel without smearing; and broad
// swaths that hardly move. Display choice.
float silt(vec2 p, vec2 vel) {
  const float cyc = 14.0;
  float ph0 = fract(uTime / cyc);
  float ph1 = fract(uTime / cyc + 0.5);
  float w0 = 1.0 - abs(2.0 * ph0 - 1.0);
  float a0 = texture2D(uNoise, (p - vel * ((ph0 - 0.5) * cyc)) / 260.0 + 0.13).a;
  float a1 = texture2D(uNoise, (p - vel * ((ph1 - 0.5) * cyc)) / 260.0 + 0.61).a;
  float big = texture2D(uNoise, p / 1300.0 + 0.27).a;
  return clamp((mix(a1, a0, w0) - 0.5) * 1.7 + (big - 0.5) * 1.0, -1.0, 1.0);
}

// Foam lapping at the waterline, 0..1. sd = metres from the waterline across the water. A band that washes up and
// falls back every few seconds, each stretch of bank at its own time, with a fainter line left behind as the wash
// falls back. The caller passes it on as foam, so the travelling foam pattern breaks it up. Display choice.
float lapFoam(vec2 p, float sd) {
  float ph = texture2D(uNoise, p / 47.0 + 0.71).a * 9.0;
  float swell = 0.5 + 0.5 * sin(uTime * 1.3 + ph);
  float w = 0.5 + 1.4 * swell;
  float band = 1.0 - smoothstep(0.3 * w, w, sd);
  float back = sd - (1.0 + 2.6 * (1.0 - swell));
  float trail = exp(-back * back / 0.35) * 0.45 * (1.0 - swell);
  return max(band, trail);
}

// The colour of the water itself: lighter where shallow, the bed showing through the last few decimetres (uSee:
// muddy water hides it quickly), patches of muddier water (siltv, -1..1).
vec3 waterBody(float depth, float depthScale, float siltv) {
  float d = max(depth, 0.0);
  float dz = 1.0 - exp(-d / depthScale);
  vec3 body = dz < 0.5 ? mix(uShallow, uBody, dz * 2.0) : mix(uBody, uDeep, dz * 2.0 - 1.0);
  body *= 1.0 + 0.12 * siltv;
  return mix(body, uBed, exp(-d / uSee) * 0.85);
}

// Colour of the surface. slope as above, body = waterBody(...) (the caller may tint it), foam 0..1 (1 = solid white
// water), fpat from waterSlope, shade = 1 in the open (less under a deck), bank 0..1 = how much a bank stands in the
// reflected view (the caller looks).
vec3 shadeWater(vec3 wpos, vec2 slope, vec3 body, float foam, float fpat, float shade, float bank) {
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
  vec3 V = waterEye(wpos);
  float cosv = clamp(dot(n, V), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - cosv, 5.0);
  vec3 R = reflect(-V, n);
  // a cheap world to reflect: the sky with soft clouds (a layer 1.5 km up, fixed in the world and drifting slowly,
  // so its reflection moves right as the camera moves; display choice), and the green and earth bank where one
  // stands in the way
  float b = clamp(bank, 0.0, 1.0);
  vec3 env = mix(uSkyH, uSkyZ, pow(clamp(abs(R.y), 0.0, 1.0), 0.55));
  vec2 cl = (wpos.xz + R.xz / max(R.y, 0.06) * 1500.0) / 5200.0 + uTime * vec2(0.0011, 0.0004);
  float cloud = smoothstep(0.5, 0.85, texture2D(uNoise, cl).a) * smoothstep(0.03, 0.2, R.y);
  env = mix(env, vec3(0.97, 0.98, 0.985), cloud * 0.75);
  env = mix(env, uBank, b * 0.9);
  float lit = -dot(slope, uSun.xz);                   // wave faces turned to the sun: read from straight above too
  body *= 1.0 + clamp(lit * 2.4, -0.2, 0.3);
  vec3 col = mix(body, env, clamp(fres + 0.25 * b * fres, 0.0, 0.6));
  vec3 hv = normalize(uSun + V);
  float nh = max(dot(n, hv), 0.0);
  // the sun: a sharp glint on the wave faces and a broad soft sheen around it (a wet surface, not a matt one)
  col += vec3(1.0, 0.97, 0.9) * (pow(nh, 190.0) * 0.85 + pow(nh, 18.0) * 0.07) * (1.0 - 0.8 * b);
  col = max(col, uDeep * 0.8);                        // nothing drawn as water is much darker than the deep colour
  col *= shade;
  float thr = 1.03 - foam * 1.06;
  float f = smoothstep(thr, thr + 0.28, fpat) * step(0.012, foam);
  f = max(f, smoothstep(0.72, 1.0, foam));            // a full roller is white all over
  vec3 fc = uFoamCol * (0.84 + 0.16 * fpat) * (1.0 + clamp(lit * 1.5, -0.1, 0.06)) * mix(1.0, shade, 0.6);
  return mix(col, fc, f * 0.96);
}

// how much of the surface is white at this point (for alpha: white water is never see-through)
float foamCover(float foam, float fpat) {
  float thr = 1.03 - foam * 1.06;
  return max(smoothstep(thr, thr + 0.28, fpat) * step(0.012, foam), smoothstep(0.72, 1.0, foam));
}
`;

const kits = new WeakMap();

export function waterKit(THREE, river = RIVER) {
  if (kits.has(THREE)) return kits.get(THREE);
  if (!river || !river.normal) river = RIVER; // an A8 blue family passed by an older caller: the river's own look wins
  const N = 256;
  const noise = new THREE.DataTexture(rippleBytes(N), N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  noise.wrapS = noise.wrapT = THREE.RepeatWrapping;
  noise.magFilter = THREE.LinearFilter;
  noise.minFilter = THREE.LinearMipmapLinearFilter;
  noise.generateMipmaps = true;
  noise.anisotropy = 4;
  noise.colorSpace = THREE.NoColorSpace;
  noise.needsUpdate = true;
  // the shaders write their colour straight to the screen (no colour-space step), so the hex values stay as they are
  const c = (v) => new THREE.Color().setStyle(v, THREE.LinearSRGBColorSpace);
  const rip = [];
  for (let i = 0; i < RIPPLES; i++) rip.push(new THREE.Vector4(0, 0, -1e6, 0));
  const uniforms = {
    uNoise: { value: noise },
    uTime: { value: 0 },
    uEyeW: { value: new THREE.Vector3(0, 1, 0) },
    uEyeIsDir: { value: 1 },
    uDeep: { value: new THREE.Color() },
    uBody: { value: new THREE.Color() },
    uShallow: { value: new THREE.Color() },
    uBed: { value: c(river.bed) },
    uSee: { value: 0.3 },
    uBank: { value: c(river.bank) },
    uTurb: { value: TURBIDITY.normal_at },
    uFoamCol: { value: new THREE.Color() },
    uSkyH: { value: c(SKY_HORIZON) },
    uSkyZ: { value: c(SKY_ZENITH) },
    uSun: { value: new THREE.Vector3(...SUN).normalize() },
    uRip: { value: rip },
  };
  // the look now and where it is going: a new flow glides in over TURBIDITY.glide_s of the frame clock
  const turb = { now: TURBIDITY.normal_at, want: null, lastT: null, store: null };
  function applyLook(t) {
    const L = riverLook(t, river);
    turb.now = L.t;
    uniforms.uTurb.value = L.t;
    uniforms.uShallow.value.setRGB(...L.shallow);
    uniforms.uBody.value.setRGB(...L.body);
    uniforms.uDeep.value.setRGB(...L.deep);
    uniforms.uFoamCol.value.setRGB(...L.foam);
    uniforms.uSee.value = L.see_m;
  }
  applyLook(turb.now);
  const flowFrom = (st) => {
    const f = st.get('flow') || {};
    const w = st.get('weir') || {};
    return Number.isFinite(f.q_in) ? f.q_in : w.q_down;
  };
  const e = new THREE.Vector4();
  let next = 0;
  const kit = {
    uniforms,
    glsl: GLSL,
    get time() {
      return uniforms.uTime.value;
    },
    get turbidity() {
      return turb.now;
    },
    setTime(t) {
      if (!Number.isFinite(t)) return;
      uniforms.uTime.value = t;
      if (turb.store) kit.setFlow(flowFrom(turb.store));
      const dt = turb.lastT == null ? 0 : t - turb.lastT;
      turb.lastT = t;
      if (turb.want == null || Math.abs(turb.want - turb.now) < 1e-4) return;
      if (dt > 0 && dt < 2) applyLook(turb.now + (turb.want - turb.now) * (1 - Math.exp(-dt / TURBIDITY.glide_s)));
      else if (dt !== 0) applyLook(turb.want); // a jump of the clock: go straight there
    },
    // the river's flow in m3/s; the first one known is shown at once (a still picture never starts mid-glide)
    setFlow(q) {
      const t = turbidityFor(q);
      if (t == null) return;
      if (turb.want == null) applyLook(t);
      turb.want = t;
    },
    setTurbidity(t) {
      if (!Number.isFinite(t)) return;
      turb.want = Math.max(0, Math.min(1, t));
      applyLook(turb.want);
    },
    // read the flow from the store (flow.q_in, else weir.q_down) on every setTime
    follow(store) {
      turb.store = store && typeof store.get === 'function' ? store : null;
      if (turb.store) kit.setFlow(flowFrom(turb.store));
    },
    // camera position in scene metres. On the map the camera's projection matrix is the whole view (its world
    // matrix is the identity); on a plain three.js page the world matrix carries it. Both give the eye this way.
    eye(camera) {
      e.set(0, 0, 1, 0).applyMatrix4(camera.projectionMatrixInverse).applyMatrix4(camera.matrixWorld);
      if (Math.abs(e.w) > 1e-12) {
        uniforms.uEyeW.value.set(e.x / e.w, e.y / e.w, e.z / e.w);
        uniforms.uEyeIsDir.value = 0;
      } else {
        uniforms.uEyeW.value.set(e.x, Math.abs(e.y), e.z);
        uniforms.uEyeIsDir.value = 1;
      }
    },
    watch(mesh) {
      mesh.onBeforeRender = (renderer, scene, camera) => kit.eye(camera);
      return mesh;
    },
    ripple(x, z, strength = 1) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      rip[next].set(x, z, uniforms.uTime.value, strength);
      next = (next + 1) % RIPPLES;
    },
    ripples: () => rip.filter((r) => r.w > 0 && uniforms.uTime.value - r.z < RIPPLE_LIFE_S).length,
  };
  kits.set(THREE, kit);
  return kit;
}
