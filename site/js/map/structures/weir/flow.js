// The water inside the weir, as a moving 3D surface (lane b08). Pure factory: never touches the map.
//
// One mesh covers every bay from just upstream of the pier noses to just past the stilling basins. Its shape is
// the profile of weir/hydraulics.js for each bay (pond, jet under the leaf, hydraulic jump, basin, tail), rebuilt
// whenever a gate, a level or a flow moves; its look is the shared water surface of water/surface.js, so it runs
// into the river sheets without an edge (water/join.js says where they meet). A second small mesh is the nappe
// that falls from a leaf's top when the pond stands above it.
//
// createBayWater(THREE, P, civil) -> { group, set({H, T, a[], q[]}), wake(), info(), dispose() }
//   H, T: pond and tail (project EL = model y); a[i]: opening of bay i (m); q[i]: flow through bay i (m3/s)

import { waterKit } from '../../water/surface.js';
import { JOIN } from '../../water/join.js';
import { bayProfile, floorLine, G } from './hydraulics.js';

const LIFT = 0.03; // metres above the river sheets where the two overlap
const COLS = 11;
const COL_SPEED = [0.5, 0.5, 0.78, 1, 1, 1, 1, 1, 0.78, 0.5, 0.5]; // slower along the piers
const COL_FOAM = [0.3, 0.3, 0.14, 0, 0, 0, 0, 0, 0.14, 0.3, 0.3]; // and a line of foam there when it runs
const NAPPE_ROWS = 9;

const VERT = /* glsl */ `
attribute vec4 aFlow;   // speed downstream (m/s), foam 0..1, depth (m), alpha
attribute vec3 aAux;    // shade (1 = open sky), roughness 0..1, slope of the surface along the flow
varying vec3 vW;
varying vec4 vFlow;
varying vec3 vAux;
void main() {
  vFlow = aFlow;
  vAux = aAux;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = (kit) => /* glsl */ `
precision highp float;
uniform vec2 uDown;         // downstream, a unit vector in scene x and z
uniform float uDepthScale;
varying vec3 vW;
varying vec4 vFlow;
varying vec3 vAux;
${kit.glsl}
void main() {
  float depth = vFlow.z;
  float alpha = vFlow.w * smoothstep(0.0, 0.07, depth);
  if (alpha < 0.004) discard;
  float sp = vFlow.x;
  float fpat;
  vec2 slope = waterSlope(vW.xz, uDown * sp, vAux.y, fpat) + pointerSlope(vW.xz);
  // fast water draws the foam out into streaks along the flow
  float along = dot(vW.xz, uDown);
  float across = dot(vW.xz, vec2(-uDown.y, uDown.x));
  const float cyc = 1.7;
  float ph0 = fract(uTime / cyc);
  float ph1 = fract(uTime / cyc + 0.5);
  float w0 = 1.0 - abs(2.0 * ph0 - 1.0);
  float st0 = texture2D(uNoise, vec2(across / 2.3, (along - sp * (ph0 - 0.5) * cyc) / 12.0)).a;
  float st1 = texture2D(uNoise, vec2(across / 2.3 + 0.43, (along - sp * (ph1 - 0.5) * cyc) / 12.0 + 0.5)).a;
  fpat = mix(fpat, mix(st1, st0, w0), 0.8 * smoothstep(1.0, 5.0, sp));
  slope -= vAux.z * uDown;                           // the slope of the surface itself: the jet, the face of the jump
  float foam = vFlow.y;
  // the shared look (water/surface.js): no bank in the reflection between the piers; the same drifting patches of
  // muddier water as the river sheets, so the two meet without a change of colour
  vec3 col = shadeWater(vW, slope, waterBody(depth, uDepthScale, silt(vW.xz, uDown * sp)), foam, fpat, vAux.x, 0.0);
  alpha *= max(mix(0.7, 1.0, smoothstep(0.0, 0.5, depth)), foamCover(foam, fpat));
  gl_FragColor = vec4(col, alpha);
}`;

const smooth = (u) => {
  const x = Math.max(0, Math.min(1, u));
  return x * x * (3 - 2 * x);
};

function stations(zGateUp, zGateDn) {
  const zs = [];
  const top = JOIN.up + JOIN.feather;
  const end = -(JOIN.down + JOIN.feather);
  for (let z = top; z > zGateUp + 3.01; z -= 1.5) zs.push(z);
  for (let z = zGateUp + 3; z > zGateUp + 0.01; z -= 0.5) zs.push(z);
  zs.push(zGateUp, zGateDn);
  for (let z = zGateDn - 0.4; z > zGateDn - 30; z -= 0.4) zs.push(z);
  for (let z = zGateDn - 30; z > end + 0.01; z -= 1.25) zs.push(z);
  zs.push(end);
  return zs;
}

export function createBayWater(THREE, P, civil) {
  const kit = waterKit(THREE);
  const L = civil.layout;
  const X = civil.X;
  const zGateUp = L.zGate + 0.42; // the leaf's upstream skin
  const zGateDn = L.zGate - 0.48; // and its downstream girders
  const zs = stations(zGateUp, zGateDn);
  const R = zs.length;
  const iJoin = zs.findIndex((z) => z <= -JOIN.down); // the row on the downstream join line
  const nb = P.bays.length;

  const bays = P.bays.map((B, i) => {
    const sec = civil.sections[i];
    const floorAt = floorLine(sec.pts.slice(1, 11)); // the top of the floor section (its first and last points are the base)
    const xe0 = X(B.x_left);
    const xe1 = X(B.x_left + B.width);
    const prev = P.bays[i - 1];
    const next = P.bays[i + 1];
    const xo0 = prev ? (X(prev.x_left + prev.width) + xe0) / 2 : X(0);
    const xo1 = next ? (xe1 + X(next.x_left)) / 2 : X(P.length);
    const xs = [xo0, xe0, xe0 + 0.6];
    for (let k = 1; k <= 5; k++) xs.push(xe0 + ((xe1 - xe0) * k) / 6);
    xs.push(xe1 - 0.6, xe1, xo1);
    const leafH = B.kind === 'sluice' ? B.gate_h + B.under_h + 0.02 : B.gate_h + P.flapH;
    return {
      B, xs, xc: (xe0 + xe1) / 2, leafH,
      geo: { floorAt, sill: B.sill_el, floor: P.basinFloor, zGateUp, zGateDn, zCrestUp: sec.zCrestUp, zSillUp: sec.zSillUp, zEnd: sec.zEnd, endSill: B.end_sill },
      prof: { y: new Float32Array(R), v: new Float32Array(R), foam: new Float32Array(R), depth: new Float32Array(R), rough: new Float32Array(R) },
    };
  });

  // ---- the surface: one grid of COLS x R points per bay ----
  const nv = nb * COLS * R;
  const pos = new Float32Array(nv * 3);
  const flow = new Float32Array(nv * 4);
  const aux = new Float32Array(nv * 3);
  const index = [];
  // what never changes: x and z of every point, its fade at the two join lines, the shade under the deck
  const alphaZ = new Float32Array(R);
  const shadeZ = new Float32Array(R);
  for (let r = 0; r < R; r++) {
    const z = zs[r];
    const up = smooth((JOIN.up + JOIN.feather - z) / JOIN.feather);
    const down = smooth((z + JOIN.down + JOIN.feather) / JOIN.feather);
    alphaZ[r] = Math.min(up, down);
    const under = smooth((z - (L.zRoad0 - 2.5)) / 2.5) * (1 - smooth((z - L.zHouse1) / 2.5));
    shadeZ[r] = 1 - 0.27 * under;
  }
  bays.forEach((b, bi) => {
    const base = bi * COLS * R;
    for (let c = 0; c < COLS; c++) for (let r = 0; r < R; r++) {
      const i = base + c * R + r;
      pos[i * 3] = b.xs[c];
      pos[i * 3 + 2] = zs[r];
      aux[i * 3] = shadeZ[r] * (c < 2 || c > COLS - 3 ? 0.93 : 1);
    }
    for (let c = 0; c < COLS - 1; c++) for (let r = 0; r < R - 1; r++) {
      const a = base + c * R + r;
      const d = a + R;
      index.push(a, a + 1, d, d, a + 1, d + 1);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('aFlow', new THREE.BufferAttribute(flow, 4));
  geometry.setAttribute('aAux', new THREE.BufferAttribute(aux, 3));
  geometry.setIndex(index);
  const uniforms = { ...kit.uniforms, uDown: { value: new THREE.Vector2(0, -1) }, uDepthScale: { value: 5 } };
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG(kit), uniforms, transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'weir-water';
  mesh.renderOrder = 6; // over the river sheets where they overlap
  mesh.frustumCulled = false;
  const dirV = new THREE.Vector3();
  mesh.onBeforeRender = (renderer, scene, camera) => {
    kit.eye(camera);
    // downstream is the model's -Z, wherever the model has been turned to
    dirV.set(0, 0, -1).transformDirection(mesh.matrixWorld);
    uniforms.uDown.value.set(dirV.x, dirV.z).normalize();
  };

  // ---- the nappe: water falling from the top of a leaf ----
  const nn = nb * 2 * NAPPE_ROWS;
  const npos = new Float32Array(nn * 3);
  const nflow = new Float32Array(nn * 4);
  const naux = new Float32Array(nn * 3).fill(1);
  const nindex = [];
  for (let bi = 0; bi < nb; bi++) {
    const base = bi * 2 * NAPPE_ROWS;
    for (let r = 0; r < NAPPE_ROWS - 1; r++) {
      const a = base + r;
      const d = a + NAPPE_ROWS;
      nindex.push(a, a + 1, d, d, a + 1, d + 1);
    }
  }
  const ngeo = new THREE.BufferGeometry();
  ngeo.setAttribute('position', new THREE.BufferAttribute(npos, 3));
  ngeo.setAttribute('aFlow', new THREE.BufferAttribute(nflow, 4));
  ngeo.setAttribute('aAux', new THREE.BufferAttribute(naux, 3));
  ngeo.setIndex(nindex);
  const nappe = new THREE.Mesh(ngeo, material);
  nappe.name = 'weir-nappe';
  nappe.renderOrder = 7;
  nappe.frustumCulled = false;
  nappe.visible = false;

  const group = new THREE.Group();
  group.name = 'weir-water';
  group.add(mesh, nappe);

  const wakeBays = bays.map((b) => ({ x: b.xc, w: b.B.width, foam: 0, len: 10 }));
  let last = null;

  function set(st) {
    last = st;
    let anyNappe = false;
    bays.forEach((b, bi) => {
      const a = (st.a && st.a[bi]) || 0;
      const q = (st.q && st.q[bi]) || 0;
      const p = bayProfile(b.geo, { H: st.H, T: st.T, a, q, width: b.B.width, leafH: b.leafH }, zs, b.prof);
      const base = bi * COLS * R;
      for (let r = 0; r < R; r++) {
        const r0 = Math.max(0, r - 1);
        const r1 = Math.min(R - 1, r + 1);
        // slope along the flow; across the leaf (between its two faces) the surface is hidden, so no slope there
        let dydz = (p.y[r0] - p.y[r1]) / (zs[r0] - zs[r1]);
        if (zs[r] <= zGateUp + 0.6 && zs[r] >= zGateDn - 0.5) dydz = 0;
        dydz = Math.max(-1.2, Math.min(1.2, dydz));
        for (let c = 0; c < COLS; c++) {
          const i = base + c * R + r;
          pos[i * 3 + 1] = p.y[r] + LIFT;
          const v = p.v[r] * COL_SPEED[c];
          flow[i * 4] = v;
          flow[i * 4 + 1] = Math.min(1, p.foam[r] + COL_FOAM[c] * Math.min(1, v / 2.5));
          flow[i * 4 + 2] = p.depth[r];
          flow[i * 4 + 3] = alphaZ[r];
          aux[i * 3 + 1] = p.rough[r];
          aux[i * 3 + 2] = dydz;
        }
      }
      wakeBays[bi].foam = iJoin >= 0 ? p.foam[iJoin] : 0;
      wakeBays[bi].len = p.fadeLen || 10;
      b.regime = p.regime;
      b.toe = p.toe;
      b.over = p.over;

      // the nappe
      const nbase = bi * 2 * NAPPE_ROWS;
      const hov = st.H - p.leafTop;
      const on = p.over > 0.002 && hov > 0.01;
      if (on) {
        anyNappe = true;
        const v0 = Math.sqrt(G * hov) + 0.4;
        const y0 = p.leafTop + 0.7 * hov;
        const land = p.y[zs.indexOf(zGateDn) + 3];
        const tLand = Math.sqrt((2 * Math.max(0.05, y0 - land)) / G);
        for (let r = 0; r < NAPPE_ROWS; r++) {
          let z;
          let y;
          let sp;
          if (r === 0) { z = zGateUp + 0.9; y = st.H; sp = v0 * 0.6; }
          else {
            const t = (tLand * (r - 1)) / (NAPPE_ROWS - 2);
            z = zGateUp - 0.1 - v0 * t;
            y = y0 - 0.5 * G * t * t;
            sp = Math.hypot(v0, G * t);
          }
          for (let s = 0; s < 2; s++) {
            const i = nbase + s * NAPPE_ROWS + r;
            npos[i * 3] = s ? b.xs[COLS - 2] - 0.05 : b.xs[1] + 0.05;
            npos[i * 3 + 1] = y + LIFT;
            npos[i * 3 + 2] = z;
            nflow[i * 4] = sp;
            nflow[i * 4 + 1] = r === 0 ? 0.1 : Math.min(0.95, 0.45 + 0.07 * r);
            nflow[i * 4 + 2] = Math.max(0.12, hov);
            nflow[i * 4 + 3] = r === 0 ? 0 : 0.94;
            naux[i * 3] = shadeZ[zs.indexOf(zGateDn)];
            naux[i * 3 + 1] = 1;
            naux[i * 3 + 2] = 0;
          }
        }
      } else {
        for (let k = 0; k < 2 * NAPPE_ROWS; k++) nflow[(nbase + k) * 4 + 3] = 0;
      }
    });
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aFlow.needsUpdate = true;
    geometry.attributes.aAux.needsUpdate = true;
    ngeo.attributes.position.needsUpdate = true;
    ngeo.attributes.aFlow.needsUpdate = true;
    ngeo.attributes.aAux.needsUpdate = true;
    nappe.visible = anyNappe;
  }

  return {
    group, mesh, nappe, set,
    // what each bay sends on to the river sheet below the weir (water/shader.js uBay)
    wake: () => ({ z0: JOIN.down, bays: wakeBays }),
    info: () => ({ rows: R, bays: bays.map((b) => ({ id: b.B.id, regime: b.regime, toe: b.toe, over: b.over })), state: last }),
    footprint: { zUp: JOIN.up, zDown: -JOIN.down },
    dispose() {
      geometry.dispose();
      ngeo.dispose();
      material.dispose();
    },
  };
}
