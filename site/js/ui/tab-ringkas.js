// Tab "Ringkas" (overview). Owner: lane b01. Both modes, first tab.
// Two sentences on what this is; three "try this" buttons that set `scenario` through the store; six key facts as
// tiles from site/data/facts.json with their status letters; the stand-ins list.
// Which six facts: facts.meta.key_facts (a list of six fact keys, lane b18) when present, else the first fact whose
// key matches each pattern in SLOTS. A missing fact shows "–" and never breaks the tab.
// Scenario values: params.json `flat['scenario.dry_year']` and `flat['scenario.design_T']` when present.

const SLOTS = [
  { re: /^weir\.(length|crest_len)/, key: 'ringkas.fact_length', en: 'Weir length' },
  { re: /^weir\.(flood_gates|gates_n|gate_count|n_gates)/, key: 'ringkas.fact_gates', en: 'Flood gates' },
  { re: /^weir\.(design_flood|q_design)|design_flood/, key: 'ringkas.fact_design_flood', en: 'Design flood' },
  { re: /^(catchment|basin)\.(area)/, key: 'ringkas.fact_catchment', en: 'Catchment' },
  { re: /^irrigation\.(area|command|service)/, key: 'ringkas.fact_irrigation', en: 'Irrigated area' },
  { re: /^(river|flow)\.(mean|q_mean)/, key: 'ringkas.fact_mean_flow', en: 'Mean river flow' },
];

const DRY_YEAR = 2019; // FALLBACK: the brief's dry year until params.json carries scenario.dry_year
const DESIGN_T = 100; // FALLBACK: return period (years) of the statistical flood button until params.json carries it

// The stand-ins list is facts.json `standins` (lane b18); no text is typed here.

export async function init(ctx) {
  if (!ctx.panel) return;
  const { store, t, fmt } = ctx;
  let el = null;
  let facts = null;
  let params = null;
  let factsFailed = false;

  ctx.panel.addTab({
    id: 'ringkas',
    order: 0,
    label: ['ringkas.tab', 'Overview'],
    modes: ['weir', 'maker'],
    mount(node) {
      el = node;
      render();
    },
  });

  ctx.data
    .json('facts.json')
    .then((f) => (facts = f))
    .catch(() => (factsFailed = true))
    .finally(render);
  ctx.data
    .json('params.json')
    .then((p) => (params = p))
    .catch(() => {})
    .finally(render);
  store.on('lang', render);
  store.on('mode', render);
  store.on('scenario', render);

  function param(name, fallback) {
    const v = params?.flat?.[name];
    const n = v && typeof v === 'object' ? v.v : v;
    return Number.isFinite(Number(n)) && n != null ? Number(n) : fallback;
  }

  function trials() {
    const dry = param('scenario.dry_year', DRY_YEAR);
    const T = param('scenario.design_T', DESIGN_T);
    const qd = param('scenario.design_q_m3s', param('weir.design_flood_m3s', null));
    return [
      {
        id: 'mean',
        title: t('ringkas.try_mean', 'A mean year'),
        hint: t('ringkas.try_mean_hint', 'Average rain month by month: watch the river rise in the wet season.'),
        scenario: { kind: 'climatology', year: null, rain_scale: 1, label: t('ringkas.try_mean', 'A mean year'), design_T: null },
      },
      {
        id: 'dry',
        title: t('ringkas.try_dry', 'The dry year {year}', { year: dry }),
        hint: t('ringkas.try_dry_hint', 'Replay a dry year: does the canal still get its water?'),
        scenario: { kind: 'replay', year: dry, rain_scale: 1, label: t('ringkas.try_dry', 'The dry year {year}', { year: dry }), design_T: null },
      },
      {
        // The weir's own design flood (design_T null = the weir's design flood, as lane b19's rain tab).
        id: 'design',
        title: t('ringkas.try_design_weir', 'Weir design flood {q}', { q: fmt.q(qd) }),
        hint: t('ringkas.try_design_weir_hint', 'The flood the weir was designed for: every gate opens; see what floods below.'),
        scenario: { kind: 'design', year: null, rain_scale: 1, label: t('ringkas.try_design_weir', 'Weir design flood {q}', { q: fmt.q(qd) }), design_T: null },
      },
      {
        id: 'flood_T',
        title: t('ringkas.try_flood_T', '{T}-year flood', { T }),
        hint: t('ringkas.try_flood_T_hint', 'A rarer statistical flood from the long-term flow record.'),
        scenario: { kind: 'design', year: null, rain_scale: 1, label: t('ringkas.try_flood_T', '{T}-year flood', { T }), design_T: T },
      },
    ];
  }

  function runTrial(tr) {
    store.set('mode', 'weir');
    store.set('scenario', { ...(store.get('scenario') || {}), ...tr.scenario });
    try {
      ctx.sim?.reset?.();
    } catch (e) {
      console.error('[ringkas] sim.reset failed', e);
    }
    if (!ctx.shot) store.set('clock.running', true);
    store.emit('toast', { text: t('ringkas.toast_started', 'Running: {name}', { name: tr.title }), kind: 'info' });
  }

  function factFor(slot, i) {
    const list = facts?.facts || {};
    const pick = facts?.meta?.key_facts?.[i];
    if (pick && list[pick]) return [pick, list[pick]];
    const k = Object.keys(list).find((key) => slot.re.test(key));
    return k ? [k, list[k]] : [null, null];
  }

  function valueText(f) {
    const v = f?.v;
    if (v == null) return '–';
    if (typeof v === 'number') return fmt.num(v, Number.isInteger(v) ? 0 : Math.abs(v) < 10 ? 2 : 1);
    if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v))) return fmt.num(Number(v), 0);
    return String(v);
  }

  function tile(slot, i) {
    const [, f] = factFor(slot, i);
    const lang = store.get('lang') || 'id';
    const d = document.createElement('div');
    d.className = 'tile';
    const lab = document.createElement('div');
    lab.className = 'label';
    // Long labels wrap to two lines instead of being cut off.
    Object.assign(lab.style, { whiteSpace: 'normal', overflow: 'visible', textOverflow: 'clip', paddingRight: '14px' });
    lab.textContent = (f?.label && (f.label[lang] || f.label.en)) || t(slot.key, slot.en);
    const val = document.createElement('div');
    val.className = 'value';
    val.textContent = valueText(f);
    const unit = prettyUnit(f?.unit);
    if (unit && val.textContent !== '–') {
      const u = document.createElement('span');
      u.className = 'unit';
      u.textContent = unit;
      val.append(u);
    }
    d.append(lab, val);
    if (f?.status) {
      const s = document.createElement('span');
      s.className = 'status-letter';
      s.dataset.s = f.status;
      s.textContent = f.status;
      s.title = t('ringkas.status_' + f.status, { S: 'Sourced', C: 'Computed', R: 'Read from a picture or map', A: 'Assumed', P: 'Press' }[f.status] || f.status);
      d.append(s);
    }
    return d;
  }

  function prettyUnit(u) {
    if (!u || u === '-') return '';
    return String(u).replace(/m3\b/g, 'm³').replace(/km2\b/g, 'km²').replace(/m2\b/g, 'm²');
  }

  function section(titleKey, titleEn) {
    const s = document.createElement('div');
    s.className = 'ringkas__section';
    const h = document.createElement('h3');
    h.className = 'card__title';
    h.textContent = t(titleKey, titleEn);
    s.append(h);
    return s;
  }

  function render() {
    if (!el) return;
    const intro = document.createElement('div');
    intro.className = 'ringkas__intro';
    const p1 = document.createElement('p');
    p1.textContent = t(
      'ringkas.intro_1',
      'Perjaya Weir holds back the Komering River near Martapura and turns part of it into the canal that waters the rice fields of OKU Timur.',
    );
    const p2 = document.createElement('p');
    p2.textContent =
      (store.get('mode') || 'weir') === 'maker'
        ? t('ringkas.intro_2_maker', 'In this mode you place a dam of your own on any river of the basin and watch the lake fill over simulated years.')
        : t('ringkas.intro_2', 'Here rain over the basin becomes river flow; you operate the gates and see the pond, the canal and the river below respond.');
    intro.append(p1, p2);

    const tryS = section('ringkas.try_title', 'Try this');
    const cur = store.get('scenario') || {};
    for (const tr of trials()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ringkas__try';
      // Layout only (look is lane b02's): a full-width button with its hint on a second line.
      Object.assign(b.style, { display: 'block', width: '100%', textAlign: 'left', whiteSpace: 'normal', marginBottom: '6px' });
      const on = cur.kind === tr.scenario.kind && (tr.scenario.kind !== 'replay' || cur.year === tr.scenario.year) && (tr.scenario.kind !== 'design' || (cur.design_T ?? null) === tr.scenario.design_T);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      const tt = document.createElement('strong');
      tt.textContent = tr.title;
      const hh = document.createElement('span');
      hh.className = 'note';
      hh.textContent = tr.hint;
      hh.style.display = 'block';
      b.append(tt, hh);
      b.addEventListener('click', () => runTrial(tr));
      tryS.append(b);
    }

    const factS = section('ringkas.facts_title', 'Key facts');
    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    SLOTS.forEach((slot, i) => tiles.append(tile(slot, i)));
    factS.append(tiles);
    if (factsFailed || !facts) {
      const n = document.createElement('p');
      n.className = 'note';
      n.textContent = factsFailed ? t('ringkas.facts_missing', 'The fact sheet is not available yet.') : t('ringkas.facts_loading', 'Loading the fact sheet…');
      factS.append(n);
    }

    const standS = section('ringkas.standins_title', 'Stand-ins in this model');
    const lang = store.get('lang') || 'id';
    const fromFacts = Array.isArray(facts?.standins) ? facts.standins.map((s) => (typeof s === 'string' ? s : s?.[lang] || s?.en)).filter(Boolean) : null;
    const all = fromFacts || [];
    const list = (items) => {
      const ul = document.createElement('ul');
      ul.className = 'ringkas__standins';
      for (const text of items) {
        const li = document.createElement('li');
        li.textContent = text;
        ul.append(li);
      }
      return ul;
    };
    const FIRST = 4; // how many stand-ins show before "all"
    if (!all.length) {
      const n = document.createElement('p');
      n.className = 'note';
      n.textContent = facts ? t('ringkas.standins_missing', 'The list of stand-ins is not available yet.') : t('ringkas.facts_loading', 'Loading the fact sheet…');
      standS.append(n);
    }
    standS.append(list(all.slice(0, FIRST)));
    if (all.length > FIRST) {
      const more = document.createElement('details');
      more.className = 'ringkas__more';
      const sum = document.createElement('summary');
      sum.textContent = t('ringkas.standins_more', 'All {n} stand-ins', { n: all.length });
      more.append(sum, list(all.slice(FIRST)));
      standS.append(more);
    }

    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = t('app.model_note', 'Indicative model, not a survey');

    el.replaceChildren(intro, tryS, factS, standS, note);
  }
}
