"""g01 terrain build: GLO-30 mosaic -> dem_wide/dem_fine, Terrarium tiles, contours, shots, checks.
usage: python -I build.py <step>   steps: dem tiles contours shots check stats
"""
import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import glob
import json
import math
import os
import sys

import numpy as np

BASE = WORK + ""
REPO = REPO + ""
LANE = f"{BASE}/lanes/g01"
RAW = f"{BASE}/geo/raw/glo30"
DEM_WIDE = f"{BASE}/geo/dem_wide.tif"
DEM_FINE = f"{BASE}/geo/dem_fine.tif"
MOSAIC = f"{LANE}/mosaic.tif"
TILES = f"{REPO}/site/data/tiles/terrain"
FEAT = f"{REPO}/site/data/feat"
SHOTS = f"{BASE}/geo/shots"
ALLOWED = [LANE + "/", f"{BASE}/geo/raw/glo30/", DEM_WIDE, DEM_FINE, SHOTS + "/g01-", TILES + "/",
           f"{FEAT}/contours_wide.geojson", f"{FEAT}/contours_fine.geojson"]

CREDIT = ("Elevation: Copernicus DEM GLO-30, (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018 "
          "provided under COPERNICUS by the European Union and ESA; all rights reserved.")
NOT_SURVEY = "Terrain: GLO-30 satellite surface model (30 m cells, tree tops and roofs included), not a survey"
ATTR = ("Elevation: Copernicus DEM GLO-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018, "
        "provided under COPERNICUS by the EU and ESA. Satellite surface model, not a survey.")

BOX = json.load(open(f"{BASE}/geo/box.json"))
WIDE = (BOX["west"], BOX["south"], BOX["east"], BOX["north"])
FINE = (BOX["fine"]["west"], BOX["fine"]["south"], BOX["fine"]["east"], BOX["fine"]["north"])
ARC = 1.0 / 3600.0


def guard(path):
    p = os.path.abspath(path)
    if not any(p == a or p.startswith(a) for a in ALLOWED):
        raise SystemExit(f"refusing to write outside owned paths: {p}")
    return p


def step_dem():
    import rasterio
    from rasterio.merge import merge
    srcs = [rasterio.open(f) for f in sorted(glob.glob(f"{RAW}/*.tif"))]
    arr, tr = merge(srcs, nodata=-32767.0, dtype="float32")
    prof = srcs[0].profile
    print("mosaic", arr.shape, tr, "src res", srcs[0].res, "nodata", srcs[0].nodata)
    a = arr[0]
    a[a <= -32000] = np.nan
    prof.update(driver="GTiff", height=a.shape[0], width=a.shape[1], transform=tr, dtype="float32", nodata=np.nan,
                compress="deflate", predictor=3, tiled=True, blockxsize=512, blockysize=512, count=1)
    prof.pop("copy_src_overviews", None)
    with rasterio.open(guard(MOSAIC), "w", **prof) as d:
        d.write(a, 1)
    for box, out in ((WIDE, DEM_WIDE), (FINE, DEM_FINE)):
        w, s, e, n = box
        c0 = int(round((w - tr.c) / tr.a)); c1 = int(round((e - tr.c) / tr.a))
        r0 = int(round((n - tr.f) / tr.e)); r1 = int(round((s - tr.f) / tr.e))
        sub = a[r0:r1, c0:c1]
        t2 = rasterio.Affine(tr.a, 0, tr.c + c0 * tr.a, 0, tr.e, tr.f + r0 * tr.e)
        p2 = dict(prof, height=sub.shape[0], width=sub.shape[1], transform=t2)
        with rasterio.open(guard(out), "w", **p2) as d:
            d.write(sub, 1)
            d.update_tags(source="Copernicus DEM GLO-30 (COG tiles from copernicus-dem-30m S3), mosaic, no resampling",
                          vertical="m above EGM2008 geoid", credit=CREDIT, note=NOT_SURVEY)
        print(out, sub.shape, t2, "nan", int(np.isnan(sub).sum()))


def lon2x(lon, z):
    return (lon + 180.0) / 360.0 * 2 ** z


def lat2y(lat, z):
    r = math.radians(lat)
    return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z


def tile_range(box, z):
    w, s, e, n = box
    return (int(math.floor(lon2x(w, z))), int(math.floor(lon2x(e, z) - 1e-9)),
            int(math.floor(lat2y(n, z))), int(math.floor(lat2y(s, z) - 1e-9)))


R = 6378137.0
HALF = math.pi * R


def render_zoom(z, box, src):
    """One mercator raster covering the zoom's tile range, so neighbouring tiles share one resampling."""
    import rasterio
    from rasterio.warp import Resampling, reproject
    x0, x1, y0, y1 = tile_range(box, z)
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    res = 2 * HALF / (256 * 2 ** z)
    left = -HALF + x0 * 256 * res
    top = HALF - y0 * 256 * res
    dst = np.full((ny * 256, nx * 256), np.nan, dtype="float32")
    reproject(source=rasterio.band(src, 1), destination=dst, dst_transform=rasterio.Affine(res, 0, left, 0, -res, top),
              dst_crs="EPSG:3857", resampling=Resampling.bilinear, src_nodata=np.nan, dst_nodata=np.nan, num_threads=1)
    return x0, y0, nx, ny, dst


def encode(h):
    h = np.where(np.isfinite(h), h, 0.0)  # voids, sea and outside the mosaic = 0 m
    # quantised to 0.25 m (far below GLO-30's metre-level error) so the PNGs compress under the 60 MB budget
    v = np.round((h.astype("float64") + 32768.0) * 4.0) / 4.0
    r = np.floor(v / 256.0)
    g = np.floor(v - r * 256.0)
    b = np.round((v - r * 256.0 - g) * 256.0)
    return np.dstack([r, g, b]).astype("uint8")


def step_tiles():
    import rasterio
    from PIL import Image
    src = rasterio.open(MOSAIC)
    total, count = 0, 0
    levels = [(z, WIDE) for z in range(6, 13)] + [(13, FINE)]
    for z, box in levels:
        x0, y0, nx, ny, big = render_zoom(z, box, src)
        rgb = encode(big)
        for i in range(nx):
            for j in range(ny):
                d = guard(f"{TILES}/{z}/{x0 + i}")
                os.makedirs(d, exist_ok=True)
                p = f"{d}/{y0 + j}.png"
                Image.fromarray(rgb[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256]).save(p, optimize=True)
                total += os.path.getsize(p); count += 1
        print("z", z, "tiles", nx * ny, "range x", x0, x0 + nx - 1, "y", y0, y0 + ny - 1)
    tj = {"tilejson": "3.0.0", "name": "Komering terrain (GLO-30, Terrarium)", "tiles": ["./{z}/{x}/{y}.png"],
          "scheme": "xyz", "encoding": "terrarium", "tileSize": 256, "minzoom": 6, "maxzoom": 13,
          "bounds": list(WIDE), "fine_bounds_z13": list(FINE), "attribution": ATTR,
          "description": ("Copernicus GLO-30 surface model resampled bilinear to web mercator. Zoom 6-12 over the wide "
                          "box, zoom 13 inside the fine box only (MapLibre overzooms z12 elsewhere). Voids, sea and "
                          "anything outside the 6 source tiles (103-105 E, 6-3 S) are 0 m. Heights m above EGM2008. "
                          "Heights quantised to 0.25 m. Tile URLs are relative to this file; a page may "
                          "rewrite them to absolute.")}
    with open(guard(f"{TILES}/tiles.json"), "w") as f:
        json.dump(tj, f, indent=1)
    print("tiles", count, "bytes", total, f"{total / 1e6:.1f} MB")


def smooth(a, sigma):
    """Separable Gaussian on a NaN-free array (numpy only)."""
    rad = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-rad, rad + 1) / sigma) ** 2); k /= k.sum()
    out = a.astype("float64")
    for ax in (0, 1):
        pad = [(0, 0), (0, 0)]; pad[ax] = (rad, rad)
        p = np.pad(out, pad, mode="edge")
        acc = np.zeros_like(out)
        for i, w in enumerate(k):
            sl = [slice(None), slice(None)]; sl[ax] = slice(i, i + out.shape[ax])
            acc += w * p[tuple(sl)]
        out = acc
    return out


def contours(path, out, step, sigma, down, tol, lo):
    import contourpy
    import rasterio
    from shapely.geometry import LineString
    with rasterio.open(path) as d:
        a = d.read(1); tr = d.transform
    a = np.where(np.isfinite(a), a, 0.0)
    if down > 1:
        h, w = (a.shape[0] // down) * down, (a.shape[1] // down) * down
        a = a[:h, :w].reshape(h // down, down, w // down, down).mean(axis=(1, 3))
    s = smooth(a, sigma)
    cell = tr.a * down
    xs = tr.c + (np.arange(s.shape[1]) + 0.5) * cell
    ys = tr.f - (np.arange(s.shape[0]) + 0.5) * cell
    gen = contourpy.contour_generator(xs, ys, s, line_type="Separate")
    levels = np.arange(lo, s.max() + step, step)
    feats = []
    for lev in levels:
        for seg in gen.lines(float(lev)):
            if len(seg) < 4:
                continue
            g = LineString(seg).simplify(tol, preserve_topology=False)
            if g.length < tol * 6:
                continue
            coords = [[round(x, 5), round(y, 5)] for x, y in g.coords]
            feats.append({"type": "Feature", "properties": {"e": round(float(lev), 1)},
                          "geometry": {"type": "LineString", "coordinates": coords}})
    fc = {"type": "FeatureCollection", "name": os.path.basename(out),
          "note": (f"Contours every {step} m from Copernicus GLO-30 (surface model, not a survey), smoothed with a "
                   f"Gaussian of sigma {sigma} cells on a {cell * 3600:.0f} arc-second grid before contouring, "
                   f"simplified at {tol * 111000:.0f} m. Heights m above EGM2008. Indicative only."),
          "attribution": ATTR, "features": feats}
    with open(guard(out), "w") as f:
        json.dump(fc, f, separators=(",", ":"))
    print(out, len(feats), "lines", os.path.getsize(out), "bytes")


def step_contours():
    contours(DEM_WIDE, f"{FEAT}/contours_wide.geojson", 100.0, 1.5, 3, 0.0006, 100.0)
    contours(DEM_FINE, f"{FEAT}/contours_fine.geojson", 12.5, 2.0, 1, 0.00015, 12.5)


def step_shots():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import rasterio
    from matplotlib.colors import LightSource
    for path, tag, cpath, mark in ((DEM_WIDE, "wide", f"{FEAT}/contours_wide.geojson", True),
                                   (DEM_FINE, "fine", f"{FEAT}/contours_fine.geojson", True)):
        with rasterio.open(path) as d:
            a = d.read(1); b = d.bounds
        a = np.where(np.isfinite(a), a, 0.0)
        step = 3 if tag == "wide" else 1
        a2 = a[::step, ::step]
        dy = 30.9 * step; dx = 30.9 * step * math.cos(math.radians(4.4))
        ls = LightSource(azdeg=315, altdeg=45)
        vmax = np.percentile(a2, 99.5)
        rgb = ls.shade(a2, cmap=plt.cm.terrain, vert_exag=2 if tag == "wide" else 6, dx=dx, dy=dy, blend_mode="soft",
                       vmin=-50 if tag == "wide" else a2.min() - 20, vmax=vmax)
        fig = plt.figure(figsize=(11, 12.2), dpi=110)
        ax = fig.add_axes([0.07, 0.17, 0.88, 0.78])
        ext = [b.left, b.right, b.bottom, b.top]
        ax.imshow(rgb, extent=ext, interpolation="bilinear")
        cs = json.load(open(cpath))
        for f in cs["features"]:
            c = np.array(f["geometry"]["coordinates"])
            major = (f["properties"]["e"] % (500 if tag == "wide" else 50)) == 0
            ax.plot(c[:, 0], c[:, 1], color="#5a3a1a", lw=0.8 if major else 0.3, alpha=0.8 if major else 0.5)
        pts = [("Martapura (about)", 104.36, -4.32), ("Danau Ranau (about)", 103.92, -4.86)]
        for name, lo, la in pts:
            if ext[0] < lo < ext[1] and ext[2] < la < ext[3]:
                ax.plot(lo, la, "o", ms=6, mfc="red", mec="white")
                ax.annotate(name, (lo, la), xytext=(6, 6), textcoords="offset points", fontsize=10,
                            bbox=dict(fc="white", alpha=0.8, lw=0))
        if tag == "wide":
            w, s, e, n = FINE
            ax.plot([w, e, e, w, w], [s, s, n, n, s], color="black", lw=1.2, ls="--")
            ax.text(w, n + 0.01, "fine box", fontsize=9)
        ax.set_xlim(ext[0], ext[1]); ax.set_ylim(ext[2], ext[3]); ax.set_aspect(1 / math.cos(math.radians(4.4)))
        ax.set_xlabel("longitude (deg E)"); ax.set_ylabel("latitude (deg)")
        title = ("Komering basin, wide box: hillshade, contours 100 m (bold 500 m)" if tag == "wide" else
                 "Perjaya weir reach, fine box: hillshade, contours 12.5 m (bold 50 m)")
        ax.set_title(title, fontsize=12)
        fig.text(0.07, 0.10, NOT_SURVEY, fontsize=10, weight="bold")
        fig.text(0.07, 0.075, "Contours from the satellite surface model, smoothed lightly: indicative only. "
                 "Heights m above EGM2008. Points are approximate.", fontsize=8.5)
        fig.text(0.07, 0.035, CREDIT, fontsize=7.6, wrap=True)
        fig.text(0.07, 0.012, "lane g01, 23 Nov 2026", fontsize=7, color="#666")
        out = guard(f"{SHOTS}/g01-hillshade-{tag}.png")
        fig.savefig(out); plt.close(fig)
        print(out)


def sample_bilinear(src, a, lon, lat):
    tr = src.transform
    fc = (lon - tr.c) / tr.a - 0.5; fr = (lat - tr.f) / tr.e - 0.5
    c0, r0 = int(math.floor(fc)), int(math.floor(fr)); tc, trr = fc - c0, fr - r0
    q = a[r0:r0 + 2, c0:c0 + 2]
    return float(q[0, 0] * (1 - tc) * (1 - trr) + q[0, 1] * tc * (1 - trr) + q[1, 0] * (1 - tc) * trr + q[1, 1] * tc * trr)


def step_check():
    import rasterio
    from PIL import Image
    src = rasterio.open(MOSAIC); a = src.read(1)
    rng = np.random.default_rng(23)
    worst = []
    for z, box in [(8, WIDE), (10, WIDE), (12, WIDE), (13, FINE)]:
        x0, x1, y0, y1 = tile_range(box, z)
        for _ in range(4):
            x, y = int(rng.integers(x0, x1 + 1)), int(rng.integers(y0, y1 + 1))
            im = np.asarray(Image.open(f"{TILES}/{z}/{x}/{y}.png").convert("RGB")).astype("float64")
            h = im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768
            for _ in range(25):
                px, py = int(rng.integers(0, 256)), int(rng.integers(0, 256))
                mx = (x * 256 + px + 0.5) / (256 * 2 ** z); my = (y * 256 + py + 0.5) / (256 * 2 ** z)
                lon = mx * 360 - 180; lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * my))))
                if not (WIDE[0] < lon < WIDE[2] and WIDE[1] < lat < WIDE[3]):
                    continue
                ref = sample_bilinear(src, a, lon, lat)
                if not np.isfinite(ref):
                    ref = 0.0
                worst.append((abs(h[py, px] - ref), z, x, y, round(lon, 5), round(lat, 5), round(float(h[py, px]), 2), round(ref, 2)))
    worst.sort(reverse=True)
    d = np.array([w[0] for w in worst])
    for zz in (8, 10, 12, 13):
        dz = np.array([w[0] for w in worst if w[1] == zz])
        print("zoom", zz, "n", len(dz), "max", dz.max().round(3), "median", np.median(dz).round(3))
    print("points", len(d), "max", d.max().round(3), "mean", d.mean().round(4), "p95", np.percentile(d, 95).round(3))
    for w in worst[:5]:
        print("worst", w)
    # edge agreement: last column of tile x equals first column of x+1 continuity (same big raster)
    z = 12; x0, x1, y0, y1 = tile_range(WIDE, z)
    xm, ym = (x0 + x1) // 2, (y0 + y1) // 2
    A = np.asarray(Image.open(f"{TILES}/{z}/{xm}/{ym}.png").convert("RGB")).astype("float64")
    B = np.asarray(Image.open(f"{TILES}/{z}/{xm + 1}/{ym}.png").convert("RGB")).astype("float64")
    ha = A[..., 0] * 256 + A[..., 1] + A[..., 2] / 256 - 32768; hb = B[..., 0] * 256 + B[..., 1] + B[..., 2] / 256 - 32768
    jump = np.abs(ha[:, -1] - hb[:, 0]).mean(); inner = np.abs(ha[:, -2] - ha[:, -1]).mean()
    print(f"edge z12 {xm}/{ym}|{xm + 1}: mean step across edge {jump:.2f} m vs within tile {inner:.2f} m")


def step_stats():
    import rasterio
    for path, tag in ((DEM_WIDE, "wide"), (DEM_FINE, "fine")):
        with rasterio.open(path) as d:
            a = d.read(1); tr = d.transform
        v = a[np.isfinite(a)]
        r, c = np.unravel_index(np.nanargmin(a), a.shape); r2, c2 = np.unravel_index(np.nanargmax(a), a.shape)
        print(tag, "cells", a.size, "void", int((~np.isfinite(a)).sum()), "min", v.min().round(2),
              (round(tr.c + (c + .5) * tr.a, 4), round(tr.f + (r + .5) * tr.e, 4)), "max", v.max().round(2),
              (round(tr.c + (c2 + .5) * tr.a, 4), round(tr.f + (r2 + .5) * tr.e, 4)), "mean", v.mean().round(2),
              "median", np.median(v).round(2), "p1", np.percentile(v, 1).round(1), "p99", np.percentile(v, 99).round(1),
              "share<=0", round(float((v <= 0).mean()), 4))
    src = rasterio.open(MOSAIC); a = src.read(1); tr = src.transform
    for name, lon, lat, rad in (("Martapura", 104.36, -4.32, 10), ("Danau Ranau", 103.92, -4.86, 17)):
        c = int((lon - tr.c) / tr.a); r = int((lat - tr.f) / tr.e)
        win = a[r - rad:r + rad + 1, c - rad:c + rad + 1]
        print(name, "point", round(sample_bilinear(src, a, lon, lat), 2), f"window +-{rad} cells (~{rad * 31} m):",
              "median", np.nanmedian(win).round(2), "p10", np.nanpercentile(win, 10).round(2), "p90",
              np.nanpercentile(win, 90).round(2), "min", np.nanmin(win).round(2), "max", np.nanmax(win).round(2),
              "std", np.nanstd(win).round(2))
    # lake: mode of heights across a larger lake window (flattened water surface)
    c = int((103.92 - tr.c) / tr.a); r = int((-4.86 - tr.f) / tr.e)
    win = a[r - 60:r + 61, c - 60:c + 61].round(1).ravel()
    vals, cnt = np.unique(win, return_counts=True)
    o = np.argsort(cnt)[::-1][:3]
    print("Ranau commonest values in +-60 cells:", list(zip(vals[o].tolist(), cnt[o].tolist())), "of", win.size)


if __name__ == "__main__":
    {"dem": step_dem, "tiles": step_tiles, "contours": step_contours, "shots": step_shots,
     "check": step_check, "stats": step_stats}[sys.argv[1]]()
