// The water sheet material. Owner: lane b06.
// A sheet at the water level. MapLibre's terrain is in the depth buffer when the 3D layer draws (CONTRACT A3),
// so the ground cuts the sheet exactly where ground = level; the mask only keeps water out of hollows that are not
// part of the water body. The surface itself (ripples, reflection, foam, pointer rings) is the shared look of
// water/surface.js. A sheet may also carry:
// - a current: a texture of flow directions (water/flowfield.js) and a speed; the ripples travel with it;
// - a cut: a straight line where the sheet stops and the weir's own water takes over (water/join.js);
// - a wake: the white water each weir bay sends downstream, fading with distance;
// - a shore (lane w, 24 Nov 2026): the depth comes from the terrain the map draws (sheet.fitTerrain), so the sheet
//   knows how far each point is from the waterline: lighter water over the last metres, a lapping line, the bank in
//   the reflection, and the water thinning out over its last decimetres instead of ending on a hard edge;
// - a wet band (createWetMaterial): the bank darkened and faintly glossy just above the waterline.

import { waterKit } from './surface.js';

export const WAKE_BAYS = 10;

const VERT = /* glsl */ `
uniform sampler2D uFloor;    // R16F: river floor for a channel sheet, minus uGroundBase (hug mode only)
uniform float uHug;          // 1 = channel sheet: never below the surface model's river (see createSheet)
uniform float uLevelRel;
uniform float uLift;
uniform float uHugShift;     // 1 = the river's own surface moved up or down with the level (a tailwater reach)
uniform float uHugRef;       // the level (minus uGroundBase) at which the sheet lies on that surface
uniform vec2 uSize;
uniform vec4 uCut;           // xy: a point on the cut line (sheet metres), zw: unit direction into the sheet
uniform float uCutFlat;      // metres from the cut over which the sheet is flat at the level (0 = no cut)
uniform float uWetLift;      // the wet band's pass: metres above the water it is drawn at (0 = the water itself)
varying vec2 vXZ;      // sheet-local metres: x east, z south, origin at the sheet centre
varying vec3 vW;       // scene metres
varying float vRise;   // how far this point of the sheet lies above the level (hug mode), metres
void main() {
  vec3 p = position;
  vRise = 0.0;
  if (uHug > 0.5) {
    vec2 uv = vec2(p.x / uSize.x + 0.5, p.z / uSize.y + 0.5);
    float f = texture(uFloor, uv).r + uLift;
    float y = uHugShift > 0.5 ? f + (uLevelRel - uHugRef) : max(uLevelRel, f);
    if (uCutFlat > 0.0) y = mix(uLevelRel, y, smoothstep(0.0, uCutFlat, dot(p.xz - uCut.xy, uCut.zw)));
    p.y += y - uLevelRel;
    vRise = y - uLevelRel;
  }
  p.y += uWetLift;
  vXZ = p.xz;
  vW = (modelMatrix * vec4(p, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAG = (kit) => /* glsl */ `
precision highp float;
uniform sampler2D uMask;     // R8: 1 = water may show here (linear filtered: smooth edge)
uniform sampler2D uGround;   // R16F: ground height minus uGroundBase, metres (linear filtered)
uniform vec2 uGroundTexel;   // 1 / the ground texture's size (columns, rows)
uniform float uShoreFx;      // 1 = draw the shore (lapping foam, the bank in the reflection); 0 = open water only
uniform float uGroundBase;
uniform float uLevelRel;     // water level minus uGroundBase, metres
uniform vec2 uSize;          // sheet width (east) and height (south), metres
uniform float uOpacity;
uniform float uDepthScale;   // metres over which the colour goes from shallow to deep
uniform float uHug;
uniform float uMinDepth;     // hug mode: a river is never shown as a film of water
uniform vec4 uFade;          // xy: a point (sheet metres), zw: unit direction away from it (0 = no fade)
uniform vec2 uFadeRange;     // distance along uFade.zw where the sheet starts and ends fading out
uniform vec4 uCut;
uniform float uCutFlat;
uniform sampler2D uFlowTex;  // RG: unit direction of the current (east, south), B: 1 in mid-channel, less at the banks
uniform float uFlowSpeed;    // m/s in mid-channel at uFlowDepth (0 = still water)
uniform float uFlowDepth;
uniform vec4 uWakeAxis;      // xy: the weir axis centre (sheet metres), zw: unit direction of the axis (towards its far end)
uniform float uWakeZ0;       // metres downstream of the axis where this sheet starts (0 = no wake)
uniform vec4 uBay[${WAKE_BAYS}];          // per bay: centre along the axis (m), width (m), foam there 0..1, fade length (m)
varying vec2 vXZ;
varying vec3 vW;
varying float vRise;
${kit.glsl}

void main() {
  vec2 uv = vec2(vXZ.x / uSize.x + 0.5, vXZ.y / uSize.y + 0.5);   // row 0 of the textures is the north edge
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
  float m = texture2D(uMask, uv).r;
  if (m < 0.5) discard;
  if (uCutFlat > 0.0 && dot(vXZ - uCut.xy, uCut.zw) < 0.0) discard;   // the weir's own water from here
  float ground = texture2D(uGround, uv).r;
  float surf = uLevelRel + vRise;                 // the water surface here, metres above uGroundBase
  float depth = surf - ground;                    // metres of water over the ground the map draws (fitTerrain)
  if (uHug > 0.5) depth = max(depth, 0.0) + uMinDepth;
  else if (depth < -0.05) discard;                // the depth test also cuts here; this saves the work

  // the current: along the channel, quicker where the water is deep, slack at the banks (Manning's 2/3 power)
  vec4 fl = texture2D(uFlowTex, uv);
  vec2 dir = fl.rg * 2.0 - 1.0;
  float sp = uFlowSpeed * fl.b * clamp(pow(max(depth, 0.05) / uFlowDepth, 0.667), 0.2, 1.5);
  vec2 vel = dir * sp;

  // white water coming out of the weir bays, spreading and fading downstream
  float foam = 0.0;
  if (uWakeZ0 > 0.0) {
    vec2 r = vXZ - uWakeAxis.xy;
    float xw = dot(r, uWakeAxis.zw);
    float dd = -dot(r, vec2(-uWakeAxis.w, uWakeAxis.z)) - uWakeZ0;   // metres below the line where the sheet starts
    if (dd > -1.0 && dd < 420.0) {
      dd = max(dd, 0.0);
      for (int i = 0; i < ${WAKE_BAYS}; i++) {
        vec4 b = uBay[i];
        float half_ = 0.5 * b.y + 0.10 * dd;
        float edge = 1.5 + 0.07 * dd;
        foam += b.z * (1.0 - smoothstep(half_ - edge, half_ + edge, abs(xw - b.x))) * exp(-dd / max(b.w, 1.0));
      }
      foam = min(foam, 1.0);
    }
  }

  // the shore: metres across the water to the waterline = depth / the bank's slope (forward differences of the
  // ground). Lapping foam lives there (display choice); on flat flooded ground the slope is small, so it stays away.
  vec2 gs = vec2(texture2D(uGround, uv + vec2(uGroundTexel.x, 0.0)).r - ground,
                 texture2D(uGround, uv + vec2(0.0, uGroundTexel.y)).r - ground) / (uGroundTexel * uSize);
  float sd = depth / max(length(gs), 0.05);
  float lap = uShoreFx * lapFoam(vW.xz, sd);
  float rough = clamp(sp / 3.5, 0.0, 0.7) + 0.5 * foam + 0.25 * lap;

  float fpat;
  vec2 slope = waterSlope(vW.xz, vel, min(rough, 1.0), fpat) + pointerSlope(vW.xz);

  // a bank in the reflected view: three steps along the reflected ray over the ground heights (the sheet is never
  // turned, so its axes are the scene's). Where the ray meets higher ground, the water shows the bank, not the sky.
  // Dry land a metre or more above the water counts 6 m taller: the trees and bushes along the bank (display choice;
  // the surface model holds only part of them).
  vec3 R = reflect(-waterEye(vW), normalize(vec3(-slope.x, 1.0, -slope.y)));
  float bank = 0.0;
  float hl = length(R.xz);
  if (hl > 1e-3) {
    vec2 rd = R.xz / hl;
    float tanE = R.y / hl;
    for (int i = 0; i < 3; i++) {
      float s = i == 0 ? 6.0 : (i == 1 ? 16.0 : 40.0);
      float g = texture2D(uGround, (vXZ + rd * s) / uSize + 0.5).r - surf;
      g += 6.0 * smoothstep(0.6, 1.6, g);
      bank = max(bank, smoothstep(-0.2, 1.5, g - s * tanE));
    }
  }

  // the water itself, lighter over its last metres towards the bank (display choice), then the surface over it
  vec3 body = waterBody(depth, uDepthScale, silt(vW.xz, vel));
  body = mix(body, uShallow, uShoreFx * (1.0 - smoothstep(0.0, 8.0, sd)) * 0.45);
  vec3 col = shadeWater(vW, slope, body, foam, fpat, 1.0, bank * uShoreFx);
  // the lapping line: a soft cream line along the waterline, thicker and thinner along the bank
  float lapLine = lap * (0.45 + 0.55 * fpat) * 0.75;
  col = mix(col, uFoamCol, lapLine);

  // opaque water (the muddy river hides what lies under it); it thins to nothing over its last decimetres, so it
  // meets the wet ground of the bank softly instead of on a hard line
  float alpha = uOpacity * smoothstep(0.0, 0.28, depth);
  alpha = max(alpha, max(foamCover(foam, fpat) * 0.95, lapLine) * smoothstep(0.0, 0.05, depth));
  alpha *= smoothstep(0.5, 0.72, m);              // and at the edge of the mask
  if (dot(uFade.zw, uFade.zw) > 0.5) {             // the far end of a river reach: never a wall of water
    float along = dot(vXZ - uFade.xy, uFade.zw);
    alpha *= 1.0 - smoothstep(uFadeRange.x, uFadeRange.y, along);
  }
  gl_FragColor = vec4(col, alpha);
}`;

export function createWaterMaterial(THREE, { maskTex, groundTex, floorTex = null, flowTex = null, groundBase, size, colours, opacity = 1, depthScale = 9, lift = 0.6, minDepth = 2.5, hugShift = false, hugRef = 0, shore = 1 }) {
  const kit = waterKit(THREE, colours);
  const bays = [];
  for (let i = 0; i < WAKE_BAYS; i++) bays.push(new THREE.Vector4(0, 0, 0, 1));
  // no current: a 1 x 1 texture that says "no direction, still"
  const still = flowTex || (() => {
    const t = new THREE.DataTexture(new Uint8Array([128, 128, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.needsUpdate = true;
    return t;
  })();
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG(kit),
    transparent: true,
    depthWrite: false,
    depthTest: true,
    // water and a flat surface-model river at the same height: let the water win, never flicker
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -8,
    side: THREE.DoubleSide,
    uniforms: {
      ...kit.uniforms,
      uMask: { value: maskTex },
      uGround: { value: groundTex },
      uGroundBase: { value: groundBase },
      uGroundTexel: { value: new THREE.Vector2(1 / Math.max(1, groundTex.image.width), 1 / Math.max(1, groundTex.image.height)) },
      uShoreFx: { value: shore },
      uLevelRel: { value: 0 },
      uSize: { value: new THREE.Vector2(size[0], size[1]) },
      uOpacity: { value: opacity },
      uDepthScale: { value: depthScale },
      uFloor: { value: floorTex || groundTex },
      uHug: { value: floorTex ? 1 : 0 },
      uLift: { value: lift },
      uHugShift: { value: hugShift ? 1 : 0 },
      uHugRef: { value: hugRef - groundBase },
      uMinDepth: { value: minDepth },
      uFade: { value: new THREE.Vector4(0, 0, 0, 0) },
      uFadeRange: { value: new THREE.Vector2(1e9, 1e9) },
      uCut: { value: new THREE.Vector4(0, 0, 0, 1) },
      uCutFlat: { value: 0 },
      uWetLift: { value: 0 },
      uFlowTex: { value: still },
      uFlowSpeed: { value: 0 },
      uFlowDepth: { value: 3 },
      uWakeAxis: { value: new THREE.Vector4(0, 0, 1, 0) },
      uWakeZ0: { value: 0 },
      uBay: { value: bays },
    },
  });
  material.userData.ownFlowTex = flowTex ? null : still;
  return material;
}

// The wet band on the bank just above the waterline, drawn from the water's side: the same sheet lifted WET.lift_m,
// showing only where the ground lies between the water surface and that height, darker and faintly glossy at the
// water and fading out upwards. Shares the water material's uniforms (one level, one mask, one ground). Display
// choice; lane g's ground drape carries its own wet sand, so this stays a thin film at the edge.
export const WET = Object.freeze({ lift_m: 0.7, alpha: 0.3 });

const WET_FRAG = (kit) => /* glsl */ `
precision highp float;
uniform sampler2D uMask;
uniform sampler2D uGround;
uniform float uLevelRel;
uniform vec2 uSize;
uniform float uOpacity;
uniform float uHug;
uniform float uMinDepth;
uniform vec4 uCut;
uniform float uCutFlat;
uniform float uWetLift;
uniform vec4 uFade;
uniform vec2 uFadeRange;
varying vec2 vXZ;
varying vec3 vW;
varying float vRise;
${kit.glsl}
void main() {
  if (uHug > 0.5 && uMinDepth > 0.0) discard;     // a sheet that never shows its edge has no wet band
  vec2 uv = vec2(vXZ.x / uSize.x + 0.5, vXZ.y / uSize.y + 0.5);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
  float m = texture2D(uMask, uv).r;
  if (m < 0.5) discard;
  if (uCutFlat > 0.0 && dot(vXZ - uCut.xy, uCut.zw) < 0.0) discard;
  float above = texture2D(uGround, uv).r - (uLevelRel + vRise);   // metres the ground stands above the water
  if (above < -0.02 || above > uWetLift) discard;
  float wet = smoothstep(-0.02, 0.06, above) * (1.0 - smoothstep(0.0, uWetLift, above));
  wet *= smoothstep(0.5, 0.72, m);
  if (dot(uFade.zw, uFade.zw) > 0.5) wet *= 1.0 - smoothstep(uFadeRange.x, uFadeRange.y, dot(vXZ - uFade.xy, uFade.zw));
  // wet earth: darker, a little of the sky in it
  vec3 V = waterEye(vW);
  float fres = 0.04 + 0.96 * pow(1.0 - clamp(V.y, 0.0, 1.0), 5.0);
  vec3 col = mix(uBed * 0.42, uSkyH, clamp(fres * 0.6 + 0.06, 0.0, 0.5));
  gl_FragColor = vec4(col, wet * ${WET.alpha.toFixed(2)} * uOpacity);
}`;

export function createWetMaterial(THREE, water) {
  const kit = waterKit(THREE);
  return new THREE.ShaderMaterial({
    vertexShader: water.vertexShader,
    fragmentShader: WET_FRAG(kit),
    // the water's own uniform objects (one level, one mask, one ground), with its own lift
    uniforms: { ...water.uniforms, uWetLift: { value: WET.lift_m } },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
}
