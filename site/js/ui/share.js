// Share link: mode, camera, scenario, controls and dams in the URL hash, restored on load. Owner: lane b10.
//
// Hash: #c=<lon>,<lat>,<zoom>,<pitch>,<bearing>&m=<mode>&x=<base64url JSON of the rest>
// ctx.share = { link() -> full URL of the state now, state() -> object, encode(state) -> hash, decode(hash) -> state,
//               apply(state) }
// The hash is kept current (replaceState, at most every 0.8 s) except with ?shot=1. Pure encode/decode for node tests.

const r = (v, d) => (Number.isFinite(v) ? +Number(v).toFixed(d) : undefined);

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const clean = (o) => {
  if (Array.isArray(o)) return o.map(clean);
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = clean(v);
    return out;
  }
  return o;
};

// state = { v, mode, camera {lon, lat, zoom, pitch, bearing}, lang, tab, scenario, rain, weir, speed, dams[] }
export function encode(st = {}) {
  const parts = [];
  const c = st.camera;
  if (c && Number.isFinite(c.lon) && Number.isFinite(c.lat)) {
    parts.push('c=' + [r(c.lon, 5), r(c.lat, 5), r(c.zoom, 2), r(c.pitch, 1), r(((c.bearing % 360) + 360) % 360, 1)].join(','));
  }
  if (st.mode) parts.push('m=' + encodeURIComponent(st.mode));
  const rest = clean({
    v: 1, lang: st.lang, tab: st.tab, scenario: st.scenario, rain: st.rain, weir: st.weir, speed: st.speed,
    dams: st.dams && st.dams.length ? st.dams : undefined,
  });
  parts.push('x=' + b64urlEncode(JSON.stringify(rest)));
  return parts.join('&');
}

export function decode(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (!h) return null;
  const q = new URLSearchParams(h);
  const out = {};
  const c = q.get('c');
  if (c) {
    const [lon, lat, zoom, pitch, bearing] = c.split(',').map(Number);
    if (Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90) {
      out.camera = { lon, lat, zoom: Number.isFinite(zoom) ? zoom : undefined, pitch: Number.isFinite(pitch) ? pitch : undefined, bearing: Number.isFinite(bearing) ? bearing : undefined };
    }
  }
  const m = q.get('m');
  if (m === 'weir' || m === 'maker') out.mode = m;
  const x = q.get('x');
  if (x) {
    try {
      const o = JSON.parse(b64urlDecode(x));
      if (o && typeof o === 'object') Object.assign(out, o);
    } catch { /* a broken link restores what it can */ }
  }
  return Object.keys(out).length ? out : null;
}

const SCEN_KEYS = ['kind', 'year', 'rain_scale', 'design_T'];
const RAIN_KEYS = ['annual_mm', 'monthly_mm', 'runoff_share'];
const WEIR_KEYS = ['mode', 'gates', 'sluices', 'intake_open', 'demand_m3s'];
const DAM_KEYS = ['name', 'lon', 'lat', 'type', 'crest_el', 'height_m', 'release_m3s', 'spill_width_m'];
const pick = (o, keys) => {
  if (!o || typeof o !== 'object') return undefined;
  const out = {};
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  return Object.keys(out).length ? out : undefined;
};

export async function init(ctx) {
  const { store } = ctx;

  function state() {
    const map = ctx.map;
    let camera;
    if (map) {
      const c = map.getCenter();
      camera = { lon: c.lng, lat: c.lat, zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
    }
    const maker = store.get('maker') || {};
    return {
      mode: store.get('mode'),
      camera,
      lang: store.get('lang'),
      tab: store.get('tab'),
      scenario: pick(store.get('scenario'), SCEN_KEYS),
      rain: pick(store.get('rain'), RAIN_KEYS),
      weir: pick(store.get('weir'), WEIR_KEYS),
      speed: store.get('clock.speed'),
      dams: (maker.dams || []).map((d) => {
        const o = pick(d, DAM_KEYS) || {};
        if (Number.isFinite(o.lon)) o.lon = r(o.lon, 5);
        if (Number.isFinite(o.lat)) o.lat = r(o.lat, 5);
        return o;
      }),
    };
  }

  const link = () => {
    const q = new URLSearchParams(location.search);
    for (const k of ['shot', 'only', 'dev']) q.delete(k);
    const s = q.toString();
    return location.origin + location.pathname + (s ? '?' + s : '') + '#' + encode(state());
  };

  function apply(st) {
    if (!st) return;
    if (st.lang === 'id' || st.lang === 'en') store.set('lang', st.lang);
    if (st.mode === 'weir' || st.mode === 'maker') store.set('mode', st.mode);
    const sc = pick(st.scenario, SCEN_KEYS);
    if (sc) store.patch('scenario', sc);
    const rn = pick(st.rain, RAIN_KEYS);
    if (rn) store.patch('rain', rn);
    const wr = pick(st.weir, WEIR_KEYS);
    if (wr) store.patch('weir', wr);
    if (Number.isFinite(st.speed) && st.speed > 0) store.set('clock.speed', st.speed);
    if (typeof st.tab === 'string' && st.tab) {
      if (ctx.panel?.show) { try { ctx.panel.show(st.tab); } catch { /* tab gone */ } } else store.set('tab', st.tab);
    }
    if (st.camera && ctx.camera) ctx.camera.goto(st.camera, { ms: 0 });
    else if (st.camera && ctx.map) {
      const c = st.camera;
      ctx.map.jumpTo({ center: [c.lon, c.lat], zoom: c.zoom, pitch: c.pitch, bearing: c.bearing });
    }
    if (Array.isArray(st.dams) && st.dams.length) restoreDams(st.dams);
  }

  // Dams: ask the simulation to place each one again, then put back its controls once it appears.
  function restoreDams(dams) {
    const want = dams.filter((d) => Number.isFinite(d.lon) && Number.isFinite(d.lat));
    const done = new Set();
    const off = store.on('maker.dams', (list) => {
      if (!Array.isArray(list)) return;
      let changed = false;
      const next = list.map((d) => {
        if (done.has(d.id)) return d;
        const w = want.find((x) => !x._used && Math.abs(x.lon - d.lon) < 0.003 && Math.abs(x.lat - d.lat) < 0.003);
        if (!w) return d;
        w._used = true;
        done.add(d.id);
        changed = true;
        const ctl = pick(w, ['name', 'type', 'crest_el', 'height_m', 'release_m3s', 'spill_width_m']) || {};
        return { ...d, ...ctl };
      });
      if (changed) store.set('maker.dams', next);
      if (want.every((x) => x._used)) off();
    });
    setTimeout(off, 120000);
    for (const d of want) store.emit('maker:place', { lon: d.lon, lat: d.lat, restore: pick(d, DAM_KEYS) });
  }

  const initial = decode(location.hash);
  if (initial) {
    try { apply(initial); } catch (e) { console.warn('[share] could not restore the link', e); }
  }

  // Keep the hash current (never in shot mode, where pictures are taken).
  if (!ctx.shot) {
    let timer = null;
    const write = () => {
      timer = null;
      try { history.replaceState(history.state, '', location.pathname + location.search + '#' + encode(state())); } catch { /* sandboxed */ }
    };
    const soon = () => { if (!timer) timer = setTimeout(write, 800); };
    for (const p of ['mode', 'lang', 'tab', 'scenario', 'weir.mode', 'weir.gates', 'weir.sluices', 'weir.intake_open', 'maker.dams', 'clock.speed']) store.on(p, soon);
    ctx.map?.on?.('moveend', soon);
  }

  ctx.share = { link, state, encode, decode, apply };
}
