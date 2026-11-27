import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import numpy as np, rasterio, json
from rasterio.enums import Resampling
from rasterio.features import rasterize
from shapely.geometry import shape, mapping
from shapely.ops import transform as stx
from pyproj import Transformer
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
D = WORK + "/lanes/g06/dl/"; O = WORK + "/lanes/g06/out/"
def rd(b):
    with rasterio.open(D + b + ".tif") as s: return s.read(1).astype("f4") * 1e-4, s.transform, s.crs, s.shape
g, T, crs, sh = rd("B03"); n = rd("B08")[0]; r = rd("B04")[0]; bl = rd("B02")[0]
with rasterio.open(D + "B11.tif") as s:
    sw = s.read(1, out_shape=sh, resampling=Resampling.bilinear).astype("f4") * 1e-4
mndwi = (g - sw) / (g + sw + 1e-6); ndwi = (g - n) / (g + n + 1e-6)
np.save(O + "mndwi.npy", mndwi); np.save(O + "ndwi.npy", ndwi)
json.dump({"transform": list(T)[:6], "crs": str(crs), "shape": list(sh)}, open(O + "grid.json", "w"))
print("veg-ish NIR median", np.median(n), "green median", np.median(g))
# Komering centre line pixels
tr = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform
fc = json.load(open(REPO + "/site/data/feat/rivers.geojson"))
ks = [stx(tr, shape(f["geometry"])) for f in fc["features"] if f["properties"].get("name") == "Sungai Komering"]
cl = rasterize([(k, 1) for k in ks], out_shape=sh, transform=T).astype(bool)
for nm, a in [("mndwi", mndwi), ("ndwi", ndwi)]:
    v = a[cl]; print(nm, "on centre line pct 5/25/50/75", np.percentile(v, [5, 25, 50, 75]).round(3), "all pct 50/90/97", np.percentile(a, [50, 90, 97]).round(3))
# picture of the weir reach
x0, y0 = tr(104.355, -4.28); x1, y1 = tr(104.41, -4.33)
c0, r0 = ~T * (x0, y0); c1, r1 = ~T * (x1, y1); sl = (slice(int(r0), int(r1)), slice(int(c0), int(c1)))
rgb = np.dstack([r, g, bl])[sl]; rgb = np.clip(rgb / np.percentile(rgb, 99), 0, 1) ** 0.8
fig, ax = plt.subplots(2, 3, figsize=(18, 12))
ax[0, 0].imshow(rgb); ax[0, 0].set_title("true colour")
for i, (nm, a) in enumerate([("MNDWI", mndwi), ("NDWI", ndwi)]):
    ax[0, i + 1].imshow(a[sl], cmap="RdBu", vmin=-0.6, vmax=0.6); ax[0, i + 1].set_title(nm)
for i, t in enumerate([-0.1, 0.0, 0.1]):
    m = mndwi[sl] > t; im = rgb.copy(); im[m] = im[m] * 0.4 + np.array([0, 0.6, 1]) * 0.6
    ax[1, i].imshow(im); ax[1, i].set_title(f"MNDWI > {t}")
for a in ax.flat: a.axis("off")
fig.text(0.01, 0.005, "Contains modified Copernicus Sentinel data 2026 (S2B 26 Apr 2026). Check picture, not a survey.", fontsize=9)
plt.tight_layout(); plt.savefig(O + "idx_check.png", dpi=70)
