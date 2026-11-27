// Bendung Perjaya 3D model: concrete and deck works (lane b08).
// Frame (model): metres, +X along the axis from the left (west) bank to the right (east) bank, +Y up with y = project
// EL (the model's origin is the axis centre at EL 0), +Z upstream (south: the river runs south to north, CONTRACT A1).
// Every size comes from the normalised parameters P (weir.json via weir.js); the few shape choices that no source
// gives (wall batter, nose taper, girder layout) are named SHAPE below and are drawing choices, not facts.
import { merge, slab, prismXZ, prismZY, pierPlan, worldUV } from './parts.js';

// SHAPE: positions across the deck band (z, m), chosen so road, gate slot and towers fit the 12 m band read on
// the aerial: road on the downstream half, gate slot and tower pillars on the upstream half.
export function bandLayout(P) {
  const half = P.bandW / 2;
  const zRoad0 = -half, zRoad1 = -half + P.roadW;           // road deck
  const zGate = half - 2;                                    // gate slot centre line
  const zHouse0 = zGate - P.tower[1] / 2 - 1, zHouse1 = zHouse0 + P.tower[1]; // hoist house along the flow
  const zPierTail = -half - 2, zPierNose = half + 3.5;       // pier plan ends (with nose and tail tapers)
  const houseFloor = P.deckEl + P.towerH * 0.55, houseTop = P.deckEl + P.towerH;
  return { zRoad0, zRoad1, zGate, zHouse0, zHouse1, zPierTail, zPierNose, houseFloor, houseTop,
    zUp: zPierNose + 14, zDown: -(P.maxBasin + 8) };
}

// Section of the floor under one bay: apron, sill (gate seat), glacis, stilling basin, end sill, back to the bed.
function floorSection(P, B, L) {
  const base = P.basinFloor - 1.6, bed = P.riverbed, crest = B.sill_el, floor = P.basinFloor;
  const zc0 = L.zGate + 2.2, zc1 = L.zGate - 1.2;            // SHAPE: crest length around the gate seat
  const zUpToe = zc0 + Math.max(1, (crest - bed) * 1.5);       // SHAPE: upstream face 1:1.5
  const zGlToe = zc1 - Math.max(1, (crest - floor) * 1.6);     // SHAPE: glacis 1:1.6
  const zEnd = -B.basin_len, es = B.end_sill;
  const pts = [
    [L.zUp, base], [L.zUp, bed], [zUpToe, bed], [zc0, crest], [zc1, crest], [zGlToe, floor],
    [zEnd + es * 1.2 + 1.2, floor], [zEnd + 1.2, floor + es], [zEnd, floor + es], [zEnd - es * 1.0, Math.max(bed, floor + 0.2)],
    [zEnd - 6, Math.max(bed, floor + 0.2)], [zEnd - 6, base],
  ];
  return { pts, zGlToe, zEnd, zCrestUp: zc0, zSillUp: zEnd + es * 1.2 + 1.2 };
}

export function buildCivil(THREE, P, mats) {
  const L = bandLayout(P);
  const concrete = [], dark = [], roof = [], glass = [], asphalt = [], rail = [];
  const X = (xj) => xj - P.length / 2; // weir.json x (from the left abutment face) to model x

  // floors, one extrusion per bay, running under half of each neighbouring pier
  const basinEnds = [];
  const sections = []; // the floor section of every bay, for the water that runs over it (weir/flow.js)
  P.bays.forEach((B, i) => {
    const x0 = i === 0 ? X(0) : X(B.x_left) - P.pierW / 2 - 0.01;
    const x1 = i === P.bays.length - 1 ? X(P.length) : X(B.x_left + B.width) + P.pierW / 2;
    const sec = floorSection(P, B, L);
    dark.push(prismZY(THREE, sec.pts, x0, x1));
    basinEnds.push(sec.zEnd);
    sections.push(sec);
    // baffle blocks on the basin floor (SHAPE: a row a third of the way down the basin)
    const zb = sec.zGlToe + (sec.zEnd - sec.zGlToe) * 0.33, n = Math.floor(B.width / 2.5);
    for (let k = 0; k < n; k++) {
      const xc = X(B.x_left) + (B.width * (k + 0.5)) / n;
      concrete.push(prismZY(THREE, [[zb + 0.6, P.basinFloor], [zb - 0.6, P.basinFloor], [zb - 0.6, P.basinFloor + 0.9], [zb + 0.1, P.basinFloor + 0.9]], xc - 0.45, xc + 0.45));
    }
  });

  // piers: tapered, rounded noses upstream, gate slots on both faces, from the floor to the deck
  const pierXs = P.piers.map(X);
  for (const x of pierXs) {
    concrete.push(prismXZ(THREE, pierPlan(x, P.pierW, L.zPierTail, L.zPierNose, P.nose, L.zGate), P.basinFloor - 0.5, P.deckEl));
  }

  // abutments with their wing walls (SHAPE: 45 degree flares, 1.4 m walls)
  const wallTop = P.dhwl + 1.5, t = 1.4, flare = 14;
  for (const side of [-1, 1]) {
    const xi = side < 0 ? X(P.abutL) : X(P.length - P.abutR); // abutment face on the river side
    const xo = side < 0 ? X(0) : X(P.length);                    // its back, against the bank
    const a0 = Math.min(xo, xi), a1 = Math.max(xo, xi);
    concrete.push(prismXZ(THREE, [[a0, L.zPierTail - 1], [a1, L.zPierTail - 1], [a1, L.zPierNose - 1], [a0, L.zPierNose - 1]], P.basinFloor - 0.5, P.deckEl));
    const w0 = side < 0 ? xi - t : xi, w1 = side < 0 ? xi : xi + t; // walls stand on the bank side of the face line
    // SHAPE: on the right (east) bank the intake (lane b09, from about 21 m upstream) and the fish ladder (from 20 m
    // upstream, about 6.5 m east of the abutment face) take the bank, so the right upstream wall stops at 20 m
    // and returns east along the bank to meet the fish ladder; the left wall flares into the bank at 45 degrees.
    const zU = side > 0 ? Math.min(L.zUp - 2, 20) : L.zUp - 2;
    concrete.push(prismXZ(THREE, [[w0, L.zPierNose - 1], [w1, L.zPierNose - 1], [w1, zU], [w0, zU]], P.basinFloor - 0.5, wallTop));
    if (side < 0) {
      concrete.push(prismXZ(THREE, [[xi, zU], [xi + side * t, zU - t * 0.4], [xi + side * (flare + t), zU + flare], [xi + side * flare, zU + flare + t * 0.4]], P.riverbed - 1, wallTop));
    } else {
      concrete.push(prismXZ(THREE, [[w0, zU - t], [xi + 6.4, zU - t], [xi + 6.4, zU], [w0, zU]], P.riverbed - 1, wallTop));
    }
    const zD = Math.min(...basinEnds) - 4;
    concrete.push(prismXZ(THREE, [[w0, zD], [w1, zD], [w1, L.zPierTail - 1], [w0, L.zPierTail - 1]], P.basinFloor - 0.5, wallTop - 0.5));
    concrete.push(prismXZ(THREE, [[xi, zD], [xi + side * flare, zD - flare], [xi + side * (flare + t), zD - flare + t * 0.4], [xi + side * t, zD + t * 0.4]], P.riverbed - 1, wallTop - 0.5));
  }

  // divide wall between the flood bays and the sluice bays, upstream and downstream (lengths from weir.json)
  if (P.divide) {
    const xd = X(P.divide.x), h = 0.6;
    const zu = Math.max(L.zPierNose + 1, P.divide.up), zd = -Math.max(-L.zPierTail + 1, P.divide.down);
    const endRound = (zEnd, dir) => { const pts = []; for (let k = 0; k <= 6; k++) { const a = Math.PI * (k / 6); pts.push([xd - h * Math.cos(a), zEnd + dir * h * Math.sin(a)]); } return pts; };
    concrete.push(prismXZ(THREE, [[xd - h, L.zPierNose - 2], ...endRound(zu, 1), [xd + h, L.zPierNose - 2]], P.basinFloor - 0.5, P.divide.top));
    concrete.push(prismXZ(THREE, [[xd - h, L.zPierTail + 1], ...endRound(zd, -1), [xd + h, L.zPierTail + 1]], P.basinFloor - 0.5, Math.min(P.divide.top, P.dhwl)));
  }

  // road deck (service bridge) across the whole weir and onto both banks, with girders, kerbs and railings
  const xa = X(0) - 8, xb = X(P.length) + 8;
  concrete.push(slab(THREE, xa, P.deckEl - 0.6, L.zRoad0, xb, P.deckEl, L.zRoad1));
  for (const zg of [L.zRoad0 + 0.9, (L.zRoad0 + L.zRoad1) / 2, L.zRoad1 - 0.9]) {
    concrete.push(slab(THREE, xa, P.deckEl - 1.5, zg - 0.35, xb, P.deckEl - 0.6, zg + 0.35));
  }
  asphalt.push(slab(THREE, xa, P.deckEl, L.zRoad0 + 0.5, xb, P.deckEl + 0.04, L.zRoad1 - 0.5));
  for (const zk of [L.zRoad0 + 0.25, L.zRoad1 - 0.25]) concrete.push(slab(THREE, xa, P.deckEl, zk - 0.25, xb, P.deckEl + 0.25, zk + 0.25));

  // tower pillars (both sides of the gate slot) and hoist houses on every pier and on both abutments
  const towerXs = [X(P.abutL / 2), ...pierXs, X(P.length - P.abutR / 2)];
  const tw = P.tower[0];
  for (const x of towerXs) {
    const pw = Math.min(P.pierW, 3.2) / 2;
    concrete.push(slab(THREE, x - pw, P.deckEl, L.zGate + 0.3, x + pw, L.houseFloor, L.zHouse1 - 0.3));
    concrete.push(slab(THREE, x - pw, P.deckEl, L.zRoad1 + 0.2, x + pw, L.houseFloor, L.zGate - 0.3));
    concrete.push(slab(THREE, x - tw / 2 - 0.1, L.houseFloor - 0.45, L.zHouse0 - 0.1, x + tw / 2 + 0.1, L.houseFloor, L.zHouse1 + 0.1)); // floor slab
    concrete.push(slab(THREE, x - tw / 2, L.houseFloor, L.zHouse0, x + tw / 2, L.houseTop, L.zHouse1));     // house walls
    roof.push(slab(THREE, x - tw / 2 - 0.45, L.houseTop, L.zHouse0 - 0.45, x + tw / 2 + 0.45, L.houseTop + 0.35, L.zHouse1 + 0.45));
    roof.push(slab(THREE, x - 0.9, L.houseTop + 0.35, L.zGate - 1.2, x + 0.9, L.houseTop + 0.95, L.zGate + 0.6)); // hoist machine cover
    const wy0 = L.houseFloor + 0.9, wy1 = L.houseTop - 0.6; // window bands on all four faces
    glass.push(slab(THREE, x - tw / 2 + 0.6, wy0, L.zHouse1, x + tw / 2 - 0.6, wy1, L.zHouse1 + 0.04));
    glass.push(slab(THREE, x - tw / 2 + 0.6, wy0, L.zHouse0 - 0.04, x + tw / 2 - 0.6, wy1, L.zHouse0));
    for (const s of [-1, 1]) {
      glass.push(slab(THREE, x + s * tw / 2, wy0, L.zHouse0 + 2.6, x + s * (tw / 2 + 0.04), wy1, L.zHouse1 - 0.8));
      // door onto the hoist deck walkway
      glass.push(slab(THREE, x + s * tw / 2, L.houseFloor, L.zHouse0 + 0.7, x + s * (tw / 2 + 0.05), L.houseFloor + 2.1, L.zHouse0 + 1.7));
      for (const zc of [L.zHouse0, L.zHouse1]) { // corner pilasters standing proud of the walls
        concrete.push(slab(THREE, x + s * (tw / 2 - 0.35), L.houseFloor, zc - 0.2, x + s * (tw / 2 + 0.15), L.houseTop, zc + 0.2));
      }
    }
    concrete.push(slab(THREE, x - tw / 2 - 0.12, L.houseFloor + 0.55, L.zHouse0 - 0.12, x + tw / 2 + 0.12, L.houseFloor + 0.75, L.zHouse1 + 0.12)); // sill band
    // lamp post on the downstream kerb above each pier
    const zl = L.zRoad0 + 0.3, ly = P.deckEl + 0.25;
    const pole = new THREE.CylinderGeometry(0.07, 0.1, 7, 6); pole.translate(x, ly + 3.5, zl); roof.push(pole);
    roof.push(slab(THREE, x - 0.05, ly + 6.85, zl, x + 0.05, ly + 6.95, zl + 1.6));
    roof.push(slab(THREE, x - 0.18, ly + 6.7, zl + 1.3, x + 0.18, ly + 6.9, zl + 1.9));
  }

  // hoist deck: a walkway joining the house floors over the bays
  const zw0 = L.zHouse0 + 0.4, zw1 = zw0 + 1.6;
  concrete.push(slab(THREE, towerXs[0], L.houseFloor - 0.35, zw0, towerXs[towerXs.length - 1], L.houseFloor, zw1));

  // railings: posts as one instanced mesh, rails merged
  const posts = [];
  const H = P.railH;
  const railLine = (x0, x1, z, y) => {
    for (let x = x0; x <= x1; x += 2) posts.push([x, y, z]);
    rail.push(slab(THREE, x0, y + H - 0.06, z - 0.04, x1, y + H, z + 0.04));
    rail.push(slab(THREE, x0, y + H * 0.5 - 0.03, z - 0.03, x1, y + H * 0.5 + 0.03, z + 0.03));
  };
  railLine(xa, xb, L.zRoad0 + 0.15, P.deckEl + 0.25);
  railLine(xa, xb, L.zRoad1 - 0.15, P.deckEl + 0.25);
  railLine(towerXs[0], towerXs[towerXs.length - 1], zw0 + 0.05, L.houseFloor);
  railLine(towerXs[0], towerXs[towerXs.length - 1], zw1 - 0.05, L.houseFloor);

  const group = new THREE.Group();
  group.name = 'weir-civil';
  const mesh = (geos, mat, uv) => {
    if (!geos.length) return;
    const g = merge(THREE, geos);
    if (uv) worldUV(g, uv);
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
  };
  mesh(concrete, mats.concrete, 7);
  mesh(dark, mats.concreteDark, 9);
  mesh(roof, mats.roof);
  mesh(glass, mats.glass);
  mesh(asphalt, mats.asphalt);
  mesh(rail, mats.rail);
  const pg = new THREE.BoxGeometry(0.08, H, 0.08);
  pg.translate(0, H / 2, 0);
  const inst = new THREE.InstancedMesh(pg, mats.rail, posts.length);
  const m4 = new THREE.Matrix4();
  posts.forEach(([x, y, z], i) => inst.setMatrixAt(i, m4.makeTranslation(x, y, z)));
  inst.castShadow = true;
  group.add(inst);
  return { group, layout: L, towerXs, pierXs, X, basinEnds, sections };
}
