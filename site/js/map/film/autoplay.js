// Start-from-the-URL options for filming the page itself (a headless renderer in "clock mode"). Owner: lane b10.
// Loaded by map/film.js. Applied ONCE after `app:ready`; nothing here reads the wall clock: tours advance on the
// store's `frame` event (lane s01, driven by requestAnimationFrame) and the simulation by its own clock.
//
//   t0=<s>                          nothing of play, run or dam starts before the page's own time
//                                   (performance.now()/1000) reaches t0; scn/scnDay are prepared before it with the
//                                   clock held, so the film from t0 starts on the tour's first frame and the set day
//   play=<orbit|orbit-close|gates|river|floodplain>   start that camera tour; tourSeconds=<n> its length (default the tour's own);
//                                   loop=1 repeats it
//   view=<view name>                jump to a named camera view instead (ctx.camera.views)
//   scn=<mean|dry2019|design|q100>  the scenario the overview's four buttons set; scnDay=<n> moves the clock to that
//                                   day of the scenario year first
//   run=1 [speed=<days per s>]      start the clock
//   mode=maker&dam=<preset id>      place that preset dam (presets.json kind 'dam') and let it fill (runs the clock
//                                   unless run=0)
//   (no view/play)                  the share hash's camera #c=... is applied
//   ui=0                            store view.film = true; hide the top bar, status card, panel, map buttons and credits strip; show the
//                                   film title card and the credit line as an overlay, same layout as the recorder
//   act=<gates|touch|flush>         something happens on the frame clock from t0 (see act() below); flush: the clock
//                                   runs at an hour per second (or speed=) and at 1 s the fullest settling basin is
//                                   flushed by hand (lane s), so a film of 8 to 12 s shows the whole flush. Give t0 a
//                                   little after the film's start (e.g. start=60, t0=60.5): the frames skipped before
//                                   the start come in coarse steps and would count towards the 1 s
// None is active unless given (also with shot=1).

import { drawOverlay } from './card.js';

const DRY_YEAR = 2019; // FALLBACK: params flat scenario.dry_year (as tab-ringkas)
const DESIGN_T = 100; // FALLBACK: params flat scenario.design_T (as tab-ringkas)

// Pure: the query options this module understands, cleaned. Exported for node tests.
export function readOptions(search) {
  const q = new URLSearchParams(search || '');
  const num = (k) => (q.has(k) && Number.isFinite(+q.get(k)) ? +q.get(k) : null);
  const o = {};
  if (q.get('play')) o.play = q.get('play');
  if (num('tourSeconds') > 0) o.tourSeconds = num('tourSeconds');
  if (q.get('loop') === '1') o.loop = true;
  if (q.get('view')) o.view = q.get('view');
  if (['mean', 'dry2019', 'design', 'q100'].includes(q.get('scn'))) o.scn = q.get('scn');
  if (num('scnDay') >= 0 && q.has('scnDay')) o.scnDay = num('scnDay');
  if (q.get('run') === '1') o.run = true;
  if (q.get('run') === '0') o.run = false;
  if (num('speed') > 0) o.speed = num('speed');
  if (q.get('mode') === 'maker' || q.get('mode') === 'weir') o.mode = q.get('mode');
  if (q.get('dam')) o.dam = q.get('dam');
  if (q.get('ui') === '0') o.ui = false;
  if (['gates', 'touch', 'flush'].includes(q.get('act'))) o.act = q.get('act');
  if (num('t0') > 0) o.t0 = num('t0');
  return o;
}

// Pure: the scenario object for a scn option (same keys as the overview's buttons, lane b01).
export function scenarioFor(scn, flat = {}, t = (k, en) => en, fmtQ = (v) => (v == null ? '–' : v + ' m³/s')) {
  const dry = Number.isFinite(flat['scenario.dry_year']) ? flat['scenario.dry_year'] : DRY_YEAR;
  const T = Number.isFinite(flat['scenario.design_T']) ? flat['scenario.design_T'] : DESIGN_T;
  if (scn === 'mean') return { kind: 'climatology', year: null, rain_scale: 1, label: t('ringkas.try_mean', 'A mean year'), design_T: null };
  if (scn === 'dry2019') return { kind: 'replay', year: dry, rain_scale: 1, label: t('ringkas.try_dry', 'The dry year {year}', { year: dry }), design_T: null };
  if (scn === 'design') return { kind: 'design', year: null, rain_scale: 1, label: t('ringkas.try_design_weir', 'Weir design flood {q}', { q: fmtQ(flat['scenario.design_q_m3s'] ?? flat['weir.design_flood_m3s'] ?? null) }), design_T: null };
  if (scn === 'q100') return { kind: 'design', year: null, rain_scale: 1, label: t('ringkas.try_flood_T', '{T}-year flood', { T }), design_T: T };
  return null;
}

export function start(ctx, film) {
  const o = readOptions(location.search);
  const { store } = ctx;
  store.set('view.film', o.ui === false); // lane b05 thins the map's labels when true
  if (!Object.keys(o).length) return;
  let done = false;
  store.listen('app:ready', () => {
    if (done) return;
    done = true;
    apply(ctx, film, o).catch((e) => console.warn('[film] autoplay', e));
  });
}

// The camera in the share hash (#c=lon,lat,zoom,pitch,bearing), parsed here (a map module never imports ui/share).
export function hashCamera(hash) {
  const m = /(?:^#|&)c=([^&]*)/.exec(String(hash || ''));
  if (!m) return null;
  const [lon, lat, zoom, pitch, bearing] = decodeURIComponent(m[1]).split(',').map(Number);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const c = { lon, lat };
  if (Number.isFinite(zoom)) c.zoom = zoom;
  if (Number.isFinite(pitch)) c.pitch = pitch;
  if (Number.isFinite(bearing)) c.bearing = bearing;
  return c;
}

// Resolves on the first frame event at which the page's own time (performance.now() / 1000) has reached t0.
function untilPageTime(store, t0) {
  if (!(t0 > 0) || performance.now() / 1000 >= t0) return Promise.resolve();
  return new Promise((resolve) => {
    const off = store.listen('frame', () => {
      if (performance.now() / 1000 >= t0) { off(); resolve(); }
    });
  });
}

async function apply(ctx, film, o) {
  const { store, t } = ctx;
  const cam = ctx.camera;
  const hold = o.t0 > 0;
  if (hold) store.set('clock.running', false); // nothing moves in simulated time before t0
  if (o.ui === false) overlay(ctx, film);

  let flat = {};
  try { flat = (await ctx.data.json('params.json'))?.flat || {}; } catch { /* fallbacks */ }

  if (o.mode && store.get('mode') !== o.mode) store.set('mode', o.mode);

  // Camera before t0: a named view, else the share hash's camera (after any padding change above).
  if (cam) {
    if (o.view && !o.play) cam.goto(o.view, { ms: 0 });
    else if (!o.play) {
      const hc = hashCamera(location.hash);
      if (hc) cam.goto(hc, { ms: 0 });
    }
  }

  // The scenario and its day are prepared with the clock held, so that at t0 the film starts on the set day.
  if (o.scn) {
    const sc = scenarioFor(o.scn, flat, t, ctx.fmt?.q);
    store.set('scenario', { ...(store.get('scenario') || {}), ...sc });
    try { await ctx.sim?.reset?.(); } catch { /* the clock keeps going */ }
    if (hold) store.set('clock.running', false);
  }
  if (Number.isFinite(o.scnDay) && o.scnDay > 0 && ctx.sim?.step) {
    // Walk to the day in steps of at most 5 days, so every runner sees an ordinary step.
    let left = o.scnDay - (store.get('clock.day') || 0);
    while (left > 1e-9) {
      const d = Math.min(5, left);
      try { await ctx.sim.step(d); } catch { break; }
      left -= d;
    }
  }
  let presets = [];
  if (o.mode === 'maker' && o.dam) {
    try { presets = (await ctx.data.json('presets.json')) || []; } catch { presets = []; }
  }
  if (cam && o.play) await cam.ready;

  // ---- t0: from here on, things move ----
  await untilPageTime(store, o.t0);

  if (o.mode === 'maker' && o.dam) {
    const p = presets.find((x) => x.id === o.dam && x.kind === 'dam');
    if (p) {
      const lang = store.get('lang') || 'id';
      store.emit('maker:place', { ...(p.dam || {}), lon: p.lon, lat: p.lat, name: p.name?.[lang] || p.name?.id || p.id, preset: p.id });
      if (o.run !== false) o.run = true;
    }
  }
  if (o.speed) store.set('clock.speed', o.speed);
  if (o.run === true) store.set('clock.running', true);
  if (o.run === false) store.set('clock.running', false);

  if (o.act) act(ctx, o.act, o);

  if (cam && o.play && cam.tours?.[o.play]) {
    const go = () => cam.tour(o.play, { seconds: o.tourSeconds || undefined, driven: true }).then((r) => {
      if (o.loop && r && r.done) go();
    });
    go();
  }
}

// act=<gates|touch|flush>: something happens to the water from t0, on the frame clock (so a film of it is exact).
//   gates: by hand, every gate shut, then flood gates lift one after another and one closes again;
//   touch: rings on the pond, as a pointer makes them (scene metres from the weir axis: x east, z south);
//   flush: the basins stand part full (their fills at the start of a run); the clock runs at an hour per second
//          (unless speed= is given) and at 1 s the fullest basin is flushed by hand: a 4-hour flush takes 4 s.
export const FLUSH_SPEED = 1 / 24; // simulated days per second for act=flush (display: one hour per second)
export const FLUSH_AT_S = 1.0; // seconds after t0
function act(ctx, name, o = {}) {
  const { store } = ctx;
  let t = 0;
  const plan = [];
  if (name === 'flush') {
    store.patch('clock', { speed: o.speed || FLUSH_SPEED, running: o.run !== false });
    plan.push([FLUSH_AT_S, () => store.emit('sediment:flush', { basin: null })]);
    // with the panel shown, bring the operation tab's settling-basin block into view (a film aid)
    if (o.ui !== false) setTimeout(() => document.querySelector('.operasi-sed')?.scrollIntoView({ block: 'end' }), 0);
  } else if (name === 'gates') {
    const n = (store.get('weir.gates') || []).length || 7;
    const ns = (store.get('weir.sluices') || []).length || 3;
    store.patch('weir', { mode: 'manual', gates: new Array(n).fill(0), sluices: new Array(ns).fill(0) });
    const lift = (i, a) => () => {
      const g = (store.get('weir.gates') || []).slice();
      if (i < g.length) g[i] = a;
      store.set('weir.gates', g);
    };
    plan.push([1.2, lift(3, 1.6)], [3.0, lift(5, 2.6)], [4.8, lift(1, 0.7)], [7.0, lift(3, 0)]);
  } else {
    const tap = (x, z, k) => () => ctx.water?.touch?.(x, z, k);
    plan.push([0.4, tap(-30, 55, 1.7)], [1.5, tap(25, 80, 1.7)], [2.4, tap(-70, 95, 1.4)], [3.3, tap(60, 45, 1.7)], [4.4, tap(-10, 110, 1.7)]);
  }
  store.listen('frame', (f) => {
    t += (f && f.dt) || 0;
    while (plan.length && t >= plan[0][0]) plan.shift()[1]();
  });
}

// ui=0: the app's chrome hidden; the film's card and credit line drawn over the map with the recorder's own layout,
// redrawn on every frame event (and when the store changes) so a film of the page carries them.
function overlay(ctx, film) {
  const { store } = ctx;
  const st = document.createElement('style');
  st.textContent = '#topbar,#status,#panel,#maptools,#credits,#toast,.dev-drawer{display:none!important}'
    + '#film-overlay{position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:40}';
  document.head.append(st);
  ctx.camera?.setPadding?.(false);
  const cv = document.createElement('canvas');
  cv.id = 'film-overlay';
  cv.setAttribute('aria-hidden', 'true');
  document.body.append(cv);
  const g = cv.getContext('2d');
  let dirty = true;
  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    g.clearRect(0, 0, w, h);
    drawOverlay(g, w, h, film.info(true));
    dirty = false;
  };
  for (const k of ['clock.date', 'weir', 'flow', 'maker', 'lang', 'mode']) store.on(k, () => (dirty = true));
  window.addEventListener('resize', () => (dirty = true));
  store.listen('frame', () => { if (dirty) draw(); });
  film.ready.then(draw);
}
