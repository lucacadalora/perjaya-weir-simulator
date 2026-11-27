// Settling basins (lane s, 24 Nov 2026): the GLSL of the sediment drawing. Positions are in the site frame (metres,
// x east, y up model metres, z south). Per-basin state arrives in uniform arrays indexed by the basin number:
//   uB[b] = (turbidity at the inlet 0..1, flush 0..1, water drop m, deposit front F)
//   uG[b] = (z of the inlet tip, z of the north end, s of the bar, full deposit thickness D m)
//   uS[b] = (scour 0..1, flow factor (flow / design flow), 0, 0)
// The deposit formula depG() repeats sediment-shape.js depositShape() (keep the two the same).
import { SHAPE } from './sediment-shape.js';

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
export const NB = 5; // array size: the five basins (shorter lists use the first entries)

export const COMMON = /* glsl */ `
#define NB ${NB}
float sHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float sNoise(vec2 p) {
  vec2 i = floor(p), q = fract(p);
  vec2 u = q * q * (3.0 - 2.0 * q);
  return mix(mix(sHash(i), sHash(i + vec2(1.0, 0.0)), u.x), mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float sFbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * sNoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}
float depG(float s, float w, float F, float sbar) {
  float tip = smoothstep(0.0, ${f(SHAPE.tip)}, s);
  float top = 1.0 - ${f(SHAPE.topFall)} * min(s, sbar) / sbar;
  float x = clamp((F - s) / ${f(SHAPE.ramp)}, 0.0, 1.0);
  float front = x * x * (3.0 - 2.0 * x);
  float across = 1.0 - ${f(SHAPE.across)} + ${f(SHAPE.across)} * w * w;
  return tip * top * front * across;
}
// a flush cuts a gully down the middle of the deposit
float gully(float w, float scour) { return 1.0 - scour * 0.9 * exp(-w * w / 0.08); }
`;

const TURB = /* glsl */ `
uniform vec3 uClear;
uniform vec3 uNormal;
uniform vec3 uFlood;
uniform vec3 uClearS;
uniform vec3 uNormalS;
uniform vec3 uFloodS;
vec3 turbBody(float t) { return t < 0.5 ? mix(uClear, uNormal, t * 2.0) : mix(uNormal, uFlood, min(1.0, t * 2.0 - 1.0)); }
vec3 turbShallow(float t) { return t < 0.5 ? mix(uClearS, uNormalS, t * 2.0) : mix(uNormalS, uFloodS, min(1.0, t * 2.0 - 1.0)); }
`;

const STATE = /* glsl */ `
uniform vec4 uB[NB];
uniform vec4 uG[NB];
uniform vec4 uS[NB];
uniform float uFloor;
uniform float uWater;
`;

// ---------- the deposit on each basin floor ----------
export const DEPOSIT_VS = COMMON + STATE + /* glsl */ `
attribute vec3 aSWB;
attribute float aHW;
varying vec3 vPos;
varying vec3 vN;
varying float vG;
varying float vS;
varying float vF;
varying float vWet;
float thick(float s, float w, int b) {
  vec4 g = uG[b];
  return g.w * depG(s, w, uB[b].w, g.z) * gully(w, uS[b].x);
}
void main() {
  int b = int(aSWB.z + 0.5);
  float s = aSWB.x, w = aSWB.y;
  float L = max(1.0, uG[b].x - uG[b].y);
  float h = thick(s, w, b);
  float dhds = (thick(min(1.0, s + 0.008), w, b) - thick(max(0.0, s - 0.008), w, b)) / (0.016 * L);
  float dhdw = (thick(s, min(1.0, w + 0.1), b) - thick(s, max(-1.0, w - 0.1), b)) / (0.2 * max(aHW, 0.5));
  vN = normalize(vec3(-dhdw, 1.0, dhds));
  vec3 p = vec3(position.x, uFloor + 0.02 + h, position.z);
  vPos = p;
  vG = h;
  vS = s;
  vF = max(uB[b].w, 0.05);
  vWet = (uWater - uB[b].z) - p.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const DEPOSIT_FS = COMMON + /* glsl */ `
uniform vec3 uSand;
uniform vec3 uMud;
uniform vec3 uFloorCol;
uniform vec3 uSun;
varying vec3 vPos;
varying vec3 vN;
varying float vG;
varying float vS;
varying float vF;
varying float vWet;
void main() {
  float n = sFbm(vPos.xz * 0.12);
  float band = 0.5 + 0.5 * sin(vPos.z * 1.25 + n * 6.0);         // sand waves across the flow, about 5 m apart
  float fine = smoothstep(0.55, 1.05, vS / vF);                   // sand over most of the delta, silt at its front
  vec3 c = mix(uSand, uMud, fine);
  c *= 0.9 + 0.1 * band + 0.16 * (n - 0.5);
  float film = smoothstep(0.02, 0.22, vG);                        // bare floor: concrete under a thin mud film
  c = mix(mix(uFloorCol, uMud, 0.55), c, film);
  float wet = smoothstep(-0.05, 0.3, vWet);
  c *= mix(1.12, 0.88, wet);                                       // sand out of the water dries lighter
  float lam = max(dot(normalize(vN), uSun), 0.0);
  c *= 0.6 + 0.5 * lam;
  gl_FragColor = vec4(c, 1.0);
}
`;

// ---------- the water in each basin ----------
export const BASIN_VS = COMMON + STATE + /* glsl */ `
attribute vec3 aSWB;
varying vec3 vPos;
varying vec2 vSW;
varying vec4 vSt;
varying vec3 vGeo;
varying float vDepth;
void main() {
  int b = int(aSWB.z + 0.5);
  vec4 st = uB[b];
  vec4 g = uG[b];
  float s = aSWB.x, w = aSWB.y;
  float L = max(1.0, g.x - g.y);
  // a flushing basin's surface falls towards its gates
  float surf = uWater - st.z - st.y * 0.35 * clamp(s / g.z, 0.0, 1.2);
  float dep = g.w * depG(s, w, st.w, g.z) * gully(w, uS[b].x);
  vDepth = surf - (uFloor + 0.02 + dep);
  vec3 p = vec3(position.x, surf, position.z);
  vPos = p;
  vSW = vec2(s, w);
  vSt = st;
  vGeo = vec3(g.z, L, float(b));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const BASIN_FS = COMMON + TURB + /* glsl */ `
uniform float uTime;
uniform float uTauOut;
uniform float uU;
uniform float uUf;
uniform vec3 uSun;
uniform vec3 uEye;
uniform vec3 uSky;
uniform vec3 uFoam;
uniform vec3 uSand;
varying vec3 vPos;
varying vec2 vSW;
varying vec4 vSt;
varying vec3 vGeo;
varying float vDepth;
float hN(vec2 p) {
  return sNoise(p * 0.31 + vec2(uTime * 0.05, -uTime * 0.21)) * 0.65 + sNoise(p * 0.83 + vec2(-uTime * 0.17, uTime * 0.09)) * 0.35;
}
void main() {
  float s = vSW.x, w = vSW.y, sbar = vGeo.x, L = vGeo.y, bi = floor(vGeo.z);
  float flush = vSt.y, tIn = vSt.x;
  float along = s * L;
  // muddy water from the inlet drifts north in billows and clears as its sand settles
  float bill = sFbm(vec2(w * 1.6 + bi * 7.3, (along - uTime * uU) / 13.0));
  float k = smoothstep(0.02, sbar * 0.95, s);
  float tau = mix(tIn, uTauOut, k);
  tau += 0.3 * tIn * (1.0 - smoothstep(0.0, 0.32, s));          // the sand-laden jet where the feed channel enters
  tau += (bill - 0.5) * 0.5 * tIn * (1.0 - 0.8 * k);
  // a flush: brown and fast to the gates on the bar
  float fl = flush * (1.0 - 0.6 * smoothstep(sbar + 0.02, sbar + 0.12, s));
  tau = clamp(mix(tau, 1.0, fl * 0.95), 0.0, 1.0);
  vec3 body = turbBody(tau);
  vec3 sh = turbShallow(tau);
  // the deposit shows through shallow water (display: deeper than muddy water really allows, so the delta is seen)
  float see = mix(3.0, 1.2, tau);
  float bedShow = exp(-max(vDepth, 0.0) / see);
  vec3 col = mix(body, sh, 0.2 + 0.5 * bedShow);
  col = mix(col, uSand * 0.85, bedShow * 0.6 * (1.0 - 0.4 * tau) * (1.0 - fl));   // the delta's sand seen through the water
  // small ripples, the sky and the sun
  vec2 q = vPos.xz;
  float e = 0.6;
  float h0 = hN(q);
  float amp = 0.5 + 1.2 * fl;
  vec3 n = normalize(vec3(-(hN(q + vec2(e, 0.0)) - h0) / e * amp, 1.0, -(hN(q + vec2(0.0, e)) - h0) / e * amp));
  vec3 V = normalize(uEye - vPos);
  float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 5.0);
  col = mix(col, uSky, clamp(fres, 0.0, 0.4));
  col += vec3(1.0, 0.97, 0.9) * pow(max(dot(n, normalize(uSun + V)), 0.0), 140.0) * 0.45;
  // foam streaks running to the gates in a flush (long along the flow, thin across), white water at the gates
  float st = smoothstep(0.7, 0.94, sNoise(vec2(w * 11.0 + bi * 3.1, (along - uTime * uUf) / 14.0)));
  float db = (s - sbar) * L / 4.0;
  float atBar = exp(-db * db);
  float foam = fl * (st * 0.4 + atBar * 0.85 * sNoise(q * 0.8 + uTime * 2.0));
  col = mix(col, uFoam, clamp(foam, 0.0, 0.85));
  col *= 1.0 - 0.12 * smoothstep(0.82, 1.0, abs(w));             // a darker line along the walls
  float alpha = mix(0.9, 0.45, bedShow);
  alpha = max(max(alpha, 0.88 * fl), clamp(foam, 0.0, 0.9));        // flushing water is opaque brown
  gl_FragColor = vec4(col, alpha);
}
`;

// ---------- suspended sediment drifting along each basin and sinking ----------
export const PART_VS = COMMON + STATE + /* glsl */ `
uniform vec4 uLens[NB * 8];
uniform float uTime;
uniform float uU;
uniform float uUf;
uniform float uPx;
uniform float uShow;
attribute vec4 aP;
attribute float aBasin;
varying float vA;
varying float vC;
vec2 lensSample(int k) {
  vec4 q = uLens[k / 2];
  return (k - (k / 2) * 2) == 0 ? q.xy : q.zw;
}
vec2 lensAt(int b, float s) {
  float x = clamp(s, 0.0, 1.0) * 15.0;
  float i0 = floor(min(x, 14.0));
  int k = b * 16 + int(i0);
  return mix(lensSample(k), lensSample(k + 1), x - i0);
}
void main() {
  int b = int(aBasin + 0.5);
  vec4 st = uB[b];
  vec4 g = uG[b];
  float L = max(1.0, g.x - g.y), sbar = g.z, flush = st.y;
  float U = mix(uU * clamp(uS[b].y, 0.15, 1.6), uUf, flush);
  float reach = mix(sbar * 1.25, sbar + 0.02, flush);           // fines may pass the bar; in a flush all go to the gates
  float period = reach * L / U;
  float age = fract(aP.x + uTime / period) * period;
  float s = age * U / L;
  float w = aP.y * smoothstep(0.0, 0.22, s);                       // the jet spreads out of the inlet tip
  vec2 lw = lensAt(b, s);
  float surf = uWater - st.z;
  float bed = uFloor + 0.02 + g.w * depG(s, w, st.w, sbar) * gully(w, uS[b].x);
  float H = max(0.05, surf - bed);
  float ws = mix(0.02, 0.22, aP.w * aP.w);                         // display sinking speed (m/s): sand fast, silt slow
  float sunk = mix(aP.z * 0.25 + ws * age / H, aP.z * 0.8, flush);  // share of the water column sunk through
  float y = surf - clamp(sunk, 0.0, 1.0) * H;
  float on = step(sHash(aP.xy * 31.7 + float(b)), uShow * (0.35 + 0.65 * clamp(st.x * 1.6, 0.0, 1.0)));
  float a = on * (1.0 - smoothstep(0.85, 1.0, sunk)) * smoothstep(0.0, 0.03, s) * (1.0 - smoothstep(reach - 0.06, reach, s));
  a *= mix(1.0, 0.35, clamp(sunk, 0.0, 1.0)) * (1.0 - 0.6 * flush);
  vA = a;
  vC = aP.w;
  vec4 cp = projectionMatrix * modelViewMatrix * vec4(lw.x + w * lw.y * 0.9, y, g.x - s * L, 1.0);
  gl_Position = cp;
  gl_PointSize = a > 0.001 ? clamp(uPx * mix(0.9, 1.8, aP.w) / max(cp.w, 1e-6), 1.5, 4.0) : 0.0;
}
`;

export const PART_FS = /* glsl */ `
uniform vec3 uFine;
uniform vec3 uCoarse;
varying float vA;
varying float vC;
void main() {
  float r = length(gl_PointCoord - 0.5);
  float a = vA * (1.0 - smoothstep(0.2, 0.5, r)) * 0.7;
  if (a < 0.01) discard;
  gl_FragColor = vec4(mix(uFine, uCoarse, vC), a);
}
`;

// ---------- the water of the channels (feed, outlets and canal, flushing channel, fish ladder) ----------
export const CHAN_VS = /* glsl */ `
attribute float aAlong;
varying vec3 vPos;
varying float vAlong;
void main() {
  vPos = position;
  vAlong = aAlong;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const CHAN_FS = COMMON + TURB + /* glsl */ `
uniform float uTime;
uniform float uTau;
uniform float uFlow;
uniform float uFoamAmt;
uniform vec3 uFoam;
varying vec3 vPos;
varying float vAlong;
void main() {
  float x = (vAlong - uTime * uFlow);
  float xc = dot(vPos.xz, vec2(0.11, 0.07));
  float bill = sFbm(vec2(x / 9.0, xc));
  float tau = clamp(uTau + (bill - 0.5) * 0.3 * (0.4 + uTau), 0.0, 1.0);
  vec3 col = mix(turbBody(tau), turbShallow(tau), 0.3);
  col *= 0.94 + 0.12 * sNoise(vPos.xz * 0.45 + vec2(0.0, -uTime * 0.3));
  float st = smoothstep(0.6, 0.88, sNoise(vec2(x / 3.5, dot(vPos.xz, vec2(0.37, 0.29)))));
  col = mix(col, uFoam, st * uFoamAmt);
  gl_FragColor = vec4(col, 0.93);
}
`;

// ---------- the brown plume a flush sends into the river ----------
export const PLUME_VS = /* glsl */ `
attribute vec2 aUV;
varying vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const PLUME_FS = COMMON + /* glsl */ `
uniform float uAmt;
uniform float uFront;
uniform float uTime;
uniform float uLen;
uniform vec3 uDark;
uniform vec3 uLight;
uniform vec3 uFoam;
varying vec2 vUV;
void main() {
  float u = vUV.x, v = vUV.y;
  float along = u * uLen;
  float b1 = sFbm(vec2(v * 2.2, (along - uTime * 3.2) / 16.0));
  float b2 = sNoise(vec2(v * 5.0 + 3.0, (along - uTime * 4.5) / 6.0));
  float lat = 1.0 - smoothstep(0.3 + 0.45 * b1, 1.0, abs(v));
  float head = 1.0 - smoothstep(uFront - 0.14, uFront, u + (b1 - 0.5) * 0.16 + 0.05 * abs(v));   // a ragged, rounded front
  float tail = 1.0 - smoothstep(0.45, 1.0, u);
  float a = uAmt * lat * head * (0.3 + 0.7 * tail) * (0.55 + 0.6 * b1);
  vec3 col = mix(uDark, uLight, smoothstep(0.35, 0.75, b1));
  col = mix(col, uFoam, smoothstep(0.7, 0.95, b2) * (1.0 - smoothstep(0.0, 0.2, u)) * 0.5);
  a = clamp(a, 0.0, 0.88);
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}
`;
