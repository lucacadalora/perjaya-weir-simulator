// Data loader with a cache and a progress signal. FROZEN API (CONTRACT section 4.2).
//   json(path) · bin(path) -> ArrayBuffer · text(path) · url(path) · onProgress(fn) -> off()
// Paths are relative to site/data/ ("grid/wide.json"). Every request carries the build stamp so a cached
// copy of an older release is never served. A failed request rejects with an Error that names the path.

export function createData(base = './data/') {
  const cache = new Map();
  const listeners = new Set();
  const stamp = (typeof window !== 'undefined' && window.__BUILD) || '';
  let started = 0;
  let finished = 0;
  let bytes = 0;

  const url = (path) => base + path + (stamp ? (path.includes('?') ? '&' : '?') + 'v=' + stamp : '');

  function tell(path, state) {
    for (const fn of [...listeners]) {
      try {
        fn({ started, finished, bytes, path, state });
      } catch (e) {
        console.error('[data] progress listener failed', e);
      }
    }
  }

  function load(path, kind) {
    const key = kind + ':' + path;
    if (cache.has(key)) return cache.get(key);
    started++;
    tell(path, 'start');
    const p = fetch(url(path))
      .then((r) => {
        if (!r.ok) throw new Error('data ' + path + ': HTTP ' + r.status);
        return kind === 'json' ? r.json() : kind === 'text' ? r.text() : r.arrayBuffer();
      })
      .then((v) => {
        finished++;
        if (v && v.byteLength) bytes += v.byteLength;
        tell(path, 'done');
        return v;
      })
      .catch((e) => {
        finished++;
        cache.delete(key);
        tell(path, 'error');
        throw e;
      });
    cache.set(key, p);
    return p;
  }

  return {
    url,
    json: (path) => load(path, 'json'),
    bin: (path) => load(path, 'bin'),
    text: (path) => load(path, 'text'),
    onProgress(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
