// Weir surroundings (lane b09): turns the data files into plan geometry in the site frame.
// Site frame: origin on the weir axis centre (weir.json axis lon/lat) at model elevation 0; metres; +X east, +Y up
// (model metres = project EL + params datum offset), +Z south. weir.json's own frame (x from the left abutment face
// along the axis, y downstream = north) maps to x_site = x - length/2, z_site = -y.
//
// Every place comes from a real source: the settling basins from the OpenStreetMap outline "Bak Desilting Perjaya"
// (lakes.geojson), the feed channels, outlets and the flushing channel from the OSM ditch and drain lines
// (rivers.geojson), the main canal from the OSM canal line, the river bank from river_poly.geojson, the houses from
// buildings_fine.geojson, the intake, office and fish ladder from weir.json. Shapes and sizes that no source gives
// are marked INDICATIVE where they are set.
import { chaikinLine, densify, lineLength, pointInRing, centroid, openRing } from './geom.js';
import { planHouses, planTrees, planLabels } from './layout-items.js';

export const v = (leaf, fb) => (leaf && typeof leaf === 'object' && 'v' in leaf ? leaf.v : leaf ?? fb);

const R_HOUSES = 600; // brief: real footprints within 600 m

export function planSite(D, toXZ) {
  const W = D.weir || {}, F = (D.params && D.params.flat) || {};
  const offset = v(D.params?.datum?.offset_m, F['datum.offset_m'] ?? 0);
  const length = v(W.axis?.length_m, 215.5); // FALLBACK SETTLE.md item 7
  const el = (x) => x + offset;
  const lv = {
    canal: el(F['weir.intake_canal_wl_el'] ?? v(W.intake?.design_wl_el, 79.7)),
    pond: el(F['weir.pond_normal_el'] ?? v(W.levels?.pond_normal_el, 79.7)),
    tailBed: el(F['weir.tail_bed_el'] ?? v(W.levels?.riverbed_el, 74)),
    tail: el(F['weir.tail_flight_el'] ?? v(W.levels?.tailwater_flood_case_el, 80)),
    intakeSill: el(F['weir.intake_sill_el'] ?? v(W.intake?.sill_el, 76.8)),
    deck: el(v(W.deck?.el, 83)),
  };
  const P = { offset, length, lv, labels: [] };
  const ring = (coords) => openRing(coords.map(([lon, lat]) => toXZ(lon, lat)));
  const line = (coords) => coords.map(([lon, lat]) => toXZ(lon, lat));
  const near = (pts, r) => pts.some(([x, z]) => Math.hypot(x, z) < r);

  // river outline (for the bank and to keep houses and trees out of the water)
  const rf = (D.riverPoly?.features || []).find((f) => f.properties?.kind === 'river');
  P.river = rf ? ring(rf.geometry.type === 'Polygon' ? rf.geometry.coordinates[0] : rf.geometry.coordinates[0][0]) : null;
  const inRiver = (x, z) => (P.river ? pointInRing(x, z, P.river) : false);

  // settling basins: the five OSM bulbs, west to east
  const lake = (D.lakes?.features || []).find((f) => /desilting/i.test(f.properties?.name || ''));
  const polys = lake ? (lake.geometry.type === 'Polygon' ? [lake.geometry.coordinates] : lake.geometry.coordinates) : [];
  P.basins = polys.map((p) => ring(p[0])).map((r) => {
    const xs = r.map((p) => p[0]), zs = r.map((p) => p[1]);
    return { ring: r, x0: Math.min(...xs), x1: Math.max(...xs), zN: Math.min(...zs), zS: Math.max(...zs), cx: centroid(r)[0] };
  }).sort((a, b) => a.cx - b.cx);
  const SB = W.settling_basins || {};
  const depth = v(SB.depth_m, [2.9, 4.3]);
  P.basinDepth = Array.isArray(depth) ? Math.max(...depth) : depth;
  P.flushGates = v(SB.flush_gates_per_basin, 10);

  // intake (weir.json x_m is the centre across the bank; INDICATIVE depth of the structure: 12 m)
  const IN = W.intake || {};
  const ixc = v(IN.x_m, 226) - length / 2;
  P.intake = { xFace: ixc - 6, xBack: ixc + 6, leaves: v(IN.leaves, 5), width: v(IN.width_m, 49.5),
    sillY: lv.intakeSill, gateH: F['weir.intake_gate_h_m'] ?? 2.7, zc: -v(IN.y_m, -30) };

  // OSM ditches near the weir: feed channels from the intake to each basin and outlets on to the canal head
  const rv = (D.rivers?.features || []).filter((f) => f.geometry?.type === 'LineString');
  const ditches = rv.filter((f) => f.properties?.kind === 'ditch').map((f) => line(f.geometry.coordinates)).filter((l) => near(l, 700));
  // where the ditches cross the back of the intake: centre the intake on them so the channels meet it
  const zAt = (l, xq) => {
    for (let i = 1; i < l.length; i++) {
      const [x0, z0] = l[i - 1], [x1, z1] = l[i];
      if ((x0 - xq) * (x1 - xq) <= 0 && x0 !== x1) return z0 + ((z1 - z0) * (xq - x0)) / (x1 - x0);
    }
    return null;
  };
  const crossings = ditches.map((l) => zAt(l, P.intake.xBack)).filter(Number.isFinite);
  if (crossings.length) P.intake.zc = crossings.reduce((a, b) => a + b, 0) / crossings.length;
  P.intake.z0 = P.intake.zc - P.intake.width / 2;
  P.intake.z1 = P.intake.zc + P.intake.width / 2;
  // The pocket of the pond in front of the intake. The surface model has the river's own surface there, level with
  // the pond, so the pond sheet (lane b06, map/water.js WEIR_POCKET_M) would lie hidden in it: a lid just above the
  // pond opens it. From the last 45 m of the weir's length to the intake's face; beside the abutment only from
  // where the right upstream wall turns to the bank (21 m upstream, weir/civil.js). SHAPE, not a researched size.
  P.pocket = { x0: length / 2 - 45, xa: length / 2, x1: P.intake.xFace - 1.9, z0: 9, za: 21, z1: P.intake.z1 + 6, top: lv.pond + 0.8 };

  // INDICATIVE lined-channel sections (no source gives them): feed and outlet channels 8 m wide, near-vertical walls
  const FEED = { hb: 3.9, m: 0.05 };
  P.channels = [];
  for (const raw of ditches) {
    const l = densify(chaikinLine(raw, 2), 5);
    const b = P.basins.find((B) => l.some(([x, z]) => pointInRing(x, z, B.ring)));
    const inside = l.map(([x, z]) => (b ? pointInRing(x, z, b.ring) : false));
    const first = inside.indexOf(true), last = inside.lastIndexOf(true);
    const feed = (first > 0 ? l.slice(0, first + 1) : b ? [] : l).filter(([x]) => x >= P.intake.xBack - 0.5);
    if (feed.length > 1) P.channels.push({ kind: 'feed', line: feed, ...FEED, bed: lv.canal - 3.2, level: 'canal' });
    if (b && last >= 0 && last < l.length - 2) P.channels.push({ kind: 'outlet', line: l.slice(last), ...FEED, bed: lv.canal - 3.2, level: 'canal' });
  }

  // main canal head: the OSM canal line from its start, its first 600 m (INDICATIVE trapezoid 1:1.5, 3 m deep)
  const head = v(W.canal_head?.point, [104.3855, -4.302]);
  const hxz = toXZ(head[0], head[1]);
  const canal = rv.filter((f) => f.properties?.kind === 'canal').map((f) => line(f.geometry.coordinates))
    .map((l) => ({ l, d: Math.hypot(l[0][0] - hxz[0], l[0][1] - hxz[1]) })).sort((a, b) => a.d - b.d)[0];
  if (canal && canal.d < 150) {
    const l = densify(canal.l, 10), out = [l[0]];
    for (let i = 1; i < l.length && lineLength(out) < 600; i++) out.push(l[i]);
    const ww = v(W.canal_head?.water_width_m, 31), m = 1.5, d = 3;
    P.channels.push({ kind: 'canal', line: out, hb: ww / 2 - m * d, m, bed: lv.canal - d, level: 'canal', cope: 1.2 });
  }

  // flushing channel (Saluran Bilas): OSM drain segments joined east to west, cut where they reach the river,
  // carried east to the westmost basin's wall (INDICATIVE link), water at the tail level
  const drains = rv.filter((f) => /bilas/i.test(f.properties?.name || '')).map((f) => line(f.geometry.coordinates));
  if (drains.length) {
    const pts = drains.flat().sort((a, b) => b[0] - a[0]);
    const zf = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const b0 = P.basins[0];
    const east = b0 ? b0.x0 + 2 : pts[0][0];
    let l = densify([[Math.max(east, pts[0][0]), zf], ...pts], 5);
    const k = l.findIndex(([x, z]) => inRiver(x, z));
    if (k > 1) l = l.slice(0, k + 1);
    P.flush = { line: l, z: zf };
    P.channels.push({ kind: 'flush', line: l, hb: 2.5, m: 0.4, bed: lv.tailBed, level: 'tail' });
  }

  // fish ladder: along the bank just behind the right abutment (INDICATIVE slot), length, slope, width from weir.json
  const FL = W.fish_ladder || {};
  const flLen = v(FL.length_m, 75.5), flSlope = v(FL.slope, 11.7), flW = v(FL.width_m, 3);
  const xL = length / 2 + 1 + flW / 2;
  P.ladder = { x: xL, z0: 20, z1: 20 - flLen, w: flW, waterUp: lv.pond, waterDown: lv.pond - flLen / flSlope,
    pools: Math.max(8, Math.round(flLen / flSlope / 0.3)) };

  // office point
  const op = v(W.office?.point, [104.38245, -4.30494]);
  P.officeXZ = toXZ(op[0], op[1]);
  P.officeStoreys = v(W.office?.storeys, 4);

  planHouses(P, D, toXZ, inRiver);
  planTrees(P, inRiver);
  planLabels(P, W);
  return P;
}
