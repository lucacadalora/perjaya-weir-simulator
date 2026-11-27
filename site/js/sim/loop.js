// Simulation loop. Owner: lane s01. CONTRACT 4.2 (`ctx.sim`), 4.4 (`clock`, `history`), addendum (frame clock).
//
// ctx.sim = { step(dtDays) -> Promise, reset() -> Promise, run(bool), clock, runner() }
// window.__simStep(dtSeconds) -> Promise (exact stepping for films; see sim/clock.js).
// Each step calls the runner of the current mode (sim/weir-run.js or sim/maker-run.js), emits `sim:tick` and fills
// `history`. The runners are loaded on their own: a missing or failing runner never stops the clock.

import { createClock, dateFor } from './clock.js';

export const HISTORY_MAX = 1500;
export const HISTORY_EVERY_DAYS = 0.25; // one history point at most every 6 simulated hours
export const DESIGN_SPEED = 1 / 24; // simulated days per real second during a design flood (one hour per second)
const HISTORY_KEYS = ['day', 'q_in', 'pond_el', 'q_down', 'q_intake', 'fill'];

export function emptyHistory() {
  const h = {};
  for (const k of HISTORY_KEYS) h[k] = [];
  return h;
}

// Push one point into the ring buffers (keeps at most HISTORY_MAX). Returns a new object (store notifies).
export function pushHistory(h, point) {
  const out = {};
  for (const k of HISTORY_KEYS) {
    const a = (h && Array.isArray(h[k]) ? h[k] : []).slice(-(HISTORY_MAX - 1));
    const v = point[k];
    a.push(Number.isFinite(v) ? v : null);
    out[k] = a;
  }
  return out;
}

function activeFill(store) {
  const m = store.get('maker') || {};
  const d = (m.dams || []).find((x) => x && x.id === m.active);
  return d && Number.isFinite(d.fill) ? d.fill : null;
}

async function loadRunner(ctx, mode) {
  const path = mode === 'maker' ? './maker-run.js' : './weir-run.js';
  try {
    const mod = await import(path);
    const make = mode === 'maker' ? mod.createMakerRun : mod.createWeirRun;
    if (typeof make !== 'function') return null;
    const r = await make(ctx);
    return r || null;
  } catch (e) {
    ctx.log?.('runner not ready:', mode, e && e.message);
    return null;
  }
}

export async function init(ctx) {
  const store = ctx && ctx.store;
  if (!store) return;
  const runners = {};
  let mode = store.get('mode') === 'maker' ? 'maker' : 'weir';
  let lastHistDay = -Infinity;
  let failures = 0;
  let toldDesign = null;
  const scenKey = (s) => (s ? [s.kind, s.year, s.design_T].join('|') : '');

  async function runner() {
    if (!(mode in runners)) runners[mode] = loadRunner(ctx, mode);
    return runners[mode];
  }

  function record(dayAt, force) {
    const c = store.get('clock') || {};
    const day = Number.isFinite(dayAt) ? dayAt : Number.isFinite(c.day) ? c.day : 0;
    if (!force && day - lastHistDay < HISTORY_EVERY_DAYS - 1e-9) return;
    if (day <= lastHistDay) return;
    lastHistDay = day;
    const w = store.get('weir') || {};
    const f = store.get('flow') || {};
    store.set('history', pushHistory(store.get('history'), {
      day,
      q_in: mode === 'maker' ? activeInflow(store) : f.q_in,
      pond_el: w.pond_el,
      q_down: w.q_down,
      q_intake: w.q_intake,
      fill: activeFill(store),
    }));
  }

  // One simulation step of dtDays (0 = evaluate the present day without advancing).
  async function runStep(dtDays) {
    const r = await runner();
    const clk = store.get('clock') || {};
    const end = Number.isFinite(clk.day) ? clk.day : 0;
    if (r && typeof r.step === 'function') {
      // the runner may cut the step (sub-daily steps around a design wave); each piece is stepped and recorded
      let parts = [dtDays];
      if (typeof r.chunks === 'function' && dtDays > 0) {
        const c = r.chunks(end - dtDays, dtDays);
        if (Array.isArray(c) && c.length) parts = c;
      }
      let d = end - dtDays;
      for (let i = 0; i < parts.length; i++) {
        d = i === parts.length - 1 ? end : d + parts[i];
        try {
          await r.step(parts[i], i === parts.length - 1 ? clk : { ...clk, day: d });
          failures = 0;
        } catch (e) {
          if (failures++ < 3) console.warn('[sim] ' + mode + ' step failed: ' + (e && e.message));
        }
        if (i < parts.length - 1) record(d, true);
      }
      if (parts.length > 1) {
        record(end, true);
        store.emit('sim:tick', { day: end, dt_days: dtDays, mode });
        return;
      }
    }
    record();
    store.emit('sim:tick', { day: store.get('clock.day'), dt_days: dtDays, mode });
  }

  const waitDrawn = () =>
    new Promise((res) => {
      const map = ctx.map;
      if (!map || typeof map.once !== 'function') return res();
      const to = setTimeout(res, 3000);
      map.once('render', () => {
        clearTimeout(to);
        res();
      });
      try {
        map.triggerRepaint();
      } catch {
        clearTimeout(to);
        res();
      }
    });

  const clock = createClock(store, { onStep: (d) => runStep(d), waitDrawn });

  async function reset() {
    const c = store.get('clock') || {};
    const scen = store.get('scenario') || {};
    const start = scen.kind === 'replay' && Number.isFinite(+scen.year) && scen.year ? scen.year + '-01-01' : c.start_date || '2025-01-01';
    store.set('clock', { ...c, day: 0, start_date: start, date: start });
    store.set('history', emptyHistory());
    lastHistDay = -Infinity;
    const r = await runner();
    if (r && typeof r.reset === 'function') {
      try {
        const o = await r.reset();
        if (!o || !o.design) toldDesign = null;
        if (o && Number.isFinite(o.start_day) && o.start_day > 0) {
          const c2 = store.get('clock') || {};
          const next = { ...c2, day: o.start_day, date: dateFor(c2.start_date, o.start_day) };
          // a design flood: an hour per second so the peak is seen, unless the link names its own day (scnDay);
          // the run state stays as it was. Told once per scenario.
          const scnDay = ctx.query && typeof ctx.query.has === 'function' && ctx.query.has('scnDay');
          if (o.design && !scnDay) next.speed = DESIGN_SPEED;
          store.set('clock', next);
          const key = scenKey(store.get('scenario'));
          if (o.design && !scnDay && toldDesign !== key) {
            toldDesign = key;
            const text = typeof ctx.t === 'function' ? ctx.t('sim.design_slow', 'Design flood: the simulation clock is slowed to 1 hour per second') : 'Design flood: the simulation clock is slowed to 1 hour per second';
            store.emit('toast', { text, kind: 'info' });
          }
        }
      } catch (e) {
        console.warn('[sim] ' + mode + ' reset failed: ' + (e && e.message));
      }
    }
    store.emit('sim:reset', { mode });
    await runStep(0);
  }

  ctx.sim = {
    step: (dtDays) => {
      const c = store.get('clock') || {};
      const d = Math.max(0, Number(dtDays) || 0);
      const day = (Number.isFinite(c.day) ? c.day : 0) + d;
      store.set('clock', { ...c, day, date: dateFor(c.start_date, day) });
      return runStep(d);
    },
    reset,
    run: (on) => store.set('clock.running', !!on),
    clock,
    runner,
    mode: () => mode,
  };
  if (typeof window !== 'undefined') window.__simStep = (dt) => clock.step(dt);

  store.on('mode', (m) => {
    const next = m === 'maker' ? 'maker' : 'weir';
    if (next === mode) return;
    mode = next;
    reset();
  });
  // A new kind, year or return period starts over; a slider (rain scale) only rebuilds the series.
  let lastScen = scenKey(store.get('scenario'));
  store.on('scenario', (s) => {
    const k = scenKey(s);
    if (k !== lastScen) {
      lastScen = k;
      reset();
      return;
    }
    for (const m of Object.keys(runners))
      Promise.resolve(runners[m]).then((r) => r && typeof r.reseries === 'function' && r.reseries()).catch(() => {});
  });

  clock.start();
  // First values before boot ends when they come quickly; never hold the page for a slow engine.
  const first = reset();
  ctx.sim.ready = first;
  let timer = null;
  await Promise.race([first, new Promise((r) => (timer = setTimeout(r, 4000)))]);
  clearTimeout(timer);
  first.then(() => { if (!('maker' in runners)) runners.maker = loadRunner(ctx, 'maker'); }); // listens for maker:place from the start
  if (!ctx.shot) {
    const go = () => store.set('clock.running', true);
    if (typeof window !== 'undefined' && window.__simReady) go();
    else store.listen('app:ready', go);
  }
}

function activeInflow(store) {
  const m = store.get('maker') || {};
  const d = (m.dams || []).find((x) => x && x.id === m.active);
  return d && Number.isFinite(d.inflow_m3s) ? d.inflow_m3s : null;
}

