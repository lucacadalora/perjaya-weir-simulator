# P2 engines spec (draft, lane r13, 23 Nov 2026)

> Public copy of `plan/P2-engines-spec-draft.md`, the file code comments cite. Its test targets are now
> `test/targets.json`, recomputed by `tools/targets/calc_examples.py` and `tools/targets/make_targets.py`. Lanes `r01`
> to `r11` named below were research packages whose notes are not published; see `docs/CONTRACT.md` for lane ids.

Simulator of Bendung Perjaya and the Komering basin. Six engines, each a pure calculation core with node tests
against `plan/P2-targets-draft.json` (now `test/targets.json`; 39 targets, all recomputed by
`tools/targets/calc_examples.py`).
Methods are the ones an Indonesian irrigation engineer meets in the KP series (Kriteria Perencanaan, Ditjen SDA 2013)
and SNI 2415:2016, so the numbers can be checked by hand against those books.

Status letters: [S] sourced, [C] computed, [R] read from a figure, [A] assumed, [P] press only.
Basin-specific values (catchment area, rainfall, flows, crest level, gate sizes, command area) are owned by lanes
r01 to r11; where this spec needs one it says "from rNN" and uses a placeholder marked [A].

Units everywhere: m, m3/s, mm, mm/day, l/s/ha, days. Time in UTC.

---

## E1 Rain to flow

**Question.** How much water does the Komering bring to the weir in a month, a half-month and a day, for a given rain
year, and how often is a given flow reached?

**Methods (selectable, one default).**
1. **F.J. Mock, monthly or half-monthly** (default for month view). KP-01 2013 Tabel 4-4 names "Dr. Mock" and NRECA as
   the methods when flow records are short.
   - limited ET: dE = Ep x (m/20) x (18 - n); Et = Ep - dE (m exposed surface fraction, n rain days)
   - water balance: ds = P - Et; soil store SM up to SMC; water surplus WS = ds - (change in SM), WS >= 0
   - infiltration I = i x WS; groundwater Vn = k x Vn-1 + 0.5(1 + k) x I; baseflow BF = I - (Vn - Vn-1)
   - direct runoff DRO = WS - I; storm runoff SRO = PF x P in months with ds < 0 (PF default 0)
   - runoff RO = BF + DRO + SRO (mm); Q = RO/1000 x A / (days x 86400)
2. **NRECA monthly** (alternative). Nominal = 100 + 0.2 Ra; Wi = W/Nominal; AET/PET = (P/PET)(1 - 0.5 Wi) + 0.5 Wi
   when P/PET < 1 and Wi < 2, else 1; excess-moisture ratio 0.5(1 + tanh((Wi - 1)/0.52)) [A: matches the
   NRECA chart shape, to be checked against the original curve]; recharge = PSUB x EM; GW flow = GWF x (GW + recharge);
   direct = EM - recharge.
3. **Runoff coefficient** (the "share of rain that reaches the river" slider, simplest view): Q = C x P x A / t.
4. **Daily bucket for flood peaks**: soil store capacity Smax; overflow enters a linear reservoir of time constant K;
   daily outflow = store x (1 - e^(-1/K)); plus baseflow from Mock groundwater. Rational check for small side
   catchments: Qp = 0.278 C I A (I mm/h, A km2).

**Controls.**

| Control | Base | Range | Step | Source | Status |
|---|---|---|---|---|---|
| Catchment area above weir | from r03 (lead 4,320 km2 at Martapura, JICA) | fixed per map | - | r03 / E4 D8 | [A] until r03 settles |
| Yearly rain scale | 100 % of the 10-year mean | 50-150 % | 5 % | r03 rain series | [A] |
| Runoff coefficient C (method 3) | 0.50 | 0.20-0.80 | 0.05 | KP-01 Lampiran I Tabel A.1.1 gives 0.60-0.80 for flood peaks; monthly C is lower | [A] |
| Mock exposed surface m | 0.30 | 0.0-0.5 | 0.05 | Mock practice (0 forest, 0.1-0.4 farmland, 0.3-0.5 bare) | [A] |
| Mock SMC | 200 mm | 50-250 | 10 | ITB IGSC 2022 (50-200 mm) | [S] range |
| Mock infiltration i | 0.40 | 0.1-0.8 | 0.05 | Bakhtiar 2008 used 0.40; range 0-1 per ITB 2022 | [S] example |
| Mock recession k | 0.60 | 0.3-0.95 | 0.05 | calibrated by trial in every study | [A] |
| NRECA PSUB / GWF | 0.5 / 0.5 | 0.3-0.9 / 0.2-0.8 | 0.05 | thesis reviews: permeable 0.9/0.2, tight 0.3/0.8 | [S] range |
| Bucket Smax, K | 150 mm, 2 days | 50-300 mm, 0.5-10 days | 10 mm, 0.5 d | none for Komering | [A] |
| ETo | monthly series, base 4.0 mm/day | 3.0-5.5 | 0.1 | JICA 1982 pan 4.2-5.0 mm/day at Belitang x pan coef | [C] |

**Outputs.** Inflow series (m3/s) by day, half-month, month; flow-duration curve; Q80 per half-month (Weibull P = m/(n+1),
or normal mean + z(0.2) sd as KP-01 Tabel 4-4 row 1a); mean, wettest and driest years.

**Honesty note.** Mock and NRECA are lumped water-balance models with 4 to 6 parameters that are calibrated, not
measured; without calibration against the Martapura or Perjaya gauge they are a plausible shape, not a forecast.
Lake Ranau storage and its outlet regulation are not in either model; they flatten the Komering's dry season and must
be added as a separate store once r03 gives its outflow. The daily bucket gives peak timing to within a day or two at
best; it is not a flood forecast.

---

## E2 Storage and routing

**Question.** How does the pond behind the weir (and, as a what-if, a storage dam somewhere in the basin) fill and
empty: level, volume, percent full, inflow, outflow?

**Method.**
- Storage curve from the terrain grid: V(h) = sum over cells of cell_area x max(0, h - z); A(h) = cell_area x count(z < h),
  restricted to cells connected to the seed behind the dam line (E4 fill). Tabulate every 0.1 m.
- Level-pool (modified Puls) routing: (I1 + I2)/2 - (O1 + O2)/2 = (S2 - S1)/dt, solved per step by Newton on h2 with
  O(h) from E3 (crest plus gates plus intake). Fallback for display speed: explicit step with dt small enough that
  dt < 0.2 x A(h) / (dO/dh).
- Open-water evaporation from the pond: E = Kpan x Epan x A(h); defaults below. Seepage ignored by default.

**Controls.**

| Control | Base | Range | Step | Source | Status |
|---|---|---|---|---|---|
| Time step | 1 hour (flood), 1 day (year view) | 10 min - 1 day | - | - | [A] |
| Time speed | 1 h/s | 1 h/s to 1 yr/s | x2 | brief | - |
| Pan evaporation | 4.6 mm/day (monthly 4.2 Jun to 5.0 Mar) | 3.5-6.0 | 0.1 | JICA 1982 Upper Komering Pre-FS Annex I sec 1.8, Belitang | [S] |
| Pan to open-water coefficient | 0.70 | 0.6-0.85 | 0.05 | standard Class A lake coefficient; KP-01 A.2.4 uses Kp 0.65-0.85 for ETo | [A] |
| Constant release (what-if dam) | 0 | 0-1,000 m3/s | 5 | brief | [A] |

**Outputs.** h(t), V(t), percent of the volume at normal pond level, A(t), I(t), O(t), evaporation loss, fill chart.

**Honesty note.** Bendung Perjaya is a weir: its pond holds hours of flow, not months, so "percent full" means pond
level between river bed and normal pond level, not a seasonal store; say so on screen. The storage curve comes from
a 30 m surface model that sees the water surface on the day it was flown, not the river bed, and tree tops as ground:
volumes below the surveyed water line are unknown and the curve is "not a survey".

---

## E3 Gates and intake

**Question.** For a given pond level, tailwater and gate openings, how much passes the weir crest, the gates and the
intake into the saluran induk?

**Method (KP-02 2013).**
- Fixed crest: Q = Cd x (2/3) x sqrt((2/3) g) x Be x H1^1.5 (eq 4-2), Cd = C0 C1 C2, C0 up to 1.49 for H1/r > 5.
  Effective width Be = B - 2(n Kp + Ka) H1 (eq 4-1, Tabel 4-1: Kp 0.02 square-rounded, 0.01 round piers;
  Ka 0.20 square abutment, 0.10 round). Submergence: multiply by f(H2/H1) from KP-02 Gambar 4-8 (to be digitised).
- Gate, underflow: Q = K x mu x a x b x sqrt(2 g h1) (eq 4-42); mu from Gambar 4-40 (about 0.55-0.75 over h1/a 1-13
  [R]); K submergence factor from Gambar 4-48 (Schmidt) with K = 1 for free flow. Option: energy form with Cc = 0.61,
  Q = b Cc a sqrt(2 g (h1 - Cc a) / (1 - (Cc a/h1)^2)). Free/submerged switch when tailwater exceeds the conjugate of
  Cc a.
- Gate overtopped or fully raised: switch to crest equation over the gate sill.
- Intake (pengambilan): Q = mu x b x a x sqrt(2 g z) (eq 5-3), mu = 0.80, z = head loss across the opening (typical
  design 0.10-0.30 m, KP-02 Gambar 5-1); radial intake gate mu = 0.80 when its lip is 0.20 m under the pond.
- River rating below the weir (tailwater) by Manning: Q = (1/n) A R^(2/3) S^(1/2) for a cross-section from r11 or
  from the surface model.

**Controls.**

| Control | Base | Range | Step | Source | Status |
|---|---|---|---|---|---|
| Gate opening each bay | from r05 operation | 0 to full lift | 0.05 m | r05 / r08 | [A] |
| Operation mode | "keep normal pond level" | free overflow / hold level / flush (all gates open) / manual | - | r05 | [A] |
| Crest Cd | 1.30 | 1.1-1.49 | 0.01 | KP-02 4.2 (round crest) | [S] range |
| Gate mu | 0.60 | 0.5-0.8 | 0.01 | KP-02 Gambar 4-40 | [R] +/- 0.05 |
| Intake mu | 0.80 | 0.7-0.85 | 0.01 | KP-02 eq 5-3 | [S] |
| Manning n of the Komering | 0.035 | 0.025-0.06 | 0.005 | Chow's table for clean winding natural channels 0.033-0.045 | [A] |
| Bed slope | from r11 | 0.0001-0.001 | - | r11 / surface model | [A] |

**Outputs.** Q over crest, Q per gate, Q to intake, pond level for a target intake flow, rating curve h(Q) at the
weir and at AWLR Peracak's reach.

**Honesty note.** Gate count, sizes, sill and crest levels come from r01/r08; until they are settled every number from
E3 is an example. The KP-02 figures (Gambar 4-8, 4-40, 4-48) exist only as graphs; our digitised curves carry a reading
error. A single Manning section cannot reproduce backwater from the weir or from the Ogan confluence.

---

## E4 Flood extent

**Question.** Which land is under water for a given pond level (behind the weir or an imaginary dam) or a given river
flow, and what is the design flood?

**Method.**
- Catchment: D8 steepest descent on the conditioned (pit-filled, river-burned) 30 m grid; diagonal drop divided by
  sqrt 2; accumulation = upstream cell count x cell area. Check against r03's published area; the difference is a
  reported number, not hidden.
- Reservoir fill behind a dam line: rasterise the dam line as a wall at crest level, 4-connected flood fill from a seed
  in the river cell, all cells with z < level. Volume/area feed E2.
- River floods: HAND = z - z(drainage cell reached by following D8), drainage cells = accumulation above a threshold
  (base 5 km2). Flooded where HAND <= stage above the bed, with stage from the E3 Manning rating for the flow.
- Design flood (SNI 2415:2016 practice, KP-01 Tabel 4-3): annual maxima -> Gumbel (YT = -ln(-ln(1 - 1/T)),
  K = (YT - Yn)/Sn with Yn, Sn for record length n) and Log-Pearson III on log10 Q with KT from skew Cs
  (table or Wilson-Hilferty). Pick by the usual parameter checks (Gumbel: Cs about 1.14, Ck about 5.4; LP3: any
  other Cs) and Chi-square / Smirnov-Kolmogorov tests. Return periods 2, 5, 10, 25, 50, 100 years.

**Controls.**

| Control | Base | Range | Step | Source | Status |
|---|---|---|---|---|---|
| Water level / stage | normal pond level from r01 | bed to crest + 6 m | 0.1 m | r01 | [A] |
| Drainage threshold | 5 km2 | 1-50 km2 | - | HAND practice | [A] |
| Return period | 25 years | 2-100 | list | KP-01 Tabel 4-3 | [S] list |
| Distribution | Log-Pearson III | Gumbel / LP3 | - | SNI 2415:2016 | [S] |
| Terrain | Copernicus GLO-30 | GLO-30 only | - | lane g0x | [S] |

**Outputs.** Flooded mask, area (ha), depth grid, catchment polygon, design flood table.

**Honesty note.** Copernicus GLO-30 is a surface model with a stated absolute vertical accuracy of < 4 m (LE90); over
forest and plantations it reads the canopy, often several metres above ground (FABDEM work cut forest mean error from
5.15 m to 2.88 m). The Komering channel is near the grid size, so its bed is not in the model and HAND is measured
from the water surface on the flight day. HAND has no momentum, backwater, levees or culverts: it overstates flooding
behind embankments that hold and understates it where water backs up from the Ogan or the Musi. Typical published
HAND checks match a hydraulic model on most cells but underestimate extents. Show "not a survey" on every flood map.

---

## E5 Impact count

**Question.** What lies in the flooded area: buildings, roads, rail, sawah, villages?

**Method.** Point-in-mask for building footprints (centroid) from Overture/OSM; length of road and rail segments inside
the mask; area of WorldCover cropland and of sawah from r02 inside the mask; names of desa whose boundary meets the mask.

**Controls.** Source layer switches; minimum depth to count (base 0.3 m, range 0-2 m, step 0.1, [A]).

**Outputs.** Counts and lengths with the data date of each layer; a list of the ten largest settlements touched.

**Honesty note.** Open building footprints miss many rural houses in Sumatra and carry no floor level; counts are a
lower bound on structures and say nothing about people, damage or loss. A 30 m mask can be wrong by a whole row of
houses along a river bank.

---

## E6 Irrigation demand

**Question.** How much water must the intake take for the Komering command area, half-month by half-month, and does the
dependable flow (Q80 from E1) cover it?

**Method (KP-01 2013 Lampiran II).**
- Land preparation (Van de Goor and Zijlstra 1968): IR = M e^k / (e^k - 1), M = Eo + P, Eo = 1.1 ETo, k = M T / S;
  T = 30 days (machines) or 45 days; S = 250 mm (200 puddling + 50 layer) or 300 mm after a long fallow.
- Growth: NFR = ETc + P + WLR - Re, ETc = Kc x ETo; Kc per half-month (FAO improved variety 1.10, 1.10, 1.05, 1.05,
  0.95, 0; Nedeco/Prosida 1.20, 1.27, 1.33, 1.30, 1.30, 0) KP-01 Tabel A.2.2; WLR 50 mm twice (3.3 mm/day over a
  half-month) at one and two months after transplanting; Re = 0.7 x R5/15 with R5 the half-month rain of 5-year
  return dry value (KP-01 eq A.2.5; elsewhere KP-01 says the 80 % value); P = 1-3 mm/day on puddled clay, at least
  5 mm/day on slopes above 5 %.
- Intake demand DR (l/s/ha) = NFR / (8.64 x e), e = 0.65 overall (KP-01 examples; tertiary 0.80 x secondary 0.90 x
  primary 0.90 = 0.648). Q_intake = DR x area.
- Golongan (technical rotation): split the area into 3-5 groups whose planting starts 15 days apart; demand = sum of
  groups. KP-01 recommends this for systems of about 10,000 ha or more.
- Balance: compare Q_intake with Q80 x 0.9 (KP-01 4.2: allow about 10 % for flow variation within the half-month, and
  a correction 80-90 % for catchment degradation).

**Controls.**

| Control | Base | Range | Step | Source | Status |
|---|---|---|---|---|---|
| Command area | from r02 | 0 to full design area | 1,000 ha | r02 | [A] |
| Planting start (group 1) | from r02 cropping calendar | any half-month | 1 half-month | r02 | [A] |
| Number of groups | 3 | 1-5 | 1 | KP-01 A.2.3.3 | [S] |
| Land preparation T | 30 days | 30 / 45 | - | KP-01 | [S] |
| Land preparation S | 250 mm | 250 / 300 | - | KP-01 | [S] |
| Percolation P | 2 mm/day | 1-5 | 0.5 | KP-01 | [S] range |
| Kc table | FAO improved variety | FAO / Nedeco-Prosida | - | KP-01 Tabel A.2.2 | [S] |
| Overall efficiency e | 0.65 | 0.45-0.80 | 0.01 | KP-01 examples | [S] |
| ETo | 4.0 mm/day | 3.0-5.5 | 0.1 | JICA 1982 pan 4.6 x Kp about 0.85 | [C] |

**Outputs.** NFR and DR by half-month, peak DR (typically 1.2-1.5 l/s/ha during land preparation with 3-4 groups,
KP-01 Gambar A.2.2 [R]), intake flow, shortfall half-months, area that can be served at Q80.

**Honesty note.** KP-01 gives design demand, not what farmers take: real offtakes depend on gate operation, canal
losses and planting dates that drift each season. Without measured intake flows from the weir operator, E6 shows
what the design rules would ask for, not what the canal carries.

---

## Engine links

E1 inflow -> E2 routing <- E3 outflow(h); E2 level -> E4 extent -> E5 counts; E1 Q80 + E6 demand -> balance chart;
E4 D8 area -> E1 area check.

## Sources

KP-01 2013 and KP-02 2013 (Ditjen SDA, Kementerian PU), read from luk.tsipil.ugm.ac.id/atur/sda/kp/; JICA 1982
Pre-FS Upper Komering River Basin Development Project, Annex I, openjicareport.jica.go.jp/pdf/10310845_01.pdf;
Rasyid and Afdhaliah, ITB IGSC 2022 (F.J. Mock steps); NRECA reviews (core.ac.uk 492937158 and others); Copernicus DEM
product handbook; HESS 28, 1287 (2024) on HAND. Full list in the r13 research note (not published).
