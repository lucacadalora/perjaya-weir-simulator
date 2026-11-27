// Tab "Dosir" (dossier). Owner: lane b18. Both modes, last tab.
// The researched facts of the weir, its river, the irrigation system, operation, money, upstream dams, floods and
// droughts, each with its status letter and numbered sources; then the timeline, the stand-ins, the sources list and
// the data credits. Every number comes from site/data/facts.json (written by tools/data/build.mjs); nothing is typed
// here. Text values in facts.json are {id, en}; labels and notes too.

const SECTION_TITLES = {
  identity: ['dosir.sec_identity', 'What it is'],
  structure: ['dosir.sec_structure', 'The structure'],
  river: ['dosir.sec_river', 'The river'],
  irrigation: ['dosir.sec_irrigation', 'The irrigation system'],
  operation: ['dosir.sec_operation', 'Operation'],
  money: ['dosir.sec_money', 'Money and institutions'],
  upstream: ['dosir.sec_upstream', 'Upstream dams'],
  floods: ['dosir.sec_floods', 'Floods and droughts'],
  people: ['dosir.sec_people', 'People'],
};
const SECTION_LEADS = {
  identity: ['dosir.lead_identity', 'A gated weir (a barrage), not a dam: it raises the river a few metres and turns part of it into the canal; it stores almost nothing.'],
  structure: ['dosir.lead_structure', 'Gate sizes come from the operation and maintenance manual as quoted by later reports; levels the drawings would give are marked A where we had to assume them.'],
  river: ['dosir.lead_river', 'Flows at the weir are long-term figures from the old Martapura gauge and later studies; there is no public live gauge.'],
  irrigation: ['dosir.lead_irrigation', 'The weir feeds one of the largest irrigation systems of South Sumatra; several area figures exist because they measure different things.'],
  operation: ['dosir.lead_operation', 'The operating rules come from a student paper quoting the manual; no gate log or pond record is published.'],
  money: ['dosir.lead_money', 'Built with Japanese loans in stages since 1989; operated by the central government.'],
  upstream: ['dosir.lead_upstream', 'Lake Ranau feeds the river in the dry season through a regulating weir; a large storage dam is being built on a tributary.'],
  floods: ['dosir.lead_floods', 'Dated events from reports and the press; press items are marked P.'],
  people: ['dosir.lead_people', 'Who lives along the river near the weir.'],
};
const STATUS_EN = { S: 'Sourced', C: 'Computed', R: 'Read from a picture or map', A: 'Assumed', P: 'Press' };

export async function init(ctx) {
  if (!ctx.panel) return;
  const { store, t, fmt } = ctx;
  let el = null;
  let facts = null;
  let credits = null;
  let failed = false;


  const lang = () => (store.get('lang') === 'en' ? 'en' : 'id');
  const tx = (o) => (o == null ? '' : typeof o === 'object' ? o[lang()] || o.en || o.id || '' : String(o));
  const h = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function decimals(v) {
    const s = String(v);
    const i = s.indexOf('.');
    return i < 0 ? 0 : Math.min(3, s.length - i - 1);
  }
  function prettyUnit(u) {
    if (!u || u === '-' || u === 'date') return '';
    const whole = {
      houses: t('dosir.unit_houses', 'houses'), persons: t('dosir.unit_persons', 'people'),
      Mm3: t('dosir.unit_mm3', 'million m³'), 'Mt/yr': t('dosir.unit_mtyr', 'million t/yr'),
      'M yen': t('dosir.unit_myen', 'million yen'), 'Rp bn': t('dosir.unit_rpbn', 'Rp billion'),
      'Rp M': t('dosir.unit_rpm', 'Rp million'), 'mm/day': t('dosir.unit_mmday', 'mm/day'), deg: '°',
    };
    if (whole[u]) return whole[u];
    return String(u).replace(/m3\/s/g, 'm³/s').replace(/m3\b/g, 'm³').replace(/km2\b/g, 'km²').replace(/m2\b/g, 'm²');
  }
  function monthYear(s) {
    const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(s || '');
    if (!m) return s || '–';
    if (m[3]) return fmt.date(s);
    try {
      return new Intl.DateTimeFormat(lang() === 'en' ? 'en-GB' : 'id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
        new Date(Date.UTC(+m[1], +m[2] - 1, 1)),
      );
    } catch {
      return s;
    }
  }
  // value text with its unit; EL values read "EL +81,00"
  function valueText(f) {
    const v = f.v;
    if (v == null) return '–';
    if (f.unit === 'date') return monthYear(v);
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'number' ? fmt.num(x, decimals(x)) : tx(x))).join(' · ') + unitSuffix(f.unit);
    if (typeof v === 'object') return tx(v);
    if (typeof v === 'number') {
      if (f.unit === 'm EL') return 'EL ' + (v >= 0 ? '+' : '−') + fmt.num(Math.abs(v), 2);
      if (f.unit === 'deg') return fmt.num(v, 5) + '°';
      return fmt.num(v, decimals(v)) + unitSuffix(f.unit);
    }
    return String(v) + unitSuffix(f.unit);
  }
  function unitSuffix(u) {
    const p = prettyUnit(u);
    return p ? (p === '°' || p === '%' ? p : ' ' + p) : '';
  }

  // sources numbered in order of first use in this render
  let srcIndex = new Map();
  function refs(list) {
    const nums = [];
    for (const k of list || []) {
      if (!facts?.sources?.[k]) continue;
      if (!srcIndex.has(k)) srcIndex.set(k, srcIndex.size + 1);
      nums.push(srcIndex.get(k));
    }
    return nums.length ? '[' + [...new Set(nums)].sort((a, b) => a - b).join(', ') + ']' : '';
  }
  function statusLetter(s) {
    const n = h('sup', 'status-letter', s);
    n.dataset.s = s;
    n.title = t('dosir.status_' + s, STATUS_EN[s] || s);
    return n;
  }

  function factRow(key, f) {
    const row = h('div', 'dosir__fact');
    const lab = h('dt', 'dosir__label', tx(f.label));
    const dd = h('dd', 'dosir__value');
    const val = h('span', 'dosir__v', valueText(f));
    dd.append(val, statusLetter(f.status));
    const r = refs(f.src);
    if (r) dd.append(h('span', 'dosir__ref', ' ' + r));
    if (f.note) dd.append(h('div', 'note', tx(f.note)));
    for (const a of f.alt || []) {
      const alt = typeof a.v === 'number' ? fmt.num(a.v, decimals(a.v)) + unitSuffix(f.unit) : tx(a.v);
      dd.append(h('div', 'note', t('dosir.alt', 'Other figure: {v} {ref}', { v: alt, ref: refs(a.src) })));
    }
    row.dataset.fact = key;
    row.append(lab, dd);
    return row;
  }

  function sectionEl(id, title, lead) {
    const s = h('section', 'dosir__section');
    s.dataset.section = id;
    s.append(h('h3', 'card__title', title));
    if (lead) s.append(h('p', 'note', lead));
    return s;
  }

  function render() {
    if (!el) return;
    el.replaceChildren();
    if (failed) {
      el.append(h('p', 'note', t('dosir.failed', 'The dossier could not be loaded.')));
      return;
    }
    if (!facts) {
      el.append(h('p', 'note', t('dosir.loading', 'Loading the dossier…')));
      return;
    }
    srcIndex = new Map();
    const wrap = h('div', 'dosir');
    // layout only, our own classes (look is lane b02's)
    const style = h('style');
    style.textContent =
      '.dosir__fact{display:grid;grid-template-columns:42% 1fr;gap:4px 10px;padding:5px 0;border-top:1px solid var(--line,#e3e3e3)}' +
      '.dosir__fact dt{margin:0}.dosir__fact dd{margin:0}.dosir__ref{color:var(--muted,#777);font-size:11px}' +
      '.dosir__section{margin:0 0 18px}.dosir__list{margin:0;padding-left:18px}.dosir__list li{margin:0 0 5px}' +
      '.dosir__tl{display:grid;grid-template-columns:96px 1fr;gap:3px 10px;margin:0}' +
      '.dosir__legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin:0 0 12px}' +
      '.dosir__nav{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 14px}.dosir__nav .btn{font-size:12px;padding:2px 6px}';
    wrap.append(style);

    wrap.append(
      h('p', null, t('dosir.intro', 'What the research found about Perjaya Weir and its river. Each figure carries a letter for how we know it and the numbers of its sources (listed at the end).')),
    );
    const legend = h('div', 'dosir__legend note');
    for (const s of ['S', 'C', 'R', 'A', 'P']) {
      const item = h('span');
      item.append(statusLetter(s), document.createTextNode(' ' + t('dosir.status_' + s, STATUS_EN[s])));
      legend.append(item);
    }
    wrap.append(legend);
    const all0 = facts.facts || {};
    const secs = (facts.meta?.sections || Object.keys(SECTION_TITLES)).filter((sec) => Object.values(all0).some((f) => f.section === sec));
    const nav = h('nav', 'dosir__nav chips');
    nav.setAttribute('aria-label', t('dosir.contents', 'Contents'));
    const links = [
      ...secs.map((sec) => [sec, t(...(SECTION_TITLES[sec] || ['dosir.sec_' + sec, sec]))]),
      ['timeline', t('dosir.sec_timeline', 'Timeline')],
      ['standins', t('dosir.sec_standins', 'What stands in for a survey')],
      ['sources', t('dosir.sec_sources', 'Sources')],
      ['credits', t('dosir.sec_credits', 'Data credits')],
    ];
    for (const [id, label] of links) {
      const b = h('button', 'btn btn--quiet', label);
      b.type = 'button';
      b.addEventListener('click', () => el.querySelector(`[data-section="${id}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
      nav.append(b);
    }
    wrap.append(nav);

    const all = facts.facts || {};
    const order = facts.meta?.sections || Object.keys(SECTION_TITLES);
    for (const sec of order) {
      const keys = Object.keys(all).filter((k) => all[k].section === sec);
      if (!keys.length) continue;
      const [tk, te] = SECTION_TITLES[sec] || ['dosir.sec_' + sec, sec];
      const [lk, le] = SECTION_LEADS[sec] || [null, null];
      const s = sectionEl(sec, t(tk, te), lk ? t(lk, le) : null);
      const dl = h('dl', null);
      dl.style.margin = '0';
      for (const k of keys) dl.append(factRow(k, all[k]));
      s.append(dl);
      wrap.append(s);
    }

    if (facts.timeline?.length) {
      const s = sectionEl('timeline', t('dosir.sec_timeline', 'Timeline'), null);
      const dl = h('dl', 'dosir__tl');
      for (const ev of facts.timeline) {
        dl.append(h('dt', 'label', ev.date_label ? tx(ev.date_label) : monthYear(ev.date)));
        const dd = h('dd', null, tx(ev));
        dd.style.margin = '0';
        if (ev.status) dd.append(statusLetter(ev.status));
        const r = refs(ev.src);
        if (r) dd.append(h('span', 'dosir__ref', ' ' + r));
        dl.append(dd);
      }
      s.append(dl);
      wrap.append(s);
    }

    if (facts.standins?.length) {
      const s = sectionEl('standins', t('dosir.sec_standins', 'What stands in for a survey'),
        t('dosir.lead_standins', 'This is a model. These are the places where it uses something other than a survey or a gauge.'));
      const ul = h('ul', 'dosir__list');
      for (const x of facts.standins) ul.append(h('li', null, tx(x)));
      s.append(ul);
      wrap.append(s);
    }

    const s = sectionEl('sources', t('dosir.sec_sources', 'Sources'), null);
    const ol = h('ol', 'dosir__list');
    for (const [k] of [...srcIndex.entries()].sort((a, b) => a[1] - b[1])) {
      const src = facts.sources[k];
      const li = h('li', null);
      const title = (lang() === 'id' && src.title_id) || src.title;
      const bits = [title, src.publisher, src.year].filter((x) => x != null && x !== '');
      li.append(document.createTextNode(bits.join(', ')));
      if (src.access) li.append(h('span', 'note', ' (' + t('dosir.snippet_only', 'seen as a search snippet only') + ')'));
      if (src.url && /^https?:\/\//.test(src.url)) {
        const a = h('a', null, ' ' + t('dosir.link', 'link'));
        a.href = src.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        li.append(a);
      }
      ol.append(li);
    }
    s.append(ol);
    wrap.append(s);

    if (credits?.length) {
      const c = sectionEl('credits', t('dosir.sec_credits', 'Data credits'), null);
      const ul = h('ul', 'dosir__list');
      for (const cr of credits) ul.append(h('li', null, cr.full + (cr.licence ? ' (' + cr.licence + ')' : '')));
      c.append(ul);
      wrap.append(c);
    }
    wrap.append(h('p', 'note', t('app.model_note', 'Indicative model, not a survey')));
    el.append(wrap);
  }

  ctx.panel.addTab({
    id: 'dosir',
    order: 90,
    label: ['dosir.tab', 'Dossier'],
    modes: ['weir', 'maker'],
    mount(node) {
      el = node;
      render();
    },
    onShow: render,
  });

  ctx.data
    .json('facts.json')
    .then((f) => (facts = f))
    .catch(() => (failed = true))
    .finally(render);
  ctx.data
    .json('credits.json')
    .then((c) => (credits = c))
    .catch(() => {})
    .finally(render);
  store.on('lang', render);
}
