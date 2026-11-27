// Search box in #topbar. Owner: lane b21. CONTRACT 4.2, 4.4 (`camera:goto`), 5.
// One box that finds presets, place names, lake names and river names, accent- and case-insensitive, by keyboard
// and pointer, then emits `camera:goto` with {lon, lat, zoom, pitch, bearing[, bbox]}.
// The presets load at once (small); the place and river files load on the first focus, so the first frame never
// waits for them. The index functions are pure and exported for node tests.

// FALLBACK until lane b18 writes site/data/presets.json (CONTRACT 4.9 shape).
export const FALLBACK_PRESETS = [
  { id: 'perjaya', kind: 'view', name: { id: 'Bendung Perjaya', en: 'Perjaya Weir' }, lon: 104.38101, lat: -4.30512, zoom: 15 },
  { id: 'ranau', kind: 'place', name: { id: 'Danau Ranau', en: 'Lake Ranau' }, lon: 103.92, lat: -4.86, zoom: 11 },
  { id: 'tiga-dihaji', kind: 'dam', name: { id: 'Bendungan Tiga Dihaji (rencana)', en: 'Tiga Dihaji Dam (planned)' }, lon: 103.87687, lat: -4.62893, zoom: 13, dam: {} },
  { id: 'muaradua', kind: 'place', name: { id: 'Muaradua', en: 'Muaradua' }, lon: 104.07, lat: -4.53, zoom: 13 },
  { id: 'martapura', kind: 'place', name: { id: 'Martapura', en: 'Martapura' }, lon: 104.36, lat: -4.32, zoom: 13 },
]; // FALLBACK

// Lower case, accents removed, punctuation to spaces.
export function norm(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// How a kind is ordered when two names match equally well (lower first). Layout choices, not research.
const KIND_ORDER = { dam: 0, view: 0, place: 1, lake: 2, city: 3, town: 3, river: 4, canal: 5, locality: 6, village: 7, neighborhood: 8, macrohood: 8, hamlet: 9, stream: 9, ditch: 10, drain: 11 };
const KIND_ZOOM = { city: 12, town: 12.5, locality: 13, village: 13.5, neighborhood: 14, macrohood: 13.5, hamlet: 14 };

function bboxOfCoords(coords, bb) {
  if (typeof coords[0] === 'number') {
    if (coords[0] < bb[0]) bb[0] = coords[0];
    if (coords[1] < bb[1]) bb[1] = coords[1];
    if (coords[0] > bb[2]) bb[2] = coords[0];
    if (coords[1] > bb[3]) bb[3] = coords[1];
    return bb;
  }
  for (const c of coords) bboxOfCoords(c, bb);
  return bb;
}

// The vertex nearest to a point, so a river's target is on the river and not in the middle of its bend.
function nearestVertex(coords, lon, lat, best) {
  if (typeof coords[0] === 'number') {
    const d = (coords[0] - lon) ** 2 + (coords[1] - lat) ** 2;
    if (d < best.d) Object.assign(best, { d, lon: coords[0], lat: coords[1] });
    return best;
  }
  for (const c of coords) nearestVertex(c, lon, lat, best);
  return best;
}

const zoomForSpan = (deg) => Math.max(8, Math.min(14, Math.log2(360 / Math.max(deg, 1e-4)) - 0.6));

// Build the search list. presets: CONTRACT 4.9 list; places, rivers, lakes: GeoJSON FeatureCollections or null.
export function buildIndex({ presets = [], places = null, rivers = null, lakes = null } = {}) {
  const items = [];
  for (const p of presets || []) {
    if (!p || !Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;
    const name = typeof p.name === 'string' ? { id: p.name, en: p.name } : p.name || {};
    items.push({
      key: 'preset:' + p.id, src: 'preset', kind: p.kind || 'place', name, preset: p,
      n: [norm(name.id), norm(name.en)], pop: 0,
      goto: { lon: p.lon, lat: p.lat, zoom: p.zoom ?? 13, pitch: p.pitch ?? 50, bearing: p.bearing ?? 0 },
    });
  }
  const seen = new Set(items.flatMap((i) => i.n));
  for (const f of places?.features || []) {
    const nm = f.properties?.name;
    const c = f.geometry?.coordinates;
    if (!nm || !c) continue;
    const kind = f.properties.kind || 'village';
    items.push({
      key: 'place:' + nm + ':' + c[0] + ',' + c[1], src: 'place', kind, name: { id: nm, en: nm },
      n: [norm(nm)], pop: f.properties.population || 0,
      goto: { lon: c[0], lat: c[1], zoom: KIND_ZOOM[kind] ?? 13.5, pitch: 45, bearing: 0 },
    });
  }
  // Rivers and lakes: one entry per name, framed on all its pieces.
  const groups = new Map();
  const addGroup = (fc, src, keep) => {
    for (const f of fc?.features || []) {
      const nm = f.properties?.name;
      if (!nm || !f.geometry || !keep(f.properties)) continue;
      const k = src + ':' + norm(nm);
      if (!groups.has(k)) groups.set(k, { src, name: nm, kind: f.properties.kind || src, geoms: [], best: 99 });
      const g = groups.get(k);
      g.geoms.push(f.geometry.coordinates);
      g.best = Math.min(g.best, KIND_ORDER[f.properties.kind] ?? 12);
      if ((KIND_ORDER[f.properties.kind] ?? 12) <= (KIND_ORDER[g.kind] ?? 12)) g.kind = f.properties.kind || src;
    }
  };
  addGroup(lakes, 'lake', (p) => p.kind === 'lake'); // ponds and fish farms carry owner names: left out
  addGroup(rivers, 'river', () => true);
  for (const [k, g] of groups) {
    if (seen.has(norm(g.name)) && g.src === 'lake') continue; // a preset already covers it
    const bb = bboxOfCoords(g.geoms, [Infinity, Infinity, -Infinity, -Infinity]);
    const cx = (bb[0] + bb[2]) / 2;
    const cy = (bb[1] + bb[3]) / 2;
    const at = nearestVertex(g.geoms, cx, cy, { d: Infinity, lon: cx, lat: cy });
    const kind = g.src === 'lake' ? 'lake' : g.kind;
    items.push({
      key: k, src: g.src, kind, name: { id: g.name, en: g.name }, n: [norm(g.name)], pop: 0,
      goto: { lon: at.lon, lat: at.lat, zoom: zoomForSpan(Math.max(bb[2] - bb[0], bb[3] - bb[1])), pitch: 40, bearing: 0, bbox: bb },
    });
  }
  // A hint for small places: the nearest town or city, so two villages of the same name can be told apart.
  const towns = items.filter((i) => i.src === 'place' && (i.kind === 'city' || i.kind === 'town'));
  for (const it of items) {
    if (it.src !== 'place' || it.kind === 'city' || it.kind === 'town' || !towns.length) continue;
    let best = null;
    let bd = Infinity;
    for (const tw of towns) {
      const d = (tw.goto.lon - it.goto.lon) ** 2 + (tw.goto.lat - it.goto.lat) ** 2;
      if (d < bd) (bd = d), (best = tw);
    }
    if (best && best.n[0] !== it.n[0]) it.near = best.name.id;
  }
  for (const it of items) it.c = it.n.map((x) => x.replace(/ /g, ''));
  return items;
}

// 3 = whole name, 2 = a word starts with the query, 1 = anywhere, 0 = no match.
function matchScore(it, q, qc) {
  let s = 0;
  it.n.forEach((n, i) => {
    if (!n) return;
    const c = it.c?.[i] ?? n.replace(/ /g, '');
    if (n === q || c === qc) s = 3;
    else if (n.startsWith(q) || n.includes(' ' + q) || c.startsWith(qc)) s = Math.max(s, 2);
    else if (n.includes(q) || c.includes(qc)) s = Math.max(s, 1);
  });
  return s;
}

export function search(items, query, limit = 8) {
  const q = norm(query);
  if (!q) return [];
  const qc = q.replace(/ /g, '');
  const hits = [];
  for (const it of items) {
    let s = matchScore(it, q, qc);
    if (s && it.src === 'preset') s += 1; // a preset that starts with the words beats a village of the same name
    if (s) hits.push({ it, s: Math.min(s, 3) + (it.src === 'preset' && s > 3 ? 0.5 : 0) });
  }
  hits.sort(
    (a, b) =>
      b.s - a.s ||
      (a.it.src === 'preset' ? 0 : 1) - (b.it.src === 'preset' ? 0 : 1) ||
      (KIND_ORDER[a.it.kind] ?? 12) - (KIND_ORDER[b.it.kind] ?? 12) ||
      b.it.pop - a.it.pop ||
      a.it.n[0].length - b.it.n[0].length,
  );
  // Same name and kind within about 2 km: keep the first only.
  // A place that a preset of the same name already covers (within about 6 km) is dropped too.
  const out = [];
  const near = (a, b, d) => Math.abs(a.goto.lon - b.goto.lon) + Math.abs(a.goto.lat - b.goto.lat) < d;
  for (const h of hits) {
    const dup = out.some(
      (o) => (o.n[0] === h.it.n[0] && o.kind === h.it.kind && near(o, h.it, 0.02)) || (o.src === 'preset' && h.it.src !== 'preset' &&
          ((o.n.includes(h.it.n[0]) && near(o, h.it, 0.06)) || (o.n.some((n) => n.endsWith(' ' + h.it.n[0])) && near(o, h.it, 0.005)))),
    );
    if (!dup) out.push(h.it);
    if (out.length >= limit) break;
  }
  return out;
}

// Kind names shown beside a hit.
const KIND_TEXT = {
  dam: ['search.kind_dam', 'dam'], view: ['search.kind_view', 'view'], place: ['search.kind_place', 'place'],
  lake: ['search.kind_lake', 'lake'], city: ['search.kind_city', 'city'], town: ['search.kind_town', 'town'],
  locality: ['search.kind_locality', 'locality'], village: ['search.kind_village', 'village'],
  neighborhood: ['search.kind_neighborhood', 'neighbourhood'], macrohood: ['search.kind_neighborhood', 'neighbourhood'],
  hamlet: ['search.kind_hamlet', 'hamlet'], river: ['search.kind_river', 'river'], canal: ['search.kind_canal', 'canal'],
  stream: ['search.kind_stream', 'stream'], ditch: ['search.kind_ditch', 'channel'], drain: ['search.kind_ditch', 'channel'],
};

// Layout of the list under the box: truly this module's own (CONTRACT 5); colours from the tokens.
const STYLE = `
.search{position:relative;flex:0 1 300px;min-width:180px}
.search__input{width:100%;font:13px var(--font);padding:7px 10px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);color:var(--ink)}
.search__input:focus{outline:2px solid var(--accent);outline-offset:-1px}
.search__list{position:absolute;left:0;right:0;top:calc(100% + 4px);margin:0;padding:4px 0;list-style:none;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);max-height:340px;overflow:auto;z-index:20}
.search__list[hidden]{display:none}
.search__item{display:flex;justify-content:space-between;gap:10px;padding:6px 10px;cursor:pointer;font:13px var(--font)}
.search__item[aria-selected="true"]{background:var(--chart-band)}
.search__item .label{flex:none;align-self:center}
.search__empty{padding:6px 10px;font:13px var(--font);color:var(--ink-2)}
`;

export async function init(ctx) {
  // b01's toolbar gives a slot between the mode switch and the language switch; else the bare top bar.
  const bar = ctx?.toolbar?.searchSlot || document.getElementById('topbar-search') || document.getElementById('topbar');
  if (!bar || !ctx?.store) return;
  const { store, t } = ctx;
  if (!document.getElementById('b21-search-style')) {
    const st = document.createElement('style');
    st.id = 'b21-search-style';
    st.textContent = STYLE;
    document.head.append(st);
  }

  const wrap = document.createElement('div');
  wrap.className = 'search';
  wrap.setAttribute('role', 'search');
  wrap.innerHTML = `<input class="search__input" type="search" autocomplete="off" spellcheck="false"
      role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="search-list">
    <ul class="search__list" id="search-list" role="listbox" hidden></ul>`;
  bar.append(wrap);
  const input = wrap.querySelector('input');
  const list = wrap.querySelector('ul');

  let presets = FALLBACK_PRESETS; // FALLBACK
  let geo = { places: null, rivers: null, lakes: null };
  let items = buildIndex({ presets });
  let geoState = 'idle'; // idle | loading | done
  let hits = [];
  let sel = -1;

  const label = () => {
    input.placeholder = t('search.placeholder', 'Search a place, river or dam');
    input.setAttribute('aria-label', t('search.label', 'Search the map'));
  };
  label();
  store.on('lang', () => (label(), render()));

  try {
    const p = await Promise.race([ctx.data.json('presets.json'), new Promise((r) => setTimeout(() => r(null), 4000))]);
    if (Array.isArray(p) && p.length) presets = p;
    else if (Array.isArray(p?.presets)) presets = p.presets;
  } catch {
    // presets.json not written yet: the fallback list stays
  }
  items = buildIndex({ presets, ...geo });
  store.set('search', { presets }); // shared with tab-buat so both use the same list

  function loadGeo() {
    if (geoState !== 'idle') return;
    geoState = 'loading';
    render();
    const get = (p) => ctx.data.json(p).catch(() => null);
    Promise.all([get('feat/places.geojson'), get('feat/rivers.geojson'), get('feat/lakes.geojson')]).then(([places, rivers, lakes]) => {
      geo = { places, rivers, lakes };
      items = buildIndex({ presets, ...geo });
      geoState = 'done';
      update();
    });
  }

  const nameOf = (it) => (store.get('lang') === 'en' ? it.name.en || it.name.id : it.name.id || it.name.en);

  function render() {
    const open = document.activeElement === input && norm(input.value).length > 0;
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (!open) return;
    list.replaceChildren();
    hits.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = 'search__item';
      li.id = 'search-opt-' + i;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === sel));
      const nm = document.createElement('span');
      nm.textContent = nameOf(it);
      const kd = document.createElement('span');
      kd.className = 'label';
      const k = KIND_TEXT[it.kind] || KIND_TEXT.place;
      kd.textContent = it.near ? t('search.kind_near', '{kind} · near {town}', { kind: t(k[0], k[1]), town: it.near }) : t(k[0], k[1]);
      li.append(nm, kd);
      li.addEventListener('pointerdown', (e) => {
        e.preventDefault(); // keep focus until the choice is made
        choose(i);
      });
      li.addEventListener('pointermove', () => {
        if (sel !== i) (sel = i), mark();
      });
      list.append(li);
    });
    if (!hits.length || geoState === 'loading') {
      const li = document.createElement('li');
      li.className = 'search__empty';
      li.textContent = geoState === 'loading' ? t('search.loading', 'Loading place and river names') : t('search.none', 'Nothing found');
      list.append(li);
    }
    mark();
  }

  function mark() {
    [...list.querySelectorAll('.search__item')].forEach((li, i) => li.setAttribute('aria-selected', String(i === sel)));
    if (sel >= 0) input.setAttribute('aria-activedescendant', 'search-opt-' + sel);
    else input.removeAttribute('aria-activedescendant');
    list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }

  function update() {
    hits = search(items, input.value, 8);
    sel = hits.length ? 0 : -1;
    render();
  }

  function choose(i) {
    const it = hits[i];
    if (!it) return;
    input.value = nameOf(it);
    store.emit('camera:goto', { ...it.goto });
    store.emit('search:chosen', { key: it.key, kind: it.kind, preset: it.preset || null, ...it.goto });
    hits = [];
    sel = -1;
    input.blur();
    render();
  }

  input.addEventListener('focus', () => (loadGeo(), update()));
  input.addEventListener('input', () => (loadGeo(), update()));
  input.addEventListener('blur', () => setTimeout(render, 0));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hits.length) return;
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
      mark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(sel >= 0 ? sel : 0);
    } else if (e.key === 'Escape') {
      if (input.value) input.value = '';
      else input.blur();
      update();
    }
  });
  // "/" focuses the box from anywhere outside a text field.
  window.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    e.preventDefault();
    input.focus();
  });

  ctx.search = { focus: () => input.focus(), presets: () => presets };
}
