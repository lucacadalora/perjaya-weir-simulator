// Maker-mode runner. Owner: lane s01. CONTRACT 4.4 (`maker`), 4.5, 4.8 and the addendum fields
// (`dam.line:<id>`, `reservoir.curve:<id>`, `catchment.mask:<id>`, `reservoir.mask:<id>`).
//
// On `maker:place` {lon, lat, ...preset}: snap to a stream, catchment, dam line, storage curve, fields.
// Each step: inflow from the catchment's rain, reservoir.routeStep, level, fill, spill; the lake mask through the
// worker when the level moved by 0.5 m; the impact count for the active dam. Everything is guarded.
// Maker dam elevations are model metres (CONTRACT 4.4).

import { paramGroup, lightEngine, guard, warnOnce, workerCall, loadJson, seriesAt, fallbackSeries, engineSeries, validSeries, flowOf } from './weir-run.js';

const DAY_S = 86400;
export const LAKE_STEP_M = 0.5; // re-draw the lake when the level moved this much (brief s01)
const num = (v) => (Number.isFinite(v) ? v : null);

// Status word from the routing result.
export function damStatus(volume, fslVolume, spill) {
  if (!Number.isFinite(volume) || !Number.isFinite(fslVolume) || fslVolume <= 0) return 'computing';
  if (spill > 1e-6) return 'spilling';
  const f = volume / fslVolume;
  if (f >= 0.995) return 'full';
  if (volume <= 1) return 'empty';
  return 'filling';
}

// createMakerRun(ctx) -> { reset(), step(dtDays, clock), place(payload), remove(id) }
export async function createMakerRun(ctx) {
  const store = ctx.store;
  const D = { params: null, rain: null, flow: null };
  const E = {};
  const S = new Map(); // id -> { curve, line, idx, volume, lakeAt, ctl, busy, version, catchment_km2 }
  let series = null;
  let seq = 0;

  const loaded = (async () => {
    const [params, rain, flow] = await Promise.all([loadJson(ctx, 'params.json'), loadJson(ctx, 'climate/rain.json'), loadJson(ctx, 'climate/flow_glofas.json')]);
    Object.assign(D, { params, rain, flow });
    for (const n of ['reservoir', 'rainflow']) E[n] = await lightEngine(n);
    E.scenarios = await import('./scenarios.js').catch(() => null);
  })().catch((e) => warnOnce('maker-run data', e));

  const P = (g) => paramGroup(D.params, g);
  const dams = () => (store.get('maker') || {}).dams || [];
  function patchDam(id, obj) {
    const m = store.get('maker') || {};
    const list = (m.dams || []).map((d) => (d && d.id === id ? { ...d, ...obj } : d));
    store.set('maker', { ...m, dams: list });
  }

  async function makeSeries() {
    const sc = store.get('scenario') || {};
    let s = null;
    const f = E.scenarios && E.scenarios.seriesFor;
    const rn = store.get('rain') || {};
    if (typeof f === 'function') s = await guard('scenarios.seriesFor', () => f(sc, { rain: D.rain, flow: D.flow }, D.params, { monthly_mm: rn.monthly_mm ?? null, runoff_share: rn.runoff_share ?? null }));
    if (!validSeries(s)) s = await engineSeries(sc, D, E.rainflow, store, E.scenarios);
    if (!validSeries(s)) s = fallbackSeries(sc, D.rain, D.flow);
    series = s;
  }

  // ---------- placing a dam ----------
  async function place(payload) {
    await loaded;
    if (!payload || !Number.isFinite(payload.lon) || !Number.isFinite(payload.lat)) return;
    const mk = P('maker');
    const id = payload.id || 'dam' + Date.now().toString(36) + (seq++).toString(36);
    // the tab (b21) may already have written the entry with its controls: they win over the event and the defaults
    const prev = dams().find((d) => d.id === id) || {};
    const pick = (k) => num(prev[k]) ?? num(payload[k]);
    const dam = {
      id, name: prev.name || payload.name || null, lon: payload.lon, lat: payload.lat, grid: 'wide', idx: null,
      type: prev.type || payload.type || mk.default_type || 'embankment', // FALLBACK type word when params has none
      crest_el: pick('crest_el'), base_el: null, height_m: pick('height_m') ?? num(mk.height_default_m) ?? 60, // FALLBACK height until params.maker has one
      crest_len_m: null, release_m3s: pick('release_m3s') ?? num(mk.release_default_m3s) ?? 0,
      spill_width_m: pick('spill_width_m') ?? num(mk.spill_width_default_m),
      start: prev.start === 'full' || payload.start === 'full' ? 'full' : 'empty', // 'full' only for an existing lake
      catchment_km2: null, fsl_area_km2: null, fsl_volume_m3: null, inflow_m3s: null, level_el: null, volume_m3: 0,
      fill: 0, spill_m3s: 0, status: 'computing', line: null,
    };
    const m = store.get('maker') || {};
    store.set('maker', { ...m, active: id, placing: false, dams: [...(m.dams || []).filter((d) => d.id !== id), dam] });
    // a new dam starts empty (or full for an existing lake) on the day it is placed, whatever was built before
    S.set(id, { volume: 0, lakeAt: null, version: 0, fresh: true });
    await build(id);
  }

  // Snap, catchment, dam line and storage curve (again when the crest or the place changes).
  async function build(id) {
    const st = S.get(id);
    let d = dams().find((x) => x.id === id);
    if (!st || !d) return;
    st.building = true;
    patchDam(id, { status: 'computing' });
    try {
      const mk = P('maker');
      if (st.idx == null || st.lon !== d.lon || st.lat !== d.lat) {
        const snap = await workerCall(ctx, 'grid.snapToStream', { grid: 'wide', lon: d.lon, lat: d.lat, min_km2: mk.min_catchment_km2 ?? 10, radius_cells: mk.snap_radius_cells ?? 8 }); // FALLBACK search sizes
        if (!snap || !snap.ok || !Number.isFinite(snap.idx)) return patchDam(id, { status: 'computing', error: 'no_stream' });
        st.idx = snap.idx;
        st.lon = d.lon;
        st.lat = d.lat;
        const cm = await workerCall(ctx, 'grid.catchment', { grid: 'wide', idx: snap.idx });
        if (cm && cm.mask) {
          const outline = await workerCall(ctx, 'grid.maskOutline', { grid: 'wide', mask: cm.mask.slice(), simplify: 1 });
          ctx.fields && ctx.fields.set('catchment.mask:' + id, { grid: 'wide', mask: cm.mask, area_km2: num(cm.area_km2), outline: outline || null });
          st.catchment_km2 = num(cm.area_km2);
        }
        st.base = null;
        const tr = await workerCall(ctx, 'grid.traceDownstream', { grid: 'wide', idx: snap.idx, max_steps: 1 });
        if (tr && tr.el_m && tr.el_m.length) st.base = tr.el_m[0];
        patchDam(id, { idx: snap.idx, catchment_km2: st.catchment_km2 });
      }
      d = dams().find((x) => x.id === id);
      if (!d) return;
      let crest = d.crest_el;
      const prev = st.ctl || {};
      if ((!Number.isFinite(crest) || (d.height_m !== prev.height_m && d.crest_el === prev.crest_el)) && Number.isFinite(d.height_m) && Number.isFinite(st.base)) crest = st.base + d.height_m;
      if (!Number.isFinite(crest)) return patchDam(id, { status: 'computing', error: 'no_crest' });
      const line = await workerCall(ctx, 'reservoir.damLine', { grid: 'wide', idx: st.idx, crest_el: crest });
      if (!line || !line.ok) return patchDam(id, { crest_el: crest, status: 'computing', error: (line && line.reason) || 'no_line', line: null });
      ctx.fields && ctx.fields.set('dam.line:' + id, line);
      const curve = await workerCall(ctx, 'reservoir.storageCurve', { grid: 'wide', idx: st.idx, crest_el: crest, line, steps: mk.curve_steps ?? 60 }); // FALLBACK step count
      st.curve = curve && curve.level_el && curve.level_el.length ? curve : null;
      st.line = line;
      st.crest = crest;
      if (st.curve) ctx.fields && ctx.fields.set('reservoir.curve:' + id, st.curve);
      const n = st.curve ? st.curve.level_el.length - 1 : -1;
      const base = num(line.base_el) ?? st.base;
      const latest = dams().find((x) => x.id === id) || d;
      const fsl = n >= 0 ? st.curve.volume_m3[n] : 0;
      if (st.fresh) st.volume = latest.start === 'full' ? fsl : 0;
      st.volume = Math.min(st.volume || 0, fsl);
      st.lakeAt = null;
      const R = E.reservoir;
      const lvl = st.volume > 0 && R && typeof R.levelAt === 'function' ? num(guard('reservoir.levelAt', () => R.levelAt(st.curve, st.volume))) : num(base);
      st.ctl = { crest_el: crest, height_m: latest.height_m, lon: latest.lon, lat: latest.lat };
      patchDam(id, {
        crest_el: crest, base_el: base, height_m: Number.isFinite(base) ? crest - base : latest.height_m,
        crest_len_m: num(line.length_m), line: line.a && line.b ? { a: line.a, b: line.b } : null, error: null,
        fsl_area_km2: n >= 0 ? num(st.curve.area_km2[n]) : null, fsl_volume_m3: n >= 0 ? num(st.curve.volume_m3[n]) : null,
        status: damStatus(st.volume, n >= 0 ? st.curve.volume_m3[n] : null, 0),
        volume_m3: st.volume, fill: fsl > 0 ? st.volume / fsl : null, level_el: lvl, spill_m3s: 0,
      });
      if (st.curve) st.fresh = false;
      st.ctl = { crest_el: crest, height_m: Number.isFinite(base) ? crest - base : latest.height_m, lon: latest.lon, lat: latest.lat };
    } finally {
      st.building = false;
    }
  }

  // ---------- stepping ----------
  // The scenario's flow for this dam's own catchment (b13 seriesFor with area_km2), made once per dam and scenario.
  function damSeries(st, area) {
    const f = E.scenarios && E.scenarios.seriesFor;
    if (typeof f !== 'function') return null;
    if (st.series && st.seriesArea === area && st.seriesOf === series) return st.series;
    const rn = store.get('rain') || {};
    const s = guard('scenarios.seriesFor dam', () =>
      f(store.get('scenario') || {}, { rain: D.rain, flow: D.flow }, D.params, { monthly_mm: rn.monthly_mm ?? null, runoff_share: rn.runoff_share ?? null, area_km2: area }),
    );
    st.series = validSeries(s) ? s : null;
    st.seriesArea = area;
    st.seriesOf = series;
    return st.series;
  }

  function inflowFor(d, st, day) {
    if (!series) return null;
    const area = st.catchment_km2 ?? d.catchment_km2;
    if (!Number.isFinite(area)) return null;
    const own = damSeries(st, area);
    if (own) return flowOf(own, day);
    const RF = E.rainflow;
    const rain = store.get('rain') || {};
    const share = Number.isFinite(rain.runoff_share) ? rain.runoff_share : P('rainflow').runoff_coeff ?? null;
    const r = series.rain_mm ? seriesAt(series.rain_mm, day) : null;
    if (RF && typeof RF.runoffCoeff === 'function' && Number.isFinite(r) && Number.isFinite(share)) {
      const q = guard('rainflow.runoffCoeff', () => RF.runoffCoeff({ rain_mm: r, area_km2: area, share, seconds: DAY_S }));
      if (Number.isFinite(q)) return q;
    }
    // FALLBACK: the scenario's flow at the weir scaled by catchment area
    const weirArea = P('catchment').area_km2;
    const q0 = seriesAt(series.q_m3s, day);
    return Number.isFinite(weirArea) && weirArea > 0 && Number.isFinite(q0) ? (q0 * area) / weirArea : null;
  }

  async function stepDam(d, dtDays, day) {
    const st = S.get(d.id);
    if (!st || st.building) return;
    const ctlNow = { crest_el: d.crest_el, height_m: d.height_m, lon: d.lon, lat: d.lat };
    const c = st.ctl;
    if (c && (ctlNow.crest_el !== c.crest_el || ctlNow.height_m !== c.height_m || ctlNow.lon !== c.lon || ctlNow.lat !== c.lat)) {
      build(d.id); // the user moved the crest or the dam: new line and curve (not awaited: the clock keeps going)
      return;
    }
    if (!st.curve) return;
    const R = E.reservoir;
    const inflow = inflowFor(d, st, day);
    let out = { volume_m3: st.volume, level_el: null, spill_m3s: 0, release_m3s: 0 };
    if (R && typeof R.routeStep === 'function' && Number.isFinite(inflow)) {
      const evap = P('evap');
      let left = dtDays;
      while (left > 1e-9) {
        const h = Math.min(1, left); // at most one simulated day per routing step
        left -= h;
        const r = guard('reservoir.routeStep', () =>
          R.routeStep(
            { curve: st.curve, volume_m3: st.volume, crest_el: st.crest, spill_width_m: d.spill_width_m, spill_cd: P('maker').spill_cd ?? null, release_m3s: d.release_m3s ?? 0, evap_mm_day: evap.open_water_mm_day ?? 0, pan_coef: 1 },
            inflow,
            h * DAY_S,
          ),
        );
        if (!r) break;
        out = r;
        st.volume = Number.isFinite(r.volume_m3) ? r.volume_m3 : st.volume;
      }
    }
    let level = num(out.level_el);
    if (level == null && R && typeof R.levelAt === 'function') level = num(guard('reservoir.levelAt', () => R.levelAt(st.curve, st.volume)));
    const n = st.curve.volume_m3.length - 1;
    const fsl = st.curve.volume_m3[n];
    patchDam(d.id, {
      inflow_m3s: num(inflow), level_el: level, volume_m3: num(st.volume), fill: fsl > 0 ? Math.max(0, Math.min(1, st.volume / fsl)) : null,
      spill_m3s: num(out.spill_m3s), status: damStatus(st.volume, fsl, out.spill_m3s || 0),
    });
    if (level != null && (st.lakeAt == null || Math.abs(level - st.lakeAt) >= LAKE_STEP_M) && !st.busy) {
      st.lakeAt = level;
      st.busy = lake(d.id, level).finally(() => (st.busy = null));
      return st.busy;
    }
  }

  async function lake(id, level) {
    const st = S.get(id);
    if (!st) return;
    const r = await workerCall(ctx, 'reservoir.fillReservoir', { grid: 'wide', idx: st.idx, level_el: level, line: st.line });
    if (!r || !r.mask || !S.has(id)) return;
    const version = ++st.version;
    ctx.fields && ctx.fields.set('reservoir.mask:' + id, { grid: 'wide', mask: r.mask, level_el: level, bbox: r.bbox || null, version });
    if ((store.get('maker') || {}).active !== id) return;
    const [c, l, pl] = await Promise.all([
      workerCall(ctx, 'impact.count', { grid: 'wide', mask: r.mask.slice(), max_points: 20000 }),
      workerCall(ctx, 'impact.lines', { grid: 'wide', mask: r.mask.slice() }),
      workerCall(ctx, 'impact.places', { grid: 'wide', mask: r.mask.slice(), buffer_cells: 1 }),
    ]);
    if (version !== st.version) return;
    if (c && c.points) ctx.fields.set('impact.points', c.points);
    if (l && l.geojson) ctx.fields.set('impact.lines', l.geojson);
    const iv = ((store.get('impact') || {}).version || 0) + 1;
    store.set('impact', {
      buildings: c ? num(c.buildings) : null, footprint_m2: c ? num(c.footprint_m2) : null, roads_km: l ? num(l.roads_km) : null,
      rail_km: l ? num(l.rail_km) : null, lc_ha: c && c.lc_ha ? c.lc_ha : null, places: Array.isArray(pl) ? pl : [], version: iv, source: id,
    });
  }

  async function step(dtDays, clock) {
    await loaded;
    if (!series) await makeSeries();
    const day = (clock && clock.day) || 0;
    const waits = [];
    for (const d of dams()) {
      if (!S.has(d.id)) {
        // a dam written by someone else (a preset list, a share link): build it
        S.set(d.id, { volume: 0, lakeAt: null, version: 0, fresh: true });
        build(d.id);
        continue;
      }
      const p = await stepDam(d, dtDays, day);
      if (p) waits.push(p);
    }
    if (waits.length && ctx.sim && ctx.sim.clock && ctx.sim.clock.external()) await Promise.all(waits);
  }

  async function reset() {
    await loaded;
    await makeSeries();
    for (const [id, st] of S) {
      st.volume = 0;
      st.lakeAt = null;
      if (st.curve) patchDam(id, { volume_m3: 0, fill: 0, level_el: null, spill_m3s: 0, status: damStatus(0, 1, 0) });
    }
  }

  function remove(id) {
    if (!id) return;
    S.delete(id);
    const m = store.get('maker') || {};
    store.set('maker', { ...m, active: m.active === id ? null : m.active, dams: (m.dams || []).filter((d) => d.id !== id) });
    if (ctx.fields) for (const f of ['dam.line:', 'reservoir.curve:', 'reservoir.mask:', 'catchment.mask:']) ctx.fields.set(f + id, null);
  }

  // L14: every maker level (crest_el, base_el, level_el, curve) is in model terrain metres, not project EL
  if ((store.get('maker') || {}).level_datum !== 'model') store.patch('maker', { level_datum: 'model' });
  store.listen('maker:place', (p) => place(p));
  store.listen('maker:remove', (p) => remove(p && p.id));

  return { reset, step, place, remove, reseries: makeSeries, state: (id) => S.get(id), loaded };
}
