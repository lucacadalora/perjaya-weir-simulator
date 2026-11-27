// Film tab: camera views, tours, length, size, record, progress, download, still picture, copy link. Owner: lane b10.
// Talks only through ctx.camera, ctx.film, ctx.share and the store (CONTRACT 4.1); each may be missing.

const LENGTHS = [
  { id: 'short', f: 0.6, label: ['film.len_short', 'Short'] },
  { id: 'normal', f: 1, label: ['film.len_normal', 'Normal'] },
  { id: 'slow', f: 1.6, label: ['film.len_slow', 'Slow'] },
];
const SIZE_IDS = ['720', '1080', 'vertical', 'square'];
const SIZE_LABELS = {
  '720': ['film.chip_720', '720p'],
  '1080': ['film.chip_1080', '1080p'],
  vertical: ['film.chip_vertical', 'Phone 9:16'],
  square: ['film.chip_square', '1:1'],
};
// Short chip words for the tours (the long names are the camera's labels).
const TOUR_CHIPS = { orbit: ['film.chip_orbit', 'Orbit'], 'orbit-close': ['film.chip_orbit_close', 'Close orbit'], gates: ['film.chip_gates', 'Gates'], river: ['film.chip_river', 'Down the river'], floodplain: ['film.chip_floodplain', 'Flood plain'] };
const TOUR_FALLBACK = [
  { id: 'orbit', label: ['camera.tour_orbit', 'Orbit of the weir'], seconds: 16 },
  { id: 'river', label: ['camera.tour_river', 'Down the river from Danau Ranau'], seconds: 24 },
  { id: 'floodplain', label: ['camera.tour_floodplain', 'Rise over the flood plain'], seconds: 14 },
];

export async function init(ctx) {
  if (!ctx.panel) return;
  const { store, t, fmt } = ctx;
  const pick = { tour: 'orbit', len: 'normal', size: '720' };
  if (!document.getElementById('film-tab-layout')) {
    // Layout only (lane b02 owns the look): rows, the view grid and the progress bar of this tab.
    const st = document.createElement('style');
    st.id = 'film-tab-layout';
    st.textContent = '.film-views{display:grid;grid-template-columns:1fr 1fr;gap:4px 8px}.film-views .btn{justify-content:flex-start;text-align:left;white-space:normal;min-width:0;height:auto;min-height:32px}'
      + '#tabpanel-film .chips button{white-space:nowrap}'
      + '.film-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.film-len{margin-left:auto}'
      + '.film-bar{height:6px;border:1px solid var(--line,#d9dcdf);border-radius:4px;overflow:hidden;margin-top:10px}'
      + '.film-bar>i{display:block;height:100%;width:0;background:var(--accent,#1f6fb2)}#tabpanel-film .card{margin-bottom:12px}'
      + '#tabpanel-film .field{margin-bottom:10px}';
    document.head.append(st);
  }

  let offFilm = null;
  ctx.panel.addTab({
    id: 'film',
    order: 80,
    label: ['film.tab', 'Film'],
    modes: ['weir', 'maker'],
    mount(el) {
      build(el);
      let lang = store.get('lang');
      store.on('lang', (l) => { if (l !== lang) { lang = l; build(el); } });
    },
  });

  function build(el) {
      offFilm?.();
      el.replaceChildren();
      const h = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
      };
      const chips = (items, key, onPick) => {
        const row = h('div', 'chips');
        row.setAttribute('role', 'group');
        for (const it of items) {
          const b = h('button', null, t(it.label[0], it.label[1]));
          b.type = 'button';
          b.dataset.id = it.id;
          b.setAttribute('aria-pressed', String(pick[key] === it.id));
          b.addEventListener('click', () => {
            pick[key] = it.id;
            for (const x of row.children) x.setAttribute('aria-pressed', String(x.dataset.id === it.id));
            onPick?.(it.id);
          });
          row.append(b);
        }
        return row;
      };
      const field = (labelKey, labelEn, control) => {
        const f = h('div', 'field');
        f.append(h('span', 'label', t(labelKey, labelEn)), control);
        return f;
      };

      // ---- views ----
      const cardViews = h('section', 'card');
      cardViews.append(h('h3', 'card__title', t('film.views_title', 'Views')));
      const viewRow = h('div', 'film-views');
      const views = ctx.camera?.views ? Object.values(ctx.camera.views) : [];
      for (const v of views) {
        const b = h('button', 'btn btn--quiet', t(v.label[0], v.label[1]));
        b.type = 'button';
        b.addEventListener('click', () => ctx.camera?.goto(v.id));
        viewRow.append(b);
      }
      if (!views.length) viewRow.append(h('p', 'note', t('film.no_camera', 'The camera views appear when the map has loaded.')));
      cardViews.append(viewRow);

      // ---- film ----
      const cardFilm = h('section', 'card');
      cardFilm.append(h('h3', 'card__title', t('film.film_title', 'Aerial film')));
      const tours = ctx.camera?.tours ? Object.values(ctx.camera.tours) : TOUR_FALLBACK;
      const lenNote = h('span', 'film-len mono');
      const secondsFor = () => {
        const tour = tours.find((x) => x.id === pick.tour) || tours[0];
        const f = LENGTHS.find((x) => x.id === pick.len)?.f || 1;
        return Math.round((tour?.seconds || 12) * f);
      };
      const tourName = h('p', 'note');
      const showLen = () => {
        lenNote.textContent = t('film.seconds', '{n} s', { n: fmt.num(secondsFor(), 0) });
        const tour = tours.find((x) => x.id === pick.tour);
        tourName.textContent = tour ? t(tour.label[0], tour.label[1]) : '';
      };
      cardFilm.append(
        field('film.tour', 'Camera move', chips(tours.map((x) => ({ id: x.id, label: TOUR_CHIPS[x.id] || x.label })), 'tour', showLen)),
        tourName,
        field('film.length', 'Length', (() => { const w = h('div', 'film-row'); w.append(chips(LENGTHS, 'len', showLen), lenNote); return w; })()),
        field('film.size', 'Size', chips(SIZE_IDS.map((id) => ({ id, label: SIZE_LABELS[id] })), 'size')),
      );
      showLen();

      const actions = h('div', 'film-row');
      const rec = h('button', 'btn btn--primary', t('film.record', 'Record film'));
      rec.type = 'button';
      const stopBtn = h('button', 'btn', t('film.stop', 'Stop'));
      stopBtn.type = 'button';
      stopBtn.hidden = true;
      actions.append(rec, stopBtn);
      const bar = h('div', 'film-bar');
      const fill = h('i');
      bar.append(fill);
      bar.hidden = true;
      const line = h('p', 'note film-line');
      const dl = h('button', 'btn', t('film.download', 'Download film'));
      dl.type = 'button';
      dl.hidden = true;
      const stillHere = h('button', 'btn', t('film.still', 'Save picture'));
      stillHere.type = 'button';
      stillHere.hidden = true;
      stillHere.addEventListener('click', () => stillBtn.click());
      cardFilm.append(actions, bar, line, stillHere, dl,
        h('p', 'note', t('film.slow_note', 'On a slow computer recording takes longer than the film; the film itself plays at true speed. The title card and the credits are burnt into every frame.')));

      // ---- still and link ----
      const cardMore = h('section', 'card');
      cardMore.append(h('h3', 'card__title', t('film.more_title', 'Picture and link')));
      const row2 = h('div', 'film-row');
      const stillBtn = h('button', 'btn', t('film.still', 'Save picture'));
      stillBtn.type = 'button';
      const linkBtn = h('button', 'btn', t('film.copy_link', 'Copy link'));
      linkBtn.type = 'button';
      row2.append(stillBtn, linkBtn);
      cardMore.append(row2, h('p', 'note', t('film.link_note', 'The link keeps the mode, the camera, the scenario, the gate settings and your dams.')));

      el.append(cardViews, cardFilm, cardMore);

      rec.addEventListener('click', async () => {
        if (!ctx.film) { store.emit('toast', { text: t('film.not_ready', 'The film recorder is not ready yet.'), kind: 'warn' }); return; }
        const r = await ctx.film.start({ tour: pick.tour, seconds: secondsFor(), size: pick.size });
        if (r) ctx.film.download(r);
      });
      stopBtn.addEventListener('click', () => ctx.film?.stop());
      dl.addEventListener('click', () => ctx.film?.download());
      stillBtn.addEventListener('click', async () => {
        const r = await ctx.film?.still();
        if (r) ctx.film.download(r);
        else store.emit('toast', { text: t('film.still_failed', 'The picture could not be made.'), kind: 'warn' });
      });
      linkBtn.addEventListener('click', async () => {
        const url = ctx.share?.link?.() || location.href;
        try {
          await navigator.clipboard.writeText(url);
          store.emit('toast', { text: t('film.link_copied', 'Link copied.') });
        } catch {
          window.prompt(t('film.link_prompt', 'Copy this link:'), url);
        }
      });

      const render = (f) => {
        f = f || {};
        const busy = f.state === 'recording' || f.state === 'encoding';
        rec.disabled = busy;
        stopBtn.hidden = f.state !== 'recording';
        bar.hidden = !busy;
        fill.style.width = Math.round((f.progress || 0) * 100) + '%';
        dl.hidden = !(f.state === 'done' && ctx.film?.result);
        if (f.state === 'recording') line.textContent = t('film.recording', 'Recording frame by frame: {p}', { p: fmt.pct(f.progress || 0) });
        else if (f.state === 'encoding') line.textContent = t('film.encoding', 'Finishing the file');
        else if (f.state === 'done') line.textContent = t('film.done', 'Ready: {kind}, {mb} MB', { kind: String(f.kind || 'mp4').toUpperCase(), mb: fmt.num((f.bytes || 0) / 1e6, 1) });
        else if (f.state === 'error') line.textContent = f.error || t('film.err_record', 'The film could not be recorded in this browser. A still picture still works.');
        else line.textContent = '';
        stillHere.hidden = f.state !== 'error';
      };
      offFilm = store.on('film', render, { immediate: true });
  }
}
