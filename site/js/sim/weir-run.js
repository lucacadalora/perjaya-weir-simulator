// Weir-mode runner. Owner: lane s01. CONTRACT 4.4 (`flow`, `weir`, `flood`, `impact`, `irrigation`, `rain`), 4.5, 4.8.
//
// Each step: the scenario's flow for the date -> canal demand (irrigation engine) -> gates (weir.autoGates, or the
// manual controls) -> weir.solve -> results into the store. Then flood: the stage from the flow below the weir and
// from the pond's rise; the extent through the worker when a stage moved by 0.1 m (at most every 0.4 s of frames);
// then the impact count. Every engine may be missing: each call is guarded and the clock keeps running.
// Sediment (lane s, 24 Nov 2026): after the irrigation balance, engine/sediment.js carries the river's load through
// the intake into the five settling basins and flushes them (store key `sediment`, event `sediment:flush`).
// Light engines are imported here directly; anything that touches a grid goes through ctx.engine.call.

import { calendarOf } from './clock.js';

// ---------- shared helpers (maker-run.js imports these) ----------

// {v, unit, status, src} leaves -> plain values, recursively.
export function unwrap(o) {
  if (o == null || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(unwrap);
  if ('v' in o && ('status' in o || 'unit' in o || 'src' in o)) return unwrap(o.v);
  const out = {};
  for (const k of Object.keys(o)) out[k] = unwrap(o[k]);
  return out;
}

// One parameter group as plain values: params.flat[name] when it is an object, else flat keys "name.x", else params[name].
export function paramGroup(params, name) {
  if (!params) return {};
  const flat = params.flat;
  if (flat && typeof flat === 'object') {
    if (flat[name] && typeof flat[name] === 'object') return unwrap(flat[name]);
    const pre = name + '.';
    const keys = Object.keys(flat).filter((k) => k.startsWith(pre));
    if (keys.length) {
      const g = {};
      for (const k of keys) g[k.slice(pre.length)] = unwrap(flat[k]);
      return g;
    }
  }
  return unwrap(params[name]) || {};
}

// Import a light engine module; null when it is not there yet.
const engineCache = new Map();
let override = null;
// Tests only: setEngineOverride({weir: stubModule, flood: null, ...}) replaces the light engines (null = missing).
export function setEngineOverride(map) {
  override = map || null;
}
export function lightEngine(name) {
  if (override && name in override) return Promise.resolve(override[name]);
  if (!engineCache.has(name)) {
    engineCache.set(
      name,
      import('../engine/' + name + '.js').catch(() => null), // missing until its lane ships; a reload picks it up
    );
  }
  return engineCache.get(name);
}

// A guarded call: returns the value or null, never throws. Warns once per key.
const warned = new Set();
export function guard(key, fn) {
  try {
    const v = fn();
    if (v && typeof v.then === 'function')
      return v.catch((e) => {
        warnOnce(key, e);
        return null;
      });
    return v;
  } catch (e) {
    warnOnce(key, e);
    return null;
  }
}
export function warnOnce(key, e) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn('[sim] ' + key + ' not used: ' + ((e && e.message) || e));
}

// A worker call through ctx.engine; null when the worker or the function is not there.
export async function workerCall(ctx, fn, args) {
  const eng = ctx && ctx.engine;
  if (!eng || typeof eng.call !== 'function') return null;
  return guard('engine.call ' + fn, () => eng.call(fn, args));
}

export async function loadJson(ctx, path) {
  if (!ctx || !ctx.data) return null;
  return guard('data ' + path, () => ctx.data.json(path));
}

const num = (v) => (Number.isFinite(v) ? v : null);

// Value of a daily series at a float day (linear between days; wraps when wrap is true).
export function seriesAt(q, day, wrap = true) {
  if (!q || !q.length) return null;
  const n = q.length;
  let d = Math.max(0, day);
  if (wrap) d = d % n;
  else d = Math.min(d, n - 1);
  const i = Math.floor(d);
  const f = d - i;
  const a = q[i];
  const b = q[wrap ? (i + 1) % n : Math.min(i + 1, n - 1)];
  return Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * f : num(a);
}

// ---------- the scenario's series ----------

// FALLBACK until sim/scenarios.js (b13) answers: built from the modelled river flow and the basin rain files.
export function fallbackSeries(scenario, rain, flow) {
  const sc = scenario || {};
  const scale = Number.isFinite(sc.rain_scale) && sc.rain_scale > 0 ? sc.rain_scale : 1;
  const year = Number(sc.year);
  const days = 365;
  const q = new Float32Array(days);
  const r = new Float32Array(days);
  const mm = (flow && flow.monthly_mean) || null;
  const rm = (rain && (rain.monthly_mean_1991_2020 || rain.monthly_mean_2015_2024)) || null;
  const start = sc.kind === 'replay' && year ? year + '-01-01' : '2025-01-01';
  const fromDaily = (src, scaleV, y) => {
    if (!src || !src.start || !src.values) return null;
    const s0 = Date.parse(src.start + 'T00:00:00Z');
    const off = Math.round((Date.UTC(y, 0, 1) - s0) / 86400000);
    if (off < 0 || off + days > src.values.length) return null;
    return (i) => src.values[off + i] * scaleV;
  };
  const qDaily = sc.kind === 'replay' && year ? fromDaily(flow && flow.daily, 1, year) : null;
  const rDaily = sc.kind === 'replay' && year ? fromDaily(rain && rain.daily_basin_mean, (rain.daily_basin_mean && rain.daily_basin_mean.scale) || 1, year) : null;
  for (let i = 0; i < days; i++) {
    const c = calendarOf(start, i);
    const mlen = new Date(Date.UTC(c.year, c.month + 1, 0)).getUTCDate();
    // smooth month means: blend towards the neighbour month across the month
    const f = (c.mday - 0.5) / mlen - 0.5;
    const nb = f < 0 ? (c.month + 11) % 12 : (c.month + 1) % 12;
    const w = Math.abs(f);
    const mid = (arr) => (arr ? arr[c.month] * (1 - w) + arr[nb] * w : null);
    q[i] = qDaily ? qDaily(i) : (mid(mm) ?? NaN) * scale;
    r[i] = rDaily ? rDaily(i) * scale : rm ? (mid(rm) / mlen) * scale : NaN;
  }
  if (sc.kind === 'design' && flow && flow.flood_frequency) {
    const T = Number(sc.design_T) || 25;
    const peak = flow.flood_frequency['Q' + T] ?? flow.flood_frequency.Q25;
    if (Number.isFinite(peak)) {
      // a smooth flood wave on top of the seasonal flow, peaking 40 days in (FALLBACK shape)
      const t0 = 40;
      const base = q[t0];
      for (let i = 0; i < days; i++) {
        const x = (i - t0) / 4;
        const bump = Math.exp(-x * x);
        q[i] = q[i] + Math.max(0, peak - base) * bump;
      }
    }
  }
  return { start, q_m3s: q, rain_mm: r, fallback: true };
}

// The engine's series (b13 rainflow.inflowSeries) when sim/scenarios.js is not there yet. Null on any gap.
export async function engineSeries(sc, D, RF, store, SC) {
  const f = RF && RF.inflowSeries;
  // the engine wants the bucket shape that scenarios.bucketParams builds (q01), never the raw flat group
  const rp = SC && typeof SC.bucketParams === 'function' ? guard('scenarios.bucketParams', () => SC.bucketParams(D.params)) || {} : {};
  const area = paramGroup(D.params, 'catchment').area_km2;
  if (typeof f !== 'function' || !D.rain || !Number.isFinite(area) || !Object.keys(rp).length) return null;
  const share = store && store.get('rain.runoff_share');
  const s = guard('rainflow.inflowSeries', () =>
    f({ kind: sc.kind || 'climatology', year: sc.year ?? null, rain: D.rain, flow: D.flow, area_km2: area, rain_scale: sc.rain_scale ?? 1,
      share: Number.isFinite(share) ? share : null, params: rp, monthly_mm: store && store.get('rain.monthly_mm'), design: sc.kind === 'design' ? { T: sc.design_T ?? null } : null }),
  );
  return validSeries(s) ? s : null;
}

// A series is usable only when its flows are numbers (q01: a NaN series must never be taken).
export function validSeries(s) {
  if (!s || !s.q_m3s || !s.q_m3s.length) return false;
  const q = s.q_m3s;
  const step = Math.max(1, Math.floor(q.length / 24));
  for (let i = 0; i < q.length; i += step) if (!Number.isFinite(q[i])) return false;
  return Number.isFinite(q[q.length - 1]);
}

// The scenario's flow on a fractional day: b13's flowAt reads a design wave's sub-daily points; else linear.
let flowAtFn = null;
export function useFlowAt(fn) {
  flowAtFn = typeof fn === 'function' ? fn : null;
}
export function flowOf(s, day) {
  if (flowAtFn) {
    const v = guard('scenarios.flowAt', () => flowAtFn(s, day));
    if (Number.isFinite(v)) return v;
  }
  return seriesAt(s && s.q_m3s, day);
}

// Day (fractional) of a design wave's highest point: from its sub-daily points when b13 gives them.
export function peakTime(s) {
  if (!s || !Number.isFinite(s.peak_day)) return null;
  const w = s.wave;
  if (w && w.q_m3s && w.q_m3s.length && Number.isFinite(w.start_day) && w.step_days > 0) {
    let k = 0;
    for (let i = 1; i < w.q_m3s.length; i++) if (w.q_m3s[i] > w.q_m3s[k]) k = i;
    return w.start_day + k * w.step_days;
  }
  return s.peak_day;
}

// ---------- the runner ----------

const DAY_S = 86400;
export const FLOOD_STAGE_STEP_M = 0.1; // re-draw the flood when a stage moved this much (brief s01)
export const FLOOD_MIN_GAP_S = 0.4; // and at most this often, in seconds of frames
const DESIGN_LEAD_DAYS = 0.75; // a design flood starts 18 hours before its peak (lead's pacing ruling)
const SUBSTEP_DAYS = 1 / 24; // one simulated hour per step around a design wave
const DESIGN_WAVE_HALF_DAYS = 4; // FALLBACK half-width of the wave window until the series says (b13)

// createWeirRun(ctx) -> { reset(), step(dtDays, clock), inputs() }
export async function createWeirRun(ctx) {
  const store = ctx.store;
  const D = { params: null, weirJson: null, rain: null, flow: null };
  const E = {}; // light engines: weir, rainflow, irrigation, flood, scenarios
  let series = null;
  let cachedWP = null;
  let pondPrev = null;
  let rel = { ok: 0, all: 0 };
  // A8.5: running totals of the scenario year (reset on sim:reset and at each new calendar year)
  let yr = { year: null, short_days: 0, short_volume_m3: 0, days_run: 0 };
  let lastRes = null;
  let fl = { busy: null, stage: null, up: null, at: -Infinity, version: 0, dry: null };

  async function loadAll() {
    const [params, weirJson, rain, flow] = await Promise.all([
      loadJson(ctx, 'params.json'),
      loadJson(ctx, 'weir.json'),
      loadJson(ctx, 'climate/rain.json'),
      loadJson(ctx, 'climate/flow_glofas.json'),
    ]);
    Object.assign(D, { params, weirJson, rain, flow });
    for (const n of ['weir', 'rainflow', 'irrigation', 'flood', 'sediment']) E[n] = await lightEngine(n);
    E.scenarios = await import('./scenarios.js').catch(() => null);
    if (E.scenarios) useFlowAt(E.scenarios.flowAt);
  }
  const loaded = loadAll().catch((e) => warnOnce('weir-run data', e));

  // Engine constants, built from params.json and weir.json (never typed here).
  function inputs() {
    const P = D.params;
    if (!cachedWP && E.weir && typeof E.weir.weirParamsFromData === 'function' && P)
      cachedWP = guard('weir.weirParamsFromData', () => E.weir.weirParamsFromData(P, D.weirJson)) || null;
    const weirParams = cachedWP;
    return {
      weirParams,
      floodParams: paramGroup(P, 'flood'),
      irrParams: paramGroup(P, 'irrigation'),
      rainParams: paramGroup(P, 'rainflow'),
      catchment: paramGroup(P, 'catchment'),
      offset: paramGroup(P, 'datum').offset_m,
      refTail: paramGroup(P, 'flood').ref_tail_el, // A7.3: the normal river's edge below the weir (project EL)
      refPond: paramGroup(P, 'weir').pond_normal_el, // A7.3: the normal pond (project EL)
    };
  }

  async function makeSeries() {
    const sc = store.get('scenario') || {};
    let s = null;
    const f = E.scenarios && E.scenarios.seriesFor;
    if (typeof f === 'function') {
      const rn = store.get('rain') || {};
      s = await guard('scenarios.seriesFor', () => f(sc, { rain: D.rain, flow: D.flow }, D.params, { monthly_mm: rn.monthly_mm ?? null, runoff_share: rn.runoff_share ?? null }));
      if (!validSeries(s)) s = null;
    }
    if (!s) s = await engineSeries(sc, D, E.rainflow, store, E.scenarios);
    if (!s) s = fallbackSeries(sc, D.rain, D.flow);
    series = s;
    ctx.fields && ctx.fields.set('scenario.series', s);
  }

  // ---- sediment through the intake and the settling basins (engine/sediment.js; store key `sediment`, lane s) ----
  // The engine's state lives here; `sediment.auto` (UI) switches the automatic flushing rule; the event
  // `sediment:flush` {basin|null} asks for a flush by hand (null: the fullest basin). Tonnes trapped and returned:
  // over the last 24 simulated hours (`last_day`) and as running totals of the calendar year (`year`), reset on
  // sim:reset and at each new year (like the irrigation counts).
  const sed = { P: undefined, st: null, year: null, hist: [], yr: null };
  function sedParams() {
    if (sed.P === undefined && E.sediment && typeof E.sediment.sedimentParams === 'function' && D.params)
      sed.P = guard('sediment.sedimentParams', () => E.sediment.sedimentParams(D.params, D.weirJson)) || null;
    return sed.P || null;
  }
  function sedReset() {
    sed.st = null;
    sed.year = null;
    sed.hist = [];
    sed.yr = { trapped_t: 0, returned_t: 0 };
  }
  sedReset();
  // the last 24 simulated hours: the steps that end inside them, the oldest one counted for its share
  function lastDay(now) {
    let trapped_t = 0;
    let returned_t = 0;
    for (const h of sed.hist) {
      const f = h.dt > 0 ? Math.max(0, Math.min(1, (h.end - Math.max(h.end - h.dt, now - 1)) / h.dt)) : 1;
      trapped_t += h.tr * f;
      returned_t += h.rt * f;
    }
    return { trapped_t, returned_t };
  }
  function sedPublish(out, now) {
    store.patch('sediment', { ...out, last_day: lastDay(now), year: { ...sed.yr } });
  }
  function sedStep(dtDays, q_in, q_intake, clock) {
    const S = E.sediment;
    const P = sedParams();
    if (!S || !P || typeof S.step !== 'function') return;
    if (!sed.st) sed.st = guard('sediment.initState', () => S.initState(P));
    if (!sed.st) return;
    const auto = store.get('sediment.auto') !== false;
    const r = guard('sediment.step', () => S.step(sed.st, { q_river: q_in, q_intake, dt_s: dtDays * DAY_S, auto }, P));
    if (!r) return;
    sed.st = r.state;
    const day = (clock && clock.day) || 0;
    const c = calendarOf(clock && clock.start_date, day);
    // the share of this step that fell in the new calendar year is counted there
    const inYear = dtDays > 0 ? Math.min(1, (c.doy + day - Math.floor(day + 1e-9)) / dtDays) : 0;
    if (sed.year !== c.year) {
      if (sed.year != null) sed.yr = { trapped_t: r.out.trapped_t * inYear, returned_t: r.out.returned_t * inYear };
      else sed.yr = { trapped_t: r.out.trapped_t, returned_t: r.out.returned_t };
      sed.year = c.year;
    } else {
      sed.yr.trapped_t += r.out.trapped_t;
      sed.yr.returned_t += r.out.returned_t;
    }
    if (dtDays > 0) {
      sed.hist.push({ end: day, dt: dtDays, tr: r.out.trapped_t, rt: r.out.returned_t });
      while (sed.hist.length && (sed.hist[0].end <= day - 1 || sed.hist.length > 5000)) sed.hist.shift();
    }
    sedPublish(r.out, day);
  }
  // a flush by hand shows at once, also with the clock stopped (it moves on with simulated time)
  store.listen('sediment:flush', (p) => {
    const S = E.sediment;
    const P = sedParams();
    if (!S || !P || typeof S.requestFlush !== 'function') return;
    if (!sed.st) sed.st = guard('sediment.initState', () => S.initState(P));
    if (!sed.st) return;
    const r = guard('sediment.requestFlush', () => S.requestFlush(sed.st, p && Number.isInteger(p.basin) ? p.basin : null, P));
    if (!r) return;
    sed.st = r.state;
    const w = store.get('weir') || {};
    const e = guard('sediment.step', () => S.step(sed.st, { q_river: store.get('flow.q_in'), q_intake: w.q_intake, dt_s: 0, auto: store.get('sediment.auto') !== false }, P));
    if (!e) return;
    sed.st = e.state;
    sedPublish(e.out, store.get('clock.day') || 0);
  });

  async function reset() {
    await loaded;
    pondPrev = null;
    sedReset();
    rel = { ok: 0, all: 0 };
    yr = { year: null, short_days: 0, short_volume_m3: 0, days_run: 0 };
    fl = { busy: null, stage: null, up: null, at: -Infinity, version: fl.version, dry: null };
    await makeSeries();
    // a design flood starts 18 hours before the wave's peak (newcomer walk: at a day per second it was missed)
    const pk = peakTime(series);
    return pk != null ? { start_day: Math.max(0, pk - DESIGN_LEAD_DAYS), design: true } : null;
  }

  // N3: the demand never waits for the irrigation tab. The tab's pattern wins key by key over defaults built here
  // from params and rain.json (irrigation.rainInputs), the same way b17's fillDefaults builds them.
  let patDefaults = null;
  let patMerged = { src: undefined, out: null };
  function patternFor(fromStore, I) {
    if (!patDefaults) {
      const ii = I.irrParams || {};
      const ri = E.irrigation && typeof E.irrigation.rainInputs === 'function'
        ? guard('irrigation.rainInputs', () => E.irrigation.rainInputs(D.rain, paramGroup(D.params, 'rainflow').et0_monthly_mm)) || {} : {};
      patDefaults = {};
      for (const k of ['start_hm', 'groups', 'efficiency']) if (Number.isFinite(ii[k])) patDefaults[k] = ii[k];
      const ownR80 = Array.isArray(ii.r80_halfmonth_mm) && ii.r80_halfmonth_mm.length === 24;
      if (!ownR80 && Array.isArray(ri.r5_mm)) patDefaults.r5_mm = ri.r5_mm;
      if (Array.isArray(ri.eto_mm_day)) patDefaults.eto_mm_day = ri.eto_mm_day;
    }
    if (!patMerged.out || patMerged.src !== fromStore) {
      const out = { ...patDefaults };
      if (fromStore && typeof fromStore === 'object') for (const [k, v] of Object.entries(fromStore)) if (v != null) out[k] = v;
      patMerged = { src: fromStore, out };
    }
    return patMerged.out;
  }

  function canalDemand(day, clock, I) {
    const w = store.get('weir') || {};
    if (Number.isFinite(w.demand_m3s)) return w.demand_m3s; // set by hand in the operation tab
    const irr = store.get('irrigation') || {};
    const pattern = patternFor(irr.pattern, I);
    const fn = E.irrigation && E.irrigation.demand;
    if (typeof fn !== 'function') return null;
    const c = calendarOf(clock.start_date, day);
    const area = Number.isFinite(irr.area_ha) ? irr.area_ha : I.irrParams.area_default_ha ?? null;
    if (!Number.isFinite(area)) return null;
    return num(guard('irrigation.demand', () => fn({ area_ha: area, month: c.month + 1, day: c.mday, doy: c.doy + 1, pattern, params: I.irrParams })));
  }

  async function step(dtDays, clock) {
    await loaded;
    if (!series) await makeSeries();
    const day = (clock && clock.day) || 0;
    const I = inputs();
    const q_in = num(flowOf(series, day));
    const r = series.rain_mm ? num(seriesAt(series.rain_mm, Math.floor(day), true)) : null;
    store.patch('flow', { q_in, q_base: num(series.q_base ? seriesAt(series.q_base, day) : null), q_ranau: num(series.q_ranau ? seriesAt(series.q_ranau, day) : null) });
    store.patch('rain', { today_mm: r });

    const cy = calendarOf(clock && clock.start_date, day).year;
    if (yr.year !== cy) yr = { year: cy, short_days: 0, short_volume_m3: 0, days_run: 0 };
    const demand = canalDemand(day, clock, I);
    const ctl = store.get('weir') || {};
    const W = E.weir;
    const { gates, sluices, intake_open } = ctl;
    const manual = ctl.mode === 'manual';
    let sol = null;
    // weir.solve resolves the mode itself (auto: weir.autoGates; flush, flood, closed: their rule; manual: as set)
    if (W && typeof W.solve === 'function' && q_in != null && I.weirParams) {
      const controls = { mode: ctl.mode || 'auto', gates, sluices, intake_open, demand_m3s: demand };
      sol = guard('weir.solve', () => W.solve({ q_in, controls, weirParams: I.weirParams, pond_el_prev: pondPrev, dt_s: dtDays * DAY_S }));
    }
    const res = sol
      ? {
          pond_el: num(sol.pond_el), tail_el: num(sol.tail_el), q_gates: num(sol.q_gates), q_sluices: num(sol.q_sluices),
          q_intake: num(sol.q_intake), q_down: num(sol.q_down), q_spill: num(sol.q_spill), freeboard_m: num(sol.freeboard_m),
          alerts: Array.isArray(sol.alerts) ? sol.alerts : [],
        }
      : { pond_el: null, tail_el: null, q_gates: null, q_sluices: null, q_intake: null, q_down: q_in, q_spill: null, freeboard_m: null, alerts: [] };
    if (!manual) {
      const g = sol && Array.isArray(sol.gates) ? sol.gates : gates;
      const s = sol && Array.isArray(sol.sluices) ? sol.sluices : sluices;
      if (Array.isArray(g)) res.gates = g.slice();
      if (Array.isArray(s)) res.sluices = s.slice();
      const io = sol && Number.isFinite(sol.intake_open) ? sol.intake_open : intake_open;
      if (Number.isFinite(io)) res.intake_open = io;
    }
    // the openings in use in every mode (manual ones clamped to full lift by the engine)
    res.gates_used = sol && Array.isArray(sol.gates) ? sol.gates.slice() : null;
    res.sluices_used = sol && Array.isArray(sol.sluices) ? sol.sluices.slice() : null;
    res.op_stage = sol && sol.stage ? sol.stage : null; // the auto rule's stage word (b14)
    // the flow through every bay (m3/s) and its regime, for the moving water in the 3D weir (map/structures/weir/flow.js)
    res.gate_q = sol && Array.isArray(sol.gate_q) ? sol.gate_q.slice() : null;
    res.sluice_q = sol && Array.isArray(sol.sluice_q) ? sol.sluice_q.slice() : null;
    if (res.pond_el != null) pondPrev = res.pond_el;
    store.patch('weir', res);

    // irrigation: one supply rule, the irrigation engine's own (irrigation.balance; A7.10, L15)
    const supplied = res.q_intake;
    const short = demand != null && supplied != null ? Math.max(0, demand - supplied) : null;
    if (demand != null && supplied != null && dtDays > 0) {
      const B = E.irrigation && E.irrigation.balance;
      let met = null;
      if (typeof B === 'function') {
        const b = guard('irrigation.balance', () => B({ q_river: [supplied], demand: [demand], intake_capacity_m3s: null, env_flow_m3s: 0 }));
        met = b && Number.isFinite(b.reliability) ? b.reliability : null;
      }
      if (met != null) {
        rel.all += dtDays;
        rel.ok += dtDays * met;
        yr.short_days += dtDays * (1 - met);
        yr.short_volume_m3 += met < 1 ? short * dtDays * DAY_S : 0;
      }
    }
    if (dtDays > 0) yr.days_run += dtDays;
    store.patch('irrigation', {
      demand_m3s: demand, supplied_m3s: supplied, shortfall_m3s: short, reliability: rel.all > 0 ? rel.ok / rel.all : null,
      short_days: yr.short_days, short_volume_m3: yr.short_volume_m3, days_run: yr.days_run,
    });

    sedStep(dtDays, q_in, res.q_intake, clock);

    const p = floodStep(res, I);
    if (p && ctx.sim && ctx.sim.clock && ctx.sim.clock.external()) await p; // films: the picture matches the step
  }

  // A7.3: two RISES over the normal river. Below the weir: tail level - flood.ref_tail_el; above it: pond level -
  // weir.pond_normal_el (both project EL, never below 0). flood.extent returns only ground beyond the normal river.
  function floodStep(res, I, force) {
    lastRes = res;
    const q = res.q_down;
    if (res.tail_el == null || !Number.isFinite(I.refTail)) return null;
    // A8.4: the bank reference can be shifted by the impact tab (flood.ref_shift_m, default 0)
    const shift = Number.isFinite(store.get('flood.ref_shift_m')) ? store.get('flood.ref_shift_m') : 0;
    const ref = I.refTail + shift;
    const stage = Math.max(0, res.tail_el - ref);
    const up = res.pond_el != null && Number.isFinite(I.refPond) ? Math.max(0, res.pond_el - I.refPond) : 0;
    store.patch('flood', { stage_m: stage, stage_up_m: up, q, ref_tail_el_used: ref, ref_q_m3s: refFlow(ref, I) });
    if (fl.busy) return fl.busy;
    if (force) fl.at = -Infinity;
    const dry = stage <= 0 && up <= 0;
    if (dry) {
      if (fl.dry) return null;
      fl.dry = true;
      fl.stage = 0;
      fl.up = 0;
      clearFlood(q);
      return null;
    }
    const t = ctx.sim && ctx.sim.clock ? ctx.sim.clock.t() : 0;
    const moved = force || fl.dry !== false || fl.stage == null || Math.abs(stage - fl.stage) >= FLOOD_STAGE_STEP_M || Math.abs(up - (fl.up ?? 0)) >= FLOOD_STAGE_STEP_M;
    if (!moved || (t - fl.at < FLOOD_MIN_GAP_S && fl.dry === false)) return null;
    fl.stage = stage;
    fl.up = up;
    fl.at = t;
    fl.busy = runFlood(stage, up, q, I).finally(() => (fl.busy = null));
    return fl.busy;
  }

  // The flow at which the tail reaches a level: bisection on the weir engine's rating (weir.tailwater).
  let refMemo = { el: null, q: null };
  function refFlow(el, I) {
    if (refMemo.el === el) return refMemo.q;
    const tw = E.weir && E.weir.tailwater;
    let q = null;
    if (typeof tw === 'function' && I.weirParams && Number.isFinite(el)) {
      const at = (x) => guard('weir.tailwater', () => tw(x, I.weirParams));
      let lo = 0;
      let hi = 1;
      while (at(hi) < el && hi < 1e6) hi *= 2;
      if (Number.isFinite(at(hi)) && at(hi) >= el && at(0) < el) {
        for (let i = 0; i < 50; i++) {
          const mid = (lo + hi) / 2;
          if (at(mid) < el) lo = mid;
          else hi = mid;
        }
        q = (lo + hi) / 2;
      } else if (at(0) >= el) q = 0;
    }
    refMemo = { el, q };
    return q;
  }

  // A shifted bank reference redraws the flood at once, even while the clock is paused.
  let lastShift = store.get('flood.ref_shift_m') ?? 0;
  store.on('flood.ref_shift_m', (v) => {
    const sh = Number.isFinite(v) ? v : 0;
    if (sh === lastShift) return;
    lastShift = sh;
    if (!lastRes) return;
    const go = () => {
      const p = floodStep(lastRes, inputs(), true);
      if (p && fl.busy === p) return;
    };
    if (fl.busy) fl.busy.then(go);
    else go();
  });

  // Nothing beyond the normal river: fields cleared, numbers 0 (not null).
  function clearFlood(q) {
    const version = ++fl.version;
    if (ctx.fields) {
      ctx.fields.set('flood.mask', null);
      ctx.fields.set('impact.points', null);
      ctx.fields.set('impact.lines', null);
    }
    store.patch('flood', { stage_m: 0, stage_up_m: 0, q, area_km2: 0, depth_max_m: 0, version });
    store.set('impact', { buildings: 0, footprint_m2: 0, roads_km: 0, rail_km: 0, lc_ha: {}, places: [], version: nextImpactVersion(), source: 'weir' });
  }

  function nextImpactVersion() {
    return ((store.get('impact') || {}).version || 0) + 1;
  }

  async function runFlood(stage, up, q, I) {
    const ext = await workerCall(ctx, 'flood.extent', { grid: 'fine', stage_m: stage, stage_up_m: up, floodParams: I.floodParams });
    if (!ext || !ext.mask) return;
    fl.dry = false;
    const version = ++fl.version;
    ctx.fields && ctx.fields.set('flood.mask', { grid: 'fine', mask: ext.mask, depth_dm: ext.depth_dm || null, version });
    store.patch('flood', { stage_m: stage, stage_up_m: up, q, area_km2: num(ext.area_km2) ?? 0, depth_max_m: num(ext.depth_max_m) ?? 0, version });
    await runImpact(ext.mask, ext.depth_dm || null, version, I);
  }

  async function runImpact(mask, depth, version, I) {
    const [c, l, pl] = await Promise.all([
      workerCall(ctx, 'impact.count', { grid: 'fine', mask: mask.slice(), depth_dm: depth ? depth.slice() : null, min_depth_m: I.floodParams.min_depth_m ?? null, max_points: 20000 }),
      workerCall(ctx, 'impact.lines', { grid: 'fine', mask: mask.slice() }),
      workerCall(ctx, 'impact.places', { grid: 'fine', mask: mask.slice(), buffer_cells: 2 }),
    ]);
    if (version !== fl.version) return; // a newer flood is already on its way
    if (ctx.fields) {
      ctx.fields.set('impact.points', c && c.points ? c.points : null);
      ctx.fields.set('impact.lines', l && l.geojson ? l.geojson : null);
    }
    store.set('impact', {
      buildings: c ? num(c.buildings) : null,
      footprint_m2: c ? num(c.footprint_m2) : null,
      roads_km: l ? num(l.roads_km) : null,
      rail_km: l ? num(l.rail_km) : null,
      lc_ha: c && c.lc_ha ? c.lc_ha : null,
      places: Array.isArray(pl) ? pl : [],
      version: nextImpactVersion(),
      source: 'weir',
    });
  }

  // Sub-daily steps around a design wave so its peak is seen (A7.10, L12): chunk lengths for a step of dt days.
  function chunks(day0, dt) {
    const pk = peakTime(series);
    if (pk == null || !(dt > SUBSTEP_DAYS)) return [dt];
    const w = series.wave;
    const sub = w && w.step_days > 0 ? Math.min(SUBSTEP_DAYS, w.step_days) : SUBSTEP_DAYS;
    // the wave's own window (b13: series.wave {start_day, step_days, q_m3s}); else a window round the peak
    const a = w && Number.isFinite(w.start_day) ? w.start_day : pk - DESIGN_WAVE_HALF_DAYS;
    const b = w && w.q_m3s ? w.start_day + (w.q_m3s.length - 1) * w.step_days : pk + DESIGN_WAVE_HALF_DAYS;
    if (day0 + dt <= a || day0 >= b) return [dt];
    const out = [];
    let d = day0;
    const end = day0 + dt;
    while (d < end - 1e-9) {
      let next = d >= a && d < b ? Math.min(end, d + sub) : Math.min(end, d < a ? a : end);
      if (d < pk && next > pk) next = pk; // always land on the peak itself
      out.push(next - d);
      d = next;
    }
    return out;
  }

  return { reset, step, chunks, inputs, reseries: makeSeries, series: () => series, loaded };
}
