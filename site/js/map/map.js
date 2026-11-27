// Map core. Owner: lane b04. CONTRACT 4.2, 4.7; recipe: baseline plan/T1-render-findings.md.
// Sets ctx.map (MapLibre), ctx.geo, ctx.scene3d (three.js host) and ctx.sampler (terrain heights).
// Sources it adds: 'terrain' (raster-dem, the 3D surface), 'terrain-hs' (raster-dem for hillshade), 'sat'
// (satellite raster). Layers: 'bg', 'sat', 'three' (the one custom 3D layer, added by scene3d). Other lanes add
// their layers below 'three' with map.addLayer(layer, 'three') (a raster or fill layer added on top still draws over the 3D models).

import * as geo from './geo.js';
import { createScene3d } from './scene3d.js';
import { createSampler, createTerrainStore } from './terrain-sampler.js';

// Opening view: the weir seen from downstream (the Komering runs north here), looking upstream to the south-south-west.
// The weir point is the binding one from presets.json ('weir' view) when it exists.
const OPEN = { lon: 104.38101, lat: -4.30512, zoom: 16.2, pitch: 62, bearing: 195 }; // FALLBACK until presets.json
const PAD_DEG = 0.25; // how much wider than the data box the user may pan

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch (e) {
    return false;
  }
}

const abs = (rel, base) => new URL(rel, base).href.replace(/%7B/g, '{').replace(/%7D/g, '}');

async function tileSource(ctx, dir) {
  // tiles.json links are relative: "./{z}/.." is relative to the file, "data/tiles/.." to the site root.
  const tj = await ctx.data.json('tiles/' + dir + '/tiles.json');
  const fileBase = new URL('./data/tiles/' + dir + '/', location.href).href;
  const siteBase = new URL('./', location.href).href;
  const stamp = window.__BUILD ? '?v=' + encodeURIComponent(window.__BUILD) : ''; // a rebuilt tile set is never served from cache
  const tiles = (tj.tiles || []).map((u) => abs(u, u.startsWith('./') || u.startsWith('../') ? fileBase : siteBase) + stamp);
  return { tj, tiles };
}

function creditLine(ctx, credits, fallback) {
  const el = document.getElementById('credits');
  if (!el) return;
  const items = Array.isArray(credits) && credits.length ? credits.map((c) => c.short).filter(Boolean) : fallback;
  el.textContent = items.join(' · ');
  el.dataset.b04 = '1';
}

// Satellite through a protocol too: zoom 14 exists only inside `z14_bounds`; elsewhere a zoom 14 tile is the
// zoom 13 parent's quarter scaled up, so zooming in makes no failed request.
function satProtocol(sat) {
  const tj = sat.tj, deep = tj.maxzoom ?? 14, b = tj.z14_bounds;
  const full = b ? deep - 1 : deep;
  const range = b && { x: [Math.floor(geo.lonToTileX(b[0], deep)), Math.floor(geo.lonToTileX(b[2], deep))],
    y: [Math.floor(geo.latToTileY(b[3], deep)), Math.floor(geo.latToTileY(b[1], deep))] };
  const has = (z, x, y) => z <= full || (range && z === deep && x >= range.x[0] && x <= range.x[1] && y >= range.y[0] && y <= range.y[1]);
  const url = (z, x, y) => sat.tiles[0].replace('{z}', z).replace('{x}', x).replace('{y}', y);
  return async (params, abort) => {
    const [z, x, y] = /(\d+)\/(\d+)\/(\d+)/.exec(params.url).slice(1).map(Number);
    const opt = { signal: abort && abort.signal };
    if (has(z, x, y)) {
      const r = await fetch(url(z, x, y), opt);
      if (r.ok) return { data: await r.arrayBuffer() };
    }
    let az = z - 1, ax = x >> 1, ay = y >> 1;
    while (az > 0 && !has(az, ax, ay)) (az--, (ax >>= 1), (ay >>= 1));
    const r = await fetch(url(az, ax, ay), opt);
    if (!r.ok) throw new Error('no picture for this tile');
    const bmp = await createImageBitmap(await r.blob());
    const k = 2 ** (z - az), w = bmp.width / k;
    const cv = new OffscreenCanvas(256, 256);
    const c2 = cv.getContext('2d');
    c2.imageSmoothingQuality = 'high';
    c2.drawImage(bmp, (x - ax * k) * w, (y - ay * k) * w, w, w, 0, 0, 256, 256);
    bmp.close();
    return { data: await (await cv.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer() };
  };
}

// The free map area: what lies between the status card (left), the top bar (top) and the panel (right; at phone
// width the panel is a bottom sheet and pads the bottom). Pixels, for map.setPadding and camera moves.
function viewPadding() {
  const mapEl = document.getElementById('map');
  const pad = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!mapEl) return pad;
  const m = mapEl.getBoundingClientRect();
  const box = (id) => {
    const el = document.getElementById(id);
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  };
  const panel = box('panel'), status = box('status'), top = box('topbar');
  if (panel) {
    if (panel.width >= 0.8 * m.width) pad.bottom = Math.max(0, m.bottom - panel.top);
    else pad.right = Math.max(0, m.right - panel.left);
  }
  if (status && status.left < m.left + m.width / 2) pad.left = Math.max(0, status.right - m.left);
  if (top) pad.top = Math.max(0, top.bottom - m.top);
  // never squeeze the free area below a third of the map
  const k = Math.min(1, (m.width * 0.67) / Math.max(1, pad.left + pad.right), (m.height * 0.67) / Math.max(1, pad.top + pad.bottom));
  for (const key in pad) pad[key] = Math.round(pad[key] * k);
  return pad;
}

function followPadding(map) {
  let raf = 0;
  const apply = () => {
    raf = 0;
    const p = viewPadding(), q = map.getPadding();
    if (['top', 'right', 'bottom', 'left'].some((k) => Math.abs((q[k] || 0) - p[k]) > 1)) map.setPadding(p);
  };
  const later = () => raf || (raf = requestAnimationFrame(apply));
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(later);
    for (const id of ['map', 'panel', 'status', 'topbar']) {
      const el = document.getElementById(id);
      if (el) ro.observe(el);
    }
  }
  window.addEventListener('resize', later);
  apply();
}

// The first frame is already the pale map: b05's background colour and satellite paint for the default base.
async function paleStart() {
  try {
    const b = await import('./basemap.js');
    if (typeof b.PALE_BG === 'string' && b.BLEND_SAT && typeof b.BLEND_SAT === 'object') {
      return { bg: b.PALE_BG, sat: structuredClone(b.BLEND_SAT) };
    }
  } catch (e) {
    /* basemap.js missing or failing: the fallback below */
  }
  return { bg: '#f3efe5', sat: { 'raster-opacity': 0.6, 'raster-brightness-min': 0.25, 'raster-saturation': -0.3 } }; // FALLBACK
}

async function openingView(ctx) {
  try {
    const presets = await ctx.data.json('presets.json');
    const p = (presets || []).find((x) => x && (x.id === 'weir' || x.id === 'bendung-perjaya') && x.lon != null);
    if (p) return { lon: p.lon, lat: p.lat, zoom: p.zoom ?? OPEN.zoom, pitch: p.pitch ?? OPEN.pitch, bearing: p.bearing ?? OPEN.bearing };
  } catch (e) {
    /* presets.json not there yet */
  }
  return OPEN;
}

export async function init(ctx) {
  const el = document.getElementById('map');
  if (!el) return;
  ctx.geo = { ...geo, viewPadding };
  if (typeof maplibregl === 'undefined' || !hasWebGL()) {
    el.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'note map-nowebgl';
    p.style.cssText = 'position:absolute;inset:auto 0 50% 0;text-align:center;padding:0 16px';
    p.textContent = ctx.t('map.no_webgl', 'This browser cannot draw the 3D map (WebGL is off or missing). Try another browser or turn on hardware acceleration.');
    el.appendChild(p);
    return;
  }

  const [dem, sat, view, pale] = await Promise.all([tileSource(ctx, 'terrain'), tileSource(ctx, 'sat'), openingView(ctx), paleStart()]);
  const b = dem.tj.bounds || sat.tj.bounds;
  const maxBounds = b ? [[b[0] - PAD_DEG, b[1] - PAD_DEG], [b[2] + PAD_DEG, b[3] + PAD_DEG]] : undefined;
  // terrain through our protocol: deep zooms exist only in the fine box; a missing tile is made from its parent
  const terrain = createTerrainStore({ tilesUrl: dem.tiles[0], tj: dem.tj });
  if (!maplibregl.__pjterrain) {
    maplibregl.addProtocol('pjterrain', (params, abort) => maplibregl.__pjterrain.load(params, abort));
  }
  maplibregl.__pjterrain = terrain; // the newest store answers (one map per page)
  if (!maplibregl.__pjsat) maplibregl.addProtocol('pjsat', (params, abort) => maplibregl.__pjsat(params, abort));
  maplibregl.__pjsat = satProtocol(sat);
  const demSrc = { type: 'raster-dem', tiles: ['pjterrain://{z}/{x}/{y}'], encoding: dem.tj.encoding || 'terrarium',
    tileSize: terrain.tileSize, minzoom: terrain.avail.minzoom, maxzoom: terrain.avail.maxzoom, bounds: dem.tj.bounds };

  const map = new maplibregl.Map({
    container: el,
    center: [view.lon, view.lat],
    zoom: view.zoom,
    pitch: view.pitch,
    bearing: view.bearing,
    maxPitch: 80,
    maxBounds,
    minZoom: 6,
    attributionControl: false,
    // preserveDrawingBuffer: the film and the still picture (lane b10) read the canvas.
    canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true },
    fadeDuration: ctx.shot ? 0 : 300,
    locale: {
      'NavigationControl.ZoomIn': ctx.t('map.zoom_in', 'Zoom in'),
      'NavigationControl.ZoomOut': ctx.t('map.zoom_out', 'Zoom out'),
      'NavigationControl.ResetBearing': ctx.t('map.reset_north', 'Turn north up'),
    },
    style: {
      version: 8,
      projection: { type: 'mercator' },
      sources: {
        terrain: demSrc,
        'terrain-hs': { ...demSrc },
        sat: { type: 'raster', tiles: ['pjsat://{z}/{x}/{y}'], tileSize: sat.tj.tileSize || 256, minzoom: sat.tj.minzoom ?? 6,
          maxzoom: sat.tj.maxzoom ?? 14, bounds: sat.tj.bounds },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': pale.bg } },
        { id: 'sat', type: 'raster', source: 'sat', paint: { ...pale.sat, 'raster-fade-duration': ctx.shot ? 0 : 200 } },
      ],
      terrain: { source: 'terrain', exaggeration: 1 },
      sky: { 'sky-color': '#cfe0ef', 'horizon-color': '#f2efe6', 'sky-horizon-blend': 0.6, 'fog-color': '#eef1f2', 'fog-ground-blend': 0.85 },
    },
  });
  ctx.map = map;
  followPadding(map); // centres of flyTo / easeTo / jumpTo land in the free map area
  window.__map = map;
  map.on('error', (e) => ctx.log('map error', e && e.error && e.error.message));

  // controls into #maptools (zoom, compass with pitch) and a scale bar
  const tools = document.getElementById('maptools');
  if (tools) {
    const nav = new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true, showZoom: true });
    const node = nav.onAdd(map);
    node.classList.add('b04-ctrl');
    node.style.alignSelf = 'flex-start';
    tools.appendChild(node);
    // scale bar from the centre's latitude and the zoom (never from screen points that may miss the terrain)
    const bar = document.createElement('div');
    bar.className = 'maplibregl-ctrl maplibregl-ctrl-scale b04-ctrl';
    bar.style.alignSelf = 'flex-start';
    tools.appendChild(bar);
    const update = () => {
      const c = map.getCenter();
      const s = geo.scaleBar(c.lat, map.getZoom(), 110);
      if (!s) return (bar.hidden = true);
      bar.hidden = false;
      bar.style.width = Math.round(s.px) + 'px';
      bar.textContent = s.metres >= 1000 ? ctx.fmt.num(s.metres / 1000, 0) + ' km' : ctx.fmt.num(s.metres, 0) + ' m';
    };
    map.on('move', update);
    map.on('resize', update);
    map.on('load', update);
    update();
  }

  map.on('click', (e) => ctx.store.emit('map:click', { lon: e.lngLat.lng, lat: e.lngLat.lat }));

  // credits: from credits.json (lane b18); until it exists, the tile files' own lines
  const fallback = ['Copernicus DEM GLO-30 (DLR, Airbus)', 'Sentinel-2 cloudless 2016 by EOX (CC BY 4.0)']; // FALLBACK
  creditLine(ctx, null, fallback);
  let haveCredits = false;
  const loadCredits = () =>
    haveCredits || ctx.data.json('credits.json').then((c) => ((haveCredits = true), creditLine(ctx, c, fallback)), () => {});
  loadCredits();
  ctx.store.listen('app:ready', loadCredits); // a credits.json that appeared after start-up is read again here

  ctx.sampler = createSampler(terrain);

  await new Promise((res, rej) => {
    if (map.loaded()) return res();
    const to = setTimeout(() => rej(new Error('the map style did not load in 20 s')), 20000);
    map.once('load', () => (clearTimeout(to), res()));
  });
  ctx.scene3d = createScene3d(ctx, map);

  if (ctx.shot) {
    // pictures: wait until the first view's tiles are drawn (at most 25 s), so a shot shows terrain
    await new Promise((res) => {
      const to = setTimeout(res, 25000);
      map.once('idle', () => (clearTimeout(to), res()));
      map.triggerRepaint();
    });
  }
}
