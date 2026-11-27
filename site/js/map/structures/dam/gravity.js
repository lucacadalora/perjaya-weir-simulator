// The concrete gravity dam: non-overflow monoliths fitted section by section to the ground (near-vertical upstream
// face with a batter at the heel, downstream face 0.8 on 1, monolith joints every 15 m, lift lines, a crest road
// between parapets), and a gated spillway over the river: radial gates between round-nosed piers, a hoist deck with
// housings, a road bridge, a stepped downstream face ending in a flip bucket that throws a jet when spilling.
// Owner: lane b24. Look constants (freeboard, gate height, step height, bucket radius) are rules of thumb.

import { solveSide, MeshBag, wallAlong } from './section.js';
import { runX, railing, lamps, pier, deck } from './parts.js';
import { flowSheet, jet, spray } from './water.js';

const DSL = 0.8; // downstream face, horizontal per vertical
const BLOCK = 15; // monolith width (m)

export function buildGravity(THREE, P, mats, tex) {
  const { G, Ys, xDeep } = P;
  const group = new THREE.Group();
  group.name = 'dam-gravity';
  const hg = Math.min(12, Math.max(3, 0.12 * Ys)); // gate height
  const Hc = Ys + Math.min(3, Math.max(1.5, 0.04 * Ys));
  const wc = P.crest_width_m > 0 ? P.crest_width_m : Math.min(12, Math.max(6, 0.06 * Ys + 5));
  const yO = Ys - hg; // ogee crest

  const keyEnd = (dir) => {
    let x = xDeep;
    for (let i = 0; i < 6000; i++, x += dir) if (G(x, 0) >= Hc + 0.5) return x + dir * 3;
    return x;
  };
  const xStart = keyEnd(-1), xEnd = keyEnd(+1);

  // spillway bays centred on the river
  const nb = Math.max(1, Math.round(P.spill_width_m / 14));
  let b = P.spill_width_m / nb;
  const tp = Math.min(3.5, Math.max(2, 0.2 * b));
  let Wtot = nb * b + (nb + 1) * tp;
  const room = (xEnd - xStart) * 0.8;
  if (Wtot > room) { b = Math.max(4, (room - (nb + 1) * tp) / nb); Wtot = nb * b + (nb + 1) * tp; }
  let xs0 = xDeep - Wtot / 2;
  xs0 = Math.max(xStart + 4, Math.min(xEnd - 4 - Wtot, xs0));
  const xs1 = xs0 + Wtot;
  const W = nb * b;

  // ---- non-overflow monoliths ----
  const Yb = 0.35 * Hc;
  const upT = [{ z: wc / 2, y: Hc, v: 0 }, { z: wc / 2, y: Yb, v: 0 }, { z: wc / 2 + 0.05 * (Yb + 40), y: -40, v: 0 }];
  const Yk = Hc - Math.max(2, 0.9 * wc);
  const dnT = [{ z: -wc / 2, y: Hc, v: 0 }, { z: -wc / 2, y: Yk, v: 0 }, { z: -wc / 2 - DSL * (Yk + 40), y: -40, v: 0 }];
  const bands = ['conc', 'conc', 'conc', 'conc', 'crestEdge', 'road', 'crestEdge', 'conc', 'conc', 'conc', 'conc'];
  const sh = 0.7;
  const bag = new MeshBag();
  const pieces = [[xStart, xs0], [xs1, xEnd]];
  for (const [x0, x1] of pieces) {
    if (!(x1 - x0 > 0.5)) continue;
    const n = Math.max(2, Math.ceil((x1 - x0) / Math.min(10, Math.max(3, (xEnd - xStart) / 80))) + 1);
    const secs = [];
    for (let i = 0; i < n; i++) {
      const x = x0 + ((x1 - x0) * i) / (n - 1);
      const U = solveSide(upT, x, G).reverse();
      const D = solveSide(dnT, x, G);
      secs.push({ x, pts: [...U, { z: wc / 2 - sh, y: Hc, v: 0 }, { z: -(wc / 2 - sh), y: Hc, v: 0 }, ...D] });
    }
    bag.strips(secs, bands, (key, x, p) => {
      if (key === 'road') return [x / 12, (wc / 2 - sh - p.z) / (wc - 2 * sh)];
      if (key === 'crestEdge') return [x / 8, p.z / 8];
      return [(x - xStart) / BLOCK, p.y / BLOCK + (p.z > 0 ? 0 : 0.5)];
    });
    for (const z of [wc / 2 - 0.2, -(wc / 2 - 0.2)]) {
      const m = runX(THREE, x0, x1, z, Hc, 0.4, 1.1, mats.concretePlain); // parapets
      if (m) group.add(m);
    }
    lamps(THREE, group, x0, x1, -(wc / 2 - 0.2), Hc + 1.1, { step: 40, toward: 1, material: mats.steel, lampMaterial: mats.lamp });
  }

  // ---- the spillway section: ogee, stepped face, flip bucket ----
  const Rg = 1.25 * hg;
  const yTr = yO + 0.55 * hg;
  const zS = wc / 2 + 0.9 * Rg + 1.5; // gate sill, upstream of the road
  const zTr = zS - Math.sqrt(Rg * Rg - (yTr - yO) ** 2);
  const zU = zS + 2.5; // upstream face of the spillway block
  const Gmin = (z) => Math.min(G(xs0, z), G((xs0 + xs1) / 2, z), G(xs1, z));
  const prof = [];
  prof.push({ z: zU, y: Gmin(zU) - 3, k: 'face' }, { z: zU, y: yO - 0.8, k: 'face' }, { z: zU - 0.6, y: yO - 0.2, k: 'crest' },
    { z: zS, y: yO, k: 'crest' });
  // ogee y = yO - K t^1.85 down to the tangent with the 0.8 on 1 face
  const K = 0.5 / Math.pow(hg, 0.85);
  const tT = Math.pow(1 / DSL / (1.85 * K), 1 / 0.85);
  for (let i = 1; i <= 6; i++) { const t = (tT * i) / 6; prof.push({ z: zS - t, y: yO - K * Math.pow(t, 1.85), k: 'ogee' }); }
  const zT = zS - tT, yT = yO - K * Math.pow(tT, 1.85);
  // flip bucket: invert just above the ground at its place (found by iteration), lip at 30 degrees
  const R = Math.min(15, Math.max(5, 0.12 * Ys));
  const pf = Math.atan(1 / DSL), lip = (30 * Math.PI) / 180;
  let yInv = 2, zC = zT;
  for (let it = 0; it < 4; it++) {
    const yC = yInv + R, yTa = yC - R * Math.cos(pf);
    const zTa = zT - DSL * (yT - yTa);
    zC = zTa - R * Math.sin(pf);
    yInv = Math.min(yT - 2, Gmin(zC) + 1.2);
  }
  const yC = yInv + R;
  const yTa = yC - R * Math.cos(pf), zTa = zT - DSL * (yT - yTa);
  // steps from the tangent of the ogee down to the bucket
  const hs = Math.min(1.2, Math.max(0.6, Ys / 60));
  let zz = zT, yy = yT;
  const steps = [];
  while (yy - hs > yTa + 0.2) {
    zz -= DSL * hs; prof.push({ z: zz, y: yy, k: 'step' });
    yy -= hs; prof.push({ z: zz, y: yy, k: 'step' });
    steps.push({ z: zz, y: yy });
  }
  prof.push({ z: zTa, y: yTa, k: 'step' });
  for (let i = 1; i <= 8; i++) {
    const a = -pf + ((pf + lip) * i) / 8;
    prof.push({ z: zC - R * Math.sin(a), y: yC - R * Math.cos(a), k: 'bucket' });
  }
  const zLip = zC - R * Math.sin(lip), yLip = yC - R * Math.cos(lip);
  prof.push({ z: zLip - 1.2, y: yLip, k: 'lip' }, { z: zLip - 1.6, y: Gmin(zLip - 1.6) - 3, k: 'lip' });
  let s = 0;
  for (let i = 0; i < prof.length - 1; i++) {
    const p = prof[i], q = prof[i + 1];
    const ds = Math.hypot(q.z - p.z, q.y - p.y);
    bag.quad('spill', [xs0, p.y, p.z, xs0 / BLOCK, p.y / BLOCK], [xs1, p.y, p.z, xs1 / BLOCK, p.y / BLOCK],
      [xs1, q.y, q.z, xs1 / BLOCK, q.y / BLOCK], [xs0, q.y, q.z, xs0 / BLOCK, q.y / BLOCK]);
    s += ds;
  }
  const profAt = (z) => {
    for (let i = 0; i < prof.length - 1; i++) {
      const a = prof[i], c = prof[i + 1];
      if (z <= a.z && z >= c.z) return a.z === c.z ? Math.max(a.y, c.y) : a.y + ((c.y - a.y) * (z - a.z)) / (c.z - a.z);
    }
    return prof[prof.length - 1].y;
  };
  // training walls down both sides of the spillway, to the lip
  const wallPts = (x, xo) => {
    const pts = [];
    let v = 0;
    for (let z = -wc / 2 - 3; z > zLip - 1.2; z -= 2) {
      pts.push({ x, z, yBot: Math.min(profAt(z), G(xo, z)) - 2, yTop: profAt(z) + 3.2, v });
      v += 2;
    }
    pts.push({ x, z: zLip - 1.2, yBot: Math.min(yLip, G(xo, zLip)) - 2, yTop: yLip + 3.2, v });
    return pts;
  };
  wallAlong(bag, 'spillWall', wallPts(xs0 + tp / 2, xs0 - 2), tp / 2, -1, BLOCK);
  wallAlong(bag, 'spillWall', wallPts(xs1 - tp / 2, xs1 + 2), tp / 2, +1, BLOCK);

  // piers: full length up to the road, the upstream part up to the hoist deck
  const yHoist = Ys + 0.8 * hg + 2.5;
  const pierBot = Math.min(profAt(-wc / 2 - 3), yO) - 1;
  const bayX = [];
  for (let i = 0; i <= nb; i++) {
    const xc = xs0 + tp / 2 + i * (b + tp);
    group.add(pier(THREE, xc, tp, -wc / 2 - 3, zS + 3.5, pierBot, Hc - 0.9, mats.pier));
    group.add(pier(THREE, xc, tp, zTr - 1.6, zS + 3.5, Hc - 0.95, yHoist, mats.pier));
    if (i < nb) bayX.push(xc + tp / 2 + b / 2);
  }
  deck(THREE, group, xs0, xs1, -wc / 2, wc / 2, Hc, { concrete: mats.concretePlain, asphalt: mats.road });
  railing(THREE, group, xs0, xs1, wc / 2 - 0.2, Hc, { step: 2, h: 1.0, material: mats.steel });
  railing(THREE, group, xs0, xs1, -wc / 2 + 0.2, Hc, { step: 2, h: 1.0, material: mats.steel });
  // hoist deck with a housing over each bay
  const hd = new THREE.Mesh(new THREE.BoxGeometry(Wtot, 0.8, zS + 3 - (zTr - 1.4)), mats.concretePlain);
  hd.position.set((xs0 + xs1) / 2, yHoist + 0.4, (zS + 3 + zTr - 1.4) / 2);
  group.add(hd);
  railing(THREE, group, xs0, xs1, zTr - 1.2, yHoist + 0.8, { step: 2, h: 1.0, material: mats.steel });
  for (const x of bayX) {
    const hw = Math.min(b * 0.6, 7), hdp = Math.min(4.5, zS + 2.5 - zTr);
    const house = new THREE.Mesh(new THREE.BoxGeometry(hw, 2.8, hdp), mats.house);
    house.position.set(x, yHoist + 0.8 + 1.4, zS + 0.5 - hdp / 2 + 1);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(hw + 0.6, 0.25, hdp + 0.6), mats.roof);
    roof.position.set(x, yHoist + 0.8 + 2.9, house.position.z);
    group.add(house, roof);
  }

  // radial gates: a curved skin plate on two arms, turning about trunnions on the piers
  const bot = Math.atan2(yO - yTr, zS - zTr);
  const yTop = Ys + 0.3;
  const zTop = zTr + Math.sqrt(Math.max(1, Rg * Rg - (yTop - yTr) ** 2));
  const top = Math.atan2(yTop - yTr, zTop - zTr);
  const gates = [];
  for (const x of bayX) {
    const g = new THREE.Group();
    g.position.set(x, yTr, zTr);
    // cylinder points are (r sin th, y, r cos th); turned about Z the axis runs along X and th is the angle from +z
    // toward +y in the z-y plane, so the plate spans th = bot (sill) to th = top
    const skin = new THREE.CylinderGeometry(Rg, Rg, b - 0.25, 12, 1, true, bot, top - bot);
    skin.rotateZ(Math.PI / 2);
    const sm = new THREE.Mesh(skin, mats.gate);
    g.add(sm);
    const mid = (bot + top) / 2;
    for (const sx of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.55, Rg), mats.gate);
      arm.position.set(sx * (b / 2 - 0.9), Math.sin(mid) * Rg / 2, Math.cos(mid) * Rg / 2);
      arm.rotation.x = -mid;
      g.add(arm);
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.6, 10), mats.steel);
      pin.rotation.z = Math.PI / 2;
      pin.position.set(sx * (b / 2 - 0.3), 0, 0);
      g.add(pin);
    }
    group.add(g);
    gates.push(g);
  }

  const tris = bag.build(THREE, mats, group);

  // ---- white water: over the crest and down the steps, then the jet off the bucket ----
  const wpath = [{ z: zS + 1.5, y: yO }, ...prof.filter((p) => p.k === 'crest' || p.k === 'ogee'),
    ...steps.map((p) => ({ z: p.z, y: p.y })), ...prof.filter((p) => p.k === 'bucket')];
  const sheet = flowSheet(THREE, {
    x0: xs0 + tp + 0.05, x1: xs1 - tp - 0.05, path: wpath,
    depthOf: (q, i) => (i < 2 ? Math.pow(q / (1.7 * W), 2 / 3) : Math.max(0.35, Math.min(3, q / (W * 9)) + hs * 0.5)),
  }, mats.foam);
  const xc = (xs0 + xs1) / 2;
  const jt = jet(THREE, { x0: xs0 + tp, x1: xs1 - tp, zLip, yLip, yHead: Ys, lipDeg: 30, G, xc }, mats.foam);
  const sp = spray(THREE, { count: 180 });
  group.add(sheet.mesh, jt.mesh, sp.points);
  return {
    group, tris: tris + nb * 300 + 1500,
    info: { kind: 'gravity', dam_crest_y: Hc, spill_crest_y: yO, gate_top_y: yTop, crest_width_m: wc, x_start: xStart,
      x_end: xEnd, spill_x: [xs0, xs1], bays: nb, bay_m: b, lip: { z: zLip, y: yLip } },
    setSpill(q) {
      const qFull = 1.7 * W * Math.pow(hg, 1.5);
      const r = q > 0 ? 0.12 + 0.88 * Math.min(1, q / qFull) : 0;
      for (const g of gates) g.rotation.x = -(r * hg) / Rg;
      sheet.set(q);
      const d = Math.min(3, q / (W * 9));
      jt.set(q, d);
      const L = jt.landing;
      sp.set(q, { x0: xs0, x1: xs1, z0: L.z - 15, z1: L.z + 10, y: L.y, h: 4 + Math.min(14, q / 120), size: 3 + Math.min(5, W / 12) });
      mats.foam.opacity = q > 0 ? Math.min(0.95, 0.6 + q / 500) : 0;
    },
    update(dt) {
      tex.foam.offset.y -= dt * 1.4;
      sp.update(dt);
    },
  };
}
