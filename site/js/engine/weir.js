// Weir hydraulics engine (lane b14): gates, sluices, crest overflow, intake, tailwater, pond solve, auto operation.
// Pure functions, no DOM, no imports. Method: KP-02 2013 (Kriteria Perencanaan Bangunan Utama) as in
// plan/P2-engines-spec-draft.md section E3.
//
// LEVELS. Every `*_el` here is project EL (the datum of the project documents). The engine never adds the terrain
// offset (CONTRACT 2.3); `params.datum.offset_m` is applied only by the 3D scene.
//
// CONSTANTS. No site fact lives in this file. Every level, size and coefficient comes in `weirParams`
// (built from site/data/weir.json and params.json, see `weirParamsFromData`). The only numbers below are physics
// (gravity, used only when weirParams.g is absent), formula constants of published methods (Villemonte's
// submergence exponents, the hydraulic-jump conjugate formula) and numeric tolerances.
//
// weirParams shape (all plain numbers; levels in project EL, lengths in m, flows in m3/s):
// {
//   g?,                                   gravity (default 9.81, physics)
//   levels: { pond_target_el, design_high_water_el, deck_el, bed_el },
//   gates:   [7 x { id, width_m, height_m (leaf), sill_el, lift_max_m? }]   gate 1 first (FG1..FG7)
//   sluices: [3 x { id, width_m, height_m (upper + lower leaf), sill_el, lift_max_m? }]   SG/UG 1..3
//   intake:  { width_m, sill_el, gate_height_m, canal_wl_el, mu, capacity_m3s, capacity_max_m3s }
//   hyd:     { crest_cd, gate_mu, top_cd?, pier_kp, abut_ka, weir_length_m }
//   tail:    { bed_el, width_m, side_z, n, slope }          Manning section just below the weir
//   ops:     { gate_order [gate numbers, 1-based], first_opening_m, step_m, flood_step_m, q_env_m3s }
//   pond_area_m2?                                           pond surface for storage routing (else steady state)
// }

const G_DEFAULT = 9.81;           // physics: gravity, m/s2
const VILLEMONTE_N = 1.5;          // formula constant: weir exponent in Villemonte (1947)
const VILLEMONTE_P = 0.385;        // formula constant: Villemonte (1947)
const EPS = 1e-9;                  // numeric tolerance
// Shape of the hand-over from gate-controlled to free-surface flow as the lip nears the water: the open-bay flow is
// scaled by (a / h1)^LIP_SHAPE, so a bay passes more with every centimetre of lift until its lip leaves the water.
// A numeric stand-in (KP-02 gives no formula for the transition), not a site fact; it keeps auto openings continuous.
const LIP_SHAPE = 0.5;
const BISECT_ITERS = 60;           // numeric

const gOf = (p) => (p && Number.isFinite(p.g) ? p.g : G_DEFAULT);
const pos = (x) => (x > 0 ? x : 0);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// ---------------------------------------------------------------------------------------------------------------
// Element formulas

/** KP-02 eq 4-1: effective crest width Be = B - 2 (n Kp + Ka) H1. */
export function effectiveWidth({ B_m, n_piers = 0, Kp = 0, Ka = 0, H1_m }) {
  return pos(B_m - 2 * (n_piers * Kp + Ka) * pos(H1_m));
}

/** Villemonte submergence factor for a crest: f = (1 - (H2/H1)^n)^p, H2 = tail head over the crest. */
export function submergenceFactor(ratio) {
  if (!(ratio > 0)) return 1;
  if (ratio >= 1) return 0;
  return Math.pow(1 - Math.pow(ratio, VILLEMONTE_N), VILLEMONTE_P);
}

/**
 * KP-02 eq 4-2: Q = Cd (2/3) sqrt((2/3) g) Be H1^1.5, times the submergence factor.
 * `submergence` is the ratio H2/H1 (tail head over upstream head, both above the crest); `factor` overrides it.
 */
export function crestFlow({ width_m, head_m, cd, submergence = 0, factor, g = G_DEFAULT }) {
  const H = pos(head_m);
  if (!(H > 0) || !(width_m > 0)) return 0;
  const f = isNum(factor) ? factor : submergenceFactor(submergence);
  return cd * (2 / 3) * Math.sqrt((2 / 3) * g) * width_m * Math.pow(H, 1.5) * f;
}

/** KP-02 eq 5-3, intake: Q = mu b a sqrt(2 g z), z = head across the opening. */
export function intakeFlow({ mu, b_m, a_m, z_m, g = G_DEFAULT }) {
  if (!(a_m > 0) || !(b_m > 0) || !(z_m > 0)) return 0;
  return mu * b_m * a_m * Math.sqrt(2 * g * z_m);
}

/** Energy form of the underflow gate with contraction Cc: Q = b Cc a sqrt(2 g (h1 - Cc a) / (1 - (Cc a / h1)^2)). */
export function gateFlowEnergy({ Cc, a_m, b_m, h1_m, g = G_DEFAULT }) {
  const y1 = Cc * a_m;
  if (!(a_m > 0) || !(h1_m > y1)) return 0;
  return b_m * y1 * Math.sqrt((2 * g * (h1_m - y1)) / (1 - (y1 / h1_m) ** 2));
}

/** Manning, trapezoid: Q = (1/n) A R^(2/3) S^(1/2). */
export function manningQ({ b_m, side_z = 0, y_m, n, S }) {
  const y = pos(y_m);
  if (!(y > 0)) return 0;
  const A = (b_m + side_z * y) * y;
  const P = b_m + 2 * y * Math.sqrt(1 + side_z * side_z);
  return (1 / n) * A * Math.pow(A / P, 2 / 3) * Math.sqrt(S);
}

/**
 * One gate bay. Heads are measured from the sill: h_up_m = pond above sill, h_down_m = tail above sill.
 *  type 'sluice' | 'radial': underflow gate, KP-02 eq 4-42 Q = K mu a b sqrt(2 g h1). Free while the tail is
 *    below the conjugate depth of the jet (Cc a, Cc = `cc` or the mu itself); above it K falls continuously to 0 at
 *    h2 = h1 (a stand-in for KP-02 Gambar 4-48, which exists only as a graph). The gate never passes more than the
 *    open bay would: once the lip is clear of the water the bay works as a crest over the sill (regime 'open').
 *  type 'flap': overflow over the flap crest; h_up_m and h_down_m are heads over that crest, opening_m is unused.
 * `cd` is mu for an underflow gate and the crest Cd for a flap; `crest_cd` is the open bay's Cd (without it an
 * underflow gate is the plain orifice until its lip leaves the water, then a crest with `cd`);
 * `crest_width_m` (optional) is the bay's effective width when it works as a crest (KP-02 eq 4-1).
 * Returns { q_m3s, regime: 'closed' | 'free' | 'submerged' | 'open' | 'open-submerged' | 'overflow' }.
 */
export function gateFlow({ type = 'sluice', opening_m, width_m, h_up_m, h_down_m = 0, cd, crest_cd, crest_width_m, cc, g = G_DEFAULT }) {
  const h1 = pos(h_up_m);
  const h2 = pos(h_down_m);
  if (type === 'flap') {
    const q = crestFlow({ width_m, head_m: h1, cd, submergence: h1 > 0 ? h2 / h1 : 0, g });
    return { q_m3s: q, regime: q > 0 ? (h2 > 0 ? 'open-submerged' : 'overflow') : 'closed' };
  }
  const a = pos(opening_m);
  if (!(a > 0) || !(h1 > 0) || h2 >= h1) return { q_m3s: 0, regime: 'closed' };
  const ccd = isNum(crest_cd) ? crest_cd : cd;
  const cw = isNum(crest_width_m) ? crest_width_m : width_m;
  const qOpen = crestFlow({ width_m: cw, head_m: h1, cd: ccd, submergence: h2 / h1, g });
  if (a >= h1) return { q_m3s: qOpen, regime: h2 > 0 ? 'open-submerged' : 'open' };
  const qFree = cd * a * width_m * Math.sqrt(2 * g * h1);
  // conjugate depth of the contracted jet y1 = Cc a
  const y1 = (isNum(cc) ? cc : cd) * a;
  const v1 = qFree / (width_m * y1);
  const fr1 = v1 / Math.sqrt(g * y1);
  const y2 = (y1 / 2) * (Math.sqrt(1 + 8 * fr1 * fr1) - 1);
  let K = 1;
  let regime = 'free';
  if (h2 > y2 && y2 < h1) {
    K = Math.sqrt(pos(h1 - h2) / (h1 - y2));
    regime = 'submerged';
  }
  const qUnder = K * qFree;
  // the open-bay cap needs the crest Cd; without `crest_cd` the gate is the plain KP-02 eq 4-42 orifice
  const qLip = isNum(crest_cd) ? qOpen * Math.pow(a / h1, LIP_SHAPE) : Infinity;
  if (qLip < qUnder) return { q_m3s: qLip, regime: h2 > 0 ? 'open-submerged' : 'open' };
  return { q_m3s: qUnder, regime };
}

// ---------------------------------------------------------------------------------------------------------------
// Tailwater

/** Tail level (project EL) for a flow below the weir, by Manning on the section in weirParams.tail. */
export function tailwater(q_m3s, weirParams) {
  const t = weirParams.tail;
  const q = pos(q_m3s);
  if (!(q > 0)) return t.bed_el;
  const Q = (y) => manningQ({ b_m: t.width_m, side_z: t.side_z, y_m: y, n: t.n, S: t.slope });
  let hi = 1;
  while (Q(hi) < q && hi < 1e4) hi *= 2;
  let lo = 0;
  for (let i = 0; i < BISECT_ITERS; i++) {
    const mid = (lo + hi) / 2;
    if (Q(mid) < q) lo = mid; else hi = mid;
  }
  return t.bed_el + (lo + hi) / 2;
}

/** Rating table of the tail section: { q_m3s[], tail_el[] } for the flows given. */
export function rating(weirParams, flows) {
  return { q_m3s: flows.slice(), tail_el: flows.map((q) => tailwater(q, weirParams)) };
}

// ---------------------------------------------------------------------------------------------------------------
// The whole structure at one pond level and one tail level

const LEVEL_TOL = 0.005; // numeric: levels closer than 5 mm count as equal for alerts

/** Full lift of a bay: its own `lift_max_m`, else the lift that puts the gate lip at the design high water. */
export function fullLift(bay, weirParams) {
  if (isNum(bay.lift_max_m)) return bay.lift_max_m;
  return pos(weirParams.levels.design_high_water_el - bay.sill_el);
}

function bayFlow(bay, opening, H, T, p, isEnd) {
  const hyd = p.hyd;
  const g = gOf(p);
  const h1 = H - bay.sill_el;
  const h2 = T - bay.sill_el;
  const crestCd = hyd.crest_cd;
  const ka = isEnd ? hyd.abut_ka || 0 : 0;
  const be = effectiveWidth({ B_m: bay.width_m, n_piers: isEnd ? 0.5 : 1, Kp: hyd.pier_kp || 0, Ka: ka, H1_m: pos(h1) });
  const under = gateFlow({
    type: 'sluice', opening_m: opening, width_m: bay.width_m, crest_width_m: be,
    h_up_m: h1, h_down_m: h2, cd: hyd.gate_mu, crest_cd: crestCd, g,
  });
  // water over the top of the leaf (the flap crest) when the pond is above it
  const top = bay.sill_el + pos(opening) + bay.height_m;
  let over = 0;
  if (H > top && pos(opening) < h1) {
    const head = H - top;
    over = crestFlow({ width_m: bay.width_m, head_m: head, cd: isNum(hyd.top_cd) ? hyd.top_cd : crestCd,
      submergence: pos(T - top) / head, g });
  }
  return { under: under.q_m3s, over, regime: under.regime };
}

/** Intake flow at pond level H for an opening fraction, capped by the demand (if given) and the maximum capacity. */
export function intakeAt(H, intake_open, demand_m3s, weirParams) {
  const k = weirParams.intake;
  const a = Math.min(pos(intake_open) * k.gate_height_m, pos(H - k.sill_el));
  let q = intakeFlow({ mu: k.mu, b_m: k.width_m, a_m: a, z_m: H - k.canal_wl_el, g: gOf(weirParams) });
  if (isNum(k.capacity_max_m3s)) q = Math.min(q, k.capacity_max_m3s);
  if (isNum(demand_m3s)) q = Math.min(q, pos(demand_m3s));
  return q;
}

/**
 * Flows through the structure for pond level H and tail level T (both project EL).
 * Returns { q_gates, q_sluices, q_spill, q_down, gate_q[], sluice_q[], regimes[] }.
 */
export function structureFlows(H, T, gates, sluices, weirParams) {
  const p = weirParams;
  const nG = p.gates.length;
  const nS = p.sluices.length;
  const gate_q = new Array(nG).fill(0);
  const sluice_q = new Array(nS).fill(0);
  const regimes = [];
  let q_gates = 0, q_sluices = 0, q_spill = 0;
  for (let i = 0; i < nG; i++) {
    const f = bayFlow(p.gates[i], gates[i] || 0, H, T, p, i === 0);
    gate_q[i] = f.under + f.over;
    q_gates += f.under;
    q_spill += f.over;
    regimes.push(f.regime);
  }
  for (let j = 0; j < nS; j++) {
    const f = bayFlow(p.sluices[j], sluices[j] || 0, H, T, p, j === nS - 1);
    sluice_q[j] = f.under + f.over;
    q_sluices += f.under;
    q_spill += f.over;
    regimes.push(f.regime);
  }
  const deck = p.levels.deck_el;
  if (isNum(deck) && H > deck && isNum(p.hyd.weir_length_m)) {
    const head = H - deck;
    q_spill += crestFlow({ width_m: p.hyd.weir_length_m, head_m: head, cd: p.hyd.crest_cd,
      submergence: pos(T - deck) / head, g: gOf(p) });
  }
  return { q_gates, q_sluices, q_spill, q_down: q_gates + q_sluices + q_spill, gate_q, sluice_q, regimes };
}

/** Tail level that agrees with the flow the structure passes at pond H (Manning section below the weir). */
function tailFor(H, gates, sluices, p) {
  const t = p.tail;
  const qM = (T) => manningQ({ b_m: t.width_m, side_z: t.side_z, y_m: T - t.bed_el, n: t.n, S: t.slope });
  let lo = t.bed_el;
  let hi = Math.max(H, t.bed_el);
  if (structureFlows(H, lo, gates, sluices, p).q_down <= EPS) return lo;
  // g(T) = qManning(T) - qDown(H, T) rises with T; g(lo) < 0 here, raise hi until g(hi) >= 0
  for (let k = 0; k < 20 && qM(hi) < structureFlows(H, hi, gates, sluices, p).q_down; k++) hi += 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (qM(mid) < structureFlows(H, mid, gates, sluices, p).q_down) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function lowestLevel(p) {
  let lo = Math.min(p.tail.bed_el, p.intake.sill_el, p.intake.canal_wl_el);
  for (const b of p.gates) lo = Math.min(lo, b.sill_el);
  for (const b of p.sluices) lo = Math.min(lo, b.sill_el);
  return lo;
}

// ---------------------------------------------------------------------------------------------------------------
// Automatic operation

/**
 * Openings for a point x along the operating sequence (see autoGates). `plat` is the common lift at which the flood
 * gates stop passing more water (the lip has left the water); the sequence never jumps past it.
 */
function sequenceOpenings(stage, x, p, plat = Infinity, splat = Infinity) {
  const nG = p.gates.length;
  const ops = p.ops || {};
  const order = (ops.gate_order && ops.gate_order.length ? ops.gate_order : p.gates.map((_, i) => i + 1))
    .map((n) => n - 1).filter((i) => i >= 0 && i < nG);
  const a0 = isNum(ops.first_opening_m) ? ops.first_opening_m : 0;
  const gates = new Array(nG).fill(0);
  const sluices = new Array(p.sluices.length).fill(0);
  const lifts = p.gates.map((b) => fullLift(b, p));
  if (stage < order.length) {
    // stage k: the first k gates in the order at the first opening, gate k+1 opening from 0 to it
    for (let k = 0; k < stage; k++) gates[order[k]] = Math.min(a0, lifts[order[k]]);
    gates[order[stage]] = Math.min(x, lifts[order[stage]]);
  } else if (stage === order.length) {
    // all gates raised together from the first opening to the lift where their flow stops rising
    for (const i of order) gates[i] = Math.min(Math.max(a0, x), plat, lifts[i]);
  } else {
    // flood: the gates stay at that lift, the sluices rise together to the lift where their flow stops rising
    for (const i of order) gates[i] = Math.min(plat, lifts[i]);
    p.sluices.forEach((b, j) => { sluices[j] = Math.min(pos(x), splat, fullLift(b, p)); });
  }
  return { gates, sluices };
}

function stageRange(stage, p, plat = Infinity, splat = Infinity) {
  const ops = p.ops || {};
  const a0 = isNum(ops.first_opening_m) ? ops.first_opening_m : 0;
  const nOrder = (ops.gate_order && ops.gate_order.length) ? ops.gate_order.length : p.gates.length;
  if (stage < nOrder) return [0, a0];
  if (stage === nOrder) return [a0, Math.min(plat, Math.max(...p.gates.map((b) => fullLift(b, p))))];
  return [0, Math.min(splat, Math.max(...p.sluices.map((b) => fullLift(b, p))))];
}

/**
 * Past the last stage nothing more can be opened that adds flow, so the pond rises. The leaves then go on from
 * where their flow stopped rising to full lift in step with the pond's rise from the target to the design high
 * water, so the openings stay continuous in the flow (A8.7) and are all at full lift by the design high water.
 */
function floodRamp(H, base, p) {
  const lv = p.levels;
  const span = lv.design_high_water_el - lv.pond_target_el;
  const f = span > 0 ? Math.min(1, pos((H - lv.pond_target_el) / span)) : 1;
  return {
    gates: base.gates.map((a, i) => a + f * pos(fullLift(p.gates[i], p) - a)),
    sluices: base.sluices.map((a, j) => a + f * pos(fullLift(p.sluices[j], p) - a)),
  };
}

/** Intake opening fraction that passes q at pond level H (1 when even a full opening cannot). */
function intakeOpenFor(q, H, p) {
  const k = p.intake;
  if (!(q > 0)) return 0;
  const z = H - k.canal_wl_el;
  const depth = H - k.sill_el;
  if (!(z > 0) || !(depth > 0) || !(k.gate_height_m > 0)) return 1;
  const a = q / (k.mu * k.width_m * Math.sqrt(2 * gOf(p) * z));
  return Math.min(1, a / k.gate_height_m);
}

/**
 * Hold the pond at levels.pond_target_el. The river keeps its maintenance flow first (CONTRACT A7.4): the intake
 * takes min(demand, operating cap intake.target_m3s, max(0, inflow - ops.q_env_m3s)) (A7.5); the gates pass the rest
 * in the operating order of ops.gate_order: the first gate to ops.first_opening_m, then the next ones to the same
 * opening, then all raised together until their flow stops rising, then (a flood) the sluices rise together while
 * the gates go on to full lift, so every opening is continuous in the flow (A8.7). There is no separate flap stage
 * (A7.6): the first gate opens continuously from 0, so the pond holds its level from the smallest flow on.
 * Openings are continuous (the operating steps ops.step_m are not imposed).
 * Returns { gates[7], sluices[3], intake_open, intake_q (the intake flow it allows), stage:
 *   'closed'|'gates'|'all_gates'|'flood'|'flood_full' }.
 */
export function autoGates({ q_in, demand_m3s, weirParams, pond_el }) {
  const p = weirParams;
  if (!p || !p.levels || !p.gates || !p.tail) return null;
  const H = p.levels.pond_target_el;
  const qIn = pos(q_in);
  const k = p.intake;
  const ops = p.ops || {};
  const cap = Math.min(isNum(k.target_m3s) ? k.target_m3s : Infinity,
    isNum(k.capacity_m3s) ? k.capacity_m3s : Infinity, isNum(k.capacity_max_m3s) ? k.capacity_max_m3s : Infinity);
  const want = isNum(demand_m3s) ? pos(demand_m3s) : (Number.isFinite(cap) ? cap : 0);
  const env = isNum(ops.q_env_m3s) ? ops.q_env_m3s : 0;
  const qInt = Math.min(want, cap, pos(qIn - env));
  const intake_open = intakeOpenFor(qInt, H, p);
  const intake_q = intakeAt(H, intake_open, qInt, p);
  const qg = pos(qIn - intake_q);
  const closed = { gates: new Array(p.gates.length).fill(0), sluices: new Array(p.sluices.length).fill(0) };
  if (!(qg > EPS)) return { ...closed, intake_open, intake_q: qInt, stage: 'closed' };
  const T = tailwater(qg, p);
  const capAt = (o) => structureFlows(H, T, o.gates, o.sluices, p).q_down;
  const nOrder = (ops.gate_order && ops.gate_order.length) ? ops.gate_order.length : p.gates.length;
  const lastStage = nOrder + 1;
  // the common lift where the flood gates stop passing more (A8.7: no leap to full lift at one flow); found with a
  // free tail at the target pond, so it is a property of the structure and does not move with the flow
  const capFree = (o) => structureFlows(H, p.tail.bed_el, o.gates, o.sluices, p).q_down;
  const aMax = Math.max(...p.gates.map((b) => fullLift(b, p)));
  const capGates = (a) => capFree(sequenceOpenings(nOrder, a, p));
  const capTop = capGates(aMax);
  let pl = isNum(ops.first_opening_m) ? ops.first_opening_m : 0, ph = aMax;
  for (let i = 0; i < 40; i++) {
    const mid = (pl + ph) / 2;
    if (capGates(mid) < capTop * (1 - 1e-6)) pl = mid; else ph = mid;
  }
  const plat = ph;
  // the same for the sluices, with the gates at that lift
  const sMax = Math.max(...p.sluices.map((b) => fullLift(b, p)));
  const capS = (a) => capFree(sequenceOpenings(lastStage, a, p, plat));
  const capSTop = capS(sMax);
  let sl = 0, sh = sMax;
  for (let i = 0; i < 40; i++) {
    const mid = (sl + sh) / 2;
    if (capS(mid) < capSTop * (1 - 1e-6)) sl = mid; else sh = mid;
  }
  const splat = sh;
  for (let stage = 0; stage <= lastStage; stage++) {
    const [x0, x1] = stageRange(stage, p, plat, splat);
    if (capAt(sequenceOpenings(stage, x1, p, plat, splat)) < qg) continue;
    let lo = x0, hi = x1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (capAt(sequenceOpenings(stage, mid, p, plat, splat)) < qg) lo = mid; else hi = mid;
    }
    const o = sequenceOpenings(stage, hi, p, plat, splat);
    const name = stage < nOrder ? 'gates' : stage === nOrder ? 'all_gates' : 'flood';
    return { gates: o.gates, sluices: o.sluices, intake_open, intake_q: qInt, stage: name };
  }
  // flood_full: the openings where the flow stopped rising; solve() ramps them to full lift with the pond (floodRamp)
  const o = sequenceOpenings(lastStage, Infinity, p, plat, splat);
  return { gates: o.gates, sluices: o.sluices, intake_open, intake_q: qInt, stage: 'flood_full' };
}

/** Openings actually used for a mode: 'auto' | 'manual' | 'flush' | 'flood' | 'closed'. */
export function resolveControls({ q_in, controls = {}, weirParams, pond_el }) {
  const p = weirParams;
  const mode = controls.mode || 'auto';
  const nG = p.gates.length, nS = p.sluices.length;
  const arr = (a, n) => Array.from({ length: n }, (_, i) => pos(a && isNum(a[i]) ? a[i] : 0));
  const demand = isNum(controls.demand_m3s) ? controls.demand_m3s : undefined;
  if (mode === 'auto') {
    const a = autoGates({ q_in, demand_m3s: demand, weirParams: p, pond_el });
    return { mode, gates: a.gates, sluices: a.sluices, intake_open: a.intake_open, demand_m3s: demand,
      intake_cap: a.intake_q, stage: a.stage };
  }
  const intake_open = isNum(controls.intake_open) ? Math.min(1, pos(controls.intake_open))
    : intakeOpenFor(demand ?? 0, p.levels.pond_target_el, p);
  let gates = arr(controls.gates, nG).map((a, i) => Math.min(a, fullLift(p.gates[i], p)));
  let sluices = arr(controls.sluices, nS).map((a, j) => Math.min(a, fullLift(p.sluices[j], p)));
  if (mode === 'closed') { gates = gates.map(() => 0); sluices = sluices.map(() => 0); }
  if (mode === 'flood') { gates = p.gates.map((b) => fullLift(b, p)); sluices = p.sluices.map((b) => fullLift(b, p)); }
  if (mode === 'flush') sluices = p.sluices.map((b) => fullLift(b, p));
  // manual and the other modes: the canal may run up to the maximum (intakeAt caps it), with an alert over design
  return { mode, gates, sluices, intake_open, demand_m3s: demand, intake_cap: demand, stage: mode };
}

// ---------------------------------------------------------------------------------------------------------------
// Solve the pond

/**
 * Pond level where the gates, sluices, intake and overflow carry the inflow, found by bisection.
 * Steady state by default; with `pond_el_prev`, `dt_s` and a pond area (`pond_area_m2` in the args or in weirParams)
 * it is one implicit storage step: A (H - H_prev) / dt = q_in - q_out(H).
 * controls: { mode, gates[7], sluices[3], intake_open, demand_m3s } as the `weir` state keys (CONTRACT 4.4).
 * Returns { pond_el, tail_el, q_gates, q_sluices, q_intake, q_down, q_spill, freeboard_m, gates[7], sluices[3],
 *   intake_open, gate_q[7], sluice_q[3], regimes[10], stage, alerts[] } with levels in project EL.
 * Alert codes: pond_high (above the design high water), overtop (above the deck), intake_short (intake under the
 * demand), intake_over_design (intake above intake.capacity_m3s, manual only), gates_full (the flood gates can pass
 * no more: all at full lift, or auto in its flood stages), river_dry_below (flow below the weir under ops.q_env_m3s).
 */
export function solve({ q_in, controls = {}, weirParams, pond_el_prev, dt_s, pond_area_m2 }) {
  const p = weirParams;
  if (!p || !p.levels || !p.gates || !p.tail) return null;
  const qIn = pos(q_in);
  const c = resolveControls({ q_in: qIn, controls, weirParams: p, pond_el: pond_el_prev });
  const area = isNum(pond_area_m2) ? pond_area_m2 : p.pond_area_m2;
  const dynamic = isNum(pond_el_prev) && dt_s > 0 && area > 0;
  const demand = c.demand_m3s;

  const ramp = c.mode === 'auto' && c.stage === 'flood_full';
  const evalAt = (H) => {
    const o = ramp ? floodRamp(H, c, p) : c;
    const q_intake = intakeAt(H, c.intake_open, c.intake_cap, p);
    const T = tailFor(H, o.gates, o.sluices, p);
    const s = structureFlows(H, T, o.gates, o.sluices, p);
    const store = dynamic ? (area * (H - pond_el_prev)) / dt_s : 0;
    return { H, T, q_intake, s, o, f: qIn - q_intake - s.q_down - store };
  };

  let lo = lowestLevel(p);
  if (dynamic) lo = Math.min(lo, pond_el_prev);
  let hi = Math.max(p.levels.deck_el ?? p.levels.design_high_water_el, lo) + 1;
  if (dynamic) hi = Math.max(hi, pond_el_prev + 1);
  let r = evalAt(lo);
  if (r.f > 0) {
    let rh = evalAt(hi);
    for (let k = 0; k < 12 && rh.f > 0; k++) { hi += 2 ** k; rh = evalAt(hi); }
    for (let i = 0; i < BISECT_ITERS; i++) {
      const mid = (lo + hi) / 2;
      if (evalAt(mid).f > 0) lo = mid; else hi = mid;
      if (hi - lo < 1e-5) break;
    }
    r = evalAt((lo + hi) / 2);
  }

  const lv = p.levels;
  const alerts = [];
  if (r.H > lv.design_high_water_el + LEVEL_TOL) alerts.push('pond_high');
  if (isNum(lv.deck_el) && r.H > lv.deck_el + LEVEL_TOL) alerts.push('overtop');
  if (isNum(demand) && demand > 0 && r.q_intake < demand * (1 - 1e-3) - 1e-3) alerts.push('intake_short');
  if (isNum(p.intake.capacity_m3s) && r.q_intake > p.intake.capacity_m3s + 1e-3) alerts.push('intake_over_design');
  const used = r.o || c;
  // gates_full: the flood gates can pass no more (every one at full lift, or auto past the lift where their flow
  // stops rising: stages 'flood' and 'flood_full')
  if (used.gates.every((a, i) => a >= fullLift(p.gates[i], p) - 1e-6)
    || (c.mode === 'auto' && (c.stage === 'flood' || c.stage === 'flood_full'))) alerts.push('gates_full');
  const env = p.ops && p.ops.q_env_m3s;
  if (isNum(env) && r.s.q_down < env - 1e-3) alerts.push('river_dry_below');

  return {
    pond_el: r.H, tail_el: r.T,
    q_gates: r.s.q_gates, q_sluices: r.s.q_sluices, q_intake: r.q_intake,
    q_down: r.s.q_down, q_spill: r.s.q_spill,
    freeboard_m: lv.design_high_water_el - r.H,
    gates: used.gates, sluices: used.sluices, intake_open: c.intake_open,
    gate_q: r.s.gate_q, sluice_q: r.s.sluice_q, regimes: r.s.regimes, stage: c.stage,
    alerts,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// From the data files to weirParams

/**
 * Build weirParams from site/data/params.json (its `flat` copy, dotted keys 'weir.*', or the flat object itself)
 * and, optionally, site/data/weir.json (only for the overall length when params has none). Leaves may be plain
 * values or {v, ...}. Missing optional keys fall back to values computed from other parameters, never to a
 * number typed here. Returns null when a required key is missing (the caller shows "–").
 */
export function weirParamsFromData(paramsJson, weirJson) {
  const flat = paramsJson && (paramsJson.flat || paramsJson);
  if (!flat) return null;
  const val = (x) => (x && typeof x === 'object' && !Array.isArray(x) && 'v' in x ? x.v : x);
  const get = (k) => val(flat['weir.' + k]);
  const need = ['pond_normal_el', 'design_high_water_el', 'deck_el', 'riverbed_el', 'gate_width_m', 'gate_h_m',
    'gate_sill_el', 'sluice_width_m', 'sluice_h_m', 'sill_sluice_el', 'crest_cd', 'gate_mu', 'intake_mu',
    'intake_sill_el', 'intake_width_m', 'manning_n', 'bed_slope', 'tail_width_m'];
  for (const k of need) if (get(k) == null) return null;
  const nG = get('gate_count') ?? get('gate_h_m').length;
  const nS = get('sluice_count') ?? 3;
  const pick = (v, i) => (Array.isArray(v) ? v[i] : v);
  const lift = get('gate_lift_max_m');
  const gates = Array.from({ length: nG }, (_, i) => ({
    id: 'FG' + (i + 1), width_m: pick(get('gate_width_m'), i), height_m: pick(get('gate_h_m'), i),
    sill_el: pick(get('gate_sill_el'), i), lift_max_m: pick(lift, i) ?? undefined,
  }));
  const sluices = Array.from({ length: nS }, (_, j) => ({
    id: 'SG' + (j + 1), width_m: pick(get('sluice_width_m'), j),
    height_m: pick(get('sluice_h_m'), j) + (pick(get('under_sluice_h_m'), j) || 0),
    sill_el: pick(get('sill_sluice_el'), j), lift_max_m: pick(get('sluice_lift_max_m') ?? lift, j) ?? undefined,
  }));
  const pondMin = get('pond_min_intake_el');
  const headLoss = get('intake_head_loss_m');
  let length = get('length_m');
  if (length == null && weirJson) length = val(weirJson.length_m) ?? (weirJson.check && weirJson.check.length_m);
  return {
    g: val(flat['physics.g']) ?? undefined,
    levels: {
      pond_target_el: get('pond_normal_el'), design_high_water_el: get('design_high_water_el'),
      deck_el: get('deck_el'), bed_el: get('riverbed_el'),
    },
    gates, sluices,
    intake: {
      width_m: get('intake_width_m'), sill_el: get('intake_sill_el'), mu: get('intake_mu'),
      // FALLBACK (computed, not typed): gate height = lowest pond for design intake - sill;
      // canal level = that pond - the design head loss across the opening (KP-02 Gambar 5-1)
      gate_height_m: get('intake_gate_h_m') ?? (pondMin != null ? pondMin - get('intake_sill_el') : undefined),
      canal_wl_el: get('intake_canal_wl_el') ?? (pondMin != null && headLoss != null ? pondMin - headLoss : undefined),
      capacity_m3s: get('intake_capacity_m3s'), capacity_max_m3s: get('intake_capacity_max_m3s'),
      target_m3s: get('intake_target_m3s') ?? undefined, // automatic mode's cap (CONTRACT A7.5)
    },
    hyd: {
      crest_cd: get('crest_cd'), gate_mu: get('gate_mu'), top_cd: get('top_cd') ?? undefined,
      pier_kp: get('pier_kp') ?? 0, abut_ka: get('abut_ka') ?? 0, weir_length_m: length ?? undefined,
    },
    tail: {
      bed_el: get('tail_bed_el') ?? get('riverbed_el'), width_m: get('tail_width_m'),
      side_z: get('tail_side_z') ?? 0, // FALLBACK: rectangular section until params gives side slopes
      n: get('manning_n'), slope: get('bed_slope'),
    },
    ops: {
      gate_order: get('gate_order'), first_opening_m: get('first_main_opening_m'),
      step_m: get('gate_step_normal_m'), flood_step_m: get('gate_step_flood_m'),
      flap_threshold_m3s: get('flap_threshold_m3s'), q_env_m3s: get('maintenance_flow_m3s'),
    },
    pond_area_m2: get('pond_area_m2') ?? undefined,
  };
}
