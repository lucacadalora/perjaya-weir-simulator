// Weir surroundings (lane b09): houses on the real building footprints (Overture / OpenStreetMap), with pitched roofs.
// Walls follow the footprint; the roof covers its oriented rectangle. Colours read from the reference pictures:
// village roofs are mostly orange-brown clay tile with some dark brown and grey metal, walls cream and white; the
// operator's office is white with a flat roof, the long shed in the compound has a blue roof.
// INDICATIVE: storey height, roof pitch, roof form (hip or gable) and the colour of each single house are drawing
// choices made per footprint from a stable hash, not survey facts.
import { orientedRect, hash2 } from './geom.js';
import { prism } from './intake.js';

const ROOFS = [0xb0603e, 0xa4553a, 0x9c4f35, 0xb86a45, 0xa8674a, 0x7a4f3c, 0x6e4a3a, 0x9aa0a3, 0x8b9196, 0x4b78b0];
const ROOF_W = [14, 14, 12, 10, 10, 8, 6, 9, 7, 2];
const WALLS = [0xeee6d6, 0xf3f0e8, 0xe6d9b8, 0xe2e6dc, 0xead2c4, 0xdcd6c8];
const STOREY = 3.0;

const pick = (arr, w, r) => {
  let s = 0;
  const tot = w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < arr.length; i++) { s += w[i] / tot; if (r < s) return arr[i]; }
  return arr[arr.length - 1];
};

// item: { ring [[x, z]], base (model m), kind 'house'|'office'|'shed'|'compound', storeys }
export function addHouse(B, item) {
  const { ring, base } = item;
  const R = orientedRect(ring);
  if (!R) return;
  const r1 = hash2(R.cx, R.cz), r2 = hash2(R.cz, R.cx);
  const kind = item.kind || 'house';
  const storeys = item.storeys || (kind === 'house' && R.len * R.wid > 160 && r2 > 0.8 ? 2 : 1);
  let wall = pick(WALLS, [1, 1, 1, 1, 1, 1], r2), roof = pick(ROOFS, ROOF_W, r1);
  if (kind === 'office') { wall = 0xf4f3ef; roof = 0xdedcd6; }
  if (kind === 'shed') { wall = 0xe9e7e1; roof = 0x3c6fc0; }
  if (kind === 'compound') { wall = 0xece9e1; roof = 0x5d6266; }
  const h = kind === 'shed' ? 6 : storeys * STOREY;
  const y0 = base - 1.5, y1 = base + h;
  prism(B, ring, y0, y1, wall, wall);

  const { cx, cz, ux, uz, len, wid } = R;
  const P = (u, v, y) => [cx + u * ux - v * uz, y, cz + u * uz + v * ux];
  const e = 0.5, hu = len / 2 + e, hv = wid / 2 + e;
  if (kind === 'office') {
    // flat roof with a parapet and dark window bands on every storey
    prism(B, ring.map((p) => p), y1, y1 + 0.8, wall, 0xd2d0c9);
    for (let s = 0; s < storeys; s++) {
      const ya = base + s * STOREY + 0.9, yb = ya + 1.4;
      for (const [sv, su] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const half = su ? wid / 2 - 0.8 : len / 2 - 0.8, off = (su ? len / 2 : wid / 2) + 0.06;
        const a = su ? P(su * off, -half, ya) : P(-half, sv * off, ya);
        const b = su ? P(su * off, half, ya) : P(half, sv * off, ya);
        B.quad2(a, b, [b[0], yb, b[2]], [a[0], yb, a[2]], 0x3a4a58);
      }
    }
    return;
  }
  const rise = (wid / 2) * (kind === 'shed' ? 0.22 : 0.5);
  const top = y1 + rise, ye = y1 - 0.2;
  const gable = kind === 'shed' || r1 > 0.72 || len < wid * 1.15;
  if (gable) {
    B.quad2(P(-hu, -hv, ye), P(hu, -hv, ye), P(hu, 0, top), P(-hu, 0, top), roof);
    B.quad2(P(-hu, hv, ye), P(-hu, 0, top), P(hu, 0, top), P(hu, hv, ye), roof);
    B.tri(P(-len / 2, -wid / 2, y1), P(-len / 2, wid / 2, y1), P(-len / 2, 0, top), wall);
    B.tri(P(len / 2, -wid / 2, y1), P(len / 2, 0, top), P(len / 2, wid / 2, y1), wall);
  } else {
    const ridge = Math.max(0, hu - hv);
    B.quad2(P(-hu, -hv, ye), P(hu, -hv, ye), P(ridge, 0, top), P(-ridge, 0, top), roof);
    B.quad2(P(-hu, hv, ye), P(-ridge, 0, top), P(ridge, 0, top), P(hu, hv, ye), roof);
    B.tri(P(-hu, -hv, ye), P(-ridge, 0, top), P(-hu, hv, ye), roof);
    B.tri(P(hu, -hv, ye), P(hu, hv, ye), P(ridge, 0, top), roof);
  }
}
