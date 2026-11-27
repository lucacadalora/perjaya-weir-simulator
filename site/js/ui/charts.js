// Small SVG charts. FROZEN API (CONTRACT section 4.6). Owner: lane b19.
//   lineChart(el, opts) -> { update(opts), destroy() }   opts: { x:[], series:[{name, y:[], color, fill, dashed}],
//       height, yMin, yMax, yLabel, xFormat(v), yFormat(v), markers:[{x, label, color}], bands:[{from, to, color}],
//       now: {x, label} (a now-marker), xTicks: [x values] (optional; otherwise tidy ticks), tipFormat(x) (optional) }
//   barChart(el, opts)  -> { update(opts), destroy() }   opts: { labels:[], values:[], highlight, height, yLabel,
//       yFormat(v), color, tipLabels:[] (optional, longer names for the tooltip) }
// Additive over the seed: a tooltip on hover (and touch), tidy ticks, a now-marker, redraw on resize.
// Colours come from CSS variables so the look lane restyles charts without touching this file.
// Classes used (styled by b02): .chart .chart-grid .chart-tick .chart-label .chart-now .chart-hover .chart-tip

const NS = 'http://www.w3.org/2000/svg';
const node = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== '' && v != null) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};
const finite = (a) => a.filter((v) => Number.isFinite(v));
const minOf = (a) => a.reduce((m, v) => (v < m ? v : m), Infinity);
const maxOf = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);

// Tidy ticks: about `n` round values (1, 2, 2.5, 5 times a power of ten) covering [a, b].
export function niceTicks(a, b, n = 4) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
  if (a === b) return [a];
  const raw = (b - a) / Math.max(1, n);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || 10 * p;
  const out = [];
  for (let v = Math.ceil(a / step - 1e-9) * step; v <= b + step * 1e-9; v += step) out.push(Math.round(v / step) * step + 0); // + 0 turns -0 into 0
  return out;
}
const defaultYf = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10);

function frame(el, height, state) {
  const w = Math.max(200, el.clientWidth || state.lastW || 320);
  state.lastW = el.clientWidth || state.lastW;
  const svg = node('svg', { viewBox: `0 0 ${w} ${height}`, width: '100%', height, class: 'chart', role: 'img' });
  // keep the tooltip element, replace only the drawing
  el.querySelector(':scope > svg.chart')?.remove();
  el.prepend(svg);
  return { svg, w, h: height, l: 40, r: 10, t: 14, b: 20 };
}

// A tooltip div inside `el` (positioned over the chart). Created once per chart.
// Base look of the tooltip at zero specificity (:where), so the stylesheet (b02) overrides it freely.
function baseStyle() {
  if (document.getElementById('chart-base-style')) return;
  const st = document.createElement('style');
  st.id = 'chart-base-style';
  st.textContent =
    ':where(.chart-tip){background:var(--panel,#fff);border:1px solid var(--line,#ccc);border-radius:var(--radius,4px);padding:4px 7px;font:11px/1.35 var(--font,sans-serif);color:var(--ink,#111);font-variant-numeric:tabular-nums;box-shadow:0 1px 3px rgba(0,0,0,.12)}' +
    ':where(.chart-tip__head){font:600 10.5px/1.4 var(--mono,monospace);color:var(--ink-2,#444)}';
  document.head.append(st);
}
function tipFor(el) {
  baseStyle();
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  let tip = el.querySelector(':scope > .chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.setAttribute('role', 'status');
    tip.hidden = true;
    Object.assign(tip.style, { position: 'absolute', pointerEvents: 'none', zIndex: 2, whiteSpace: 'nowrap' });
    el.append(tip);
  }
  return tip;
}
function showTip(el, tip, rows, px, py, f) {
  tip.replaceChildren(
    ...rows.map((r, i) => {
      const d = document.createElement('div');
      if (i === 0) d.className = 'chart-tip__head';
      if (r.color) {
        const s = document.createElement('i');
        s.className = 'chart-tip__swatch';
        Object.assign(s.style, { display: 'inline-block', width: '8px', height: '8px', marginRight: '5px', background: r.color });
        d.append(s);
      }
      d.append(document.createTextNode(r.text));
      return d;
    }),
  );
  tip.hidden = false;
  const scale = (el.clientWidth || f.w) / f.w;
  const x = px * scale;
  const tw = tip.offsetWidth || 120;
  const left = x + 10 + tw > (el.clientWidth || f.w) ? x - 10 - tw : x + 10;
  tip.style.left = Math.max(0, left) + 'px';
  tip.style.top = Math.max(0, py * scale - 8) + 'px';
}

function watchSize(el, redraw, state) {
  if (typeof ResizeObserver === 'undefined') return () => {};
  const ro = new ResizeObserver(() => {
    const w = el.clientWidth;
    if (w && Math.abs(w - (state.lastW || 0)) > 1) redraw();
  });
  ro.observe(el);
  return () => ro.disconnect();
}

function nearest(xs, v) {
  // xs ascending (gaps as NaN are skipped): binary search on the finite neighbours
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < v) lo = mid;
    else hi = mid;
  }
  return Math.abs(xs[lo] - v) <= Math.abs(xs[hi] - v) ? lo : hi;
}

export function lineChart(el, opts) {
  let o = opts || {};
  const state = {};
  const tip = tipFor(el);
  function draw() {
    const f = frame(el, o.height || 140, state);
    tip.hidden = true;
    const xs = o.x || [];
    const series = o.series || [];
    const all = finite(series.flatMap((s) => Array.from(s.y || [])));
    const fx = finite(Array.from(xs));
    if (!fx.length || !all.length) return;
    const x0 = minOf(fx);
    const x1 = maxOf(fx);
    let y0 = o.yMin ?? Math.min(0, minOf(all));
    let y1 = o.yMax ?? (maxOf(all) || 1) * 1.08;
    const yt = niceTicks(y0, y1, 3);
    if (o.yMax == null && yt.length && yt[yt.length - 1] < y1) {
      const st = yt.length > 1 ? yt[1] - yt[0] : y1;
      y1 = yt[yt.length - 1] + st;
      yt.push(y1);
    }
    if (o.yMin == null && yt.length) y0 = Math.min(y0, yt[0]);
    const X = (v) => f.l + ((v - x0) / (x1 - x0 || 1)) * (f.w - f.l - f.r);
    const Y = (v) => f.h - f.b - ((v - y0) / (y1 - y0 || 1)) * (f.h - f.t - f.b);
    const yf = o.yFormat || defaultYf;
    for (const b of o.bands || []) f.svg.append(node('rect', { x: X(b.from), y: f.t, width: Math.max(0, X(b.to) - X(b.from)), height: f.h - f.t - f.b, fill: b.color || 'var(--chart-band)' }));
    for (const v of yt) {
      if (v < y0 - 1e-9 || v > y1 + 1e-9) continue;
      f.svg.append(node('line', { x1: f.l, x2: f.w - f.r, y1: Y(v), y2: Y(v), class: 'chart-grid' }));
      f.svg.append(node('text', { x: f.l - 5, y: Y(v) + 3, 'text-anchor': 'end', class: 'chart-tick' }, yf(v)));
    }
    if (o.xFormat) {
      const xt = o.xTicks ? o.xTicks.filter((v) => v >= x0 && v <= x1) : niceTicks(x0, x1, 4);
      let lastRight = -Infinity;
      for (const v of xt) {
        const label = String(o.xFormat(v));
        const px = X(v);
        const half = label.length * 3.1;
        const anchor = px - half < f.l - 4 ? 'start' : px + half > f.w ? 'end' : 'middle';
        const left = anchor === 'start' ? px : anchor === 'end' ? px - 2 * half : px - half;
        if (left < lastRight + 6) continue; // never overlap tick labels
        lastRight = left + 2 * half;
        f.svg.append(node('line', { x1: px, x2: px, y1: f.h - f.b, y2: f.h - f.b + 3, class: 'chart-grid' }));
        f.svg.append(node('text', { x: px, y: f.h - 5, 'text-anchor': anchor, class: 'chart-tick' }, label));
      }
    }
    f.svg.append(node('line', { x1: f.l, x2: f.w - f.r, y1: Y(y0), y2: Y(y0), class: 'chart-grid' }));
    if (o.yLabel) f.svg.append(node('text', { x: f.l, y: f.t - 4, class: 'chart-label' }, o.yLabel));
    series.forEach((s, si) => {
      let d = '';
      let pen = false;
      let first = null;
      let last = null;
      const ys = s.y || [];
      for (let i = 0; i < ys.length; i++) {
        const v = ys[i];
        if (!Number.isFinite(v) || !Number.isFinite(xs[i])) {
          pen = false;
          continue;
        }
        d += (pen ? 'L' : 'M') + X(xs[i]).toFixed(1) + ' ' + Y(v).toFixed(1);
        if (first == null) first = xs[i];
        last = xs[i];
        pen = true;
      }
      if (!d) return;
      const color = s.color || `var(--chart-${si + 1})`;
      if (s.fill) f.svg.append(node('path', { d: d + `L${X(last).toFixed(1)} ${Y(y0)}L${X(first).toFixed(1)} ${Y(y0)}Z`, fill: color, opacity: 0.14 }));
      f.svg.append(node('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.6, 'stroke-dasharray': s.dashed ? '4 3' : '', 'stroke-linejoin': 'round' }));
    });
    for (const m of o.markers || []) {
      if (!(m.x >= x0 && m.x <= x1)) continue;
      f.svg.append(node('line', { x1: X(m.x), x2: X(m.x), y1: f.t, y2: f.h - f.b, stroke: m.color || 'var(--chart-mark)', 'stroke-width': 1 }));
      if (m.label) f.svg.append(node('text', { x: X(m.x) + 3, y: f.t + 9, class: 'chart-tick' }, m.label));
    }
    if (o.now && o.now.x >= x0 && o.now.x <= x1) {
      const px = X(o.now.x);
      f.svg.append(node('line', { x1: px, x2: px, y1: f.t - 2, y2: f.h - f.b, class: 'chart-now', stroke: 'var(--chart-mark)', 'stroke-width': 1.4 }));
      if (o.now.label) {
        const right = px > f.w - 60;
        f.svg.append(node('text', { x: right ? px - 3 : px + 3, y: f.t + 8, 'text-anchor': right ? 'end' : 'start', class: 'chart-label chart-now' }, o.now.label));
      }
    }
    // hover: a guide line and the tooltip
    const guide = node('line', { y1: f.t, y2: f.h - f.b, class: 'chart-hover', stroke: 'var(--ink-3)', 'stroke-width': 1, 'stroke-dasharray': '2 2', visibility: 'hidden' });
    f.svg.append(guide);
    const hit = node('rect', { x: f.l, y: 0, width: f.w - f.l - f.r, height: f.h, fill: 'transparent' });
    f.svg.append(hit);
    const move = (ev) => {
      const r = f.svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / (r.width || 1)) * f.w;
      const xv = x0 + ((px - f.l) / (f.w - f.l - f.r || 1)) * (x1 - x0);
      const i = nearest(xs, xv);
      const rows = [{ text: (o.tipFormat || o.xFormat || String)(xs[i]) }];
      series.forEach((s, si) => {
        const v = s.y?.[i];
        if (Number.isFinite(v)) rows.push({ text: (s.name ? s.name + ': ' : '') + yf(v), color: s.color || `var(--chart-${si + 1})` });
      });
      guide.setAttribute('x1', X(xs[i]));
      guide.setAttribute('x2', X(xs[i]));
      guide.setAttribute('visibility', 'visible');
      showTip(el, tip, rows, X(xs[i]), f.t, f);
    };
    const leave = () => {
      tip.hidden = true;
      guide.setAttribute('visibility', 'hidden');
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', leave);
  }
  draw();
  const unwatch = watchSize(el, draw, state);
  return {
    update: (next) => ((o = { ...o, ...next }), draw()),
    destroy: () => (unwatch(), el.replaceChildren()),
    _hover: (fraction) => {
      // test hook: show the tooltip at a fraction of the plot width
      const svg = el.querySelector(':scope > svg.chart');
      const rect = svg?.querySelector('rect[fill="transparent"]');
      if (!rect) return;
      const r = svg.getBoundingClientRect();
      const ev = new PointerEvent('pointermove', { clientX: r.left + r.width * (0.1 + 0.88 * fraction), clientY: r.top + 20, bubbles: true });
      rect.dispatchEvent(ev);
    },
  };
}

export function barChart(el, opts) {
  let o = opts || {};
  const state = {};
  const tip = tipFor(el);
  function draw() {
    const f = frame(el, o.height || 110, state);
    tip.hidden = true;
    const vals = Array.from(o.values || []);
    const n = vals.length;
    if (!n) return;
    const top = maxOf(finite(vals));
    const yt = niceTicks(0, Number.isFinite(top) && top > 0 ? top : 1, 3);
    const ymax = Math.max(yt[yt.length - 1] || 1, top || 0, 1e-9);
    const yf = o.yFormat || ((v) => Math.round(v));
    const Y = (v) => f.h - f.b - (v / ymax) * (f.h - f.t - f.b);
    for (const v of yt) {
      f.svg.append(node('line', { x1: f.l, x2: f.w - f.r, y1: Y(v), y2: Y(v), class: 'chart-grid' }));
      f.svg.append(node('text', { x: f.l - 5, y: Y(v) + 3, 'text-anchor': 'end', class: 'chart-tick' }, yf(v)));
    }
    if (o.yLabel) f.svg.append(node('text', { x: f.l, y: f.t - 4, class: 'chart-label' }, o.yLabel));
    const bw = (f.w - f.l - f.r) / n;
    const bars = [];
    vals.forEach((v, i) => {
      const hi = i === o.highlight;
      const hgt = Math.max(0, Y(0) - Y(Number.isFinite(v) ? v : 0));
      const r = node('rect', { x: f.l + i * bw + 1.5, y: Y(0) - hgt, width: Math.max(1, bw - 3), height: hgt, fill: hi ? 'var(--chart-hi)' : o.color || 'var(--chart-1)', opacity: hi ? 1 : 0.45, class: hi ? 'chart-bar chart-bar--hi' : 'chart-bar' });
      f.svg.append(r);
      bars.push(r);
      if (o.labels?.[i] != null) f.svg.append(node('text', { x: f.l + i * bw + bw / 2, y: f.h - 6, 'text-anchor': 'middle', class: hi ? 'chart-label' : 'chart-tick' }, o.labels[i]));
    });
    const hit = node('rect', { x: f.l, y: 0, width: f.w - f.l - f.r, height: f.h, fill: 'transparent' });
    f.svg.append(hit);
    const move = (ev) => {
      const r = f.svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / (r.width || 1)) * f.w;
      const i = Math.max(0, Math.min(n - 1, Math.floor((px - f.l) / bw)));
      bars.forEach((b, j) => b.setAttribute('stroke', j === i ? 'var(--ink)' : 'none'));
      const name = o.tipLabels?.[i] ?? o.labels?.[i] ?? String(i + 1);
      showTip(el, tip, [{ text: String(name) }, { text: Number.isFinite(vals[i]) ? yf(vals[i]) : '–' }], f.l + i * bw + bw / 2, f.t, f);
    };
    const leave = () => {
      tip.hidden = true;
      bars.forEach((b) => b.setAttribute('stroke', 'none'));
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', leave);
  }
  draw();
  const unwatch = watchSize(el, draw, state);
  return { update: (next) => ((o = { ...o, ...next }), draw()), destroy: () => (unwatch(), el.replaceChildren()) };
}
