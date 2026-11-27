// Tests for engine/worker.js (lane b11): the dispatcher runs in node with a fake `self` and a disk-backed fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DATA_DIR, packsPresent } from './node-loader.js';

const HAVE = (await packsPresent('wide')) && (await packsPresent('fine'));

test('worker: loads wide then fine, dispatches calls with G, transfers arrays, plain errors', { skip: !HAVE && 'no packs' }, async () => {
  const sent = [];
  globalThis.self = {
    postMessage(msg, transfer) {
      sent.push({ msg, transfer: transfer || [] });
    },
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace('http://test/data/', '').replace(/\?.*$/, '');
    try {
      const b = await readFile(new URL(path, DATA_DIR));
      const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      return { ok: true, status: 200, arrayBuffer: async () => ab, json: async () => JSON.parse(b.toString('utf8')) };
    } catch {
      return { ok: false, status: 404 };
    }
  };
  await import('./worker.js?node-test');
  const until = async (pred, ms = 20000) => {
    const t0 = Date.now();
    while (!sent.some((s) => pred(s.msg))) {
      if (Date.now() - t0 > ms) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
    return sent.find((s) => pred(s.msg));
  };
  let id = 0;
  const call = async (name, args) => {
    const my = ++id;
    self.onmessage({ data: { type: 'call', id: my, name, args } });
    return until((m) => m.type === 'result' && m.id === my);
  };

  self.onmessage({ data: { type: 'init', urlTemplate: 'http://test/data/__PATH__?v=x', grids: ['wide', 'fine'] } });
  const meta = await until((m) => m.type === 'meta' && m.grid === 'wide');
  assert.equal(meta.msg.meta.cols, 2040);
  await until((m) => m.type === 'grid' && m.grid === 'wide' && m.state === 'ready');
  const w = meta.msg.meta.weir;

  // calls with G first
  const t0 = performance.now();
  const r = await call('grid.catchment', { grid: 'wide', idx: w.row * 2040 + w.col });
  const ms = performance.now() - t0;
  assert.ok(r.msg.ok, r.msg.error);
  assert.ok(Math.abs(r.msg.value.area_km2 - w.catchment_km2) / w.catchment_km2 < 0.03);
  assert.equal(r.transfer.length, 1, 'the mask buffer is transferred');
  assert.equal(r.transfer[0], r.msg.value.mask.buffer);
  console.log(`# worker catchment ${r.msg.value.area_km2.toFixed(1)} km2 in ${ms.toFixed(0)} ms`);

  // grid functions that take g: args array with the grid name first
  const c = await call('grid.lonLatToCell', ['wide', w.lon, w.lat]);
  assert.deepEqual([c.msg.value.col, c.msg.value.row], [w.col, w.row]);
  const e = await call('grid.elevationAt', ['wide', w.lon, w.lat]);
  assert.ok(Number.isFinite(e.msg.value));

  // a call naming the fine grid waits for it
  const f = await call('grid.snapToStream', { grid: 'fine', lon: w.lon, lat: w.lat, min_km2: 1000, radius_cells: 5 });
  assert.ok(f.msg.ok && f.msg.value.ok, JSON.stringify(f.msg));

  // grid arrays are never transferred away from the worker
  const tr = await call('grid.traceDownstream', { grid: 'wide', idx: w.row * 2040 + w.col, max_steps: 10 });
  assert.ok(tr.msg.ok && tr.msg.value.idx.length === 11);

  // flood.extent waits for flood.prepare (river outline + fine land cover), A7.3
  const params = JSON.parse(await readFile(new URL('params.json', DATA_DIR), 'utf8'));
  const fp = params.flat || params;
  const fl = await call('flood.extent', { grid: 'fine', stage_m: 1.8, stage_up_m: 0, floodParams: fp });
  assert.ok(fl.msg.ok, fl.msg.error);
  console.log(`# worker flood.extent rise 1.8 m below: ${fl.msg.value.area_km2.toFixed(2)} km2 (below ${fl.msg.value.area_down_km2?.toFixed(2)})`);
  assert.ok(Math.abs(fl.msg.value.area_down_km2 - 2.3) < 0.3, 'about 2.3 km2 below the weir');
  const f0 = await call('flood.extent', { grid: 'fine', stage_m: 0, stage_up_m: 0, floodParams: fp });
  assert.equal(f0.msg.value.cells, 0, 'a rise of 0 floods nothing');
  assert.equal(f0.msg.value.mask.reduce((a, b) => a + b, 0), 0);

  // plain errors
  const bad = await call('grid.nothing', {});
  assert.equal(bad.msg.ok, false);
  assert.match(bad.msg.error, /does not exist/);
  const bad2 = await call('nomodule.x', {});
  assert.match(bad2.msg.error, /not available/);
  const bad3 = await call('grid.catchment', { grid: 'moon', idx: 0 });
  assert.match(bad3.msg.error, /not part of this simulator/);

  const mods = await until((m) => m.type === 'modules');
  assert.ok(mods.msg.loaded.includes('grid'));
  console.log('# worker modules', mods.msg.loaded.join(','), Object.keys(mods.msg.failed).length ? 'failed: ' + JSON.stringify(mods.msg.failed) : '');
});
