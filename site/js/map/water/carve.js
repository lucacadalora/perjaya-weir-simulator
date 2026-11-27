// The weir's pond and tailwater over the carved river bed (lane g07's `feat/carve.json`). Owner: lane b06.
// When the terrain tiles carry a carved bed, the sheets are plain flat water (no lifting over a surface-model river):
// each covers its carve polygon grown by about 250 m, the terrain's depth cuts the shoreline (A3) so a rising level
// spreads up the banks by itself, and the far end of each reach fades out over its last 500 m.

import { cropGround, riverFloor, rasterPolygons, splitByAxis, maskBytes, dilate, polygonsOf, polygonsBox, bboxFromDegrees } from './masks.js';
import { flowField } from './flowfield.js';
import { JOIN } from './join.js';

const GROW_M = 15; // how far a sheet reaches beyond its carved outline: water stays in the river (lead fix round, 23 Nov); overbank flooding is b07's tint
const FADE_M = 500; // the last stretch of each reach fades to nothing (lead, 23 Nov)
const SUB = 3; // mask sub-cells per 30 m ground cell

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const val = (x) => (x && typeof x === 'object' && 'v' in x ? x.v : x);

// pick the polygons and bed levels out of carve.json, tolerant of its exact shape
export function readCarve(carve) {
  if (!carve || typeof carve !== 'object') return null;
  const P = carve.polygons || {};
  const pond = polygonsOf(P.pond);
  const tail = polygonsOf(P.tail);
  if (!pond.length || !tail.length) return null;
  // bed levels in terrain metres: a number per side, or a list of {.., bed_m} stations (the deepest is used)
  const bedOf = (side) => {
    const lm = carve.levels_model_m || {};
    const cands = [side === 'pond' ? lm.bed_up : lm.bed_down, carve.bed?.[side], carve.beds?.[side], carve.bed_m?.[side], carve.levels?.[side + '_bed'], carve.levels?.[side + '_bed_m'],
      carve[side + '_bed_m'], carve[side + '_bed'], carve.bed?.[side + '_m']];
    for (const c of cands) {
      const v = val(c);
      if (isNum(v)) return v;
      if (Array.isArray(v)) {
        const nums = v.map((x) => (isNum(x) ? x : val(x?.bed_m ?? x?.bed ?? x?.z ?? x?.el))).filter(isNum);
        if (nums.length) return Math.min(...nums);
      }
    }
    return null;
  };
  const lm = carve.levels_model_m || {};
  // the surface model's own river surface beside the axis: the tail sheet lies on that surface at this level
  const surf = { pond: isNum(lm.pond_surface_dsm) ? lm.pond_surface_dsm : null, tail: isNum(lm.tail_surface_dsm) ? lm.tail_surface_dsm : null };
  return { pond, tail, bed: { pond: bedOf('pond'), tail: bedOf('tail') }, surf, axis: carve.axis || null };
}

// deps: {ctx, meta, dem, lon, lat, bearing, pondSide ('a' south | 'b'), dry: {up, down} metres, placeSheet, live}
export function buildCarveSheets(cv, deps) {
  const { meta, dem, lon, lat, bearing, pondSide, dry, pit, placeSheet, live } = deps;
  const c = meta.cell ?? meta.cellsize_deg;
  const box = polygonsBox([...cv.pond, ...cv.tail]);
  const padDeg = (GROW_M + 100) / 111000;
  const bbox = bboxFromDegrees(meta, Math.min(box[0], lon) - padDeg, Math.min(box[1], lat) - padDeg, Math.max(box[2], lon) + padDeg, Math.max(box[3], lat) + padDeg);
  const ground = cropGround(dem, meta, bbox);
  const C = ground.cols;
  const R = ground.rows;
  const MC = C * SUB;
  const MR = R * SUB;
  const sub = { west: meta.west + bbox[0] * c, north: meta.north - bbox[1] * c, cols: MC, rows: MR, cellsize_deg: c / SUB };
  const cellM = (c * Math.PI * 6378137) / 180 / SUB;
  const axC = ((lon - meta.west) / c - bbox[0]) * SUB;
  const axR = ((meta.north - lat) / c - bbox[1]) * SUB;
  const t = (bearing * Math.PI) / 180;
  const nx = Math.cos(t);
  const nz = Math.sin(t); // side a normal in (east, south)
  const gapUp = dry.up / cellM;
  const gapDown = dry.down / cellM;
  const gA = pondSide === 'a' ? gapUp : gapDown;
  const gB = pondSide === 'a' ? gapDown : gapUp;

  const out = {};
  for (const k of ['pond', 'tail']) {
    const poly = rasterPolygons(cv[k], sub, [0, 0, MC - 1, MR - 1]);
    // The terrain is also dug out under the weir and a little around it (carve.json levels_model_m.weir_pit), wider
    // than the river outline at both abutments: that pit holds water too (the intake's forebay on the right bank)
    if (pit) {
      const along0 = k === 'pond' ? 0 : -pit.down;
      const along1 = k === 'pond' ? pit.up : 0;
      const sgn = pondSide === 'a' ? 1 : -1; // side a's normal points upstream when the pond is on side a
      for (let r = 0; r < MR; r++) for (let q = 0; q < MC; q++) {
        const ex = (q + 0.5 - axC) * cellM;
        const ez = (r + 0.5 - axR) * cellM;
        const across = ex * Math.sin(t) - ez * Math.cos(t); // metres along the axis from its centre
        const up = sgn * (ex * nx + ez * nz); // metres upstream of the axis
        if (Math.abs(across) <= pit.half && up >= along0 && up <= along1) poly[r * MC + q] = 1;
        // the pocket of the pond in front of the intake (pond only): see WEIR_POCKET in water.js
        const pk = k === 'pond' ? pit.pocket : null;
        if (pk && across >= pk.a0 && across <= pk.a1 && up >= pk.up0 && up <= pk.up1) poly[r * MC + q] = 1;
      }
    }
    const grown = dilate(poly, MC, MR, GROW_M / cellM);
    const sides = splitByAxis(grown, MC, MR, axC, axR, bearing, gA, gB);
    const isA = (k === 'pond') === (pondSide === 'a');
    const mask = isA ? sides.a : sides.b;
    // depth shading from the carved bed: inside the outline the ground is at most the bed level
    const g = Float32Array.from(ground.ground);
    const bed = cv.bed[k];
    if (isNum(bed)) {
      for (let r = 0; r < MR; r++) for (let q = 0; q < MC; q++) {
        if (!poly[r * MC + q]) continue;
        const i = ((r / SUB) | 0) * C + ((q / SUB) | 0);
        if (g[i] > bed) g[i] = bed;
      }
    }
    // The river surface is not flat (about 80 m 5 km upstream, 70 m 5 km downstream: carve.json). The pond lies at
    // max(level, that surface): a backwater that never sinks under the river. The tail is that surface moved up or
    // down with the level (it lies on it at the surface model's own tail level). Surface = a low percentile of the
    // uncarved surface model inside the outline, spread over the grown margin.
    const chan = new Uint8Array(C * R);
    for (let r = 0; r < MR; r++) for (let q = 0; q < MC; q++) if (poly[r * MC + q]) chan[((r / SUB) | 0) * C + ((q / SUB) | 0)] = 1;
    const floor = riverFloor(ground.ground, C, R, chan, { radius: 5, pct: 0.1, spread: Math.ceil(GROW_M / (cellM * SUB)) + 2 });
    const tailShift = k === 'tail' && isNum(cv.surf?.tail);
    let gmin = Infinity;
    for (const v of g) if (v < gmin) gmin = v;
    // how far the reach runs from the axis (metres along its own direction, from the outline, not the grown edge)
    const sign = isA ? 1 : -1;
    let reach = 0;
    for (let r = 0; r < MR; r++) for (let q = 0; q < MC; q++) {
      if (!poly[r * MC + q]) continue;
      const d = sign * ((q + 0.5 - axC) * nx + (r + 0.5 - axR) * nz) * cellM;
      if (d > reach) reach = d;
    }
    // the current: walk the channel from the weir (water/flowfield.js); it runs towards the weir in the pond and
    // away from it below
    const cut = k === 'pond' ? JOIN.up : JOIN.down;
    const seeds = [];
    const near = (cut + 40) / cellM;
    for (let r = 0; r < MR; r++) for (let q = 0; q < MC; q++) {
      if (!mask[r * MC + q]) continue;
      const d = sign * ((q + 0.5 - axC) * nx + (r + 0.5 - axR) * nz);
      if (d <= near) seeds.push([q, r, Math.max(0, d)]);
    }
    const flow = seeds.length ? flowField(mask, MC, MR, seeds, { away: k === 'tail', step: 2 }) : null;
    const entry = placeSheet(meta, bbox, { ground: g, cols: C, rows: R, min: gmin }, maskBytes(mask, null, MC), 'weir:' + k,
      { depthScale: 5, maskCols: MC, maskRows: MR, floor, lift: 0.3, minDepth: 0, opacity: 1, flow,
        hugShift: tailShift, hugRef: tailShift ? cv.surf.tail : 0 });
    const ax = (axC / MC - 0.5) * entry.width_m;
    const az = (axR / MR - 0.5) * entry.height_m;
    if (reach > FADE_M) entry.sheet.setFade(ax, az, sign * nx, sign * nz, reach - FADE_M, reach);
    // the sheet stops on the line where the weir's own water takes over, and is flat at the level beside it
    entry.sheet.setCut(ax + sign * nx * cut, az + sign * nz * cut, sign * nx, sign * nz, JOIN.flat);
    // the weir axis in this sheet's metres (its direction: compass bearing `bearing`, in east and south)
    entry.axis = { x: ax, z: az, dx: Math.sin(t), dz: -Math.cos(t) };
    entry.flow_cells = flow ? flow.reached : 0;
    entry.kind = 'weir-' + k;
    live.add(entry);
    out[k] = entry;
    out[k + '_reach_m'] = Math.round(reach);
    out[k + '_bed'] = bed;
  }
  out.info = { source: 'carve', bbox, cols: C, rows: R, mask_sub: SUB, pond_reach_m: out.pond_reach_m, tail_reach_m: out.tail_reach_m,
    pond_flow_cells: out.pond.flow_cells, tail_flow_cells: out.tail.flow_cells,
    pond_bed: out.pond_bed, tail_bed: out.tail_bed };
  return out;
}
