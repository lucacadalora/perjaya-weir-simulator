// Weir surroundings (lane b09): the sunk works on the right (east) bank: lined channels, the settling basins
// (kantong lumpur) with their gate bars, the head of the main canal, the flushing channel and the fish ladder.
// Pure: takes THREE and plan geometry in the site frame (metres, +X east, +Y up model metres, +Z south).
import { TriBuilder, normals, chaikin, signedArea } from './geom.js';
import { LidBuilder } from './punch.js';
import { WATER } from '../../water/palette.js';

const hex = (h, fb) => (typeof h === 'string' && /^#[0-9a-f]{6}$/i.test(h) ? parseInt(h.slice(1), 16) : fb);

export const C = {
  concrete: 0xc9c6bd, concreteDark: 0xa19e95, coping: 0xd8d5cc, floor: 0x6f6b60, earth: 0x9c8a66,
  // water, waterShallow: only tags now; the water strips are shaded in the RIVER look by site/sediment.js (lane s)
  grass: 0x8fa66a, steel: 0x3d6fa6, steelDark: 0x2f4f72, water: hex(WATER.body, 0x3f7fa6), waterShallow: hex(WATER.shallow, 0x7fb2cc), roofGrey: 0x8e9296,
};

const lerp = (a, b, t) => a + (b - a) * t;

// One channel along `line` ([x, z] points, already dense). Section: bed at `bed`, sides at 1:m, coping `cope` wide
// at the per-station `top[i]`, an outer skirt `skirt` m down. Water is a strip at y = 0 in `wb` (the caller moves
// the water group to the level) whose half width is the section's width at `waterY`; each water quad also gets the
// distance along the line at its corners (lane s: the sediment drawing's StripBuilder moves the water along it).
export function channel(B, wb, lid, line, o) {
  const { bed, m = 0.1, hb, cope = 0.6, top, waterY, col = C.concrete, bankCol = C.coping, skirt = 4, caps = [true, true] } = o;
  const lidTop = o.lidTop || top;
  const N = normals(line);
  const along = [0];
  for (let i = 1; i < line.length; i++) along.push(along[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  const st = line.map((p, i) => {
    const t = top[i];
    const ht = hb + m * (t - bed), hw = hb + m * Math.max(0, waterY - bed);
    const at = (h, y) => [p[0] + N[i][0] * h, y, p[1] + N[i][1] * h];
    return {
      L: { top: at(ht, t), bed: at(hb, bed), cope: at(ht + cope, t), skirt: at(ht + cope, t - skirt), w: at(hw, 0), lid: at(ht + cope, Math.max(t, lidTop[i])) },
      R: { top: at(-ht, t), bed: at(-hb, bed), cope: at(-ht - cope, t), skirt: at(-ht - cope, t - skirt), w: at(-hw, 0), lid: at(-ht - cope, Math.max(t, lidTop[i])) },
    };
  });
  for (let i = 1; i < st.length; i++) {
    const a = st[i - 1], b = st[i];
    // left side (normal side): inner face, coping, outer skirt
    B.quad(a.L.top, a.L.bed, b.L.bed, b.L.top, col);
    B.quad(a.L.cope, a.L.top, b.L.top, b.L.cope, bankCol);
    B.quad(a.L.skirt, a.L.cope, b.L.cope, b.L.skirt, C.concreteDark);
    // right side
    B.quad(a.R.top, b.R.top, b.R.bed, a.R.bed, col);
    B.quad(a.R.cope, b.R.cope, b.R.top, a.R.top, bankCol);
    B.quad(a.R.skirt, b.R.skirt, b.R.cope, a.R.cope, C.concreteDark);
    // floor
    B.quad(a.L.bed, a.R.bed, b.R.bed, b.L.bed, C.floor);
    if (wb) wb.quad(a.L.w, a.R.w, b.R.w, b.L.w, C.water, [along[i - 1], along[i - 1], along[i], along[i]]);
    if (lid) lid.quad(a.L.lid, a.R.lid, b.R.lid, b.L.lid);
  }
  // end caps (a wall across the section) so a lid end never shows the hole's inside
  const cap = (s, flip) => {
    const pts = [s.L.cope, s.L.top, s.L.bed, s.R.bed, s.R.top, s.R.cope];
    const sk = [s.L.skirt, s.R.skirt];
    if (flip) { B.quad(sk[0], pts[0], pts[5], sk[1], C.concreteDark); B.quad(pts[1], pts[2], pts[3], pts[4], col); }
    else { B.quad(sk[1], pts[5], pts[0], sk[0], C.concreteDark); B.quad(pts[4], pts[3], pts[2], pts[1], col); }
  };
  if (caps[0]) cap(st[0], false);
  if (caps[1]) cap(st[st.length - 1], true);
  return st;
}

// offset a closed ring outward by d (ring in any winding)
export function offsetRing(ring, d) {
  const s = Math.sign(signedArea(ring)) || 1;
  const n = ring.length;
  return ring.map((p, i) => {
    const a = ring[(i - 1 + n) % n], b = ring[(i + 1) % n];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    // outward normal: for a ring with positive signed area in (x, z) the outside is to the right of travel
    return [p[0] + s * dz * d, p[1] - s * dx * d];
  });
}

const triangulate = (THREE, ring) => THREE.ShapeUtils.triangulateShape(ring.map((p) => new THREE.Vector2(p[0], p[1])), []);

// A settling basin: vertical lined walls round the smoothed OSM outline, a floor, water, a coping, a lid.
// o: { ring (closed, open form), top, floor, bar: {z, gates}, trainTo: z of the inlet tip }
// With wb null no water is drawn here (lane s: site/sediment.js draws the basin water and the deposit on the floor).
export function basin(THREE, B, wb, lid, o) {
  const inner = chaikin(o.ring, 3);
  const outer = offsetRing(inner, 0.8);
  const n = inner.length, top = o.top, floor = o.floor, lt = Math.max(top, o.lidTop ?? top);
  const s = Math.sign(signedArea(inner)) || 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = inner[i], b = inner[j], A = outer[i], Bo = outer[j];
    const q = (p, y) => [p[0], y, p[1]];
    // inner face seen from inside, coping, outer skirt seen from outside
    if (s > 0) {
      B.quad(q(a, top), q(b, top), q(b, floor), q(a, floor), C.concrete);
      B.quad(q(A, top), q(Bo, top), q(b, top), q(a, top), C.coping);
      B.quad(q(A, top - 4), q(Bo, top - 4), q(Bo, top), q(A, top), C.concreteDark);
    } else {
      B.quad(q(a, floor), q(b, floor), q(b, top), q(a, top), C.concrete);
      B.quad(q(a, top), q(b, top), q(Bo, top), q(A, top), C.coping);
      B.quad(q(A, top), q(Bo, top), q(Bo, top - 4), q(A, top - 4), C.concreteDark);
    }
    if (lid) lid.quad(q(A, lt), q(Bo, lt), q(b, lt), q(a, lt));
  }
  for (const [i, j, k] of triangulate(THREE, inner)) {
    const p = (t, y) => [inner[t][0], y, inner[t][1]];
    B.tri(p(i, floor), p(j, floor), p(k, floor), C.floor);
    if (wb) wb.tri(p(i, 0), p(j, 0), p(k, 0), C.water);
    if (lid) lid.tri(p(i, lt), p(j, lt), p(k, lt));
  }
  // where a line z = zc crosses the basin: [xmin, xmax]
  const span = (zc) => {
    const xs = [];
    for (let i = 0; i < n; i++) {
      const a = inner[i], b = inner[(i + 1) % n];
      if ((a[1] - zc) * (b[1] - zc) <= 0 && a[1] !== b[1]) xs.push(lerp(a[0], b[0], (zc - a[1]) / (b[1] - a[1])));
    }
    return xs.length >= 2 ? [Math.min(...xs), Math.max(...xs)] : null;
  };
  // INDICATIVE: the gate bar (walkway with the flushing gates' hoists) across the basin, and the low training
  // walls fanning from it to the inlet tip, as seen on the aerial and the drone photo. Positions are drawn, not surveyed.
  if (o.bar) {
    const sp = span(o.bar.z);
    if (sp) {
      const [x0, x1] = sp, zb = o.bar.z, y = top + 0.9, w = 1.0;
      B.quad([x0, y, zb - w], [x0, y, zb + w], [x1, y, zb + w], [x1, y, zb - w], C.steelDark);
      B.quad([x0, y - 0.35, zb + w], [x1, y - 0.35, zb + w], [x1, y, zb + w], [x0, y, zb + w], C.steel);
      B.quad([x1, y - 0.35, zb - w], [x0, y - 0.35, zb - w], [x0, y, zb - w], [x1, y, zb - w], C.steel);
      for (const zr of [zb - w, zb + w]) B.quad2([x0, y, zr], [x1, y, zr], [x1, y + 1.1, zr], [x0, y + 1.1, zr], C.steel);
      const g = o.bar.gates;
      for (let k = 0; k < g; k++) {
        const xc = lerp(x0, x1, (k + 0.5) / g), hw = 0.35;
        // hoist pedestal on the walkway, spindle down to the gate leaf
        B.quad([xc - hw, y + 1.2, zb - hw], [xc - hw, y + 1.2, zb + hw], [xc + hw, y + 1.2, zb + hw], [xc + hw, y + 1.2, zb - hw], C.steelDark);
        B.quad2([xc - hw, y, zb], [xc + hw, y, zb], [xc + hw, y + 1.2, zb], [xc - hw, y + 1.2, zb], C.steelDark);
        B.quad2([xc - 0.08, floor, zb], [xc + 0.08, floor, zb], [xc + 0.08, y, zb], [xc - 0.08, y, zb], C.steelDark);
      }
      // piers under the walkway at both walls and between gate groups
      for (const xp of [x0 + 0.3, lerp(x0, x1, 0.5), x1 - 0.3]) {
        B.quad2([xp, floor, zb - w], [xp, floor, zb + w], [xp, y, zb + w], [xp, y, zb - w], C.concrete);
      }
      if (Number.isFinite(o.trainTo)) {
        // lane s: low walls (o.trainTop, INDICATIVE height) so the deposit and a drained basin read; else as b09 drew them
        const zt = o.trainTo, wt = Number.isFinite(o.trainTop) ? o.trainTop : o.waterY - 0.25;
        for (let k = 1; k < g; k++) {
          const xa = lerp(x0, x1, k / g), xb = lerp(x0, x1, 0.5) + (xa - lerp(x0, x1, 0.5)) * 0.25;
          const zEnd = lerp(zb, zt, 0.8);
          B.quad2([xa, floor, zb + w], [xb, floor, zEnd], [xb, wt, zEnd], [xa, wt, zb + w], C.concreteDark);
        }
      }
    }
  }
  return { inner, outer, span };
}
