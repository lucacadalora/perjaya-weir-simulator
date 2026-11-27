// Rain tab ("Hujan"). Owner: lane b19. CONTRACT 4.4 (scenario, rain controls), 4.6 (charts), 5 (classes).
// Writes ONLY `scenario` and the rain controls (`rain.annual_mm`, `rain.monthly_mm`, `rain.runoff_share`).
// Reads: clock, flow, history, maker, rain, field `scenario.series` (s01). Never computes river flow (s01, b13 do).
// Data: climate/rain.json (monthly means, daily basin rain, annual totals, Gumbel rain), facts.json, params.json.
//
// Exports: init(ctx) adds the tab to ctx.panel; mountHujan(el, ctx) mounts the tab into any element (dev page).

import { lineChart, barChart } from './charts.js';

// FALLBACK (until params.json carries them; CONTRACT 4.9): slider ranges and defaults from the engine spec
// (P2 E1 controls: yearly rain scale 50-150 % step 5 %, runoff share 0.20-0.80 step 0.05, base 0.50).
const FALLBACK = {
  scale_min: 0.5, // FALLBACK
  scale_max: 1.5, // FALLBACK
  share_min: 0.2, // FALLBACK
  share_max: 0.8, // FALLBACK
  share_step: 0.05, // FALLBACK
  share: 0.5, // FALLBACK
};
const DAY = 86400000;

const leaf = (x) => (x && typeof x === 'object' && 'v' in x ? x.v : x);
function dig(obj, path) {
  let o = obj;
  for (const k of path.split('.')) {
    if (o == null) return undefined;
    o = o[k];
  }
  return o;
}
// First value found under any of the paths, in params.flat, params, or facts.facts. Returns {v, status} or null.
function lookup(src, paths) {
  if (!src) return null;
  for (const p of paths) {
    for (const cand of [dig(src, p), src.facts?.[p], dig(src.facts, p), src.flat?.[p], dig(src.flat, p)]) {
      const v = leaf(cand);
      if (Array.isArray(v) && v.length) return { v, status: cand?.status || null };
      if (v !== null && v !== '' && typeof v !== 'object' && Number.isFinite(Number(v))) return { v: Number(v), status: cand?.status || null };
    }
  }
  return null;
}

// Rain of each month of one real year from the daily basin mean (mm). Null when the year is not in the record.
export function monthlyOfYear(rain, year) {
  const d = rain?.daily_basin_mean;
  if (!d?.values) return null;
  const t0 = Date.parse(d.start + 'T00:00:00Z');
  const scale = d.scale ?? 1;
  const out = new Array(12).fill(0);
  let seen = 0;
  for (let m = 0; m < 12; m++) {
    const a = Math.round((Date.UTC(year, m, 1) - t0) / DAY);
    const b = Math.round((Date.UTC(year, m + 1, 1) - t0) / DAY);
    for (let i = Math.max(0, a); i < Math.min(b, d.values.length); i++) {
      out[m] += d.values[i] * scale;
      seen++;
    }
  }
  return seen > 300 ? out.map((v) => Math.round(v * 10) / 10) : null;
}

// The value exceeded p of the time (Weibull plotting position), from a list of flows.
export function exceeded(values, p) {
  const a = Array.from(values || []).filter(Number.isFinite).sort((x, y) => y - x);
  if (!a.length) return null;
  const rank = Math.min(a.length, Math.max(1, Math.round(p * (a.length + 1))));
  return a[rank - 1];
}

// Base months (before the yearly-rain slider) for a scenario.
export function baseMonths(rain, sc, params) {
  const pm = lookup(params, ['rainflow.rain_monthly_mm'])?.v;
  const mean = (Array.isArray(pm) && pm.length === 12 ? pm : null) || rain?.monthly_mean_1991_2020 || rain?.monthly_mean_2015_2024 || null;
  if (sc?.kind === 'replay' && sc.year != null) return monthlyOfYear(rain, Number(sc.year)) || mean;
  return mean;
}
const sum = (a) => (a || []).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);

export async function init(ctx) {
  if (!ctx?.panel?.addTab) return;
  let view = null;
  ctx.panel.addTab({
    id: 'hujan',
    order: 20,
    label: ['hujan.tab', 'Rain'],
    modes: ['weir', 'maker'],
    mount(el) {
      view = mountHujan(el, ctx);
    },
    onShow() {
      view?.refresh();
    },
  });
}

export function mountHujan(el, ctx) {
  const { store, t, fmt } = ctx;
  const S = { rain: null, facts: null, params: null, failed: false, applied: '', charts: {}, timer: 0 };
  const lang = () => store.get('lang') || 'id';
  const loc = () => (lang() === 'id' ? 'id-ID' : 'en-GB');
  el.classList.add('hujan');

  el.innerHTML = '';
  const wait = document.createElement('div');
  wait.className = 'note hujan-wait';
  wait.innerHTML = '<span></span><span class="loading-bar"><i></i></span>';
  wait.firstChild.textContent = t('hujan.loading', 'Loading the rain record');
  el.append(wait);

  Promise.allSettled([ctx.data.json('climate/rain.json'), ctx.data.json('facts.json'), ctx.data.json('params.json')]).then(([r, f, p]) => {
    S.rain = r.status === 'fulfilled' ? r.value : null;
    S.facts = f.status === 'fulfilled' ? f.value : null;
    S.params = p.status === 'fulfilled' ? p.value : null;
    S.failed = !S.rain;
    if (S.rain) ensureControls();
    render();
    wire();
  });

  // ---- settings from params.json with fallbacks -------------------------------------------------------------
  function cfg() {
    const P = S.params;
    const g = (paths, fb) => lookup(P, paths)?.v ?? fb;
    const sr = lookup(P, ['rainflow.rain_scale_range'])?.v;
    const cr = lookup(P, ['rainflow.runoff_coeff_range'])?.v;
    const ok = (r) => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite);
    return {
      scale_min: ok(sr) ? sr[0] : FALLBACK.scale_min,
      scale_max: ok(sr) ? sr[1] : FALLBACK.scale_max,
      share_min: ok(cr) ? cr[0] : FALLBACK.share_min,
      share_max: ok(cr) ? cr[1] : FALLBACK.share_max,
      share_step: FALLBACK.share_step,
      share: g(['rainflow.runoff_share', 'rainflow.runoff_coeff', 'rainflow.C', 'rainflow.c'], FALLBACK.share),
    };
  }
  // Return periods of the published floods (params hydro.flood_T); else those of the rain record's Gumbel fit.
  const designTs = () => {
    const pT = lookup(S.params, ['hydro.flood_T'])?.v;
    if (Array.isArray(pT) && pT.length) return pT.filter(Number.isFinite);
    return Object.keys(S.rain?.gumbel?.max3day || {}).map((k) => Number(k.replace(/\D/g, ''))).filter(Number.isFinite).sort((a, b) => a - b);
  };
  // The weir's own design flood (no return period): facts.json first, then params.json; never typed.
  const weirDesignQ = () => lookup(S.facts, ['design_flood']) || lookup(S.params, ['hydro.design_flood_m3s', 'weir.design_flood_m3s']);
  // Published monthly mean flow (gauged 1963-1980 at Martapura), Jan..Dec.
  const gaugedMonthly = () => {
    const g = lookup(S.facts, ['monthly_flow']) || lookup(S.params, ['hydro.monthly_mean_m3s']);
    return Array.isArray(g?.v) && g.v.length === 12 ? g : null;
  };
  // The four driest years of the rain record (marked in the year picker).
  const dryYears = () => new Set(Object.entries(S.rain?.annual || {}).sort((a, b) => a[1] - b[1]).slice(0, 4).map(([y]) => Number(y)));
  const years = () => Object.keys(S.rain?.annual || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);

  function labelFor(sc) {
    if (sc.kind === 'replay') return t('hujan.label_replay', 'Rain of {year}', { year: sc.year });
    if (sc.kind === 'design' && sc.design_T == null) return t('hujan.label_design_weir_q', 'Weir design flood {q}', { q: fmt.q(weirDesignQ()?.v) });
    if (sc.kind === 'design') return t('hujan.label_design', '{T}-year design flood', { T: sc.design_T });
    return t('hujan.label_mean', 'Mean year');
  }

  // Write the scenario and the rain controls (the only keys this tab writes).
  function apply(next) {
    const cur = store.get('scenario') || {};
    const sc = { ...cur, ...next };
    if (sc.kind === 'replay' && sc.year == null) sc.year = years().at(-1) ?? null;
    if (!Number.isFinite(sc.rain_scale)) sc.rain_scale = 1;
    sc.label = labelFor(sc);
    const base = baseMonths(S.rain, sc, S.params);
    const months = base ? base.map((v) => Math.round(v * sc.rain_scale * 10) / 10) : null;
    const rainCur = store.get('rain') || {};
    const share = Number.isFinite(next.runoff_share) ? next.runoff_share : Number.isFinite(rainCur.runoff_share) ? rainCur.runoff_share : null; // null = the model's own share
    S.applied = key(sc);
    store.patch('scenario', { kind: sc.kind, year: sc.year ?? null, rain_scale: sc.rain_scale, label: sc.label, design_T: sc.design_T ?? null });
    store.patch('rain', { annual_mm: months ? Math.round(sum(months)) : null, monthly_mm: months, runoff_share: share });
  }
  const key = (sc) => [sc.kind, sc.year, sc.design_T, sc.rain_scale].join('|');
  const shape = (sc) => [sc.kind, sc.year, sc.design_T].join('|');

  // On first load (or when another module set a scenario without rain months), fill the rain controls.
  function ensureControls() {
    const sc = store.get('scenario') || {};
    const r = store.get('rain') || {};
    if (!Array.isArray(r.monthly_mm) || key(sc) !== S.applied) apply({ kind: sc.kind || 'climatology' });
  }

  function wire() {
    store.on('lang', () => {
      if (S.rain) apply({}); // the scenario label follows the language
      render();
    });
    store.on('scenario', (sc) => {
      if (!S.rain || !sc) return;
      if (key(sc) !== S.applied) return apply({}); // set by another module (e.g. a "try this" button)
      if (shape(sc) !== S.shape) render(); // the controls differ; a slider move only updates
      else schedule();
    });
    store.on('rain', () => schedule());
    store.on('history', () => schedule());
    store.on('clock', () => schedule());
    store.on('flow', () => schedule());
    store.on('maker', () => schedule());
    store.on('mode', () => schedule());
    store.listen('sim:reset', () => schedule());
    ctx.fields?.on?.('scenario.series', () => schedule());
  }
  // Charts and tiles redraw at most every 150 ms however fast the clock runs.
  function schedule() {
    if (S.timer) return;
    S.timer = setTimeout(() => {
      S.timer = 0;
      update();
    }, 150);
  }

  // Exposed so the dev page and the panel can refresh after a hidden mount.
  return {
    refresh: () => update(),
    charts: S.charts,
    get state() {
      return S;
    },
  };

  // ---- markup -------------------------------------------------------------------------------------------------
  function h(tag, cls, text, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    return n;
  }
  function chipRow(items, current, onPick, aria) {
    const row = h('div', 'chips', null, { role: 'group', 'aria-label': aria });
    for (const it of items) {
      const b = h('button', null, it.text, { type: 'button', 'aria-pressed': String(it.value === current) });
      b.addEventListener('click', () => onPick(it.value));
      row.append(b);
    }
    return row;
  }
  function slider(label, min, max, step, value, onInput) {
    const wrap = h('label', 'slider');
    const lab = h('span', 'slider__label', label);
    const val = h('span', 'slider__value');
    const inp = h('input', null, null, { type: 'range', min, max, step });
    inp.value = value;
    inp.addEventListener('input', () => onInput(Number(inp.value)));
    wrap.append(lab, val, inp);
    return { wrap, inp, val };
  }
  function tile(label) {
    const d = h('div', 'tile');
    const l = h('div', 'label', label);
    const v = h('div');
    const val = h('span', 'value', '–');
    const unit = h('span', 'unit');
    const sl = h('sup', 'status-letter');
    sl.hidden = true;
    v.append(val, sl, unit);
    d.append(l, v);
    return { el: d, val, unit, sl };
  }

  function render() {
    for (const c of Object.values(S.charts)) c?.destroy?.();
    S.charts = {};
    el.replaceChildren();
    if (S.failed) {
      el.append(h('p', 'note', t('hujan.failed', 'The rain record could not be loaded. The rest of the simulator keeps working.')));
      return;
    }
    const sc = store.get('scenario') || {};
    S.shape = shape(sc);
    const c = cfg();
    const root = h('div', 'hujan-body');

    // scenario chips
    const f1 = h('div', 'field');
    f1.append(h('span', 'label', t('hujan.scenario', 'Rain to apply')));
    f1.append(
      chipRow(
        [
          { value: 'climatology', text: t('hujan.kind_mean', 'Mean year') },
          { value: 'replay', text: t('hujan.kind_replay', 'A real year') },
          { value: 'design', text: t('hujan.kind_design', 'Design flood') },
        ],
        sc.kind || 'climatology',
        (kind) => apply({ kind, rain_scale: 1 }),
        t('hujan.scenario', 'Rain to apply'),
      ),
    );
    root.append(f1);

    if (sc.kind === 'replay') {
      const f = h('label', 'field');
      f.append(h('span', 'label', t('hujan.year', 'Year')));
      const sel = h('select', 'hujan-select');
      const dry = dryYears();
      for (const y of years()) {
        const o = h('option', null, dry.has(y) ? t('hujan.year_dry', '{year} · dry year', { year: y }) : String(y), { value: String(y) });
        if (Number(sc.year) === y) o.selected = true;
        sel.append(o);
      }
      sel.addEventListener('change', () => apply({ year: Number(sel.value), rain_scale: 1 }));
      f.append(sel);
      root.append(f);
    }
    if (sc.kind === 'design') {
      const f = h('div', 'field');
      f.append(h('span', 'label', t('hujan.return_period_yr', 'Return period, years')));
      const Ts = designTs();
      const chips = chipRow(Ts.map((T) => ({ value: T, text: fmt.num(T, 0) })), sc.design_T ?? null, (T) => apply({ design_T: T }), t('hujan.return_period_yr', 'Return period, years'));
      chips.classList.add('hujan-tchips');
      chips.style.display = 'flex'; // layout only: the short chips share the row
      for (const b of chips.children) b.style.flex = '1 1 auto';
      f.append(chips);
      // the weir's own design flood has no return period: its own chip, the same scenario as the overview button
      const wq = weirDesignQ();
      if (wq) {
        const wchip = chipRow([{ value: 'weir', text: t('hujan.T_weir_q', 'Weir design flood {q}', { q: fmt.q(wq.v) }) }], sc.design_T == null ? 'weir' : '', () => apply({ design_T: null }), t('hujan.T_weir_q', 'Weir design flood {q}', { q: fmt.q(wq.v) }));
        wchip.style.cssText = 'display:flex;margin-top:6px'; // layout only
        wchip.firstChild.style.flex = '1 1 auto';
        f.append(wchip);
      }
      // the peak flow of that flood (params hydro.flood_q_m3s by return period, or the weir's design flood)
      const qs = lookup(S.params, ['hydro.flood_q_m3s']);
      const qd = weirDesignQ();
      const i = Ts.indexOf(sc.design_T);
      const peak = sc.design_T == null ? qd : Array.isArray(qs?.v) && i >= 0 && Number.isFinite(qs.v[i]) ? { v: qs.v[i], status: qs.status } : null;
      const g = S.rain?.gumbel?.max3day?.['R' + sc.design_T];
      const kv = h('dl', 'kv');
      const row = (k, v, st) => {
        const dd = h('dd', null, v);
        if (st) dd.append(h('sup', 'status-letter', st, { 'data-s': st }));
        kv.append(h('dt', null, k), dd);
      };
      if (peak) row(t('hujan.peak', 'Peak flow at the weir'), fmt.q(peak.v), peak.status);
      if (Number.isFinite(g)) row(t('hujan.design_rain', '3-day basin rain, this return period'), fmt.num(g, 0) + ' mm', 'C');
      if (kv.children.length) f.append(kv);
      root.append(f);
    }

    // sliders
    const baseAnnual = sum(baseMonths(S.rain, sc, S.params));
    const s1 = slider(t('hujan.annual', 'Yearly rain'), Math.round(baseAnnual * c.scale_min), Math.round(baseAnnual * c.scale_max), 10, Math.round(baseAnnual * (sc.rain_scale || 1)), (v) => apply({ rain_scale: baseAnnual ? v / baseAnnual : 1 }));
    const s2 = slider(t('hujan.share', 'Share of rain that reaches the river'), c.share_min, c.share_max, c.share_step, store.get('rain.runoff_share') ?? ctx.fields?.get?.('scenario.series')?.share_model ?? c.share, (v) => store.patch('rain', { runoff_share: v }));
    S.sliders = { s1, s2, baseAnnual };
    root.append(s1.wrap, s2.wrap);

    // monthly bars
    const card1 = h('div', 'card hujan-card');
    card1.append(h('div', 'card__title', t('hujan.monthly', 'Rain by month')));
    const bars = h('div', 'hujan-chart');
    card1.append(bars);
    root.append(card1);

    // flow line
    const card2 = h('div', 'card hujan-card');
    card2.append(h('div', 'card__title', t('hujan.flow', 'River flow at the weir')));
    const line = h('div', 'hujan-chart');
    const legend = h('div', 'legend');
    const li = (cls, text, color, dashed) => {
      const it = h('span', 'legend__item ' + cls);
      const sw = h('span', 'swatch');
      sw.style.cssText = `display:inline-block;width:14px;height:0;border-top:2px ${dashed ? 'dashed' : 'solid'} ${color};margin-right:5px;vertical-align:middle`;
      it.append(sw, document.createTextNode(text));
      return it;
    };
    legend.append(li('', t('hujan.so_far', 'So far'), 'var(--chart-1)'), li('', t('hujan.ahead', 'Scenario year ahead'), 'var(--chart-3)', true));
    const gm = gaugedMonthly();
    if (gm) {
      const it = li('', t('hujan.gauged', 'gauged 1963–1980, Martapura'), 'var(--ink-3)', true);
      if (gm.status) it.append(h('sup', 'status-letter', gm.status, { 'data-s': gm.status }));
      legend.append(it);
    }
    S.empty = h('p', 'note hujan-empty', t('hujan.flow_empty', 'The flow line appears once the simulation runs.'));
    card2.append(line, S.empty, legend);
    if (sc.kind === 'replay') card2.append(h('p', 'note hujan-replay-note', t('hujan.replay_note', 'A real year shows the flow of the seasons, not flood peaks: daily rain averaged over the whole basin understates storms. For floods, use the design-flood chips.')));
    root.append(card2);

    // tiles
    const tl = h('div', 'tiles hujan-tiles');
    S.tiles = {
      area: tile(t('hujan.t_area', 'Catchment')),
      now: tile(t('hujan.t_now', 'Flow now')),
      mean: tile(t('hujan.t_mean', 'Mean flow')),
      q80: tile(t('hujan.t_q80_short', 'Q80 flow')),
    };
    S.tiles.q80.el.title = t('hujan.t_q80_tip', 'Q80: the flow exceeded 80% of the time');
    for (const x of Object.values(S.tiles)) tl.append(x.el);
    root.append(tl);

    root.append(h('p', 'note', t('hujan.note', 'Rain is a reanalysis (ERA5), averaged over the basin, not a gauge reading. River flow is modelled from it.')));
    el.append(root);

    const months = Array.from({ length: 12 }, (_, m) => new Date(Date.UTC(2001, m, 15)));
    S.charts.bars = barChart(bars, {
      labels: months.map((d) => d.toLocaleDateString(loc(), { month: 'short', timeZone: 'UTC' }).replace('.', '').slice(0, 3)),
      tipLabels: months.map((d) => d.toLocaleDateString(loc(), { month: 'long', timeZone: 'UTC' })),
      values: [],
      height: 120,
      yLabel: 'mm',
      yFormat: (v) => fmt.num(v, 0),
    });
    S.charts.line = lineChart(line, { x: [], series: [], height: 150 });
    update();
  }

  // ---- live values ----------------------------------------------------------------------------------------------
  function nowDays() {
    const c = store.get('clock') || {};
    const start = Date.parse((c.start_date || c.date || '2000-01-01') + 'T00:00:00Z') / DAY;
    if (Number.isFinite(c.day)) return start + c.day;
    const d = Date.parse((c.date || '') + 'T00:00:00Z');
    return Number.isFinite(d) ? d / DAY : null;
  }
  function setTile(x, value, unit, status) {
    if (!x) return;
    x.val.textContent = value;
    x.unit.textContent = unit || '';
    x.sl.hidden = !status;
    if (status) {
      x.sl.textContent = status;
      x.sl.dataset.s = status;
    }
  }
  function update() {
    if (!S.charts.bars || !S.charts.line) return;
    const sc = store.get('scenario') || {};
    const rain = store.get('rain') || {};
    const clock = store.get('clock') || {};
    const month = Number(String(clock.date || '').slice(5, 7)) - 1;

    if (S.sliders) {
      const { s1, s2, baseAnnual } = S.sliders;
      const ann = Number.isFinite(rain.annual_mm) ? rain.annual_mm : baseAnnual * (sc.rain_scale || 1);
      if (document.activeElement !== s1.inp) s1.inp.value = Math.round(ann);
      s1.val.textContent = fmt.num(ann, 0) + ' mm · ' + fmt.pct(sc.rain_scale ?? 1).replace(/[.,]0\s?%/, '%');
      const own = ctx.fields?.get?.('scenario.series')?.share_model;
      const sh = Number.isFinite(rain.runoff_share) ? rain.runoff_share : Number.isFinite(own) ? own : null;
      if (document.activeElement !== s2.inp && Number.isFinite(sh)) s2.inp.value = sh;
      s2.val.textContent = sh == null ? t('hujan.share_model', 'model') : fmt.pct(sh).replace(/[.,]0\s?%/, '%') + (Number.isFinite(rain.runoff_share) ? '' : ' · ' + t('hujan.share_model', 'model'));
    }
    S.charts.bars.update({ values: rain.monthly_mm || [], highlight: month >= 0 && month < 12 ? month : null });

    // flow so far (history) and the scenario year ahead (field scenario.series)
    const hist = store.get('history') || {};
    const start = Date.parse((clock.start_date || '2000-01-01') + 'T00:00:00Z') / DAY;
    const now = nowDays();
    const hx = [];
    const hy = [];
    const hd = hist.day || [];
    const hq = hist.q_in || [];
    for (let i = 0; i < hd.length; i++) {
      const x = start + hd[i];
      if (Number.isFinite(x) && (now == null || x >= now - 400)) {
        hx.push(x);
        hy.push(hq[i] ?? NaN);
      }
    }
    const ser = ctx.fields?.get?.('scenario.series');
    const ax = [];
    const ay = [];
    if (ser?.q_m3s?.length) {
      let s0 = Date.parse(String(ser.start).slice(0, 10) + 'T00:00:00Z') / DAY;
      const n = ser.q_m3s.length;
      const step = n > 24 ? 1 : 365.25 / n;
      // the scenario year repeats: once the clock has passed it, lay it on the year now running
      for (let k = 0; k < 200 && now != null && Number.isFinite(s0) && s0 + n * step <= now; k++) {
        const d = new Date(s0 * DAY);
        s0 = Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate()) / DAY;
      }
      const half = n > 24 ? 0 : step / 2;
      for (let i = 0; i < n; i++) {
        const x = s0 + i * step + half;
        if (now == null || x >= now - (step > 1 ? step : 0)) {
          ax.push(x);
          ay.push(ser.q_m3s[i]);
        }
      }
    }
    // join: the ahead line starts at the last point so far, so the two lines meet
    if (hx.length && ax.length && ax[0] > hx[hx.length - 1]) {
      ax.unshift(hx[hx.length - 1]);
      ay.unshift(hy[hy.length - 1]);
    }
    const x = [...hx, ...ax];
    const so = [...hy, ...ax.map(() => NaN)];
    const ah = [...hx.map(() => NaN), ...ay];
    if (hx.length && ax.length && ax[0] === hx[hx.length - 1]) ah[hx.length - 1] = hy[hy.length - 1];
    const span = x.length ? x[x.length - 1] - x[0] : 0;
    const every = span > 540 ? 6 : span > 270 ? 3 : span > 120 ? 2 : 1;
    const xTicks = [];
    if (x.length) {
      const d0 = new Date(x[0] * DAY);
      for (let m = 0; m < 40; m++) {
        const d = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1 + m, 1) / DAY;
        if (d > x[x.length - 1]) break;
        const mm = new Date(d * DAY).getUTCMonth();
        if (mm % every === 0) xTicks.push(d);
      }
    }
    if (S.empty) S.empty.hidden = x.length > 0;
    // the published monthly mean flow as a step line under the modelled one (weir mode only)
    const gmv = store.get('mode') === 'maker' ? null : gaugedMonthly()?.v;
    const gauged = gmv && x.length ? x.map((v) => gmv[new Date(Math.round(v) * DAY).getUTCMonth()]) : null;
    const dateOf = (v) => new Date(Math.round(v) * DAY).toISOString().slice(0, 10);
    S.charts.line.update({
      x,
      series: [
        { name: t('hujan.so_far', 'So far'), y: so, color: 'var(--chart-1)', fill: true },
        { name: t('hujan.ahead', 'Scenario year ahead'), y: ah, color: 'var(--chart-3)', dashed: true },
        ...(gauged ? [{ name: t('hujan.gauged', 'gauged 1963–1980, Martapura'), y: gauged, color: 'var(--ink-3)', dashed: true }] : []),
      ],
      yLabel: 'm³/s',
      yFormat: (v) => fmt.num(v, v !== 0 && Math.abs(v) < 10 ? 1 : 0),
      xFormat: (v) => new Date(v * DAY).toLocaleDateString(loc(), { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace('.', ''),
      tipFormat: (v) => fmt.date(dateOf(v)),
      xTicks,
      now: now != null && x.length ? { x: now, label: t('hujan.now', 'now') } : null,
    });

    // tiles: weir, or the active dam in maker mode
    const maker = store.get('mode') === 'maker';
    const dam = maker ? (store.get('maker.dams') || []).find((d) => d.id === store.get('maker.active')) : null;
    const area = maker ? (dam && Number.isFinite(dam.catchment_km2) ? { v: dam.catchment_km2, status: 'C' } : null) : lookup(S.facts, ['catchment_km2', 'catchment.area_km2', 'weir.catchment_km2', 'catchment_area_km2']) || lookup(S.params, ['catchment.area_km2', 'catchment.weir_km2']);
    const qnow = maker ? dam?.inflow_m3s : store.get('flow.q_in');
    const fq = (v) => {
      const s = fmt.q(v);
      return [s.replace(/\s*m³\/s$/, ''), s === '–' ? '' : 'm³/s'];
    };
    const fa = area ? fmt.area(area.v) : '–';
    setTile(S.tiles.area, fa.replace(/\s*km²$/, ''), fa === '–' ? '' : 'km²', area?.status);
    setTile(S.tiles.now, ...fq(qnow), Number.isFinite(qnow) ? 'C' : null);
    const qs = ser?.q_m3s?.length > 24 ? ser.q_m3s : null;
    // weir: the researched long-term values (params.hydro); Q80 of the current month. Else: the scenario year.
    const fMean = maker ? null : lookup(S.params, ['hydro.mean_flow_m3s']) || lookup(S.facts, ['flow.mean_m3s', 'mean_flow_m3s']);
    const mq = maker ? null : lookup(S.params, ['hydro.monthly_q80_m3s'])?.v;
    const fQ80 = Array.isArray(mq) && mq.length === 12 && month >= 0 && Number.isFinite(mq[month]) ? { v: mq[month], status: lookup(S.params, ['hydro.monthly_q80_m3s']).status, month: true } : null;
    const mean = fMean || (Number.isFinite(ser?.q_mean) ? { v: ser.q_mean, status: 'C', year: true } : qs ? { v: sum(qs) / qs.length, status: 'C', year: true } : null);
    const q80 = fQ80 || (Number.isFinite(ser?.q80) ? { v: ser.q80, status: 'C', year: true } : qs ? { v: exceeded(qs, 0.8), status: 'C', year: true } : null);
    const yr = t('hujan.this_year', 'this year');
    const monthName = month >= 0 ? new Date(Date.UTC(2001, month, 15)).toLocaleDateString(loc(), { month: 'short', timeZone: 'UTC' }).replace('.', '') : '';
    const [mv, mu] = fq(mean?.v);
    setTile(S.tiles.mean, mv, mu + (mean?.year && mu ? ' · ' + yr : ''), mean?.status);
    const [qv, qu] = fq(q80?.v);
    setTile(S.tiles.q80, qv, qu + (q80?.year && qu ? ' · ' + yr : q80?.month && qu ? ' · ' + monthName : ''), q80?.status);
  }
}
