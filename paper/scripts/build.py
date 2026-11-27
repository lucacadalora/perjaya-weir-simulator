#!/usr/bin/env python3
"""Turns paper/results/results.json (written by run.mjs) into everything the LaTeX source includes:
  paper/numbers.tex        one macro per number quoted in the text
  paper/tab_*.tex          table bodies
  paper/figures/fig_*.pdf  the plots
No number in main.tex is typed by hand; change the model or its data files, run `make`, and the paper follows.
  python3 paper/scripts/build.py [--no-tests]
"""
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.colors import LinearSegmentedColormap, LightSource

PAPER = Path(__file__).resolve().parents[1]
REPO = PAPER.parent
RES = PAPER / "results"
FIG = PAPER / "figures"
FIG.mkdir(exist_ok=True)
R = json.loads((RES / "results.json").read_text())
PARAMS = json.loads((REPO / "site/data/params.json").read_text())

# ------------------------------------------------------------------------------------------------- helpers
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
MAC = {}


def num(x, d=0):
    """1234.5 -> '1,234.5' (text mode)."""
    if x is None:
        return "--"
    s = f"{abs(x):,.{d}f}"
    return ("$-$" + s) if x < 0 and float(s.replace(",", "")) != 0 else s


def signed(x, d=0):
    s = f"{abs(x):,.{d}f}"
    if float(s.replace(",", "")) == 0:
        return s
    return ("$+$" if x > 0 else "$-$") + s


def M(name, value):
    assert re.fullmatch(r"[A-Za-z]+", name), name
    assert name not in MAC, name
    MAC[name] = str(value)


def write(name, text):
    (PAPER / name).write_text(text)
    print("wrote", name)


# ------------------------------------------------------------------------------------------------- numbers
rf, rp, w, fl, ir, sd, mk, dat = R["rainflow"], R["rainflow"]["replay"], R["weir"], R["flood"], R["irrigation"], R["sediment"], R["maker"], R["data"]

M("CatchArea", num(rf["area_km2"]))
M("CatchGrid", num(mk["weir_catchment_km2"], 0))
M("CatchGridErrPct", signed(100 * (mk["weir_catchment_km2"] / mk["weir_catchment_published_km2"] - 1), 1))
M("RainAnnual", num(rf["rain_annual_mean_mm"]))
M("RunoffShare", num(rp["runoff_share"], 2))
M("RepYearFirst", rf["years"][0])
M("RepYearLast", rf["years"][1])
M("RepNYears", rf["n_years"])
M("QmeanPub", num(rp["q_mean_published"], 1))
M("QmeanRep", num(rp["q_mean"], 1))
M("QmeanErrPct", signed(100 * (rp["q_mean"] / rp["q_mean_published"] - 1), 1))
M("QmeanAbsErrPct", num(abs(100 * (rp["q_mean"] / rp["q_mean_published"] - 1)), 0))
M("RmsMeanPct", num(100 * rp["rms_rel_mean"], 0))
k = int(np.argmax(np.abs(rp["rel_err_mean"])))
M("MaxMeanErrPct", signed(100 * rp["rel_err_mean"][k], 0))
M("MaxMeanErrMonth", MONTHS[k])
M("RmsQeightyPct", num(100 * rp["rms_rel_q80"], 0))
dq = [100 * v for v in rp["dry_season_q80_rel"]]
M("DryQeightyLoPct", signed(min(dq), 0))
M("DryQeightyHiPct", signed(max(dq), 0))
M("DryQeightyAbsPct", num(max(abs(v) for v in dq), 0))
k = int(np.argmax(np.abs(rp["rel_err_q80"])))
M("MaxQeightyErrPct", signed(100 * rp["rel_err_q80"][k], 0))
M("MaxQeightyErrMonth", MONTHS[k])
M("AnnMaxLo", num(rp["annual_max_range"][0]))
M("AnnMaxHi", num(rp["annual_max_range"][1]))
M("PubQtwo", num(rp["published_q2"]))
M("PubQhundred", num(rp["published_q100"]))
M("PubLargest", num(rp["published_largest"]))
M("GlofasCorr", num(rf["glofas"]["corr_monthly"], 2))
M("GlofasMean", num(rf["glofas"]["mean"], 0))
M("GlofasYearFirst", rf["glofas"]["years"][0])
M("ClimQmean", num(rf["climatology"]["q_mean"], 0))
b = rf["bucket"]
M("BucketSmax", num(b["smax_mm"]))
M("BucketKfast", num(b["k_fast_days"], 1))
M("BucketKslow", num(b["k_slow_days"]))
M("BucketGwShare", num(b["gw_share"], 2))
M("BucketEtFactor", num(b["et_factor"], 2))
M("BucketFc", num(b["fc"], 2))
M("BucketSlowExp", num(b["slow_exp"], 2))
M("DesignTp", num(b["design_tp_days"]))
M("DesignShape", num(b["design_shape"]))
dry = {d["year"]: d for d in rf["dry_years"]}
M("DriestYear", min(dry, key=lambda y: dry[y]["rain_mm"]))
M("DriestRain", num(dry[min(dry, key=lambda y: dry[y]["rain_mm"])]["rain_mm"]))

M("PondNormal", f'{w["levels"]["pond_target_el"]:.2f}')
M("DHW", f'{w["levels"]["design_high_water_el"]:.2f}')
M("DesignQ", num(rf["design"]["weir_design_q"]))
e = w["max_balance_err"]
ex = math.floor(math.log10(e))
M("BalanceErr", f"${e / 10 ** ex:.0f}\\times10^{{{ex}}}$")
M("PondHeldTo", num(w["pond_held_to_q"]))
M("PondOverFrom", num(w["pond_over_dhw_from_q"]))
row = {r["q_in"]: r for r in w["table"]}
M("DesignPondAuto", f'{row[2200]["pond_el"]:.2f}')
M("DesignTailAuto", f'{row[2200]["tail_el"]:.2f}')
M("DesignFreeboard", f'{w["levels"]["design_high_water_el"] - row[2200]["pond_el"]:.2f}')
M("QhundredPondAuto", f'{row[1939]["pond_el"]:.2f}')
fm = {r["q_in"]: r for r in w["flood_mode"]}
M("DesignPondOpen", f'{fm[2200]["pond_el"]:.2f}')
M("DesignTailOpen", f'{fm[2200]["tail_el"]:.2f}')
M("WavePondPeak", f'{w["design_wave"]["pond_peak"]:.2f}')
M("WaveVolume", num(w["design_wave"]["wave_volume_mm3"]))
M("WaveDepth", num(w["design_wave"]["wave_depth_mm"]))
M("MaxPondJump", f'{w["max_pond_jump_m"]:.2f}')
M("SolveMs", num(w["solve_ms"], 1))
M("IntakeTarget", num(w["intake"]["target_m3s"]))
M("IntakeDesign", f'{w["intake"]["capacity_m3s"]:.2f}')
M("IntakeMax", num(w["intake"]["capacity_max_m3s"]))
M("EnvFlow", num(w["ops"]["q_env_m3s"]))
M("TailBed", f'{w["tail"]["bed_el"]:.2f}')
M("TailWidth", num(w["tail"]["width_m"]))
M("TailN", f'{w["tail"]["n"]:.3f}')
M("TailSlope", f'{w["tail"]["slope"]:.5f}')
M("FirstOpening", f'{w["ops"]["first_opening_m"]:.2f}')

M("RefTail", f'{fl["ref_tail_el"]:.1f}')
M("RefFlow", num(fl["ref_flow_m3s"]))
M("FirstWetQ", num(fl["first_wet_q"]))
M("MinDepth", f'{fl["min_depth_m"]:.1f}')
ft = {r["q_in"]: r for r in fl["table"]}
M("FloodAreaDesign", f'{ft[2200]["area_km2"]:.1f}')
M("FloodAreaUpDesign", f'{ft[2200]["area_up_km2"]:.1f}')
M("FloodAreaDownDesign", f'{ft[2200]["area_down_km2"]:.1f}')
M("FloodBldDesign", num(ft[2200]["buildings"]))
M("FloodRoadDesign", f'{ft[2200]["roads_km"]:.1f}')
M("FloodCropDesign", num(ft[2200]["lc_ha"].get("Cropland", 0)))
M("FloodRiseBelowDesign", f'{ft[2200]["rise_below_m"]:.2f}')
M("FloodRiseAboveDesign", f'{ft[2200]["rise_above_m"]:.2f}')
M("FloodAreaQhundred", f'{ft[1939]["area_km2"]:.1f}')
M("FloodBldQhundred", num(ft[1939]["buildings"]))
sens = fl["sensitivity"]
M("SensAreaLo", f'{min(s["area_km2"] for s in sens):.1f}')
M("SensAreaHi", f'{max(s["area_km2"] for s in sens):.1f}')
M("SensBldLo", num(min(s["buildings"] for s in sens)))
M("SensBldHi", num(max(s["buildings"] for s in sens)))
M("ExtentMs", num(fl["extent_ms"]))
g = R["grid"]
M("WideCols", num(g["wide"]["cols"]))
M("WideCellM", g["wide"]["cell_m"])
M("FineCols", num(g["fine"]["cols"]))
M("FineRows", num(g["fine"]["rows"]))
M("FineCellM", g["fine"]["cell_m"])

M("IrrArea", num(ir["area_ha"]))
M("IrrEff", f'{ir["efficiency"]:.2f}')
M("PeakDR", f'{ir["peak_dr_lsha"]:.2f}')
M("PeakHM", ir["peak_halfmonth"])
M("PeakDemand", f'{ir["peak_demand_m3s"]:.1f}')
M("PeakDRPub", f'{ir["peak_dr_published"]:.1f}')
M("PeakDemandPub", f'{ir["peak_demand_published"]:.1f}')
M("PeakDRErrPct", num(abs(100 * (ir["peak_dr_lsha"] / ir["peak_dr_published"] - 1)), 0))
yrs = ir["years"]
worst = max((k for k in yrs if k != "mean"), key=lambda k: yrs[k]["short_days"])
M("WorstYear", yrs[worst]["year"])
M("LeastDryShortDays", num(min(yrs[k]["short_days"] for k in yrs if k != "mean")))
M("NDryYears", len(yrs) - 1)
M("WorstShortDays", num(yrs[worst]["short_days"]))
M("WorstShortVol", num(yrs[worst]["short_volume_mm3"]))
M("WorstShortPct", num(100 * yrs[worst]["short_volume_mm3"] / yrs[worst]["demand_mm3"], 0))
M("MeanYearShortDays", num(yrs["mean"]["short_days"]))
M("YearDemandVol", num(yrs["mean"]["demand_mm3"]))
M("EnvBreachDays", num(sum(yrs[k]["days_below_env_with_water"] for k in yrs)))

M("SedYieldMt", f'{sd["yield_t_yr"] / 1e6:.2f}')
M("SedUnscaledMt", f'{sd["unscaled_t_yr"] / 1e6:.1f}')
M("SedScale", f'{sd["scale"]:.2f}')
M("SedRatingA", f'{sd["rating_a"]}')
M("SedRatingB", f'{sd["rating_b"]:.2f}')
last = sd["years"][-1]
M("SedIntakeKt", num(last["intake_t"] / 1e3))
M("SedTrapKt", num(last["trapped_t"] / 1e3))
M("SedTrapPct", num(100 * sd["trapped_share_of_intake"], 0))
M("SedIntakePct", num(100 * sd["intake_share_of_river"], 1))
M("SedFlushes", num(sd["flushes_per_year"]))
M("SedInterval", num(sd["days_between_flushes_per_basin"]))
M("SedStorage", num(sd["storage_m3"]))
M("SedCmean", num(sd["c_at_mean_mgL"]))
M("SedBasins", sd["basins"])
M("SedFlushHours", num(sd["flush_hours"]))
M("SedFlushAtPct", num(100 * sd["flush_at"]))

td = next(d for d in mk["dams"] if d["id"] == "tiga-dihaji")
sl = next(d for d in mk["dams"] if d["id"] == "try-selabung")
M("TDCatch", num(td["catchment_km2"], 0))
M("TDCatchPub", num(td["catchment_published_km2"], 0))
M("TDCatchErrPct", signed(100 * (td["catchment_km2"] / td["catchment_published_km2"] - 1), 2))
M("TDCrest", num(td["crest_el"]))
M("TDHeight", num(td["height_m"]))
M("TDHeightPub", num(td["height_published_m"]))
M("TDLen", num(td["crest_len_m"]))
M("TDLenPub", num(td["crest_len_published_m"]))
M("TDVol", num(td["fsl_volume_mm3"]))
M("TDVolPub", num(td["storage_published_mm3"]))
M("TDVolPct", num(100 * td["fsl_volume_mm3"] / td["storage_published_mm3"]))
M("TDArea", f'{td["fsl_area_km2"]:.1f}')
M("TDFillDays", num(td["days_to_fill"]))
M("TDInflow", num(td["inflow_mean_m3s"]))
M("SelVol", num(sl["fsl_volume_mm3"]))
M("SelArea", f'{sl["fsl_area_km2"]:.1f}')
M("SelLen", num(sl["crest_len_m"]))
M("SelCatch", num(sl["catchment_km2"]))
M("SelHeight", num(sl["height_m"]))
M("SelFillDays", num(sl["days_to_fill"]))
M("CatchMs", num(max(td["catchment_ms"], sl["catchment_ms"])))
M("CurveMs", num(max(td["curve_ms"], sl["curve_ms"])))

ps = dat["params_by_status"]
M("NParams", dat["params_total"])
for s in "SCRA":
    M("NParams" + s, ps.get(s, 0))
M("NParamsAPct", num(100 * ps.get("A", 0) / dat["params_total"]))
M("NFacts", dat["facts_total"])
M("NFactsS", dat["facts_by_status"].get("S", 0))
M("NSources", dat["sources"])
M("DatumOffset", f'{abs(dat["datum_offset_m"]):.1f}')
M("ResultsDate", R["meta"]["made"])


# counts read from the data files' own headers
BLD = json.loads((REPO / "site/data/feat/buildings.json").read_text())
M("NBuildings", num(BLD["count"]))
RAINJ = json.loads((REPO / "site/data/climate/rain.json").read_text())
pts = RAINJ["meta"]["points"]
pts = json.loads(pts) if isinstance(pts, str) else pts
M("NRainPoints", len(pts))
FLOWJ = json.loads((REPO / "site/data/climate/flow_glofas.json").read_text())
M("GlofasYearLast", rf["glofas"]["years"][1])

# ------------------------------------------------------------------------------------------------- code and tests
JS = REPO / "site/js"


def loc(paths, tests=False):
    n = f = 0
    for root in paths:
        for p in Path(root).rglob("*.js"):
            if "vendor" in p.parts or "i18n" in p.parts:
                continue
            if p.name.endswith(".test.js") != tests:
                continue
            n += sum(1 for _ in p.open(encoding="utf8"))
            f += 1
    return n, f


CMD = "node --test --test-concurrency=4 "
GLOBS = {"engine": "'site/js/engine/*.test.js'", "sim": "'site/js/sim/*.test.js'", "map": "'site/js/map/**/*.test.js'", "targets": "'test/**/*.test.js'"}
if "--no-tests" in sys.argv and (RES / "tests.json").exists():
    T = json.loads((RES / "tests.json").read_text())
else:
    T = {}
    for key, glob in {**GLOBS, "all": " ".join(GLOBS.values())}.items():
        out = subprocess.run(CMD + glob, shell=True, cwd=REPO, capture_output=True, text=True).stdout
        T[key] = {k: int(re.search(rf"^. {k} (\d+)", out, re.M).group(1)) for k in ["tests", "pass", "fail", "skipped"]}
    (RES / "tests.json").write_text(json.dumps(T) + "\n")

groups = [("Calculation engines", "engine", "pure functions"), ("Simulation runners", "sim", "clock, scenarios, per-step chain"),
          ("Map and 3D scene", "map", "layers, structures, water, ground"), ("Panels and charts", "ui", "eight tabs, drawings")]
rows = []
tot = tot_f = 0
for label, d, what in groups:
    n, f = loc([JS / d])
    tot += n
    tot_f += f
    nt = T[d]["tests"] if d in T else None
    rows.append(f"{label}: {what} & {f} & {num(n)} & {nt if nt else '--'} \\\\")
tn, tf = loc([JS, REPO / "test"], tests=True)
rows.append(f"Targets recomputed from the published methods & 1 & -- & {T['targets']['tests']} \\\\")
rows.append("\\midrule")
rows.append(f"Test code, all parts & {tf} & {num(tn)} & {T['all']['tests']} \\\\")
write("tab_code.tex", "\n".join(rows) + "\n")
M("LocCode", num(tot))
M("LocEngine", num(loc([JS / "engine"])[0]))
M("NModules", tot_f)
M("NTestFiles", tf)
M("NTargets", T["targets"]["tests"])
T = T["all"]
M("NTests", T["tests"])
M("NPass", T["pass"])
M("NFail", T["fail"])
M("NSkip", T["skipped"])

# ------------------------------------------------------------------------------------------------- tables
T_OF = dict(zip(rf["design"]["q"], rf["design"]["T"]))
STAGE = {"gates": "gates in turn", "all_gates": "all gates", "flood": "gates + sluices", "flood_full": "all at full lift", "closed": "closed"}


def lift(a):
    lo, hi = min(a), max(a)
    return f"{hi:.2f}" if hi - lo < 0.005 else f"{lo:.2f}--{hi:.2f}"


rows = []
for r in w["table"]:
    if r["q_in"] in (50, 1200, 2497):
        continue
    q = num(r["q_in"], 1 if r["q_in"] % 1 else 0)
    rows.append(f'{q} & {r["pond_el"]:.2f} & {r["tail_el"]:.2f} & {STAGE[r["stage"]]} & {lift(r["gates"])} & {lift(r["sluices"])} & {num(r["q_intake"])} & {num(r["q_down"])} \\\\')
write("tab_weir.tex", "\n".join(rows) + "\n")

rows = []
for r in fl["table"]:
    q = r["q_in"]
    if q in (800, 1250):
        continue
    t = "mean flow" if abs(q - 203.1) < 0.1 else ("design" if q == 2200 else (f"{T_OF[q]:,}-year" if q in T_OF else "--"))
    rows.append(f'{num(q, 1 if q % 1 else 0)} & {t} & {r["rise_below_m"]:.2f} & {r["rise_above_m"]:.2f} & {r["area_km2"]:.2f} & {num(r["buildings"])} & {r["roads_km"]:.2f} & {num(r["lc_ha"].get("Cropland", 0))} \\\\')
write("tab_flood.tex", "\n".join(rows) + "\n")

rows = []
order = ["mean"] + sorted((k for k in yrs if k != "mean"), key=lambda k: yrs[k]["year"])
for k in order:
    y = yrs[k]
    name = "Mean year" if k == "mean" else str(y["year"])
    rain = num(rf["rain_annual_mean_mm"]) if k == "mean" else num(dry[y["year"]]["rain_mm"])
    rows.append(f'{name} & {rain} & {num(y["q_mean"])} & {num(y["q_min"])} & {num(y["short_days"])} & {num(y["short_volume_mm3"])} & {num(100 * y["reliability"])} \\\\')
write("tab_dry.tex", "\n".join(rows) + "\n")

# parameter table (appendix): a fixed selection of keys; values, units and status letters read from params.json
SEL = [
    ("catchment.area_km2", "Catchment at the weir"), ("hydro.mean_flow_m3s", "Mean flow"), ("hydro.design_flood_m3s", "Weir design flood"),
    ("hydro.maintenance_flow_m3s", "Maintenance flow below weir"), ("rainflow.bucket_smax_mm", "Soil store $S_{\\max}$"),
    ("rainflow.bucket_k_days", "Fast store $K_f$"), ("rainflow.bucket_k_slow_days", "Slow store $K_s$"), ("rainflow.bucket_gw_share", "Share to slow store $\\gamma$"),
    ("rainflow.bucket_et_factor", "ET factor $c_e$"), ("rainflow.bucket_fc", "ET threshold $f_c$"), ("rainflow.bucket_slow_exp", "Slow-store exponent $\\beta$"),
    ("rainflow.design_tp_days", "Flood wave time to peak"), ("rainflow.design_shape", "Flood wave shape $a$"),
    ("weir.pond_normal_el", "Normal pond level"), ("weir.design_high_water_el", "Design high water"), ("weir.gate_width_m", "Flood gate width (7 bays)"),
    ("weir.gate_h_m", "Flood gate leaf height"), ("weir.gate_sill_el", "Flood gate sill level"), ("weir.sluice_width_m", "Sluice width (3 bays)"),
    ("weir.sill_sluice_el", "Sluice sill level"), ("weir.gate_lift_max_m", "Full lift"), ("weir.crest_cd", "Crest coefficient $C_d$"),
    ("weir.gate_mu", "Gate coefficient $\\mu$"), ("weir.intake_mu", "Intake coefficient $\\mu_i$"), ("weir.pier_kp", "Pier contraction $K_p$"),
    ("weir.abut_ka", "Abutment contraction $K_a$"), ("weir.intake_width_m", "Intake width"), ("weir.intake_target_m3s", "Canal operating flow"),
    ("weir.intake_capacity_m3s", "Canal design capacity"), ("weir.manning_n", "Manning $n$, tail reach"), ("weir.bed_slope", "Bed slope $S$"),
    ("weir.tail_width_m", "Tail section bed width"), ("weir.tail_bed_el", "Tail section bed level"), ("weir.tailwater_flood_case_el", "Tail level at design flood"),
    ("datum.offset_m", "Datum offset (terrain $-$ EL)"), ("flood.ref_tail_el", "Flood reference below weir"), ("flood.min_depth_m", "Least depth mapped"),
    ("flood.river_seed_km2", "Main-river seed area"), ("irrigation.area_default_ha", "Command area"), ("irrigation.efficiency", "Overall efficiency $e$"),
    ("irrigation.percolation_mm_day", "Percolation $P$"), ("irrigation.landprep_mm", "Land preparation $S$"), ("irrigation.kc_fao", "Rice $K_c$ by half-month"),
    ("sediment.rating_a", "Sediment rating $a$"), ("sediment.rating_b", "Sediment rating $b$"), ("sediment.yield_t_yr", "Sediment yield"),
    ("sediment.intake_factor", "Intake concentration factor"), ("sediment.trap_sand", "Trap share, sand"), ("sediment.trap_fine", "Trap share, fines"),
    ("sediment.dry_density_t_m3", "Deposit dry density"), ("sediment.flush_at", "Flush at fill"), ("maker.spill_cd", "Spillway coefficient"),
    ("evap.open_water_mm_day", "Open-water evaporation"),
]
UNIT = {"m EL": "m EL", "m3/s": "m$^3$/s", "km2": "km$^2$", "t/day per (m3/s)^b": "t/d", "t/yr": "t/yr", "m^0.5/s": "m$^{1/2}$/s", "t/m3": "t/m$^3$", "mm/day": "mm/d", "-": ""}


def leaf(key):
    g, k = key.split(".")
    return PARAMS[g][k]


def fmtv(v):
    if isinstance(v, list):
        if len(set(v)) == 1:
            return fmtv(v[0])
        return ", ".join(fmtv(x) for x in sorted(set(v), key=v.index))
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, (int, float)):
        t = f"{abs(v):,.0f}" if abs(v) >= 1000 else f"{abs(v):g}"
        return ("$-$" + t) if v < 0 else t
    return str(v)


cells = []
for key, label in SEL:
    L = leaf(key)
    u = UNIT.get(L.get("unit", ""), L.get("unit", ""))
    cells.append(f'{label} & {fmtv(L["v"])} {u} & {L["status"]}')
half = (len(cells) + 1) // 2
rows = []
for i in range(half):
    right = cells[i + half] if i + half < len(cells) else " & & "
    rows.append(f"{cells[i]} & {right} \\\\")
write("tab_params.tex", "\n".join(rows) + "\n")
M("NParamsShown", len(cells))

write("numbers.tex", "% GENERATED by paper/scripts/build.py from paper/results/results.json. Do not edit.\n" +
      "".join(f"\\newcommand{{\\{k}}}{{{v}}}\n" for k, v in MAC.items()))

# ------------------------------------------------------------------------------------------------- figures
for f in font_manager.findSystemFonts():
    if "texgyretermes" in f.lower() and f.endswith(".otf"):
        font_manager.fontManager.addfont(f)
INK, INK2, MUTED, GRID, AXIS = "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7"
BLUE, ORANGE, AQUA, VIOLET = "#2a78d6", "#eb6834", "#1baf7a", "#6250d6"
plt.rcParams.update({
    "font.family": "TeX Gyre Termes", "font.size": 7.5, "mathtext.fontset": "stix", "axes.labelsize": 7.5, "axes.titlesize": 8,
    "xtick.labelsize": 7, "ytick.labelsize": 7, "legend.fontsize": 7, "axes.edgecolor": AXIS, "axes.linewidth": 0.6, "axes.labelcolor": INK2,
    "xtick.color": MUTED, "ytick.color": MUTED, "xtick.labelcolor": INK2, "ytick.labelcolor": INK2, "xtick.major.width": 0.5, "ytick.major.width": 0.5,
    "xtick.major.size": 2.5, "ytick.major.size": 2.5, "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.5, "axes.axisbelow": True,
    "axes.spines.top": False, "axes.spines.right": False, "legend.frameon": False, "lines.linewidth": 1.3, "pdf.fonttype": 42, "savefig.pad_inches": 0.02,
    "text.color": INK,
})
COL, WIDE = 3.31, 6.85  # column and text widths in inches (A4, 18 mm margins, 6 mm gutter)


def panel(ax, letter, title):
    ax.set_title(f"({letter}) {title}", loc="left", color=INK, pad=4)


def save(fig, name):
    fig.savefig(FIG / name, bbox_inches="tight")
    plt.close(fig)
    print("wrote figures/" + name)


# ---- Fig. rain to flow: monthly mean and dependable flow, model against the published tables
fig, axs = plt.subplots(2, 1, figsize=(COL, 3.3), sharex=True)
x = np.arange(12)
ax = axs[0]
hb = ax.bar(x, rp["monthly_mean_published"], width=0.62, color="#d9d8d2", zorder=2)
(hm,) = ax.plot(x, rp["monthly_mean"], color=BLUE, marker="o", ms=3, zorder=3)
(hg,) = ax.plot(x, rf["glofas"]["monthly_mean"], color=ORANGE, ls=(0, (4, 2)), marker="s", ms=2.6, zorder=3)
ax.set_ylabel("Mean flow (m³/s)")
ax.set_ylim(0, 400)
panel(ax, "a", "Monthly mean flow at the weir")
ax = axs[1]
ax.bar(x, rp["monthly_q80_published"], width=0.62, color="#d9d8d2", zorder=2)
ax.plot(x, rp["monthly_q80"], color=BLUE, marker="o", ms=3, zorder=3)
ax.set_ylabel("80 % dependable flow (m³/s)")
ax.set_ylim(0, 260)
ax.set_xticks(x, [m[0] for m in MONTHS])
panel(ax, "b", "Monthly flow exceeded in 80 % of years")
for a in axs:
    a.grid(axis="x", visible=False)
fig.legend([hb, hm, hg], ["Published tables", "This model", "GloFAS v4"], loc="lower center", ncol=3, handlelength=2.2, columnspacing=1.4,
           bbox_to_anchor=(0.54, -0.035))
fig.subplots_adjust(hspace=0.32, bottom=0.11)
save(fig, "fig_rainflow.pdf")

# ---- Fig. weir: levels and openings against inflow, automatic operation
sw = w["sweep"]
q = np.array(sw["q"])
fig, axs = plt.subplots(2, 1, figsize=(COL, 3.35), sharex=True)
ax = axs[0]
ax.axhline(w["levels"]["design_high_water_el"], color=MUTED, lw=0.7, ls=(0, (1, 2)))
ax.text(40, w["levels"]["design_high_water_el"] + 0.12, "design high water EL 81.00", color=INK2, fontsize=6.5, va="bottom")
ax.plot(q, sw["pond"], color=BLUE, label="Pond (upstream)")
ax.plot(q, sw["tail"], color=ORANGE, ls=(0, (4, 2)), label="Tailwater (downstream)")
ax.axvline(2200, color=MUTED, lw=0.7, ls=(0, (1, 2)))
ax.text(2235, 74.25, "design flood", color=INK2, fontsize=6.5, ha="left", va="bottom")
ax.set_ylabel("Level (m EL)")
ax.set_ylim(74, 84.6)
ax.set_yticks([74, 76, 78, 80, 82, 84])
ax.legend(loc="upper right", ncol=2, handlelength=2.2, columnspacing=1.2, borderaxespad=0.1)
panel(ax, "a", "Water levels")
ax = axs[1]
ax.plot(q, sw["gate_mean"], color=BLUE, label="Flood gates")
ax.plot(q, sw["sluice_mean"], color=ORANGE, ls=(0, (4, 2)), label="Scouring sluices")
ax.axvline(2200, color=MUTED, lw=0.7, ls=(0, (1, 2)))
ax.set_ylabel("Mean lift (m)")
ax.set_xlabel("Inflow to the weir (m³/s)")
ax.set_ylim(0, 5)
ax.set_xlim(0, 3000)
ax.legend(loc="upper left", handlelength=2.2)
panel(ax, "b", "Openings chosen by the automatic rule")
fig.subplots_adjust(hspace=0.32)
save(fig, "fig_weir.pdf")

# ---- Fig. flood: the design-flood map and the response to flow
ras = fl["raster"]
C, Rr = ras["cols"], ras["rows"]
dep = np.fromfile(RES / "flood_depth_dm.i16", dtype="<i2").reshape(Rr, C) / 10.0
dem = np.fromfile(RES / "flood_dem_dm.i16", dtype="<i2").reshape(Rr, C) / 10.0
riv = np.fromfile(RES / "flood_river.u8", dtype="u1").reshape(Rr, C)
lcr = np.fromfile(RES / "flood_lc.u8", dtype="u1").reshape(Rr, C)
cell = ras["cell_deg"]
wc = int((ras["weir"][0] - ras["west"]) / cell)
wr = int((ras["north"] - ras["weir"][1]) / cell)
ky = 111.32 * cell  # km per cell, north-south
kx = ky * math.cos(math.radians(ras["weir"][1]))
# window: the wet cells within 5.5 km of the weir, padded
rr, cc = np.nonzero(dep > 0)
near = np.hypot((cc - wc) * kx, (rr - wr) * ky) < 5.5
r0, r1 = max(0, rr[near].min() - 22), min(Rr, rr[near].max() + 22)
c0, c1 = max(0, cc[near].min() - 22), min(C, cc[near].max() + 22)
sub = (slice(r0, r1), slice(c0, c1))
M_km = ((c1 - c0) * kx, (r1 - r0) * ky)
ext = [0, M_km[0], 0, M_km[1]]
ls = LightSource(azdeg=315, altdeg=45)
hs = ls.hillshade(np.clip(dem[sub], 0, None), vert_exag=4, dx=30, dy=30)
seq = LinearSegmentedColormap.from_list("depth", ["#86b6ef", "#3987e5", "#1c5cab", "#0d366b"])
fig = plt.figure(figsize=(WIDE, 3.0))
gs = fig.add_gridspec(2, 2, width_ratios=[1.12, 1], hspace=0.5, wspace=0.2)
ax = fig.add_subplot(gs[:, 0])
ax.imshow(hs, cmap="gray", vmin=-0.9, vmax=1.3, extent=ext, interpolation="bilinear")
water = np.where((riv[sub] == 1) | (lcr[sub] == 80), 1.0, np.nan)
ax.imshow(water, cmap=LinearSegmentedColormap.from_list("w", ["#c9d0d6", "#c9d0d6"]), extent=ext, interpolation="nearest")
d = np.where(dep[sub] > 0, dep[sub], np.nan)
im = ax.imshow(d, cmap=seq, vmin=0.3, vmax=max(1.8, np.nanmax(d)), extent=ext, interpolation="nearest")
wx, wy = (wc - c0 + 0.5) * kx, (r1 - wr - 0.5) * ky
ax.plot([wx - 0.11, wx + 0.11], [wy, wy], color=INK, lw=2.0, solid_capstyle="butt")
ax.annotate("weir", (wx + 0.12, wy), xytext=(wx + 0.75, wy - 0.55), fontsize=7, color=INK, arrowprops=dict(arrowstyle="-", lw=0.5, color=INK))
ax.annotate("", xy=(wx + 0.45, wy + 1.15), xytext=(wx + 0.45, wy + 0.35), arrowprops=dict(arrowstyle="-|>", lw=0.7, color=INK))
ax.text(wx + 0.55, wy + 0.75, "flow", fontsize=6.5, color=INK, ha="left", va="center")
ax.plot([0.3, 1.3], [0.3, 0.3], color=INK, lw=1.2)
ax.text(0.8, 0.38, "1 km", ha="center", va="bottom", fontsize=6.5, color=INK)
ax.annotate("N", xy=(0.35, M_km[1] - 0.25), xytext=(0.35, M_km[1] - 0.95), ha="center", fontsize=7, color=INK, arrowprops=dict(arrowstyle="-|>", lw=0.7, color=INK))
ax.set_xticks([])
ax.set_yticks([])
ax.grid(False)
for sp_ in ax.spines.values():
    sp_.set_visible(True)
cax = ax.inset_axes([0.60, 0.075, 0.34, 0.035])
cb = fig.colorbar(im, cax=cax, orientation="horizontal")
cb.set_ticks([0.3, 1.0, 1.7])
cb.ax.tick_params(labelsize=6.3, length=2, colors=INK)
cb.outline.set_linewidth(0.4)
cax.set_title("Depth over the ground (m)", fontsize=6.5, color=INK, pad=2)
panel(ax, "a", f'Ground flooded beyond the river at {num(2200)} m³/s')
tb = [r for r in fl["table"]]
qq = [r["q_in"] for r in tb]
ax = fig.add_subplot(gs[0, 1])
ax.plot(qq, [r["area_up_km2"] for r in tb], color=BLUE, marker="o", ms=3, label="Above the weir")
ax.plot(qq, [r["area_down_km2"] for r in tb], color=ORANGE, marker="s", ms=2.6, ls=(0, (4, 2)), label="Below the weir")
ax.set_ylabel("Flooded ground (km²)")
ax.set_xlim(0, 2600)
ax.set_ylim(0, None)
ax.legend(loc="upper left", handlelength=2.2)
ax.tick_params(labelbottom=False)
panel(ax, "b", "Extent against inflow")
ax = fig.add_subplot(gs[1, 1])
ax.plot(qq, [r["buildings"] for r in tb], color=BLUE, marker="o", ms=3)
ax.set_ylabel("Buildings in water ≥ 0.3 m")
ax.set_xlabel("Inflow to the weir (m³/s)")
ax.set_xlim(0, 2600)
ax.set_ylim(0, None)
panel(ax, "c", "Buildings reached")
save(fig, "fig_flood.pdf")
print("  flood map window km:", [round(v, 1) for v in M_km], "wet cells in window:", int(np.sum(dep[sub] > 0)), "of", int(np.sum(dep > 0)))

# ---- Fig. canal, sediment and reservoir
fig, axs = plt.subplots(1, 4, figsize=(WIDE, 1.75))
ax = axs[0]
h = np.arange(24)
ax.bar(h, ir["demand_m3s"], width=0.7, color=BLUE, zorder=2)
ax.axhline(ir["peak_demand_published"], color=INK2, lw=0.7, ls=(0, (1, 2)))
ax.text(23.4, ir["peak_demand_published"] + 2, "published peak", fontsize=6.3, color=INK2, ha="right", va="bottom")
ax.set_xticks(np.arange(0.5, 24, 4), [MONTHS[i][0] for i in range(0, 12, 2)])
ax.set_ylabel("Canal demand (m³/s)")
ax.set_ylim(0, 90)
ax.grid(axis="x", visible=False)
panel(ax, "a", "Demand by half-month")
ax = axs[1]
s = yrs[worst]["series"]
dd = np.arange(len(s["q"]))
dm, sp = np.array(s["demand"]), np.array(s["supplied"])
ax.fill_between(dd, sp, dm, where=dm > sp + 1e-6, color="#f6c5b2", lw=0, zorder=2, label="Shortfall")
ax.plot(dd, dm, color=INK2, lw=0.9, ls=(0, (1, 1.5)), label="Demand", zorder=3)
ax.plot(dd, sp, color=BLUE, lw=1.1, label="Delivered", zorder=4)
ax.set_xticks([15 + 30.4 * i for i in range(0, 12, 2)], [MONTHS[i][0] for i in range(0, 12, 2)])
ax.set_ylim(0, 90)
ax.set_ylabel("Canal flow (m³/s)")
ax.legend(loc="upper right", handlelength=1.6, borderaxespad=0.1, labelspacing=0.2)
ax.grid(axis="x", visible=False)
panel(ax, "b", f'Dry year {yrs[worst]["year"]}')
ax = axs[2]
F = np.array(sd["fill_year3"]) * 100
t = np.arange(len(F)) * 2
ax.plot(t, F[:, 0], color=BLUE, lw=1.1, label="Basin 1")
ax.plot(t, F[:, 1], color=ORANGE, lw=1.1, ls=(0, (4, 2)), label="Basin 2")
ax.axhline(100 * sd["flush_at"], color=INK2, lw=0.7, ls=(0, (1, 2)))
ax.set_xticks([15 + 30.4 * i for i in range(0, 12, 2)], [MONTHS[i][0] for i in range(0, 12, 2)])
ax.set_ylim(0, 118)
ax.set_yticks([0, 20, 40, 60, 80, 100])
ax.set_ylabel("Deposit (% of storage)")
ax.legend(loc="upper center", ncol=2, handlelength=1.6, borderaxespad=0.0, columnspacing=0.8, handletextpad=0.4)
ax.grid(axis="x", visible=False)
panel(ax, "c", "Settling basins")
ax = axs[3]
ax.plot(td["curve"]["level"], td["curve"]["volume_mm3"], color=BLUE)
ax.plot([td["crest_el"]], [td["storage_published_mm3"]], marker="D", ms=4, color=ORANGE, ls="none")
ax.annotate("published", (td["crest_el"], td["storage_published_mm3"]), xytext=(-6, -2), textcoords="offset points", ha="right", va="center", fontsize=6.3, color=INK2)
ax.annotate("terrain model", (td["curve"]["level"][-8], td["curve"]["volume_mm3"][-8]), xytext=(-5, 6), textcoords="offset points", ha="right", fontsize=6.3, color=INK2)
ax.set_xlabel("Lake level (m, terrain)")
ax.set_ylabel("Storage (million m³)")
ax.set_ylim(0, 140)
panel(ax, "d", "Maker: storage curve")
fig.subplots_adjust(wspace=0.52)
save(fig, "fig_ops.pdf")
