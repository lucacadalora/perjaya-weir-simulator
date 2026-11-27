// node --test site/js/map/water/ (lane b06): the direction of the current in a channel mask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelDistance, flowField } from './flowfield.js';
import { rippleBytes } from './surface.js';

// an L-shaped channel: down the left side (cols 2..7), then along the bottom (rows 32..37) to the right
const C = 40, R = 40;
const mask = new Uint8Array(C * R);
for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
  if ((c >= 2 && c <= 7 && r <= 37) || (r >= 32 && r <= 37 && c >= 2)) mask[r * C + c] = 1;
}
const seeds = [];
for (let c = 2; c <= 7; c++) seeds.push([c, 0, 0]);

test('channelDistance walks through wet cells only, round the bend', () => {
  const { dist, reached } = channelDistance(mask, C, R, seeds);
  assert.equal(reached, mask.reduce((a, x) => a + x, 0));
  assert.equal(dist[20 * C + 20], Infinity, 'land is never reached');
  assert.ok(dist[35 * C + 38] > 60, 'the far end is reached round the corner, not across the land');
});

test('flowField points along the channel, away from the seeds or towards them', () => {
  const f = flowField(mask, C, R, seeds, { away: true, step: 1 });
  const dir = (c, r) => [(f.data[(r * f.cols + c) * 4] - 127.5) / 127.5, (f.data[(r * f.cols + c) * 4 + 1] - 127.5) / 127.5];
  const a = dir(4, 15); // in the first leg: down the grid (rows grow = south)
  assert.ok(a[1] > 0.9 && Math.abs(a[0]) < 0.3);
  const b = dir(28, 34); // in the second leg: to the right (east)
  assert.ok(b[0] > 0.9 && Math.abs(b[1]) < 0.3);
  assert.equal(f.data[(15 * f.cols + 4) * 4 + 2], 255, 'full speed in mid-channel');
  assert.equal(f.data[(20 * f.cols + 20) * 4 + 2], 0, 'none on land');
  const g = flowField(mask, C, R, seeds, { away: false, step: 1 });
  assert.ok((g.data[(15 * g.cols + 4) * 4 + 1] - 127.5) / 127.5 < -0.9, 'towards the seeds when asked');
});

test('a coarser field keeps the same directions', () => {
  const f = flowField(mask, C, R, seeds, { away: true, step: 2 });
  assert.equal(f.cols, 20);
  assert.ok((f.data[(7 * f.cols + 2) * 4 + 1] - 127.5) / 127.5 > 0.9);
});

test('the ripple texture is tileable bytes with balanced slopes', () => {
  const N = 64;
  const b = rippleBytes(N, 3);
  assert.equal(b.length, N * N * 4);
  let sx = 0, sy = 0;
  for (let i = 0; i < N * N; i++) { sx += b[i * 4] - 127.5; sy += b[i * 4 + 1] - 127.5; }
  assert.ok(Math.abs(sx / (N * N)) < 2 && Math.abs(sy / (N * N)) < 2, 'slopes average to zero');
  const again = rippleBytes(N, 3);
  assert.deepEqual(b, again, 'the same every time');
});
