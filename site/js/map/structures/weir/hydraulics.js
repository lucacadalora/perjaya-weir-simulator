// The water surface through one weir bay, for drawing (lane b08). Pure: no three.js, no DOM.
//
// The engine (engine/weir.js) decides how much water each bay passes. This turns that flow into the shape people
// see: the pond held by the leaf, the thin fast sheet that shoots out under it and down the glacis, the hydraulic
// jump where that sheet meets the tailwater and turns white, the pool the end sill holds, and the calmer water
// beyond. One-dimensional open-channel hydraulics with no losses (energy line = the pond level), the Belanger
// equation for the jump, critical depth over the end sill. It is a picture of the flow the engine computed, not a
// second model: no number on a panel comes from here.
//
// Frame: z in metres along the flow, upstream positive (the weir model's +Z), levels in project EL.

export const G = 9.81;

// a floor line from points [[z, el], ...] with z falling: el at z (flat beyond both ends)
export function floorLine(pts) {
  const p = pts.slice().sort((a, b) => b[0] - a[0]);
  return (z) => {
    if (z >= p[0][0]) return p[0][1];
    for (let i = 1; i < p.length; i++) {
      if (z >= p[i][0]) {
        const a = p[i - 1];
        const b = p[i];
        const w = a[0] === b[0] ? 0 : (a[0] - z) / (a[0] - b[0]);
        return a[1] + (b[1] - a[1]) * w;
      }
    }
    return p[p.length - 1][1];
  };
}

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (u) => {
  const x = clamp(u, 0, 1);
  return x * x * (3 - 2 * x);
};

// depth of the fast (supercritical) sheet with unit flow q under an energy line `head` metres above the floor
export function fastDepth(q, head, g = G) {
  const yc = Math.cbrt((q * q) / g);
  if (!(head > 1.5 * yc * 1.0005)) return yc; // the energy line is too low for a fast sheet: critical depth
  let d = q / Math.sqrt(2 * g * head);
  for (let i = 0; i < 12; i++) d = q / Math.sqrt(2 * g * Math.max(head - d, 0.5 * yc));
  return Math.min(d, yc);
}

// the depth a fast sheet of depth d jumps to (Belanger)
export function sequentDepth(q, d, g = G) {
  return (d / 2) * (Math.sqrt(1 + (8 * q * q) / (g * d * d * d)) - 1);
}

/**
 * geo: { floorAt(z), sill (gate seat EL), floor (basin floor EL), zGateUp, zGateDn (the leaf's two faces),
 *        zCrestUp (upstream edge of the gate seat), zSillUp (where the end sill starts to rise), zEnd (the end sill's downstream edge), endSill (its height, m) }
 * st:  { H (pond EL), T (tail EL), a (gate opening, m), q (flow through the bay, m3/s), width (m),
 *        leafH (leaf height with its flap, m) }
 * zs:  stations, z falling (upstream first)
 * out: optional {y, v, foam, depth, rough} Float32Arrays of zs.length to fill
 * -> { y (surface EL), v (speed, m/s), foam 0..1, depth (m, negative where the floor is above the water),
 *      rough 0..1, toe (z of the jump's toe or null), drop (m the jump rises), basin (EL the basin holds),
 *      regime 'still' | 'gate' | 'gate-drowned' | 'open' | 'open-drowned', over (m2/s over the leaf top) }
 */
export function bayProfile(geo, st, zs, out) {
  const n = zs.length;
  const o = out || { y: new Float32Array(n), v: new Float32Array(n), foam: new Float32Array(n), depth: new Float32Array(n), rough: new Float32Array(n) };
  const { floorAt, sill, floor, zGateUp, zGateDn, zEnd, endSill } = geo;
  const zSillUp = geo.zSillUp ?? zEnd + endSill * 1.2 + 2.4;
  const H = st.H;
  const T = st.T;
  const h1 = H - sill;
  const a = Math.max(0, st.a || 0);
  const qAll = st.q > 0 && h1 > 0.02 ? st.q / st.width : 0;
  // water over the top of the leaf (pond above it): its share of the bay's flow
  const leafTop = sill + a + st.leafH;
  const qOver = H > leafTop + 0.01 && a < h1 ? Math.min(qAll, 1.7 * Math.pow(H - leafTop, 1.5)) : 0;
  const q = Math.max(0, qAll - qOver);
  const flowing = q > 1e-3;
  const gated = a < h1 - 0.02; // the lip is in the water: the leaf holds the pond
  const yc = Math.cbrt((q * q) / G);
  // the level the basin holds: the tail, or what the end sill backs up (critical depth over it)
  const sillTop = floor + endSill;
  const ycAll = Math.cbrt((qAll * qAll) / G);
  const basin = Math.max(T, qAll > 1e-3 ? sillTop + 1.4 * ycAll : sillTop - 0.03);
  const dropLen = Math.max(2.5, 2.2 * endSill); // metres over which the water falls from the basin to the tail

  // downstream of the leaf -----------------------------------------------------------------------------------
  let toe = null;
  let drop = 0;
  let y1 = basin;
  let jumpLen = 0;
  let foam0 = 0;
  let fadeLen = 10;
  let regime = 'still';
  let fr1 = 0;
  const E = H; // energy line
  const fast = (z) => fastDepth(q, E - floorAt(z));
  if (flowing) {
    // the jump stands where the fast sheet's sequent depth reaches the basin level; look for that point
    const gap = (z) => {
      const d = fast(z);
      return floorAt(z) + sequentDepth(q, d) - basin;
    };
    const zLim = zSillUp + 1;
    let zPrev = zGateDn;
    let gPrev = gap(zPrev);
    if (gPrev <= 0) {
      toe = zGateDn; // the tailwater drowns the jet at the leaf
      regime = gated ? 'gate-drowned' : 'open-drowned';
    } else {
      regime = gated ? 'gate' : 'open';
      toe = zLim; // not held before the end sill: it forces the jump there
      for (let z = zGateDn - 0.25; z >= zLim; z -= 0.25) {
        const gz = gap(z);
        if (gz <= 0) {
          toe = z + (0.25 * -gz) / (gPrev - gz);
          break;
        }
        zPrev = z;
        gPrev = gz;
      }
    }
    const d1 = fast(toe);
    const v1 = q / d1;
    fr1 = v1 / Math.sqrt(G * d1);
    y1 = floorAt(toe) + d1;
    if (regime.endsWith('drowned')) {
      // a drowned jet: the surface dips below the basin level just behind the leaf, with a roller on top
      const dip = clamp(0.12 * (v1 * v1) / (2 * G), 0.03, 0.6 * Math.max(0.05, basin - y1));
      y1 = basin - dip;
    }
    drop = Math.max(0, basin - y1);
    jumpLen = clamp(5.5 * drop, 1.2, 16);
    const weight = clamp(q / 0.25, 0, 1); // a trickle makes little foam
    foam0 = clamp(0.22 + 0.11 * (fr1 - 1), 0.1, 0.94) * weight;
    if (regime.endsWith('drowned')) foam0 *= gated ? 0.8 : 0.55;
    fadeLen = clamp(7 + 7 * drop + 2.5 * q, 7, 70);
  }
  const plunge = qOver > 0 ? clamp(0.45 + 0.6 * qOver, 0, 1) : 0; // the nappe falling from the leaf top

  // upstream of the leaf: the pond; an open bay draws it down towards the sill
  const zDraw = geo.zCrestUp + 2.5 * Math.max(0.5, h1);
  const yGate = flowing && !gated ? Math.min(H, Math.max(floorAt(zGateDn) + fast(zGateDn), regime === 'open-drowned' ? y1 : -Infinity)) : H;

  for (let i = 0; i < n; i++) {
    const z = zs[i];
    const fl = floorAt(z);
    let y;
    let foam = 0;
    let rough = 0;
    if (z >= zGateUp - 1e-6) {
      y = flowing && !gated ? H - (H - yGate) * smooth((zDraw - z) / (zDraw - zGateDn)) : H;
      rough = flowing ? clamp((qAll / Math.max(0.3, y - fl)) / 6, 0, 0.5) : 0;
    } else if (!flowing) {
      y = z > zEnd ? basin : T + (basin - T) * (1 - smooth((zEnd - z) / dropLen));
      if (plunge > 0) foam = plunge * Math.exp(-(zGateDn - z) / 9);
      rough = foam;
    } else {
      const s = toe - z; // metres below the jump's toe
      if (s < 0) {
        // the fast sheet
        const d = fast(z);
        y = fl + d;
        const fr = q / d / Math.sqrt(G * d);
        foam = clamp(0.3 + 0.07 * (fr - 1), 0.3, 0.72) * clamp(q / 0.25, 0.3, 1);
        rough = 1;
      } else if (s <= jumpLen) {
        y = y1 + drop * smooth(s / jumpLen) + 0.06 * drop * Math.sin(Math.PI * s / jumpLen);
        foam = Math.max(foam0, fr1 > 1.7 ? clamp(q / 0.25, 0, 1) : foam0);
        rough = 1;
      } else {
        const s2 = s - jumpLen;
        y = basin + 0.05 * drop * Math.exp(-s2 / 14) * Math.cos(s2 / 2.2);
        foam = foam0 * Math.exp(-s2 / fadeLen);
        rough = clamp(0.25 + foam, 0, 1);
      }
      if (plunge > 0) foam = Math.max(foam, plunge * Math.exp(-(zGateDn - z) / 9));
      if (z <= zEnd) {
        // over the end sill and down to the tail
        const u = smooth((zEnd - z) / dropLen);
        const fall = basin - T;
        y = T + (y - T) * (1 - u);
        if (fall > 0.05) {
          const spill = clamp(0.12 + 0.4 * fall, 0, 0.8) * clamp(qAll / 0.25, 0, 1) * Math.exp(-Math.max(0, zEnd - dropLen - z) / (6 + 6 * fall));
          foam = Math.max(foam, spill * smooth((zEnd - z) / (0.4 * dropLen)));
          rough = Math.max(rough, foam);
        }
      }
    }
    const depth = y - fl;
    o.y[i] = y;
    o.depth[i] = depth;
    o.v[i] = qAll > 0 ? clamp(qAll / Math.max(depth, 0.06), 0, 16) : 0;
    o.foam[i] = clamp(foam, 0, 1);
    o.rough[i] = clamp(rough, 0, 1);
  }
  o.toe = flowing ? toe : null;
  o.drop = drop;
  o.basin = basin;
  o.regime = regime;
  o.over = qOver;
  o.leafTop = leafTop;
  o.fr1 = fr1;
  o.fadeLen = fadeLen;
  return o;
}

// a quick estimate of the flow through a bay from its opening, for pages that run the model without the engine
// (the dev page): an orifice under the leaf, capped by the open bay's crest flow, cut by a drowned tail
export function estimateFlow({ a, width, H, T, sill, mu = 0.6, cd = 1.0 }) {
  const h1 = H - sill;
  if (!(a > 0) || !(h1 > 0)) return 0;
  const h2 = Math.max(0, T - sill);
  if (h2 >= h1) return 0;
  const open = cd * (2 / 3) * Math.sqrt((2 / 3) * G) * width * Math.pow(h1, 1.5);
  const under = mu * Math.min(a, h1) * width * Math.sqrt(2 * G * h1);
  const k = h2 > 0.67 * h1 ? Math.sqrt((h1 - h2) / (0.33 * h1)) : 1;
  return Math.min(open, under) * k;
}
