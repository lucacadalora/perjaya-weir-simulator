// Bendung Perjaya: the weir's surroundings in 3D (lane b09). CONTRACT 4.7; facts from weir.json and params.json.
//
// What it draws (what weir.js draws is not repeated): on the right (east, Perjaya) bank the intake with its gate
// houses, the lined feed channels from the intake to the five settling basins (kantong lumpur) with their gate bars,
// the outlets on to the head of the main canal, the flushing channel back to the river, the fish ladder behind the
// right abutment, the operator's compound (white office, blue-roofed shed, palm park); on both banks the real
// building footprints within 600 m as houses with pitched roofs, trees along the banks, and name labels with leader
// lines for the weir's parts (they follow view.layers.labels).
//
// Model frame (buildSite): metres, +X east, +Y up in MODEL metres (absolute: project EL + params.datum.offset_m),
// +Z south. REFERENCE POINT: the weir axis centre (weir.json axis lon/lat). REFERENCE ELEVATION: model 0, so mount it
// with el = 0 and bearing_deg = 0.
//
// buildSite(THREE, siteParams) -> { group, update(dt, t), setLevels({canal_y, tail_y}), setIntake(opening_m),
//   setLabels({id: text}), setLabelsVisible(bool), setSediment(store sediment), triangles, params }
// The water of the basins and channels, the deposit, the suspended particles and the flushing plume in the river are
// drawn by site/sediment.js (lane s, 24 Nov 2026) from the store key `sediment`.
// siteParams: the plan from site/layout.js (planSite + applyHeights).
import { TriBuilder } from './site/geom.js';
import { LidBuilder, punchMeshes } from './site/punch.js';
import { channel, basin } from './site/works.js';
import { buildIntake, buildLadder } from './site/intake.js';
import { addHouse } from './site/houses.js';
import { buildTrees } from './site/trees.js';
import { buildLabels } from './site/labels.js';
import { planSite, v } from './site/layout.js';
import { applyHeights } from './site/layout-items.js';
import { StripBuilder, buildSediment } from './site/sediment.js';

export function buildSite(THREE, P) {
  const group = new THREE.Group();
  group.name = 'b09-site';
  const B = new TriBuilder(), lid = new LidBuilder(), houseB = new TriBuilder(), leafB = new TriBuilder();
  // water strips by what they carry (lane s): feed = the river's water from the intake, out = the outlets and the
  // canal after the basins, tail = the flushing channel back to the river, static = the fish ladder's pools
  const wFeed = new StripBuilder(), wCanal = new StripBuilder(), wTail = new StripBuilder(), wStatic = new StripBuilder();
  const lv = P.lv;

  for (const c of P.channels) {
    const level = c.level === 'tail' ? lv.tail : lv.canal;
    channel(B, c.level === 'tail' ? wTail : c.kind === 'feed' ? wFeed : wCanal, lid, c.line,
      { bed: c.bed, m: c.m, hb: c.hb, cope: c.cope ?? 0.6, top: c.top, lidTop: c.lidTop, waterY: Math.max(level, c.bed + 0.3) });
  }
  // the basins' own floor lies 0.3 m under the true floor: the deposit drawing (sediment.js) is the floor seen
  const floorY = lv.canal - P.basinDepth;
  const rings = [];
  for (const b of P.basins) {
    // INDICATIVE: training walls 1.4 m high on the floor (the aerial of the drained basins shows them low, as lines)
    const r = basin(THREE, B, null, lid, { ring: b.ring, top: b.top, lidTop: b.lidTop, floor: floorY - 0.3, waterY: lv.canal,
      bar: P.flush ? { z: P.flush.z, gates: P.flushGates } : null, trainTo: b.zS, trainTop: floorY + 1.4 });
    rings.push(r.inner);
  }
  const I = P.intake;
  buildIntake(THREE, B, leafB, wFeed, { ...I, deckY: I.top });
  const pk = P.pocket; // the pond's pocket in front of the intake: open the surface model for the pond sheet
  if (pk) {
    // the bank stands up to about the deck level at the intake's face: the lid lies above it (the pond sheet's own
    // mask keeps the water inside the pocket)
    const top = Math.max(pk.top, Number.isFinite(I.top) ? I.top + 1.5 : pk.top);
    lid.quad([pk.x0, top, pk.z0], [pk.xa, top, pk.z0], [pk.xa, top, pk.z1], [pk.x0, top, pk.z1]);
    lid.quad([pk.xa, top, pk.za], [pk.x1, top, pk.za], [pk.x1, top, pk.z1], [pk.xa, top, pk.z1]);
  }
  buildLadder(B, wStatic, lid, { ...P.ladder, top: P.ladder.top });
  for (const h of P.houses) addHouse(houseB, h);

  const solid = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mesh = (tb, mat, order, name) => {
    const m = new THREE.Mesh(tb.geometry(THREE), mat);
    m.renderOrder = order;
    m.frustumCulled = false;
    m.name = name;
    group.add(m);
    return m;
  };
  for (const p of punchMeshes(THREE, lid.geometry(THREE))) group.add(p);
  mesh(B, solid, -50, 'b09-works');
  const leaves = mesh(leafB, solid, -50, 'b09-intake-leaves');
  mesh(houseB, solid, 0, 'b09-houses');
  const sed = buildSediment(THREE, { basins: rings, barZ: P.flush ? P.flush.z : null, floorY, depth: P.basinDepth,
    canalY: lv.canal, tailY: lv.tail, flushLine: P.flush ? P.flush.line : null,
    strips: { feed: wFeed, out: wCanal, flush: wTail, ladder: wStatic } });
  group.add(sed.group);

  const trees = buildTrees(THREE, P.trees);
  group.add(trees.group);
  const labels = buildLabels(THREE, P.labels);
  group.add(labels.group);

  const triangles = B.triangles + houseB.triangles + leafB.triangles + sed.triangles + lid.triangles * 2
    + trees.triangles + labels.triangles;

  return {
    group, triangles, params: P,
    update(dt, t) { sed.update(dt, t); },
    setLevels({ canal_y, tail_y } = {}) {
      sed.setLevels({ canal_y, tail_y, tail_floor: lv.tailBed + 0.2 });
    },
    setSediment: sed.setState,
    // gate leaves of the intake lifted by opening_m (0 = closed on the sill)
    setIntake(opening_m) {
      if (Number.isFinite(opening_m)) leaves.position.y = Math.max(0, Math.min(opening_m, I.gateH));
    },
    setLabels: labels.setTexts,
    setLabelsVisible(on) { labels.group.visible = !!on; },
    setLabelZoom: labels.setZoom,
  };
}

const LABELS = {
  flood_gates: 'Flood gates', sluices: 'Scouring sluices', intake: 'Intake', basins: 'Sediment trap',
  ladder: 'Fish ladder', office: "Operator's office",
};

export async function init(ctx) {
  if (!ctx || !ctx.scene3d || !ctx.sampler || !ctx.data) return;
  const work = mount(ctx).catch((e) => ctx.log && ctx.log('site: not drawn', e && e.message));
  if (ctx.shot) await work;
}

async function mount(ctx) {
  const get = (p) => ctx.data.json(p).catch(() => null);
  const [weir, params, lakes, rivers, riverPoly, buildings] = await Promise.all([
    get('weir.json'), get('params.json'), get('feat/lakes.geojson'), get('feat/rivers.geojson'),
    get('feat/river_poly.geojson'), get('feat/buildings_fine.geojson'),
  ]);
  if (!weir || !weir.axis) return;
  const S3 = ctx.scene3d, THREE = S3.THREE;
  const ax = v(weir.axis.lon, 104.38101), ay = v(weir.axis.lat, -4.30512); // FALLBACK: OSM weir line centre
  const o = S3.toLocal(ax, ay, 0);
  const toXZ = (lon, lat) => {
    const p = S3.toLocal(lon, lat, 0);
    return [p[0] - o[0], p[2] - o[2]];
  };
  const fromXZ = (x, z) => S3.fromLocal(x + o[0], z + o[2]);
  const P = planSite({ weir, params, lakes, rivers, riverPoly, buildings }, toXZ);
  await applyHeights(P, (pts) => ctx.sampler.elevations(pts), fromXZ);
  const S = buildSite(THREE, P);
  S3.add(S.group, { lon: ax, lat: ay, el: 0, bearing_deg: 0 });

  const texts = () => Object.fromEntries(Object.entries(LABELS).map(([k, en]) => [k, ctx.t('site.label.' + k, en)]));
  S.setLabels(texts());
  ctx.store.on('lang', () => { S.setLabels(texts()); S3.requestRender(); });
  const vis = () => {
    const on = ctx.store.get('view.layers.labels') !== false && (!ctx.map || ctx.map.getZoom() >= 13);
    S.setLabelsVisible(on);
    if (ctx.map) S.setLabelZoom(ctx.map.getZoom());
    S3.requestRender();
  };
  ctx.store.on('view.layers.labels', vis);
  if (ctx.map) { ctx.map.on('zoomend', vis); ctx.map.on('zoom', vis); }
  vis();

  // follow the pond and the river below: the channels hold the pond (never above the intake's design level)
  const follow = () => {
    const w = ctx.store.get('weir') || {};
    S.setLevels({
      canal_y: Number.isFinite(w.pond_el) ? Math.min(w.pond_el + P.offset, P.lv.canal) : P.lv.canal,
      tail_y: Number.isFinite(w.tail_el) ? w.tail_el + P.offset : P.lv.tail,
    });
    // INDICATIVE: with no operation set yet the intake leaves stand half open
    const open = Number.isFinite(w.intake_open) ? w.intake_open : 0.5;
    S.setIntake(open * P.intake.gateH);
    S3.requestRender();
  };
  ctx.store.on('weir', follow);
  follow();
  // sediment in the basins (lane s): the engine's state from the store; the drawing moves on the frame clock
  ctx.store.on('sediment', (s) => S.setSediment(s));
  S.setSediment(ctx.store.get('sediment'));
  S3.onFrame((dt, t) => S.update(dt, t));
  if (ctx.dev) window.__b09 = { S, P };
  ctx.log && ctx.log('site: drawn,', S.triangles, 'triangles,', P.houses.length, 'houses,', P.trees.length, 'trees');
}
