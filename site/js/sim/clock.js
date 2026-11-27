// The frame clock. Owner: lane s01. CONTRACT 4.2, 4.4 (`clock`) and the LEAD ADDENDUM (frame clock).
//
// - Emits `store.emit('frame', {dt, t})` once per animation frame (dt in real seconds, t = real seconds since start).
//   Everything that moves on screen takes its time from this event, never from its own requestAnimationFrame.
// - `window.__simStep(dt)`: from its first call the page's own loop stops; each call emits exactly one frame of `dt`
//   seconds, advances the simulation by dt * speed days, and resolves after the map has drawn (films are exact).
// - Store key `clock` = { day, date, start_date, speed (simulated days per real second), running }.
//   `speed` and `running` may also be written by the UI; the clock reads them every frame.
// No DOM is written here. Pure helpers are exported for node tests.

const DAY_MS = 86400000;
export const MAX_FRAME_DT = 0.25; // s: a stalled tab never makes one giant jump

export function parseDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

export function isoDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

// Calendar date of a (float) simulated day counted from start_date.
export function dateFor(startIso, day) {
  const s = parseDate(startIso);
  if (s == null || !Number.isFinite(day)) return startIso || null;
  return isoDate(s + Math.floor(day + 1e-9) * DAY_MS);
}

// Month index 0..11 and day of year 0..365 of a (float) simulated day.
export function calendarOf(startIso, day) {
  const s = parseDate(startIso) ?? Date.UTC(2025, 0, 1);
  const ms = s + Math.floor(day + 1e-9) * DAY_MS;
  const d = new Date(ms);
  const y0 = Date.UTC(d.getUTCFullYear(), 0, 1);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), doy: Math.round((ms - y0) / DAY_MS), mday: d.getUTCDate() };
}

// createClock(store, {onStep(dtDays) -> void|Promise, raf, now, waitDrawn})
// Returns { tick(dt) (one frame by hand), start(), stop(), step(dt) (= window.__simStep), external(), t() }.
export function createClock(store, opts = {}) {
  const raf = opts.raf || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(() => f(Date.now()), 16));
  const caf = opts.caf || (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout);
  const now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const onStep = opts.onStep || (() => {});
  const waitDrawn = opts.waitDrawn || (() => Promise.resolve());

  let t = 0; // real seconds of frames emitted
  let last = null;
  let handle = null;
  let ext = false; // true once __simStep took over
  let busy = null; // a pending step promise (async runner); frames never pile up behind it

  // One frame of dt real seconds: emit the frame, advance simulated time when running.
  function tick(dt) {
    dt = Math.max(0, Math.min(Number(dt) || 0, ext ? 3600 : MAX_FRAME_DT));
    t += dt;
    store.emit('frame', { dt, t });
    const c = store.get('clock') || {};
    if (!c.running || !(dt > 0)) return null;
    const speed = Number.isFinite(c.speed) && c.speed > 0 ? c.speed : 0;
    const dtDays = dt * speed;
    if (!(dtDays > 0)) return null;
    const day = (Number.isFinite(c.day) ? c.day : 0) + dtDays;
    const start = c.start_date || '2025-01-01';
    const date = dateFor(start, day);
    store.set('clock', { ...c, day, date, start_date: start });
    let r = null;
    try {
      r = onStep(dtDays);
    } catch (e) {
      console.error('[sim] step failed', e);
    }
    return r && typeof r.then === 'function' ? r : null;
  }

  function loop(ms) {
    handle = null;
    if (ext) return;
    const n = Number.isFinite(ms) ? ms : now();
    const dt = last == null ? 1 / 60 : (n - last) / 1000;
    last = n;
    if (!busy) {
      const p = tick(dt);
      if (p) busy = p.catch(() => {}).finally(() => (busy = null));
    } else {
      // The runner is still working (an awaited engine call): keep the picture moving, hold simulated time.
      t += Math.min(dt, MAX_FRAME_DT);
      store.emit('frame', { dt: Math.min(dt, MAX_FRAME_DT), t });
    }
    handle = raf(loop);
  }

  function start() {
    if (ext || handle != null) return;
    last = null;
    handle = raf(loop);
  }

  function stop() {
    if (handle != null) caf(handle);
    handle = null;
  }

  // window.__simStep(dtSeconds): exact stepping for the film tool.
  async function step(dt) {
    if (!ext) {
      ext = true;
      stop();
    }
    if (busy) await busy;
    const p = tick(dt);
    if (p) await p.catch(() => {});
    await waitDrawn();
  }

  // Give time back to the page's own loop after a recording (b10's film.start drove __simStep).
  function release() {
    ext = false;
    last = null;
    start();
  }

  return { tick, start, stop, step, release, external: () => ext, t: () => t };
}
