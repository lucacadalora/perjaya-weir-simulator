// Tiny observable store. FROZEN API (CONTRACT section 4.1): extend, never break.
//   get(path) · set(path, value) · patch(path, object) · on(path, fn, {immediate}) -> off()
//   emit(event, payload) · listen(event, fn) -> off() · snapshot()
// Paths are dot-separated ("weir.pond_el"). A change at a path notifies that path, every ancestor
// and every subscribed descendant. Subscribers get (value, path). A failing subscriber never stops the others.

export function createStore(initial = {}) {
  const state = structuredClone(initial);
  const subs = new Map(); // path -> Set<fn>
  const evts = new Map(); // event -> Set<fn>
  const split = (p) => (p ? String(p).split('.') : []);

  function get(path) {
    let o = state;
    for (const k of split(path)) {
      if (o == null) return undefined;
      o = o[k];
    }
    return o;
  }

  function fire(p, seen) {
    if (seen.has(p)) return;
    seen.add(p);
    const s = subs.get(p);
    if (!s) return;
    for (const fn of [...s]) {
      try {
        fn(get(p), p);
      } catch (e) {
        console.error('[store] subscriber failed at "' + p + '"', e);
      }
    }
  }

  function notify(path) {
    const parts = split(path);
    const seen = new Set();
    for (let i = parts.length; i >= 0; i--) fire(parts.slice(0, i).join('.'), seen);
    const prefix = path + '.';
    for (const p of [...subs.keys()]) if (p.startsWith(prefix)) fire(p, seen);
  }

  function set(path, value) {
    const parts = split(path);
    if (!parts.length) throw new Error('store.set needs a path');
    let o = state;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
      o = o[k];
    }
    const last = parts[parts.length - 1];
    const same = Object.is(o[last], value) && (value === null || typeof value !== 'object');
    if (same) return;
    o[last] = value;
    notify(path);
  }

  // Shallow merge into the object at path (creates it when missing).
  function patch(path, obj) {
    const cur = get(path);
    set(path, Object.assign({}, cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}, obj));
  }

  function on(path, fn, opts = {}) {
    const p = path || '';
    if (!subs.has(p)) subs.set(p, new Set());
    subs.get(p).add(fn);
    if (opts.immediate) {
      try {
        fn(get(p), p);
      } catch (e) {
        console.error('[store] subscriber failed at "' + p + '"', e);
      }
    }
    return () => subs.get(p)?.delete(fn);
  }

  function emit(event, payload) {
    const s = evts.get(event);
    if (!s) return;
    for (const fn of [...s]) {
      try {
        fn(payload, event);
      } catch (e) {
        console.error('[store] listener failed for "' + event + '"', e);
      }
    }
  }

  function listen(event, fn) {
    if (!evts.has(event)) evts.set(event, new Set());
    evts.get(event).add(fn);
    return () => evts.get(event)?.delete(fn);
  }

  const snapshot = () => structuredClone(state);

  return { get, set, patch, on, emit, listen, snapshot };
}
