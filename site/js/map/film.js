// Automatic aerial films and still pictures. Owner: lane b10. CONTRACT 4.2 (`ctx.film`), 2.6 (credits), A2.
//
// ctx.film = {
//   sizes                         { id: {w, h, label:[key, en]} }  ('720', '1080', 'vertical', 'square')
//   start({tour, seconds, size})  -> Promise<result|null>: records the tour at 30 frames a second. Time is driven by
//                                    window.__simStep(1/30) (lane s01), so every frame is exact however slow the
//                                    renderer; the title card and the credit line are burnt into each frame.
//   stop()                        ends a recording early; what was recorded is still finished into a file
//   still({size}) -> Promise<result>  a PNG of the map now, with the card and the credit line
//   result                        the last {blob, url, type, ext, name, bytes, via, codec, frames, seconds}
//   download(result)              saves it through a link
//   support() -> Promise<{h264, recorder}>
// }
// Store key `film` = {state 'idle'|'recording'|'encoding'|'done'|'error', tour, progress (0..1), kind, bytes, error}.
// Store event `film:frame` {i, n} after each recorded frame.

import { drawFrame, loadFonts } from './film/card.js';
import { createEncoder, h264Config, recorderMime } from './film/encode.js';

const FPS = 30;
export const SIZES = {
  '720': { w: 1280, h: 720, label: ['film.size_720', 'Wide 1280 × 720'] },
  '1080': { w: 1920, h: 1080, label: ['film.size_1080', 'Wide 1920 × 1080'] },
  vertical: { w: 720, h: 1280, label: ['film.size_vertical', 'Phone, upright 720 × 1280'] },
  square: { w: 1080, h: 1080, label: ['film.size_square', 'Square 1080 × 1080'] },
};

export async function init(ctx) {
  const { store, t, fmt } = ctx;
  if (store.get('film') == null) store.set('film', { state: 'idle', tour: null, progress: 0 });

  let credit = '';
  const creditReady = ctx.data.json('credits.json').then((list) => {
    if (Array.isArray(list)) credit = list.map((c) => c.short).filter(Boolean).join(' · ');
  }).catch(() => {});
  let presets = [];
  ctx.data.json('presets.json').then((p) => (presets = Array.isArray(p) ? p : [])).catch(() => {});

  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d', { alpha: false });
  let job = null; // {stop: bool}

  const mapCanvas = () => ctx.map?.getCanvas?.() || null;
  const sizeOf = (s) => {
    if (s && typeof s === 'object' && s.w && s.h) return { w: s.w, h: s.h };
    if (s === 'screen') {
      const c = mapCanvas();
      return c ? { w: c.width - (c.width % 2), h: c.height - (c.height % 2) } : SIZES['720'];
    }
    return SIZES[s] || SIZES['720'];
  };

  function info(progressBar) {
    const lang = store.get('lang') || 'id';
    const clock = store.get('clock') || {};
    const date = clock.date ? fmt.date(clock.date) : null;
    // The credit line comes only from credits.json (lane b18); start() and still() wait for it.
    const credits = [credit, t('film.made_with', 'Simulator Bendung Perjaya')].filter(Boolean).join(' · ');
    const note = t('app.model_note', 'Indicative model, not a survey');
    if ((store.get('mode') || 'weir') === 'maker') {
      const m = store.get('maker') || {};
      const d = (m.dams || []).find((x) => x.id === m.active) || null;
      if (d) {
        return {
          name: d.name || t('film.maker_dam', 'A dam of your own'),
          kind: t('film.kind_dam_' + (d.type || 'gravity'), d.type === 'embankment' ? 'Embankment dam (what-if)' : 'Gravity dam (what-if)'),
          date,
          numbers: [
            { label: t('film.n_level', 'Water level'), value: fmt.num(d.level_el, 1), unit: 'm' },
            { label: t('film.n_fill', 'Full'), value: fmt.num(d.fill == null ? null : d.fill * 100, 1), unit: '%' },
            { label: t('film.n_inflow', 'Inflow'), value: fmt.num(d.inflow_m3s, 0), unit: 'm³/s' },
          ],
          note, credit: credits, progress: progressBar && Number.isFinite(d.fill) ? d.fill : null,
        };
      }
    }
    const w = store.get('weir') || {};
    const flow = store.get('flow') || {};
    const p = presets.find((x) => x.id === 'weir');
    return {
      name: (p && p.name && p.name[lang]) || t('film.weir_name', 'Perjaya Weir'),
      kind: t('film.weir_kind', 'Gated weir · Sungai Komering'),
      date,
      numbers: [
        { label: t('film.n_pond', 'Pond level'), value: w.pond_el == null ? '–' : 'EL ' + fmt.num(w.pond_el, 2), unit: 'm' },
        { label: t('film.n_inflow', 'Inflow'), value: fmt.num(flow.q_in, 0), unit: 'm³/s' },
        { label: t('film.n_down', 'Downstream'), value: fmt.num(w.q_down, 0), unit: 'm³/s' },
      ],
      note, credit: credits, progress: null,
    };
  }

  function compose(w, h) {
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    drawFrame(g, mapCanvas(), w, h, info(true));
  }

  const stamp = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  };

  function keep(blob, ext, extra) {
    if (api.result?.url) { try { URL.revokeObjectURL(api.result.url); } catch { /* gone */ } }
    const name = `bendung-perjaya-${extra.tour || 'gambar'}-${stamp()}.${ext}`;
    api.result = { blob, url: URL.createObjectURL(blob), type: blob.type, ext, name, bytes: blob.size, ...extra };
    return api.result;
  }

  function download(r = api.result) {
    if (!r) return;
    const a = document.createElement('a');
    a.href = r.url;
    a.download = r.name;
    document.body.append(a);
    a.click();
    a.remove();
  }

  async function still(opts = {}) {
    const c = mapCanvas();
    if (!c) return null;
    const { w, h } = opts.size ? sizeOf(opts.size) : { w: c.width, h: c.height };
    await Promise.all([loadFonts(), creditReady]);
    ctx.map.triggerRepaint?.();
    await new Promise((r) => { let done = false; const fin = () => { if (!done) { done = true; r(); } }; ctx.map.once('render', fin); setTimeout(fin, 1500); });
    compose(w, h);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) return null;
    return keep(blob, 'png', { tour: null, w, h });
  }

  async function start(opts = {}) {
    if (job) return null;
    const cam = ctx.camera;
    const step = typeof window.__simStep === 'function' ? window.__simStep : null;
    const tourId = opts.tour || 'orbit';
    const tourDef = cam?.tours?.[tourId];
    const seconds = Number.isFinite(opts.seconds) && opts.seconds > 0 ? opts.seconds : tourDef?.seconds || 12;
    const { w, h } = sizeOf(opts.size || '720');
    const fail = (key, en) => {
      store.set('film', { state: 'error', tour: tourId, progress: 0, error: t(key, en) });
      return null;
    };
    if (!mapCanvas() || !cam || !tourDef) return fail('film.err_map', 'The film needs the map and its camera; neither is ready.');
    if (!step) return fail('film.err_clock', 'The film needs the simulation clock, which has not started.');

    job = { stop: false };
    const me = job;
    store.set('film', { state: 'recording', tour: tourId, progress: 0 });
    let enc = null;
    let frames = 0;
    let slow = false;
    ctx.camera?.setPadding?.(false); // the film frame is the whole canvas
    try {
      await Promise.all([loadFonts(), creditReady, cam.ready]);
      canvas.width = w;
      canvas.height = h;
      enc = await createEncoder({ canvas, width: w, height: h, fps: FPS, forceFallback: !!opts.forceFallback });
      if (!enc) throw new Error('no encoder');
      const n = Math.max(2, Math.round(seconds * FPS));
      const done = cam.tour(tourId, { seconds: (n - 1) / FPS, driven: true });
      const wall0 = performance.now();
      for (let i = 0; i < n && !me.stop; i++) {
        // Frame 0 shows the tour's first camera; each later step moves time by exactly 1/30 s.
        await step(i === 0 ? 0 : 1 / FPS);
        compose(w, h);
        await enc.add(i);
        // The recorder fallback stamps frames by the wall clock: if this browser cannot keep up with real time the
        // film would come out longer than asked, so stop and offer the still picture instead.
        if (enc.via === 'mediarecorder' && i >= 5 && (performance.now() - wall0) / 1000 > (i + 1) / FPS * 1.2) {
          slow = true;
          break;
        }
        frames = i + 1;
        store.emit('film:frame', { i, n });
        if (i % 3 === 0 || i === n - 1) store.patch('film', { progress: (i + 1) / n });
      }
      cam.stop();
      await done;
      if (slow) {
        enc.abort();
        enc = null;
        store.set('film', { state: 'error', tour: tourId, progress: 0, code: 'slow',
          error: t('film.err_slow', 'This browser records films too slowly to keep their speed. Save a still picture instead.') });
        return null;
      }
      store.patch('film', { state: 'encoding' });
      const { kind, via, codec } = enc;
      const blob = await enc.finish();
      enc = null;
      const r = keep(blob, kind, { tour: tourId, w, h, frames, seconds: frames / FPS, fps: FPS, via, codec });
      store.set('film', { state: 'done', tour: tourId, progress: 1, kind: r.ext, bytes: r.bytes });
      return r;
    } catch (e) {
      console.warn('[film] recording failed', e);
      try { enc?.abort(); } catch { /* closed */ }
      cam?.stop?.();
      fail('film.err_record', 'The film could not be recorded in this browser. A still picture still works.');
      return null;
    } finally {
      job = null;
      ctx.camera?.setPadding?.(true);
      // Give the page its own clock back (lane s01), if the clock offers it.
      try { ctx.sim?.clock?.release?.(); } catch { /* the page keeps the stepped clock */ }
    }
  }

  function stop() {
    if (job) job.stop = true;
  }

  async function support() {
    const s = SIZES['720'];
    const cfg = await h264Config(s.w, s.h, FPS, 6e6);
    return { h264: cfg ? cfg.codec : null, recorder: recorderMime() };
  }

  const ready = Promise.all([loadFonts(), creditReady]).then(() => {});
  const api = { sizes: SIZES, start, stop, still, download, support, info, ready, result: null, fps: FPS };
  ctx.film = api;
  window.__film = api;
  // URL options for filming the page itself (play=, view=, scn=, run=, mode=maker&dam=, ui=0).
  try { (await import('./film/autoplay.js')).start(ctx, api); } catch (e) { console.warn('[film] autoplay unavailable', e); }
}
