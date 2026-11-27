// Right panel with a tab bar. Owner: lane b01. CONTRACT 4.2 and 5.
//   ctx.panel.addTab({ id, order, label, modes: ['weir','maker'], mount(el), onShow(el) }) -> { el, show(), remove() }
//     label: ['area.key', 'English fallback'] (a text key) or ['Indonesian text', 'English text'] or {id, en} or a key.
//     modes: the modes the tab belongs to (default both). mount(el) runs once, at once; onShow(el) each time it shows.
//   ctx.panel.show(id) · ctx.panel.tabs() -> [{id, order, modes}] · ctx.panel.el (the #panel element)
// Writes the store key `tab`. Remembers the tab per mode; a mode change shows that mode's last tab (or its first).
// A tab whose mount() throws shows one plain sentence in its own place; the other tabs keep working.

export async function init(ctx) {
  const root = document.getElementById('panel');
  if (!root) return;
  const { store, t } = ctx;

  root.replaceChildren();
  const bar = document.createElement('div');
  bar.className = 'tabbar';
  bar.setAttribute('role', 'tablist');
  const body = document.createElement('div');
  body.className = 'panel__body';
  const empty = document.createElement('p');
  empty.className = 'note panel__empty';
  root.append(bar, body, empty);

  const tabs = new Map(); // id -> {id, order, label, modes, btn, el, onShow, mounted}
  // The tab each mode wants: the user's last pick in that mode, else the starting `tab` (or ?tab=) until a tab of
  // that id arrives. Selecting a fallback tab during layout never overwrites the wish.
  const q = ctx.query?.get?.('tab');
  if (q) store.set('tab', q);
  const wish = { [store.get('mode') || 'weir']: store.get('tab') };
  // ?tab= is honoured when that tab arrives, in whichever mode it belongs to (?mode= is applied later by the
  // toolbar), until the user picks a tab.
  let requested = q || null;

  const isKey = (s) => typeof s === 'string' && /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/i.test(s) && !/\s/.test(s);
  function labelText(label, id) {
    if (Array.isArray(label)) {
      const [a, b] = label;
      if (isKey(a)) return t(a, b ?? a);
      return (store.get('lang') === 'en' ? b : a) ?? a ?? b ?? id;
    }
    if (label && typeof label === 'object') return (store.get('lang') === 'en' ? label.en : label.id) ?? label.en ?? id;
    if (isKey(label)) return t(label, id);
    return label ?? t('panel.tab_' + id, id);
  }

  const mode = () => store.get('mode') || 'weir';
  const inMode = (tab, m = mode()) => !tab.modes || tab.modes.includes(m);
  const visible = () => [...tabs.values()].filter((x) => inMode(x)).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));

  function relabel() {
    for (const x of tabs.values()) x.btn.textContent = labelText(x.label, x.id);
    empty.textContent = t('panel.empty', 'The panels for this mode are still being built.');
  }

  function layout() {
    // Order the buttons, hide the tabs of the other mode, pick the selected one.
    const vis = visible();
    for (const x of [...tabs.values()].sort((a, b) => a.order - b.order)) {
      bar.append(x.btn);
      x.btn.hidden = !inMode(x);
    }
    empty.hidden = vis.length > 0;
    if (requested && vis.some((x) => x.id === requested)) {
      wish[mode()] = requested;
      requested = null;
    }
    let want = wish[mode()];
    if (!vis.some((x) => x.id === want)) want = vis.some((x) => x.id === current) ? current : vis[0]?.id ?? null;
    select(want, false, false);
  }

  let current = null;
  let selecting = false; // true while select() writes `tab`, so our own write is not read back as a user pick
  function select(id, focus, byUser = true) {
    const tab = tabs.get(id);
    for (const x of tabs.values()) {
      const on = x === tab;
      x.btn.setAttribute('aria-selected', on ? 'true' : 'false');
      x.btn.tabIndex = on ? 0 : -1;
      x.el.hidden = !on;
    }
    if (!tab) return;
    if (byUser) {
      wish[mode()] = id;
      requested = null;
    }
    selecting = true;
    try {
      if (store.get('tab') !== id) store.set('tab', id);
    } finally {
      selecting = false;
    }
    if (focus) tab.btn.focus();
    if (current !== id) {
      current = id;
      try {
        tab.onShow?.(tab.el);
      } catch (e) {
        console.error('[panel] onShow failed: ' + id, e);
      }
    }
  }

  function addTab(spec) {
    if (!spec || !spec.id) throw new Error('panel.addTab needs an id');
    const id = String(spec.id);
    if (tabs.has(id)) tabs.get(id).remove();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab';
    btn.id = 'tab-' + id;
    btn.dataset.tab = id;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-controls', 'tabpanel-' + id);
    const el = document.createElement('section');
    el.className = 'tabpanel';
    el.id = 'tabpanel-' + id;
    el.dataset.tab = id;
    el.setAttribute('role', 'tabpanel');
    el.setAttribute('aria-labelledby', btn.id);
    el.hidden = true;
    body.append(el);
    const tab = {
      id,
      order: Number.isFinite(spec.order) ? spec.order : 100,
      label: spec.label,
      modes: Array.isArray(spec.modes) && spec.modes.length ? spec.modes : null,
      btn,
      el,
      onShow: spec.onShow,
      remove() {
        btn.remove();
        el.remove();
        tabs.delete(id);
        if (current === id) current = null;
        layout();
      },
    };
    tabs.set(id, tab);
    btn.addEventListener('click', () => select(id, false));
    btn.textContent = labelText(tab.label, id);
    try {
      spec.mount?.(el);
    } catch (e) {
      console.error('[panel] mount failed: ' + id, e);
      const p = document.createElement('p');
      p.className = 'note';
      p.textContent = t('panel.tab_failed', 'This part could not be shown. The rest of the simulator still works.');
      el.replaceChildren(p);
    }
    layout();
    return { el, show: () => select(id, false), remove: tab.remove };
  }

  // Arrow keys move along the tab bar (ARIA tabs pattern).
  bar.addEventListener('keydown', (e) => {
    const vis = visible();
    const i = vis.findIndex((x) => x.id === current);
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % vis.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + vis.length) % vis.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = vis.length - 1;
    if (j < 0 || !vis[j]) return;
    e.preventDefault();
    select(vis[j].id, true);
  });

  store.on('mode', layout);
  store.listen('app:ready', () => layout());
  store.on('tab', (id) => {
    if (selecting) return;
    if (id !== current && tabs.has(id) && inMode(tabs.get(id))) select(id, false);
  });
  store.on('lang', relabel);
  relabel();
  layout();

  ctx.panel = {
    el: root,
    addTab,
    show: (id) => select(id, false),
    tabs: () => [...tabs.values()].map(({ id, order, modes }) => ({ id, order, modes })),
  };
}
