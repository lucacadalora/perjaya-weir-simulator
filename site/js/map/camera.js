// Camera views and tours. Owner: lane b10. CONTRACT 4.2 (`ctx.camera`), amendment A2 (the frame clock).
//
// ctx.camera = {
//   views                      { id: {id, label:[key, en], lon, lat, zoom, pitch, bearing} }
//   tours                      { id: {id, label:[key, en], seconds} }
//   goto(name | {lon, lat, zoom, pitch, bearing}, {ms}) -> Promise   (ms 0 = jump; default 2400)
//   tour(name, {seconds, driven}) -> Promise (resolves when the tour ends or is stopped; driven = a recorder steps
//                              the clock itself, so never jump for want of frames)
//   stop()                     ends the running move where it is
//   busy()                     -> null | {kind 'goto'|'tour', name, u}
//   current()                  -> {lon, lat, zoom, pitch, bearing} of the map now
//   sample(tour, u)            -> the camera of a tour at u in 0..1 (pure; for tests and the film)
// }
// Every move advances ONLY on the store's `frame` event ({dt, t}, lane s01): never by wall-clock time, so a film
// stepped with window.__simStep is exact. A user drag stops the move. The store event `camera:goto` (payload as
// goto: a view name, or {name} / {lon, lat, zoom, pitch, bearing, ms}) is obeyed too.
// The river runs from SOUTH to NORTH through the weir (CONTRACT A1): "from downstream" looks south (bearing 180).

const D2R = Math.PI / 180;

// FALLBACK views until presets.json carries them (presets win by id). Places from the brief.
const VIEW_DEFS = [
  { id: 'weir-downstream', label: ['camera.view_weir_down', 'Weir from downstream'], lon: 104.38101, lat: -4.30512, zoom: 16.6, pitch: 64, bearing: 180 },
  { id: 'weir-upstream', label: ['camera.view_weir_up', 'Weir from upstream'], lon: 104.38101, lat: -4.30512, zoom: 16.4, pitch: 62, bearing: 0 },
  { id: 'gates-close', label: ['camera.view_gates', 'Gates close-up'], lon: 104.3806, lat: -4.30495, zoom: 17.6, pitch: 74, bearing: 180 },
  { id: 'weir-above', label: ['camera.view_weir_above', 'Weir from above'], lon: 104.38101, lat: -4.30512, zoom: 16.9, pitch: 0, bearing: 0 },
  { id: 'intake', preset: 'intake', label: ['camera.view_intake', 'Intake and canal head'], lon: 104.3855, lat: -4.302, zoom: 16.4, pitch: 55, bearing: 300 },
  { id: 'martapura', preset: 'martapura', label: ['camera.view_martapura', 'The river at Martapura'], lon: 104.36, lat: -4.32, zoom: 14, pitch: 50, bearing: 20 },
  { id: 'rail-bridge', preset: 'rail-bridge', label: ['camera.view_rail', 'Rail bridge'], lon: 104.34868, lat: -4.32338, zoom: 16, pitch: 55, bearing: 90 },
  { id: 'floodplain', label: ['camera.view_floodplain', 'Flood plain below the weir'], lon: 104.392, lat: -4.268, zoom: 13.3, pitch: 55, bearing: 180 },
  { id: 'basin', preset: 'basin', label: ['camera.view_basin', 'The whole basin'], lon: 104.08, lat: -4.58, zoom: 9.2, pitch: 40, bearing: 20 },
  { id: 'ranau', label: ['camera.view_ranau', 'Danau Ranau'], lon: 103.925, lat: -4.835, zoom: 11.6, pitch: 55, bearing: 200 },
  { id: 'dam-site', preset: 'tiga-dihaji', label: ['camera.view_dam_site', 'Planned dam upstream'], lon: 103.87687, lat: -4.62893, zoom: 13, pitch: 58, bearing: 0 },
];

// Places (brief). FALLBACK until facts.json/presets carry them.
const WEIR = { lon: 104.38101, lat: -4.30512 };
const RANAU_OUT = { lon: 103.91944, lat: -4.81111 };
const WEIR_KM_FALLBACK = 138.47; // FALLBACK: profile.json marks_km.weir
const WEIR_LEN_FALLBACK = 215.5; // FALLBACK: weir.json check.length_m

export const TOUR_DEFS = [
  { id: 'orbit', label: ['camera.tour_orbit', 'Orbit of the weir'], seconds: 16 },
  { id: 'orbit-close', label: ['camera.tour_orbit_close', 'Close orbit of the weir'], seconds: 16 },
  { id: 'gates', label: ['camera.tour_gates', 'Along the gates'], seconds: 12 },
  { id: 'river', label: ['camera.tour_river', 'Down the river from Danau Ranau'], seconds: 24 },
  { id: 'floodplain', label: ['camera.tour_floodplain', 'Rise over the flood plain'], seconds: 14 },
];

// ---------- pure helpers ----------
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const smooth = (u) => u * u * (3 - 2 * u);
export const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const lerp = (a, b, u) => a + (b - a) * u;
const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) / Math.PI) / 2;
const lonOf = (x) => x * 360 - 180;
const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
export const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
export function bearingOf(a, b) {
  const y = Math.sin((b.lon - a.lon) * D2R) * Math.cos(b.lat * D2R);
  const x = Math.cos(a.lat * D2R) * Math.sin(b.lat * D2R) - Math.sin(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.cos((b.lon - a.lon) * D2R);
  return (Math.atan2(y, x) / D2R + 360) % 360;
}
export function distKm(a, b) {
  const dlat = (b.lat - a.lat) * D2R, dlon = (b.lon - a.lon) * D2R;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dlon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// Camera between two states at u (0..1, already eased). Long hops zoom out in the middle (a flight, not a slide).
export function between(a, b, u) {
  const x = lerp(mercX(a.lon), mercX(b.lon), u), y = lerp(mercY(a.lat), mercY(b.lat), u);
  const d = distKm(a, b);
  const bump = d > 3 ? clamp(Math.log2(d / 3), 0, 4.5) : 0;
  const zoom = lerp(a.zoom, b.zoom, u) - bump * Math.sin(Math.PI * u);
  return {
    lon: lonOf(x), lat: latOf(y), zoom: clamp(zoom, 1, 20),
    pitch: lerp(a.pitch, b.pitch, u),
    bearing: (a.bearing + wrap180(b.bearing - a.bearing) * u + 360) % 360,
  };
}

// Piecewise keyframes [{u, v}] with smoothstep between keys.
export function keyed(keys, u) {
  if (u <= keys[0].u) return keys[0].v;
  for (let i = 1; i < keys.length; i++) {
    if (u <= keys[i].u) {
      const k0 = keys[i - 1], k1 = keys[i];
      return lerp(k0.v, k1.v, smooth((u - k0.u) / (k1.u - k0.u || 1)));
    }
  }
  return keys[keys.length - 1].v;
}

// River path from profile.json rows [km, surface, lower, lon, lat, km2]: returns {at(km) -> {lon, lat},
// heading(km) -> smoothed bearing deg, weirKm, startKm}. Headings use a wide look-ahead so the D8 zigzag never shakes.
export function riverPath(profile) {
  const rows = (profile && profile.rows) || [];
  const weirKm = profile?.marks_km?.weir ?? WEIR_KM_FALLBACK;
  const pts = rows.filter((r) => r[0] <= weirKm + 12).map((r) => ({ km: r[0], lon: r[3], lat: r[4] }));
  if (pts.length < 2) return null;
  function at(km) {
    km = clamp(km, pts[0].km, pts[pts.length - 1].km);
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (pts[m].km <= km) lo = m; else hi = m;
    }
    const a = pts[lo], b = pts[hi];
    const u = b.km > a.km ? (km - a.km) / (b.km - a.km) : 0;
    return { lon: lerp(a.lon, b.lon, u), lat: lerp(a.lat, b.lat, u) };
  }
  // Heading table every 0.5 km, from a point 5 km back to 15 km ahead, then smoothed twice on unit vectors (+-12 km).
  const step = 0.5, n = Math.ceil(weirKm / step) + 1, raw = [];
  for (let i = 0; i < n; i++) {
    const km = i * step;
    raw.push(bearingOf(at(km - 5), at(km + 15)) * D2R);
  }
  const W = 24;
  const blur = (src) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0;
      for (let j = -W; j <= W; j++) {
        const k = clamp(i + j, 0, n - 1), w = W + 1 - Math.abs(j);
        sx += Math.sin(src[k]) * w; sy += Math.cos(src[k]) * w;
      }
      out[i] = Math.atan2(sx, sy);
    }
    return out;
  };
  const head = blur(blur(raw)).map((a) => (a / D2R + 360) % 360);
  function heading(km) {
    const f = clamp(km / step, 0, n - 1), i = Math.floor(f), j = Math.min(n - 1, i + 1);
    return (head[i] + wrap180(head[j] - head[i]) * (f - i) + 360) % 360;
  }
  return { at, heading, weirKm, startKm: pts[0].km };
}

// The camera of a tour at u (0..1). `env` = {river (riverPath or null), views}.
export function sampleTour(id, u, env = {}) {
  u = clamp(u, 0, 1);
  const views = env.views || {};
  if (id === 'orbit') {
    // One full turn round the weir, starting from downstream (looking south), easing in and out.
    const c = views['weir-above'] || WEIR;
    const turn = easeInOut(u);
    return {
      lon: c.lon, lat: c.lat,
      zoom: keyed([{ u: 0, v: 16.3 }, { u: 0.5, v: 15.9 }, { u: 1, v: 16.3 }], u),
      pitch: keyed([{ u: 0, v: 64 }, { u: 0.5, v: 58 }, { u: 1, v: 64 }], u),
      bearing: (180 + 360 * turn) % 360,
    };
  }
  if (id === 'orbit-close') {
    // One full turn close round the weir: the structure about 60 % of the frame width.
    const c = views['weir-above'] || WEIR;
    return { lon: c.lon, lat: c.lat, zoom: 17.2, pitch: 66, bearing: (180 + 360 * easeInOut(u)) % 360 };
  }
  if (id === 'gates') {
    // A slow low push along the downstream face, west abutment to east end, looking south at the gates.
    const len = env.weirLength_m || WEIR_LEN_FALLBACK;
    const half = len / 2 / (111320 * Math.cos(WEIR.lat * D2R));
    const e = easeInOut(u);
    return { lon: WEIR.lon - half + 2 * half * e, lat: WEIR.lat, zoom: 18.2, pitch: 72, bearing: 180 };
  }
  if (id === 'river') {
    const r = env.river;
    if (!r) {
      // No river line: a low straight flight from the outlet to the weir, never a high basin view.
      const e = easeInOut(u);
      const a0 = RANAU_OUT, a1 = WEIR;
      return {
        lon: lerp(a0.lon, a1.lon, e), lat: lerp(a0.lat, a1.lat, e), pitch: 62, bearing: bearingOf(a0, a1),
        zoom: keyed([{ u: 0, v: 12.3 }, { u: 0.8, v: 12.8 }, { u: 1, v: 15.5 }], u),
      };
    }
    // A real flight down the valley: km follows a speed profile (ramp up, cruise, slow to a stop on the last frame).
    const km = r.startKm + (r.weirKm - r.startKm) * riverProgress(u);
    const p = r.at(km);
    return {
      lon: p.lon, lat: p.lat,
      zoom: keyed([{ u: 0, v: 12.3 }, { u: 0.1, v: 12.5 }, { u: 0.45, v: 13.2 }, { u: 0.8, v: 13.0 }, { u: 1, v: 15.5 }], u),
      pitch: 62,
      bearing: r.heading(km),
    };
  }
  if (id === 'floodplain') {
    // From low over the weir, rise and drift north (downstream) over the flood plain, looking back south.
    const fp = views.floodplain || { lon: 104.392, lat: -4.268 };
    const a = { lon: WEIR.lon, lat: WEIR.lat - 0.0012, zoom: 16.4, pitch: 72, bearing: 180 };
    const b = { lon: fp.lon, lat: fp.lat, zoom: 12.9, pitch: 48, bearing: 165 };
    const e = easeInOut(u);
    return {
      lon: lerp(a.lon, b.lon, e), lat: lerp(a.lat, b.lat, e),
      zoom: lerp(a.zoom, b.zoom, smooth(u)), pitch: lerp(a.pitch, b.pitch, e),
      bearing: (a.bearing + wrap180(b.bearing - a.bearing) * e + 360) % 360,
    };
  }
  return null;
}

// Share of the river distance flown by u: speed ramps up over the first 8 %, cruises, and falls to zero over the
// last 22 % (so the descent to the weir is slow and the weir is reached exactly at u = 1). Monotone, 0 -> 1.
const RIVER_TABLE = (() => {
  const n = 2000, cum = new Float64Array(n + 1);
  const v = (u) => (u < 0.08 ? smooth(u / 0.08) : u < 0.78 ? 1 : Math.pow(1 - smooth((u - 0.78) / 0.22), 3));
  for (let i = 1; i <= n; i++) cum[i] = cum[i - 1] + (v((i - 0.5) / n) + 1e-4) / n;
  for (let i = 0; i <= n; i++) cum[i] /= cum[n];
  return cum;
})();
export function riverProgress(u) {
  const n = RIVER_TABLE.length - 1, f = clamp(u, 0, 1) * n, i = Math.floor(f);
  return i >= n ? 1 : RIVER_TABLE[i] + (RIVER_TABLE[i + 1] - RIVER_TABLE[i]) * (f - i);
}

// ---------- the module ----------
export async function init(ctx) {
  const map = ctx.map;
  if (!map) return;
  const { store, t } = ctx;

  const views = {};
  let presets = [];
  try { presets = (await ctx.data.json('presets.json')) || []; } catch { presets = []; }
  for (const d of VIEW_DEFS) {
    const p = d.preset ? presets.find((x) => x.id === d.preset) : null;
    const v = { id: d.id, label: d.label, lon: d.lon, lat: d.lat, zoom: d.zoom, pitch: d.pitch, bearing: d.bearing };
    if (p && Number.isFinite(p.lon) && Number.isFinite(p.lat)) {
      Object.assign(v, { lon: p.lon, lat: p.lat });
      for (const k of ['zoom', 'pitch', 'bearing']) if (Number.isFinite(p[k])) v[k] = p[k];
      if (d.id === 'dam-site') Object.assign(v, { zoom: d.zoom, pitch: d.pitch, bearing: d.bearing });
    }
    views[d.id] = v;
  }
  const tours = Object.fromEntries(TOUR_DEFS.map((d) => [d.id, { ...d }]));

  // The river line (for the river flight and the flood-plain point), loaded on its own; tours wait for it.
  let river = null;
  let weirLength_m = null;
  ctx.data.json('weir.json').then((w) => {
    const L = w?.check?.length_m ?? w?.length_m?.v;
    if (Number.isFinite(L) && L > 0) weirLength_m = L;
  }).catch(() => {});
  let riverDone = false;
  const riverReady = ctx.data.json('feat/profile.json').then((p) => {
    river = riverPath(p);
    if (river) {
      const fp = river.at(river.weirKm + 5.5); // about 5 km below the weir along the river
      Object.assign(views.floodplain, { lon: +fp.lon.toFixed(5), lat: +fp.lat.toFixed(5) });
    }
  }).catch(() => {}).finally(() => (riverDone = true));

  const current = () => {
    const c = map.getCenter();
    return { lon: c.lng, lat: c.lat, zoom: map.getZoom(), pitch: map.getPitch(), bearing: (map.getBearing() + 360) % 360 };
  };
  const apply = (s) => {
    if (!s) return;
    applying = true;
    try {
      map.jumpTo({ center: [s.lon, s.lat], zoom: s.zoom, pitch: clamp(s.pitch, 0, map.getMaxPitch?.() ?? 80), bearing: s.bearing, padding: padding() });
    } finally {
      applying = false;
    }
  };

  // The free map area between the status card and the panel (lane b04, CONTRACT A8.2); none while a film records.
  let usePadding = true;
  const NONE = { top: 0, bottom: 0, left: 0, right: 0 };
  const padding = () => {
    if (!usePadding) return NONE;
    try {
      const p = ctx.geo?.viewPadding?.();
      return p && typeof p === 'object' ? { top: +p.top || 0, bottom: +p.bottom || 0, left: +p.left || 0, right: +p.right || 0 } : NONE;
    } catch { return NONE; }
  };
  function setPadding(on) {
    usePadding = !!on;
    try { map.setPadding?.(padding()); } catch { /* old map */ }
  }

  let applying = false;
  let move = null; // {kind, name, elapsed, seconds, sample(u), resolve}
  let lastFrame = -1e9; // performance.now() of the last frame event: used only to know whether a clock exists

  function finish(m, reason) {
    if (!m) return;
    if (move === m) move = null;
    m.resolve({ done: reason === 'end', reason });
  }
  function stop() { finish(move, 'stopped'); }

  store.listen('frame', (f) => {
    lastFrame = performance.now();
    const m = move;
    if (!m) return;
    m.elapsed += Math.max(0, Number(f && f.dt) || 0);
    const u = m.seconds > 0 ? clamp(m.elapsed / m.seconds, 0, 1) : 1;
    m.u = u;
    apply(m.sample(u));
    if (u >= 1) finish(m, 'end');
  });

  // A drag, wheel or key from the user ends any move.
  map.on('movestart', (e) => { if (!applying && e && e.originalEvent) stop(); });

  const clockAlive = () => performance.now() - lastFrame < 1500;

  function start(kind, name, seconds, sample, driven = false) {
    stop();
    return new Promise((resolve) => {
      const m = { kind, name, elapsed: 0, seconds, sample, resolve, u: 0 };
      if (!(seconds > 0) || (!driven && !clockAlive())) {
        // No frame clock on this page (or ms 0): jump straight to the end, never move by wall-clock time.
        apply(sample(1));
        resolve({ done: true, reason: seconds > 0 ? 'no-clock' : 'jump' });
        return;
      }
      move = m;
      apply(sample(0));
    });
  }

  function resolveTarget(target) {
    if (typeof target === 'string') return views[target] || null;
    if (target && typeof target === 'object') {
      if (target.name && views[target.name]) return views[target.name];
      if (Number.isFinite(target.lon) && Number.isFinite(target.lat)) {
        const c = current();
        return {
          lon: target.lon, lat: target.lat,
          zoom: Number.isFinite(target.zoom) ? target.zoom : c.zoom,
          pitch: Number.isFinite(target.pitch) ? target.pitch : c.pitch,
          bearing: Number.isFinite(target.bearing) ? target.bearing : c.bearing,
        };
      }
    }
    return null;
  }

  function goto(target, opts = {}) {
    const to = resolveTarget(target);
    if (!to) return Promise.resolve({ done: false, reason: 'unknown' });
    const from = current();
    const ms = Number.isFinite(opts.ms) ? opts.ms : Number.isFinite(target?.ms) ? target.ms : 2400;
    const name = typeof target === 'string' ? target : target?.name || null;
    return start('goto', name, ms / 1000, (u) => between(from, to, easeInOut(u)));
  }

  // Starts at once (synchronously) when the river line is loaded, so a recorder's next frame is the tour's first.
  function tour(name, opts = {}) {
    if (!tours[name]) return Promise.resolve({ done: false, reason: 'unknown' });
    const seconds = Number.isFinite(opts.seconds) && opts.seconds > 0 ? opts.seconds : tours[name].seconds;
    const go = () => start('tour', name, seconds, (u) => sampleTour(name, u, { river, views, weirLength_m }), !!opts.driven);
    if (name === 'river' && riverDone && !river) {
      // The river line failed to load earlier: try once more before flying.
      return ctx.data.json('feat/profile.json').then((p) => { river = riverPath(p); }).catch(() => {}).then(go);
    }
    return riverDone ? go() : riverReady.then(go);
  }

  store.listen('camera:goto', (p) => {
    if (!p) return;
    goto(typeof p === 'string' ? p : p, { ms: p.ms });
  });

  ctx.camera = {
    views, tours, goto, tour, stop, current, setPadding, padding,
    busy: () => (move ? { kind: move.kind, name: move.name, u: move.u } : null),
    sample: (id, u) => sampleTour(id, u, { river, views, weirLength_m }),
    ready: riverReady,
  };
  // Keys for the language tables (labels are read by tab-film through ctx.t).
  for (const v of Object.values(views)) t(v.label[0], v.label[1]);
  for (const d of TOUR_DEFS) t(d.label[0], d.label[1]);
}
