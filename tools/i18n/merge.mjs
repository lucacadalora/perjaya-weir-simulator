#!/usr/bin/env node
// Write strings into the language tables. Owner: lane b03.
//   node tools/i18n/merge.mjs id <file.json>   merge {key: text} into site/js/i18n/id/<area>.js (area = text before the first dot)
//   node tools/i18n/merge.mjs en <file.json>   the same for English
//   node tools/i18n/merge.mjs en --fallbacks   add every missing English key from its fallback in the code
// Each area file is a sorted flat object; site/js/i18n/<lang>.js is rebuilt to import every area file.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'site/js/i18n');
const [lang, src] = process.argv.slice(2);
if (!['id', 'en'].includes(lang) || !src) { console.error('usage: merge.mjs id|en <file.json>|--fallbacks'); process.exit(2); }

let add;
if (src === '--fallbacks') {
  let out;
  try { out = execFileSync(process.execPath, [path.join(ROOT, 'tools/i18n/harvest.mjs'), '--json'], { encoding: 'utf8', maxBuffer: 1 << 26 }); }
  catch (e) { out = e.stdout; }
  const rep = JSON.parse(out);
  add = {};
  for (const k of rep['missing_' + lang]) if (rep.fallbacks[k] != null) add[k] = rep.fallbacks[k];
  // English follows the code: when a lane changes its fallback, the English table follows it.
  if (lang === 'en') for (const line of rep.en_differs || []) { const k = line.split(':')[0]; add[k] = rep.fallbacks[k]; }
} else add = JSON.parse(fs.readFileSync(src, 'utf8'));

const langDir = path.join(DIR, lang);
fs.mkdirSync(langDir, { recursive: true });
const areaOf = (k) => k.split('.')[0].replace(/[^\w-]/g, '_');

async function readArea(area) {
  const p = path.join(langDir, area + '.js');
  if (!fs.existsSync(p)) return {};
  return (await import(pathToFileURL(p).href + '?v=' + Date.now())).default || {};
}

function writeArea(area, obj) {
  const keys = Object.keys(obj).sort();
  const body = keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(obj[k])},`).join('\n');
  const head = `// ${lang === 'id' ? 'Indonesian' : 'English'} strings, area "${area}". Owner: lane b03. Written by tools/i18n/merge.mjs; keep it sorted.\n`;
  fs.writeFileSync(path.join(langDir, area + '.js'), `${head}export default {\n${body}\n};\n`);
}

// Move any strings that still live in the old flat <lang>.js into area files once.
const flat = path.join(DIR, lang + '.js');
const flatSrc = fs.existsSync(flat) ? fs.readFileSync(flat, 'utf8') : '';
if (flatSrc && !flatSrc.includes('Written by tools/i18n/merge.mjs')) {
  const old = (await import(pathToFileURL(flat).href + '?v=' + Date.now())).default || {};
  add = { ...old, ...add };
}

// Remember the English each Indonesian string was translated from, so the harvest can say when the English moved.
if (lang === 'id' && src !== '--fallbacks') {
  let rep;
  try { rep = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'tools/i18n/harvest.mjs'), '--json'], { encoding: 'utf8', maxBuffer: 1 << 26 })); }
  catch (e) { rep = JSON.parse(e.stdout); }
  const bp = path.join(ROOT, 'tools/i18n/id-basis.json');
  const basis = fs.existsSync(bp) ? JSON.parse(fs.readFileSync(bp, 'utf8')) : {};
  for (const k of Object.keys(add)) if (rep.fallbacks[k] != null) basis[k] = rep.fallbacks[k];
  fs.writeFileSync(bp, JSON.stringify(Object.fromEntries(Object.entries(basis).sort()), null, 1) + '\n');
}

const byArea = {};
for (const [k, v] of Object.entries(add)) (byArea[areaOf(k)] ||= {})[k] = v;
let n = 0;
for (const [area, obj] of Object.entries(byArea)) {
  const cur = await readArea(area);
  for (const [k, v] of Object.entries(obj)) { if (cur[k] !== v) n++; cur[k] = v; }
  writeArea(area, cur);
}

const areas = fs.readdirSync(langDir).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).sort();
const ident = (a) => 'a_' + a.replace(/[^\w]/g, '_');
const agg = `// ${lang === 'id' ? 'Indonesian' : 'English'} strings. Owner: lane b03. Written by tools/i18n/merge.mjs from ${lang}/<area>.js; edit the area files.\n`
  + areas.map((a) => `import ${ident(a)} from './${lang}/${a}.js';`).join('\n')
  + `\n\nexport default {\n${areas.map((a) => `  ...${ident(a)},`).join('\n')}\n};\n`;
fs.writeFileSync(flat, agg);
console.log(`${lang}: ${n} strings written · ${areas.length} areas`);
