# Hydraulic review of the engines (23 November 2026)

This is the independent review referred to in the paper (section 6). It was made after every unit test had passed,
by running the whole chain on the real data files, and it is published as written, with two changes: the reviewer's
scratch scripts are not in this repository (the paths `.scratch/x01/` below name them), and file and line references
are those of the code on the day of the review. "CONTRACT A7" is the set of rulings in `docs/CONTRACT.md`, section 9;
lane ids (b13, b14, s01, ...) are explained at the top of that file. Later rounds dealt with the open items N1
(gate lifts, CONTRACT A8.7), N3 and N4 (canal demand and yearly shortage counts, A8.5) and N5 (the flood reference
is stated on the impact tab and can be shifted, A8.4). N2, the monthly shape of the flow, is still open and is
reported in the paper.

Reviewer: lane x01, read as a senior hydraulic engineer. No code changed. Every number below comes from a run in
node on the real data files (`site/data/params.json`, `weir.json`, `climate/*.json`, the `fine` and `wide` grid
packs, `feat/buildings.bin`). Scripts: `.scratch/x01/*.mjs` (weir_balance, weir_sweep, modes, chain, rain, flood,
flood2, res, irr). Engine tests: `node --test --test-concurrency=4 'site/js/engine/*.test.js'` = 88 tests, 87 pass,
**1 fails** (`weir.test.js:194`, the design-flood check of finding H1).

Severity: **H** = a water engineer would reject the screen; **M** = wrong but bounded, say it or fix it;
**L** = tidy-up or wording.

## Findings, worst first

| # | Sev | Where | Got | Expected and why | Smallest fix | Owner |
|---|---|---|---|---|---|---|
| H1 | H | `params.json` `weir.tail_bed_el` 76.8 (C), used by `weir.js:129` `tailwater` and `:229` `tailFor` | Tail rating: 203 m3/s -> EL 78.21, 800 -> 80.00, 1,400 -> 81.27, 2,200 -> 82.65. Auto mode: pond EL 82.74 at 2,200 (flood mode 82.89; Q100 1,939 -> 82.44), **1.7 to 1.9 m over the design high water EL 81.00**; pond over 81.00 from **1,295 m3/s**, below the 10-year flood (1,372). From about 650 m3/s the tail reaches the normal pond, so auto jumps from all gates at 0.93 m (600) straight to every gate and sluice fully open (800); from there the weir is drowned (pond only 0.07 to 0.25 m over the tail). The structure itself is not the limit: with a free tail it passes **3,950 m3/s at EL 81.00**. | A5: the design flood with every gate open peaks at or a little under EL 81.00; the (weak) design tailwater is EL 80.00. The tail section was anchored by taking the flight-day tail surface (EL 78.2, which rests on the -3.2 m offset and a 30 m surface model with up to 4 m vertical error) as the **mean** flow. Both anchors cannot hold with one Manning section: through EL 80.0 at 2,200 the flight-day surface would be the level of about 1,260 m3/s. | Lead rules which anchor wins (A5 already implies the design case). Then b18 sets `weir.tail_bed_el` from the design case: bed **EL 74.0** (= `weir.riverbed_el`) gives tail 79.85 at 2,200 and pond **EL 80.64** with every gate open (test passes, no other change); mean-flow tail becomes 75.41. Optional later: a two-segment rating through both points. | b18, lead |
| H2 | H | `weir.js:314` `autoGates`: `qInt = Math.min(want, cap, qIn)` | The intake takes water before the river: inflow 20, 35, 50, 80 m3/s -> **0.0 m3/s below the weir**; inflow 100 with the engine's own demand 112 -> 0.0. Chained over real years (flow -> irrigation demand -> weir auto): 2019 model replay **46 days**, 1997 **61 days**, GloFAS 2019 45 days with the river below the weir under the maintenance flow 35 m3/s while the inflow is above it. The alert `river_dry_below` fires, but the auto rule causes it. | The maintenance flow (35 m3/s, S) is kept in the river first; `irrigation.balance` already does this (`irrigation.js:186`), so the two engines disagree on the same day. | `qInt = Math.min(want, cap, Math.max(0, qIn - (ops.q_env_m3s ?? 0)))`. | b14 |
| H3 | H | `irrigation.js:71` `r5` is null: `params.json` has no `irrigation.r5_halfmonth_mm`, so effective rain Re = 0 in every half-month | Peak DR **1.80 l/s/ha** (Mar II, Nov II) -> **112.4 m3/s** for the default 62,536 ha; 1.67 and 1.51 l/s/ha in four more half-months. Demand is over the intake maximum (101) in 4 half-months and over the design capacity 91.68 in 6. | Sourced peak 1.1 l/s/ha -> 68.8 m3/s (`irrigation.unit_demand_peak_lsha`, `peak_demand_default_m3s`). KP-01 subtracts Re = 0.7 R80/15. With a rough Re from 60 % of the half-month mean rain the same engine gives a peak of **1.05 l/s/ha**: the method is right, the input is missing. | b18 adds `irrigation.r5_halfmonth_mm` [24] (80 % dependable half-month basin rain from `climate/rain.json`, C); until then b17 derives it from rain.json rather than using 0. | b18, b17 |
| H4 | H | `params.json` `flood.base_q_m3s` 56 against `weir.tail_bed_el` (flight day = 203.1); `flood.js:85` `stageAt`; counts in `impact.js` `count` | At the mean flow 203 m3/s: stage 0.76 m, **14.27 km2 flooded, 107 buildings** (>= 0.3 m; 112 at any depth), 1.2 km of road. Extent jumps 0 -> 13.9 km2 between 100 and 150 m3/s. With the base set to 203.1: 0 at 203, but 14.27 km2 and 107 buildings again at 400 m3/s, because the first wet cells are the **channel itself** (WorldCover permanent water, class 80: 9.8 km2 of the 14.3). | A normal river floods nothing. The same flight-day surface is the 56 m3/s surface in the flood engine and the 203 m3/s surface in the weir engine. | (1) One flight-day flow for both engines (b18 rules; the weir's anchor changes with H1, the flood's should follow). (2) b15 or b16: report flooded area and buildings **outside the normal river**: subtract the extent at the mean flow (`hydro.mean_flow_m3s`) and drop permanent-water cells (lc 80 or `feat/river_poly.geojson`) from area; label "di luar sungai normal". | b18, b15, b16 |
| M5 | M | `params.json` `rainflow.bucket_k_slow_days` 240, `bucket_gw_share` 0.75 (fitted by b13, C) | Replay 1991-2024 monthly Q80 Jul-Oct **142 / 122 / 108 / 98** against the published 88 / 73 / 68 / 56 (+60 to +75 %); lowest day of the dry year 2019 **92 m3/s** (published 10-year low flow 23). Climatology mean year: Sep 114 vs 135 (-16 %), Oct 102 vs 141 (-28 %), Apr 256 vs 292 (-12 %). | Dependable flow is what irrigation and the dry-year scenarios run on; the published Q80 table is in params. The slow store makes every dry season the same. | Refit against the monthly Q80 table as well as the monthly means (shorter `k_slow_days`, lower `gw_share`); or show the replay Q80 next to the published one with a note. | b13 |
| M6 | M | `rainflow.js` bucket, `bucket_k_days` 12.5 | Replay annual daily maxima **271 to 530 m3/s** (Gumbel Q100 505) vs published Q2 917, Q100 1,939, largest 1,438. No replay year ever reaches the flood map; floods exist only in the design scenario. | A 4,300 km2 basin fed by daily basin-mean rain will not reproduce instantaneous peaks; that is acceptable only if said. | Say on screen that replay years show seasonal flow, not flood peaks; or add a design wave to replay years. | b13 |
| M7 | M | `weir.js:319` the 'flaps' stage | Inflow between demand and demand + 9.36: pond **EL 79.94 to 79.98**, then 79.70 again at 105 m3/s (a 0.28 m jump between neighbouring flows). The leaf top closed is EL 79.90, above the normal pond, so the "flaps" pass nothing until the pond overtops them. | A flap is lowered so its crest sits under the held pond; the pond should stay at 79.70. | Drop the 'flaps' stage (go straight to the gates stage), or model the flap lowered: crest = pond target minus the head that passes the leftover flow. | b14 |
| M8 | M | `weir.js:477` (`weirParamsFromData` intake caps); `weir.settling_capacity_m3s` 80 unused | The canal takes up to **101 m3/s**; 2019 model replay: intake over 80 on **152 days**, over 91.68 on 91 days. | Five settling basins of 16 m3/s pass 80; the design intake is 91.68, operating 81. An operator holds the canal to what the basins pass. | Cap = min(capacity_max, settling_capacity) in `weirParamsFromData` (or lead rules 91.68). | b14, lead |
| M9 | M | `flood.js:216-226` pond reference `zRef` | zRef = **77.0 m** (median of main-river cells within 5 cells upstream); the normal pond in model metres is 79.70 - 3.20 = **76.5 m** (offset built from the median of the lowest 10 %). The pond adds nothing to the flood map until EL 80.2; upstream depths are 0.5 m too shallow. | One pond surface, one number. | Rise over zRef = `pond_level_m - (pond_normal_el + offset)` (pass the rise, not the level), or b18 and b15 use the same statistic. | b15, b18 |
| M10 | M | `irrigation.js:77` two rice seasons, fallow Jun II to Oct I | September demand **0**, so the September balance shows no shortfall (Q80 68, maintenance 35, 33 m3/s free). | The sourced pattern is padi-padi-palawija, 300 %: September carries a palawija crop. At about 0.3 to 0.5 l/s/ha that is 20 to 30 m3/s against 33 available: tight, not empty. | Add the third (palawija) season with its Kc table (KP-01). | b17 |
| L11 | L | `weir.js` tailwater vs `flood.js` stageAt | Same reach, same section (200 m, z 2, n 0.035, S 0.0004), two bases: at 2,200 m3/s the weir says 4.44 m over the flight-day surface, the flood map 5.20 m. Rise from mean flow to 2,200 = 4.4 m: plausible for a river 150-200 m wide and in line with the 5.08 m range of the Martapura staff gauge; not tens of metres. Area grows with stage without ever falling (0.5 m: 13.9 km2 ... 5.0 m: 51.6 ... 8.0 m: 88.0), in steps every 0.5 m. | One rating for both engines. | Fold into H1 and H4: flood.stageAt reads the weir's tail rating. | b15, b14 |
| L12 | L | `rainflow.js:306` design wave, `rainflow.design_tp_days` 2, `design_shape` 4 | 2,200 m3/s on 15 Apr; daily 261, 1,154, **2,200**, 1,581, 812, 428; wave volume **433 Mm3 = 101 mm** over 4,305 km2 in about 4 days. | Volume plausible (ERA5 basin 3-day maxima 52-139 mm, Martapura point day 207 mm). The base is short for a 4,300 km2 basin (5-8 days usual) and the weir sees the peak for one instant with daily steps. | Optional: tp 3 days; step hourly around the peak in films. | b13 |
| L13 | L | `reservoir.js:347` curve base = seed ground | Dam 30 m at 104.034 E 4.527 S (1,211 km2): dam foot 128.4 m, storage curve starts at **136.6 m** (seed 8.2 m above the river); pits enter as steps (0.13 Mm3 at +0.37 m over 0.026 km2). Otherwise right: no negative volume (0 of 365 days, also drained at 1,000 m3/s), spill only above the crest, level and volume agree with the curve to 0.000 %, evaporation 3.2 mm/day over the lake (1.6-3.2 when Puls averages a changing area). | An empty lake should read the river bed at the dam. | Start the curve at `base_el` from damLine, or seed on the lowest river cell above the wall. | b12 |
| L14 | L | `maker-run.js` (no `offset_m`) | Maker levels are terrain metres in fields named `*_el`; weir mode is project EL. At the weir site the two differ by 3.2 m. | One datum on screen, or a label. | Label maker levels "m (model)" or pass the offset. | s01 |
| L15 | L | `weir-run.js:305` | A day counts as supplied when the shortfall is within 5 %; `irrigation.balance` uses 0.1 %. | One rule. | Use `balance` or the same tolerance. | s01 |
| L16 | L | `irrigation.eto_mm_day` 4.0 scalar | Irrigation uses 4.0 mm/day all year while `rainflow.et0_monthly_mm` carries 3.2 to 4.3. | Same ETo in both engines. | Pass the monthly series. | b17, b18 |

## What I checked and found right

- **Mass balance at the weir** closes to better than 0.01 % at every flow 5 to 3,000 m3/s (5 m3/s steps) and in
  every mode (auto, flood, flush, closed, manual). No gate or sluice is ever "open" with no flow; the tail is never
  above the pond in auto mode.
- **Normal operation**: from 105 to 600 m3/s the pond is held at EL 79.70 (+/- 0.00); gates open in the order
  FG6, FG7, FG5 ... FG1 at 0.30 m, then all together; sluices stay shut until the flood stage. Intake: at 79.70 a
  full opening passes 110 m3/s, capped at 101 and the demand.
- **Units and datum**: mm over km2 to m3/s and back (`rainflow.js:14-19`), l/s/ha to m3/s (`irrigation.js:165`),
  DR = NFR / 8.64 e, days to seconds (`weir-run.js:276`, `maker-run.js:198`), decimetres in HAND, DEM and depth
  grids (`flood.js`, `reservoir.js`) are all right. The offset is crossed in exactly one place in the engines'
  chain (`weir-run.js:321`, pond EL to model metres for the flood map); the 3D layers convert with the same key.
- **Rain to flow, means**: yearly mean 205.7 m3/s on the 1991-2024 replay and 194.2 on the climatology year
  against the published 203.1 (+1 %, -4 %); replay monthly means within 13 % of the published table every month.
  Stores never negative over 34 years (soil 12-197 mm, slow store 323-1,243 mm, no drift).
- **Reservoir routing** (maker dam): see L13; the method and the mass balance are right.
- **Flood stage** of a few metres for 2,200 m3/s (L11) and a monotone area against stage.

## What I would show a water engineer today

- **Yes**: the weir's normal operation up to about 600 m3/s (levels, gate order, intake), the mass balance, unit
  handling, the yearly and monthly mean flows, the maker-dam fill and spill.
- **Not yet**: anything at flood flows (pond level, freeboard, gates_full, flood map, building counts: H1, H4,
  M9), the river below the weir in the dry season (H2), irrigation demand and the irrigation balance (H3, M10, M8),
  dependable flows and dry years (M5), and floods in replay years (M6).

## Re-check after the fix round (CONTRACT A7), 23 Nov 2026

Re-ran every script on the current tree (`.scratch/x01/`: weir_balance, weir_sweep, openings, flood3, irr2, chain2,
wave, res). Tests: `node --test --test-concurrency=4 'site/js/engine/*.test.js' 'test/**/*.test.js'` = 133 tests,
130 pass, **0 fail**, 3 skipped.

### Weir, automatic mode (demand 91.68 asked; auto holds the canal to 81)

| Inflow | Pond EL | Tail EL | Stage | Gates open (m) | Canal | River below | Balance error |
|---|---|---|---|---|---|---|---|
| 20 | 79.70 | 74.58 | gates | FG6 0.20 | 0.0 | 20.0 | 0.00 % |
| 50 | 79.70 | 74.71 | gates | FG6 0.30, FG7 0.04 | 15.0 | 35.0 | 0.00 % |
| 100 | 79.70 | 74.71 | gates | FG6 0.30, FG7 0.04 | 65.0 | 35.0 | 0.00 % |
| 203 | 79.70 | 75.25 | gates | FG3 0.09, FG4-7 0.30 | 81.0 | 122.0 | 0.00 % |
| 400 | 79.70 | 76.05 | all gates | 0.50 | 81.0 | 319.0 | 0.00 % |
| 800 | 79.70 | 77.19 | all gates | 1.12 | 81.0 | 719.0 | 0.00 % |
| 1,400 | 79.70 | 78.48 | flood | 4.50 + sluices 0.42 | 81.0 | 1,319 | 0.00 % |
| 2,200 | **80.60** | 79.87 | flood_full | all 4.50 | 81.0 | 2,119 | 0.00 % |
| 3,000 | 81.88 | 81.05 | flood_full | all 4.50 | 81.0 | 2,919 | 0.00 % |

Flood mode (every gate open): 1,939 -> pond 80.29, 2,200 -> **80.74**, tail exactly 80.00. Sweep 5-3,000 m3/s in
5 m3/s steps: no pond jump over 0.05 m, tail never above pond, no gate open without flow, pond never over EL 81.00
below 2,200. New, cosmetic: between 1,360 and 1,370 m3/s the leaves jump from 2.27 m to full lift 4.50 m with no
change in flow (once the lip clears the water a higher lift passes nothing more: capacity flat at 1,273 m3/s from
2.4 m up); the 3D gates leap at that flow.

### Flood beyond the normal river (rises after A7.3; buildings >= 0.3 m deep)

| Inflow | Rise below / above (m) | Area km2 (above weir) | Buildings | Roads km |
|---|---|---|---|---|
| 203 | 0 / 0 | 0.00 | 0 | 0 |
| 800 | 0 / 0 | 0.00 | 0 | 0 |
| 1,250 | 0 / 0 | 0.00 | 0 | 0 |
| 1,400 | 0.28 / 0 | 0.00 | 0 | 0 |
| 1,939 | 1.25 / 0.45 | 3.14 (2.44) | 56 | 0.83 |
| 2,200 | 1.67 / 0.90 | 5.17 (3.27) | 73 | 1.04 |

No permanent-water cell is ever in the mask; area never falls as the rise grows (0.5 m: 0.64, 1.0: 0.70, 1.5: 1.83,
2.0: 3.71, 3.0: 6.32, 4.0: 10.44 km2). Note for the lead: on the A7 rating the reference tail EL 78.2 is the level
of about **1,175 m3/s**, so the map treats the survey-day river as nearly bank-full: the 2-year flood (917) and the
largest recorded flood (1,438, 1980) flood nothing beyond the river, and ground starts to flood at about 1,550
m3/s. That is what the ruling says; the screen should say "beyond the river as the terrain survey saw it".

### Status of the 16 findings

| # | Now | New numbers |
|---|---|---|
| H1 | **FIXED** | tail bed EL 74.23; design flood 2,200 m3/s: pond 80.60 auto, 80.74 every gate open, tail 80.00; pond over 81.00 only above about 2,700 m3/s |
| H2 | **FIXED** | river below keeps 35 m3/s whenever the inflow has it (table); dry replays 2019 and 1997: 0 days under 35 with inflow over 35 (was 46 and 61) |
| H3 | **FIXED** (with the tab's pattern) | peak 1.10 l/s/ha (May II) = 68.9 m3/s vs sourced 1.1 / 68.8. But without `irrigation.pattern` in the store (tab not mounted, `?only=` runs) `demandTable` is not ok and the canal demand is null, so the weir falls back to 81 all year: see N3 |
| H4 | **FIXED** | 0 km2 and 0 buildings at 203 m3/s (was 14.27 km2, 107) |
| M5 | **PARTLY** | replay Q80 Jul-Oct 105 / 82 / 68 / 59 vs 88 / 73 / 68 / 56 (+19, +12, 0, +5 %: meets A7.8); 2019 lowest day 46.5 m3/s (was 92). Yearly mean 196.1 (-3.4 %). But the monthly means moved the other way: Sep 95 vs 135 (-30 %), Oct 114 vs 141 (-19 %), Mar 280 vs 238 (+18 %), and Nov Q80 65 vs 109 (-40 %) |
| M6 | **OPEN** | replay annual maxima now 283-612 m3/s; the A7.9 sentence ("replay years show seasonal flow, not flood peaks") is not in the rain tab or its strings |
| M7 | **FIXED** | pond 79.70 from 20 m3/s to gates fully open; no jump |
| M8 | **FIXED** | auto canal never over 81 |
| M9 | **FIXED** | above the weir the rise is pond EL - 79.70 (0 at normal pond) |
| M10 | **FIXED** | September palawija: Sep I 0.59 l/s/ha = 36.6 m3/s against Q80 68 - 35 = 33 -> short 3.6; Sep II 21.8, no shortfall |
| L11 | **FIXED** | flood.stageAt = weir tail - ref, identical to the weir's tail at every flow checked |
| L12 | **FIXED** | design wave daily 617, 1,718, **2,200**, 1,868, 1,284, 810, 518: volume 645 Mm3 = 150 mm over 4,305 km2, about 7 days. Plausible for the design storm, on the high side of the ERA5 3-day basin maxima (52-139 mm), so the rain behind it is rarer than the record shows |
| L13 | **FIXED** | 30 m dam: curve base 128.4 = dam foot (was 136.6); volume strictly rising; routing still clean (0 negatives, spill only over the crest, evaporation 3.2 mm/day) |
| L14 | **FIXED** | maker levels shown as "m (model terrain)" / "m (medan model)" |
| L15 | **FIXED** | the runner's reliability now comes from `irrigation.balance` |
| L16 | **FIXED** | monthly ETo from rain.json in the tab's pattern |

### The two things the fixes might have broken

(a) **Canal shortage in dry years** (canal held to 81, river keeps 35 first, demand from the tab's pattern):
2019 model replay: short on **32 days** (all over 5 %), 57 Mm3 in all, in Nov (30) and Dec (2); 1997: short on
**91 days** (85 over 5 %), 136 Mm3, in Aug 13, Sep 30, Oct 11, Nov 30, Dec 7. This reads right for a dry year.
It is shown live (irrigation tab: delivered, shortfall, "time fully supplied since the start"; the `intake_short`
alert on the status card and the operation tab), but **no screen counts the short days or the short volume for the
year**; a water engineer asks for exactly that number. Smallest fix: s01 keeps `irrigation.short_days` and
`irrigation.short_mm3` since the reset; b17 shows them in the tab.

(b) **3-hour steps through the design wave** (2,200 m3/s, demand 60): the pond rises 79.70 -> 80.63 and falls back
with **one** change of direction (at the peak), largest 3-hour step 0.134 m, no oscillation, no overshoot; the tail
follows the flow (peak 79.90). The reason is that each step is a steady state (`weir.pond_area_m2` is still not in
params, so the pond has no storage); harmless for a pond that holds hours of flow.

### New items

| # | Sev | Where | What | Fix | Owner |
|---|---|---|---|---|---|
| N1 | L | `weir.js` autoGates, stage after all-gates | leaves leap 2.27 -> 4.50 m between 1,360 and 1,370 m3/s with no flow change | in the stage after all-gates, keep the gates at the lift where capacity stops rising (or raise them stepwise) | b14 |
| N2 | M | `params.json` rainflow refit | monthly means Sep -30 %, Oct -19 %, Mar +18 %; Nov Q80 -40 % | refit with the monthly means and the Q80 table weighted together | b13 |
| N3 | M | `weir-run.js:282` | the canal demand depends on the irrigation tab having filled `irrigation.pattern`; without it the demand is null and auto mode takes 81 all year | runner builds the pattern itself with `irrigation.rainInputs` when the store has none | s01 |
| N4 | M | `weir-run.js` irrigation patch | no yearly count of short days or short volume (see (a)) | add `short_days` and `short_mm3` | s01, b17 |
| N5 | L | flood reference | ground floods only from about 1,550 m3/s; 1980's 1,438 floods nothing | say on the map "beyond the river as the terrain survey saw it" | b15, lead |

### What I would show a water engineer now

Yes: the weir across the whole range (levels, gate order, intake held to 81, maintenance flow kept, design flood
0.4 m under the design high water), the mass balance, irrigation demand by half-month and the September palawija
balance, dry-season dependable flows, the maker dam. Not yet: the monthly mean flow shape (N2), replay years without
the flood-peak sentence (M6), and flood maps and building counts until the map says what the reference level is
(N5); yearly shortage figures are missing (N4).
