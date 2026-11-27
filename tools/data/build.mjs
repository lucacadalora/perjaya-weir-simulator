#!/usr/bin/env node
// b18: builds site/data/{weir,params,presets,credits,facts}.json from the fragments in data-src/.
// Fragment leaves are [v, unit, status, src, note, alt] and become {v, unit, status, src, note, alt}.
// Usage: node tools/data/build.mjs   (from the repo root or anywhere)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'data-src');
const OUT = join(ROOT, 'site', 'data');
const STATUSES = new Set(['S', 'C', 'R', 'A', 'P']);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const stamp = new Date().toISOString().slice(0, 19) + 'Z';

export function isLeafArr(x) {
  return Array.isArray(x) && x.length >= 4 && x.length <= 6 && typeof x[2] === 'string' && STATUSES.has(x[2]) &&
    (typeof x[3] === 'string' || Array.isArray(x[3]));
}
export function leaf(a) {
  const [v, unit, status, src, note, alt] = a;
  const o = { v, unit, status, src: Array.isArray(src) ? src : [src] };
  if (note) o.note = note;
  if (alt && alt.length) o.alt = alt;
  return o;
}
export function expand(node) {
  if (isLeafArr(node)) return leaf(node);
  if (Array.isArray(node)) return node.map(expand);
  if (node && typeof node === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(node)) if (!k.startsWith('_')) o[k] = expand(val);
    return o;
  }
  return node;
}
function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) deepMerge(a[k], v);
    else a[k] = v;
  }
  return a;
}
// every {v,...} leaf -> flat["group.key"] = v
export function flatten(node, prefix = '', out = {}) {
  for (const [k, val] of Object.entries(node)) {
    if (k === 'meta' || k === 'flat') continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (val && typeof val === 'object' && !Array.isArray(val) && 'v' in val && 'status' in val) out[key] = val.v;
    else if (val && typeof val === 'object' && !Array.isArray(val)) flatten(val, key, out);
  }
  return out;
}

// fact fragment {v, u, s, y, src, l:[id,en], n:[id,en], alt} -> contract shape; section from the file name
export function factLeaf(f, section) {
  const o = { v: f.v, unit: f.u ?? '-', status: f.s, year: f.y ?? null, src: Array.isArray(f.src) ? f.src : [f.src],
    label: { id: f.l[0], en: f.l[1] }, section: f.sec || section };
  if (f.n) o.note = { id: f.n[0], en: f.n[1] };
  if (f.alt) o.alt = f.alt;
  if (f.show) o.show = f.show;
  return o;
}

function medLow(a) {
  a = [...a].sort((x, y) => x - y);
  const n = Math.max(5, Math.round(a.length * 0.1)), l = a.slice(0, n);
  return l.length % 2 ? l[(l.length - 1) / 2] : (l[l.length / 2 - 1] + l[l.length / 2]) / 2;
}
// ---- datum: river surface on the fine grid just upstream of the weir ----
function datumOffset(weirLon, weirLat, pondEl) {
  const meta = readJson(join(OUT, 'grid', 'fine.json'));
  const buf = readFileSync(join(OUT, 'grid', meta.files.dem));
  const dem = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  const cs = meta.cellsize_deg;
  const kmLat = 110.574, kmLon = 111.320 * Math.cos(weirLat * Math.PI / 180);
  const c0 = Math.floor((weirLon - meta.west) / cs), r0 = Math.floor((meta.north - weirLat) / cs);
  const R = 12, cells = [], down = [];
  for (let r = r0 - R; r <= r0 + R; r++) for (let c = c0 - R; c <= c0 + R; c++) {
    if (r < 0 || c < 0 || r >= meta.rows || c >= meta.cols) continue;
    const lon = meta.west + (c + 0.5) * cs, lat = meta.north - (r + 0.5) * cs;
    const dx = (lon - weirLon) * kmLon * 1000, dy = (lat - weirLat) * kmLat * 1000;
    if (Math.hypot(dx, dy) > 300) continue;
    const z = dem[r * meta.cols + c];
    if (z === meta.nodata.dem) continue;
    if (dy > 45) { down.push(z / 10); continue; } // downstream = north
    if (dy > -45) continue; // upstream = south of the axis, clear of the structure (1.5 cells)
    cells.push(z / 10);
  }
  cells.sort((a, b) => a - b);
  const n = Math.max(5, Math.round(cells.length * 0.1));
  const low = cells.slice(0, n);
  const med = low.length % 2 ? low[(low.length - 1) / 2] : (low[low.length / 2 - 1] + low[low.length / 2]) / 2;
  const off = Math.round((med - pondEl) * 100) / 100;
  return {
    v: off, unit: 'm', status: 'C', src: ['study:terrain', 'g01:GLO30', 'r01:J19'],
    note: `model = EL + offset. Fine grid (GLO-30, EGM2008): ${cells.length} cells within 300 m upstream (south) of the weir axis; ` +
      `median of the lowest ${n} (10 %) = ${med.toFixed(2)} m, read as the pond surface on the flight day (2011-15); ` +
      `held pond EL ${pondEl.toFixed(2)}; offset = ${med.toFixed(2)} - ${pondEl.toFixed(2)} = ${off.toFixed(2)} m. ` +
      `Assumes the pond was at its held level when the surface model was flown; GLO-30 vertical error is up to 4 m.`,
    alt: [{ v: 0, src: ['b18:assume'], note: 'earlier settled stand-in: project EL = EGM2008 height' }],
    calc: { tail_low_m: medLow(down), tail_cells: down.length, cells: cells.length, lowest_n: n, median_low_m: med, lowest_m: cells[0], pond_el: pondEl },
  };
}

// ---- weir: expand bays, add positions along the axis ----
function buildWeir(raw) {
  const w = expand(raw);
  const st = raw.bay_value_status;
  const pier = w.piers.width_m.v;
  let x = w.abutments.left_width_m.v;
  w.bays = raw.bays.map((b, i) => {
    const o = { id: b.id, kind: b.kind, index: i };
    for (const [k, val] of Object.entries(b)) {
      if (k === 'id' || k === 'kind') continue;
      const s = st[k];
      o[k] = { v: val, unit: k.endsWith('_el') ? 'm EL' : 'm', status: s[0], src: [s[1]], note: s[2] };
    }
    o.x_left_m = { v: Math.round(x * 100) / 100, unit: 'm', status: 'C', src: ['b18:assume', 'r01:J19'],
      note: 'left edge of the clear opening, from the left abutment face: abutment + bays and piers to its left' };
    o.x_centre_m = { v: Math.round((x + b.width_m / 2) * 100) / 100, unit: 'm', status: 'C', src: ['b18:assume', 'r01:J19'] };
    x += b.width_m + (i < raw.bays.length - 1 ? pier : 0);
    return o;
  });
  const total = x + w.abutments.right_width_m.v;
  w.piers.x_centre_m = { v: w.bays.slice(0, -1).map((b) => Math.round((b.x_left_m.v + b.width_m.v + pier / 2) * 100) / 100),
    unit: 'm', status: 'C', src: ['b18:assume'], note: 'centre of each pier, left to right' };
  w.check = { sum_m: Math.round(total * 100) / 100, length_m: w.axis.length_m.v };
  delete w.bay_value_status;
  return w;
}

function main() {
  const weirRaw = readJson(join(SRC, 'weir.json'));
  const weir = buildWeir(weirRaw);
  if (Math.abs(weir.check.sum_m - weir.check.length_m) > 0.01) throw new Error(`weir widths sum ${weir.check.sum_m} != ${weir.check.length_m}`);

  const praw = {};
  for (const f of readdirSync(join(SRC, 'params')).filter((f) => f.endsWith('.json')).sort()) deepMerge(praw, readJson(join(SRC, 'params', f)));
  const params = expand(praw);
  params.datum.offset_m = datumOffset(weir.axis.lon.v, weir.axis.lat.v, params.weir.pond_normal_el.v);
  // A7.1: one tail rating, anchored on the design case (tail EL at the design flood)
  {
    const W = params.weir, b = W.tail_width_m.v, z = W.tail_side_z.v, n = W.manning_n.v, S = W.bed_slope.v;
    const Q = W.design_flood_m3s.v, el = W.tailwater_flood_case_el.v;
    const q = (y) => { const A = y * (b + z * y), P = b + 2 * y * Math.sqrt(1 + z * z); return A * Math.pow(A / P, 2 / 3) * Math.sqrt(S) / n; };
    let lo = 0, hi = 30;
    for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (q(m) < Q) lo = m; else hi = m; }
    const bed = Math.round((el - lo) * 100) / 100;
    W.tail_bed_el = { v: bed, unit: 'm EL', status: 'C', src: ['r05:UNISMA22', 'r01:J19', 'r13:CHOW', 'study:calc'],
      note: `Manning section b ${b} m, side slope 1:${z}, n ${n}, S ${S}: ${Q} m3/s needs depth ${lo.toFixed(2)} m; bed = tail EL ${el.toFixed(2)} - ${lo.toFixed(2)} = ${bed.toFixed(2)}. ` +
        `(The terrain's tail surface, EL ${(params.datum.offset_m.calc.tail_low_m - params.datum.offset_m.v).toFixed(1)} on the survey days, is no longer an anchor.)` };
    weir.levels.tail_bed_el = W.tail_bed_el;
    const off = params.datum.offset_m;
    const ref = Math.round((off.calc.tail_low_m - off.v) * 100) / 100;
    params.flood.ref_tail_el = { v: ref, unit: 'm EL', status: 'C', src: ['study:terrain', 'g01:GLO30'],
      note: `terrain tail surface ${off.calc.tail_low_m} m (median of the lowest 10 % of fine-grid cells 45-300 m downstream of the axis) - datum offset ${off.v} = EL ${ref.toFixed(2)}; taken as the edge of the normal channel below the weir` };
    params.flood.ref_pond_el = { ...W.pond_normal_el, note: '= weir.pond_normal_el; flooding above the weir counts the rise over it' };
  }
  // A7.7: half-month rain exceeded 80 % of the time, 1991-2020, from the daily basin rain
  {
    const rain = readJson(join(OUT, 'climate', 'rain.json')).daily_basin_mean;
    const t0 = Date.parse(rain.start + 'T00:00:00Z'), sums = {};
    rain.values.forEach((x, i) => {
      const d = new Date(t0 + i * 86400000), y = d.getUTCFullYear();
      if (y < 1991 || y > 2020 || x == null) return;
      const k = y * 100 + d.getUTCMonth() * 2 + (d.getUTCDate() > 15 ? 1 : 0);
      sums[k] = (sums[k] || 0) + x * rain.scale;
    });
    const r80 = [];
    for (let h = 0; h < 24; h++) {
      const v = Object.entries(sums).filter(([k]) => +k % 100 === h).map(([, s]) => s).sort((a, b) => a - b);
      const pos = 0.2 * (v.length + 1) - 1, i0 = Math.max(0, Math.floor(pos)), f = pos - i0; // Weibull m/(n+1)
      r80.push(Math.round((v[i0] + f * ((v[i0 + 1] ?? v[i0]) - v[i0])) * 10) / 10);
    }
    params.irrigation.r80_halfmonth_mm = { v: r80, unit: 'mm', status: 'C', src: ['study:rain', 'r14:OM', 'r13:KP01'],
      note: 'half-month basin rain (1-15, 16-end) exceeded in 80 % of the years 1991-2020 (Weibull m/(n+1)), from climate/rain.json daily_basin_mean; Jan first half first' };
  }
  params.meta = { built: stamp, by: 'tools/data/build.mjs', levels: 'project EL unless the unit says otherwise; model m = EL + datum.offset_m' };
  params.flat = flatten(params);
  weir.meta = { ...weir.meta, built: stamp, datum_offset_m: params.datum.offset_m.v };

  const out = { 'weir.json': weir, 'params.json': params };
  for (const name of ['presets', 'credits']) if (existsSync(join(SRC, `${name}.json`))) out[`${name}.json`] = expand(readJson(join(SRC, `${name}.json`)));
  if (existsSync(join(SRC, 'facts'))) {
    const facts = {};
    const dupes = [];
    for (const f of readdirSync(join(SRC, 'facts')).filter((f) => f.endsWith('.json')).sort()) {
      const frag = readJson(join(SRC, 'facts', f));
      for (const [k, val] of Object.entries(frag)) {
        if (k.startsWith('_')) continue;
        if (facts[k]) dupes.push(k);
        facts[k] = factLeaf(val, f.replace(/^\d+-|\.json$/g, ''));
      }
    }
    if (dupes.length) throw new Error('fact keys twice: ' + dupes.join(', '));
    if (Object.keys(facts).length) {
      const d = params.datum.offset_m;
      facts.datum_offset = { v: d.v, unit: 'm', status: 'C', year: 2026, src: d.src, section: 'structure',
        label: { id: 'Selisih datum: model medan = EL proyek + selisih', en: 'Datum offset: terrain model = project EL + offset' },
        note: { id: `Muka genangan di model medan ${d.calc.median_low_m} m dikurangi EL ${d.calc.pond_el.toFixed(2)}.`, en: `Pond surface in the terrain model ${d.calc.median_low_m} m minus EL ${d.calc.pond_el.toFixed(2)}.` } };
      out['facts.json'] = {
        meta: { built: stamp, by: 'tools/data/build.mjs', statuses: { S: 'sourced', C: 'computed', R: 'read from a picture or map', A: 'assumed', P: 'press' },
          key_facts: ['length', 'flood_gates_n', 'design_flood', 'catchment_area', 'area_legal', 'mean_flow'],
          sections: ['identity', 'people', 'structure', 'river', 'irrigation', 'operation', 'money', 'upstream', 'floods'] },
        facts,
        sources: {},
        timeline: existsSync(join(SRC, 'timeline.json')) ? readJson(join(SRC, 'timeline.json')) : [],
        standins: existsSync(join(SRC, 'standins.json')) ? readJson(join(SRC, 'standins.json')) : [],
      };
    }
  }
  // one key per work: map duplicate and internal keys through data-src/sources.alias.json, then keep only the
  // curated sources (data-src/sources.json) that something cites
  const alias = existsSync(join(SRC, 'sources.alias.json')) ? readJson(join(SRC, 'sources.alias.json')) : {};
  const used = new Set();
  const remap = (node) => {
    if (Array.isArray(node)) return node.forEach(remap);
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.src)) {
      node.src = [...new Set(node.src.flatMap((k) => alias[k] || [k]))];
      node.src.forEach((k) => used.add(k));
    }
    for (const [k, v] of Object.entries(node)) if (k !== 'sources') remap(v);
  };
  Object.values(out).forEach(remap);
  if (out['params.json']) out['params.json'].flat = flatten(out['params.json']);
  if (out['facts.json']) {
    const all = readJson(join(SRC, 'sources.json'));
    out['facts.json'].sources = Object.fromEntries([...used].sort().filter((k) => all[k]).map((k) => [k, all[k]]));
    const missing = [...used].filter((k) => !all[k]);
    if (missing.length) console.log('WARNING sources without a curated entry: ' + missing.join(', '));
  }
  for (const [name, obj] of Object.entries(out)) writeFileSync(join(OUT, name), JSON.stringify(obj, null, 1) + '\n');
  const o = params.datum.offset_m;
  console.log(`built ${Object.keys(out).join(', ')}; datum.offset_m ${o.v} (${o.calc.cells} cells, median low ${o.calc.median_low_m}); bays sum ${weir.check.sum_m} m; ${Object.keys(params.flat).length} flat params`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
