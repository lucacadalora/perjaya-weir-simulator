// Loading line. Owner: lane b01. CONTRACT 2.9 ("never quiet").
// Started by main.js before any module loads (not in MODULES). Fed by ctx.data.onProgress and by the store key
// `engine.state` (written by lane b11: 'loading' | 'ready' | 'error' or any other word).
// Phases on #loading[data-phase]: 'boot' (centred box while modules start) and 'bg' (after app:ready, shown only
// while files or the engine are still loading). Lane b02 styles both; this file only writes text and attributes.
//   startLoading(ctx) -> { done() }   (main.js calls done() when boot is over)

export function startLoading(ctx) {
  const el = document.getElementById('loading');
  if (!el) return { done() {} };
  const { store, t } = ctx;
  let phase = 'boot';
  let prog = { started: 0, finished: 0, path: '' };
  let queued = false;

  // Keep the seed's first span (data-t="app.loading") and bar; add one detail line.
  let detail = el.querySelector('.loading__detail');
  if (!detail) {
    detail = document.createElement('span');
    detail.className = 'loading__detail label';
    const bar = el.querySelector('.loading-bar');
    el.insertBefore(detail, bar || null);
  }
  el.dataset.phase = phase;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  const engineState = () => {
    const e = store.get('engine');
    return e && typeof e === 'object' ? e.state : e;
  };

  function shortName(path) {
    const p = String(path || '').split('?')[0];
    return p.split('/').pop();
  }

  function render() {
    queued = false;
    const pending = prog.started - prog.finished;
    const es = engineState();
    const engineBusy = es === 'loading' || es === 'starting';
    let text = '';
    if (pending > 0) {
      text = t('loading.files', 'Loading data: {done} of {total} files · {name}', {
        done: prog.finished,
        total: prog.started,
        name: shortName(prog.path),
      });
    } else if (engineBusy) {
      const e = store.get('engine');
      const pr = e && typeof e === 'object' && Number.isFinite(e.progress) ? e.progress : null;
      text = t('loading.engine', 'Preparing the terrain grids for the model') + (pr != null ? ' · ' + ctx.fmt.pct(pr) : '');
    } else if (es === 'error') {
      text = t('loading.engine_error', 'The model could not start; the map still works');
    } else if (phase === 'boot') {
      text = t('loading.modules', 'Starting the simulator');
    }
    detail.textContent = text;
    if (phase === 'bg') {
      const show = pending > 0 || engineBusy;
      if (show) el.removeAttribute('hidden');
      else el.setAttribute('hidden', '');
    }
  }

  // Coalesce: many progress events arrive in one burst.
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(render);
  };

  ctx.data.onProgress((p) => {
    prog = p;
    schedule();
  });
  store.on('engine', schedule);
  store.on('lang', schedule);
  render();

  // During boot, count the parts being started (called by main.js before each module).
  ctx.bootStep = (n, total) => {
    if (phase !== 'boot' || prog.started > prog.finished) return;
    detail.textContent = t('loading.module', 'Starting the simulator: part {n} of {total}', { n, total });
  };

  return {
    done() {
      phase = 'bg';
      el.dataset.phase = phase;
      // The boot title line is replaced by the detail line alone in the background phase.
      const head = el.querySelector('[data-t="app.loading"]');
      if (head) head.setAttribute('hidden', '');
      render();
    },
  };
}

// Not in MODULES; harmless if somebody lists it.
export async function init() {}
