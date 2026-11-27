// Layers menu. Owner: lane b05. In #maptools: one button that opens a small card with the base chips
// (Campuran / Topo / Satelit) and a checkbox per view.layers flag. It is the only writer of the store key `view`.
// Started by map/basemap.js (it is not in the MODULES list).

const LAYERS = [
  ['labels', 'Names'],
  ['roads', 'Roads and rail'],
  ['canals', 'Canals'],
  ['contours', 'Contours'],
  ['buildings', 'Buildings'],
  ['admin', 'Admin borders'],
  ['catchment', 'Catchment'],
  ['gauge', 'Gauges'],
];
const BASES = [
  ['blend', 'Blend'],
  ['topo', 'Topo'],
  ['sat', 'Satellite'],
];
const ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 3 2 8l10 5 10-5-10-5Z"/><path d="m2 13 10 5 10-5"/><path d="m2 17.5 10 5 10-5" opacity=".55"/></svg>';

let started = false;

export async function init(ctx) {
  const tools = document.getElementById('maptools');
  if (!tools || !ctx.store || started) return;
  started = true;
  const store = ctx.store;
  const t = ctx.t;

  // CONTRACT A4: building footprints are on by default (they only draw from zoom 14).
  if (store.get('view.layers.buildings') === false && !ctx.query?.has('nobuildings')) store.set('view.layers.buildings', true);

  const wrap = document.createElement('div');
  wrap.className = 'b05-layers';
  wrap.style.cssText = 'position:relative';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--icon';
  btn.innerHTML = ICON;
  btn.setAttribute('aria-expanded', 'false');
  const card = document.createElement('div');
  card.className = 'card b05-layers__card';
  card.hidden = true;
  card.style.cssText = 'position:absolute;left:calc(100% + 8px);bottom:0;width:220px;padding:10px 12px;z-index:3';
  wrap.append(btn, card);
  tools.prepend(wrap);

  const baseLabel = document.createElement('div');
  baseLabel.className = 'label';
  const chips = document.createElement('div');
  chips.className = 'chips';
  chips.style.margin = '4px 0 10px';
  const baseBtns = BASES.map(([id]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.base = id;
    b.addEventListener('click', () => store.set('view.base', id));
    chips.append(b);
    return b;
  });
  const layLabel = document.createElement('div');
  layLabel.className = 'label';
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-top:4px';
  let contourNote = null;
  const boxes = LAYERS.map(([key]) => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.layer = key;
    cb.addEventListener('change', () => store.set('view.layers.' + key, cb.checked));
    const span = document.createElement('span');
    row.append(cb, span);
    list.append(row);
    if (key === 'contours') {
      // honesty: contours of a 30 m surface model (tree tops and roofs), not surveyed ground
      contourNote = document.createElement('div');
      contourNote.className = 'note';
      contourNote.style.cssText = 'margin:-2px 0 2px 26px;font-size:11px;line-height:1.3';
      list.append(contourNote);
    }
    return { key, cb, span };
  });
  card.append(baseLabel, chips, layLabel, list);

  function text() {
    btn.title = t('layers.button', 'Map layers');
    btn.setAttribute('aria-label', btn.title);
    baseLabel.textContent = t('layers.base', 'Base map');
    layLabel.textContent = t('layers.layers', 'Layers');
    BASES.forEach(([id, en], i) => (baseBtns[i].textContent = t('layers.base_' + id, en)));
    boxes.forEach(({ key, span }) => (span.textContent = t('layers.' + key, LAYERS.find((l) => l[0] === key)[1])));
    if (contourNote) contourNote.textContent = t('layers.contours_note', 'Contours from a 30 m surface model, not a survey');
  }
  function sync() {
    const v = store.get('view') || {};
    baseBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.base === (v.base || 'blend'))));
    boxes.forEach(({ key, cb }) => (cb.checked = (v.layers || {})[key] !== false));
  }
  const open = (on) => {
    card.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
  };
  btn.addEventListener('click', () => open(card.hidden));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && open(false));
  document.addEventListener('pointerdown', (e) => !wrap.contains(e.target) && open(false));
  if (ctx.query?.get('layers') === 'open') open(true);

  text();
  sync();
  store.on('view', sync);
  store.on('lang', text);
}
