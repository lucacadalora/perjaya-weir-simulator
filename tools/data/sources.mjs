#!/usr/bin/env node
// b18: harvest the "## Sources" sections of the research notes into data-src/sources.auto.json.
// Keys are "<note id>:<KEY>", e.g. "r01:J19". Run once when the notes change; the output is committed.
// Usage: node tools/data/sources.mjs <notes folder>
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/data/sources.mjs <notes folder>'); process.exit(2); }

const PUBLISHERS = [
  [/\bJICA\b|JBIC|openjicareport|jica\.go\.jp/i, 'JICA'], [/Unisma|unisma/i, 'Universitas Islam Malang'],
  [/Wikipedia/i, 'Wikipedia'], [/Open-Meteo|open-meteo/i, 'Open-Meteo'], [/Overture/i, 'Overture Maps Foundation'],
  [/Copernicus|ESA\b|DLR/i, 'Copernicus / ESA'], [/BPS|bps\.go\.id/i, 'BPS'], [/pu\.go\.id|PUPR|Kementerian PU/i, 'Kementerian PU'],
  [/antaranews|Antara/i, 'Antara'], [/detik/i, 'detik.com'], [/jpnn/i, 'JPNN'], [/kumparan/i, 'kumparan'],
  [/medcom/i, 'Medcom'], [/mongabay/i, 'Mongabay'], [/Koran Jakarta|koran-jakarta/i, 'Koran Jakarta'],
  [/ECMWF|C3S/i, 'ECMWF / Copernicus C3S'], [/Charles Sturt/i, 'Charles Sturt University'], [/jdih|peraturan|Permen|PP \d/i, 'Republik Indonesia'],
];
const BLOCK = /our own|BASE\/|\/home\/|perjaya-baseline|lanes\//i;

const out = {};
for (const f of readdirSync(dir).filter((f) => /^[rg]\d\d-.*\.md$/.test(f) && !/^r1[25]-/.test(f)).sort()) {
  const note = f.slice(0, 3);
  const text = readFileSync(join(dir, f), 'utf8');
  const m = text.split(/^## Sources\s*$/m)[1];
  if (!m) continue;
  for (const raw of m.split('\n')) {
    const line = raw.replace(/^\s*-\s*/, '').trim();
    const km = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (!km) continue;
    const key = `${note}:${km[1].trim()}`;
    let rest = km[2];
    if (BLOCK.test(rest) && !/https?:\/\//.test(rest)) continue;
    const um = rest.match(/(?:https?:\/\/|s3:\/\/)[^\s,;)]+/);
    const url = um ? um[0].replace(/[.]$/, '') : null;
    let title = (um ? rest.slice(0, um.index) : rest).replace(/[,;\s]+$/, '').trim();
    if (!title) title = rest.replace(url || '', '').replace(/^[,;\s]+/, '').split(',')[0].trim();
    title = title.replace(/,?\s*read \d{1,2} \w{3} \d{4}\.?$/i, '').trim();
    const access = /snippet|summary only|403|not opened/i.test(rest) ? 'search snippet or summary only' : null;
    const years = [...title.matchAll(/\b(19[5-9]\d|20[0-2]\d)\b/g)].map((x) => +x[1]);
    const pub = PUBLISHERS.find(([re]) => re.test(rest));
    if (BLOCK.test(title)) continue;
    out[key] = { title, publisher: pub ? pub[1] : null, year: years.length ? years[years.length - 1] : null, url: BLOCK.test(url || '') ? null : url };
    if (access) out[key].access = access;
  }
}
writeFileSync(join(ROOT, 'data-src', 'sources.auto.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`${Object.keys(out).length} sources written`);
