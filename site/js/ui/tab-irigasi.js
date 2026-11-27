// Irrigation tab ("Irigasi"). Owner: lane b17. CONTRACT 4.4 (irrigation controls), 4.6 (charts), 4.8 (engine), 5.
// Writes ONLY the irrigation controls: `irrigation.area_ha` and `irrigation.pattern` (the engine's `pattern`:
// {start_hm, groups, efficiency, r5_mm[24], tiga_dihaji}). Results `irrigation.demand_m3s` etc. are s01's.
// Reads: params.json (irrigation, hydro), climate/rain.json (dry monthly rain), facts.json (status of the planned
// upstream reservoir), store irrigation, clock. Imports only the pure engine and the chart kit.
//
// Exports: init(ctx) adds the tab; mountIrigasi(el, ctx) mounts it into any element (dev page);
//          yearBalance(...) the half-month water balance the chart and tiles show (pure, tested by the dev page).

import { lineChart } from './charts.js';
import { demandTable, rainInputs, HALF_MONTHS } from '../engine/irrigation.js';

const HM_DAYS = 365.25 / HALF_MONTHS;
// FALLBACK until params.json carries it (asked b18): effective storage of the planned Tiga Dihaji reservoir.
const FALLBACK_TIGA_EFFECTIVE_MM3 = 64.68; // FALLBACK
// FALLBACK: group-1 land preparation from 1 November (the November peak of the sourced 1.1 l/s/ha; r02 MT I).
const FALLBACK_START_HM = 20; // FALLBACK
const EFF_RANGE = [0.45, 0.8, 0.01]; // engine spec E6 control range (KP-01 examples)

const leaf = (x) => (x && typeof x === 'object' && 'v' in x ? x.v : x);
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// Flat params group: {name: value} from params.flat ("irrigation.x") or the nested group's {v} leaves.
export function group(params, name) {
  const out = {};
  if (!params) return out;
  const flat = params.flat || {};
  for (const k of Object.keys(flat)) if (k.startsWith(name + '.')) out[k.slice(name.length + 1)] = leaf(flat[k]);
  const g = params[name];
  if (g && typeof g === 'object') for (const [k, v] of Object.entries(g)) if (!(k in out)) out[k] = leaf(v);
  return out;
}
const statusOf = (params, name, key) => params?.[name]?.[key]?.status || null;

// Half-month water balance through a year for the river's dependable flow (Q80 by month).
// avail = min(Q80 - maintenance flow, intake capacity); a planned reservoir may add `storage_m3` in the short
// half-months, spread over them in proportion to the gap. Returns arrays of 24 and the totals.
export function yearBalance({ dr_lsha, area_ha, q80_month, env_m3s, cap_m3s, storage_m3 = 0 }) {
  const n = HALF_MONTHS;
  const demand = new Array(n).fill(null);
  const river = new Array(n).fill(null);
  const avail = new Array(n).fill(null);
  const release = new Array(n).fill(0);
  const gap = new Array(n).fill(0);
  for (let h = 0; h < n; h++) {
    const q = q80_month ? q80_month[Math.floor(h / 2)] : null;
    river[h] = fin(q) ? q : null;
    if (fin(q)) avail[h] = Math.max(0, Math.min(fin(cap_m3s) ? cap_m3s : Infinity, q - (fin(env_m3s) ? env_m3s : 0)));
    const dr = dr_lsha ? dr_lsha[h] : null;
    demand[h] = fin(dr) && fin(area_ha) ? (dr * area_ha) / 1000 : null;
    if (fin(demand[h]) && fin(avail[h])) {
      const want = fin(cap_m3s) ? Math.min(demand[h], cap_m3s) : demand[h];
      gap[h] = Math.max(0, want - avail[h]);
    }
  }
  const needM3 = gap.reduce((s, g) => s + g * HM_DAYS * 86400, 0);
  const share = needM3 > 0 && storage_m3 > 0 ? Math.min(1, storage_m3 / needM3) : 0;
  for (let h = 0; h < n; h++) release[h] = gap[h] * share;
  const supplied = demand.map((d, h) => (fin(d) && fin(avail[h]) ? Math.min(d, avail[h] + release[h]) : null));
  const short = demand.map((d, h) => (fin(d) && fin(supplied[h]) ? d - supplied[h] > 1e-6 * Math.max(1, d) : false));
  // area the dependable flow (plus release) can serve in every half-month
  let areaMax = Infinity;
  for (let h = 0; h < n; h++) {
    const dr = dr_lsha ? dr_lsha[h] : null;
    if (fin(dr) && dr > 0 && fin(avail[h])) areaMax = Math.min(areaMax, ((avail[h] + release[h]) * 1000) / dr);
  }
  return {
    demand, river, avail, release, supplied, short,
    shortCount: short.filter(Boolean).length,
    peak: Math.max(0, ...demand.filter(fin)),
    peak_lsha: Math.max(0, ...(dr_lsha || []).filter(fin)),
    needM3, usedM3: share * needM3, share,
    areaMax: Number.isFinite(areaMax) ? areaMax : null,
  };
}

// Fill the irrigation controls the engine needs (pattern and area) once, whether or not the tab is ever opened,
// so the running simulation gets effective rain and the planting calendar from the start. Never overwrites.
export function fillDefaults(store, params, rain) {
  if (!store || !params) return;
  const cur = store.get('irrigation.pattern') || {};
  const i = group(params, 'irrigation');
  const fill = {};
  if (!fin(cur.start_hm)) fill.start_hm = fin(i.start_hm) ? i.start_hm : FALLBACK_START_HM;
  if (!fin(cur.groups) && fin(i.groups)) fill.groups = i.groups;
  if (!fin(cur.efficiency) && fin(i.efficiency)) fill.efficiency = i.efficiency;
  const ri = rainInputs(rain, group(params, 'rainflow').et0_monthly_mm);
  if (!Array.isArray(cur.r5_mm)) {
    // params' own R80 table (b18) wins; else computed from the daily rain
    const r = Array.isArray(i.r80_halfmonth_mm) && i.r80_halfmonth_mm.length === 24 ? null : ri.r5_mm;
    if (r) fill.r5_mm = r;
  }
  if (!Array.isArray(cur.eto_mm_day) && ri.eto_mm_day) fill.eto_mm_day = ri.eto_mm_day;
  if (Object.keys(fill).length) store.set('irrigation.pattern', { ...cur, ...fill });
  if (!fin(store.get('irrigation.area_ha')) && fin(i.area_default_ha)) store.set('irrigation.area_ha', i.area_default_ha);
}

export async function init(ctx) {
  if (ctx?.store && ctx.data)
    Promise.allSettled([ctx.data.json('params.json'), ctx.data.json('climate/rain.json')]).then(([p, r]) =>
      fillDefaults(ctx.store, p.status === 'fulfilled' ? p.value : null, r.status === 'fulfilled' ? r.value : null),
    );
  if (!ctx?.panel?.addTab) return;
  let view = null;
  ctx.panel.addTab({
    id: 'irigasi',
    order: 40,
    label: ['irigasi.tab', 'Irrigation'],
    modes: ['weir'],
    mount(el) {
      view = mountIrigasi(el, ctx);
    },
    onShow() {
      view?.refresh();
    },
  });
}

export function mountIrigasi(el, ctx) {
  const { store, t, fmt } = ctx;
  const S = { params: null, rain: null, facts: null, failed: false, chart: null, timer: 0, tiga: false, parts: null };
  const lang = () => store.get('lang') || 'id';
  el.classList.add('irigasi');
  el.replaceChildren(h('p', 'note', t('irigasi.loading', 'Loading the irrigation figures')));

  Promise.allSettled([ctx.data.json('params.json'), ctx.data.json('climate/rain.json'), ctx.data.json('facts.json')]).then(([p, r, f]) => {
    S.params = p.status === 'fulfilled' ? p.value : null;
    S.rain = r.status === 'fulfilled' ? r.value : null;
    S.facts = f.status === 'fulfilled' ? f.value : null;
    S.failed = !S.params;
    if (!S.failed) ensureControls();
    render();
    offs.push(store.on('lang', () => render()));
    offs.push(store.on('irrigation', () => schedule()));
    offs.push(store.on('clock', () => schedule()));
  });
  const offs = [];

  // ---- settings ----
  const I = () => group(S.params, 'irrigation');
  const H = () => group(S.params, 'hydro');
  const areaMaxOf = () => I().area_after_phase3_ha;
  // automatic mode holds the canal to the operating flow (CONTRACT A7.5), else the design capacity
  const capOf = () => [group(S.params, 'weir').intake_target_m3s, I().intake_target_m3s, I().intake_capacity_m3s].find(fin);
  function tigaStorageM3() {
    const i = I();
    const v = [i.tiga_dihaji_effective_mm3, group(S.params, 'tiga_dihaji').effective_storage_mm3].find(fin);
    return (fin(v) ? v : FALLBACK_TIGA_EFFECTIVE_MM3) * 1e6;
  }
  const pattern = () => store.get('irrigation.pattern') || {};
  const area = () => {
    const a = store.get('irrigation.area_ha');
    return fin(a) ? a : I().area_default_ha;
  };

  // Write the controls (the only keys this tab writes). Fills the defaults on first load.
  function setPattern(next) {
    const cur = pattern();
    store.set('irrigation.pattern', { ...cur, ...next });
  }
  function ensureControls() {
    fillDefaults(store, S.params, S.rain);
    S.tiga = !!pattern().tiga_dihaji;
  }

  function compute() {
    const i = I();
    const hy = H();
    const tab = demandTable(i, pattern());
    const env = [i.env_flow_m3s, hy.maintenance_flow_m3s].find(fin);
    const yb = yearBalance({
      dr_lsha: tab.ok ? tab.dr_lsha : null,
      area_ha: area(),
      q80_month: hy.monthly_q80_m3s,
      env_m3s: env,
      cap_m3s: capOf(),
      storage_m3: S.tiga ? tigaStorageM3() : 0,
    });
    return { tab, yb, env, cap: capOf() };
  }

  const hmName = (hh) => {
    const m = Math.floor(hh / 2);
    const mon = new Intl.DateTimeFormat(lang() === 'id' ? 'id-ID' : 'en-GB', { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2001, m, 1)));
    const last = new Date(Date.UTC(2001, m + 1, 0)).getUTCDate();
    return (hh % 2 ? '16–' + last : '1–15') + ' ' + mon;
  };
  const hmShort = (hh) => {
    const m = Math.floor(hh / 2);
    return new Intl.DateTimeFormat(lang() === 'id' ? 'id-ID' : 'en-GB', { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2001, m, 1))) + (hh % 2 ? ' II' : ' I');
  };
  const nowHm = () => {
    const d = store.get('clock.date');
    if (typeof d !== 'string' || d.length < 10) return null;
    const m = Number(d.slice(5, 7));
    const day = Number(d.slice(8, 10));
    return fin(m) ? (m - 1) * 2 + (day > 15 ? 1 : 0) + 0.5 : null;
  };

  // ---- markup ----
  function h(tag, cls, text, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    return n;
  }
  function slider(label, min, max, step, value, show, onInput) {
    const wrap = h('label', 'slider');
    const val = h('span', 'slider__value', show(value));
    const inp = h('input', null, null, { type: 'range', min, max, step });
    inp.value = value;
    const fill = () => inp.style.setProperty('--fill', (((Number(inp.value) - min) / (max - min)) * 100).toFixed(1) + '%');
    fill();
    inp.addEventListener('input', () => {
      val.textContent = show(Number(inp.value));
      fill();
      onInput(Number(inp.value));
    });
    wrap.append(h('span', 'slider__label', label), val, inp);
    return { wrap, inp, val };
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
  function tile(label, st) {
    const d = h('div', 'tile');
    const v = h('div');
    const val = h('span', 'value', '–');
    const unit = h('span', 'unit');
    v.append(val, unit);
    d.append(h('div', 'label', label, { title: label }), v);
    if (st) d.append(h('sup', 'status-letter', null, { 'data-s': st }));
    const small = h('small');
    d.append(small);
    return { el: d, val, unit, small };
  }

  function render() {
    S.chart?.destroy?.();
    S.chart = null;
    el.replaceChildren();
    if (S.failed) {
      el.append(h('p', 'note', t('irigasi.failed', 'The irrigation figures could not be loaded. The rest of the simulator keeps working.')));
      return;
    }
    const i = I();
    const root = h('div', 'stack irigasi-body');
    root.append(h('p', 'muted', t('irigasi.intro', 'How much water the rice fields of the Komering scheme ask from the intake, half-month by half-month, against the river in a dry year (the flow reached 8 years in 10).')));

    // area served
    const amax = areaMaxOf();
    const aMaxSlider = fin(amax) ? amax : Math.max(area() || 0, 1);
    const sa = slider(t('irigasi.area', 'Area served'), 0, Math.ceil(aMaxSlider / 100) * 100, 100, Math.round(area() || 0), (v) => fmt.ha(v), (v) => {
      store.set('irrigation.area_ha', v);
      schedule();
    });
    root.append(sa.wrap);
    const presets = [];
    if (fin(i.area_default_ha)) presets.push({ value: i.area_default_ha, text: t('irigasi.area_legal_s', '{ha} · legal', { ha: fmt.ha(i.area_default_ha) }) });
    if (fin(amax)) presets.push({ value: amax, text: t('irigasi.area_phase3_s', '{ha} · Phase 3', { ha: fmt.ha(amax) }) });
    if (presets.length)
      root.append(chipRow(presets, area(), (v) => {
        store.set('irrigation.area_ha', v);
        render();
      }, t('irigasi.area', 'Area served')));

    // planting start
    const fs = h('label', 'field');
    fs.append(h('span', 'label', t('irigasi.start', 'Land preparation starts (first group)')));
    const sel = h('select');
    for (let hh = 0; hh < HALF_MONTHS; hh++) {
      const o = h('option', null, hmName(hh), { value: String(hh) });
      if (pattern().start_hm === hh) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener('change', () => {
      setPattern({ start_hm: Number(sel.value) });
      schedule();
    });
    fs.append(sel);
    root.append(fs);

    // rotation groups
    const fg = h('div', 'field');
    fg.append(h('span', 'label', t('irigasi.groups', 'Rotation groups, 15 days apart')));
    fg.append(chipRow([1, 2, 3, 4, 5].map((g) => ({ value: g, text: String(g) })), pattern().groups, (g) => {
      setPattern({ groups: g });
      render();
    }, t('irigasi.groups', 'Rotation groups, 15 days apart')));
    root.append(fg);

    // efficiency
    const se = slider(t('irigasi.eff', 'Overall efficiency, field to intake'), EFF_RANGE[0], EFF_RANGE[1], EFF_RANGE[2], pattern().efficiency ?? i.efficiency, (v) => fmt.pct(v), (v) => {
      setPattern({ efficiency: Math.round(v * 100) / 100 });
      schedule();
    });
    root.append(se.wrap);

    // planned reservoir switch
    const sw = h('label', 'check');
    const cb = h('input', null, null, { type: 'checkbox' });
    cb.checked = S.tiga;
    cb.addEventListener('change', () => {
      S.tiga = cb.checked;
      setPattern({ tiga_dihaji: cb.checked });
      schedule();
    });
    sw.append(cb, h('span', null, t('irigasi.tiga', 'Add a dry-season release from the planned Tiga Dihaji reservoir')), h('span', 'badge badge--warn', t('irigasi.plan', 'plan')));
    root.append(sw);
    const tigaNote = h('p', 'note');
    root.append(tigaNote);

    // chart
    root.append(h('hr', 'sep sep--tight'));
    root.append(h('div', 'label', t('irigasi.chart', 'Canal demand against the dry-year river, m³/s')));
    const chartBox = h('div', 'irigasi-chart');
    root.append(chartBox);
    const legend = h('ul', 'legend');
    const li = (cls, c, text) => {
      const l = h('li', 'legend__item');
      const sw2 = h('span', 'swatch ' + cls);
      sw2.style.setProperty('--c', c);
      l.append(sw2, h('span', null, text));
      return l;
    };
    legend.append(
      li('swatch--line', 'var(--chart-1)', t('irigasi.l_demand', 'Demand at the intake')),
      li('swatch--line', 'var(--chart-2)', t('irigasi.l_river', 'River, dry year (Q80)')),
      li('swatch--dash', 'var(--chart-3)', t('irigasi.l_avail', 'What the intake can take')),
    );
    if (S.tiga) legend.append(li('swatch--dash', 'var(--chart-4)', t('irigasi.l_release', 'With the reservoir release (plan)')));
    legend.append(li('', 'var(--warn-weak, #fdf0d0)', t('irigasi.l_short', 'Short of water')));
    root.append(legend);

    // tiles
    const tiles = h('div', 'tiles');
    const T = {
      peak: tile(t('irigasi.peak', 'Peak demand'), 'C'),
      short: tile(t('irigasi.short', 'Half-months short'), 'C'),
      env: tile(t('irigasi.env_s', 'Maintenance flow'), statusOf(S.params, 'irrigation', 'env_flow_m3s') || 'S'),
      served: tile(t('irigasi.served_s', 'Dry-year area'), 'C'),
    };
    for (const x of Object.values(T)) tiles.append(x.el);
    root.append(tiles);

    // live readouts from the running simulation (s01)
    const kv = h('dl', 'kv');
    const live = {};
    for (const [k, label] of [
      ['demand_m3s', t('irigasi.now_demand', 'Demand now')],
      ['supplied_m3s', t('irigasi.now_supplied', 'Delivered to the canal')],
      ['shortfall_m3s', t('irigasi.now_short', 'Shortfall')],
      ['reliability', t('irigasi.now_rel', 'Time fully supplied since the start')],
      ['short_days', t('irigasi.year_short_days', 'Days short this scenario year')],
      ['short_volume_m3', t('irigasi.year_short_vol', 'Water missing this scenario year')],
    ]) {
      live[k] = h('dd', null, '–');
      kv.append(h('dt', null, label), live[k]);
    }
    root.append(h('div', 'label', t('irigasi.live', 'In the running simulation')), kv);

    const crops = t('irigasi.crops3', 'Two rice crops and a dry-season upland crop a year.');
    root.append(h('p', 'note note--model', t('irigasi.honest2', 'Design rule (KP-01), not measured offtakes: what the rules ask for, not what the canals carry.') + ' ' + crops + ' ' + t('irigasi.rain_note2', 'Effective rain is 70% of the half-month rain reached 8 years in 10; crop water use from the monthly reference evaporation.')));
    el.append(root);
    S.parts = { chartBox, T, live, tigaNote };
    update();
  }

  function update() {
    const P = S.parts;
    if (!P || S.failed) return;
    const { yb, env, cap } = compute();
    const x = Array.from({ length: HALF_MONTHS }, (_, k) => k + 0.5);
    const bands = [];
    yb.short.forEach((s, k) => s && bands.push({ from: k, to: k + 1, color: 'var(--warn-weak, #fdf0d0)' }));
    const series = [
      { name: t('irigasi.l_demand', 'Demand at the intake'), y: yb.demand, color: 'var(--chart-1)', fill: true },
      { name: t('irigasi.l_river', 'River, dry year (Q80)'), y: yb.river, color: 'var(--chart-2)' },
      { name: t('irigasi.l_avail', 'What the intake can take'), y: yb.avail, color: 'var(--chart-3)', dashed: true },
    ];
    if (S.tiga) series.push({ name: t('irigasi.l_release', 'With the reservoir release (plan)'), y: yb.avail.map((a, k) => (fin(a) ? a + yb.release[k] : null)), color: 'var(--chart-4)', dashed: true });
    const now = nowHm();
    const opts = {
      x,
      series,
      height: 190,
      yMin: 0,
      bands,
      xTicks: [0, 4, 8, 12, 16, 20].map((k) => k + 0.5),
      xFormat: (v) => hmShort(Math.floor(v)).replace(/ I+$/, ''),
      yFormat: (v) => fmt.num(v, 0),
      tipFormat: (v) => hmName(Math.floor(v)),
      now: fin(now) ? { x: now, label: t('irigasi.now', 'now') } : null,
    };
    if (S.chart) S.chart.update(opts);
    else if (P.chartBox.isConnected || P.chartBox.parentNode) S.chart = lineChart(P.chartBox, opts);

    const T = P.T;
    T.peak.val.textContent = fmt.q(yb.peak);
    T.peak.small.textContent = t('irigasi.peak_lsha', '{v} l/s per ha at the intake', { v: fmt.num(yb.peak_lsha, 2) });
    T.short.val.textContent = fmt.num(yb.shortCount, 0);
    T.short.unit.textContent = t('irigasi.of24', 'of 24');
    const shortList = yb.short.map((s, k) => (s ? hmShort(k) : null)).filter(Boolean);
    const missM3 = Math.max(0, yb.needM3 - yb.usedM3);
    T.short.small.textContent = shortList.length
      ? shortList.join(', ') + ' · ' + t('irigasi.plan_short', 'about {d} days, {v} million m³ missing in a dry year', { d: fmt.num(yb.shortCount * HM_DAYS, 0), v: fmt.num(missM3 / 1e6, 1) })
      : t('irigasi.none_short', 'Enough water all year');
    T.short.el.dataset.state = yb.shortCount ? 'warn' : '';
    T.env.val.textContent = fmt.q(env);
    T.env.small.textContent = t('irigasi.env_note2', 'kept in the river below the weir; the canal is held to {q}', { q: fmt.q(cap) });
    T.served.val.textContent = fmt.ha(yb.areaMax);
    T.served.small.textContent = t('irigasi.served_note2', 'the dry-year river can serve every half-month, at this planting and efficiency');
    T.served.el.dataset.state = fin(yb.areaMax) && yb.areaMax < area() - 1 ? 'warn' : '';

    if (S.tiga) {
      const tf = S.facts?.facts?.tiga_dihaji_status;
      const st = tf?.label ? (lang() === 'id' ? tf.v?.id : tf.v?.en) : null;
      P.tigaNote.textContent = t('irigasi.tiga_note', 'Planned, not operating{status}. {used} of its {store} million m³ of effective storage would be released over the short half-months; it covers {pct} of the gap.', {
        status: st ? ' (' + st + ')' : '',
        used: fmt.num(yb.usedM3 / 1e6, 1),
        store: fmt.num(tigaStorageM3() / 1e6, 2),
        pct: yb.needM3 > 0 ? fmt.pct(yb.share) : '–',
      });
      P.tigaNote.hidden = false;
    } else P.tigaNote.hidden = true;

    const irr = store.get('irrigation') || {};
    P.live.demand_m3s.textContent = fmt.q(irr.demand_m3s);
    P.live.supplied_m3s.textContent = fmt.q(irr.supplied_m3s);
    P.live.shortfall_m3s.textContent = fmt.q(irr.shortfall_m3s);
    P.live.reliability.textContent = fmt.pct(irr.reliability);
    // running totals of the scenario year (s01, CONTRACT A8.5); "–" until they exist
    const ran = fin(irr.days_run) ? ' ' + t('irigasi.of_days', 'of {n}', { n: fmt.num(irr.days_run, 0) }) : '';
    P.live.short_days.textContent = fin(irr.short_days) ? fmt.num(irr.short_days, 0) + ran : '–';
    P.live.short_volume_m3.textContent = fin(irr.short_volume_m3) ? t('irigasi.mm3', '{v} million m³', { v: fmt.num(irr.short_volume_m3 / 1e6, 1) }) : '–';
  }

  function schedule() {
    if (S.timer) return;
    S.timer = setTimeout(() => {
      S.timer = 0;
      update();
    }, 150);
  }

  return {
    refresh: () => update(),
    destroy: () => offs.forEach((f) => f && f()),
    get state() {
      return S;
    },
  };
}
