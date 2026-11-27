// Top bar in #topbar. Owner: lane b01. CONTRACT 4.4 (`lang`, `mode`) and 5.
// Title block (app.title, app.subtitle), the mode switch, a slot for the place search, the language switch.
// The search lane (b21) mounts into `#topbar-search` (ctx.toolbar.searchSlot); `ctx.toolbar.slot(name)` returns
// an empty element for any other lane that needs room in the bar.
// ?mode=maker starts in maker mode.

export async function init(ctx) {
  const root = document.getElementById('topbar');
  if (!root) return;
  const { store, t } = ctx;

  const qm = ctx.query?.get?.('mode');
  if (qm === 'weir' || qm === 'maker') store.set('mode', qm);

  root.replaceChildren();

  // Title block
  const title = document.createElement('div');
  title.className = 'topbar__title card';
  const h = document.createElement('h1');
  h.className = 'topbar__name';
  const sub = document.createElement('div');
  sub.className = 'topbar__sub label';
  title.append(h, sub);

  // Mode switch
  const modes = chips('toolbar.mode', 'Mode', [
    { v: 'weir', key: 'toolbar.mode_weir', en: 'Perjaya Weir' },
    { v: 'maker', key: 'toolbar.mode_maker', en: 'Build a dam' },
  ]);
  modes.el.classList.add('topbar__modes');
  modes.el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) store.set('mode', b.dataset.v);
  });

  // Search slot (lane b21)
  const search = document.createElement('div');
  search.className = 'topbar__search';
  search.id = 'topbar-search';

  const spacer = document.createElement('div');
  spacer.className = 'topbar__spacer';
  spacer.style.flex = '1 1 auto';

  // Language switch: the short codes are the same in both languages.
  const langs = chips('toolbar.lang', 'Language', [
    { v: 'id', key: 'toolbar.lang_id', en: 'ID', title: ['toolbar.lang_id_title', 'Bahasa Indonesia'] },
    { v: 'en', key: 'toolbar.lang_en', en: 'EN', title: ['toolbar.lang_en_title', 'English'] },
  ]);
  langs.el.classList.add('topbar__lang');
  langs.el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) store.set('lang', b.dataset.v);
  });

  root.append(title, modes.el, search, spacer, langs.el);

  function chips(key, en, items) {
    const el = document.createElement('div');
    el.className = 'chips';
    el.setAttribute('role', 'group');
    const buttons = items.map((it) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.v = it.v;
      b.dataset.key = it.key;
      b.dataset.en = it.en;
      if (it.title) {
        b.dataset.titleKey = it.title[0];
        b.dataset.titleEn = it.title[1];
      }
      el.append(b);
      return b;
    });
    return {
      el,
      relabel() {
        el.setAttribute('aria-label', t(key, en));
        for (const b of buttons) {
          b.textContent = t(b.dataset.key, b.dataset.en);
          if (b.dataset.titleKey) b.title = t(b.dataset.titleKey, b.dataset.titleEn);
        }
      },
      press(v) {
        for (const b of buttons) b.setAttribute('aria-pressed', b.dataset.v === v ? 'true' : 'false');
      },
    };
  }

  function relabel() {
    h.textContent = t('app.title', 'Perjaya Weir Simulator');
    sub.textContent = t('app.subtitle', 'Komering River · OKU Timur · South Sumatra');
    modes.relabel();
    langs.relabel();
    document.title = t('app.title', 'Perjaya Weir Simulator');
  }

  store.on('lang', (l) => {
    langs.press(l);
    relabel();
  }, { immediate: true });
  store.on('mode', (m) => {
    modes.press(m);
    document.documentElement.dataset.mode = m;
  }, { immediate: true });

  ctx.toolbar = {
    el: root,
    searchSlot: search,
    slot(name) {
      let s = root.querySelector('[data-slot="' + name + '"]');
      if (!s) {
        s = document.createElement('div');
        s.dataset.slot = name;
        s.className = 'topbar__slot';
        root.insertBefore(s, langs.el);
      }
      return s;
    },
  };

  // The bar wraps on narrow screens; publish its height as --topbar-h on .app so the look lane can place the
  // status card under it (layout aid only, no style).
  const app = document.getElementById('app') || document.documentElement;
  const publish = () => app.style.setProperty('--topbar-h', Math.ceil(root.getBoundingClientRect().height) + 'px');
  if (typeof ResizeObserver === 'function') new ResizeObserver(publish).observe(root);
  publish();
}
