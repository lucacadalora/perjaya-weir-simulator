#!/usr/bin/env node
// b18: checks site/data/{facts,params,weir,presets,credits}.json. Exit 0 when clean, 1 with a list of problems.
// - every fact has a status letter, a label {id,en} and at least one source key that exists in facts.sources
// - no fact key twice across the fragments in data-src/facts/
// - every {v, status, src} leaf in params.json and weir.json is complete (v, unit, status, src) and its sources exist
// - params.flat matches the grouped leaves; timeline, stand-ins and credits are well formed
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const D = join(ROOT, 'site', 'data');
const read = (n) => JSON.parse(readFileSync(join(D, n), 'utf8'));
const ST = new Set(['S', 'C', 'R', 'A', 'P']);
const errs = [];
const err = (m) => errs.push(m);

const facts = read('facts.json');
const sources = facts.sources || {};
const srcOk = (where, src) => {
  if (!Array.isArray(src) || !src.length) return err(`${where}: no source`);
  for (const k of src) if (!sources[k]) err(`${where}: source key "${k}" not in facts.sources`);
};

// facts
let nFacts = 0;
for (const [k, f] of Object.entries(facts.facts || {})) {
  nFacts++;
  if (!ST.has(f.status)) err(`fact ${k}: status "${f.status}"`);
  if (f.v === undefined || f.v === null) err(`fact ${k}: no value`);
  if (!f.label || !f.label.id || !f.label.en) err(`fact ${k}: label needs id and en`);
  if (f.v && typeof f.v === 'object' && !Array.isArray(f.v) && (!f.v.id || !f.v.en)) err(`fact ${k}: text value needs id and en`);
  if (f.note && (!f.note.id || !f.note.en)) err(`fact ${k}: note needs id and en`);
  srcOk(`fact ${k}`, f.src);
  for (const a of f.alt || []) { if (a.v === undefined) err(`fact ${k}: alt without v`); srcOk(`fact ${k} alt`, a.src); }
}
for (const k of facts.meta?.key_facts || []) if (!facts.facts[k]) err(`meta.key_facts: "${k}" is not a fact`);
for (const k of Object.keys(sources)) { const s = sources[k]; if (!s.title) err(`source ${k}: no title`); }
// top-level keys of a JSON object text, in order, duplicates kept (JSON.parse would drop them)
function topKeys(text) {
  const keys = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (depth === 1 && /^\s*:/.test(text.slice(j + 1, j + 20))) keys.push(JSON.parse(text.slice(i, j + 1)));
      i = j;
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return keys;
}
// no key twice in the fragments
const seen = new Map();
const fdir = join(ROOT, 'data-src', 'facts');
for (const f of readdirSync(fdir).filter((f) => f.endsWith('.json'))) {
  const text = readFileSync(join(fdir, f), 'utf8');
  for (const k of topKeys(text)) {
    if (k.startsWith('_')) continue;
    if (seen.has(k)) err(`fact key "${k}" twice: ${seen.get(k)} and ${f}`); else seen.set(k, f);
  }
}
(facts.timeline || []).forEach((t, i) => { if (!t.date || !t.id || !t.en) err(`timeline[${i}] incomplete`); srcOk(`timeline[${i}]`, t.src); });
(facts.standins || []).forEach((t, i) => { if (!t.id || !t.en) err(`standins[${i}] needs id and en`); });

// leaves in params and weir
let nLeaves = 0;
function walk(node, path, cb) {
  if (Array.isArray(node)) return node.forEach((x, i) => walk(x, `${path}[${i}]`, cb));
  if (!node || typeof node !== 'object') return;
  if ('v' in node && ('status' in node || 'src' in node)) return cb(node, path);
  for (const [k, v] of Object.entries(node)) if (k !== 'meta' && k !== 'flat' && k !== 'check' && k !== 'calc') walk(v, path ? `${path}.${k}` : k, cb);
}
const leafCheck = (file) => (l, path) => {
  nLeaves++;
  if (l.v === undefined || l.v === null) err(`${file} ${path}: no v`);
  if (!l.unit) err(`${file} ${path}: no unit`);
  if (!ST.has(l.status)) err(`${file} ${path}: status "${l.status}"`);
  srcOk(`${file} ${path}`, l.src);
  for (const a of l.alt || []) srcOk(`${file} ${path} alt`, a.src);
};
const params = read('params.json');
walk(params, '', leafCheck('params'));
walk(read('weir.json'), '', leafCheck('weir'));
// flat copy
const grouped = {};
walk(params, '', (l, path) => { grouped[path] = l.v; });
for (const [k, v] of Object.entries(grouped)) if (JSON.stringify(params.flat?.[k]) !== JSON.stringify(v)) err(`params.flat["${k}"] differs from the grouped leaf`);
for (const k of Object.keys(params.flat || {})) if (!(k in grouped)) err(`params.flat["${k}"] has no grouped leaf`);
if (params.datum?.offset_m?.status !== 'C') err('params.datum.offset_m should be computed (C)');

// presets and credits
const presets = read('presets.json');
const ids = new Set();
presets.forEach((p, i) => {
  if (!p.id || ids.has(p.id)) err(`presets[${i}]: id missing or twice`); ids.add(p.id);
  if (!['place', 'dam', 'view'].includes(p.kind)) err(`preset ${p.id}: kind`);
  if (!p.name?.id || !p.name?.en) err(`preset ${p.id}: name needs id and en`);
  for (const k of ['lon', 'lat', 'zoom', 'pitch', 'bearing']) if (typeof p[k] !== 'number') err(`preset ${p.id}: ${k}`);
  if (p.kind === 'dam' && !p.dam) err(`preset ${p.id}: dam block missing`);
  if (p.src) srcOk(`preset ${p.id}`, p.src);
});
if (!ids.has('weir')) err('presets: no "weir" entry');
read('credits.json').forEach((c, i) => { for (const k of ['id', 'short', 'full', 'licence', 'url']) if (!c[k]) err(`credits[${i}]: ${k}`); });

if (errs.length) { console.log(errs.join('\n')); console.log(`FAIL ${errs.length} problems`); process.exit(1); }
console.log(`OK ${nFacts} facts, ${Object.keys(sources).length} sources, ${(facts.timeline || []).length} timeline, ${nLeaves} leaves, ${Object.keys(params.flat).length} flat, ${presets.length} presets`);
