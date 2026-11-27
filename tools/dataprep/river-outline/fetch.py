"""Windowed reads of S2 L2A COG bands and WorldCover over the fine box. Writes only into lanes/g06/dl."""
import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import os, sys, rasterio
from rasterio.windows import from_bounds
from rasterio.warp import transform_bounds
OUT = WORK + "/lanes/g06/dl"
BASE = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/48/M/VA/2026/4/S2B_48MVA_20260426_0_L2A/"
os.environ.update(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif", GDAL_HTTP_MAX_RETRY="3")
W, S, E, N = 104.20, -4.50, 104.55, -4.10
def grab(url, name, crs_bounds=None):
    dst = os.path.join(OUT, name)
    assert os.path.realpath(dst).startswith(OUT)
    if os.path.exists(dst): print("have", name); return
    with rasterio.open("/vsicurl/" + url) as src:
        b = transform_bounds("EPSG:4326", src.crs, W - 0.003, S - 0.003, E + 0.003, N + 0.003, densify_pts=21)
        win = from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
        a = src.read(1, window=win, boundless=True, fill_value=0)
        prof = src.profile.copy()
        prof.update(width=a.shape[1], height=a.shape[0], transform=src.window_transform(win), driver="GTiff", compress="deflate", tiled=False)
        prof.pop("blockxsize", None); prof.pop("blockysize", None)
        with rasterio.open(dst, "w", **prof) as d: d.write(a, 1); d.update_tags(SOURCE=url)
        print(name, a.shape, src.crs, a.min(), a.max())
for b in ["B02", "B03", "B04", "B08", "B11", "SCL"]:
    grab(BASE + b + ".tif", b + ".tif")
grab("https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_S06E102_Map.tif", "wc.tif")
