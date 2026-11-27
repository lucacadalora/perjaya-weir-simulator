#!/usr/bin/env node
// Harvest the text keys of the app and compare them with both language tables. Owner: lane b03.
//   node tools/i18n/harvest.mjs            report (exit 1 when a key is missing from a table)
//   node tools/i18n/harvest.mjs --json     the same as JSON
//   node tools/i18n/harvest.mjs --todo     print the missing keys as table lines to paste (English = the fallback)
// Scans site/js/** and site/index.html for t('key', 'fallback'), label: ['key', 'English'], data-t="key" and
// data-t-title="key". Flags visible strings that bypass t(), English words left in the Indonesian table, and two
// different English fallbacks for one key.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = path.join(ROOT, 'site');
const args = new Set(process.argv.slice(2));

function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'i18n' && e.name !== 'node_modules') walk(p, out); }
    else if (/\.(m?js|html)$/.test(e.name) && !/\.test\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = [path.join(SITE, 'index.html'), ...walk(path.join(SITE, 'js'))].filter((f) => fs.existsSync(f));
const unq = (s) => s.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n');
const str = (n) => `(['"\x60])((?:\\\\.|(?!\\${n})[^\\\\])*?)\\${n}`;
const STR = str(1);
const KEY = String.raw`[a-z][\w-]*\.[\w.:-]+`;

const keys = new Map(); // key -> {fallbacks:Set, where:Set}
const dynamic = [];
const bypass = [];
function addKey(key, fb, where) {
  if (fb != null && new RegExp(`^${KEY}$`).test(fb.trim()) && !/\s/.test(fb)) return; // a key-to-key table, not text
  if (fb != null && /^[a-z0-9]+(_[a-z0-9]+)+$/.test(fb.trim())) return; // a data field name, not text
  if (!keys.has(key)) keys.set(key, { fallbacks: new Set(), where: new Set() });
  const k = keys.get(key);
  if (fb != null && fb.trim() !== '' && !fb.includes('${')) k.fallbacks.add(unq(fb));
  k.where.add(where);
}

const reT = new RegExp(String.raw`(?:^|[^\w$])t\(\s*(['"\x60])(${KEY})\1\s*(?:,\s*` + str(3) + ')?', 'g');
const reDyn = /(?:^|[^\w$])t\(\s*(?:`[^`]*\$\{|[A-Za-z_$][\w$.]*\s*[,)+])/g;
const reLabel = new RegExp(String.raw`label\s*:\s*\[\s*(['"])(${KEY})\1\s*,\s*(['"\x60])((?:\\.|(?!\3)[^\\])*?)\3`, 'g');
const rePair = new RegExp(String.raw`\[\s*(['"])(${KEY})\1\s*,\s*(['"])((?:\\.|(?!\3)[^\\])*?)\3\s*\]`, 'g');
const reObj = new RegExp(String.raw`\b\w*[kK]ey\s*:\s*(['"])(${KEY})\1\s*,\s*\w*(?:en|En|fallback|label)\s*:\s*` + str(3), 'g');
const reCall = new RegExp(String.raw`(?:^|[^\w$.])([A-Za-z_$][\w$]*)\(\s*(['"])(${KEY})\2\s*,\s*` + str(4), 'g');
const reMid = new RegExp(String.raw`,\s*(['"])(${KEY})\1\s*,\s*` + str(3), 'g');
const reDataT = new RegExp(String.raw`data-t=(?:\\?["'])(${KEY})(?:\\?["'])[^>]*>([^<]*)<`, 'g');
const reDataTT = new RegExp(String.raw`data-t-title=(?:\\?["'])(${KEY})(?:\\?["'])`, 'g');
const reTitleNear = /title=(?:\\?["'])([^"'\\]*)/;

// Visible-text checks (heuristic). A string with two or more letters in a row counts as visible text.
const WORDY = /[A-Za-zÀ-ž]{2,}/;
const reAssign = new RegExp(String.raw`\.(textContent|innerText|placeholder|title|ariaLabel|alt)\s*=\s*` + str(2), 'g');
const reSetAttr = new RegExp(String.raw`setAttribute\(\s*['"](title|aria-label|placeholder|alt)['"]\s*,\s*` + str(2), 'g');
const reTagText = />([^<>{}`$]*[A-Za-zÀ-ž]{2,}[^<>{}`$]*)</g;

function lineOf(src, idx) { let n = 1; for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++; return n; }
function looksCode(s) { if (/[{};]/.test(s) || /^[.:#@]/.test(s)) return true; return /^[\s\w.#\-:/()[\],]*$/.test(s) && !/\s\w+\s/.test(' ' + s + ' ') && /[_.#/:]/.test(s); }

for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const src = f.endsWith('.html') ? raw : raw.split('\n').map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l.replace(/(^|[^:'"`\\])\/\/ .*$/, '$1'))).join('\n');
  const rel = path.relative(ROOT, f);
  for (const m of src.matchAll(reT)) {
    const at = `${rel}:${lineOf(src, m.index)}`;
    if (m[4] == null && /^\s*\+/.test(src.slice(m.index + m[0].length))) {
      // t('area.prefix_' + x, MAP[x] ...): expand from the object literal MAP in the same file when there is one.
      const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 200);
      const mm = tail.match(/^\s*\+\s*[\w$.[\]]+\s*,\s*([A-Z_$][\w$]*)\[/);
      const inl = tail.match(/^\s*\+\s*[\w$.[\]]+\s*,\s*\{([^}]*)\}\s*\[/);
      if (inl) { for (const e of inl[1].matchAll(/['"]?([\w-]+)['"]?\s*:\s*(['"])((?:\\.|(?!\2)[^\\])*)\2/g)) addKey(m[2] + e[1], e[3], at + ' (inline map)'); continue; }
      const obj = mm && src.match(new RegExp(String.raw`\b${mm[1]}\s*=\s*\{([^}]*)\}`));
      if (obj) { for (const e of obj[1].matchAll(/['"]?([\w-]+)['"]?\s*:\s*(['"])((?:\\.|(?!\2)[^\\])*)\2/g)) addKey(m[2] + e[1], e[3], at + ` (from ${mm[1]})`); continue; }
      dynamic.push(`${at}: key built from '${m[2]}' + ...`); continue;
    }
    addKey(m[2], m[4], at);
  }
  for (const m of src.matchAll(reLabel)) addKey(m[2], m[4], `${rel}:${lineOf(src, m.index)}`);
  for (const m of src.matchAll(reCall)) if (!/^(t|set|get|patch|on|emit|listen|json|bin|text|url|call|goto|tour|fetch|require|import)$/.test(m[1])) addKey(m[3], m[5], `${rel}:${lineOf(src, m.index)}`);
  for (const m of src.matchAll(reMid)) addKey(m[2], m[4], `${rel}:${lineOf(src, m.index)}`);
  for (const m of src.matchAll(reObj)) addKey(m[2], m[4], `${rel}:${lineOf(src, m.index)}`);
  for (const m of src.matchAll(rePair)) addKey(m[2], m[4], `${rel}:${lineOf(src, m.index)}`);
  for (const m of src.matchAll(reDataT)) addKey(m[1], m[2], `${rel}:${lineOf(src, m.index)}`);
  for (const m of src.matchAll(reDataTT)) {
    const tail = src.slice(Math.max(0, m.index - 200), m.index + 300).match(reTitleNear);
    addKey(m[1], tail ? tail[1] : null, `${rel}:${lineOf(src, m.index)}`);
  }
  for (const m of src.matchAll(reDyn)) {
    const ln = lineOf(src, m.index);
    const line = src.split('\n')[ln - 1] || '';
    if (rel.endsWith('i18n.js') || /^(\/\/|\*|\/\*)/.test(line.trim())) continue;
    if (/function\s+t\(|const t\b|=>\s*t\(/.test(line)) continue;
    if (/\bt\(\s*[A-Za-z_$][\w$.]*\s*,\s*[A-Za-z_$]/.test(line) && /function|=>/.test(line)) continue;
    dynamic.push(`${rel}:${ln}: ${line.trim().slice(0, 140)}`);
  }
  if (rel.endsWith('i18n.js')) continue;
  const flag = (idx, what) => {
    const ln = lineOf(src, idx);
    const line = (src.split('\n')[ln - 1] || '').trim();
    if (/b03-ok|i18n-ok/.test(line) || /^(\/\/|\*|\/\*)/.test(line)) return;
    bypass.push(`${rel}:${ln}: ${what}`);
  };
  for (const m of src.matchAll(reAssign)) if (WORDY.test(m[3]) && !looksCode(m[3])) flag(m.index, `${m[1]} = "${m[3].slice(0, 60)}"`);
  for (const m of src.matchAll(reSetAttr)) if (WORDY.test(m[3]) && !looksCode(m[3])) flag(m.index, `${m[1]} "${m[3].slice(0, 60)}"`);
  // Text between tags in HTML or in markup strings, where the opening tag has no data-t.
  for (const m of src.matchAll(reTagText)) {
    const text = m[1].trim();
    if ('=-'.includes(src[m.index - 1]) || /['"\n]/.test(m[1])) continue;
    if (!text || !WORDY.test(text)) continue;
    const before = src.slice(Math.max(0, m.index - 400), m.index + 1);
    const open = before.lastIndexOf('<');
    const tag = open >= 0 ? before.slice(open) : '';
    if (/^<\/?(script|style|title|meta|link|svg|path|g|defs|option value)/i.test(tag) && /^<(script|style)/i.test(tag)) continue;
    if (/data-t(-title)?=/.test(tag) || /^<\//.test(tag) && /data-t=/.test(src.slice(Math.max(0, m.index - 400), m.index))) continue;
    if (/^<(script|style)/i.test(tag)) continue;
    if (/[=;{}()]|=>|&&|\|\|/.test(text) || /^[\d\s.,:%–·+\-/×°]*$/.test(text)) continue;
    if (/^<title/i.test(tag) && rel === 'site/index.html') { flag(m.index, `<title> "${text.slice(0, 60)}" (set it from app.title at boot)`); continue; }
    flag(m.index, `markup text "${text.slice(0, 60)}"`);
  }
}

// Keys that only appear at run time (built from data arrays): tools/i18n/runtime-keys.json {key: English}, kept by b03
// from the browser probe. A key that the code also names directly takes the code's fallback.
try {
  const rk = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/i18n/runtime-keys.json'), 'utf8'));
  for (const [k, v] of Object.entries(rk)) if (!keys.has(k)) addKey(k, v, 'runtime-keys.json');
} catch {}

async function loadTable(name) {
  const p = path.join(SITE, 'js/i18n', name + '.js');
  try { return (await import(pathToFileURL(p).href + '?v=' + Date.now())).default || {}; }
  catch (e) { console.error(`cannot read ${name}.js: ${e.message}`); return {}; }
}
const ID = await loadTable('id');
const EN = await loadTable('en');

const used = [...keys.keys()].sort();
const missId = used.filter((k) => ID[k] == null);
const missEn = used.filter((k) => EN[k] == null);
const unused = Object.keys(ID).filter((k) => !keys.has(k)).sort();
const multiFb = used.filter((k) => keys.get(k).fallbacks.size > 1);

// English left in the Indonesian table: common English words that are not also Indonesian.
const EN_WORDS = /\b(the|and|of|with|for|from|flow|water|level|loading|load|update|click|run|pause|reset|speed|gate|weir|dam|river|flood|rain|map|share|still|survey|model run|inflow|outflow|upstream|downstream|discharge|storage|intake|canal|day|days|week|month|year|hour|open|close|closed|settings|layer|layers|search|show|hide|view|record|download|error|warning|source|sources|done|ready|start|stop|play|level)\b/i;
const ALLOW = /\b(OKU|EL|DAS|DI|S|C|R|A|P|ERA5|GloFAS|Copernicus|Sentinel-2|EOX|Overture|OpenStreetMap|MapLibre|three\.js|GLO-30|3D|km|m|ha|mm)\b/g;
const english = Object.entries(ID).filter(([, v]) => EN_WORDS.test(String(v).replace(/\{\w+\}/g, '').replace(ALLOW, ''))).map(([k, v]) => `${k}: "${v}"`);
const notEnglishInEn = Object.entries(EN).filter(([k, v]) => ID[k] != null && v === ID[k] && WORDY.test(v) && /\b(dan|yang|di|ke|air|sungai|bendung|pintu|debit)\b/i.test(v)).map(([k, v]) => `${k}: "${v}"`);

let overrides = {};
try { overrides = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/i18n/en-overrides.json'), 'utf8')); } catch {}
const firstFb = (k) => (overrides[k] != null ? overrides[k] : [...keys.get(k).fallbacks][0]);
const enDiffers = used.filter((k) => EN[k] != null && (keys.get(k).fallbacks.size === 1 || overrides[k] != null) && EN[k] !== firstFb(k)).map((k) => `${k}: table "${EN[k]}" · code "${firstFb(k)}"`);
let basis = {};
try { basis = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/i18n/id-basis.json'), 'utf8')); } catch {}
const idStale = used.filter((k) => ID[k] != null && basis[k] != null && keys.get(k).fallbacks.size === 1 && overrides[k] == null && basis[k] !== firstFb(k)).map((k) => `${k}: was "${basis[k]}" · now "${firstFb(k)}"`);

const report = { at: new Date().toISOString(), files: files.length, keys: used.length, missing_id: missId, missing_en: missEn,
  english_in_id: english, indonesian_in_en: notEnglishInEn, two_fallbacks: multiFb.map((k) => `${k}: ${[...keys.get(k).fallbacks].map((s) => JSON.stringify(s)).join(' | ')}`),
  en_differs: enDiffers, id_stale: idStale, dynamic_keys: dynamic, bypass, unused_in_tables: unused };

if (args.has('--json')) {
  report.fallbacks = Object.fromEntries(used.map((k) => [k, firstFb(k) ?? null]));
  report.where = Object.fromEntries(used.map((k) => [k, [...keys.get(k).where]]));
  console.log(JSON.stringify(report, null, 1));
} else if (args.has('--todo')) {
  for (const k of [...new Set([...missId, ...missEn])]) {
    const fb = [...keys.get(k).fallbacks][0] ?? '';
    console.log(`  ${JSON.stringify(k)}: ${JSON.stringify(fb)},   // ${[...keys.get(k).where][0]}`);
  }
} else {
  const sec = (title, list) => { console.log(`${title}: ${list.length}`); for (const x of list.slice(0, 80)) console.log('  ' + x); };
  console.log(`harvest ${report.at} · ${report.files} files · ${report.keys} keys`);
  sec('missing from id.js', missId);
  sec('missing from en.js', missEn);
  sec('English left in id.js', english);
  sec('one key, two English fallbacks', report.two_fallbacks);
  sec('English table differs from the code (run merge en --fallbacks)', enDiffers);
  sec('English changed since the Indonesian was written', idStale);
  sec('dynamic keys (check by hand)', dynamic);
  sec('visible text outside t()', bypass);
  console.log(`in the tables but not used now: ${unused.length}`);
}
process.exitCode = missId.length || missEn.length || idStale.length ? 1 : 0;
