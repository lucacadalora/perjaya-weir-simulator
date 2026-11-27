// Engine client (lane b11): starts the engine worker and sets ctx.engine (CONTRACT 4.2, 4.8).
//   ctx.engine.call('module.function', args, {transfer}) -> Promise (rejects with a plain Error)
//   ctx.engine.ready -> Promise that resolves when the wide grid is in the worker (rejects if it cannot load)
//   ctx.engine.gridReady(name) -> Promise for one grid ('wide' or 'fine')
//   ctx.engine.meta(name) -> the grid's json header or null · ctx.engine.modules -> {loaded:[], failed:{}}
// Store key `engine` = { state: 'loading'|'ready'|'error', loaded: [grid names in the worker], error: text|null,
//   progress: 0..1 (all packs), fine: 'loading'|'ready'|'error' }. 'ready' means the wide grid is usable.
// Fields `grid.meta:wide` and `grid.meta:fine` hold the json headers as soon as they arrive.
// Nothing here blocks the first frame: init() only starts the worker and returns.

const GRIDS = ['wide', 'fine'];

export async function init(ctx) {
  if (!ctx || !ctx.store) return;
  if (typeof Worker === 'undefined') {
    ctx.store.set('engine', { state: 'error', loaded: [], error: 'no worker support', progress: 0, fine: 'error' });
    return;
  }
  const store = ctx.store;
  const state = { state: 'loading', loaded: [], error: null, progress: 0, fine: 'loading' };
  const publish = () => store.set('engine', { ...state, loaded: [...state.loaded] });
  publish();

  let worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'engine' });
  } catch (e) {
    state.state = 'error';
    state.error = 'the engine could not start';
    publish();
    console.error('[engine] worker failed to start', e);
    return;
  }

  const pending = new Map();
  let nextId = 1;
  const metas = {};
  const waiters = {};
  for (const n of GRIDS) {
    let res;
    let rej;
    const p = new Promise((a, b) => ((res = a), (rej = b)));
    p.catch(() => {});
    waiters[n] = { p, res, rej };
  }
  const prog = {}; // grid -> done / total
  const modules = { loaded: [], failed: {} };

  worker.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.type === 'result') {
      const job = pending.get(m.id);
      if (!job) return;
      pending.delete(m.id);
      if (m.ok) job.resolve(m.value);
      else job.reject(new Error(m.error || 'engine call failed'));
    } else if (m.type === 'progress') {
      prog[m.grid] = m.total ? m.done / m.total : 0;
      state.progress = GRIDS.reduce((a, n) => a + (prog[n] || 0), 0) / GRIDS.length;
      publish();
    } else if (m.type === 'meta') {
      metas[m.grid] = m.meta;
      if (ctx.fields) ctx.fields.set('grid.meta:' + m.grid, m.meta);
    } else if (m.type === 'grid') {
      if (m.state === 'ready') {
        if (!state.loaded.includes(m.grid)) state.loaded.push(m.grid);
        prog[m.grid] = 1;
        waiters[m.grid]?.res(true);
      } else {
        waiters[m.grid]?.rej(new Error('the ' + m.grid + ' terrain grid could not load'));
        console.error('[engine] grid ' + m.grid + ' failed: ' + m.error);
      }
      if (m.grid === 'wide') {
        state.state = m.state === 'ready' ? 'ready' : 'error';
        if (m.state !== 'ready') state.error = 'the terrain grid could not load';
      }
      if (m.grid === 'fine') state.fine = m.state === 'ready' ? 'ready' : 'error';
      state.progress = GRIDS.reduce((a, n) => a + (prog[n] || 0), 0) / GRIDS.length;
      publish();
    } else if (m.type === 'modules') {
      modules.loaded = m.loaded || [];
      modules.failed = m.failed || {};
      for (const [k, v] of Object.entries(modules.failed)) {
        if (!/Failed to fetch|error loading dynamically|Importing a module script failed|Cannot find module/i.test(v)) {
          console.error('[engine] module ' + k + ' failed: ' + v);
        } else ctx.log && ctx.log('engine module not there yet:', k);
      }
    }
  };
  worker.onerror = (e) => {
    e.preventDefault?.();
    console.error('[engine] worker error', e.message || e);
    state.state = 'error';
    state.error = 'the engine stopped';
    publish();
    for (const job of pending.values()) job.reject(new Error('the engine stopped'));
    pending.clear();
  };

  // the worker fetches with the same build stamp as ctx.data
  const tmpl = ctx.data && ctx.data.url ? ctx.data.url('__PATH__') : './data/__PATH__';
  worker.postMessage({ type: 'init', urlTemplate: new URL(tmpl, location.href).href, grids: GRIDS });

  const call = (name, args, opts = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ type: 'call', id, name, args }, opts.transfer || []);
      } catch (e) {
        pending.delete(id);
        reject(new Error('engine call ' + name + ' could not be sent'));
      }
    });

  ctx.engine = {
    call,
    ready: waiters.wide.p,
    gridReady: (n) => (waiters[n] ? waiters[n].p : Promise.reject(new Error('no grid ' + n))),
    meta: (n) => metas[n] || null,
    get modules() {
      return modules;
    },
    get state() {
      return store.get('engine');
    },
  };
}
