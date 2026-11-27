// Boot. Owner: lane b01 (seeded by the lead). CONTRACT sections 4.1 to 4.5.
// Every module is loaded on its own: a missing or failing module is reported and the rest still start.

import { createStore } from './store.js';
import { createData } from './data.js';
import { createI18n } from './i18n.js';
import { createFmt } from './fmt.js';
import { startLoading } from './ui/loading.js';

// The state keys every lane may bind to (CONTRACT section 4.4). Extend under your own key; never rename.
export const INITIAL = {
  lang: 'id',
  mode: 'weir', // 'weir' = the real Bendung Perjaya · 'maker' = place a dam of your own in the basin
  tab: 'ringkas',
  clock: { day: 0, date: '2025-01-01', start_date: '2025-01-01', speed: 1, running: false },
  scenario: { kind: 'climatology', year: null, rain_scale: 1, label: '', design_T: null },
  rain: { annual_mm: null, monthly_mm: null, runoff_share: null, today_mm: null },
  flow: { q_in: null, q_base: null, q_ranau: null },
  weir: {
    mode: 'auto',
    gates: [0, 0, 0, 0, 0, 0, 0],
    sluices: [0, 0, 0],
    intake_open: 1,
    demand_m3s: null,
    pond_el: null,
    tail_el: null,
    q_gates: null,
    q_sluices: null,
    q_intake: null,
    q_spill: null,
    q_down: null,
    freeboard_m: null,
    alerts: [],
  },
  flood: { stage_m: null, q: null, area_km2: null, depth_max_m: null, version: 0 },
  impact: { buildings: null, footprint_m2: null, roads_km: null, rail_km: null, lc_ha: null, places: [], version: 0 },
  irrigation: { area_ha: null, demand_m3s: null, supplied_m3s: null, shortfall_m3s: null, reliability: null },
  maker: { active: null, placing: false, dams: [] },
  view: {
    base: 'blend',
    exaggeration: 1,
    layers: { contours: true, roads: true, labels: true, buildings: false, canals: true, catchment: true, gauge: true, admin: false },
  },
  film: { state: 'idle', tour: null, progress: 0 },
  history: { day: [], q_in: [], pond_el: [], q_down: [], q_intake: [], fill: [] },
  engine: { state: null }, // written by lane b11 ('loading' | 'ready' | 'error'); read by ui/loading
  // lane s: sediment through the intake and the settling basins. `auto` (flushing rule on or off) is the UI's control;
  // the rest are results written by sim/weir-run.js from engine/sediment.js (null until the first step).
  sediment: {
    auto: true,
    c_river_mgL: null, c_intake_mgL: null, c_canal_mgL: null, c_flush_mgL: null,
    river_t_day: null, intake_t_day: null, trapped_t_day: null, flushed_t_day: null, q_flush_m3s: null,
    storage_m3: null, flush_at: null, flush_hours: null, basins: [], flushing: null, queue: [], next: null,
    last_day: { trapped_t: 0, returned_t: 0 }, year: { trapped_t: 0, returned_t: 0 },
  },
};

// The shell (panel, top bar, status card) starts first so the title and frame appear before any big data file
// is requested (CONTRACT 2.9). MODULES keeps its names and order; only the boot order pulls these forward.
export const SHELL_FIRST = ['ui/panel', 'ui/toolbar', 'ui/statuscard'];

// Load order. A module is a file site/js/<path>.js that exports `async function init(ctx)`.
export const MODULES = [
  'map/map', // sets ctx.map, ctx.scene3d, ctx.geo
  'map/basemap',
  'map/ground/mount', // lane g: the close-zoom ground drape, above the base hillshade, below contours and water
  'map/thematic',
  'map/water',
  'map/floodmask',
  'map/impact-layers',
  'map/structures/mount-weir',
  'map/structures/site',
  'map/structures/mount-dam',
  'map/camera', // sets ctx.camera
  'engine/client', // sets ctx.engine
  'sim/loop', // sets ctx.sim, window.__simStep
  'ui/panel', // sets ctx.panel
  'ui/toolbar',
  'ui/statuscard',
  'ui/search',
  'ui/tab-ringkas',
  'ui/tab-hujan',
  'ui/tab-operasi',
  'ui/tab-dampak',
  'ui/tab-irigasi',
  'ui/tab-buat',
  'ui/tab-film',
  'ui/tab-dosir',
  'map/film', // sets ctx.film
  'ui/share',
];

function createFields(store) {
  // Big arrays (masks, point lists) live here, not in the store. set() tells listeners of "field:<name>".
  const m = new Map();
  return {
    get: (name) => m.get(name),
    set(name, value) {
      m.set(name, value);
      store.emit('field:' + name, value);
    },
    on: (name, fn) => store.listen('field:' + name, fn),
  };
}

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' took longer than ' + ms / 1000 + ' s')), ms))]);

async function boot() {
  const q = new URLSearchParams(location.search);
  const store = createStore(INITIAL);
  if (q.get('lang') === 'en' || q.get('lang') === 'id') store.set('lang', q.get('lang'));
  const ctx = { store, data: createData('./data/'), query: q, dev: q.get('dev') === '1', shot: q.get('shot') === '1' };
  ctx.t = createI18n(store);
  ctx.fmt = createFmt(store);
  ctx.fields = createFields(store);
  ctx.log = (...a) => ctx.dev && console.log('[sim]', ...a);
  window.__ctx = ctx;
  window.__modules = {};
  const loading = startLoading(ctx);
  ctx.t.apply(document);

  // ?only=map/map,ui/panel for a lane's own test page (spaces and a trailing ".js" are forgiven).
  const only = q.get('only') ? q.get('only').split(',').map((s) => s.trim().replace(/\.js$/, '')).filter(Boolean) : null;
  const order = [...SHELL_FIRST.filter((p) => MODULES.includes(p)), ...MODULES.filter((p) => !SHELL_FIRST.includes(p))];
  const todo = order.filter((p) => !only || only.includes(p));
  let n = 0;
  for (const path of todo) {
    ctx.bootStep?.(++n, todo.length);
    try {
      const mod = await import('./' + path + '.js');
      if (typeof mod.init === 'function') await withTimeout(Promise.resolve(mod.init(ctx)), 30000, path);
      window.__modules[path] = 'ok';
    } catch (e) {
      const missing = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(String(e && e.message));
      window.__modules[path] = missing ? 'missing' : 'failed: ' + (e && e.message);
      if (missing) ctx.log('module not there yet:', path);
      else console.error('[boot] module failed: ' + path, e);
    }
  }

  ctx.t.apply(document);
  store.on('lang', () => ctx.t.apply(document));
  document.documentElement.lang = store.get('lang');
  store.on('lang', (l) => (document.documentElement.lang = l));
  document.getElementById('loading')?.setAttribute('hidden', '');
  loading.done();
  store.emit('app:ready', {});
  window.__simReady = true;
  if (ctx.dev) {
    console.table(window.__modules);
    devDrawer(ctx);
  }
}

// ?dev=1: a small drawer listing window.__modules (developer aid, never shown otherwise, so plain text is fine).
function devDrawer(ctx) {
  const box = document.createElement('details');
  box.className = 'dev-drawer';
  box.style.cssText =
    'position:fixed;left:12px;bottom:56px;z-index:50;max-height:50vh;overflow:auto;background:#fff;border:1px solid #d9dcdf;border-radius:4px;padding:6px 10px;font:11px/1.4 ui-monospace,monospace;color:#15202b';
  const sum = document.createElement('summary');
  const mods = Object.entries(window.__modules);
  const ok = mods.filter(([, v]) => v === 'ok').length;
  sum.textContent = ctx.t('dev.modules', 'Modules: {ok} of {all} loaded', { ok, all: mods.length });
  box.append(sum);
  const list = document.createElement('div');
  for (const [k, v] of mods) {
    const row = document.createElement('div');
    row.textContent = (v === 'ok' ? '✓ ' : v === 'missing' ? '· ' : '✗ ') + k + (v === 'ok' ? '' : '  ' + v);
    row.style.color = v === 'ok' ? '#1f7a3d' : v === 'missing' ? '#77828d' : '#b3261e';
    list.append(row);
  }
  box.append(list);
  document.body.append(box);
}

boot().catch((e) => {
  console.error('[boot] failed', e);
  const el = document.getElementById('loading');
  if (el) el.textContent = window.__ctx?.t ? window.__ctx.t('app.boot_failed', 'The simulator could not start. Please reload the page.') : 'The simulator could not start. Please reload the page.';
});
