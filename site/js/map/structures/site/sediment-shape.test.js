// Tests for the sediment drawing's pure shape helpers (lane s). Run: node --test site/js/map/structures/site/sediment-shape.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depositShape, basinFrame, frontTable, frontFor, fullThickness, turbidity, plumePath } from './sediment-shape.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} got ${a}, want ${b} +/- ${tol}`);

// a lens 45 m wide and 170 m long, tip in the south (z = 0), north end at z = -170
const lens = [];
for (let i = 0; i < 40; i++) {
  const a = (i / 40) * 2 * Math.PI;
  lens.push([22.5 * Math.sin(a), -85 + 85 * Math.cos(a)]);
}

test('frame: inlet tip south, north end, bar share, rows inside the ring', () => {
  const f = basinFrame(lens, -110);
  near(f.zS, 0, 1e-9);
  near(f.zN, -170, 1e-9);
  near(f.sbar, 110 / 170, 1e-9);
  for (const r of f.rows) assert.ok(r.x1 >= r.x0 && r.x1 <= 22.6 && r.x0 >= -22.6);
  const mid = f.rows[Math.round(f.rows.length / 2)];
  near(mid.x1 - mid.x0, 45, 0.5, 'widest in the middle');
  near(f.lens[1], f.rows[0].x1 - f.rows[0].x0 > 0 ? (f.rows[0].x1 - f.rows[0].x0) / 2 : 0, 0.01);
});

test('deposit: thickest near the inlet, nothing beyond the front or at the tip', () => {
  const sbar = 0.64;
  assert.equal(depositShape(0, 0, 0.5, sbar), 0, 'the jet at the tip');
  assert.equal(depositShape(0.6, 0, 0.4, sbar), 0, 'beyond the front');
  assert.ok(depositShape(0.1, 0, sbar, sbar) > depositShape(0.5, 0, sbar, sbar), 'falls towards the bar');
  assert.ok(depositShape(0.2, 1, sbar, sbar) > depositShape(0.2, 0, sbar, sbar), 'a little higher at the walls');
});

test('front table: volume grows with the front; the drawing holds the engine volume', () => {
  const f = basinFrame(lens, -110);
  const tab = frontTable(f);
  for (let i = 1; i < tab.V.length; i++) assert.ok(tab.V[i] >= tab.V[i - 1]);
  const { D, clamped } = fullThickness(tab, 6300, 3.4);
  assert.equal(clamped, false);
  assert.ok(D > 1 && D < 3.4, 'D ' + D);
  // half the storage: the front stands short of the bar, and the table gives the volume back
  const F = frontFor(tab, 3150 / D);
  assert.ok(F > 0.1 && F < f.sbar);
  const back = frontTable({ ...f }, 64).V; // same table
  near(frontFor(tab, back[32]), tab.F[32], 1e-6);
  assert.equal(frontFor(tab, 0), 0);
  near(frontFor(tab, 1e9), f.sbar, 1e-6);
  assert.deepEqual(fullThickness(tab, 1e7, 3.4), { D: 3.4, clamped: true });
});

test('turbidity: 0 for clear water, half at 693 mg/L, towards 1 in a flood', () => {
  assert.equal(turbidity(0), 0);
  near(turbidity(693), 0.5, 0.001);
  assert.ok(turbidity(10000) > 0.99);
  assert.equal(turbidity(null), 0);
});

test('plume path: leaves the mouth along the channel and turns downstream', () => {
  const p = plumePath([113, -140], [-1, 0], [0, -1], 300, 6);
  assert.deepEqual(p[0], [113, -140]);
  assert.ok(p[1][0] < 113, 'first west');
  const last = p[p.length - 1], prev = p[p.length - 2];
  near(Math.atan2(last[1] - prev[1], last[0] - prev[0]), -Math.PI / 2, 0.01, 'then north');
  let len = 0;
  for (let i = 1; i < p.length; i++) len += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  near(len, 300, 1e-6);
});
