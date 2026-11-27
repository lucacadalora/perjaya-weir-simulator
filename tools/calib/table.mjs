// tools/calib/table.mjs (lane b15): ground flooded BEYOND the normal river on the real fine grid (CONTRACT A7).
// Rises in metres: below the weir over flood.ref_tail_el, above it over the normal pond. Node only.
//   node tools/calib/table.mjs [--json tools/calib/fine-stage-table.json]
// Everything here is computed from a 30 m surface model with tree tops and roofs: a model, not a survey.
import { readFile, writeFile } from 'node:fs/promises';
import { loadPacks } from '../../site/js/engine/node-loader.js';
import { extent, stageAt, prepare, param } from '../../site/js/engine/flood.js';
import { weirParamsFromData } from '../../site/js/engine/weir.js';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const readJson = async (p) => JSON.parse(await readFile(new URL(p, import.meta.url), 'utf8'));

let params = null, weirJson = null;
try { params = await readJson('../../site/data/params.json'); } catch { /* not yet written */ }
try { weirJson = await readJson('../../site/data/weir.json'); } catch { /* not yet written */ }
const floodParams = params ? params.flat || params : null;
let weirParams = null;
try { weirParams = params ? weirParamsFromData(params, weirJson) : null; } catch { weirParams = null; }

const G = await loadPacks(['fine'], { layers: ['dem', 'dir', 'acc', 'hand', 'lc'] });
if (!G.fine || !G.fine.hand) { console.error('fine grid with HAND not found'); process.exit(1); }
let river = { river_cells: 0 };
try { river = prepare(G, { grid: 'fine', river_poly: await readJson('../../site/data/feat/river_poly.geojson') }); } catch { /* none */ }

const rows = [];
const run = (stage_m, stage_up_m) => {
  const a = performance.now();
  const r = extent(G, { grid: 'fine', stage_m, stage_up_m, floodParams });
  rows.push({ stage_m, stage_up_m, cells: r.cells, area_km2: +r.area_km2.toFixed(2), area_ha: Math.round(r.area_km2 * 100),
    area_up_km2: +r.area_up_km2.toFixed(2), area_down_km2: +r.area_down_km2.toFixed(2),
    volume_mcm: +(r.volume_m3 / 1e6).toFixed(2), depth_max_m: r.depth_max_m, ms: Math.round(performance.now() - a) });
};
run(1, 0); rows.length = 0; // warm-up: the first call prepares the grid
for (const s of [0, 0.25, 0.5, 1, 1.8, 3, 4, 5]) run(s, 0);
for (const su of [0.25, 0.5, 1, 1.3]) run(0, su);

const flows = [203, 500, 1000, 1250, 1500, 1939, 2200].map((q) => {
  const s = stageAt(q, floodParams, weirParams);
  return { q_m3s: q, rise_m: s == null ? null : +s.toFixed(2) };
});

const md = [];
md.push(`Fine grid ${G.fine.cols} x ${G.fine.rows}; river outline ${river.river_cells} cells; land cover ${G.fine.lc ? 'loaded' : 'missing'}; ` +
  `ref_tail_el ${param(floodParams, 'ref_tail_el')}, min_depth_m ${param(floodParams, 'min_depth_m')}.`);
md.push('');
md.push('| Rise below m | Rise above m | Area km2 | ha | Up km2 | Down km2 | Volume million m3 | Depth max m | ms |');
md.push('|---|---|---|---|---|---|---|---|---|');
for (const r of rows) md.push(`| ${r.stage_m} | ${r.stage_up_m} | ${r.area_km2} | ${r.area_ha} | ${r.area_up_km2} | ` +
  `${r.area_down_km2} | ${r.volume_mcm} | ${r.depth_max_m} | ${r.ms} |`);
md.push('');
md.push(`Rise below the weir from the weir engine's tail rating: ` + flows.map((f) => `${f.q_m3s} m3/s -> ${f.rise_m} m`).join(', '));
console.log(md.join('\n'));

if (jsonOut) {
  await writeFile(jsonOut, JSON.stringify({ note: 'Ground flooded beyond the normal river (land cover 80 and the river ' +
    'outline left out), computed from a 30 m surface model (Copernicus GLO-30), not a survey. stage_m = rise of the tail ' +
    'over flood.ref_tail_el; stage_up_m = rise of the pond over the normal pond.', grid: 'fine',
    ref_tail_el: param(floodParams, 'ref_tail_el'), river_cells: river.river_cells, rises: rows, rating: flows }, null, 1) + '\n');
}
