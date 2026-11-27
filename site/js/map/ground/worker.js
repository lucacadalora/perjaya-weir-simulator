// Ground worker (lane g, 24 Nov 2026): smooth terrain tiles and close-zoom ground tiles, off the main thread.
// Started by terrain-sampler.js (a small pool). Messages in:
//   {op:'init', tj, terrainUrl, dataBase, stamp, small}            -> {op:'ready', ok}
//   {op:'dem', id, z, x, y, png}  -> {id, ok, h (Float32Array 256^2), png (Terrarium PNG ArrayBuffer, when asked)}
//   {op:'ground', id, z, x, y}    -> {id, ok, img (JPEG ArrayBuffer)}
//   {op:'cancel', id}             -> the job answers {id, ok:false, cancelled:true} if it had not finished
import { createCore } from './core.js';
import { createIO, encodeImage, encodeTerrariumPng } from './io.js';

let core = null;
const queue = []; // ground jobs, first in first out
const live = new Map(); // id -> job (ground jobs not answered yet)
let active = 0;
const ACTIVE_MAX = 3; // ground jobs fetching at once (their drawing is one at a time anyway)

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const errText = (e) => String((e && e.message) || e);

function offscreenOk() {
  try {
    return typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('2d') && typeof createImageBitmap === 'function';
  } catch (e) {
    return false;
  }
}

async function dem(m) {
  try {
    const h = core && (await core.drawn(m.z, m.x, m.y));
    if (!h) return post({ id: m.id, ok: false });
    const hc = h.slice(); // the cache keeps its own copy
    const png = m.png ? await encodeTerrariumPng(h, h.w || 256) : null;
    post({ id: m.id, ok: true, h: hc, png }, png ? [hc.buffer, png] : [hc.buffer]);
  } catch (e) {
    post({ id: m.id, ok: false, error: errText(e) });
  }
}

async function runGround(job) {
  try {
    const px = await core.ground(job.z, job.x, job.y);
    if (job.cancelled) return post({ id: job.id, ok: false, cancelled: true });
    if (!px) return post({ id: job.id, ok: false });
    const img = await encodeImage(px, 256, 256, 'image/jpeg', 0.9);
    post({ id: job.id, ok: true, img }, [img]);
  } catch (e) {
    post({ id: job.id, ok: false, error: errText(e) });
  } finally {
    live.delete(job.id);
  }
}

function pump() {
  while (active < ACTIVE_MAX && queue.length) {
    const job = queue.shift();
    if (job.cancelled) {
      live.delete(job.id);
      post({ id: job.id, ok: false, cancelled: true });
      continue;
    }
    active++;
    runGround(job).finally(() => {
      active--;
      setTimeout(pump, 0);
    });
  }
}

self.onmessage = (ev) => {
  const m = ev.data || {};
  if (m.op === 'init') {
    if (!offscreenOk()) return post({ op: 'ready', ok: false });
    const suffix = m.stamp ? '?v=' + m.stamp : '';
    core = createCore(createIO(), { tj: m.tj, terrainUrl: m.terrainUrl, dataUrl: (p) => m.dataBase + p + suffix, small: !!m.small });
    return post({ op: 'ready', ok: true });
  }
  if (m.op === 'dem') return void dem(m);
  if (m.op === 'ground') {
    if (!core) return post({ id: m.id, ok: false });
    const job = { id: m.id, z: m.z, x: m.x, y: m.y, cancelled: false };
    live.set(m.id, job);
    queue.push(job);
    return pump();
  }
  if (m.op === 'cancel') {
    const job = live.get(m.id);
    if (job) job.cancelled = true;
  }
};
