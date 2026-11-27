// The embankment dam: a rockfill/earthfill bank fitted section by section to the ground, with a crest road between
// kerbs and a wave wall, a riprap upstream face (1 on 3), a grassed downstream face (1 on 2.5) with berms, a rock toe,
// and a chute spillway on one abutment (ogee crest under a road bridge, chute between training walls, stilling basin
// with an end sill) that carries white water when the lake spills. Owner: lane b24.
// Look constants (freeboard, berm spacing, wall heights) are design-office rules of thumb, not researched values.

import { solveSide, MeshBag, wallAlong } from './section.js';
import { runX, railing, lamps, pier, deck } from './parts.js';
import { flowSheet, spray } from './water.js';

const US = 3, DS = 2.5; // face slopes, horizontal per vertical (CONTRACT brief b24)

// the downstream template from the crest edge: faces of `hb` height with berms of `wb` between
function downTemplate(wc, Hc, hb, wb, berms) {
  const t = [{ z: -wc / 2, y: Hc, v: 0 }], keys = [];
  let z = -wc / 2, y = Hc, v = 0;
  const k = Math.sqrt(1 + DS * DS);
  while (y > -40) {
    const h = berms ? Math.min(hb, y + 40) : y + 40;
    y -= h; z -= DS * h; v += h * k;
    t.push({ z, y, v }); keys.push('grass');
    if (berms && y > 4) {
      v = Math.ceil(v / 5) * 5; // berm texture starts on a tile edge (gutter on the inner side)
      t[t.length - 1] = { ...t[t.length - 1], v };
      z -= 5; v += 5;
      t.push({ z, y, v }); keys.push('berm');
    }
  }
  return { t, keys };
}

// height of the bank's surface at z (ignoring the ground): used for the spillway's retaining walls
function surfaceAt(z, wc, Hc, dn) {
  if (z >= -wc / 2) return z <= wc / 2 ? Hc : Hc - (z - wc / 2) / US;
  for (let i = 0; i < dn.length - 1; i++) {
    const a = dn[i], b = dn[i + 1];
    if (z <= a.z && z >= b.z) return a.y + ((b.y - a.y) * (z - a.z)) / (b.z - a.z || -1);
  }
  return -40;
}

export function buildEmbankment(THREE, P, mats, tex) {
  const { G, Ys, xDeep } = P;
  const group = new THREE.Group();
  group.name = 'dam-embankment';
  const FB = Math.min(4, Math.max(1.5, 0.05 * Ys));
  const Hc = Ys + FB;
  const wc = P.crest_width_m > 0 ? P.crest_width_m : Math.min(14, Math.max(6, 0.08 * Ys + 6));
  const sh = 1.0;
  const berms = Ys >= 18, hb = Ys > 45 ? 15 : 10, wb = 5;

  // where the crest keys into each hillside
  const keyEnd = (dir) => {
    let x = xDeep;
    for (let i = 0; i < 6000; i++, x += dir) if (G(x, 0) >= Hc + 0.5) return x + dir * 4;
    return x;
  };
  const xStart = keyEnd(-1), xEnd = keyEnd(+1);

  // spillway on the side with more room, its outer wall where the axis ground reaches the spill crest
  const sideB = P.xb - xDeep >= xDeep - P.xa;
  const tw = 1.2;
  let Wtot = P.spill_width_m + 2 * tw;
  const room = (sideB ? P.xb - xDeep : xDeep - P.xa) * 0.7;
  if (Wtot > room) Wtot = Math.max(8, room);
  const xs0 = sideB ? P.xb - Wtot : P.xa, xs1 = sideB ? P.xb : P.xa + Wtot;
  const W = Wtot - 2 * tw, xc = (xs0 + xs1) / 2;

  // ---- the bank, section by section ----
  const upT = [
    { z: wc / 2, y: Hc, v: 0 },
    { z: wc / 2 + US * FB, y: Ys, v: FB * Math.sqrt(1 + US * US) },
    { z: wc / 2 + US * (Hc + 40), y: -40, v: (Hc + 40) * Math.sqrt(1 + US * US) },
  ];
  const upKeys = ['riprap', 'riprapWet'];
  const dn = downTemplate(wc, Hc, hb, wb, berms);
  const upBands = [...upKeys, upKeys[1], upKeys[1]].reverse();
  const dnBands = [...dn.keys, dn.keys[dn.keys.length - 1], dn.keys[dn.keys.length - 1]];
  const bands = [...upBands, 'shoulder', 'road', 'shoulder', ...dnBands];
  const iToeDn = upT.length + 2 + 2 + dn.t.length; // index of the downstream toe in a full section

  const span = (x0, x1) => {
    const n = Math.max(2, Math.ceil((x1 - x0) / Math.min(14, Math.max(3, (xEnd - xStart) / 70))) + 1);
    const out = [];
    for (let i = 0; i < n; i++) out.push(x0 + ((x1 - x0) * i) / (n - 1));
    return out;
  };
  const pieces = sideB ? [[xStart, xs0], [xs1, xEnd]] : [[xStart, xs0], [xs1, xEnd]];
  const bag = new MeshBag();
  let zToeMin = 0;
  const toeRuns = [];
  const toeLine = [];
  for (const [x0, x1] of pieces) {
    if (!(x1 - x0 > 0.5)) continue;
    const secs = [];
    const toe = [];
    for (const x of span(x0, x1)) {
      const U = solveSide(upT, x, G).reverse();
      const D = solveSide(dn.t, x, G);
      const pts = [...U, { z: wc / 2 - sh, y: Hc, v: 0 }, { z: -(wc / 2 - sh), y: Hc, v: 0 }, ...D];
      secs.push({ x, pts });
      const T = pts[iToeDn];
      zToeMin = Math.min(zToeMin, T.z);
      toeLine.push({ x, z: T.z });
      // rock toe: a riprap wedge leaning on the face at the downstream toe
      const ht = Math.min(5, 0.1 * (Hc - T.y));
      if (ht >= 0.6) {
        const zb = T.z - 2 * ht;
        toe.push({ x, pts: [{ z: T.z + DS * ht, y: T.y + ht, v: 0 }, { z: T.z - 0.5 * ht, y: T.y + 0.8 * ht, v: 2.6 * ht },
          { z: zb, y: G(x, zb) - 0.6, v: 4.2 * ht }] });
      } else toe.push({ x, pts: [T, T, T] });
    }
    bag.strips(secs, bands, (key, x, p) => {
      if (key === 'road') return [x / 12, (wc / 2 - sh - p.z) / (wc - 2 * sh)];
      if (key === 'shoulder') return [x / 8, p.z / 8];
      if (key === 'berm') return [x / 8, p.v / 5];
      if (key === 'grass') return [x / 12, p.v / 12];
      return [x / 5, p.v / 5];
    });
    toeRuns.push(toe);
  }
  for (const toe of toeRuns) bag.strips(toe, ['toe', 'toe'], (key, x, p) => [x / 5, p.v / 5]);

  // ---- crest furniture: kerbs, wave wall, guard rail, lamps ----
  for (const [x0, x1] of pieces) {
    if (!(x1 - x0 > 1)) continue;
    const add = (m) => m && group.add(m);
    add(runX(THREE, x0, x1, wc / 2 - sh - 0.15, Hc, 0.3, 0.22, mats.kerb));
    add(runX(THREE, x0, x1, -(wc / 2 - sh - 0.15), Hc, 0.3, 0.22, mats.kerb));
    add(runX(THREE, x0, x1, wc / 2 - 0.25, Hc - 0.3, 0.45, 1.4, mats.concretePlain)); // wave wall
    railing(THREE, group, x0, x1, -(wc / 2 - 0.3), Hc, { step: 3, h: 0.8, material: mats.steel });
    lamps(THREE, group, x0, x1, wc / 2 - 0.25, Hc + 1.1, { step: 45, toward: -1, material: mats.steel, lampMaterial: mats.lamp });
  }

  // ---- the chute spillway: approach channel, ogee crest under the road bridge, a chute that runs down the
  // abutment along the dam's downstream toe to the river, a stilling basin with chute blocks and an end sill ----
  const st = []; // stations along the spillway: {cx, cz, y, kind}
  const yApp = Ys - 3;
  const zApp = wc / 2 + US * (Hc - yApp) + 12;
  for (let z = zApp; z > 3; z -= 6) st.push({ cx: xc, cz: z, y: yApp, kind: 'app' });
  st.push({ cx: xc, cz: 3, y: yApp, kind: 'app' }, { cx: xc, cz: 3, y: Ys - 0.9, kind: 'weir' },
    { cx: xc, cz: 2.1, y: Ys - 0.2, kind: 'weir' }, { cx: xc, cz: 1, y: Ys, kind: 'crest' }, { cx: xc, cz: 0, y: Ys, kind: 'crest' });
  for (let t = 1; t <= 4; t++) st.push({ cx: xc, cz: -t, y: Ys - 0.09 * t * t, kind: 'ogee' });
  // the chute: straight down the abutment, then a late curve (a quadratic Bezier) to the river below the toe,
  // pushed further downstream until no point of it lies on the bank's footprint
  const toeSorted = toeLine.slice().sort((p, q) => p.x - q.x);
  const toeAt = (x) => {
    if (!toeSorted.length || x < toeSorted[0].x || x > toeSorted[toeSorted.length - 1].x) return Infinity;
    for (let i = 0; i < toeSorted.length - 1; i++) {
      const p = toeSorted[i], q = toeSorted[i + 1];
      if (x >= p.x && x <= q.x) return q.x === p.x ? Math.min(p.z, q.z) : p.z + ((q.z - p.z) * (x - p.x)) / (q.x - p.x);
    }
    return Infinity;
  };
  let tx0 = sideB ? xDeep + W / 2 + tw + 8 : xDeep - W / 2 - tw - 8;
  if (sideB ? tx0 > xc : tx0 < xc) tx0 = xc;
  const z0c = -8;
  let tz0 = Math.min(zToeMin - 30, -60);
  let chute = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    chute = [];
    const L = Math.hypot(tx0 - xc, tz0 - z0c), n = Math.max(6, Math.ceil(L / 5));
    let clash = false;
    for (let i = 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      const cx = u * u * xc + 2 * t * u * xc + t * t * tx0;
      const cz = u * u * z0c + 2 * t * u * tz0 + t * t * tz0;
      chute.push({ cx, cz, kind: 'chute' });
      const ex = cx + (sideB ? -1 : 1) * (W / 2 + tw); // the river-side wall
      if (Math.abs(cx - xc) > 2 && cz > toeAt(ex) - 4) clash = true;
    }
    if (!clash) break;
    tz0 -= 40;
  }
  const zEnd = chute[chute.length - 1].cz;
  // edges across the path, and the ground under each station (highest of the edges and the centre)
  const frame = (list) => {
    for (let i = 0; i < list.length; i++) {
      const p = list[Math.max(0, i - 1)], q = list[Math.min(list.length - 1, i + 1)];
      let tx = q.cx - p.cx, tz = q.cz - p.cz;
      const L = Math.hypot(tx, tz);
      if (L < 1e-6) { tx = 0; tz = -1; } else { tx /= L; tz /= L; }
      const c = list[i];
      c.t = [tx, tz];
      c.l = [c.cx + (tz * W) / 2, c.cz - (tx * W) / 2];
      c.r = [c.cx - (tz * W) / 2, c.cz + (tx * W) / 2];
      const gl = G(c.l[0], c.l[1]), gr = G(c.r[0], c.r[1]);
      c.g = Math.max(G(c.cx, c.cz), 0.7 * Math.max(gl, gr) + 0.3 * Math.min(gl, gr)); // cut a little into a cross slope
    }
  };
  frame(chute);
  // chute floor: an even fall from the ogee to the end, never under the ground, never rising
  const y0 = Ys - 1.44;
  let Stot = 4;
  for (let i = 1; i < chute.length; i++) Stot += Math.hypot(chute[i].cx - chute[i - 1].cx, chute[i].cz - chute[i - 1].cz);
  const last = chute[chute.length - 1];
  const yEndT = last.g + 0.3;
  let sAcc = 4, prev = y0;
  for (let i = 0; i < chute.length; i++) {
    if (i) sAcc += Math.hypot(chute[i].cx - chute[i - 1].cx, chute[i].cz - chute[i - 1].cz);
    const lin = y0 + ((yEndT - y0) * sAcc) / Stot;
    chute[i].y = Math.max(Math.min(prev, Math.max(lin, chute[i].g + 0.3)), chute[i].g + 0.3);
    prev = chute[i].y;
  }
  // stilling basin along the last direction
  const Lb = Math.min(40, Math.max(18, 0.5 * W));
  const [tx, tz] = last.t;
  const at = (d, kind) => ({ cx: last.cx + tx * d, cz: last.cz + tz * d, kind });
  const basin = [at(2, 'basin'), at(Lb, 'basin'), at(Lb, 'sill'), at(Lb + 1.6, 'sill'), at(Lb + 3, 'exit'), at(Lb + 14, 'exit')];
  frame([last, ...basin]);
  const yB = Math.max(last.y - 2, basin[0].g + 0.2, basin[1].g + 0.2);
  basin[0].y = yB; basin[1].y = yB; basin[2].y = yB + 1.4; basin[3].y = yB + 1.4;
  basin[4].y = basin[4].g + 0.1; basin[5].y = basin[5].g - 0.2;
  const head = st.slice();
  frame(head);
  const path = [...head, ...chute, ...basin];
  // floor strip
  let s = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], c = path[i + 1];
    const ds = Math.hypot(c.cx - a.cx, c.cz - a.cz, c.y - a.y);
    const key = a.kind === 'exit' ? 'toe' : 'chuteFloor';
    bag.quad(key, [a.l[0], a.y, a.l[1], 0, s / 10], [a.r[0], a.y, a.r[1], W / 10, s / 10],
      [c.r[0], c.y, c.r[1], W / 10, (s + ds) / 10], [c.l[0], c.y, c.l[1], 0, (s + ds) / 10]);
    s += ds;
  }
  // training walls: at least `hw` over the floor, and as high as the bank where they hold it back
  const hw = Math.min(5, 2.5 + 0.03 * W);
  const bankTop = (x, z) => { const b = surfaceAt(z, wc, Hc, dn.t); return b > G(x, z) ? Math.min(Hc, b) + 0.3 : -99; };
  const wallPts = (edge, out) => {
    const pts = [];
    let v = 0;
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      if (i && p.kind === 'exit' && path[i - 1].kind === 'exit') break;
      const [x, z] = p[edge];
      if (i) v += Math.hypot(x - path[i - 1][edge][0], z - path[i - 1][edge][1]);
      if (pts.length && Math.abs(pts[pts.length - 1].z - z) < 0.05 && Math.abs(pts[pts.length - 1].x - x) < 0.05) {
        pts[pts.length - 1].yTop = Math.max(pts[pts.length - 1].yTop, p.y + hw); continue;
      }
      const xo = x + out * 2 * Math.abs(p.t[1]), zo = z - out * 2 * p.t[0];
      const basinTop = p.kind === 'basin' || p.kind === 'sill' || p.kind === 'exit' ? yB + hw + 1 : -99;
      pts.push({ x, z, yBot: Math.min(p.y, G(xo, zo)) - 1.5, yTop: Math.max(p.y + hw, bankTop(xo, zo), basinTop), v });
    }
    return pts;
  };
  wallAlong(bag, 'wall', wallPts('l', -1), tw, -1, 15);
  wallAlong(bag, 'wall', wallPts('r', 1), tw, 1, 15);
  // chute blocks: a row of concrete teeth where the chute enters the basin
  const nbk = Math.max(3, Math.floor(W / 2.5));
  const ib = new THREE.InstancedMesh(new THREE.BoxGeometry(W / nbk / 2, 1.0, 1.4), mats.concretePlain, nbk);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.atan2(tx, tz), 0));
  for (let i = 0; i < nbk; i++) {
    const f = (i + 0.5) / nbk - 0.5;
    M.compose(new THREE.Vector3(last.cx + tx * 5 + tz * f * W, yB + 0.5, last.cz + tz * 5 - tx * f * W), Q, new THREE.Vector3(1, 1, 1));
    ib.setMatrixAt(i, M);
  }
  ib.instanceMatrix.needsUpdate = true;
  group.add(ib);
  const floorAt = (z) => { for (const p of head) if (p.cz <= z + 0.5) return p.y; return head[head.length - 1].y; };

  // road bridge over the spillway crest, on round-nosed piers
  const ns = Math.max(1, Math.ceil(W / 14));
  for (let i = 1; i < ns; i++) {
    const x = xs0 + tw + (W * i) / ns;
    group.add(pier(THREE, x, 1.4, -wc / 2 - 1, wc / 2 + 2.5, floorAt(-4) - 0.6, Hc - 0.9, mats.concretePlain));
  }
  deck(THREE, group, xs0 - 0.5, xs1 + 0.5, -wc / 2, wc / 2, Hc, { concrete: mats.concretePlain, asphalt: mats.road });
  railing(THREE, group, xs0, xs1, wc / 2 - 0.2, Hc, { step: 2, h: 1.0, material: mats.steel });
  railing(THREE, group, xs0, xs1, -wc / 2 + 0.2, Hc, { step: 2, h: 1.0, material: mats.steel });

  const tris = bag.build(THREE, mats, group);

  // ---- white water over the crest, down the chute and boiling in the basin ----
  const wpath = path.filter((p) => p.kind !== 'app' && p.kind !== 'exit')
    .map((p) => ({ z: p.cz, y: p.y, kind: p.kind, l: p.l, r: p.r }));
  const sheet = flowSheet(THREE, {
    path: wpath, inset: 0.05,
    depthOf: (q, i) => {
      const k = wpath[i].kind;
      const h = Math.pow(q / (1.7 * W), 2 / 3); // head on the crest, for the look only
      if (k === 'weir' || k === 'crest') return Math.max(0.1, h);
      if (k === 'basin' || k === 'sill') return Math.max(0.6, 1.2 + h);
      return Math.max(0.12, q / (W * 12));
    },
  }, mats.foam);
  group.add(sheet.mesh);
  const sp = spray(THREE, { count: 140 });
  group.add(sp.points);
  const bx = [last.cx, basin[1].cx], bz = [last.cz, basin[1].cz];
  return {
    group, tris,
    info: { kind: 'embankment', dam_crest_y: Hc, spill_crest_y: Ys, crest_width_m: wc, x_start: xStart, x_end: xEnd,
      spill_x: [xs0, xs1], spill_side: sideB ? 'b' : 'a', toe_z: zToeMin, basin: { x: last.cx, z: last.cz, y: yB } },
    setSpill(q) {
      sheet.set(q);
      sp.set(q, { x0: Math.min(...bx) - W / 3, x1: Math.max(...bx) + W / 3, z0: Math.min(...bz), z1: Math.max(...bz),
        y: yB + 1.5, h: 2 + Math.min(8, q / 150), size: 2 + Math.min(4, W / 15) });
      mats.foam.opacity = q > 0 ? Math.min(0.95, 0.55 + q / 400) : 0;
    },
    update(dt) {
      tex.foam.offset.y -= dt * 0.9;
      sp.update(dt);
    },
  };
}
