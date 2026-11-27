// node --test site/js/map/structures/weir/ (lane b08): the drawn water surface through a bay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bayProfile, floorLine, fastDepth, sequentDepth, estimateFlow, G } from './hydraulics.js';

// the floor of a flood bay as weir/civil.js builds it: seat EL 77, basin floor EL 73, bed EL 74, 30 m basin, 2 m end sill
const zGate = 4, crest = 77, floor = 73, bed = 74, es = 2, zEnd = -30;
const zc0 = zGate + 2.2, zc1 = zGate - 1.2;
const pts = [[23, bed], [zc0 + 4.5, bed], [zc0, crest], [zc1, crest], [zc1 - 6.4, floor], [zEnd + es * 1.2 + 1.2, floor],
  [zEnd + 1.2, floor + es], [zEnd, floor + es], [zEnd - es, bed], [zEnd - 6, bed]];
const geo = { floorAt: floorLine(pts), sill: crest, floor, zGateUp: zGate + 0.42, zGateDn: zGate - 0.48, zCrestUp: zc0,
  zSillUp: zEnd + es * 1.2 + 1.2, zEnd, endSill: es };
const zs = [];
for (let z = 17; z >= -65; z -= 0.5) zs.push(z);
const run = (st) => bayProfile(geo, { width: 20, leafH: 3.5, ...st }, zs);
const at = (p, z) => p.y[zs.indexOf(z)];
const near = (a, b, tol = 1e-4) => assert.ok(Math.abs(a - b) <= tol, `${a} is not ${b}`);

test('floorLine follows the section and is flat beyond its ends', () => {
  assert.equal(geo.floorAt(30), bed);
  assert.equal(geo.floorAt(4), crest);
  assert.equal(geo.floorAt(-10), floor);
  assert.equal(geo.floorAt(-29.5), floor + es);
  assert.equal(geo.floorAt(-80), bed);
});

test('fast sheet and its sequent depth obey energy and momentum', () => {
  const q = 1, head = 6.7;
  const d = fastDepth(q, head);
  assert.ok(Math.abs(d + (q * q) / (2 * G * d * d) - head) < 1e-6);
  const d2 = sequentDepth(q, d);
  // momentum function equal on both sides of the jump
  const M = (y) => (q * q) / (G * y) + (y * y) / 2;
  assert.ok(Math.abs(M(d) - M(d2)) < 1e-6);
  assert.ok(d2 > d);
});

test('a closed bay: flat pond, still basin at the tail, no foam', () => {
  const p = run({ H: 79.7, T: 75.6, a: 0, q: 0 });
  assert.equal(p.regime, 'still');
  near(at(p, 10), 79.7);
  near(at(p, -10), 75.6);
  near(at(p, -60), 75.6);
  assert.equal(Math.max(...p.foam), 0);
});

test('a tail below the end sill leaves a pool behind it', () => {
  const p = run({ H: 79.7, T: 74.5, a: 0, q: 0 });
  near(at(p, -10), floor + es - 0.03);
  near(at(p, -60), 74.5);
});

test('a little water under the leaf: a fast sheet, a white jump, then the tail', () => {
  const p = run({ H: 79.7, T: 75.6, a: 0.23, q: 20 });
  assert.equal(p.regime, 'gate');
  assert.ok(p.toe < geo.zGateDn && p.toe > zEnd, 'the jump stands inside the basin');
  assert.ok(p.fr1 > 4);
  near(at(p, 10), 79.7); // the leaf holds the pond
  const iJet = zs.indexOf(3);
  assert.ok(p.depth[iJet] > 0 && p.depth[iJet] < 0.3, 'a thin sheet on the seat');
  assert.ok(p.v[iJet] > 5);
  assert.ok(Math.max(...p.foam) === 1, 'the jump is white');
  near(at(p, -64), 75.6);
  assert.ok(p.foam[zs.indexOf(-60)] < p.foam[zs.indexOf(-20)], 'foam thins out downstream');
  for (let i = 0; i < zs.length; i++) assert.ok(Number.isFinite(p.y[i]) && Number.isFinite(p.v[i]));
});

test('the jump moves downstream as the tail falls', () => {
  const hi = run({ H: 79.7, T: 77.5, a: 1.2, q: 110 });
  const lo = run({ H: 79.7, T: 75.8, a: 1.2, q: 110 });
  assert.ok(lo.toe < hi.toe);
});

test('a flood through open bays: a drowned swell, little white water, no waterfall', () => {
  const p = run({ H: 80.8, T: 80.0, a: 4.5, q: 300 });
  assert.equal(p.regime, 'open-drowned');
  for (let i = 0; i < zs.length; i++) assert.ok(p.y[i] > 79.5 && p.y[i] <= 80.8 + 1e-4);
  assert.ok(Math.max(...p.foam) < 0.4);
  assert.ok(at(p, 16) > at(p, 5), 'the pond is drawn down towards the seat');
});

test('pond above a closed leaf: water goes over the top', () => {
  const p = run({ H: 81.2, T: 76, a: 0, q: 20 });
  assert.ok(p.over > 0);
  assert.ok(p.foam[zs.indexOf(2)] > 0.3, 'the falling water breaks the basin surface');
});

test('estimateFlow: closed is zero, opens with the gate, capped by the open bay', () => {
  assert.equal(estimateFlow({ a: 0, width: 20, H: 79.7, T: 75.6, sill: 77 }), 0);
  const q1 = estimateFlow({ a: 0.5, width: 20, H: 79.7, T: 75.6, sill: 77 });
  const q2 = estimateFlow({ a: 1, width: 20, H: 79.7, T: 75.6, sill: 77 });
  const q9 = estimateFlow({ a: 9, width: 20, H: 79.7, T: 75.6, sill: 77 });
  assert.ok(q1 > 0 && q2 > q1 && q9 >= q2);
  assert.ok(q9 < 20 * 1.8 * Math.pow(2.7, 1.5));
});
