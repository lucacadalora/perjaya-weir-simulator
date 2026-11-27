# Tools

Node tools need Node 20 or later and nothing installed (no `npm install`). Run them from the repository root.

| Command | What it does |
|---|---|
| `node tools/serve.mjs --port 8791` | Static server for `site/` on 127.0.0.1 (correct MIME types, byte ranges, no caching). `--port 0` picks a free port, `--root <dir>` serves another folder, `--log` prints requests. Ctrl-C stops it. Can also be imported: `const { server, base } = await serve({ port: 0 })`. |
| `node tools/data/build.mjs` | Rebuilds `site/data/{facts,params,weir,presets,credits}.json` from the fragments in `data-src/` (writes a new build time into each file). |
| `node tools/data/check.mjs` | Checks those five files: every fact has a status letter, a bilingual label and existing sources; every `{v, status, src}` leaf is complete; the flat copy matches. Exit 0 when clean, 1 with a list of problems. |
| `node tools/data/sources.mjs <notes folder>` | Harvests the "## Sources" sections of the research notes into `data-src/sources.auto.json`. The research notes are not part of this repository, so this tool is kept only to document how that file was made. |
| `node tools/calib/table.mjs [--json tools/calib/fine-stage-table.json]` | Flood calibration table on the real fine grid: area flooded beyond the normal river for a range of rises below and above the weir, and the weir engine's tail rating. |
| `python3 tools/geo/river_widths.py` | Gives every line in `site/data/feat/rivers.geojson` a drawn width `w` (a display estimate from upstream area) and the flag `poly`. Python 3 standard library only; rewrites the file in place. |
| `node tools/i18n/harvest.mjs [--json \| --todo]` | Lists text keys used in the code and compares them with the Indonesian and English tables in `site/js/i18n/`. Exit 1 when it finds a missing key or other finding (a report, not a failure of the tool). |
| `node tools/i18n/merge.mjs <id\|en> <file.json>` | Merges `{key: text}` into the language tables; `en --fallbacks` adds missing English keys from the code's fallbacks. |
| `python3 tools/targets/calc_examples.py` then `python3 tools/targets/make_targets.py` | Recompute the 39 engine test targets by hand-written Python (needs numpy) and write `test/targets.json`. |
| `tools/dataprep/` | The scripts that made the terrain, hydrology, land-cover, map-feature, satellite and climate files under `site/data/` from open datasets. See `tools/dataprep/README.md`. |

`tools/i18n/en-overrides.json`, `id-basis.json` and `runtime-keys.json` are inputs of the i18n tools.
`tools/calib/fine-stage-table.json` is the stored output of `tools/calib/table.mjs`.
