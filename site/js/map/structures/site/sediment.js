// Settling basins (lane s, 24 Nov 2026): the sediment made visible. A pure factory (CONTRACT 4.7): takes THREE
// and plan geometry in the site frame (metres, +X east, +Y up model metres, +Z south), never the map.
//
// What it draws, from the store key `sediment` (engine/sediment.js through sim/weir-run.js):
//   - the water in each basin: river-coloured and muddy at the inlet tip, clearing towards the outlet as the sand
//     settles, with billows drifting north; in a flush it drops, runs brown and fast to the flushing gates on the bar;
//   - suspended particles drifting along each basin and sinking (sand soon after the inlet, silt further on);
//   - the deposit on each floor: a delta of sand and mud thickest near the inlet, holding the engine's deposit volume
//     at true scale; a flush cuts a gully down it and scours it back towards the inlet;
//   - the channels' water: the feed channels carry the river's water, the outlets and the canal clearer water, the
//     flushing channel (Saluran Bilas) runs brown in a flush;
//   - the plume a flush sends from Saluran Bilas into the Komering, bending downstream (its own mesh just above the
//     river sheet, so the river's own drawing is untouched).
// Speeds of drifting and sinking are DISPLAY speeds (about 20 times the real ones, so the movement is seen); a flush
// that the clock passes in a blink stays on screen at least MIN_SHOW_S.
//
// buildSediment(THREE, o) -> { group, setState(sediment), setLevels({canal_y, tail_y}), update(dt, t), triangles }
// o: { basins: [inner ring [x, z][]], barZ, floorY, depth, canalY, tailY, flushLine: [x, z][] | null,
//      strips: { feed, out, flush, ladder } (StripBuilder) }
import * as PAL from '../../water/palette.js';
import { basinFrame, frontTable, frontFor, fullThickness, turbidity, plumePath } from './sediment-shape.js';
import { NB, DEPOSIT_VS, DEPOSIT_FS, BASIN_VS, BASIN_FS, PART_VS, PART_FS, CHAN_VS, CHAN_FS, PLUME_VS, PLUME_FS } from './sediment-glsl.js';

// FALLBACK colours when palette.js has no RIVER look yet (lane w's proposed A10 values of 24 Nov 2026)
const RIVER_FB = {
  clear: { shallow: '#93976b', body: '#6a744c' }, normal: { shallow: '#a69169', body: '#8c7852' },
  flood: { shallow: '#8f6a4a', body: '#714f34' }, foam: '#f2ede2',
};
const RIVER = PAL.RIVER || RIVER_FB;
// Display colours of the deposit and the particles (from the aerial of the drained basins, refs/weir/05)
const SAND = '#c4a679';
const MUD = '#7d6647';
const FLOOR = '#6f6b60';
const SKY = '#d9e3e8';
const PART_FINE = '#c8b089'; // a little lighter than the river's brown, so the flecks read without looking like foam
const PART_COARSE = '#dcc396';
const PLUME_LIGHT = '#b8966a';

// Display choices
const ROWS = 56; // rows along a basin (water and deposit grids)
const COLS = 12; // columns across
const PER_BASIN = 700; // particles per basin
const U_SHOW = 2.2; // display drift speed in a basin, m/s (the real mean is about 0.1 m/s at 16 m3/s)
const U_FLUSH = 7; // display speed of a flush
const DROP_LEFT = 1.1; // a flushing basin's water stands this deep over the floor (display)
const MIN_SHOW_S = 1.8; // a flush stays on screen at least this long
const PLUME_LEN = 300; // metres of river the plume is drawn over
const PLUME_RISE = 0.12; // metres above the tail level (over the river sheet)
const PLUME_DOWN = [-0.22, -1]; // downstream heading of the river below the outlet, read from river_poly (x east, z south)

// Positions plus the distance along the channel (aAlong), for the channel water; a drop-in for TriBuilder.
export class StripBuilder {
  constructor() { this.p = []; this.a = []; }
  tri(a, b, c, col, al) {
    this.p.push(...a, ...b, ...c);
    this.a.push(al ? al[0] : 0, al ? al[1] : 0, al ? al[2] : 0);
  }
  quad(a, b, c, d, col, al) {
    this.tri(a, b, c, col, al && [al[0], al[1], al[2]]);
    this.tri(a, c, d, col, al && [al[0], al[2], al[3]]);
  }
  quad2(a, b, c, d, col, al) { this.quad(a, b, c, d, col, al); }
  get triangles() { return this.p.length / 9; }
  geometry(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('aAlong', new THREE.Float32BufferAttribute(this.a, 1));
    return g;
  }
}

export function buildSediment(THREE, o) {
  const group = new THREE.Group();
  group.name = 'sediment';
  const col = (h) => new THREE.Color().setStyle(h, THREE.LinearSRGBColorSpace); // straight to the screen, as surface.js
  const sun = new THREE.Vector3(0.45, 1.0, -0.3).normalize(); // scene3d's sun
  const turbU = () => ({
    uClear: { value: col(RIVER.clear.body) }, uNormal: { value: col(RIVER.normal.body) }, uFlood: { value: col(RIVER.flood.body) },
    uClearS: { value: col(RIVER.clear.shallow) }, uNormalS: { value: col(RIVER.normal.shallow) }, uFloodS: { value: col(RIVER.flood.shallow) },
  });
  const foamCol = col(RIVER.foam || '#f2ede2');

  // ---- basins: frames, grids, volume tables ----
  const frames = o.basins.slice(0, NB).map((ring) => basinFrame(ring, o.barZ, ROWS));
  const tables = frames.map((f) => frontTable(f));
  const n = frames.length;
  const vec4s = () => Array.from({ length: NB }, () => new THREE.Vector4());
  const uB = vec4s(), uG = vec4s(), uS = vec4s();
  const lens = Array.from({ length: NB * 8 }, () => new THREE.Vector4());
  frames.forEach((f, b) => {
    uG[b].set(f.zS, f.zN, f.sbar, 0);
    for (let k = 0; k < 8; k++) lens[b * 8 + k].set(f.lens[4 * k], f.lens[4 * k + 1], f.lens[4 * k + 2], f.lens[4 * k + 3]);
  });
  const uFloor = { value: o.floorY };
  const uWater = { value: o.canalY };
  const uTime = { value: 0 };
  const shared = { uB: { value: uB }, uG: { value: uG }, uS: { value: uS }, uFloor, uWater };

  // one grid per basin: (ROWS + 1) x (COLS + 1) points; aSWB = (s, w, basin), aHW = half width of the row
  const pos = [], swb = [], hw = [], idx = [];
  frames.forEach((f, b) => {
    const base = pos.length / 3;
    for (const r of f.rows) {
      for (let j = 0; j <= COLS; j++) {
        const t = j / COLS;
        pos.push(r.x0 + (r.x1 - r.x0) * t, 0, r.z);
        swb.push(r.s, 2 * t - 1, b);
        hw.push((r.x1 - r.x0) / 2);
      }
    }
    for (let i = 0; i < f.rows.length - 1; i++) {
      for (let j = 0; j < COLS; j++) {
        const a = base + i * (COLS + 1) + j, c = a + COLS + 1;
        idx.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
  });
  const grid = new THREE.BufferGeometry();
  grid.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  grid.setAttribute('aSWB', new THREE.Float32BufferAttribute(swb, 3));
  grid.setAttribute('aHW', new THREE.Float32BufferAttribute(hw, 1));
  grid.setIndex(idx);

  const deposit = new THREE.Mesh(grid, new THREE.ShaderMaterial({
    vertexShader: DEPOSIT_VS, fragmentShader: DEPOSIT_FS, side: THREE.DoubleSide,
    uniforms: { ...shared, uSand: { value: col(SAND) }, uMud: { value: col(MUD) }, uFloorCol: { value: col(FLOOR) }, uSun: { value: sun } },
  }));
  deposit.renderOrder = -49; // after the works' walls and floor (-50), before any water (-40)
  const eyeL = new THREE.Vector3();
  const basinU = {
    ...shared, ...turbU(), uTime, uTauOut: { value: 0.3 }, uU: { value: U_SHOW }, uUf: { value: U_FLUSH },
    uSun: { value: sun }, uEye: { value: eyeL }, uSky: { value: col(SKY) }, uFoam: { value: foamCol }, uSand: { value: col(SAND) },
  };
  const water = new THREE.Mesh(grid, new THREE.ShaderMaterial({
    vertexShader: BASIN_VS, fragmentShader: BASIN_FS, uniforms: basinU, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  }));
  water.renderOrder = -40;
  // the eye in the site frame (the map's camera carries the whole view in its projection matrix)
  const e4 = new THREE.Vector4(), inv = new THREE.Matrix4();
  water.onBeforeRender = (renderer, scene, camera) => {
    e4.set(0, 0, 1, 0).applyMatrix4(camera.projectionMatrixInverse).applyMatrix4(camera.matrixWorld);
    if (Math.abs(e4.w) > 1e-12) {
      inv.copy(water.matrixWorld).invert();
      eyeL.set(e4.x / e4.w, e4.y / e4.w, e4.z / e4.w).applyMatrix4(inv);
    }
  };

  // ---- particles ----
  const pa = [], pb = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let b = 0; b < n; b++) {
    for (let i = 0; i < PER_BASIN; i++) {
      pa.push(rnd(), rnd() * 2 - 1, rnd(), rnd());
      pb.push(b);
    }
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(pb.length * 3), 3));
  pg.setAttribute('aP', new THREE.Float32BufferAttribute(pa, 4));
  pg.setAttribute('aBasin', new THREE.Float32BufferAttribute(pb, 1));
  const uPx = { value: 400 };
  const uShow = { value: 0 };
  const points = new THREE.Points(pg, new THREE.ShaderMaterial({
    vertexShader: PART_VS, fragmentShader: PART_FS, transparent: true, depthWrite: false,
    uniforms: { ...shared, uLens: { value: lens }, uTime, uU: { value: U_SHOW }, uUf: { value: U_FLUSH }, uPx, uShow,
      uFine: { value: col(PART_FINE) }, uCoarse: { value: col(PART_COARSE) } },
  }));
  points.renderOrder = -38;
  points.frustumCulled = false;
  // pixels per metre at the basins' middle, times its clip w (the shader divides by each point's own w)
  const mid = new THREE.Vector3(), c0 = new THREE.Vector4(), c1 = new THREE.Vector4(), size = new THREE.Vector2();
  if (n) {
    const f0 = frames[0], f1 = frames[n - 1];
    mid.set((f0.lens[16] + f1.lens[16]) / 2, o.canalY, (f0.zS + f0.zN) / 2);
  }
  points.onBeforeRender = (renderer, scene, camera) => {
    renderer.getDrawingBufferSize(size);
    c0.set(mid.x, mid.y, mid.z, 1).applyMatrix4(points.matrixWorld).applyMatrix4(camera.projectionMatrix);
    c1.set(mid.x + 1, mid.y, mid.z, 1).applyMatrix4(points.matrixWorld).applyMatrix4(camera.projectionMatrix);
    if (c0.w > 0 && c1.w > 0) {
      const dx = ((c1.x / c1.w - c0.x / c0.w) * size.x) / 2, dy = ((c1.y / c1.w - c0.y / c0.w) * size.y) / 2;
      uPx.value = Math.hypot(dx, dy) * c0.w;
    }
  };

  // ---- the channels' water ----
  const chan = (sb, name, level) => {
    if (!sb || !sb.triangles) return null;
    const u = { ...turbU(), uTime, uTau: { value: 0.5 }, uFlow: { value: 0.8 }, uFoamAmt: { value: 0 }, uFoam: { value: foamCol } };
    const m = new THREE.Mesh(sb.geometry(THREE), new THREE.ShaderMaterial({
      vertexShader: CHAN_VS, fragmentShader: CHAN_FS, uniforms: u, transparent: true, side: THREE.DoubleSide,
    }));
    m.renderOrder = -40;
    m.frustumCulled = false;
    m.name = name;
    m.position.y = level;
    group.add(m);
    return u;
  };
  const S = o.strips || {};
  const cFeed = chan(S.feed, 'sediment-water-feed', o.canalY);
  const cOut = chan(S.out, 'sediment-water-canal', o.canalY);
  const cFlush = chan(S.flush, 'sediment-water-flush', o.tailY);
  const cLadder = chan(S.ladder, 'sediment-water-ladder', 0);
  const chanMeshes = group.children.slice();

  // ---- the plume in the river ----
  let plume = null;
  const plumeU = { uAmt: { value: 0 }, uFront: { value: 0 }, uTime, uLen: { value: PLUME_LEN },
    uDark: { value: col(RIVER.flood.body) }, uLight: { value: col(PLUME_LIGHT) }, uFoam: { value: foamCol } };
  const fl = o.flushLine;
  if (fl && fl.length >= 2) {
    const m0 = fl[fl.length - 1], m1 = fl[Math.max(0, fl.length - 4)];
    const hx = m0[0] - m1[0], hz = m0[1] - m1[1], hl = Math.hypot(hx, hz) || 1;
    // the Komering runs north here (A1) and its right bank bends west below the outlet: the plume follows it
    const dn = Math.hypot(PLUME_DOWN[0], PLUME_DOWN[1]);
    const path = plumePath(m0, [hx / hl, hz / hl], [PLUME_DOWN[0] / dn, PLUME_DOWN[1] / dn], PLUME_LEN, 6);
    const ppos = [], puv = [], pidx = [], AC = 8;
    for (let i = 0; i < path.length; i++) {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const u = i / (path.length - 1);
      const half = 3 + 52 * Math.pow(u, 0.85); // the plume spreads as it goes (display shape)
      for (let j = 0; j <= AC; j++) {
        const v = (2 * j) / AC - 1;
        ppos.push(path[i][0] - dz * half * v, 0, path[i][1] + dx * half * v);
        puv.push(u, v);
      }
    }
    for (let i = 0; i < path.length - 1; i++) {
      for (let j = 0; j < AC; j++) {
        const a = i * (AC + 1) + j, c = a + AC + 1;
        pidx.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(ppos, 3));
    g.setAttribute('aUV', new THREE.Float32BufferAttribute(puv, 2));
    g.setIndex(pidx);
    plume = new THREE.Mesh(g, new THREE.ShaderMaterial({
      vertexShader: PLUME_VS, fragmentShader: PLUME_FS, uniforms: plumeU, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16, side: THREE.DoubleSide,
    }));
    plume.renderOrder = 8; // after the river sheets (5) and the weir's own water (6, 7)
    plume.frustumCulled = false;
    plume.position.y = o.tailY + PLUME_RISE;
    plume.visible = false;
    plume.name = 'sediment-plume';
  }

  for (const m of [deposit, water]) { m.frustumCulled = false; group.add(m); }
  group.add(points);
  if (plume) group.add(plume);
  deposit.name = 'sediment-deposit';
  water.name = 'sediment-basin-water';
  points.name = 'sediment-particles';

  // ---- state: what the store says, and what is on screen ----
  const maxD = Math.max(0.5, o.depth - 1.4); // the delta keeps 1.4 m of water over it (display; then it holds less)
  const vis = frames.map(() => ({ vol: null, flush: 0, linger: 0, flushes: null, state: 'settling', fq: 1 }));
  const want = { basins: [], storage: null, cRiver: null, cIntake: null, cCanal: null, qFlush: 0 };
  let D = frames.map(() => 0);
  let plumeAmt = 0, plumeFront = 0, flushChan = 0;

  function setState(sed) {
    if (!sed) return;
    want.basins = Array.isArray(sed.basins) ? sed.basins : [];
    want.cRiver = sed.c_river_mgL;
    want.cIntake = sed.c_intake_mgL;
    want.cCanal = sed.c_canal_mgL;
    if (Number.isFinite(sed.storage_m3) && sed.storage_m3 !== want.storage) {
      want.storage = sed.storage_m3;
      D = tables.map((t) => fullThickness(t, sed.storage_m3, maxD).D);
      frames.forEach((f, b) => (uG[b].w = D[b]));
    }
  }

  function setLevels({ canal_y, tail_y, tail_floor } = {}) {
    if (Number.isFinite(canal_y)) {
      uWater.value = canal_y;
      for (const m of chanMeshes) if (m.name !== 'sediment-water-flush' && m.name !== 'sediment-water-ladder') m.position.y = canal_y;
    }
    if (Number.isFinite(tail_y)) {
      const fm = chanMeshes.find((m) => m.name === 'sediment-water-flush');
      if (fm) fm.position.y = Number.isFinite(tail_floor) ? Math.max(tail_y, tail_floor) : tail_y;
      if (plume) plume.position.y = tail_y + PLUME_RISE;
    }
  }

  const glide = (cur, target, tau, dt) => cur + (target - cur) * (1 - Math.exp(-dt / tau));

  function update(dt = 0, t) {
    if (Number.isFinite(t)) uTime.value = t;
    else uTime.value += dt;
    const tRiver = turbidity(want.cRiver);
    const ratio = want.cIntake > 0 && Number.isFinite(want.cCanal) ? want.cCanal / want.cIntake : 1;
    // the intake draws the pond's own surface water: the feed and a basin's inlet look like the river; the outlet and
    // the canal take the colour of the canal water's own concentration. Display: that clearing is stronger than the
    // canal/intake ratio alone (sand makes water look muddier than its share of the mass), so the settling is seen.
    const tIn = want.cIntake > 0 ? tRiver : turbidity((want.cRiver || 0) * 0.5);
    const tOut = want.cIntake > 0 && Number.isFinite(want.cCanal) ? turbidity(want.cCanal) : turbidity((want.cRiver || 0) * ratio * 0.5);
    basinU.uTauOut.value = tOut;
    uShow.value = want.cIntake > 0 ? Math.min(1, Math.max(0.2, want.cIntake / 500)) : 0; // display: more particles in muddier water
    let anyFlush = 0;
    for (let b = 0; b < n; b++) {
      const s = want.basins[b] || {};
      const v = vis[b];
      const flushing = s.state === 'flushing';
      if (Number.isFinite(s.flushes)) {
        if (v.flushes != null && s.flushes > v.flushes) v.linger = MIN_SHOW_S; // a flush began and ended between two looks
        v.flushes = s.flushes;
      }
      if (flushing && v.state !== 'flushing') v.linger = MIN_SHOW_S;
      v.state = s.state;
      v.linger = Math.max(0, v.linger - dt);
      const target = flushing || v.linger > 0 ? 1 : 0;
      v.flush = glide(v.flush, target, target > v.flush ? 0.35 : 0.8, dt);
      if (v.flush < 0.002) v.flush = 0;
      const vol = Number.isFinite(s.deposit_m3) ? s.deposit_m3 : 0;
      v.vol = v.vol == null ? vol : glide(v.vol, vol, vol < v.vol ? 0.7 : 0.3, dt);
      v.fq = Number.isFinite(s.q_m3s) ? glide(v.fq, s.q_m3s / 16, 0.5, dt) : v.fq; // display: flow / design flow (16 m3/s)
      const F = D[b] > 0 ? frontFor(tables[b], v.vol / D[b]) : 0;
      const drop = Math.max(0, uWater.value - (o.floorY + DROP_LEFT));
      uB[b].set(tIn, v.flush, v.flush * drop, F);
      uS[b].set(Math.min(1, v.flush * 1.1), v.fq, 0, 0);
      anyFlush = Math.max(anyFlush, v.flush);
    }
    // the flushing channel runs brown at once; the plume follows and lingers in the river
    flushChan = glide(flushChan, anyFlush, 0.4, dt);
    if (cFlush) {
      cFlush.uTau.value = Math.max(tRiver, flushChan * 1.0);
      cFlush.uFlow.value = 0.15 + 5 * flushChan;
      cFlush.uFoamAmt.value = 0.45 * flushChan;
    }
    if (cFeed) { cFeed.uTau.value = tIn; cFeed.uFlow.value = want.cIntake > 0 ? 1.4 : 0.05; }
    if (cOut) { cOut.uTau.value = tOut; cOut.uFlow.value = want.cIntake > 0 ? 1.2 : 0.05; }
    if (cLadder) { cLadder.uTau.value = tRiver; cLadder.uFlow.value = 0.6; }
    plumeAmt = glide(plumeAmt, flushChan > 0.05 ? 1 : 0, flushChan > 0.05 ? 0.8 : 2.5, dt);
    if (plumeAmt > 0.03) plumeFront = Math.min(1.3, plumeFront + dt * 0.3);
    else plumeFront = 0;
    if (plume) {
      plumeU.uAmt.value = plumeAmt;
      plumeU.uFront.value = plumeFront;
      plume.visible = plumeAmt > 0.01;
    }
  }

  const triangles = idx.length / 3 * 2 + (plume ? plume.geometry.index.count / 3 : 0)
    + ['feed', 'out', 'flush', 'ladder'].reduce((s, k) => s + ((S[k] && S[k].triangles) || 0), 0);
  update(0, 0);
  return { group, setState, setLevels, update, triangles, frames };
}
