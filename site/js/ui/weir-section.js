// Live section drawing of Bendung Perjaya, in the style of a sheet from an engineering office. Owner: lane b20.
//   readWeir(weirJson, params) -> desc       geometry and levels in project EL (CONTRACT 2.3), tolerant of missing data
//   mountWeirSection(el, ctx, {bay}) -> { setBay(i), redraw(), destroy() }
// Two views in one SVG: the upstream elevation with every bay in order from the left bank (gates lift with their
// openings, pond and tail lines with EL labels) and a section through one bay (sill, gate, pond, tailwater, stilling
// basin) with a level scale. It redraws from the store (`weir.*`); gate movement eases on the `frame` event.
// No hydraulics here: levels and openings come from the store (s01, b14) and the controls (tab-operasi).

const V = (x) => (x && typeof x === 'object' && 'v' in x ? x.v : x);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
function pick(o, ...names) {
  if (!o || typeof o !== 'object') return undefined;
  for (const n of names) {
    const v = Number(V(o[n]));
    if (o[n] != null && Number.isFinite(v)) return v;
  }
  return undefined;
}

// FALLBACK: used only while site/data/weir.json is absent or silent. The widths, gate heights, the design high
// water and the intake level are SETTLE.md item 7; every other level (sills, bed, basin, deck, hoist deck) and the
// bay order (flood gates from the left bank, the two 3.9 m gates last, the three sluices on the right bank beside
// the intake) are assumptions for the drawing only, shown with status A.
const FALLBACK = {
  // FALLBACK
  bays: [
    ...[2.9, 2.9, 2.9, 2.9, 2.9, 3.9, 3.9].map((h) => ({ kind: 'flood', width: 20.0, gate_h: h, sill_el: 81.0 - h })),
    ...[1, 2, 3].map(() => ({ kind: 'sluice', width: 12.5, gate_h: 4.2, sill_el: 76.8, under: { h: 2.0, sill_el: 74.8 } })),
  ],
  pier_w: 3.0, // FALLBACK
  abut_w: 5.5, // FALLBACK
  deck_el: 83.0, // FALLBACK
  tower_h: 7.0, // FALLBACK
  tower_fp: [6, 8], // FALLBACK
  bed_el: 74.0, // FALLBACK
  basin_floor_el: 73.0, // FALLBACK
  basin_len: 30.0, // FALLBACK
  end_sill_h: 2.0, // FALLBACK
  lift_max: 4.5, // FALLBACK
  levels: { normal_el: 79.7, design_hw_el: 81.0, intake_el: 79.7 }, // FALLBACK (SETTLE.md item 7, CONTRACT A5)
};

const statusOf = (x) => (x && typeof x === 'object' && x.status) || null;

// Read the weir's geometry and levels from weir.json (lane b18's key names), with params.weir as a second source
// for the levels. What is missing comes from FALLBACK and is listed in `fallback`; `assumed` lists the parts whose
// data carry status A (both are shown in the title block).
export function readWeir(weirJson, params) {
  const w = weirJson && typeof weirJson === 'object' ? weirJson : {};
  const fb = [];
  const assumed = new Set();
  const pw = (params && params.weir) || {};
  const lv = w.levels || {};
  const take = (srcs, fbv, tag) => {
    for (const [o, n] of srcs) {
      const v = pick(o, n);
      if (v !== undefined) {
        if (statusOf(o && o[n]) === 'A') assumed.add(tag);
        return v;
      }
    }
    fb.push(tag);
    return fbv;
  };

  let bays;
  if (Array.isArray(w.bays) && w.bays.length) {
    let nf = 0;
    let ns = 0;
    bays = w.bays.map((b, i) => {
      const kind = String(V(b.kind) || '').toLowerCase().startsWith('slu') ? 'sluice' : 'flood';
      const f = FALLBACK.bays.find((x) => x.kind === kind);
      const width = pick(b, 'width_m');
      const gate_h = pick(b, 'gate_h_m', 'gate_height_m');
      const sill = pick(b, 'sill_el');
      if (width === undefined || gate_h === undefined || sill === undefined) fb.push('bays');
      if (statusOf(b.sill_el) === 'A') assumed.add('sill');
      const uh = pick(b, 'under_h_m');
      const s0 = sill ?? (kind === 'sluice' ? f.under.sill_el : f.sill_el);
      // b18: for a sluice the under-sluice leaf sits on sill_el and the scouring leaf above it from sill_el + under_h_m
      const under = kind === 'sluice' ? { h: uh ?? f.under.h, sill_el: s0 } : null;
      const xl = pick(b, 'x_left_m');
      return {
        kind,
        id: V(b.id) || null,
        width: width ?? f.width,
        gate_h: gate_h ?? f.gate_h,
        sill_el: under ? s0 + under.h : s0,
        under,
        x_left: xl,
        basin_len: pick(b, 'basin_len_m'),
        end_sill_h: pick(b, 'end_sill_m'),
        no: kind === 'sluice' ? ++ns : ++nf,
        i,
      };
    });
  } else {
    fb.push('bays');
    let nf = 0;
    let ns = 0;
    bays = FALLBACK.bays.map((b, i) => ({ ...b, no: b.kind === 'sluice' ? ++ns : ++nf, i }));
  }
  const ab = w.abutments || {};
  const desc = {
    bays,
    pier_w: take([[w.piers, 'width_m']], FALLBACK.pier_w, 'pier'),
    abut_l: take([[ab, 'left_width_m']], FALLBACK.abut_w, 'abutment'),
    abut_r: take([[ab, 'right_width_m']], FALLBACK.abut_w, 'abutment'),
    deck_el: take([[w.deck, 'el']], FALLBACK.deck_el, 'deck'),
    tower_h: take([[w.deck, 'tower_height_m']], FALLBACK.tower_h, 'deck'),
    bed_el: take([[lv, 'riverbed_el'], [pw, 'riverbed_el']], FALLBACK.bed_el, 'bed'),
    basin_floor_el: take([[w.stilling_basin, 'floor_el']], FALLBACK.basin_floor_el, 'basin'),
    lift_max: take([[w.gates, 'lift_max_m']], FALLBACK.lift_max, 'lift'),
    levels: {
      normal_el: take([[pw, 'pond_normal_el'], [lv, 'pond_normal_el']], FALLBACK.levels.normal_el, 'levels'),
      design_hw_el: take([[pw, 'design_high_water_el'], [lv, 'design_high_water_el']], FALLBACK.levels.design_hw_el, 'levels'),
      intake_el: take([[pw, 'pond_min_intake_el'], [lv, 'pond_min_intake_el']], FALLBACK.levels.intake_el, 'levels'),
    },
  };
  desc.hoist_el = desc.deck_el + desc.tower_h;
  const fp = V(w.deck && w.deck.tower_footprint_m);
  const fpOk = Array.isArray(fp) && fp.length === 2 && fp.every((x) => Number.isFinite(Number(x)));
  if (!fpOk) fb.push('deck');
  desc.tower_w = fpOk ? Number(fp[0]) : FALLBACK.tower_fp[0];
  desc.tower_l = fpOk ? Number(fp[1]) : FALLBACK.tower_fp[1];
  for (const b of bays) {
    if (b.basin_len === undefined) b.basin_len = FALLBACK.basin_len;
    if (b.end_sill_h === undefined) b.end_sill_h = FALLBACK.end_sill_h;
  }
  desc.fallback = [...new Set(fb)];
  desc.assumed = [...assumed];
  desc.found_el = Math.min(desc.basin_floor_el, ...bays.map((b) => (b.under ? b.under.sill_el : b.sill_el))) - 1.5;
  // positions along the axis from the left abutment: from the data when every bay has x_left_m, else laid out
  let x = desc.abut_l;
  for (const b of bays) {
    if (!isNum(b.x_left) || bays.some((c) => !isNum(c.x_left))) b.x_left = x;
    x = b.x_left + b.width + desc.pier_w;
  }
  const last = bays[bays.length - 1];
  desc.length_m = last.x_left + last.width + desc.abut_r;
  return desc;
}

// Leaf of a bay: bottom = sill (under-sluice sill for a sluice), height = whole leaf, so an opening lifts it all.
export function leafOf(bay) {
  if (bay.under) return { sill: bay.under.sill_el, h: bay.sill_el + bay.gate_h - bay.under.sill_el, split: bay.under.h };
  return { sill: bay.sill_el, h: bay.gate_h, split: null };
}

// ---------- drawing helpers (viewBox units) ----------
// Two sheet sizes. 'compact' is the panel's sheet: 360 units drawn about 360 px wide, so every text is at least
// 10 px and only the key labels are written (bay numbers, the pond and tail lines, the design flood and normal
// levels). 'full' is the enlarged sheet over the map: 760 units drawn up to 1,100 px wide, with every label,
// dimension, scale bar and the title block.
const SIZES = {
  compact: { W: 360, full: false, elevH: 150, secH: 188, fs: { 'operasi-t': 10, 'operasi-tk': 10, 'operasi-th': 10.5, 'operasi-tw': 10, 'operasi-tdhw': 10, 'operasi-tnwl': 10, 'operasi-ta': 10.5 } },
  full: { W: 760, full: true, elevH: 300, secH: 380, fs: { 'operasi-t': 9.4, 'operasi-tk': 8.8, 'operasi-th': 10, 'operasi-tw': 9.4, 'operasi-tdhw': 8.8, 'operasi-tnwl': 8.8, 'operasi-ta': 9.6 } },
};
let M = SIZES.compact; // set by draw() before each sheet is drawn (drawing is synchronous)
let W = M.W;
const fz = () => M.fs['operasi-tk']; // the base text size, for row spacing
const r1 = (n) => Math.round(n * 10) / 10;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const line = (x1, y1, x2, y2, cls) => `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" class="${cls}"/>`;
const rect = (x, y, w, h, cls) => `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(Math.max(0, w))}" height="${r1(Math.max(0, h))}" class="${cls}"/>`;
const poly = (pts, cls) => `<polygon points="${pts.map((p) => r1(p[0]) + ',' + r1(p[1])).join(' ')}" class="${cls}"/>`;
const pline = (pts, cls) => `<polyline points="${pts.map((p) => r1(p[0]) + ',' + r1(p[1])).join(' ')}" class="${cls}"/>`;
// Text; with maxW, a string whose estimated mono width (0.6 em) would pass maxW is squeezed to fit.
const text = (x, y, s, cls, anchor = 'start', maxW = 0) => {
  const est = String(s).length * 0.6 * (M.fs[cls] || 10);
  const fit = maxW > 0 && est > maxW ? ` textLength="${r1(maxW)}" lengthAdjust="spacingAndGlyphs"` : '';
  return `<text x="${r1(x)}" y="${r1(y)}" class="${cls}" text-anchor="${anchor}"${fit}>${esc(s)}</text>`;
};
// Water-level symbol: a small inverted triangle sitting on the line, with three short ticks under it.
const wlMark = (x, y, cls = 'operasi-wl') =>
  `<path d="M${r1(x - 3)} ${r1(y - 5)} L${r1(x + 3)} ${r1(y - 5)} L${r1(x)} ${r1(y)} Z" class="${cls}"/>` +
  line(x - 3, y + 1.6, x + 3, y + 1.6, 'operasi-thin') + line(x - 2, y + 3, x + 2, y + 3, 'operasi-thin') + line(x - 1, y + 4.4, x + 1, y + 4.4, 'operasi-thin');

const styleRaw = () => `
.operasi-frame{fill:none;stroke:var(--ink);stroke-width:.8}
.operasi-hair{fill:none;stroke:var(--ink-3);stroke-width:.35}
.operasi-thin{fill:none;stroke:var(--ink);stroke-width:.45}
.operasi-med{fill:none;stroke:var(--ink);stroke-width:.7}
.operasi-cut{fill:url(#operasi-hatch);stroke:var(--ink);stroke-width:1}
.operasi-conc{fill:url(#operasi-hatch);stroke:var(--ink);stroke-width:.6}
.operasi-earth{fill:url(#operasi-earth);stroke:none}
.operasi-gate{fill:var(--panel);stroke:var(--ink);stroke-width:.9}
.operasi-gate-sel{fill:var(--panel);stroke:var(--accent);stroke-width:1.1}
.operasi-hidden{fill:none;stroke:var(--ink-2);stroke-width:.45;stroke-dasharray:2.2 1.6}
.operasi-axis{fill:none;stroke:var(--ink-3);stroke-width:.4;stroke-dasharray:6 1.5 1 1.5}
.operasi-dhw{fill:none;stroke:var(--danger);stroke-width:.5;stroke-dasharray:6 1.5 1 1.5}
.operasi-nwl{fill:none;stroke:var(--ok);stroke-width:.5;stroke-dasharray:6 1.5 1 1.5}
.operasi-water{fill:var(--water);fill-opacity:.2;stroke:none}
.operasi-jet{fill:var(--water);fill-opacity:.38;stroke:none}
.operasi-wline{fill:none;stroke:var(--water-deep);stroke-width:.9}
.operasi-wline-tail{fill:none;stroke:var(--water-deep);stroke-width:.8;stroke-dasharray:3 1.5}
.operasi-wl{fill:var(--panel);stroke:var(--water-deep);stroke-width:.6}
.operasi-tower{fill:var(--panel);stroke:var(--ink);stroke-width:.55}
.operasi-tw,.operasi-tdhw,.operasi-tnwl,.operasi-t,.operasi-tk,.operasi-ta{paint-order:stroke;stroke:var(--panel);stroke-width:2.4px;stroke-linejoin:round}
.operasi-rock{fill:var(--panel);stroke:var(--ink-2);stroke-width:.4}
.operasi-t{font:500 ${M.fs['operasi-t']}px var(--mono);fill:var(--ink-2);font-variant-numeric:tabular-nums}
.operasi-tk{font:500 ${M.fs['operasi-tk']}px var(--mono);fill:var(--ink-3);font-variant-numeric:tabular-nums}
.operasi-th{font:600 ${M.fs['operasi-th']}px var(--mono);fill:var(--ink);letter-spacing:.06em}
.operasi-tw{font:600 ${M.fs['operasi-tw']}px var(--mono);fill:var(--water-deep);font-variant-numeric:tabular-nums}
.operasi-tdhw{font:600 ${M.fs['operasi-tdhw']}px var(--mono);fill:var(--danger)}
.operasi-tnwl{font:600 ${M.fs['operasi-tnwl']}px var(--mono);fill:var(--ok)}
.operasi-ta{font:700 ${M.fs['operasi-ta']}px var(--mono);fill:var(--accent)}
.operasi-hit{fill:transparent;cursor:pointer}
.operasi-hit:hover{fill:var(--accent);fill-opacity:.06}
.operasi-sb{fill:var(--ink);stroke:var(--ink);stroke-width:.4}
.operasi-sw{fill:var(--panel);stroke:var(--ink);stroke-width:.4}
`;
// The sheet's rules, scoped to its size class so the panel sheet and the enlarged sheet keep their own text sizes.
const style = (scope) =>
  '<style>' +
  styleRaw()
    .split('\n')
    .filter((l) => l.includes('{'))
    .map((l) => {
      const k = l.indexOf('{');
      return l.slice(0, k).split(',').map((sel) => '.' + scope + ' ' + sel.trim()).join(',') + l.slice(k);
    })
    .join('\n') +
  '</style>';
const DEFS = `<defs>
<pattern id="operasi-hatch" width="3.2" height="3.2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
<rect width="3.2" height="3.2" fill="var(--panel)"/><line x1="0" y1="0" x2="0" y2="3.2" stroke="var(--ink-3)" stroke-width=".45"/></pattern>
<pattern id="operasi-earth" width="6" height="4" patternUnits="userSpaceOnUse">
<rect width="6" height="4" fill="var(--panel)"/><path d="M0.5 3.5 L2 1.2 M2 3.5 L3.5 1.2 M3.5 3.5 L5 1.2" stroke="var(--ink-3)" stroke-width=".35" opacity=".8"/></pattern>
<marker id="operasi-arr" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L6 3 L0 6 Z" fill="var(--ink)"/></marker>
</defs>`;

// A vertical level scale at x, with ticks every metre and labels every two.
function levelScale(x, Y, elLo, elHi, fmt) {
  const o = [line(x, Y(elLo), x, Y(elHi), 'operasi-med')];
  for (let e = Math.ceil(elLo); e <= Math.floor(elHi); e++) {
    const major = e % 2 === 0;
    o.push(line(x - (major ? 3.5 : 2), Y(e), x, Y(e), 'operasi-thin'));
    if (major) o.push(text(x - 5, Y(e) + fz() * 0.35, '+' + fmt.num(e, 0), 'operasi-tk', 'end'));
  }
  return o.join('');
}

// A scale bar of `metres` at (x, y), alternating black and white quarters.
function scaleBar(x, y, metres, sx, fmt) {
  const q = (metres * sx) / 4;
  const o = [];
  for (let i = 0; i < 4; i++) o.push(rect(x + i * q, y, q, 2.4, i % 2 ? 'operasi-sw' : 'operasi-sb'));
  o.push(text(x, y + 2.4 + fz(), '0', 'operasi-tk', 'middle'), text(x + 4 * q, y + 2.4 + fz(), fmt.num(metres, 0) + ' m', 'operasi-tk', 'middle'));
  return o.join('');
}

// Shown openings per bay (index in the bay list) from the gate and sluice arrays.
export function openingsByBay(desc, gates, sluices) {
  return desc.bays.map((b) => {
    const arr = b.kind === 'sluice' ? sluices : gates;
    const v = Array.isArray(arr) ? Number(arr[b.no - 1]) : NaN;
    return Number.isFinite(v) ? Math.max(0, v) : 0;
  });
}

// Reference levels: design flood level (red), normal pond when it differs, lowest pond that feeds the intake
// (green). Their labels sit in one right-hand column, nudged apart so they never overlap; `extra` adds more labels
// to the same column (the tail water in the section).
function refLines(desc, Y, xa, xb, ctx, extra = []) {
  const { t, fmt } = ctx;
  const lv = desc.levels;
  const o = [line(xa, Y(lv.design_hw_el), xb, Y(lv.design_hw_el), 'operasi-dhw')];
  const labels = [...extra];
  const same = Math.abs(lv.normal_el - lv.design_hw_el) < 0.005;
  const dfl = t('operasi.sec.dfl_short', 'DFL');
  const nwl = t('operasi.sec.nwl_short', 'NWL');
  labels.push({ y: Y(lv.design_hw_el) - 1.8, s: (same ? dfl + ' = ' + nwl : dfl) + ' ' + fmt.num(lv.design_hw_el, 2), cls: 'operasi-tdhw' });
  if (!same) {
    o.push(line(xa, Y(lv.normal_el), xb, Y(lv.normal_el), 'operasi-nwl'));
    labels.push({ y: Y(lv.normal_el) - 1.8, s: nwl + ' ' + fmt.num(lv.normal_el, 2), cls: 'operasi-tnwl' });
  }
  if (Math.abs(lv.intake_el - lv.normal_el) > 0.005 && Math.abs(lv.intake_el - lv.design_hw_el) > 0.005) {
    o.push(line(xa, Y(lv.intake_el), xb, Y(lv.intake_el), 'operasi-nwl'));
    if (M.full) labels.push({ y: Y(lv.intake_el) - 1.8, s: t('operasi.sec.intake_short', 'INTAKE MIN') + ' ' + fmt.num(lv.intake_el, 2), cls: 'operasi-tnwl' });
  }
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < fz() * 1.12) labels[i].y = labels[i - 1].y + fz() * 1.12;
  for (const l of labels) o.push(text(xb, l.y, l.s, l.cls, 'end', (xb - xa) * 0.62));
  return o.join('');
}

// ---------- view 1: upstream elevation (looking downstream, so the left bank is on the left) ----------
function drawElevation(desc, st, top, ctx, sel) {
  const { t, fmt } = ctx;
  const x0 = 40;
  const x1 = W - 8;
  const plotTop = top + fz() * 2.2;
  const plotH = M.elevH;
  const elLo = Math.floor(desc.found_el + 0.5);
  const elHi = Math.ceil(desc.hoist_el + 1);
  const sx = (x1 - x0) / desc.length_m;
  const sy = plotH / (elHi - elLo);
  const Y = (el) => plotTop + plotH - (el - elLo) * sy;
  const yBot = Y(elLo);
  const o = [];
  o.push(text(8, top + fz() * 1.2, t('operasi.sec.elev_title', 'UPSTREAM ELEVATION'), 'operasi-th', 'start', W * 0.5));
  if (M.full) o.push(text(W - 8, top + fz() * 1.2, t('operasi.sec.vscale', 'VERTICAL SCALE ×{k}', { k: fmt.num(sy / sx, 1) }), 'operasi-tk', 'end', W * 0.4));
  o.push(levelScale(30, Y, elLo, elHi, fmt));
  if (M.full) o.push(text(30, yBot + fz() * 1.2, t('operasi.sec.el_axis', 'EL (m)'), 'operasi-tk', 'middle'));

  // bays and piers from the left bank
  const xs = desc.bays.map((b) => [x0 + b.x_left * sx, x0 + (b.x_left + b.width) * sx]);
  // concrete: weir body below each sill, piers and abutments up to the deck, the deck itself
  const deckB = desc.deck_el - 0.9;
  desc.bays.forEach((b, i) => o.push(rect(xs[i][0], Y(leafOf(b).sill), xs[i][1] - xs[i][0], yBot - Y(leafOf(b).sill), 'operasi-conc')));
  const solids = [[x0, xs[0][0]], ...xs.slice(1).map((p, i) => [xs[i][1], p[0]]), [xs[xs.length - 1][1], x1]];
  for (const [a, c] of solids) o.push(rect(a, Y(desc.deck_el), c - a, yBot - Y(desc.deck_el), 'operasi-cut'));
  o.push(rect(x0, Y(desc.deck_el), x1 - x0, Y(deckB) - Y(desc.deck_el), 'operasi-cut'));
  // hoist towers on the piers (seen), each with its roof, and a hoist beam over every bay between them
  const tw = desc.tower_w * sx;
  const towers = xs.slice(1).map((p, i) => (xs[i][1] + p[0]) / 2);
  const edges = [x0, ...towers.map((m) => [m - tw / 2, m + tw / 2]).flat(), x1];
  for (const m of towers) {
    o.push(rect(m - tw / 2, Y(desc.hoist_el), tw, Y(desc.deck_el) - Y(desc.hoist_el), 'operasi-tower'));
    o.push(rect(m - tw / 2 - 1, Y(desc.hoist_el + 0.45), tw + 2, Y(desc.hoist_el) - Y(desc.hoist_el + 0.45), 'operasi-med'));
    o.push(rect(m - tw / 4, Y(desc.hoist_el - 1.6), tw / 2, Y(desc.hoist_el - 2.6) - Y(desc.hoist_el - 1.6), 'operasi-hair'));
  }
  const beamTop = desc.hoist_el - 0.5;
  const beamBot = desc.hoist_el - 1.3;
  for (let k = 0; k + 1 < edges.length; k += 2) o.push(rect(edges[k], Y(beamTop), edges[k + 1] - edges[k], Y(beamBot) - Y(beamTop), 'operasi-thin'));
  // gate leaves lifted by their opening, with their stems up to the hoist
  desc.bays.forEach((b, i) => {
    const [a, c] = xs[i];
    const lf = leafOf(b);
    const op = Math.min(st.open[i], desc.lift_max, beamBot - 0.3 - lf.sill - lf.h);
    const yb = Y(lf.sill + Math.max(0, op));
    const yt = Y(lf.sill + Math.max(0, op) + lf.h);
    o.push(line((a + c) / 2, yt, (a + c) / 2, Y(beamBot), 'operasi-thin'));
    o.push(rect(a - 0.6, yt, c - a + 1.2, yb - yt, i === sel ? 'operasi-gate-sel' : 'operasi-gate'));
    const ribs = lf.split ? [lf.split] : [lf.h / 3, (2 * lf.h) / 3];
    for (const r of ribs) o.push(line(a, Y(lf.sill + op + r), c, Y(lf.sill + op + r), lf.split ? 'operasi-med' : 'operasi-hair'));
    if (op > 0.005) o.push(rect(a, yb, c - a, Y(lf.sill) - yb, 'operasi-hidden'));
  });
  // water: the pond is in front of the structure (tinted), the tail behind it (hidden line)
  if (isNum(st.tail)) {
    o.push(line(x0, Y(st.tail), x1, Y(st.tail), 'operasi-wline-tail'));
    o.push(text(x0 + 3, Y(st.tail) + fz() * 1.05, t('operasi.sec.tail', 'Tail water') + ' EL ' + fmt.el(st.tail), 'operasi-tw'));
  }
  if (isNum(st.pond)) {
    o.push(rect(x0, Y(st.pond), x1 - x0, yBot - Y(st.pond), 'operasi-water'));
    o.push(line(x0, Y(st.pond), x1, Y(st.pond), 'operasi-wline'));
    const px = x0 + (x1 - x0) * 0.36;
    o.push(wlMark(px, Y(st.pond)));
    o.push(text(px + 6, Y(st.pond) - 2.4, t('operasi.sec.pond', 'Pond') + ' EL ' + fmt.el(st.pond), 'operasi-tw'));
  }
  // reference levels on the scale side: normal water level and design flood level
  o.push(refLines(desc, Y, x0 - 8, x1, ctx));
  o.push(line(x0, yBot, x1, yBot, 'operasi-med'));
  // bay numbers, openings, the section mark A on the chosen bay, the banks
  desc.bays.forEach((b, i) => {
    const m = (xs[i][0] + xs[i][1]) / 2;
    const name = b.kind === 'sluice' ? t('operasi.sec.sluice_n', 'S{n}', { n: b.no }) : t('operasi.sec.gate_n', 'G{n}', { n: b.no });
    o.push(text(m, yBot + fz() * 1.15, name, i === sel ? 'operasi-ta' : 'operasi-t', 'middle', xs[i][1] - xs[i][0] + 3));
    if (M.full) o.push(text(m, yBot + fz() * 2.3, fmt.num(st.open[i], 2), 'operasi-tk', 'middle', xs[i][1] - xs[i][0] + 2));
    o.push(`<rect x="${r1(xs[i][0])}" y="${r1(plotTop)}" width="${r1(xs[i][1] - xs[i][0])}" height="${r1(yBot - plotTop)}" class="operasi-hit" data-bay="${i}"><title>${esc(name)}</title></rect>`);
  });
  if (sel != null && xs[sel]) {
    const m = (xs[sel][0] + xs[sel][1]) / 2;
    o.push(line(m, plotTop - 2, m, yBot + 1, 'operasi-axis'));
    o.push(text(m + 3, plotTop + fz() * 0.3, 'A', 'operasi-ta'));
  }
  if (!M.full) return { svg: o.join(''), h: yBot + fz() * 1.6 - top };
  o.push(text(x0 - 6, yBot + fz() * 2.3, t('operasi.sec.opening_axis', 'a (m)'), 'operasi-tk', 'end'));
  o.push(text(x0, yBot + fz() * 3.6, t('operasi.sec.left_bank', 'LEFT BANK'), 'operasi-tk'));
  o.push(text(x1, yBot + fz() * 3.6, t('operasi.sec.right_bank', 'RIGHT BANK'), 'operasi-tk', 'end'));
  o.push(scaleBar(W / 2 - 60, yBot + fz() * 2.8, 50, sx, fmt));
  return { svg: o.join(''), h: yBot + fz() * 4.6 - top };
}

// ---------- view 2: section A-A through one bay (flow from left to right) ----------
function drawSection(desc, st, top, ctx, sel) {
  const { t, fmt } = ctx;
  const b = desc.bays[sel] || desc.bays[0];
  const lf = leafOf(b);
  const op = Math.max(0, Math.min(st.open[sel] || 0, desc.lift_max, desc.hoist_el - 1.6 - lf.sill - lf.h));
  const floor = desc.basin_floor_el;
  const bed = desc.bed_el;
  const es = floor + b.end_sill_h;
  const found = desc.found_el;
  // stations along the flow in metres, 0 = upstream face of the gate leaf
  const cUp = -4;
  const cDn = 1.6;
  const gE = cDn + 1.5 * Math.max(0.5, lf.sill - floor); // glacis at 1 : 1.5
  const bE = gE + b.basin_len;
  const xMin = -24;
  const xMax = bE + 12;
  const x0 = 40;
  const x1 = W - 8;
  const plotTop = top + fz() * 2.2;
  const plotH = M.secH;
  const elLo = Math.floor(found - 1.8);
  const elHi = Math.ceil(desc.hoist_el + 1.2);
  const sx = (x1 - x0) / (xMax - xMin);
  const sy = plotH / (elHi - elLo);
  const X = (m) => x0 + (m - xMin) * sx;
  const Y = (el) => plotTop + plotH - (el - elLo) * sy;
  const yBot = Y(elLo);
  const o = [];
  const nm = b.kind === 'sluice' ? t('operasi.sec.sluice_n', 'S{n}', { n: b.no }) : t('operasi.sec.gate_n', 'G{n}', { n: b.no });
  o.push(text(8, top + fz() * 1.2, t('operasi.sec.sect_title', 'SECTION A–A · BAY {n}', { n: nm }), 'operasi-th', 'start', W * 0.55));
  if (M.full) o.push(text(W - 8, top + fz() * 1.2, t('operasi.sec.vscale', 'VERTICAL SCALE ×{k}', { k: fmt.num(sy / sx, 1) }), 'operasi-tk', 'end', W * 0.4));
  o.push(levelScale(30, Y, elLo, elHi, fmt));
  if (M.full) o.push(text(30, yBot + fz() * 1.2, t('operasi.sec.el_axis', 'EL (m)'), 'operasi-tk', 'middle'));

  // water first; earth and concrete are opaque and cover what lies under the ground line
  const pond = st.pond;
  const tail = st.tail;
  if (isNum(pond)) o.push(rect(X(xMin), Y(pond), X(0) - X(xMin), yBot - Y(pond), 'operasi-water'));
  if (isNum(tail)) o.push(rect(X(0.5), Y(tail), X(xMax) - X(0.5), yBot - Y(tail), 'operasi-water'));
  if (isNum(pond) && op > 0.01) o.push(rect(X(0) - 0.5, Y(Math.min(pond, lf.sill + op)), X(0.5) - X(0) + 1, yBot - Y(Math.min(pond, lf.sill + op)), 'operasi-water'));
  const aJet = isNum(pond) ? Math.min(op, Math.max(0, pond - lf.sill)) * 0.62 : 0;
  if (aJet > 0.01 && !(isNum(tail) && tail > lf.sill + aJet)) {
    const a = aJet; // the free jet under the leaf, drawn contracted (shape only); a drowned jet is not drawn
    const tj = Math.max(a * 0.45, 0.25);
    o.push(poly([[X(0.5), Y(lf.sill)], [X(0.5), Y(lf.sill + a)], [X(cDn), Y(lf.sill + a * 0.95)], [X(gE), Y(floor + tj)], [X(gE + 6), Y(floor + tj * 1.4)], [X(gE + 6), Y(floor)], [X(gE), Y(floor)], [X(cDn), Y(lf.sill)]], 'operasi-jet'));
  }
  // earth: river bed upstream and downstream and everything under the structure (the concrete covers its part)
  o.push(poly([[X(xMin), Y(bed)], [X(-6), Y(bed)], [X(-6), Y(floor)], [X(bE + 2), Y(floor)], [X(bE + 2), Y(es)], [X(xMax), Y(es)], [X(xMax), yBot], [X(xMin), yBot]], 'operasi-earth'));
  // the cut concrete: upstream apron, sill, glacis, stilling basin, end sill, two cut-off walls
  const body = [
    [-14, bed], [-6, bed], [cUp, lf.sill], [cDn, lf.sill], [gE, floor], [bE, floor], [bE, es], [bE + 2, es],
    [bE + 2, found - 1.3], [bE + 0.8, found - 1.3], [bE + 0.8, found], [-6, found], [-6, found - 1.3], [-7.2, found - 1.3],
    [-7.2, bed - 1], [-14, bed - 1],
  ];
  o.push(poly(body.map(([m, e]) => [X(m), Y(e)]), 'operasi-cut'));
  if (lf.split) o.push(line(X(cUp), Y(lf.sill), X(cUp), Y(b.sill_el), 'operasi-hidden'));
  // riprap beyond the end sill
  for (let m = bE + 2.8; m < xMax - 0.5; m += 1.6) o.push(`<circle cx="${r1(X(m))}" cy="${r1(Y(es) - 1.3)}" r="1.25" class="operasi-rock"/>`);
  o.push(line(X(xMin), Y(bed), X(-14), Y(bed), 'operasi-med'), line(X(bE + 2), Y(es), X(xMax), Y(es), 'operasi-med'));
  // the pier beyond the cut (seen, thin) with its rounded nose, the service bridge and the hoist deck (cut)
  const pTop = desc.deck_el - 0.9;
  const nose = 2.2;
  o.push(`<path d="M${r1(X(-8))} ${r1(Y(lf.sill + 0.4))} L${r1(X(-8))} ${r1(Y(pTop))} L${r1(X(cDn + 5))} ${r1(Y(pTop))} L${r1(X(cDn + 5))} ${r1(Y(lf.sill - (5 - 0) / 1.5 + 0.3))}" class="operasi-thin"/>`);
  o.push(line(X(-8 + nose), Y(lf.sill + 0.4), X(-8 + nose), Y(pTop), 'operasi-hair'));
  o.push(rect(X(-10), Y(desc.deck_el), X(cDn + 7) - X(-10), Y(pTop) - Y(desc.deck_el), 'operasi-cut'));
  // the hoist tower on the pier beyond (seen): walls, roof, the hoist beam inside
  const tl = desc.tower_l;
  o.push(rect(X(-tl / 2), Y(desc.hoist_el), X(tl / 2) - X(-tl / 2), Y(desc.deck_el) - Y(desc.hoist_el), 'operasi-tower'));
  o.push(rect(X(-tl / 2 - 0.4), Y(desc.hoist_el + 0.45), X(tl / 2 + 0.4) - X(-tl / 2 - 0.4), Y(desc.hoist_el) - Y(desc.hoist_el + 0.45), 'operasi-med'));
  o.push(rect(X(-1.4), Y(desc.hoist_el - 0.5), X(1.9) - X(-1.4), Y(desc.hoist_el - 1.3) - Y(desc.hoist_el - 0.5), 'operasi-thin'));
  // the gate leaf in its slot, lifted by the opening, and its stem
  const gw = Math.max(X(0.55) - X(0), 2.6);
  const yb = Y(lf.sill + op);
  const yt = Y(lf.sill + op + lf.h);
  o.push(line(X(0.25), yt, X(0.25), Y(desc.hoist_el - 1.3), 'operasi-thin'));
  o.push(rect(X(0), yt, gw, yb - yt, 'operasi-gate'));
  if (lf.split) o.push(line(X(0), Y(lf.sill + op + lf.split), X(0) + gw, Y(lf.sill + op + lf.split), 'operasi-med'));
  // the opening as a dimension, just upstream of the leaf
  if (op > 0.005) {
    const dx = X(-1.7);
    o.push(line(dx, Y(lf.sill), dx, yb, 'operasi-thin'), line(dx - 1.6, Y(lf.sill), dx + 1.6, Y(lf.sill), 'operasi-thin'), line(dx - 1.6, yb, dx + 1.6, yb, 'operasi-thin'));
  }
  if (M.full) o.push(text(X(-2.4), Math.min(yb, Y(lf.sill)) - 3, t('operasi.sec.opening', 'a = {v} m', { v: fmt.num(op, 2) }), 'operasi-t', 'end'));
  // levels: pond, tail, design flood, normal; the sill
  const tailLab = isNum(tail) ? [{ y: Y(tail) - 2.4, s: t('operasi.sec.tail', 'Tail water') + ' EL ' + fmt.el(tail), cls: 'operasi-tw' }] : [];
  o.push(refLines(desc, Y, X(xMin), X(xMax), ctx, tailLab));
  if (isNum(pond)) {
    o.push(line(X(xMin), Y(pond), X(0), Y(pond), 'operasi-wline'), wlMark(X(xMin) + 6, Y(pond)));
    o.push(text(X(xMin) + 12, Y(pond) - 2.4, t('operasi.sec.pond', 'Pond') + ' EL ' + fmt.el(pond), 'operasi-tw'));
  }
  if (isNum(tail)) {
    const xt = tail >= lf.sill ? 0.5 : tail <= floor ? gE : cDn + 1.5 * (lf.sill - tail);
    o.push(line(X(xt), Y(tail), X(xMax), Y(tail), 'operasi-wline'), wlMark(X(Math.max(xt + 3, gE)), Y(tail)));
  }
  // flow arrow; in the enlarged sheet also the sill and basin levels and the scale bar
  o.push(`<line x1="${r1(X(xMin) + 4)}" y1="${r1(plotTop + 6)}" x2="${r1(X(xMin) + 26)}" y2="${r1(plotTop + 6)}" class="operasi-med" marker-end="url(#operasi-arr)"/>`);
  if (!M.full) return { svg: o.join(''), h: yBot + 4 - top };
  o.push(text(X(cDn) + 2, Y(lf.sill) + fz() * 1.1, t('operasi.sec.sill', 'SILL') + ' ' + fmt.num(lf.sill, 2), 'operasi-tk'));
  o.push(text(X((gE + bE) / 2), Y(floor) + fz() * 1.1, t('operasi.sec.basin', 'STILLING BASIN') + ' ' + fmt.num(floor, 2), 'operasi-tk', 'middle'));
  o.push(text(X(xMin) + 29, plotTop + 6 + fz() * 0.35, t('operasi.sec.flow', 'FLOW'), 'operasi-tk'));
  o.push(scaleBar(W / 2 - 60, yBot + 6, 10, sx, fmt));
  return { svg: o.join(''), h: yBot + 8 + fz() * 1.6 - top };
}

// ---------- title block ----------
function drawTitle(desc, top, ctx) {
  const { t } = ctx;
  const h = fz() * 3.6;
  const c1 = W * 0.27;
  const c2 = W * 0.73;
  const o = [line(0, top, W, top, 'operasi-frame'), line(c1, top, c1, top + h, 'operasi-thin'), line(c2, top, c2, top + h, 'operasi-thin')];
  o.push(text(8, top + fz() * 1.45, t('operasi.sec.tb_name', 'PERJAYA WEIR'), 'operasi-th', 'start', c1 - 14));
  o.push(text(8, top + fz() * 2.85, t('operasi.sec.tb_river', 'Komering River'), 'operasi-tk', 'start', c1 - 14));
  o.push(text(c1 + 5, top + fz() * 1.45, t('operasi.sec.tb_kind', 'SCHEMATIC · NOT FOR CONSTRUCTION'), 'operasi-tk', 'start', c2 - c1 - 10));
  o.push(text(c1 + 5, top + fz() * 2.85, t('app.model_note', 'Indicative model, not a survey'), 'operasi-tk', 'start', c2 - c1 - 10));
  const fb = desc.fallback.length > 0;
  const as = desc.assumed.length > 0;
  o.push(text(c2 + 5, top + fz() * 1.45, t('operasi.sec.tb_geom', 'GEOMETRY'), 'operasi-tk', 'start', W - c2 - 26));
  o.push(text(c2 + 5, top + fz() * 2.85, fb ? t('operasi.sec.tb_fallback', 'stand-in') : as ? t('operasi.sec.tb_assumed', 'partly assumed') : t('operasi.sec.tb_data', 'from sources'), fb || as ? 'operasi-tdhw' : 'operasi-t', 'start', W - c2 - 10));
  o.push(`<g transform="translate(${W - 16},${top + fz() * 1.2})"><rect x="-7" y="-7" width="14" height="14" class="operasi-frame"/>${text(0, fz() * 0.35, fb || as ? 'A' : 'S', 'operasi-th', 'middle')}</g>`);
  return { svg: o.join(''), h };
}

// ---------- mount: one live sheet bound to the store ----------
export function mountWeirSection(el, ctx, opts = {}) {
  const store = ctx.store;
  let desc = readWeir(null, null);
  let sel = Number.isInteger(opts.bay) ? opts.bay : 0;
  const size = SIZES[opts.size] || SIZES.compact;
  let shown = null; // displayed openings per bay (eased toward the store's openings)
  let framesSeen = false;
  let queued = false;
  let dead = false;
  const offs = [];
  const box = document.createElement('div');
  box.className = 'operasi-sheet';
  box.setAttribute('role', 'img');
  el.appendChild(box);

  // the openings in use (s01 writes gates_used / sluices_used, clamped by the engine); the controls until then
  const target = () => openingsByBay(desc, store.get('weir.gates_used') ?? store.get('weir.gates'), store.get('weir.sluices_used') ?? store.get('weir.sluices'));

  function draw() {
    queued = false;
    if (dead) return;
    if (!shown || shown.length !== desc.bays.length) shown = target();
    const st = { pond: Number(store.get('weir.pond_el')), tail: Number(store.get('weir.tail_el')), open: shown };
    if (store.get('weir.pond_el') == null) st.pond = NaN;
    if (store.get('weir.tail_el') == null) st.tail = NaN;
    if (sel >= desc.bays.length) sel = 0;
    M = size;
    W = M.W;
    const e = drawElevation(desc, st, 4, ctx, sel);
    const s = drawSection(desc, st, 4 + e.h + 6, ctx, sel);
    const tb = M.full ? drawTitle(desc, 4 + e.h + 6 + s.h + 4, ctx) : { svg: '', h: -2 };
    const H = 4 + e.h + 6 + s.h + 4 + tb.h;
    const sepY = 4 + e.h + 3;
    box.innerHTML =
      `<svg class="operasi-svg-${M.full ? 'full' : 'compact'}" viewBox="0 0 ${W} ${r1(H)}" width="100%" style="display:block;height:auto" xmlns="http://www.w3.org/2000/svg">` +
      style('operasi-svg-' + (M.full ? 'full' : 'compact')) + DEFS + rect(0.5, 0.5, W - 1, H - 1, 'operasi-frame') + line(0, sepY, W, sepY, 'operasi-thin') +
      e.svg + s.svg + tb.svg + '</svg>';
    box.setAttribute('aria-label', ctx.t('operasi.sec.aria', 'Drawing of the weir: upstream elevation and a section through one bay'));
  }
  const schedule = () => {
    if (!queued) {
      queued = true;
      queueMicrotask(draw);
    }
  };

  // openings: snap when nothing drives frames (or in a still picture), else ease on the frame clock
  function onWeir() {
    const tg = target();
    if (!shown || shown.length !== tg.length || ctx.shot || !framesSeen) shown = tg;
    schedule();
  }
  offs.push(store.on('weir', onWeir));
  offs.push(store.on('lang', schedule));
  offs.push(
    store.listen('frame', (p) => {
      framesSeen = true;
      const dt = Math.max(0, Math.min(0.25, Number(p && p.dt) || 0));
      if (!shown || !dt) return;
      const tg = target();
      let moving = false;
      for (let i = 0; i < shown.length; i++) {
        const d = tg[i] - shown[i];
        if (Math.abs(d) < 0.004) shown[i] = tg[i];
        else {
          shown[i] += d * Math.min(1, dt * 3.5);
          moving = true;
        }
      }
      if (moving) schedule();
    }),
  );
  box.addEventListener('click', (ev) => {
    const hit = ev.target.closest && ev.target.closest('[data-bay]');
    if (hit) {
      api.setBay(Number(hit.dataset.bay));
      if (typeof opts.onSelect === 'function') opts.onSelect(Number(hit.dataset.bay));
    }
  });

  Promise.all([ctx.data.json('weir.json').catch(() => null), ctx.data.json('params.json').catch(() => null)]).then(([w, p]) => {
    if (dead) return;
    desc = readWeir(w, p);
    shown = null;
    schedule();
  });
  draw();

  const api = {
    setBay(i) {
      if (Number.isInteger(i) && i >= 0 && i < desc.bays.length && i !== sel) {
        sel = i;
        schedule();
      }
    },
    get bay() {
      return sel;
    },
    get size() {
      return size === SIZES.full ? 'full' : 'compact';
    },
    get desc() {
      return desc;
    },
    redraw: schedule,
    destroy() {
      dead = true;
      offs.forEach((f) => f && f());
      box.remove();
    },
  };
  return api;
}
