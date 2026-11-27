import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import sys, os, json
sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "4"); os.environ["GDAL_DISABLE_READDIR_ON_OPEN"] = "EMPTY_DIR"
import numpy as np, rasterio
from rasterio.windows import from_bounds
from rasterio.warp import reproject, Resampling
from rasterio.transform import from_origin
BASE = WORK + ""; GRID = REPO + "/site/data/grid"
def guard(p):
    ok = [GRID + "/wide.lc.u8", GRID + "/fine.lc.u8", GRID + "/lc.json", BASE + "/geo/water_occurrence_fine.tif"]
    if os.path.abspath(p) not in ok and not os.path.abspath(p).startswith(BASE + "/geo/shots/g04-"): raise SystemExit("refuse " + p)
    return p
WC = "/vsicurl/https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_S06E102_Map.tif"
CL = {10: "Tree cover", 20: "Shrubland", 30: "Grassland", 40: "Cropland", 50: "Built-up", 60: "Bare / sparse vegetation",
      70: "Snow and ice", 80: "Permanent water bodies", 90: "Herbaceous wetland", 95: "Mangroves", 100: "Moss and lichen"}
def majority(a, f):
    h, w = a.shape[0] // f, a.shape[1] // f
    a = a[:h * f, :w * f].reshape(h, f, w, f)
    best = np.zeros((h, w), np.uint8); bc = np.full((h, w), -1, np.int32)
    for k in CL:
        cnt = (a == k).sum(axis=(1, 3), dtype=np.int32)
        m = cnt > bc; best[m] = k; bc[m] = cnt[m]
    best[bc == 0] = 0
    return best
with rasterio.open(WC) as src:
    print(src.res, src.bounds)
    # wide: 103.30..105.00 x -5.20..-3.50 at 3" = 10 WorldCover pixels (0.3")
    w = from_bounds(103.30, -5.20, 105.00, -3.50, src.transform).round_offsets().round_lengths()
    a = src.read(1, window=w); print("wide raw", a.shape)
    wide = majority(a, 10); del a
    print("wide", wide.shape)
    wide.tofile(guard(GRID + "/wide.lc.u8"))
    # fine: 104.20..104.55 x -4.50..-4.10 at 1" (1260 x 1440), mode of 10 m pixels
    w = from_bounds(104.20 - 0.001, -4.50 - 0.001, 104.55 + 0.001, -4.10 + 0.001, src.transform).round_offsets().round_lengths()
    a = src.read(1, window=w); tr = src.window_transform(w)
    fine = np.zeros((1440, 1260), np.uint8)
    reproject(a, fine, src_transform=tr, src_crs="EPSG:4326", dst_transform=from_origin(104.20, -4.10, 1/3600, 1/3600), dst_crs="EPSG:4326", resampling=Resampling.mode)
    fine.tofile(guard(GRID + "/fine.lc.u8"))
def share(g): 
    v, n = np.unique(g, return_counts=True); return {str(int(k)): round(float(c) / g.size, 4) for k, c in zip(v, n)}
meta = {"classes": {str(k): v for k, v in CL.items()}, "nodata": 0,
  "wide": {"file": "wide.lc.u8", "cols": 2040, "rows": 2040, "west": 103.30, "north": -3.50, "east": 105.00, "south": -5.20, "cell_deg": 1/1200, "cell": "3 arc-seconds", "resampling": "majority of 10x10 WorldCover 10 m pixels", "share": share(wide)},
  "fine": {"file": "fine.lc.u8", "cols": 1260, "rows": 1440, "west": 104.20, "north": -4.10, "east": 104.55, "south": -4.50, "cell_deg": 1/3600, "cell": "1 arc-second", "resampling": "mode (GDAL) of WorldCover 10 m pixels", "share": share(fine)},
  "layout": "uint8, row-major from the north-west corner, row 0 = north edge",
  "credit": "Land cover: (c) ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0).",
  "source": WC.replace("/vsicurl/", "")}
json.dump(meta, open(guard(GRID + "/lc.json"), "w"), indent=1)
print(meta["wide"]["share"], meta["fine"]["share"])
# JRC occurrence fine box
J = "/vsicurl/https://storage.googleapis.com/global-surface-water/downloads2021/occurrence/occurrence_100E_0Nv1_4_2021.tif"
with rasterio.open(J) as src:
    w = from_bounds(104.20, -4.50, 104.55, -4.10, src.transform).round_offsets().round_lengths()
    a = src.read(1, window=w); prof = src.profile.copy()
    prof.update(height=a.shape[0], width=a.shape[1], transform=src.window_transform(w), compress="deflate", tiled=True, blockxsize=256, blockysize=256, driver="GTiff")
    with rasterio.open(guard(BASE + "/geo/water_occurrence_fine.tif"), "w", **prof) as d:
        d.write(a, 1)
        d.update_tags(credit="Water: Source EC JRC/Google, Global Surface Water v1.4 (Pekel et al. 2016, Nature 540, 418-422). Occurrence 1984-2021, percent of valid months; 255 = no data", source=J.replace("/vsicurl/", ""))
    print("jrc", a.shape, src.res, int((a >= 50).sum()), "px >=50%")
