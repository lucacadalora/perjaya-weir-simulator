// Maker tab ("Buat"). Owner: lane b21. CONTRACT 4.4 (`maker`), 4.5, 5 and the lead addendum.
// Places a dam (button then a map click, or a preset), lists the dams, and for the active one edits its controls
// (name, kind, crest height, constant release, spillway width) and shows what lane s01 computed for it: catchment,
// lake area and volume when full, mean inflow, years to fill, percent full, spill, the storage curve, and a plain
// sentence when the dam line does not reach high ground on both banks.
// This tab computes nothing and never writes a result key of maker.dams[] (those belong to s01).
//
// Shapes this tab writes (other lanes bind to them):
//   maker.placing = true            while waiting for a map click (Escape or the button cancels)
//   maker.dams[] new entry          { id 'd<n>', name, lon, lat, grid 'wide', idx null, type, crest_el, base_el null,
//                                     height_m, crest_len_m null, release_m3s, spill_width_m, preset (id or null),
//                                     results all null, status 'computing', line null }
//   maker.active = id
//   event maker:place  { lon, lat, id }     after the entry exists (s01 fills its results)
//   event maker:remove { id }               after the entry left the list
//   crest: the slider writes height_m, and crest_el = base_el + height_m once s01 has set base_el.

import { lineChart } from './charts.js';
import { FALLBACK_PRESETS } from './search.js';

// FALLBACK control ranges and starting values; params.json `maker` (b18) overrides the defaults it carries
// (spill_width_default_m, release_default_m3s, release_max_m3s). Interface defaults, not researched values.
const DEFAULTS = {
  height_m: { v: 40, min: 5, max: 150, step: 1 }, // FALLBACK
  release_m3s: { v: 0, min: 0, max: 200, step: 0.5 }, // FALLBACK
  spill_width_m: { v: 30, min: 5, max: 200, step: 5 }, // FALLBACK
  type: 'embankment', // FALLBACK
};
const SECONDS_PER_YEAR = 365.25 * 86400; // calendar constant, not a researched number

const RESULT_KEYS = ['catchment_km2', 'fsl_area_km2', 'fsl_volume_m3', 'inflow_m3s', 'level_el', 'volume_m3', 'fill', 'spill_m3s'];

const STYLE = `
.buat{display:flex;flex-direction:column;gap:14px;padding:14px}
.buat__row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.buat__list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.buat__dam{display:flex;justify-content:space-between;gap:8px;width:100%;text-align:left;font:13px var(--font);padding:6px 8px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);color:var(--ink);cursor:pointer}
.buat__dam[aria-pressed="true"]{border-color:var(--accent);box-shadow:inset 3px 0 0 var(--accent)}
.buat__dam .label{align-self:center}
.buat__presets{display:flex;flex-wrap:wrap;gap:6px}
.buat__name{width:100%;font:600 14px var(--font);padding:6px 8px;border:1px solid var(--line);border-radius:var(--radius);color:var(--ink)}
.buat .slider{display:grid;grid-template-columns:1fr auto;gap:2px 8px}
.buat .slider input{grid-column:1 / -1;width:100%}
.buat__chart{min-height:150px}
.buat [hidden]{display:none !important}
`;

export async function init(ctx) {
  if (!ctx?.store) return;
  const { store, t, fmt } = ctx;
  if (!ctx.panel?.addTab) {
    ctx.log?.('tab-buat: no panel yet');
    return;
  }
  if (!document.getElementById('b21-buat-style')) {
    const st = document.createElement('style');
    st.id = 'b21-buat-style';
    st.textContent = STYLE;
    document.head.append(st);
  }

  // Ranges from params.json when lane b18 adds them (flat.maker.*), else the fallback above.
  const lim = structuredClone(DEFAULTS);
  try {
    const p = await Promise.race([ctx.data.json('params.json'), new Promise((r) => setTimeout(() => r(null), 3000))]);
    const m = p?.maker || {};
    const val = (g) => (Number.isFinite(g?.v) ? g.v : Number.isFinite(g) ? g : null);
    const pick = (key, field, name) => {
      const v = val(m[name]);
      if (v != null) lim[key][field] = v;
    };
    pick('spill_width_m', 'v', 'spill_width_default_m');
    pick('release_m3s', 'v', 'release_default_m3s');
    pick('release_m3s', 'max', 'release_max_m3s');
    pick('height_m', 'v', 'height_default_m');
    pick('height_m', 'max', 'height_max_m');
    if (lim.release_m3s.max > 300) lim.release_m3s.step = 1;
    if (typeof m.type_default?.v === 'string') lim.type = m.type_default.v;
  } catch {
    // params.json not there yet: the fallback stays
  }

  let root = null;
  let chart = null;
  let shownId = null; // the dam whose detail is built
  let offField = []; // field listeners of the shown dam
  const el = (sel) => root?.querySelector(sel);

  const maker = () => store.get('maker') || { active: null, placing: false, dams: [] };
  const dams = () => maker().dams || [];
  const active = () => dams().find((d) => d.id === maker().active) || null;
  const presets = () => store.get('search.presets') || FALLBACK_PRESETS; // FALLBACK until presets.json
  const lang = () => store.get('lang') || 'id';
  const pname = (p) => (typeof p.name === 'string' ? p.name : lang() === 'en' ? p.name?.en || p.name?.id : p.name?.id || p.name?.en);

  function setDam(id, patch) {
    const list = dams().map((d) => (d.id === id ? { ...d, ...patch } : d));
    store.set('maker.dams', list);
  }

  function nextId() {
    let n = 0;
    for (const d of dams()) n = Math.max(n, Number(String(d.id).replace(/\D/g, '')) || 0);
    return 'd' + (n + 1);
  }

  // A new dam. Only control keys are set; every result starts null for s01 to fill.
  function place({ lon, lat, name, type, crest_el, height_m, crest_len_m, release_m3s, spill_width_m, preset }) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    const id = nextId();
    const n = Number(id.slice(1));
    const dam = {
      id,
      name: name || t('buat.default_name', 'Dam {n}', { n }),
      lon,
      lat,
      grid: 'wide',
      idx: null,
      type: type === 'gravity' || type === 'embankment' ? type : lim.type,
      crest_el: Number.isFinite(crest_el) ? crest_el : null,
      base_el: null,
      height_m: Number.isFinite(height_m) ? height_m : Number.isFinite(crest_el) ? null : lim.height_m.v,
      crest_len_m: Number.isFinite(crest_len_m) ? crest_len_m : null,
      release_m3s: Number.isFinite(release_m3s) ? release_m3s : lim.release_m3s.v,
      spill_width_m: Number.isFinite(spill_width_m) ? spill_width_m : lim.spill_width_m.v,
      preset: preset || null,
      line: null,
      status: 'computing',
    };
    for (const k of RESULT_KEYS) dam[k] = null;
    store.patch('maker', { dams: [...dams(), dam], active: id, placing: false });
    store.emit('maker:place', { lon, lat, id });
  }

  function remove(id) {
    const list = dams().filter((d) => d.id !== id);
    const act = maker().active === id ? (list[list.length - 1]?.id ?? null) : maker().active;
    store.patch('maker', { dams: list, active: act });
    store.emit('maker:remove', { id });
  }

  // The next plain map click places the dam while `placing` is on.
  store.listen('map:click', (p) => {
    if (!maker().placing || !p) return;
    place({ lon: p.lon, lat: p.lat });
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && maker().placing) store.set('maker.placing', false);
  });

  // ---------- markup ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const tile = (key, labelKey, label) =>
    `<div class="tile" data-tile="${key}"><div class="label">${esc(t(labelKey, label))}</div><span class="value">–</span><span class="status-letter" data-s="C" title="${esc(t('buat.status_c', 'Computed by the model'))}">C</span></div>`;
  const slider = (key, labelKey, label) =>
    `<label class="slider" data-slider="${key}"><span class="slider__label label">${esc(t(labelKey, label))}</span><span class="slider__value"></span>` +
    `<input type="range" min="${lim[key].min}" max="${lim[key].max}" step="${lim[key].step}"></label>`;

  function build() {
    if (!root) return;
    shownId = null;
    root.innerHTML = `
<div class="buat">
  <section class="buat__place">
    <p class="note">${esc(t('buat.intro', 'Put a dam of your own on any river in the basin, set its height and watch its lake fill over simulated years.'))}</p>
    <div class="buat__row">
      <button type="button" class="btn btn--primary" data-act="place">${esc(t('buat.place', 'Place a dam'))}</button>
      <button type="button" class="btn btn--quiet" data-act="cancel" hidden>${esc(t('buat.cancel', 'Cancel'))}</button>
    </div>
    <p class="note" data-part="placing" hidden>${esc(t('buat.placing', 'Click a river on the map where the dam should stand. Esc cancels.'))}</p>
  </section>
  <section data-part="presets-wrap">
    <div class="label">${esc(t('buat.presets', 'Real and planned dam sites'))}</div>
    <div class="buat__presets" data-part="presets"></div>
  </section>
  <section data-part="list-wrap" hidden>
    <div class="label">${esc(t('buat.list', 'Your dams'))}</div>
    <ul class="buat__list" data-part="list"></ul>
  </section>
  <section class="card" data-part="detail" hidden>
    <label class="field"><span class="label">${esc(t('buat.name', 'Name'))}</span><input class="buat__name" type="text" maxlength="60" data-ctl="name"></label>
    <div class="field"><span class="label">${esc(t('buat.kind', 'Kind'))}</span>
      <div class="chips" role="group" data-ctl="type">
        <button type="button" data-v="embankment" aria-pressed="false">${esc(t('buat.kind_embankment', 'Embankment'))}</button>
        <button type="button" data-v="gravity" aria-pressed="false">${esc(t('buat.kind_gravity', 'Concrete gravity'))}</button>
      </div></div>
    ${slider('height_m', 'buat.height', 'Crest height above the river bed')}
    ${slider('release_m3s', 'buat.release', 'Constant release')}
    ${slider('spill_width_m', 'buat.spill_width', 'Spillway width')}
    <p class="alert alert--warn" data-part="noclose" hidden>${esc(t('buat.noclose', 'At this height the dam does not reach high ground on both banks, so the valley does not close and no lake can form. Lower the crest or move the dam to a narrower part of the valley.'))}</p>
    <p class="note" data-part="state"></p>
    <div class="tiles">
      ${tile('catchment_km2', 'buat.t_catchment', 'Catchment')}
      ${tile('inflow_m3s', 'buat.t_inflow', 'Mean inflow')}
      ${tile('fsl_area_km2', 'buat.t_area', 'Lake area, full')}
      ${tile('fsl_volume_m3', 'buat.t_volume', 'Volume, full')}
      ${tile('years', 'buat.t_years', 'Years to fill')}
      ${tile('fill', 'buat.t_fill', 'Full')}
      ${tile('spill_m3s', 'buat.t_spill', 'Spill')}
      ${tile('level_el', 'buat.t_level', 'Lake level')}
    </div>
    <div>
      <div class="label">${esc(t('buat.curve', 'Storage curve: volume by lake level'))}</div>
      <div class="buat__chart" data-part="chart"></div>
    </div>
    <p class="note">${esc(t('app.model_note', 'Indicative model, not a survey'))}. ${esc(t('buat.surface_note', 'The lake is drawn on a 30 m surface model that includes tree tops and roofs.'))}</p>
    <div class="buat__row"><button type="button" class="btn btn--quiet" data-act="remove">${esc(t('buat.remove', 'Remove this dam'))}</button></div>
  </section>
</div>`;
    chart?.destroy?.();
    chart = null;
    renderPresets();
    render();
  }

  function renderPresets() {
    const box = el('[data-part="presets"]');
    if (!box) return;
    const list = presets().filter((p) => p && p.kind === 'dam');
    el('[data-part="presets-wrap"]').hidden = !list.length;
    box.replaceChildren(
      ...list.map((p) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn';
        b.textContent = pname(p);
        b.title = t('buat.preset_title', 'Go there and build a dam at this site');
        b.addEventListener('click', () => {
          store.emit('camera:goto', { lon: p.lon, lat: p.lat, zoom: p.zoom ?? 12.5, pitch: p.pitch ?? 55, bearing: p.bearing ?? 0 });
          const d = p.dam || {};
          const num = (x) => (Number.isFinite(x?.v) ? x.v : Number.isFinite(x) ? x : undefined);
          place({ lon: p.lon, lat: p.lat, name: pname(p), type: d.type, crest_el: num(d.crest_el), height_m: num(d.height_m),
            crest_len_m: num(d.crest_len_m), release_m3s: num(d.release_m3s), spill_width_m: num(d.spill_width_m), preset: p.id });
        });
        return b;
      }),
    );
  }

  // ---------- values ----------
  const STATUS_TEXT = {
    computing: ['buat.s_computing', 'Working out the catchment, the dam line and the storage curve'],
    filling: ['buat.s_filling', 'Filling'],
    full: ['buat.s_full', 'Full'],
    spilling: ['buat.s_spilling', 'Full and spilling'],
    empty: ['buat.s_empty', 'Empty'],
  };
  const heightOf = (d) =>
    Number.isFinite(d.height_m) ? d.height_m : Number.isFinite(d.crest_el) && Number.isFinite(d.base_el) ? d.crest_el - d.base_el : lim.height_m.v;

  // Years to fill: s01's own figure when it gives one, else volume when full over the yearly net inflow (display only).
  function yearsToFill(d) {
    if (Number.isFinite(d.years_to_fill)) return d.years_to_fill;
    const net = (d.inflow_m3s ?? NaN) - (d.release_m3s ?? 0);
    if (!Number.isFinite(d.fsl_volume_m3) || !Number.isFinite(net)) return null;
    return net > 0 ? d.fsl_volume_m3 / (net * SECONDS_PER_YEAR) : Infinity;
  }

  function setTile(key, value, unit = '') {
    const tl = el(`[data-tile="${key}"]`);
    if (!tl) return;
    const v = tl.querySelector('.value');
    v.textContent = value;
    if (unit) {
      const u = document.createElement('span');
      u.className = 'unit';
      u.textContent = unit;
      v.append(u);
    }
  }

  function renderList() {
    const ul = el('[data-part="list"]');
    if (!ul) return;
    const m = maker();
    el('[data-part="list-wrap"]').hidden = !dams().length;
    ul.replaceChildren(
      ...dams().map((d) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'buat__dam';
        b.setAttribute('aria-pressed', String(d.id === m.active));
        const nm = document.createElement('span');
        nm.textContent = d.name;
        const st = document.createElement('span');
        st.className = 'label';
        st.textContent = d.status === 'computing' || d.fill == null ? '…' : fmt.pct(d.fill);
        b.append(nm, st);
        b.addEventListener('click', () => store.set('maker.active', d.id));
        li.append(b);
        return li;
      }),
    );
  }

  function watchFields(id) {
    offField.forEach((off) => off?.());
    offField = [];
    if (!ctx.fields?.on || !id) return;
    offField.push(ctx.fields.on('dam.line:' + id, () => render()));
    offField.push(ctx.fields.on('reservoir.curve:' + id, () => renderChart()));
  }

  function renderChart() {
    const box = el('[data-part="chart"]');
    const d = active();
    if (!box || !d) return;
    const c = ctx.fields?.get?.('reservoir.curve:' + d.id);
    if (!c || !c.level_el?.length) {
      chart?.destroy?.();
      chart = null;
      box.innerHTML = `<p class="note">${esc(d.status === 'computing' ? t('buat.curve_wait', 'The curve appears once the dam line is worked out.') : t('buat.curve_none', 'No storage curve for this dam yet.'))}</p>`;
      return;
    }
    const opts = {
      x: Array.from(c.level_el),
      series: [{ name: t('buat.curve_series', 'Volume'), y: Array.from(c.volume_m3, (v) => v / 1e6), fill: true }],
      height: 150,
      yMin: 0,
      yLabel: t('buat.curve_y', 'million m³'),
      xFormat: (v) => fmt.num(v, 0) + ' m',
      yFormat: (v) => fmt.num(v, v >= 100 ? 0 : 1),
      now: Number.isFinite(d.level_el) ? { x: d.level_el, label: t('buat.curve_now', 'now') } : null,
    };
    if (!chart || !box.querySelector('svg')) {
      chart?.destroy?.();
      box.replaceChildren();
      chart = lineChart(box, opts);
    }
    else chart.update(opts);
  }

  function render() {
    if (!root) return;
    const m = maker();
    const placing = !!m.placing;
    el('[data-act="place"]').hidden = placing;
    el('[data-act="cancel"]').hidden = !placing;
    el('[data-part="placing"]').hidden = !placing;
    renderList();

    const d = active();
    const det = el('[data-part="detail"]');
    det.hidden = !d;
    if (!d) {
      if (shownId) watchFields(null);
      shownId = null;
      return;
    }
    if (shownId !== d.id) {
      shownId = d.id;
      watchFields(d.id);
      chart?.destroy?.();
      chart = null;
      renderChart();
    }
    const nameIn = el('[data-ctl="name"]');
    if (document.activeElement !== nameIn) nameIn.value = d.name ?? '';
    for (const b of el('[data-ctl="type"]').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === d.type));

    const sl = (key, v, text) => {
      const box = el(`[data-slider="${key}"]`);
      const inp = box.querySelector('input');
      if (document.activeElement !== inp && Number.isFinite(v)) inp.value = v;
      box.querySelector('.slider__value').textContent = text;
    };
    // The release slider spans up to about three times the mean inflow (never past the params maximum), so small
    // rivers stay controllable.
    const relIn = el('[data-slider="release_m3s"] input');
    const relMax = Number.isFinite(d.inflow_m3s) ? Math.min(lim.release_m3s.max, Math.max(10, Math.ceil((d.inflow_m3s * 3) / 10) * 10)) : lim.release_m3s.max;
    if (Number(relIn.max) !== relMax) (relIn.max = relMax), (relIn.step = relMax <= 100 ? 0.5 : 1);
    const h = heightOf(d);
    sl('height_m', h, fmt.len(h));
    sl('release_m3s', d.release_m3s, fmt.q(d.release_m3s));
    sl('spill_width_m', d.spill_width_m, fmt.len(d.spill_width_m));

    const line = ctx.fields?.get?.('dam.line:' + d.id);
    el('[data-part="noclose"]').hidden = !(line && line.ok === false) && d.line_ok !== false;

    const s = STATUS_TEXT[d.status] || null;
    el('[data-part="state"]').textContent = s ? t(s[0], s[1]) : '';

    const split = (str) => {
      const m2 = /^(.*?)\s+(\S*[a-zA-Z³²%]\S*)$/.exec(str);
      return m2 && str !== '–' ? [m2[1], m2[2]] : [str, ''];
    };
    setTile('catchment_km2', ...split(fmt.area(d.catchment_km2)));
    setTile('inflow_m3s', ...split(fmt.q(d.inflow_m3s)));
    setTile('fsl_area_km2', ...split(fmt.area(d.fsl_area_km2)));
    const v = fmt.vol(d.fsl_volume_m3);
    setTile('fsl_volume_m3', ...(v === '–' ? ['–', ''] : [v.replace(/\s.*$/, ''), v.replace(/^\S+\s/, '')]));
    const y = yearsToFill(d);
    if (y === Infinity) setTile('years', t('buat.never', 'never'), '');
    else setTile('years', y == null ? '–' : fmt.num(y, y < 10 ? 1 : 0), y == null ? '' : t('buat.years_unit', 'yr'));
    setTile('fill', ...split(fmt.pct(d.fill)));
    setTile('spill_m3s', ...split(fmt.q(d.spill_m3s)));
    setTile('level_el', ...split(fmt.el(d.level_el)));
    if (chart && Number.isFinite(d.level_el)) renderChart();
  }

  // ---------- events ----------
  function wire() {
    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      const d = active();
      if (act === 'place') store.set('maker.placing', true);
      else if (act === 'cancel') store.set('maker.placing', false);
      else if (act === 'remove' && d) remove(d.id);
      const chip = e.target.closest('[data-ctl="type"] button');
      if (chip && d && chip.dataset.v !== d.type) setDam(d.id, { type: chip.dataset.v });
    });
    root.addEventListener('input', (e) => {
      const d = active();
      if (!d) return;
      if (e.target.matches('[data-ctl="name"]')) return setDam(d.id, { name: e.target.value });
      const key = e.target.closest('[data-slider]')?.dataset.slider;
      const v = Number(e.target.value);
      if (key === 'height_m') {
        // the dam line and the storage curve are redone on release ("change"); here only the read-out moves
        e.target.closest('[data-slider]').querySelector('.slider__value').textContent = fmt.len(v);
      } else if (key === 'release_m3s' || key === 'spill_width_m') setDam(d.id, { [key]: v });
    });
    root.addEventListener('change', (e) => {
      const d = active();
      if (!d || e.target.closest('[data-slider]')?.dataset.slider !== 'height_m') return;
      const h = Number(e.target.value);
      setDam(d.id, { height_m: h, crest_el: Number.isFinite(d.base_el) ? d.base_el + h : null });
    });
  }

  ctx.panel.addTab({
    id: 'buat',
    order: 50,
    label: ['buat.tab', 'Build'],
    modes: ['maker'],
    mount(host) {
      root = host;
      build();
      wire();
    },
    onShow() {
      chart?.destroy?.();
      chart = null;
      renderChart();
    },
  });

  store.on('maker', () => render());
  store.on('search', () => renderPresets());
  store.on('lang', () => build());
  ctx.maker = { place, remove };
}
