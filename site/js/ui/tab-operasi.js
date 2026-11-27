// Operation tab: mode, gates, sluices, intake and demand, with the live section drawing. Owner: lane b20.
// Writes the `weir` CONTROLS only (mode, gates[7], sluices[3], intake_open, demand_m3s). Reads the results that s01
// writes (pond_el, tail_el, q_gates, q_sluices, q_intake, q_spill, q_down, freeboard_m, alerts) and flow.q_in.
// No hydraulics here (b14 and s01 compute them).
// Lane s (24 Nov 2026): the 'Kantong lumpur' block after the intake (mountSediment, end of file). It sits here because
// the settling basins are part of the intake works and flushing them is an operator's act, like the gates; it reads
// the store key `sediment` (sim/weir-run.js), writes only `sediment.auto` and emits `sediment:flush`.

import { mountWeirSection, readWeir } from './weir-section.js';

const MODES = [
  ['auto', 'operasi.mode.auto', 'Automatic'],
  ['manual', 'operasi.mode.manual', 'Manual'],
  ['flush', 'operasi.mode.flush', 'Flushing'],
  ['flood', 'operasi.mode.flood', 'Flood'],
  ['closed', 'operasi.mode.closed', 'Closed'],
];
const MODE_NOTE = {
  auto: ['operasi.mode_note.auto', 'The model holds the pond at the intake level and opens the gates one by one in the operating order.'],
  manual: ['operasi.mode_note.manual', 'You set every gate and sluice. The pond rises or falls with what you choose.'],
  flush: ['operasi.mode_note.flush', 'The scouring sluices open to wash sediment away from in front of the intake.'],
  flood: ['operasi.mode_note.flood', 'All gates are open to pass the flood.'],
  closed: ['operasi.mode_note.closed', 'All gates are shut. Water leaves only through the intake and over the gates.'],
};
const ALERTS = {
  overtop: ['danger', 'operasi.alert.overtop_deck', 'The pond is above the weir deck.'],
  pond_high: ['danger', 'operasi.alert.pond_high', 'The pond is above the design flood level.'],
  gates_full: ['warn', 'operasi.alert.gates_full', 'All gates are fully open: the weir cannot pass more water.'],
  intake_short: ['warn', 'operasi.alert.intake_short', 'The canal gets less water than it asks for.'],
  river_dry_below: ['warn', 'operasi.alert.below_maintenance', 'The river below the weir gets less than its maintenance flow of {m}.'],
  intake_over_design: ['warn', 'operasi.alert.intake_over_design', 'The canal takes more than its design capacity of {cap}.'],
};
const SPLIT = [
  ['q_intake', 'operasi.split.canal', 'Canal', 'var(--ok)'],
  ['q_gates', 'operasi.split.gates', 'Flood gates', 'var(--water)'],
  ['q_sluices', 'operasi.split.sluices', 'Sluices', 'var(--water-deep)'],
  ['q_spill', 'operasi.split.spill', 'Over the gates', 'var(--warn)'],
];

export async function init(ctx) {
  if (!ctx.panel || typeof ctx.panel.addTab !== 'function') return;
  let api = null;
  ctx.panel.addTab({
    id: 'operasi',
    order: 30,
    label: ['operasi.tab', 'Operation'],
    modes: ['weir'],
    mount(el) {
      api = mountOperasi(el, ctx);
    },
    onShow() {
      if (api) api.redraw();
    },
  });
}

const h = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const V = (x) => (x && typeof x === 'object' && 'v' in x ? x.v : x);

export function mountOperasi(el, ctx) {
  const { store, t, fmt } = ctx;
  const offs = [];
  let desc = readWeir(null, null);
  // FALLBACK until params.json is read: operating flow 81, design 91.68, maximum 101, maintenance flow 35 m3/s (CONTRACT A7)
  const intake = { target: 81, cap: 91.68, max: 101, maint: 35 }; // FALLBACK
  const root = h('div', 'operasi');
  root.innerHTML = `<style>
.operasi{display:flex;flex-direction:column;gap:12px}
.operasi>*{margin:0}
.operasi-sheet{border-radius:var(--radius);overflow:hidden}
.operasi-bar{display:flex;height:14px;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;background:var(--paper)}
.operasi-bar>i{display:block;height:100%}
.operasi-rows{display:flex;flex-direction:column;gap:0}
.operasi-rows>.slider{grid-template-areas:"label input value";grid-template-columns:var(--operasi-lw,34px) 1fr var(--operasi-vw,52px);align-items:center;gap:0 8px;margin:0}
.operasi-rows input:disabled{opacity:.55}
.operasi-alerts{display:flex;flex-direction:column;gap:6px}
.operasi-alerts:empty{display:none}
.operasi>.operasi-sheetrow{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;margin-top:-4px}
.operasi-sheetrow .note{margin:0}
.operasi-sheetrow .btn{flex:none}
.operasi-intake-note{margin:4px 0 0}
.operasi-gatectl{border:1px solid var(--accent);border-radius:var(--radius);padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.operasi-gatectl[hidden]{display:none}
.operasi-gatectl__row{display:flex;align-items:center;gap:8px;justify-content:space-between}
.operasi-gatectl__row input[type=range]{flex:1}
.operasi-gatectl__row .btn{min-width:36px}
.operasi-gatectl__val{font:600 16px var(--font);font-variant-numeric:tabular-nums}
.operasi-gatectl .note{margin:0}
.operasi .chips.operasi-modes{display:flex;width:100%}
.operasi .chips.operasi-modes>button{flex:1 1 auto;padding-left:6px;padding-right:6px}
.operasi .legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:6px;font-size:12px}
.operasi .legend .swatch{display:inline-block;width:10px;height:10px;margin-right:4px;vertical-align:-1px;border-radius:1px}
.operasi-pct{color:var(--ink-3);font:11px var(--mono)}
</style>`;
  el.appendChild(root);

  // 1. mode chips and what the mode does
  const modeBox = h('div', 'field');
  modeBox.appendChild(h('div', 'label', esc(t('operasi.mode_label', 'Operating mode'))));
  const chips = h('div', 'chips chips--block operasi-modes');
  chips.setAttribute('role', 'group');
  for (const [m, k, en] of MODES) {
    const b = h('button', null, esc(t(k, en)));
    b.type = 'button';
    b.dataset.mode = m;
    b.addEventListener('click', () => store.set('weir.mode', m));
    chips.appendChild(b);
  }
  modeBox.appendChild(chips);
  const modeNote = h('p', 'note');
  modeNote.style.margin = '6px 0 0';
  modeBox.appendChild(modeNote);
  root.appendChild(modeBox);

  // compact gate control for manual mode, right under the mode chips (the drawing is the selector)
  const ctl = h('div', 'operasi-gatectl');
  ctl.tabIndex = 0;
  ctl.hidden = true;
  ctl.innerHTML = `<div class="operasi-gatectl__row"><span class="label" data-role="gname"></span><b class="operasi-gatectl__val" data-role="gval"></b></div>
<div class="operasi-gatectl__row"><button type="button" class="btn" data-role="minus" aria-label="−">−</button><input type="range" min="0" step="0.05" data-role="grange"><button type="button" class="btn" data-role="plus" aria-label="+">+</button></div>
<div class="operasi-gatectl__row"><button type="button" class="btn btn--quiet" data-role="openall"></button><button type="button" class="btn btn--quiet" data-role="closeall"></button></div>
<p class="note" data-role="ghelp"></p>`;
  root.appendChild(ctl);

  // 2. alerts as plain sentences
  const alerts = h('div', 'operasi-alerts');
  alerts.setAttribute('role', 'status');
  root.appendChild(alerts);

  // 3. tiles: pond, tail, freeboard, inflow
  const tiles = h('div', 'tiles');
  const tile = (key, en) => {
    const d = h('div', 'tile');
    d.innerHTML = `<div class="label">${esc(t(key, en))}</div><div><span class="value"></span><span class="unit"></span></div>`;
    tiles.appendChild(d);
    return { v: d.querySelector('.value'), u: d.querySelector('.unit') };
  };
  const tPond = tile('operasi.tile.pond', 'Pond level');
  const tTail = tile('operasi.tile.tail', 'Tail water level');
  const tFree = tile('operasi.tile.freeboard', 'Freeboard to design flood');
  const tIn = tile('operasi.tile.q_in', 'Modelled inflow');
  root.appendChild(tiles);
  const modelNote = h('p', 'note', esc(t('app.model_note', 'Indicative model, not a survey')));
  modelNote.style.margin = '-6px 0 0';
  root.appendChild(modelNote);

  // 4. the drawing
  const sheetBox = h('div', 'operasi-sheetbox');
  root.appendChild(sheetBox);
  const sheet = mountWeirSection(sheetBox, ctx, { bay: 0, onSelect: (i) => gate.select(i) });
  const sheetRow = h('div', 'operasi-sheetrow');
  const sheetHint = h('p', 'note', esc(t('operasi.sheet_hint', 'Tap a bay in the elevation to cut the section through it.')));
  const enlarge = h('button', 'btn', esc(t('operasi.enlarge', 'Enlarge')));
  enlarge.type = 'button';
  enlarge.dataset.role = 'enlarge';
  enlarge.addEventListener('click', () => openSheet(ctx, sheet.bay));
  sheetRow.append(sheetHint, enlarge);
  root.appendChild(sheetRow);

  // 5. flow split
  const splitBox = h('div', 'field');
  splitBox.appendChild(h('div', 'label', esc(t('operasi.split_label', 'Where the river goes'))));
  const bar = h('div', 'operasi-bar');
  bar.setAttribute('role', 'img');
  const legend = h('div', 'legend');
  splitBox.append(bar, legend);
  root.appendChild(splitBox);

  // 6. gates and sluices, 7. intake and demand
  const gatesBox = h('div', 'field');
  root.appendChild(gatesBox);
  const intakeBox = h('div', 'field');
  root.appendChild(intakeBox);
  // 8. the settling basins: sediment in, deposit, flushing (lane s)
  root.appendChild(mountSediment(ctx, offs));

  const gate = gateControl(ctx, ctl, sheet, () => desc, () => step);
  let step = 0.1; // FALLBACK: params.weir.gate_step_normal_m until params.json is read
  offs.push(store.on('weir', gate.refresh), store.on('lang', gate.refresh));
  sheetBox.addEventListener('keydown', gate.onKey);
  sheetBox.tabIndex = 0;
  const api = { redraw: () => sheet.redraw(), destroy, sheet, gate };
  const wired = wire({ ctx, root, chips, modeNote, alerts, tPond, tTail, tFree, tIn, bar, legend, gatesBox, intakeBox, offs, sheet, getDesc: () => desc, getIntake: () => intake });

  Promise.all([ctx.data.json('weir.json').catch(() => null), ctx.data.json('params.json').catch(() => null)]).then(([w, p]) => {
    desc = readWeir(w, p);
    const pw = (p && p.weir) || {};
    const num = (x) => {
      const v = Number(V(x));
      return x != null && Number.isFinite(v) ? v : null;
    };
    intake.target = num(pw.intake_target_m3s) ?? intake.target;
    intake.cap = num(pw.intake_capacity_m3s) ?? intake.cap;
    intake.max = num(pw.intake_capacity_max_m3s) ?? intake.max;
    intake.maint = num(pw.maintenance_flow_m3s) ?? intake.maint;
    const st = Number(V(pw.gate_step_normal_m));
    if (Number.isFinite(st) && st > 0) step = st;
    wired.rebuild();
    gate.refresh();
    wired.refreshResults();
  });

  function destroy() {
    offs.forEach((f) => typeof f === 'function' && f());
    sheet.destroy();
    root.remove();
  }
  return api;
}

function wire(o) {
  const { ctx, chips, modeNote, alerts, tPond, tTail, tFree, tIn, bar, legend, gatesBox, intakeBox, offs, sheet, getDesc, getIntake } = o;
  const { store, t, fmt } = ctx;
  let sliders = [];

  const sliderRow = (grid, name, max, step, get, set, show) => {
    const lab = h('label', 'slider__label', esc(name));
    const inp = document.createElement('input');
    inp.type = 'range';
    inp.min = '0';
    inp.max = String(max);
    inp.step = String(step);
    inp.setAttribute('aria-label', name);
    const val = h('span', 'slider__value');
    inp.addEventListener('input', () => set(Number(inp.value)));
    const row = h('div', 'slider');
    row.append(lab, val, inp);
    grid.appendChild(row);
    const s = { inp, val, get, show, manualOnly: true };
    return s;
  };

  function rebuild() {
    const desc = getDesc();
    sliders = [];
    gatesBox.innerHTML = '';
    gatesBox.appendChild(h('div', 'label', esc(t('operasi.gates_label', 'Gate openings (m)'))));
    const hint = h('p', 'note');
    hint.style.margin = '2px 0 6px';
    hint.dataset.role = 'gates-hint';
    gatesBox.appendChild(hint);
    const grid = h('div', 'operasi-rows');
    gatesBox.appendChild(grid);
    for (const b of desc.bays) {
      const key = b.kind === 'sluice' ? 'weir.sluices' : 'weir.gates';
      const n = b.kind === 'sluice' ? 3 : 7;
      const i = b.no - 1;
      const name = b.kind === 'sluice' ? t('operasi.sec.sluice_n', 'S{n}', { n: b.no }) : t('operasi.sec.gate_n', 'G{n}', { n: b.no });
      const max = desc.lift_max;
      const get = () => {
        const a = store.get(key);
        return Array.isArray(a) ? Number(a[i]) : null;
      };
      const set = (v) => {
        const cur = store.get(key);
        const a = Array.from({ length: Math.max(n, Array.isArray(cur) ? cur.length : 0) }, (_, j) => (Array.isArray(cur) && Number.isFinite(Number(cur[j])) ? Number(cur[j]) : 0));
        a[i] = v;
        store.set(key, a);
      };
      sliders.push(sliderRow(grid, name, max, 0.05, get, set, (v) => fmt.num(v, 2)));
    }

    intakeBox.innerHTML = '';
    intakeBox.appendChild(h('div', 'label', esc(t('operasi.intake_label', 'Intake and canal'))));
    const g2 = h('div', 'operasi-rows');
    g2.style.setProperty('--operasi-lw', '112px');
    g2.style.setProperty('--operasi-vw', '72px');
    intakeBox.appendChild(g2);
    const si = sliderRow(g2, t('operasi.intake_open', 'Intake opening'), 1, 0.05, () => store.get('weir.intake_open'), (v) => store.set('weir.intake_open', v), (v) => fmt.pct(v));
    si.manualOnly = false;
    const it = getIntake();
    const sd = sliderRow(g2, t('operasi.demand', 'Canal demand'), Math.ceil(it.max), 1, () => store.get('weir.demand_m3s') ?? store.get('irrigation.demand_m3s'), (v) => store.set('weir.demand_m3s', v), (v) => fmt.q(v));
    sd.manualOnly = false;
    sd.demand = true;
    sliders.push(si, sd);
    const inote = h('p', 'note operasi-intake-note');
    inote.dataset.role = 'intake-note';
    intakeBox.appendChild(inote);
    refreshControls();
  }

  function refreshControls() {
    const mode = store.get('weir.mode') || 'auto';
    for (const b of chips.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    const mn = MODE_NOTE[mode] || MODE_NOTE.auto;
    modeNote.textContent = t(mn[0], mn[1]);
    const manual = mode === 'manual';
    const hint = gatesBox.querySelector('[data-role="gates-hint"]');
    if (hint) {
      hint.textContent = manual ? t('operasi.gates_hint_manual', 'Drag a slider to lift or lower that gate.') : t('operasi.gates_hint_auto', 'Choose manual mode to set the gates yourself. Now they follow the mode.');
    }
    for (const s of sliders) {
      const v = s.get();
      if (document.activeElement !== s.inp && v != null && Number.isFinite(Number(v))) s.inp.value = String(v);
      s.val.textContent = v == null || !Number.isFinite(Number(v)) ? '–' : s.show(Number(v));
      s.inp.disabled = s.manualOnly && !manual;
      if (s.demand) s.inp.max = String(Math.ceil(manual ? getIntake().max : getIntake().target));
    }
    // the intake rule of the mode (CONTRACT A7 points 4 and 5)
    const it = getIntake();
    const inote = intakeBox.querySelector('[data-role="intake-note"]');
    if (inote) {
      inote.textContent = manual
        ? t('operasi.intake_note_manual', 'Manual mode: the canal may take up to {max}. Above its design capacity of {cap} an alert shows, and the river below may fall under its maintenance flow.', { max: fmt.q(it.max), cap: fmt.q(it.cap) })
        : t('operasi.intake_note_auto', 'The river keeps {m} first; the canal takes what is left, at most {target}.', { m: fmt.q(it.maint), target: fmt.q(it.target) });
    }
  }

  function refreshResults() {
    const w = store.get('weir') || {};
    const desc = getDesc();
    tPond.v.textContent = w.pond_el == null ? '–' : 'EL ' + fmt.el(w.pond_el);
    tTail.v.textContent = w.tail_el == null ? '–' : 'EL ' + fmt.el(w.tail_el);
    const fr = w.freeboard_m; // a result of s01; never computed here
    tFree.v.textContent = fr == null ? '–' : fmt.num(fr, 2);
    tFree.u.textContent = fr == null ? '' : 'm';
    tFree.v.style.color = fr != null && fr < 0 ? 'var(--danger)' : '';
    tIn.v.textContent = fmt.q(store.get('flow.q_in'));
    tPond.v.title = t('operasi.tile.pond_title', 'Normal level EL {n}', { n: fmt.el(desc.levels.normal_el) });

    // alerts
    const list = Array.isArray(w.alerts) ? w.alerts : [];
    alerts.innerHTML = '';
    for (const a of list) {
      const code = typeof a === 'string' ? a : a && a.code;
      const d = ALERTS[code] || ['warn', 'operasi.alert.other', 'The weir needs attention.'];
      const it = getIntake();
      alerts.appendChild(h('div', 'alert alert--' + d[0], esc(t(d[1], d[2], { m: fmt.q(it.maint), cap: fmt.q(it.cap) }))));
    }

    // flow split
    const parts = SPLIT.map(([k, key, en, col]) => ({ v: Number(w[k]), ok: w[k] != null && Number.isFinite(Number(w[k])), name: t(key, en), col }));
    const tot = parts.reduce((s, p) => s + (p.ok ? Math.max(0, p.v) : 0), 0);
    bar.innerHTML = tot > 0 ? parts.filter((p) => p.ok && p.v > 0).map((p) => `<i style="width:${((100 * p.v) / tot).toFixed(2)}%;background:${p.col}" title="${esc(p.name)}"></i>`).join('') : '';
    bar.setAttribute('aria-label', parts.map((p) => p.name + ' ' + (p.ok ? fmt.q(p.v) : '–')).join(', '));
    legend.innerHTML = parts
      .map((p) => `<span class="legend__item"><span class="swatch" style="background:${p.col}"></span>${esc(p.name)} <b style="font-variant-numeric:tabular-nums">${esc(p.ok ? fmt.q(p.v) : '–')}</b>${tot > 0 && p.ok ? ` <span class="operasi-pct">${esc(fmt.pct(p.v / tot))}</span>` : ''}</span>`)
      .join('');
  }

  let q = false;
  const tick = () => {
    if (q) return;
    q = true;
    queueMicrotask(() => {
      q = false;
      refreshControls();
      refreshResults();
    });
  };
  offs.push(store.on('weir', tick), store.on('flow', tick), store.on('irrigation', tick));
  offs.push(
    store.on('lang', () => {
      for (const b of chips.querySelectorAll('button')) {
        const m = MODES.find((x) => x[0] === b.dataset.mode);
        b.textContent = t(m[1], m[2]);
      }
      ctx.t.apply && ctx.t.apply(o.root);
      relabel();
      rebuild();
      refreshResults();
    }),
  );
  function relabel() {
    const labels = o.root.querySelectorAll('.tile .label');
    const keys = [['operasi.tile.pond', 'Pond level'], ['operasi.tile.tail', 'Tail water level'], ['operasi.tile.freeboard', 'Freeboard to design flood'], ['operasi.tile.q_in', 'Modelled inflow']];
    labels.forEach((l, i) => keys[i] && (l.textContent = t(keys[i][0], keys[i][1])));
    const fl = o.root.querySelectorAll(':scope > .field > .label');
    if (fl[0]) fl[0].textContent = t('operasi.mode_label', 'Operating mode');
    if (fl[1]) fl[1].textContent = t('operasi.split_label', 'Where the river goes');
    const notes = o.root.querySelectorAll(':scope > p.note');
    if (notes[0]) notes[0].textContent = t('app.model_note', 'Indicative model, not a survey');
    const sh = o.root.querySelector('.operasi-sheetrow .note');
    if (sh) sh.textContent = t('operasi.sheet_hint', 'Tap a bay in the elevation to cut the section through it.');
    const en = o.root.querySelector('[data-role="enlarge"]');
    if (en) en.textContent = t('operasi.enlarge', 'Enlarge');
  }
  rebuild();
  refreshResults();
  return { rebuild, refreshResults };
}

// ---------- the enlarged sheet over the map: every label, dimension and the title block ----------
let openOverlay = null;
export function openSheet(ctx, bay) {
  if (openOverlay) return openOverlay;
  const { t } = ctx;
  const ov = h('div', 'operasi-overlay');
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', t('operasi.sec.aria', 'Drawing of the weir: upstream elevation and a section through one bay'));
  ov.innerHTML = `<style>
.operasi-overlay{position:fixed;inset:0;z-index:50;background:rgba(246,245,241,.82);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:16px}
.operasi-overlay__card{position:relative;width:min(1100px,100%);background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:12px}
.operasi-overlay__bar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px}
</style><div class="operasi-overlay__card"><div class="operasi-overlay__bar"><span class="label"></span><button type="button" class="btn" data-role="close"></button></div><div data-role="sheet"></div></div>`;
  ov.querySelector('.label').textContent = t('operasi.enlarged_title', 'Weir drawing');
  const closeBtn = ov.querySelector('[data-role="close"]');
  closeBtn.textContent = t('operasi.close', 'Close');
  (document.getElementById('app') || document.body).appendChild(ov);
  const sheet = mountWeirSection(ov.querySelector('[data-role="sheet"]'), ctx, { bay, size: 'full' });
  const onKey = (e) => e.key === 'Escape' && close();
  function close() {
    document.removeEventListener('keydown', onKey);
    sheet.destroy();
    ov.remove();
    openOverlay = null;
  }
  document.addEventListener('keydown', onKey);
  ov.addEventListener('click', (e) => e.target === ov && close());
  closeBtn.addEventListener('click', close);
  closeBtn.focus();
  openOverlay = { close, sheet };
  return openOverlay;
}

// ---------- manual mode: one gate at a time, chosen on the drawing ----------
export function gateControl(ctx, el, sheet, getDesc, getStep) {
  const { store, t, fmt } = ctx;
  const q = (r) => el.querySelector(`[data-role="${r}"]`);
  const range = q('grange');
  const keyOf = (b) => (b.kind === 'sluice' ? 'weir.sluices' : 'weir.gates');
  const bayNow = () => getDesc().bays[sheet.bay] || getDesc().bays[0];
  const nameOf = (b) => (b.kind === 'sluice' ? t('operasi.sec.sluice_n', 'S{n}', { n: b.no }) : t('operasi.sec.gate_n', 'G{n}', { n: b.no }));
  const arr = (key, n) => {
    const cur = store.get(key);
    return Array.from({ length: n }, (_, j) => (Array.isArray(cur) && Number.isFinite(Number(cur[j])) ? Number(cur[j]) : 0));
  };
  const count = (kind) => getDesc().bays.filter((b) => b.kind === kind).length;
  const get = (b) => arr(keyOf(b), count(b.kind))[b.no - 1];
  const clamp = (v) => Math.max(0, Math.min(getDesc().lift_max, Math.round(v * 1000) / 1000));
  function set(b, v) {
    const a = arr(keyOf(b), count(b.kind));
    a[b.no - 1] = clamp(v);
    store.set(keyOf(b), a);
  }
  function all(v) {
    store.set('weir.gates', arr('weir.gates', count('flood')).map(() => clamp(v)));
    store.set('weir.sluices', arr('weir.sluices', count('sluice')).map(() => clamp(v)));
  }
  const manual = () => (store.get('weir.mode') || 'auto') === 'manual';
  function refresh() {
    el.hidden = !manual();
    const b = bayNow();
    if (!b) return;
    q('gname').textContent = t('operasi.gatectl.selected', 'Selected gate: {n}', { n: nameOf(b) });
    q('gval').textContent = fmt.num(get(b), 2) + ' m';
    range.max = String(getDesc().lift_max);
    if (document.activeElement !== range) range.value = String(get(b));
    q('openall').textContent = t('operasi.gatectl.open_all', 'Open all');
    q('closeall').textContent = t('operasi.gatectl.close_all', 'Close all');
    q('ghelp').textContent = t('operasi.gatectl.help', 'Tap a gate in the drawing, then slide.');
    q('minus').setAttribute('aria-label', t('operasi.gatectl.lower', 'Lower the gate'));
    q('plus').setAttribute('aria-label', t('operasi.gatectl.raise', 'Raise the gate'));
    range.setAttribute('aria-label', nameOf(b));
  }
  range.addEventListener('input', () => manual() && set(bayNow(), Number(range.value)));
  q('minus').addEventListener('click', () => manual() && set(bayNow(), get(bayNow()) - getStep()));
  q('plus').addEventListener('click', () => manual() && set(bayNow(), get(bayNow()) + getStep()));
  q('openall').addEventListener('click', () => manual() && all(getDesc().lift_max));
  q('closeall').addEventListener('click', () => manual() && all(0));
  function select(i) {
    sheet.setBay(i);
    queueMicrotask(refresh);
    if (manual()) el.focus({ preventScroll: true });
  }
  // keyboard on the control or the drawing: left and right choose the gate, up and down move it
  function onKey(e) {
    const n = getDesc().bays.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      select((sheet.bay + (e.key === 'ArrowLeft' ? n - 1 : 1)) % n);
      e.preventDefault();
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && manual()) {
      set(bayNow(), get(bayNow()) + (e.key === 'ArrowUp' ? 1 : -1) * getStep());
      e.preventDefault();
    }
  }
  el.addEventListener('keydown', (e) => e.target !== range && onKey(e));
  refresh();
  return { select, refresh, onKey, set, all };
}

// ---------- the settling basins (kantong lumpur): sediment in, deposit per basin, flushing (lane s) ----------
// Reads `sediment` (written by sim/weir-run.js from engine/sediment.js); writes `sediment.auto`; emits `sediment:flush`.
export function mountSediment(ctx, offs = []) {
  const { store, t, fmt } = ctx;
  const box = h('div', 'operasi-sed');
  box.innerHTML = `<style>
.operasi-sed{display:flex;flex-direction:column;gap:8px;border-top:var(--hair, 1px solid var(--line));padding-top:10px}
.operasi-sed__bars{display:grid;grid-template-columns:auto 1fr auto auto;gap:4px 8px;align-items:center;font-size:12px}
.operasi-sed__bar{position:relative;height:10px;border:1px solid var(--line);border-radius:var(--radius);background:var(--paper);overflow:hidden}
.operasi-sed__bar>i{position:absolute;inset:0 auto 0 0;background:#b89a6c}
.operasi-sed__bar>b{position:absolute;top:-1px;bottom:-1px;width:1px;background:var(--ink-3)}
.operasi-sed__bar.is-flush>i{background:#7a5636}
.operasi-sed__state{color:var(--ink-3);font:11px var(--mono)}
.operasi-sed__row{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.operasi-sed__row label{display:flex;gap:6px;align-items:center;font-size:12px}
.operasi-sed .note{margin:0}
</style>
<div class="label" data-role="title"></div>
<dl class="kv" data-role="conc"></dl>
<div class="operasi-sed__bars" data-role="bars"></div>
<p class="note" data-role="now"></p>
<div class="operasi-sed__row"><button type="button" class="btn btn--primary" data-role="flush"></button><label><input type="checkbox" data-role="auto"><span data-role="autolabel"></span></label></div>
<dl class="kv" data-role="tons"></dl>
<p class="note" data-role="note"></p>`;
  const q = (r) => box.querySelector(`[data-role="${r}"]`);
  const mg = (v) => (Number.isFinite(v) ? fmt.num(v, 0) + ' mg/L' : '–');
  const tn = (v) => (Number.isFinite(v) ? fmt.num(v, v < 100 ? 1 : 0) + ' t' : '–');
  const kv = (el, rows) => {
    el.replaceChildren();
    for (const [k, v] of rows) el.append(h('dt', null, esc(k)), h('dd', null, esc(v)));
  };
  q('flush').addEventListener('click', () => store.emit('sediment:flush', { basin: null }));
  q('auto').addEventListener('change', (e) => store.set('sediment.auto', !!e.target.checked));
  function render() {
    const s = store.get('sediment') || {};
    const basins = Array.isArray(s.basins) ? s.basins : [];
    const atPct = Number.isFinite(s.flush_at) ? s.flush_at : null;
    q('title').innerHTML = esc(t('operasi.sed.title', 'Settling basins')) + ' <sup class="status-letter" data-s="A"></sup>';
    kv(q('conc'), [
      [t('operasi.sed.c_river', 'River, mean sediment'), mg(s.c_river_mgL)],
      [t('operasi.sed.c_intake', 'Into the intake'), mg(s.c_intake_mgL)],
      [t('operasi.sed.c_canal', 'Out to the main canal'), mg(s.c_canal_mgL)],
    ]);
    const bars = q('bars');
    bars.replaceChildren();
    basins.forEach((b, i) => {
      const fill = Math.max(0, Math.min(1, b.fill || 0));
      const bar = h('div', 'operasi-sed__bar');
      bar.innerHTML = `<i style="width:${(fill * 100).toFixed(1)}%"></i>` + (atPct != null ? `<b style="left:${(atPct * 100).toFixed(1)}%"></b>` : '');
      const word = b.state === 'flushing'
        ? (b.waiting ? t('operasi.sed.st_wait', 'waiting for water') : t('operasi.sed.st_flush', 'flushing {p}', { p: fmt.pct(b.progress || 0) }))
        : b.state === 'queued' ? t('operasi.sed.st_queued', 'next in line') : t('operasi.sed.st_settle', 'settling');
      const row = [h('span', 'label', esc(t('operasi.sed.basin_n', 'B{n}', { n: i + 1 }))), bar,
        h('span', 'operasi-pct', esc(fmt.pct(fill))), h('span', 'operasi-sed__state', esc(word))];
      if (b.state === 'flushing') row.forEach((e) => e.classList.add('is-flush'));
      bars.append(...row);
    });
    bars.setAttribute('aria-label', t('operasi.sed.bars_aria', 'Deposit in each basin, west to east, as a share of its storage'));
    let now = '';
    if (Number.isInteger(s.flushing) && basins[s.flushing]) {
      const b = basins[s.flushing];
      const left = Math.max(0, 1 - (b.progress || 0));
      now = t('operasi.sed.now_flush', 'Flushing basin {n}: its sand runs back to the river through Saluran Bilas ({q}); about {h} h to go.', {
        n: s.flushing + 1, q: fmt.q(s.q_flush_m3s), h: fmt.num(left * (s.flush_hours ?? NaN), 1) });
      if (b.waiting) now = t('operasi.sed.now_wait', 'Flushing basin {n} waits: the river has no water to spare beyond the intake.', { n: s.flushing + 1 });
    } else if (s.next && Number.isInteger(s.next.basin)) {
      now = s.next.days === 0
        ? t('operasi.sed.next_due', 'Basin {n} is due for flushing.', { n: s.next.basin + 1 })
        : Number.isFinite(s.next.days)
          ? t('operasi.sed.next_in', 'Next flush: basin {n}, in about {d} days at today\'s sediment.', { n: s.next.basin + 1, d: fmt.num(s.next.days, s.next.days < 10 ? 1 : 0) })
          : t('operasi.sed.next_none', 'No sediment is coming in: the intake is shut.');
    }
    q('now').textContent = now;
    q('flush').textContent = t('operasi.sed.flush_now', 'Flush now');
    q('flush').title = t('operasi.sed.flush_title', 'Flush the fullest basin (one at a time; the canal keeps running from the others)');
    const auto = s.auto !== false;
    q('auto').checked = auto;
    q('autolabel').textContent = t('operasi.sed.auto', 'Flush automatically at {p} full', { p: fmt.pct(atPct ?? 0.8) });
    const ld = s.last_day || {}, yr = s.year || {};
    kv(q('tons'), [
      [t('operasi.sed.day_trap', 'Kept in the basins, last 24 hours'), tn(ld.trapped_t)],
      [t('operasi.sed.day_back', 'Flushed back to the river, last 24 hours'), tn(ld.returned_t)],
      [t('operasi.sed.year_trap', 'Kept this year'), tn(yr.trapped_t)],
      [t('operasi.sed.year_back', 'Flushed back this year'), tn(yr.returned_t)],
    ]);
    q('note').textContent = t('operasi.sed.note', 'Indicative model: the JICA 2003 sediment rating scaled to the sourced 5.02 million t a year; what the intake draws, what a basin keeps and the flushing rule are assumed (no flushing schedule was found).');
  }
  // the clock can send many updates a second: draw at most once per frame
  let pend = false;
  const soon = () => {
    if (pend) return;
    pend = true;
    requestAnimationFrame(() => { pend = false; render(); });
  };
  offs.push(store.on('sediment', soon), store.on('lang', soon));
  render();
  return box;
}
