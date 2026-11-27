// Impact tab ("Dampak"). Owner: lane b22. CONTRACT 4.4 (`flood`, `impact`, `maker`), 4.5 (`legend.impact`), 2.1, 5.
// Answers a regency official's first question in one look: how many buildings, which villages, which roads.
// The lead sentence is built from the numbers; the method's limits sit right under it and never scroll away.
// Reads only the store and ctx.fields; never imports a map or sim module. Every value may be null ("–").

// WorldCover class codes (the format of site/data/grid/lc.json, not a researched number). Literal t() calls so the
// harvest (b03) finds every key.
const LC_NAMES = (t) => ({
  10: t('dampak.lc.10', 'Tree cover'),
  20: t('dampak.lc.20', 'Shrubland'),
  30: t('dampak.lc.30', 'Grassland'),
  40: t('dampak.lc.40', 'Cropland and rice fields'),
  50: t('dampak.lc.50', 'Built-up land'),
  60: t('dampak.lc.60', 'Bare or sparse vegetation'),
  70: t('dampak.lc.70', 'Snow and ice'),
  80: t('dampak.lc.80', 'Open water (river, lakes)'),
  90: t('dampak.lc.90', 'Herbaceous wetland'),
  95: t('dampak.lc.95', 'Mangroves'),
  100: t('dampak.lc.100', 'Moss and lichen'),
  0: t('dampak.lc.0', 'No land-cover data'),
});

const KIND_NAMES = (t) => ({
  city: t('dampak.kind.city', 'city'),
  town: t('dampak.kind.town', 'town'),
  village: t('dampak.kind.village', 'village'),
  hamlet: t('dampak.kind.hamlet', 'hamlet'),
  locality: t('dampak.kind.locality', 'locality'),
  neighborhood: t('dampak.kind.neighborhood', 'neighbourhood'),
  macrohood: t('dampak.kind.macrohood', 'district'),
});

const fin = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);

// Round a count the way a person would say it: exact below 100, to tens below 1,000, to hundreds above.
export function roundCount(n) {
  const v = fin(n);
  if (v == null) return null;
  if (v < 100) return Math.round(v);
  if (v < 1000) return Math.round(v / 10) * 10;
  if (v < 10000) return Math.round(v / 100) * 100;
  return Math.round(v / 1000) * 1000;
}

// One summary object from the store, for either mode. Pure (takes plain state), so it is easy to test.
//   source: 'flood' | 'lake' ; ready: numbers exist ; empty: why there is nothing yet ('no_dam' | 'not_yet')
export function summarize(state) {
  const mode = state.mode === 'maker' ? 'maker' : 'weir';
  const im = state.impact || {};
  const fl = state.flood || {};
  const mk = state.maker || {};
  const dam = mode === 'maker' && mk.active != null ? (mk.dams || []).find((d) => d && d.id === mk.active) || null : null;
  const lc = [];
  let lcSum = 0;
  if (im.lc_ha && typeof im.lc_ha === 'object') {
    for (const [code, ha] of Object.entries(im.lc_ha)) {
      const v = fin(ha);
      if (v == null || v <= 0) continue;
      lc.push({ code: String(code), ha: v });
      lcSum += v;
    }
    lc.sort((a, b) => b.ha - a.ha);
  }
  const places = Array.isArray(im.places) ? im.places.filter((p) => p && p.name) : [];
  // Whose numbers are these? `impact.source` ('flood' | 'dam:<id>') when the runner writes it, otherwise the mode and
  // dam that were current when `impact` last changed (state.origin). Numbers from the other mode are not shown.
  let from = null;
  if (typeof im.source === 'string' && im.source) {
    from = im.source === 'weir' || im.source === 'flood' ? { mode: 'weir' } : { mode: 'maker', dam: im.source.replace(/^dam:/, '') };
  }
  else if (state.origin) from = state.origin;
  const stale = !!from && (from.mode !== mode || (mode === 'maker' && dam && from.dam != null && String(from.dam) !== String(dam.id)));
  const counted = !stale && (fin(im.buildings) != null || fin(im.roads_km) != null || lc.length > 0);
  let area_km2 = mode === 'weir' ? fin(fl.area_km2) : null;
  if (area_km2 == null && lcSum > 0) area_km2 = lcSum / 100;
  const out = {
    mode,
    source: mode === 'maker' ? 'lake' : 'flood',
    dam: dam ? { id: dam.id, name: dam.name || null, fill: fin(dam.fill), level_el: fin(dam.level_el) } : null,
    q: mode === 'weir' ? fin(fl.q) ?? fin(state.flow && state.flow.q_in) : null,
    depth_max_m: mode === 'weir' ? fin(fl.depth_max_m) : null,
    area_km2,
    buildings: fin(im.buildings),
    footprint_m2: fin(im.footprint_m2),
    roads_km: fin(im.roads_km),
    rail_km: fin(im.rail_km),
    lc,
    roads: state.lines ? roadsByName(state.lines) : null,
    inside: places.filter((p) => p.inside),
    near: places.filter((p) => !p.inside),
    version: im.version || 0,
    ready: counted && !(mode === 'maker' && !dam),
    empty: null,
  };
  // A7.3 / A8.4: what the flood is measured from (s01 writes the level used and the flow that reaches it)
  out.ref_el = fin(fl.ref_tail_el_used);
  out.ref_q = fin(fl.ref_q_m3s);
  out.ref_shift = fin(fl.ref_shift_m) ?? 0;
  // Three weir cases: dry (under the reference flow, nothing flooded), edge (over it but no flooded area yet or a tiny
  // one), flooded (numbers). Edge never says the river is inside its channel.
  const flooded = out.area_km2 > 0 || out.buildings > 0;
  const over = fin(fl.stage_m) > 0 || (out.ref_q != null && out.q != null && out.q >= out.ref_q);
  out.edge = mode === 'weir' && !stale && !flooded && over;
  out.dry = out.ready && out.source === 'flood' && !flooded && !over;
  if (!out.ready) out.empty = mode === 'maker' && !dam ? 'no_dam' : 'not_yet';
  return out;
}

// "A", "A and B", "A, B and C", "A, B, C and 4 more places"
export function joinNames(t, names, max = 3) {
  const and = t('dampak.join.and', ' and ');
  const shown = names.slice(0, max);
  if (names.length === max + 1) shown.push(names[max]);
  const rest = names.length - shown.length;
  if (rest > 0) return shown.join(', ') + and + t('dampak.places.more', '{n} more places', { n: rest });
  if (shown.length <= 1) return shown.join('');
  return shown.slice(0, -1).join(', ') + and + shown[shown.length - 1];
}

// Named roads under water from the field `impact.lines` (GeoJSON, `kind` 'road'|'rail', `name`), longest first.
export function roadsByName(fc) {
  const R = 6371.0088, rad = Math.PI / 180;
  const lenOf = (line) => {
    let km = 0;
    for (let i = 1; i < line.length; i++) {
      const [x1, y1] = line[i - 1], [x2, y2] = line[i];
      const dx = (x2 - x1) * rad * Math.cos(((y1 + y2) / 2) * rad), dy = (y2 - y1) * rad;
      km += R * Math.hypot(dx, dy);
    }
    return km;
  };
  const by = new Map();
  let unnamed = 0;
  for (const f of (fc && fc.features) || []) {
    const p = f.properties || {};
    if (p.kind && p.kind !== 'road') continue;
    const g = f.geometry || {};
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    let km = 0;
    for (const l of lines) km += lenOf(l || []);
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!name) unnamed += km;
    else by.set(name, (by.get(name) || 0) + km);
  }
  return { named: [...by].map(([name, km]) => ({ name, km })).sort((a, b) => b.km - a.km), unnamed_km: unnamed };
}

// The first sentence (what the numbers mean) and the second (roads and rail). Built from the numbers only.
export function leadSentences(t, fmt, s) {
  if (s.edge) return [t('dampak.lead.edge', 'The water has passed the channel\'s edge in the terrain model; the flooded area is still being worked out or is still very small.'), ''];
  if (!s.ready) {
    if (s.empty === 'no_dam') return [t('dampak.empty.no_dam', 'Place a dam or pick one in the "Build a dam" tab to see what its lake would cover.')];
    if (s.mode === 'maker') return [t('dampak.empty.lake', 'The lake is still being worked out. Its count appears here as soon as it is ready.')];
    return [t('dampak.empty.weir', 'No flooding has been worked out yet. Run the simulation or choose the design flood in the Rain tab to see what the water reaches.')];
  }
  if (s.dry) {
    return [
      t('dampak.lead.dry', 'At this flow the river stays inside its channel. No building is under water.'),
      s.ref_q != null ? t('dampak.lead.onset', 'Flooding would begin at about {q} at the weir.', { q: fmt.q(roundCount(s.ref_q)) }) : '',
    ];
  }
  const b = s.buildings || 0;
  const names = [...s.inside, ...s.near].map((p) => p.name);
  const where = names.length ? t('dampak.lead.where', ' around {places}', { places: joinNames(t, names) }) : '';
  const vars = {
    q: fmt.q(s.q),
    dam: (s.dam && s.dam.name) || t('dampak.lead.your_dam', 'your dam'),
    fill: fmt.pct(s.dam && s.dam.fill),
    buildings: fmt.num(roundCount(b)),
    where,
  };
  let first;
  if (s.source === 'lake') {
    first = b > 0
      ? t('dampak.lead.lake', 'With the lake of {dam} {fill} full, the model puts about {buildings} buildings under water{where}.', vars)
      : t('dampak.lead.lake_none', 'With the lake of {dam} {fill} full, the model finds no building under water{where}.', vars);
  } else {
    first = b > 0
      ? t('dampak.lead.weir', 'At {q} in the river at the weir, the model puts about {buildings} buildings under water{where}.', vars)
      : t('dampak.lead.weir_none', 'At {q} in the river at the weir, the model finds no building under water{where}.', vars);
  }
  const road = s.roads_km || 0;
  const rail = s.rail_km || 0;
  const named = (s.roads && s.roads.named) || [];
  const roads = named.length
    ? t('dampak.lead.road_named', '{len} of road (among them {names})', { len: fmt.len(road * 1000), names: joinNames(t, named.map((r) => r.name), 2) })
    : t('dampak.lead.road_plain', '{len} of road', { len: fmt.len(road * 1000) });
  const rv = { roads, rail: fmt.len(rail * 1000) };
  let second;
  if (road > 0 && rail > 0) second = t('dampak.lead.ways', '{roads} and {rail} of railway are under water too.', rv);
  else if (road > 0) second = t('dampak.lead.roads', '{roads} is under water too; no railway.', rv);
  else if (rail > 0) second = t('dampak.lead.rail', '{rail} of railway is under water too; no road.', rv);
  else second = t('dampak.lead.no_ways', 'No road or railway is under water.');
  return [first, second];
}

// What the flood is measured from, in one sentence (weir mode). refEl falls back to params + shift until s01 writes it.
export function refSentence(t, fmt, s, refEl) {
  const el = s.ref_el ?? refEl;
  if (el == null) return t('dampak.ref.unknown', 'Ground counts as flooded when the water rises above the river level in the terrain model below the weir.');
  const vars = { el: 'EL ' + fmt.num(el, 1), q: s.ref_q != null ? fmt.q(roundCount(s.ref_q)) : '' };
  return s.ref_q != null
    ? t('dampak.ref.sentence', 'Ground counts as flooded when the water rises above the river level in the terrain model, about {el} below the weir: the height the river reaches at roughly {q}.', vars)
    : t('dampak.ref.sentence_noq', 'Ground counts as flooded when the water rises above the river level in the terrain model, about {el} below the weir.', vars);
}

// The method's limits, always shown under the lead sentence. The lake uses a level fill on the 90 m grid.
export function limitsSentence(t, s) {
  return s.source === 'lake'
    ? t('dampak.limits.lake', 'How this is worked out: the lake is filled level on a 90 m grid taken from a 30 m surface model that includes tree tops and roofs. It is a quick estimate, not a hydraulic model and not a forecast.')
    : t('dampak.limits.weir', 'How this is worked out: a quick height-above-river method on a 30 m surface model that includes tree tops and roofs. It is not a hydraulic flood model and not a forecast.');
}

// CSV text (comma separated, quoted where needed, numbers with a dot) of the summary.
export function toCSV(rows) {
  const cell = (v) => {
    const s = v == null ? '' : typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v);
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function summaryRows(t, s, extra = {}) {
  const names = LC_NAMES(t);
  const kinds = KIND_NAMES(t);
  const rows = [[t('dampak.csv.section', 'Section'), t('dampak.csv.item', 'Item'), t('dampak.csv.value', 'Value'), t('dampak.csv.unit', 'Unit')]];
  const sec = t('dampak.csv.totals', 'Totals');
  rows.push([sec, t('dampak.csv.source', 'Water'), s.source === 'lake' ? t('dampak.csv.lake', 'Lake of {dam}', { dam: (s.dam && s.dam.name) || '' }) : t('dampak.csv.flood', 'River flood at the weir'), '']);
  if (extra.date) rows.push([sec, t('dampak.csv.date', 'Simulated date'), extra.date, '']);
  if (s.source === 'flood' && extra.ref) rows.push([sec, t('dampak.csv.ref', 'Reference'), extra.ref, '']);
  if (s.source === 'flood') rows.push([sec, t('dampak.csv.shift', 'Bank reference shift'), s.ref_shift, 'm']);
  if (s.source === 'flood') rows.push([sec, t('dampak.csv.q', 'River flow at the weir (model)'), s.q, 'm3/s']);
  if (s.source === 'lake') rows.push([sec, t('dampak.csv.fill', 'Lake fill'), s.dam && s.dam.fill != null ? s.dam.fill * 100 : null, '%']);
  rows.push([sec, t('dampak.csv.area', 'Area under water'), s.area_km2 != null ? s.area_km2 * 100 : null, 'ha']);
  rows.push([sec, t('dampak.csv.buildings', 'Buildings under water'), s.buildings, t('dampak.csv.count', 'count')]);
  rows.push([sec, t('dampak.csv.roof', 'Roof area of those buildings'), s.footprint_m2, 'm2']);
  rows.push([sec, t('dampak.csv.roads', 'Road under water'), s.roads_km, 'km']);
  rows.push([sec, t('dampak.csv.rail', 'Railway under water'), s.rail_km, 'km']);
  const rsec = t('dampak.csv.roadlist', 'Roads under water');
  for (const r of (s.roads && s.roads.named) || []) rows.push([rsec, r.name, r.km, 'km']);
  if (s.roads && s.roads.unnamed_km > 0) rows.push([rsec, t('dampak.roads.unnamed', 'Roads without a name'), s.roads.unnamed_km, 'km']);
  const lsec = t('dampak.csv.landcover', 'Land cover under water');
  for (const r of s.lc) rows.push([lsec, names[r.code] || r.code, r.ha, 'ha']);
  const psec = t('dampak.csv.places', 'Places touched');
  for (const p of s.inside) rows.push([psec, p.name, kinds[p.kind] || p.kind || '', t('dampak.csv.inside', 'centre under water')]);
  for (const p of s.near) rows.push([psec, p.name, kinds[p.kind] || p.kind || '', t('dampak.csv.near', 'water nearby')]);
  rows.push([t('dampak.csv.notes', 'Notes'), t('app.model_note', 'Indicative model, not a survey'), '', '']);
  rows.push([t('dampak.csv.notes', 'Notes'), limitsSentence(t, s), '', '']);
  if (extra.credit) rows.push([t('dampak.csv.notes', 'Notes'), extra.credit, '', '']);
  return rows;
}

// ---------- view ----------

const CSS = `
.tabpanel > .dampak__head,.dampak__head{position:sticky;top:-14px;z-index:2;background:var(--panel);margin:-14px -16px 0;padding:14px 16px 10px;border-bottom:var(--hair)}
.dampak__lead{font-size:15px;line-height:1.5;color:var(--ink);margin:0}
.dampak__lead b{font-weight:600}
.dampak__lead2{font-size:var(--fs-small);color:var(--ink-2);margin:4px 0 0}
.dampak__limits{margin:8px 0 0}
.dampak__limits p{margin:0}
.dampak__limits p + p{margin-top:2px}
.dampak__lc{list-style:none;margin:0;padding:0;display:grid;gap:7px}
.dampak__lc li{display:grid;grid-template-columns:1fr auto;gap:2px 10px;font-size:var(--fs-small);color:var(--ink-2)}
.dampak__lc .value{color:var(--ink);font-variant-numeric:tabular-nums}
.dampak__lc .bar{grid-column:1 / -1;height:6px}
.dampak__places{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:4px 6px}
.dampak__places li{font-size:var(--fs-small);border:var(--hair);border-radius:var(--radius);padding:2px 6px;color:var(--ink)}
.dampak__places li[data-inside="1"]{border-color:var(--flood);background:var(--danger-weak)}
.dampak__places small{color:var(--ink-3);margin-left:4px}
.dampak__foot{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.dampak__wait{color:var(--ink-3)}
.dampak__ref{margin-top:12px;padding-bottom:12px;border-bottom:var(--hair)}
.dampak__refline{margin:0 0 8px;font-size:var(--fs-small);color:var(--ink-2)}
.dampak__body > * + *{margin-top:12px}
.dampak__body{margin-top:12px}
@media (max-width:720px){.tabpanel > .dampak__head,.dampak__head{top:-12px;margin:-12px -14px 0;padding:12px 14px 10px}}
`;

function addStyle() {
  if (document.getElementById('dampak-style')) return;
  const st = document.createElement('style');
  st.id = 'dampak-style';
  st.textContent = CSS;
  document.head.append(st);
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function legendHTML(t, lg) {
  if (!lg || !Array.isArray(lg.items) || !lg.items.length) return '';
  const sw = (it) => {
    const c = esc(it.color || 'var(--flood)');
    if (it.kind === 'dot') return `<span class="swatch swatch--dot" style="--c:${c}"></span>`;
    if (it.kind === 'line') return `<span class="swatch swatch--line" style="--c:${c}"></span>`;
    if (it.kind === 'dash') return `<span class="swatch swatch--dash" style="--c:${c}"></span>`;
    if (it.kind === 'outline') return `<span class="swatch" style="background:none;border:2px solid ${c}"></span>`;
    return `<span class="swatch" style="--c:${c}"></span>`;
  };
  const items = lg.items.map((it) => `<li class="legend__item">${sw(it)}<span>${esc(it.label || it.en || '')}</span></li>`).join('');
  return `<h3 class="label">${esc(lg.title || t('dampak.legend', 'On the map'))}</h3><ul class="legend legend--col">${items}</ul>`;
}

function mountDampak(el, ctx) {
  const { t, fmt, store } = ctx;
  addStyle();
  el.classList.add('dampak');
  let credits = null;
  ctx.data?.json?.('credits.json').then((c) => { credits = Array.isArray(c) ? c : (c && c.credits) || null; later(); }).catch(() => {});

  function state() {
    return { origin, mode: store.get('mode'), impact: store.get('impact'), flood: store.get('flood'), flow: store.get('flow'), maker: store.get('maker'), lines: ctx.fields?.get?.('impact.lines') || null };
  }

  function creditLine() {
    if (!credits) return '';
    const want = ['glo30', 'worldcover', 'osm', 'overture-places'];
    return credits.filter((c) => want.includes(c.id)).map((c) => c.short).join(' · ');
  }

  // Three persistent parts: the sticky head, the reference block with its slider (never rebuilt, so a drag is not
  // interrupted), and the body.
  const headEl = document.createElement('div');
  headEl.className = 'dampak__head';
  const refEl = document.createElement('div');
  refEl.className = 'dampak__ref';
  const SHIFT = { min: -2, max: 1, step: 0.25 }; // A8.4: the bank-reference test range, in metres (UI range, not data)
  refEl.innerHTML = `<p class="dampak__refline" data-dampak="ref"></p>
    <label class="slider dampak__slider"><span class="slider__label" data-dampak="shift-label"></span><span class="slider__value" data-dampak="shift-value"></span>
      <input type="range" min="${SHIFT.min}" max="${SHIFT.max}" step="${SHIFT.step}" value="0" data-dampak="shift"><small class="note" data-dampak="shift-note"></small></label>`;
  const bodyEl = document.createElement('div');
  bodyEl.className = 'dampak__body';
  const shiftIn = refEl.querySelector('[data-dampak="shift"]');
  const shiftVal = () => fin(store.get('flood.ref_shift_m')) ?? 0;
  const showShift = (v) => {
    refEl.querySelector('[data-dampak="shift-value"]').textContent = (v > 0 ? '+' : v < 0 ? '−' : '') + fmt.num(Math.abs(v), 2) + ' m';
    shiftIn.style.setProperty('--fill', (((v - SHIFT.min) / (SHIFT.max - SHIFT.min)) * 100).toFixed(1) + '%');
  };
  shiftIn.addEventListener('input', () => {
    const v = Math.round(Number(shiftIn.value) / SHIFT.step) * SHIFT.step;
    showShift(v);
    store.set('flood.ref_shift_m', v);
  });
  let paramRef = null; // FALLBACK until s01 writes flood.ref_tail_el_used: params flat flood.ref_tail_el
  ctx.data?.json?.('params.json').then((P) => { paramRef = fin(P && P.flat && P.flat['flood.ref_tail_el']); later(); }).catch(() => {});
  function renderRef(s) {
    refEl.hidden = s.mode !== 'weir';
    if (refEl.hidden) return;
    const shift = shiftVal();
    refEl.querySelector('[data-dampak="ref"]').textContent = refSentence(t, fmt, s, paramRef != null ? paramRef + shift : null);
    refEl.querySelector('[data-dampak="shift-label"]').textContent = t('dampak.ref.shift', 'Bank reference');
    refEl.querySelector('[data-dampak="shift-note"]').textContent = t('dampak.ref.shift_note', 'Lower it to test what happens if the banks are lower than the terrain model shows.');
    if (document.activeElement !== shiftIn) shiftIn.value = String(shift);
    showShift(shift);
  }

  function render() {
    const s = summarize(state());
    const [lead, lead2] = leadSentences(t, fmt, s);
    const names = LC_NAMES(t);
    const kinds = KIND_NAMES(t);
    const head = `
      <p class="dampak__lead" data-dampak="lead">${esc(lead)}</p>
      ${lead2 ? `<p class="dampak__lead2" data-dampak="lead2">${esc(lead2)}</p>` : ''}
      <div class="note note--model dampak__limits" data-dampak="limits"><p>${esc(t('app.model_note', 'Indicative model, not a survey'))}.</p><p>${esc(limitsSentence(t, s))}</p></div>`;
    let body = '';
    if (s.ready && !s.dry && !s.edge) {
      const roofHa = s.footprint_m2 != null ? s.footprint_m2 / 1e4 : null;
      const roof = roofHa == null ? '–' : roofHa >= 1 ? fmt.ha(roofHa) : fmt.num(s.footprint_m2, 0) + ' m²';
      const areaHa = s.area_km2 != null ? s.area_km2 * 100 : null;
      body += `<div class="tiles">
        <div class="tile"><div class="label">${esc(t('dampak.tile.area', 'Under water'))}</div><div class="value">${esc(fmt.ha(areaHa))}</div><div class="unit">${esc(fmt.area(s.area_km2))}</div></div>
        <div class="tile"><div class="label">${esc(t('dampak.tile.buildings', 'Buildings'))}</div><div class="value">${esc(fmt.num(s.buildings, 0))}</div><div class="unit">${esc(t('dampak.tile.roof', 'roofs {roof}', { roof }))}</div></div>
        <div class="tile"><div class="label">${esc(t('dampak.tile.roads', 'Road'))}</div><div class="value">${esc(fmt.len(s.roads_km != null ? s.roads_km * 1000 : null))}</div><div class="unit">${esc(t('dampak.tile.under', 'under water'))}</div></div>
        <div class="tile"><div class="label">${esc(t('dampak.tile.rail', 'Railway'))}</div><div class="value">${esc(fmt.len(s.rail_km != null ? s.rail_km * 1000 : null))}</div><div class="unit">${esc(t('dampak.tile.under', 'under water'))}</div></div>
      </div>`;
      const places = [...s.inside, ...s.near];
      body += `<h3 class="label">${esc(t('dampak.places.title', 'Places touched'))}</h3>`;
      body += places.length
        ? `<ul class="dampak__places">${places.slice(0, 24).map((p) => `<li data-inside="${p.inside ? 1 : 0}">${esc(p.name)}<small>${esc(kinds[p.kind] || '')}</small></li>`).join('')}</ul>
           <p class="note">${esc(t('dampak.places.note', 'Red: the place\'s centre point is under water. Others: the water comes close.'))}${places.length > 24 ? ' ' + esc(t('dampak.places.more', '{n} more places', { n: places.length - 24 })) + '.' : ''}</p>`
        : `<p class="note">${esc(t('dampak.places.none', 'No named place is near the water.'))}</p>`;
      const named = (s.roads && s.roads.named) || [];
      if (named.length) {
        body += `<h3 class="label">${esc(t('dampak.roads.title', 'Roads under water'))}</h3><table class="table table--compact"><tbody>${named.slice(0, 6).map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${esc(fmt.len(r.km * 1000))}</td></tr>`).join('')}${s.roads.unnamed_km > 0 ? `<tr><td>${esc(t('dampak.roads.unnamed', 'Roads without a name'))}</td><td class="num">${esc(fmt.len(s.roads.unnamed_km * 1000))}</td></tr>` : ''}</tbody></table>`;
      }
      const top = s.lc.length ? s.lc[0].ha : 0;
      body += `<h3 class="label">${esc(t('dampak.lc.title', 'Land under water, by cover'))}</h3>`;
      body += s.lc.length
        ? `<ul class="dampak__lc">${s.lc.map((r) => `<li><span>${esc(names[r.code] || r.code)}</span><span class="value">${esc(fmt.ha(r.ha))}</span><span class="bar${r.code === '80' ? ' bar--water' : ''}" style="--p:${top > 0 ? (r.ha / top).toFixed(3) : 0}"><i></i></span></li>`).join('')}</ul>`
        : `<p class="note">${esc(t('dampak.lc.none', 'No land-cover count yet.'))}</p>`;
    }
    const lg = ctx.fields?.get?.('legend.impact');
    if (lg) body += legendHTML(t, lg);
    if (s.ready) {
      body += `<div class="dampak__foot"><button type="button" class="btn btn--sm" data-dampak="csv">${esc(t('dampak.csv.button', 'Download summary (CSV)'))}</button>
        </div>${creditLine() ? `<p class="label dampak__credit">${esc(creditLine())}</p>` : ''}`;
    }
    if (!headEl.isConnected) el.replaceChildren(headEl, refEl, bodyEl);
    headEl.innerHTML = head;
    renderRef(s);
    bodyEl.innerHTML = body;
    bodyEl.querySelector('[data-dampak="csv"]')?.addEventListener('click', () => download(s));
  }

  function download(s) {
    const clock = store.get('clock') || {};
    const rows = summaryRows(t, s, { date: clock.date || '', credit: creditLine(), ref: refSentence(t, fmt, s, paramRef != null ? paramRef + shiftVal() : null) });
    const blob = new Blob([toCSV(rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    const tag = s.source === 'lake' ? 'danau' : 'banjir';
    a.href = URL.createObjectURL(blob);
    a.download = `dampak-${tag}-${(clock.date || 'model').replace(/[^0-9-]/g, '')}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // remember which mode and dam the current impact numbers belong to
  let origin = (store.get('impact') || {}).version ? { mode: store.get('mode'), dam: store.get('maker.active') } : null;
  store.on('impact', () => (origin = { mode: store.get('mode'), dam: store.get('maker.active') }));
  let queued = false;
  let dirty = false;
  const later = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (el.hidden) return void (dirty = true);
      try { render(); } catch (e) { fail(e); }
    });
  };
  const fail = (e) => {
    console.warn('[dampak]', e);
    el.replaceChildren();
    el.innerHTML = `<p class="failed">${esc(t('dampak.failed', 'The impact summary could not be shown just now.'))}</p>`;
  };
  for (const k of ['impact', 'flood', 'mode', 'lang', 'maker.active', 'maker.dams']) store.on(k, later);
  ctx.fields?.on?.('legend.impact', later);
  ctx.fields?.on?.('impact.lines', later);
  try { render(); } catch (e) { fail(e); }
  return { render: later, renderNow: () => { dirty = false; try { render(); } catch (e) { fail(e); } } };
}

export async function init(ctx) {
  if (!ctx?.panel?.addTab) return;
  let view = null;
  ctx.panel.addTab({
    id: 'dampak',
    order: 40,
    label: ['dampak.tab', 'Impact'],
    modes: ['weir', 'maker'],
    mount(el) {
      view = mountDampak(el, ctx);
    },
    onShow() {
      view?.renderNow();
    },
  });
}
