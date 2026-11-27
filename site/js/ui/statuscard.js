// Status card in #status. Owner: lane b01. CONTRACT 4.4; reference anatomy section 4 (what a status card reads).
// Reads only; writes `clock.running` and `clock.speed` (days of simulated time per real second).
// Weir mode: river flow at the weir as the big number, pond level, gates open, canal flow, flow downstream, the
// operating mode and alerts as plain sentences. Maker mode: the active dam, percent full as the big number, volume,
// level, inflow, outflow and status, with a fill bar. The model note under it. Space toggles run (outside inputs).
// Every missing value shows "–" (ctx.fmt).

// Speed chips: simulated days per real second. Pure unit conversions, not researched values.
const DAY = 1;
const SPEEDS = [
  { key: 'status.speed_hour_short', en: 'hour', title: ['status.speed_hour', '1 hour/s'], v: DAY / 24 },
  { key: 'status.speed_day_short', en: 'day', title: ['status.speed_day', '1 day/s'], v: DAY },
  { key: 'status.speed_week_short', en: 'week', title: ['status.speed_week', '1 week/s'], v: 7 * DAY },
  { key: 'status.speed_month_short', en: 'month', title: ['status.speed_month', '1 month/s'], v: 365.25 / 12 },
  { key: 'status.speed_year_short', en: 'year', title: ['status.speed_year', '1 year/s'], v: 365.25 },
];

// Every code the weir engine returns (lane b14 STATUS) has one plain sentence; older codes kept for safety.
const ALERTS = {
  pond_high: 'The pond is above its normal level.',
  overtop: 'Water is flowing over the gates.',
  intake_short: 'The canal is getting less water than it needs.',
  intake_over_design: 'The canal takes more than its design capacity.',
  gates_full: 'Every gate is fully open.',
  river_dry_below: 'The river below the weir gets less than its maintenance flow.',
  freeboard_low: 'The pond is close to the top of the gates.',
  pond_low: 'The pond is below the level the canal needs.',
  intake_closed: 'The canal intake is closed.',
};
const DANGER = new Set(['overtop', 'river_dry_below']);

const MODES = {
  auto: 'Automatic',
  manual: 'Manual',
  flush: 'Flushing',
  flood: 'Flood operation',
  closed: 'Closed',
};

const DAM_STATUS = {
  computing: 'Working out the lake',
  filling: 'Filling',
  full: 'Full',
  spilling: 'Full and spilling',
  empty: 'Empty',
};

export async function init(ctx) {
  const root = document.getElementById('status');
  if (!root) return;
  const { store, t, fmt } = ctx;
  const icons = await import('./icons.js').catch(() => null);
  const icon = (name, alt) => {
    try {
      const s = icons?.icon?.(name);
      if (s) return s;
    } catch {}
    return alt;
  };

  root.replaceChildren();
  root.innerHTML = `
    <div class="statuscard__controls">
      <button type="button" class="btn btn--icon statuscard__play"></button>
      <span class="label statuscard__per"></span>
      <div class="chips statuscard__speed" role="group"></div>
    </div>
    <div class="statuscard__date label"></div>
    <div class="statuscard__head">
      <div class="statuscard__name card__title"></div>
      <div class="statuscard__big"><span class="value"></span><span class="unit"></span></div>
      <div class="statuscard__biglabel label"></div>
    </div>
    <button type="button" class="btn btn--quiet statuscard__more" aria-expanded="false"></button>
    <div class="statuscard__fill" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></div>
    <dl class="kv statuscard__kv"></dl>
    <div class="statuscard__alerts"></div>
    <p class="note statuscard__note"></p>`;
  const $ = (s) => root.querySelector(s);
  const play = $('.statuscard__play');
  const speed = $('.statuscard__speed');
  const per = $('.statuscard__per');
  const date = $('.statuscard__date');
  const name = $('.statuscard__name');
  const bigV = $('.statuscard__big .value');
  const bigU = $('.statuscard__big .unit');
  const bigL = $('.statuscard__biglabel');
  const fill = $('.statuscard__fill');
  const fillBar = $('.statuscard__fill i');
  const kv = $('.statuscard__kv');
  const alerts = $('.statuscard__alerts');
  const note = $('.statuscard__note');
  if (bigV) bigV.style.fontVariantNumeric = 'tabular-nums';
  // Layout only (the look is lane b02's): one row of play, "per second" and the speed chips.
  Object.assign($('.statuscard__controls').style, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });

  // Narrow screens: the card starts compact (head, fill, alerts, note); "Details" opens the list.
  const more = $('.statuscard__more');
  const narrow = typeof matchMedia === 'function' ? matchMedia('(max-width: 600px)') : null;
  let expanded = false;
  function compact() {
    const c = !!narrow?.matches && !expanded;
    root.dataset.compact = c ? '1' : '0';
    kv.hidden = c;
    more.hidden = !narrow?.matches;
    more.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    more.textContent = expanded ? t('status.less', 'Hide details') : t('status.more', 'Details');
  }
  more.addEventListener('click', () => {
    expanded = !expanded;
    compact();
  });
  narrow?.addEventListener?.('change', compact);

  const speedBtns = SPEEDS.map((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.i = String(i);
    speed.append(b);
    return b;
  });
  speed.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    store.set('clock.speed', SPEEDS[Number(b.dataset.i)].v);
  });

  const toggle = () => store.set('clock.running', !store.get('clock.running'));
  play.addEventListener('click', toggle);
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(a.tagName))) return;
    e.preventDefault();
    toggle();
  });

  // Splits "123 m³/s" into value and unit for the big number.
  const split = (s) => {
    const m = /^(.*?)\s([^\d\s–].*)$/.exec(s);
    return m ? [m[1], m[2]] : [s, ''];
  };

  function row(label, value) {
    const dt = document.createElement('dt');
    dt.className = 'label';
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dd.style.fontVariantNumeric = 'tabular-nums';
    return [dt, dd];
  }

  function alertText(a) {
    const code = a && typeof a === 'object' ? a.code : a;
    if (code == null) return null;
    const en = ALERTS[code];
    return { text: en ? t('alert.' + code, en) : t('alert.generic', 'The weir model raised a warning.'), level: a?.level || (DANGER.has(code) ? 'danger' : 'warn') };
  }

  function renderClock() {
    const c = store.get('clock') || {};
    play.innerHTML = c.running ? icon('pause', '❚❚') : icon('play', '▶');
    const lbl = c.running ? t('status.pause', 'Pause') : t('status.play', 'Run');
    play.title = lbl + ' · ' + t('status.space_hint', 'Space bar');
    play.setAttribute('aria-label', lbl);
    play.setAttribute('aria-pressed', c.running ? 'true' : 'false');
    let best = -1;
    let bd = Infinity;
    SPEEDS.forEach((s, i) => {
      const d = Math.abs(Math.log((c.speed || 1) / s.v));
      if (d < bd) (bd = d), (best = i);
    });
    speedBtns.forEach((b, i) => {
      b.textContent = t(SPEEDS[i].key, SPEEDS[i].en);
      b.title = t(SPEEDS[i].title[0], SPEEDS[i].title[1]);
      b.setAttribute('aria-pressed', i === best && bd < 0.05 ? 'true' : 'false');
    });
    speed.setAttribute('aria-label', t('status.speed', 'Simulation speed'));
    per.textContent = t('status.per_second', 'Per second');
    date.textContent = fmt.date(c.date);
  }

  function renderWeir() {
    const w = store.get('weir') || {};
    const f = store.get('flow') || {};
    name.textContent = t('status.weir_name', 'Perjaya Weir');
    const [v, u] = split(fmt.q(f.q_in));
    bigV.textContent = v;
    bigU.textContent = u;
    bigL.textContent = t('status.q_in', 'River flow at the weir (modelled)');
    fill.hidden = true;
    const gates = Array.isArray(w.gates_used) ? w.gates_used : Array.isArray(w.gates) ? w.gates : [];
    const open = gates.filter((g) => Number(g) > 0.01);
    const mean = open.length ? open.reduce((a, b) => a + Number(b), 0) / open.length : null;
    const gatesText = !gates.length
      ? '–'
      : open.length
        ? t('status.gates_open_n', '{n} of {all} · {m} m open on average', { n: open.length, all: gates.length, m: fmt.num(mean, 2) })
        : t('status.gates_all_closed', 'all {all} closed', { all: gates.length });
    kv.replaceChildren(
      ...row(t('status.pond', 'Pond level'), fmt.el(w.pond_el)),
      ...row(t('status.gates', 'Gates open'), gatesText),
      ...row(t('status.q_intake', 'To the canal'), fmt.q(w.q_intake)),
      ...row(t('status.q_down', 'Downstream'), fmt.q(w.q_down)),
      ...row(t('status.mode', 'Operation'), w.mode ? t('operasi.mode_' + w.mode, MODES[w.mode] || w.mode) : '–'),
    );
    const list = (Array.isArray(w.alerts) ? w.alerts : []).map(alertText).filter(Boolean);
    alerts.replaceChildren(
      ...list.map((a) => {
        const p = document.createElement('p');
        p.className = 'alert alert--' + (a.level === 'danger' ? 'danger' : 'warn');
        p.setAttribute('role', 'alert');
        p.textContent = a.text;
        return p;
      }),
    );
  }

  // Maker levels are model-terrain metres (CONTRACT 4.4, A7 L14): say so when maker.level_datum is 'model'.
  function levelText(v, datum) {
    if (datum !== 'model') return fmt.el(v);
    return v == null || Number.isNaN(Number(v)) ? '–' : fmt.num(v, 1) + ' ' + t('status.m_model', 'm (model terrain)');
  }

  function renderMaker() {
    const m = store.get('maker') || {};
    const dam = (m.dams || []).find((d) => d && d.id === m.active) || null;
    alerts.replaceChildren();
    if (!dam) {
      name.textContent = t('status.maker_none', 'No dam yet');
      bigV.textContent = '–';
      bigU.textContent = '';
      bigL.textContent = m.placing ? t('status.maker_placing', 'Click a river on the map to place the dam') : t('status.maker_hint', 'Open “Build” and place a dam on a river');
      fill.hidden = true;
      kv.replaceChildren();
      return;
    }
    name.textContent = dam.name || t('status.maker_dam', 'Your dam');
    const pct = dam.fill == null ? null : dam.fill * 100;
    bigV.textContent = fmt.num(pct, 1);
    bigU.textContent = pct == null ? '' : '%';
    bigL.textContent = t('status.fill', 'Percent full');
    fill.hidden = false;
    const w = Math.max(0, Math.min(100, pct ?? 0));
    fillBar.style.width = w + '%';
    fill.setAttribute('aria-valuenow', String(Math.round(w)));
    const out = dam.release_m3s == null && dam.spill_m3s == null ? null : (Number(dam.release_m3s) || 0) + (Number(dam.spill_m3s) || 0);
    kv.replaceChildren(
      ...row(t('status.volume', 'Volume'), fmt.vol(dam.volume_m3) + (dam.fsl_volume_m3 != null ? ' / ' + fmt.vol(dam.fsl_volume_m3) : '')),
      ...row(t('status.level', 'Water level'), levelText(dam.level_el, m.level_datum)),
      ...row(t('status.inflow', 'Inflow'), fmt.q(dam.inflow_m3s)),
      ...row(t('status.outflow', 'Outflow'), fmt.q(out)),
      ...row(t('status.dam_status', 'Status'), dam.status ? t('status.dam_' + dam.status, DAM_STATUS[dam.status] || dam.status) : '–'),
    );
  }

  function render() {
    queued = false;
    try {
      renderClock();
      if ((store.get('mode') || 'weir') === 'maker') renderMaker();
      else renderWeir();
      note.textContent = t('app.model_note', 'Indicative model, not a survey');
      compact();
      root.dataset.mode = store.get('mode') || 'weir';
    } catch (e) {
      console.error('[statuscard] render failed', e);
    }
  }
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(render);
  };
  for (const k of ['clock', 'flow', 'weir', 'maker', 'mode', 'lang']) store.on(k, schedule);
  render();

  ctx.statuscard = { el: root, render };
}
