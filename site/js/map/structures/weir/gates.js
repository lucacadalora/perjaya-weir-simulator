// Bendung Perjaya 3D model: gate leaves (lane b08).
// Gate type (decided from the seven reference pictures, see weir.js header): VERTICAL-LIFT ROLLER GATES with a
// low flap on top of each flood gate, lifted by the hoists in the towers on every pier. The scouring sluice bays
// carry two leaves stacked in one slot (the scouring sluice over the under-sluice) that lift together.
//
// Leaf frame: origin at the bay centre on the axis line of the slot, y = 0 at the leaf's bottom edge, +Z upstream.
import { merge, slab } from './parts.js';

const SKIN_Z = 0.4;   // upstream skin plate face (m from the slot centre line) - shape, not a researched number
const DOWN_Z = -0.46; // downstream girder flange line
const SLOT_IN = 0.3;  // how far each leaf end runs into the pier slot

function leafParts(THREE, w, h, y0, withTop) {
  const W = w + 2 * SLOT_IN, half = w / 2, skin = [], blue = [], red = [];
  skin.push(slab(THREE, -W / 2, y0, SKIN_Z - 0.06, W / 2, y0 + h, SKIN_Z));
  const n = Math.max(2, Math.ceil(h / 0.95)); // horizontal girders behind the skin
  for (let i = 0; i < n; i++) {
    const yi = y0 + (h * (i + 0.5)) / n;
    blue.push(slab(THREE, -half, yi - 0.05, DOWN_Z + 0.06, half, yi + 0.05, SKIN_Z - 0.06));
    blue.push(slab(THREE, -half, yi - 0.2, DOWN_Z, half, yi + 0.2, DOWN_Z + 0.06));
  }
  const nv = Math.max(3, Math.round(w / 2.6)); // vertical stiffeners
  for (let i = 1; i < nv; i++) {
    const xi = -half + (w * i) / nv;
    blue.push(slab(THREE, xi - 0.04, y0, DOWN_Z + 0.06, xi + 0.04, y0 + h, SKIN_Z - 0.06));
  }
  for (const s of [-1, 1]) { // end posts carrying the rollers
    blue.push(slab(THREE, s * (half - 0.15), y0, DOWN_Z, s * (W / 2), y0 + h, SKIN_Z - 0.06));
    for (const fy of [0.22, 0.78]) {
      const r = new THREE.CylinderGeometry(0.22, 0.22, 0.16, 10);
      r.rotateZ(Math.PI / 2);
      r.translate(s * (W / 2 - 0.08), y0 + h * fy, 0);
      skin.push(r);
    }
  }
  if (withTop) red.push(slab(THREE, -half, y0 + h - 0.14, DOWN_Z, half, y0 + h, SKIN_Z));
  else blue.push(slab(THREE, -half, y0 + h - 0.12, DOWN_Z, half, y0 + h, SKIN_Z));
  return { skin, blue, red };
}

// A low flap leaf hinged on the top of the main leaf (upright = holding), with its hinge brackets.
function flapParts(THREE, w, y0, flapH) {
  const half = w / 2, red = [], blue = [];
  const R = flapH / (2 * Math.sin(Math.PI * 0.05)); // chord of the slice = flapH
  const plate = new THREE.CylinderGeometry(R, R, w, 6, 1, true, -Math.PI * 0.05, Math.PI * 0.1);
  // a gently curved upright plate (bulging upstream): a thin slice of a large cylinder lying along X
  plate.rotateZ(Math.PI / 2);
  plate.computeBoundingBox();
  const bb = plate.boundingBox;
  plate.translate(0, y0 - bb.min.y, SKIN_Z - 0.05 - bb.max.z);
  red.push(plate);
  red.push(slab(THREE, -half, y0 + flapH - 0.08, SKIN_Z - 0.4, half, y0 + flapH, SKIN_Z - 0.02)); // top lip
  const nb = Math.max(3, Math.round(w / 4));
  for (let i = 0; i <= nb; i++) {
    const xi = -half + 0.3 + ((w - 0.6) * i) / nb;
    blue.push(slab(THREE, xi - 0.05, y0, SKIN_Z - 0.45, xi + 0.05, y0 + flapH * 0.9, SKIN_Z - 0.08));
  }
  return { red, blue };
}

// Returns a builder: make() gives a fresh Group sharing geometry; the group's y is set by the caller.
export function gateFactory(THREE, mats, { width, height, underHeight = 0, flapH = 0 }) {
  const skin = [], blue = [], red = [];
  const add = (p) => { skin.push(...(p.skin || [])); blue.push(...(p.blue || [])); red.push(...(p.red || [])); };
  if (underHeight > 0) {
    add(leafParts(THREE, width, underHeight, 0, false)); // under-sluice leaf
    add(leafParts(THREE, width, height, underHeight + 0.02, true)); // scouring sluice leaf on top
  } else {
    add(leafParts(THREE, width, height, 0, true));
    if (flapH > 0) add(flapParts(THREE, width, height, flapH));
  }
  const geo = { skin: merge(THREE, skin), blue: merge(THREE, blue), red: red.length ? merge(THREE, red) : null };
  const total = underHeight + height + flapH;
  return {
    height: total,
    make() {
      const g = new THREE.Group();
      g.name = 'gate-leaf';
      const m1 = new THREE.Mesh(geo.skin, mats.steelSkin);
      const m2 = new THREE.Mesh(geo.blue, mats.steelBlue);
      g.add(m1, m2);
      if (geo.red) g.add(new THREE.Mesh(geo.red, mats.gateTop));
      g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      return g;
    },
  };
}
