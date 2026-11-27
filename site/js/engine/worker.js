// Engine worker (lane b11): a module worker that holds the grids and runs every engine/*.js module.
// Messages in:  {type:'init', urlTemplate, grids:['wide','fine']}   urlTemplate: absolute URL with __PATH__ for the
//                                                                    path relative to site/data/ (keeps the build stamp)
//               {type:'call', id, name:'module.function', args}
// Messages out: {type:'progress', grid, layer, done, total, bytes} · {type:'meta', grid, meta}
//               {type:'grid', grid, state:'ready'|'error', error} · {type:'modules', loaded, failed}
//               {type:'result', id, ok:true, value} (typed arrays transferred) · {type:'result', id, ok:false, error}
//
// Calling convention (CONTRACT 4.8): a function whose first parameter is named G gets (G, args); otherwise an array
// of args is spread (`volumeAt(curve, level)` -> args [curve, level]) and anything else is passed as one argument.
// flood.* waits for flood.prepare (river outline) and impact.* for impact.prepare, both run once after the grids load.
// A function whose first parameter is named g gets the grid named by args[0] (args = ['wide', lon, lat]) or
// args.grid in its place (then the args object is passed second).
import { loadGrid } from './grid.js';

const MODULE_NAMES = ['grid', 'reservoir', 'rainflow', 'weir', 'flood', 'impact', 'irrigation'];
const mods = {};
const G = { cache: new Map() };
const gridReady = {}; // name -> Promise<grid>
let urlTemplate = null;
let impactReady = null;
let floodReady = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const urlOf = (path) => urlTemplate.replace('__PATH__', path);

async function fetchPath(path, kind) {
  const r = await fetch(urlOf(path));
  if (!r.ok) throw new Error(`data ${path}: HTTP ${r.status}`);
  return kind === 'json' ? r.json() : r.arrayBuffer();
}
G.data = { json: (p) => fetchPath(p, 'json'), bin: (p) => fetchPath(p, 'bin') };

function plain(e) {
  const m = e && e.message ? e.message : String(e);
  return m.length > 300 ? m.slice(0, 300) + '…' : m;
}

async function loadModules() {
  const loaded = [];
  const failed = {};
  await Promise.all(
    MODULE_NAMES.map(async (n) => {
      try {
        mods[n] = await import(`./${n}.js`);
        loaded.push(n);
      } catch (e) {
        failed[n] = plain(e);
      }
    }),
  );
  post({ type: 'modules', loaded: loaded.sort(), failed });
}

function startGrid(name) {
  let bytes = 0;
  const fetchBinary = async (path) => {
    const v = await fetchPath(path, path.endsWith('.json') ? 'json' : 'bin');
    if (path === `grid/${name}.json`) post({ type: 'meta', grid: name, meta: v });
    if (v && v.byteLength) bytes += v.byteLength;
    return v;
  };
  gridReady[name] = loadGrid(name, fetchBinary, {
    onProgress: (p) => post({ type: 'progress', grid: name, layer: p.layer, done: p.done, total: p.total, bytes }),
  }).then(
    (g) => {
      G[name] = g;
      post({ type: 'grid', grid: name, state: 'ready' });
      return g;
    },
    (e) => {
      post({ type: 'grid', grid: name, state: 'error', error: plain(e) });
      throw e;
    },
  );
  gridReady[name].catch(() => {});
  return gridReady[name];
}

// An optional data file: a miss logs one plain line and gives null; the worker carries on.
async function optional(path, kind) {
  try {
    return await fetchPath(path, kind);
  } catch (e) {
    console.warn(`[engine] optional file ${path} not loaded: ${plain(e)}`);
    return null;
  }
}

// flood.prepare(G, {grid:'fine', river_poly}) once after the fine grid loads (b15's hook, CONTRACT A7.3).
// The fine grid's land cover (lc class 80) is already in G.fine.lc from grid/lc.json.
function prepareFlood() {
  if (floodReady) return floodReady;
  floodReady = (async () => {
    await modulesReady;
    if (!mods.flood || typeof mods.flood.prepare !== 'function') return null;
    const g = await gridReady.fine.catch(() => null);
    if (!g) return null;
    if (!g.lc) console.warn('[engine] the fine land cover is not loaded: the normal river is drawn from its outline only');
    const river_poly = await optional('feat/river_poly.geojson', 'json');
    return mods.flood.prepare(G, { grid: 'fine', river_poly });
  })();
  floodReady.catch((e) => console.warn('[engine] flood preparation failed: ' + plain(e)));
  return floodReady;
}

// impact.prepare(G, {...}) once after the grids load; every layer optional (b16's hook).
function prepareImpact() {
  if (impactReady) return impactReady;
  impactReady = (async () => {
    if (!mods.impact || typeof mods.impact.prepare !== 'function') return null;
    await Promise.allSettled(Object.values(gridReady));
    const get = optional;
    const [bin, meta, roads, roads_fine, rail, places] = await Promise.all([
      get('feat/buildings.bin', 'bin'),
      get('feat/buildings.json', 'json'),
      get('feat/roads.geojson', 'json'),
      get('feat/roads_fine.geojson', 'json'),
      get('feat/rail.geojson', 'json'),
      get('feat/places.geojson', 'json'),
    ]);
    return mods.impact.prepare(G, { buildings: bin && meta ? { bin, meta } : null, roads, roads_fine, rail, places });
  })();
  impactReady.catch(() => {});
  return impactReady;
}

function firstParam(fn) {
  const s = Function.prototype.toString.call(fn);
  const m = s.match(/^(?:async\s+)?(?:function\s*\*?\s*[\w$]*\s*)?\(?\s*([A-Za-z_$][\w$]*)/);
  return m ? m[1] : '';
}

async function gridFor(name) {
  const n = name || 'wide';
  if (!gridReady[n]) throw new Error(`grid ${n} is not part of this simulator`);
  return gridReady[n];
}

// Typed arrays in a result go back as transfers, never a buffer that belongs to a loaded grid.
function transfers(value) {
  const own = new Set();
  for (const k of ['wide', 'fine']) {
    const g = G[k];
    if (g) for (const a of [g.dem, g.dir, g.acc, g.hand, g.lc]) if (a) own.add(a.buffer);
  }
  const out = new Set();
  const seen = new Set();
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 4 || seen.has(v)) return;
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      if (v.buffer instanceof ArrayBuffer && !own.has(v.buffer)) out.add(v.buffer);
      return;
    }
    if (v instanceof ArrayBuffer) {
      if (!own.has(v)) out.add(v);
      return;
    }
    for (const k in v) walk(v[k], depth + 1);
  };
  walk(value, 0);
  return [...out];
}

async function call(name, args) {
  const dot = String(name || '').indexOf('.');
  const modName = name.slice(0, dot);
  const fnName = name.slice(dot + 1);
  await modulesReady;
  const mod = mods[modName];
  if (!mod) throw new Error(`engine module ${modName} is not available`);
  const fn = mod[fnName];
  if (typeof fn !== 'function') throw new Error(`engine function ${name} does not exist`);
  if (modName === 'impact' && fnName !== 'prepare' && fnName !== 'indexBuildings') await prepareImpact();
  if (modName === 'flood' && fnName !== 'prepare' && (!args || args.grid === undefined || args.grid === 'fine')) {
    await prepareFlood().catch(() => null);
  }
  const p = firstParam(fn);
  if (p === 'G') {
    await gridFor(args && args.grid);
    return fn(G, args || {});
  }
  if (p === 'g') {
    if (Array.isArray(args)) {
      const [gname, ...rest] = args;
      return fn(await gridFor(gname), ...rest);
    }
    return fn(await gridFor(args && args.grid), args);
  }
  return Array.isArray(args) ? fn(...args) : fn(args);
}

const modulesReady = loadModules();

self.onmessage = async (ev) => {
  const m = ev.data || {};
  if (m.type === 'init') {
    urlTemplate = m.urlTemplate;
    const names = m.grids || ['wide', 'fine'];
    // wide first, then fine (the fine pack is only needed for flood extent)
    startGrid(names[0]);
    for (const n of names.slice(1)) {
      gridReady[n] = gridReady[names[0]].catch(() => null).then(() => startGrid(n));
      gridReady[n].catch(() => {});
    }
    if (gridReady.fine) gridReady.fine.then(() => prepareFlood(), () => null);
    Promise.allSettled(names.map((n) => gridReady[n])).then(() => modulesReady).then(() => prepareImpact());
    return;
  }
  if (m.type === 'call') {
    try {
      const value = await call(m.name, m.args);
      let list = [];
      try {
        list = transfers(value);
        post({ type: 'result', id: m.id, ok: true, value }, list);
      } catch {
        post({ type: 'result', id: m.id, ok: true, value }); // not transferable: copy
      }
    } catch (e) {
      post({ type: 'result', id: m.id, ok: false, error: plain(e) });
    }
  }
};
