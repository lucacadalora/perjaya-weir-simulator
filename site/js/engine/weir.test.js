// Tests for engine/weir.js (lane b14). Run: node --test site/js/engine/
// Targets E3-01..07 are from plan/P2-targets-draft.json (copied with their ids; never loosened).
// The weir itself is described by a `weirParams` object built here from SETTLE.md item 7 and SETTLED.md section 4
// (the same shape weirParamsFromData makes from site/data/params.json); a second block runs on the real data files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  effectiveWidth, crestFlow, intakeFlow, gateFlowEnergy, gateFlow, manningQ, submergenceFactor,
  tailwater, solve, autoGates, weirParamsFromData, structureFlows,
} from './weir.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} got ${a}, want ${b} +/- ${tol}`);

// ---- E3 targets ---------------------------------------------------------------------------------------------
test('E3-01 gate free flow, KP-02 eq 4-42', () => {
  const r = gateFlow({ type: 'sluice', opening_m: 1.0, width_m: 10, h_up_m: 5.0, h_down_m: 0, cd: 0.6, g: 9.81 });
  near(r.q_m3s, 59.4273, 0.05);
  assert.equal(r.regime, 'free');
});
test('E3-02 gate free flow, energy form Cc 0.61', () => {
  near(gateFlowEnergy({ Cc: 0.61, a_m: 1.0, b_m: 10, h1_m: 5.0 }), 57.0385, 0.05);
});
test('E3-03 intake, KP-02 eq 5-3', () => {
  near(intakeFlow({ mu: 0.8, b_m: 3.0, a_m: 1.5, z_m: 0.2 }), 7.1313, 0.01);
});
test('E3-04 crest, KP-02 eq 4-2', () => {
  near(crestFlow({ width_m: 100, head_m: 3.0, cd: 1.3 }), 1151.6562, 0.5);
});
test('E3-05 effective width, KP-02 eq 4-1', () => {
  near(effectiveWidth({ B_m: 100, n_piers: 4, Kp: 0.01, Ka: 0.1, H1_m: 3.0 }), 99.16, 0.001);
});
test('E3-06 crest with effective width', () => {
  const be = effectiveWidth({ B_m: 100, n_piers: 4, Kp: 0.01, Ka: 0.1, H1_m: 3.0 });
  near(crestFlow({ width_m: be, head_m: 3.0, cd: 1.3 }), 1141.9823, 0.5);
});
test('E3-07 Manning trapezoid', () => {
  near(manningQ({ b_m: 80, side_z: 2, y_m: 4, n: 0.035, S: 0.0003 }), 408.8611, 0.5);
});

// ---- element behaviour ---------------------------------------------------------------------------------------
test('submergence factor runs from 1 (free) to 0 (drowned)', () => {
  assert.equal(submergenceFactor(0), 1);
  assert.equal(submergenceFactor(1), 0);
  let prev = 1;
  for (let r = 0.05; r < 1; r += 0.05) { const f = submergenceFactor(r); assert.ok(f <= prev); prev = f; }
});

test('gate: closed, free, submerged, open; flow falls as the tail rises and grows with the opening', () => {
  const base = { type: 'sluice', width_m: 20, h_up_m: 3, cd: 0.6, crest_cd: 1.3 };
  assert.equal(gateFlow({ ...base, opening_m: 0 }).regime, 'closed');
  assert.equal(gateFlow({ ...base, opening_m: 0.5, h_down_m: 0 }).regime, 'free');
  assert.equal(gateFlow({ ...base, opening_m: 0.5, h_down_m: 2.5 }).regime, 'submerged');
  assert.match(gateFlow({ ...base, opening_m: 4, h_down_m: 0 }).regime, /^open/);
  let prev = Infinity;
  for (let h2 = 0; h2 < 3; h2 += 0.1) {
    const q = gateFlow({ ...base, opening_m: 0.5, h_down_m: h2 }).q_m3s;
    assert.ok(q <= prev + 1e-9, `tail ${h2}`); prev = q;
  }
  prev = 0;
  for (let a = 0; a <= 4; a += 0.05) {
    const q = gateFlow({ ...base, opening_m: a, h_down_m: 1 }).q_m3s;
    assert.ok(q >= prev - 1e-9, `opening ${a}`); prev = q;
  }
});

test('flap: overflow over its crest', () => {
  const r = gateFlow({ type: 'flap', width_m: 20, h_up_m: 0.3, cd: 1.3 });
  near(r.q_m3s, crestFlow({ width_m: 20, head_m: 0.3, cd: 1.3 }), 1e-9);
  assert.equal(r.regime, 'overflow');
});

// ---- a weirParams object for the tests (CONTRACT A5/A7 levels as b18 settled them; the engine has no constants) --
// normal pond EL 79.70, design high water EL 81.00, closed gate tops EL 79.90, tail bed EL 74.0 (A7.1)
const DHWL = 81.0;
const POND = 79.7;
const weirParams = {
  levels: { pond_target_el: POND, design_high_water_el: DHWL, deck_el: 83.0, bed_el: 74.0 },
  gates: [2.9, 2.9, 2.9, 2.9, 2.9, 3.9, 3.9].map((h, i) => ({
    id: 'FG' + (i + 1), width_m: 20.0, height_m: h, sill_el: 79.9 - h, lift_max_m: 4.5 })),
  sluices: [1, 2, 3].map((j) => ({ id: 'SG' + j, width_m: 12.5, height_m: 4.2 + 2.0, sill_el: 73.7, lift_max_m: 4.5 })),
  intake: { width_m: 49.5, sill_el: 78.3, gate_height_m: 2.7, canal_wl_el: 79.5, mu: 0.8,
    capacity_m3s: 91.68, capacity_max_m3s: 101, target_m3s: 81 },
  hyd: { crest_cd: 1.3, gate_mu: 0.6, pier_kp: 0.01, abut_ka: 0.1, weir_length_m: 215.5 },
  tail: { bed_el: 74.0, width_m: 200, side_z: 2, n: 0.035, slope: 0.0004 },
  ops: { gate_order: [6, 7, 5, 4, 3, 2, 1], first_opening_m: 0.3, step_m: 0.1, flood_step_m: 0.6,
    flap_threshold_m3s: 9.36, q_env_m3s: 35 },
};

test('tailwater inverts Manning and rises with the flow', () => {
  let prev = -Infinity;
  for (const q of [0, 10, 100, 500, 1000, 2200, 4000]) {
    const el = tailwater(q, weirParams);
    assert.ok(el >= prev); prev = el;
    const y = el - weirParams.tail.bed_el;
    near(manningQ({ b_m: 200, side_z: 2, y_m: y, n: 0.035, S: 0.0004 }), q, Math.max(0.01, q * 1e-4));
  }
});

test('steady solve balances the mass: q_in = q_intake + q_down', () => {
  for (const q of [20, 120, 500, 1200, 2200, 3500]) {
    const r = solve({ q_in: q, controls: { mode: 'auto', demand_m3s: 81 }, weirParams });
    near(r.q_intake + r.q_down, q, q * 2e-3 + 0.05, `q ${q}`);
    assert.ok(r.tail_el >= weirParams.tail.bed_el);
    near(r.freeboard_m, DHWL - r.pond_el, 1e-9);
  }
});

test('auto holds the pond at the target while the gates can', () => {
  for (const q of [200, 800, 1400]) {
    const r = solve({ q_in: q, controls: { mode: 'auto', demand_m3s: 81 }, weirParams });
    near(r.pond_el, POND, 0.01, `q ${q}`);
    // at 1,400 every flood gate is at full lift (gates_full is right); nothing else may fire
    assert.deepEqual(r.alerts.filter((a) => a !== 'gates_full'), []);
    near(r.q_intake, 81, 0.05);
  }
});

test('A7.6 (M7): the pond holds EL 79.70 from low flow until every gate is fully open, no jump', () => {
  for (let q = 1; q <= 1400; q += q < 200 ? 1 : 10) {
    const r = solve({ q_in: q, controls: { mode: 'auto', demand_m3s: 81 }, weirParams });
    if (r.alerts.includes('gates_full')) break;
    near(r.pond_el, POND, 0.01, `q ${q}`);
  }
});

test('A8.7: auto openings are continuous in the flow, 20 to 3,000 m3/s in 10 m3/s steps, and retrace', () => {
  const run = (q) => solve({ q_in: q, controls: { mode: 'auto', demand_m3s: 81 }, weirParams });
  let prev = null;
  const up = [];
  for (let q = 20; q <= 3000; q += 10) {
    const r = run(q);
    up.push(r);
    if (prev) {
      for (let i = 0; i < 7; i++) assert.ok(Math.abs(r.gates[i] - prev.gates[i]) <= weirParams.ops.flood_step_m, `gate ${i + 1} at ${q}`);
      for (let j = 0; j < 3; j++) assert.ok(Math.abs(r.sluices[j] - prev.sluices[j]) <= weirParams.ops.flood_step_m, `sluice ${j + 1} at ${q}`);
      assert.ok(Math.abs(r.pond_el - prev.pond_el) <= 0.05, `pond step at ${q}`);
      assert.ok(r.pond_el >= prev.pond_el - 0.01, `pond never falls as the flow rises (${q})`);
    }
    prev = r;
  }
  // falling flows retrace the same path (the rule is a function of the flow alone)
  for (let k = up.length - 1; k >= 0; k -= 37) {
    const r = run(20 + 10 * k);
    near(r.pond_el, up[k].pond_el, 1e-9); assert.deepEqual(r.gates, up[k].gates);
  }
});

test('A7.4 (H2): automatic mode keeps the maintenance flow in the river first', () => {
  for (const q of [10, 20, 35, 50, 80, 100, 116, 150]) {
    const r = solve({ q_in: q, controls: { mode: 'auto', demand_m3s: 81 }, weirParams });
    near(r.q_intake, Math.min(81, Math.max(0, q - 35)), 0.05, `intake at ${q}`);
    near(r.q_down, Math.min(q, Math.max(35, q - 81)), 0.1, `river at ${q}`);
    assert.equal(r.alerts.includes('river_dry_below'), q < 35, `alert at ${q}`);
    assert.equal(r.alerts.includes('intake_short'), q - 35 < 81, `short at ${q}`);
  }
});

test('A7.5 (M8): auto holds the canal to 81; manual may reach 101 with intake_over_design over 91.68', () => {
  const a = solve({ q_in: 600, controls: { mode: 'auto', demand_m3s: 120 }, weirParams });
  near(a.q_intake, 81, 0.05);
  assert.ok(!a.alerts.includes('intake_over_design'));
  const m = solve({ q_in: 600, controls: { mode: 'manual', gates: new Array(7).fill(0.6), sluices: [0, 0, 0],
    intake_open: 1, demand_m3s: 120 }, weirParams });
  assert.ok(m.q_intake > 91.68 && m.q_intake <= 101 + 1e-9, `manual intake ${m.q_intake}`);
  assert.ok(m.alerts.includes('intake_over_design'));
  const m2 = solve({ q_in: 600, controls: { mode: 'manual', gates: new Array(7).fill(0.6), sluices: [0, 0, 0],
    intake_open: 1, demand_m3s: 85 }, weirParams });
  near(m2.q_intake, 85, 0.05);
  assert.ok(!m2.alerts.includes('intake_over_design'));
});

test('auto opens gate 6 first, then 7, in the operating order', () => {
  // 20 m3/s: all stays in the river (under the maintenance flow), gate 6 alone passes it
  const a = autoGates({ q_in: 20, demand_m3s: 81, weirParams });
  assert.ok(a.gates[5] > 0, 'gate 6 opens');
  assert.equal(a.gates.filter((x) => x > 0).length, 1);
  // 100 m3/s: 35 for the river through the gates: gate 6 at the first opening, then gate 7
  const b = autoGates({ q_in: 100, demand_m3s: 81, weirParams });
  near(b.gates[5], 0.3, 1e-9); assert.ok(b.gates[6] > 0, 'gate 7 next');
});

test('design flood: all gates open, pond near the design high water', () => {
  const r = solve({ q_in: 2200, controls: { mode: 'auto', demand_m3s: 81 }, weirParams });
  assert.ok(r.alerts.includes('gates_full'));
  assert.ok(r.pond_el <= DHWL, `pond ${r.pond_el}`); // CONTRACT A7.1 check
  assert.ok(!r.alerts.includes('overtop'));
});

test('closed gates in a flood overtop the deck; flood mode passes it', () => {
  const c = solve({ q_in: 3000, controls: { mode: 'closed', intake_open: 0 }, weirParams });
  assert.ok(c.alerts.includes('overtop') && c.alerts.includes('pond_high'));
  assert.ok(c.q_spill > 1000);
  const f = solve({ q_in: 3000, controls: { mode: 'flood', demand_m3s: 81 }, weirParams });
  assert.ok(f.pond_el < c.pond_el);
  assert.ok(f.alerts.includes('gates_full'));
});

test('manual: wider openings lower the pond; flush opens the sluices', () => {
  let prev = Infinity;
  for (const a of [0.2, 0.5, 1, 2]) {
    const r = solve({ q_in: 600, controls: { mode: 'manual', gates: new Array(7).fill(a), sluices: [0, 0, 0],
      intake_open: 0.5, demand_m3s: 81 }, weirParams });
    assert.ok(r.pond_el < prev); prev = r.pond_el;
  }
  const f = solve({ q_in: 300, controls: { mode: 'flush', gates: new Array(7).fill(0), intake_open: 0 }, weirParams });
  assert.ok(f.q_sluices > 0 && f.q_gates === 0);
  assert.equal(f.q_intake, 0);
});

test('storage step: A (H - H_prev) / dt = q_in - q_out, and the pond moves toward steady state', () => {
  const controls = { mode: 'manual', gates: new Array(7).fill(1), sluices: [0, 0, 0], intake_open: 0.5, demand_m3s: 81 };
  const steady = solve({ q_in: 900, controls, weirParams }).pond_el;
  const A = 2e6, dt = 600;
  let H = 78.0;
  for (let i = 0; i < 400; i++) {
    const r = solve({ q_in: 900, controls, weirParams, pond_el_prev: H, dt_s: dt, pond_area_m2: A });
    near(A * (r.pond_el - H) / dt, 900 - r.q_intake - r.q_down, 0.5, `step ${i}`);
    assert.ok(r.pond_el >= H - 1e-6 && r.pond_el <= steady + 1e-3);
    H = r.pond_el;
  }
  near(H, steady, 0.01);
});

test('structure has no flow below every sill', () => {
  const s = structureFlows(73.6, 73.5, new Array(7).fill(1), [1, 1, 1], weirParams);
  assert.equal(s.q_down, 0);
});

// ---- the real data files, when lane b18 has written them ------------------------------------------------------
const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));
const haveData = existsSync(dataDir + 'params.json');
test('real params.json: weirParamsFromData and the auto table 50..2200 m3/s', { skip: !haveData }, () => {
  const P = JSON.parse(readFileSync(dataDir + 'params.json', 'utf8'));
  const W = existsSync(dataDir + 'weir.json') ? JSON.parse(readFileSync(dataDir + 'weir.json', 'utf8')) : null;
  const p = weirParamsFromData(P, W);
  assert.ok(p, 'params complete');
  assert.equal(p.gates.length, 7); assert.equal(p.sluices.length, 3);
  const demand = (P.flat['weir.intake_target_m3s'] || {}).v;
  for (const q of [50, 200, 800, 1400, 2200]) {
    const r = solve({ q_in: q, controls: { mode: 'auto', demand_m3s: demand }, weirParams: p });
    near(r.q_intake + r.q_down, q, q * 2e-3 + 0.05);
    if (q >= 200 && q <= 1400) near(r.pond_el, p.levels.pond_target_el, 0.01);
    if (q === 2200) assert.ok(r.pond_el <= p.levels.design_high_water_el, `design flood pond ${r.pond_el}`); // A7.1
  }
});
