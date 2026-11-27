// Weir surroundings (lane b09): houses, trees and labels for the plan, and the ground heights for everything.
import { pointInRing, distToLine, openRing, orientedRect, centroid, rng, normals, densify } from './geom.js';

const v = (leaf, fb) => (leaf && typeof leaf === 'object' && 'v' in leaf ? leaf.v : leaf ?? fb);
const R_HOUSES = 600; // the brief: real building footprints within 600 m

// INDICATIVE: the box around the operator's compound on the right bank, read from the z18 aerial (ref 03).
const COMPOUND = { x0: 108, x1: 232, z0: -130, z1: 12 };
const inCompound = (x, z) => x > COMPOUND.x0 && x < COMPOUND.x1 && z > COMPOUND.z0 && z < COMPOUND.z1;

// is (x, z) on one of our works (channels, basins, intake, ladder), with a margin in metres
export function onWorks(P, x, z, margin) {
  // the pocket of the pond in front of the intake is water (layout.js P.pocket): nothing stands in it
  const pk = P.pocket;
  if (pk && x > pk.x0 - margin && x < pk.x1 + margin && z > pk.z0 - margin && z < pk.z1 + margin) return true;
  const I = P.intake;
  if (x > I.xFace - 4 - margin && x < I.xBack + margin && z > I.z0 - margin && z < I.z1 + margin) return true;
  const L = P.ladder;
  if (Math.abs(x - L.x) < L.w / 2 + 1 + margin && z < L.z0 + margin && z > L.z1 - margin) return true;
  for (const b of P.basins) {
    if (x > b.x0 - margin && x < b.x1 + margin && z > b.zN - margin && z < b.zS + margin) return true;
  }
  for (const c of P.channels) if (distToLine(x, z, c.line) < c.hb + (c.m || 0) * 6 + 1.5 + margin) return true;
  return false;
}

export function planHouses(P, D, toXZ, inRiver) {
  P.houses = [];
  for (const f of D.buildings?.features || []) {
    const g = f.geometry;
    if (!g) continue;
    const coords = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
    if (!coords || coords.length < 4) continue;
    const p0 = toXZ(coords[0][0], coords[0][1]);
    if (Math.hypot(p0[0], p0[1]) > R_HOUSES + 60) continue;
    const ring = openRing(coords.map(([lon, lat]) => toXZ(lon, lat)));
    const [cx, cz] = centroid(ring);
    if (Math.hypot(cx, cz) > R_HOUSES) continue;
    if (Math.abs(cx) < 112 && Math.abs(cz) < 32) continue; // the weir's own hoist houses are in the footprints
    if (inRiver(cx, cz) || onWorks(P, cx, cz, 3)) continue;
    const R = orientedRect(ring);
    if (!R || R.len < 2.5 || R.wid < 1.5) continue;
    P.houses.push({ ring, cx, cz, R, kind: inCompound(cx, cz) ? 'compound' : 'house' });
  }
  // the operator's office: the largest-enough footprint nearest the office point; the long shed: blue roof
  const [ox, oz] = P.officeXZ;
  let best = null;
  for (const h of P.houses) {
    if (h.kind !== 'compound') continue;
    if (h.R.len >= 25 && h.R.wid <= 15) h.kind = 'shed';
    const d = Math.hypot(h.cx - ox, h.cz - oz);
    if (h.R.len * h.R.wid >= 120 && d < 40 && (!best || d < best.d)) best = { h, d };
  }
  if (best) { best.h.kind = 'office'; best.h.storeys = P.officeStoreys; P.office = best.h; }
}

export function planTrees(P, inRiver) {
  const r = rng(20261123), trees = [];
  // spatial grid of houses for quick distance checks
  const cell = 20, grid = new Map();
  for (const h of P.houses) {
    const k = Math.floor(h.cx / cell) + ',' + Math.floor(h.cz / cell);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(h);
  }
  const nearHouse = (x, z, gap) => {
    const gx = Math.floor(x / cell), gz = Math.floor(z / cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const h of grid.get(gx + i + ',' + (gz + j)) || []) {
        if (Math.hypot(x - h.cx, z - h.cz) < Math.hypot(h.R.len, h.R.wid) / 2 + gap) return true;
      }
    }
    return false;
  };
  const ok = (x, z, gap) => Math.hypot(x, z) < 640 && !(Math.abs(x) < 150 && Math.abs(z) < 95) && !inRiver(x, z)
    && !onWorks(P, x, z, 4) && !nearHouse(x, z, gap);
  // INDICATIVE: trees along both banks, a broken line 8 to 30 m from the water's edge
  if (P.river) {
    const near = [];
    for (const p of P.river) if (Math.hypot(p[0], p[1]) < 700) near.push(p);
    // walk the outline in order, in runs of points that stay near the weir
    let run = [];
    const flush = () => {
      if (run.length > 2) {
        const l = densify(run, 15), N = normals(l);
        l.forEach(([x, z], i) => {
          for (const d of [9 + r() * 6, 22 + r() * 8]) {
            if (r() < 0.3) continue;
            for (const s of [1, -1]) {
              const tx = x + N[i][0] * d * s + (r() - 0.5) * 5, tz = z + N[i][1] * d * s + (r() - 0.5) * 5;
              if (ok(tx, tz, 3)) trees.push({ x: tx, z: tz, kind: 'broad', s: 0.8 + r() * 0.5 });
            }
          }
        });
      }
      run = [];
    };
    for (const p of P.river) {
      if (Math.hypot(p[0], p[1]) < 700) run.push(p);
      else flush();
    }
    flush();
  }
  // INDICATIVE: the palm park of the compound and the palm rows between the curved channels (drone photo, ref 01)
  for (let x = 112; x < 350; x += 11) {
    for (let z = -205; z < 20; z += 11) {
      const tx = x + (r() - 0.5) * 4, tz = z + (r() - 0.5) * 4;
      const inPark = inCompound(tx, tz);
      if (r() > (inPark ? 0.5 : 0.35)) continue;
      if (tx > 112 && ok2(tx, tz)) trees.push({ x: tx, z: tz, kind: 'palm', s: 0.85 + r() * 0.3 });
    }
  }
  function ok2(x, z) {
    return !inRiver(x, z) && !onWorks(P, x, z, 3.5) && !nearHouse(x, z, 3) && !(Math.abs(x) < 125 && Math.abs(z) < 40);
  }
  P.trees = trees.slice(0, 1100);
}

export function planLabels(P, W) {
  const L = [], el = (x) => x + P.offset;
  const bays = Array.isArray(W.bays) ? W.bays : [];
  const bx = (id) => {
    const b = bays.find((q) => q.id === id);
    return b ? v(b.x_centre_m, null) - P.length / 2 : null;
  };
  const deckTop = el(v(W.deck?.el, 83) + v(W.deck?.tower_height_m, 7));
  const fg = bx('FG4'), sg = bx('SG2');
  if (fg != null) L.push({ id: 'flood_gates', x: fg, y: deckTop, z: 2, lift: 34 });
  if (sg != null) L.push({ id: 'sluices', x: sg, y: deckTop, z: 2, lift: 30 });
  // A8 point 3, one name per thing: labels name parts of the structure only (no divide wall, flushing channel or
  // canal label: lane b23 names the canal on its line)
  const I = P.intake;
  L.push({ id: 'intake', x: (I.xFace + I.xBack) / 2, y: 'intake', z: I.zc, lift: 11 });
  if (P.basins.length) {
    const b = P.basins[Math.floor(P.basins.length / 2)];
    L.push({ id: 'basins', x: b.cx, y: 'basin', z: (b.zN + b.zS) / 2, lift: 30 });
  }
  L.push({ id: 'ladder', x: P.ladder.x, y: 'ground', z: P.ladder.z1 + 8, lift: 9 });
  if (P.office) L.push({ id: 'office', x: P.office.cx, y: 'office', z: P.office.cz, lift: 12 });
  // INDICATIVE zoom thresholds: the parts at the weir are close together, so they appear only close up
  const far = { basins: 14.5, flood_gates: 15.3, sluices: 15.8 };
  for (const l of L) l.minZoom = far[l.id] ?? 16.4;
  P.labels = L;
}

// Ground heights for everything, from the terrain sampler, in one batch. sample([[lon, lat]]) -> Promise<number[]>.
// The terrain is a surface model (tree tops and roofs): tops of sunk works take the highest nearby surface (so the
// ground never covers them), houses and trees take the lowest (closest to the real ground).
export async function applyHeights(P, sample, fromXZ) {
  const pts = [], fill = [];
  const ask = (x, z) => (pts.push(fromXZ(x, z)), pts.length - 1);
  for (const c of P.channels) {
    const N = normals(c.line), w = c.hb + (c.m || 0) * 4 + 3;
    c._ix = c.line.map(([x, z], i) => [ask(x, z), ask(x + N[i][0] * w, z + N[i][1] * w), ask(x - N[i][0] * w, z - N[i][1] * w)]);
  }
  for (const b of P.basins) {
    b._ix = b.ring.map(([x, z]) => ask(x, z));
    for (let x = b.x0; x <= b.x1; x += 10) for (let z = b.zN; z <= b.zS; z += 10) if (pointInRing(x, z, b.ring)) b._ix.push(ask(x, z));
  }
  const I = P.intake;
  I._ix = [[I.xFace, I.z0], [I.xBack, I.z0], [I.xBack, I.z1], [I.xFace, I.z1], [(I.xFace + I.xBack) / 2, I.zc]].map(([x, z]) => ask(x, z));
  const Ld = P.ladder;
  Ld._ix = [];
  for (let z = Ld.z1; z <= Ld.z0; z += 5) Ld._ix.push(ask(Ld.x - 3, z), ask(Ld.x + 3, z));
  for (const h of P.houses) {
    const { cx, cz, ux, uz, len, wid } = h.R, a = len / 2 + 3, b = wid / 2 + 3;
    h._ix = [[a, b], [a, -b], [-a, b], [-a, -b], [0, 0]].map(([u, w]) => ask(cx + u * ux - w * uz, cz + u * uz + w * ux));
  }
  for (const t of P.trees) t._ix = [[0, 0], [10, 0], [-10, 0], [0, 10], [0, -10]].map(([dx, dz]) => ask(t.x + dx, t.z + dz));
  for (const l of P.labels) if (typeof l.y === 'string') l._ix = [ask(l.x, l.z)];
  const hs = await sample(pts);
  const dflt = P.lv.pond + 3;
  const H = (i) => (Number.isFinite(hs[i]) ? hs[i] : dflt);
  const max = (ix) => Math.max(...ix.map(H)), min = (ix) => Math.min(...ix.map(H));
  const water = (lvl) => (lvl === 'tail' ? P.lv.tail : P.lv.canal);
  // INDICATIVE cap: bank tops are never drawn more than 1 m above the weir deck (EL from weir.json); higher surface
  // readings there are tree crowns in the surface model, not ground
  const cap = P.lv.deck + 1;
  for (const c of P.channels) {
    // the lid (the hole in the terrain's depth) sits over the highest surface; the drawn walls stop at the cap
    c.lidTop = c._ix.map((ix) => max(ix) + 0.5);
    const raw = c._ix.map((ix) => Math.min(cap, max(ix) + 0.3));
    // a running maximum over neighbours, so the bank top is smooth, never below the water plus a freeboard
    c.top = raw.map((_, i) => Math.max(water(c.level) + 0.8, ...raw.slice(Math.max(0, i - 2), i + 3)));
  }
  for (const b of P.basins) { b.top = Math.max(P.lv.canal + 0.8, Math.min(cap, max(b._ix) + 0.3)); b.lidTop = max(b._ix) + 0.5; }
  I.top = P.lv.deck; // the intake deck at the weir's deck level (weir.json deck.el, an assumed level)
  Ld.top = Math.max(Ld.waterUp + 0.6, Math.min(cap, max(Ld._ix) + 0.3));
  Ld.lidTop = max(Ld._ix) + 0.5;
  for (const h of P.houses) h.base = min(h._ix);
  for (const t of P.trees) t.y = min(t._ix) - 0.3;
  for (const l of P.labels) {
    if (l.y === 'intake') l.y = I.top + 4;
    else if (l.y === 'basin') l.y = P.basins.length ? Math.max(...P.basins.map((b) => b.top)) : dflt;
    else if (l.y === 'office') l.y = P.office ? P.office.base + P.office.storeys * 3 + 1 : dflt;
    else if (l._ix) l.y = H(l._ix[0]) + 1;
  }
  fill.length = 0;
  return P;
}
