// Weir surroundings (lane b09): the intake on the right (east) bank and the fish ladder beside the right abutment.
// Pure: THREE and plan values in the site frame (metres, +X east, +Y up model metres, +Z south = upstream).
import { C } from './works.js';

// extrude a plan polygon [[x, z]] from y0 to y1 with a top (walls and top in one colour each)
export function prism(B, ring, y0, y1, col, topCol = col) {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    B.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], col);
  }
  for (let i = 1; i < n - 1; i++) B.tri([ring[0][0], y1, ring[0][1]], [ring[i][0], y1, ring[i][1]], [ring[i + 1][0], y1, ring[i + 1][1]], topCol);
}

// small gate house: walls, a pitched roof along x with gable ends
export function gateHouse(B, x, z, lx, lz, y0, h, wallCol, roofCol) {
  const x0 = x - lx / 2, x1 = x + lx / 2, z0 = z - lz / 2, z1 = z + lz / 2, y1 = y0 + h, e = 0.35, rise = lz * 0.28;
  prism(B, [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], y0, y1, wallCol);
  const r = y1 + rise;
  B.quad([x0 - e, y1 - 0.15, z0 - e], [x1 + e, y1 - 0.15, z0 - e], [x1 + e, r, z], [x0 - e, r, z], roofCol);
  B.quad([x0 - e, r, z], [x1 + e, r, z], [x1 + e, y1 - 0.15, z1 + e], [x0 - e, y1 - 0.15, z1 + e], roofCol);
  B.tri([x0, y1, z0], [x0, y1, z1], [x0, r, z], wallCol);
  B.tri([x1, y1, z0], [x1, y1, z1], [x1, r, z], wallCol);
}

// The intake: a gated structure along the bank, its face (gates) to the west looking into the pond pocket, with
// `leaves` bays between piers, a deck at `deckY`, a small gate house over every bay and water passages behind.
// o: { xFace, xBack, z0, z1, leaves, sillY, deckY, gateH }   -> { leaves: Group to lift (its y = opening in m) }
export function buildIntake(THREE, B, leafB, wb, o) {
  const { xFace, xBack, z0, z1, leaves, sillY, deckY, gateH } = o;
  const pierT = 1.2, n = leaves, bay = (z1 - z0 - (n + 1) * pierT) / n;
  const floorY = sillY - 0.6;
  // floor of the passages
  prism(B, [[xFace - 2, z0], [xBack, z0], [xBack, z1], [xFace - 2, z1]], floorY - 1, floorY, C.floor);
  // piers with pointed noses into the pond, from the floor to the deck
  for (let k = 0; k <= n; k++) {
    const zc = z0 + pierT / 2 + k * (bay + pierT), h = pierT / 2;
    prism(B, [[xFace - 2.2, zc], [xFace - 1.2, zc - h], [xBack, zc - h], [xBack, zc + h], [xFace - 1.2, zc + h]], floorY, deckY, C.concrete);
  }
  // deck slab with a kerb, and a breast wall above the gate openings on the face
  prism(B, [[xFace - 1.2, z0], [xBack, z0], [xBack, z1], [xFace - 1.2, z1]], deckY - 0.8, deckY, C.concreteDark, C.coping);
  const breastBot = sillY + gateH + 0.2;
  if (breastBot < deckY - 0.8) prism(B, [[xFace - 0.2, z0], [xFace + 0.4, z0], [xFace + 0.4, z1], [xFace - 0.2, z1]], breastBot, deckY - 0.8, C.concrete);
  // gate leaves (blue steel with ribs), in their own builder so the caller can lift them as one group
  for (let k = 0; k < n; k++) {
    const za = z0 + pierT + k * (bay + pierT), zb = za + bay, x = xFace + 0.1;
    leafB.quad2([x, sillY, za], [x, sillY, zb], [x, sillY + gateH, zb], [x, sillY + gateH, za], C.steel);
    for (let r = 0.5; r < gateH; r += 0.7) leafB.quad2([x - 0.15, sillY + r, za], [x - 0.15, sillY + r, zb], [x - 0.15, sillY + r + 0.15, zb], [x - 0.15, sillY + r + 0.15, za], C.steelDark);
    // gate house over the bay (INDICATIVE size: about 6 small housings are seen on the drone photo)
    gateHouse(B, xFace + 2.4, za + bay / 2, 3.6, Math.min(bay, 5), deckY, 2.6, 0xe9e6de, 0x5d6266);
    // water in the passage, at the canal level (the caller moves `wb` to the level)
    if (wb) wb.quad([xFace - 2, 0, za], [xFace - 2, 0, zb], [xBack, 0, zb], [xBack, 0, za], C.water);
  }
  // hand rails on the deck edges
  for (const xr of [xFace - 1.0, xBack - 0.2]) B.quad2([xr, deckY, z0], [xr, deckY, z1], [xr, deckY + 1.1, z1], [xr, deckY + 1.1, z0], C.steel);
}

// The fish ladder: a straight pool-and-weir channel of `pools` pools from z0 (upstream, pond end) to z1 (downstream),
// width w, its walls' top at `top`, water stepping down from waterUp to waterDown. Static water (absolute levels).
// INDICATIVE: the slot along the right abutment, the pool count and the pool depth are drawing choices; length,
// slope and side are from weir.json.
export function buildLadder(B, wStatic, lid, o) {
  const { x, z0, z1, w, top, waterUp, waterDown, pools, poolDepth = 1.2 } = o;
  const xl = x - w / 2, xr = x + w / 2, wall = 0.4, dz = (z1 - z0) / pools;
  const drop = (waterUp - waterDown) / pools;
  for (let k = 0; k < pools; k++) {
    const za = z0 + k * dz, zb = za + dz, wy = waterUp - (k + 0.5) * drop, bed = wy - poolDepth;
    B.quad([xl, top, za], [xl, bed, za], [xl, bed, zb], [xl, top, zb], C.concrete);
    B.quad([xr, top, za], [xr, top, zb], [xr, bed, zb], [xr, bed, za], C.concrete);
    B.quad([xl, bed, za], [xr, bed, za], [xr, bed, zb], [xl, bed, zb], C.floor);
    wStatic.quad([xl, wy, za], [xr, wy, za], [xr, wy, zb], [xl, wy, zb], C.waterShallow);
    // cross wall (the weir of each pool) at its downstream end, crest a little under the pool's water with a notch
    const crest = wy - 0.12, nb = bed - drop;
    B.quad2([xl, nb, zb], [xl + w * 0.62, nb, zb], [xl + w * 0.62, crest, zb], [xl, crest, zb], C.concreteDark);
    B.quad2([xl + w * 0.62, nb, zb], [xr, nb, zb], [xr, crest - 0.3, zb], [xl + w * 0.62, crest - 0.3, zb], C.concreteDark);
    // step between this pool's bed and the next
    B.quad2([xl, bed, zb], [xr, bed, zb], [xr, nb, zb], [xl, nb, zb], C.floor);
  }
  // copings, outer skirts, end caps and the lid
  for (const [xa, xb] of [[xl - wall, xl], [xr, xr + wall]]) {
    B.quad([xa, top, z0], [xb, top, z0], [xb, top, z1], [xa, top, z1], C.coping);
  }
  B.quad2([xl - wall, top - 4, z0], [xl - wall, top, z0], [xl - wall, top, z1], [xl - wall, top - 4, z1], C.concreteDark);
  B.quad2([xr + wall, top - 4, z0], [xr + wall, top, z0], [xr + wall, top, z1], [xr + wall, top - 4, z1], C.concreteDark);
  const endBed = waterDown - poolDepth - drop;
  for (const ze of [z0, z1]) B.quad2([xl, endBed, ze], [xr, endBed, ze], [xr, top, ze], [xl, top, ze], C.concreteDark);
  const lt = Math.max(top, o.lidTop ?? top);
  if (lid) lid.quad([xl - wall, lt, z0], [xr + wall, lt, z0], [xr + wall, lt, z1], [xl - wall, lt, z1]);
}
