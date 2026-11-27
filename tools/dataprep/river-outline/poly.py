import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import numpy as np, rasterio, json, os
from rasterio.features import rasterize, shapes
from scipy import ndimage as ndi
import shapely
from shapely.geometry import shape, mapping, LineString, Point
from shapely.ops import unary_union, substring
from pyproj import Transformer
O = WORK + "/lanes/g06/out/"
REPO_OUT = REPO + "/site/data/feat/river_poly.geojson"
T_RIVER, T_CANAL = 0.10, 0.0
gr = json.load(open(O + "grid.json")); T = rasterio.Affine(*gr["transform"]); crs = gr["crs"]; sh = tuple(gr["shape"])
m = np.load(O + "mndwi.npy"); nd = np.load(O + "ndwi.npy"); red = rasterio.open(WORK + "/lanes/g06/dl/B04.tif").read(1) * 1e-4
fwd = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform
inv = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform
def P(g): return shapely.ops.transform(fwd, g)
fc = json.load(open(REPO + "/site/data/feat/rivers.geojson"))
kom = [P(shape(f["geometry"])) for f in fc["features"] if f["properties"].get("name") == "Sungai Komering"]
kom_line = shapely.line_merge(unary_union(kom))
canal = [P(shape(f["geometry"])) for f in fc["features"] if f["properties"].get("kind") == "canal" and abs(f["geometry"]["coordinates"][0][0] - 104.38545) < 1e-4]
ditch = [P(shape(f["geometry"])) for f in fc["features"] if f["properties"].get("kind") in ("ditch", "drain") and 104.380 < f["geometry"]["coordinates"][0][0] < 104.386 and -4.306 < f["geometry"]["coordinates"][0][1] < -4.303]
basin_osm = P(shapely.from_wkt(open(O + "basin.wkt").read()))
weir = P(LineString([(104.3800307, -4.305128), (104.3819847, -4.3051046)]))
R = lambda geoms, v=1: rasterize([(g, v) for g in geoms], out_shape=sh, transform=T, all_touched=True).astype(bool)
cl = R(kom); px = 10.0
dist_cl = ndi.distance_transform_edt(~cl) * px
basin_zone = R([basin_osm.buffer(15)])
canal_zone = R([unary_union(canal + ditch).buffer(20)]) & (dist_cl > 130) & ~basin_zone
# --- river
cand = (m > T_RIVER) & ((red > 0.095) | (m > 0.6)) & (dist_cl < 250) & ~basin_zone & ~canal_zone
cand = ndi.binary_opening(cand, structure=np.ones((2, 2)))        # cut 1-px links to paddies
cand |= cl & (dist_cl < 250) & ~basin_zone & ~canal_zone           # carry the line under bridges / weir
cand |= R([weir.buffer(10)]) & ~basin_zone                         # weir crest: river continues across
cand = ndi.binary_closing(cand, structure=ndi.generate_binary_structure(2, 1), iterations=2)
lab, nl = ndi.label(cand); keep = np.unique(lab[cl & cand]); keep = keep[keep > 0]
river = np.isin(lab, keep)
river |= ndi.binary_dilation(river, iterations=1) & (m > T_RIVER) & ~basin_zone & ~canal_zone   # give back mixed bank pixels
# fill islands < 1 ha (100 px)
holes = ndi.binary_fill_holes(river) & ~river; hl, _ = ndi.label(holes); sz = ndi.sum(holes, hl, range(1, hl.max() + 1))
river |= np.isin(hl, 1 + np.where(sz < 100)[0])
# --- basin & canal
basin = (m > T_CANAL) & basin_zone & ~river
canalm = (m > T_CANAL) & canal_zone & ~river & ~basin
canalm = ndi.binary_closing(canalm | (R(canal + ditch) & canal_zone & ndi.binary_dilation(m > T_CANAL, iterations=1)), iterations=1)
def drop_specks(a, minpx):
    l, k = ndi.label(a); s = ndi.sum(a, l, range(1, k + 1)); return np.isin(l, 1 + np.where(s >= minpx)[0])
basin = drop_specks(basin, 20); canalm = drop_specks(canalm, 15)
def vec(a, kind, name):
    gs = [shape(g) for g, v in shapes(a.astype("u1"), mask=a, transform=T, connectivity=4) if v == 1]
    u = unary_union(gs)
    u = u.simplify(4).buffer(5, join_style=1).buffer(-5, join_style=1).simplify(2)
    parts = [p for p in getattr(u, "geoms", [u]) if p.area > 1500 or kind != "river"]
    return [(p, kind, name) for p in parts]
feats = vec(river, "river", "Sungai Komering") + vec(basin, "basin", "Bak Desilting Perjaya (kantong lumpur)") + vec(canalm, "canal", "saluran induk / intake (unnamed in OSM)")
out = {"type": "FeatureCollection",
       "credit": "Contains modified Copernicus Sentinel data 2026 (S2B_48MVA_20260426_0_L2A); river line and basin name (c) OpenStreetMap contributors, ODbL, via Overture",
       "method": f"MNDWI (green B03, SWIR B11 at 10 m) > {T_RIVER} and turbid (red B04 > 0.095, or MNDWI > 0.6) for the river, which drops the clear-water flooded fields beside it (one pixel of bank given back), and > {T_CANAL} for basin/canal, connected to the mapped Komering line, 2-px closing, islands < 1 ha filled, vectorised, simplify 4 m + 5 m round open/close. Water surface on 26 Apr 2026, not a survey; outline within about 10 m of the pixels.",
       "features": []}
for g, kind, name in feats:
    gg = shapely.set_precision(shapely.ops.transform(inv, g), 1e-6)
    out["features"].append({"type": "Feature", "properties": {"kind": kind, "name": name, "area_ha": round(g.area / 1e4, 2)}, "geometry": mapping(gg)})
s = json.dumps(out, separators=(",", ":"))
assert os.path.realpath(REPO_OUT) == REPO_OUT
open(REPO_OUT, "w").write(s); print("wrote", REPO_OUT, len(s), "bytes", [(f["properties"]["kind"], f["properties"]["area_ha"]) for f in out["features"]][:12], len(out["features"]))
np.save(O + "river_mask.npy", river)
# widths
rp = unary_union([g for g, k, _ in feats if k == "river"])
seg = [l for l in getattr(kom_line, "geoms", [kom_line]) if l.distance(weir) < 200][0]
d0 = seg.project(weir.centroid)
res = {}
for lab_, dd in [("weir", 0), ("500 m upstream", -500), ("500 m downstream", 500)]:
    s0 = seg.interpolate(d0 + dd); a = seg.interpolate(d0 + dd - 60); b = seg.interpolate(d0 + dd + 60)
    if lab_ == "weir":
        dx, dy = weir.coords[1][0] - weir.coords[0][0], weir.coords[1][1] - weir.coords[0][1]; L = np.hypot(dx, dy); nx, ny = dx / L, dy / L
    else:
        tx, ty = b.x - a.x, b.y - a.y; L = np.hypot(tx, ty); nx, ny = -ty / L, tx / L
    xs = LineString([(s0.x - 800 * nx, s0.y - 800 * ny), (s0.x + 800 * nx, s0.y + 800 * ny)])
    ix = xs.intersection(rp); pieces = [p for p in getattr(ix, "geoms", [ix]) if p.length > 0]
    near = min(pieces, key=lambda p: p.distance(s0))
    wet = sum(p.length for p in pieces if p.distance(near) < 400)
    ll = inv(s0.x, s0.y)
    res[lab_] = {"lon": round(ll[0], 5), "lat": round(ll[1], 5), "span_m": round(near.length), "wet_sum_within_400m_m": round(wet), "pieces": [round(p.length) for p in pieces]}
json.dump(res, open(O + "widths.json", "w"), indent=1); print(json.dumps(res, indent=1))
