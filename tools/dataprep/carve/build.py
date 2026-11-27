"""g07 carved river bed: GLO-30 fine box -> 5 m UTM model with an ASSUMED river bed -> Terrarium tiles z10-14.
usage: python -I build.py <step>   steps: carve tiles check shots
The surface model records the river at its water surface; the bed carved here is an assumption from the
project's design levels (params.json), not a measurement.
"""
import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import json
import math
import os
import sys

import numpy as np

BASE = WORK + ""
REPO = REPO + ""
LANE = f"{BASE}/lanes/g07"
DEM_FINE = f"{BASE}/geo/dem_fine.tif"
MOSAIC = f"{BASE}/lanes/g01/mosaic.tif"
CARVED = f"{BASE}/geo/dem_fine_carved.tif"
TILES = f"{REPO}/site/data/tiles/terrain"
FEAT = f"{REPO}/site/data/feat"
SHOTS = f"{BASE}/geo/shots"
ALLOWED = [LANE + "/", CARVED, SHOTS + "/g07-", TILES + "/", f"{FEAT}/carve.json"]

CRS = "EPSG:32748"   # UTM 48 S, local metric projection
CELL = 5.0
REACH_M = 5000.0     # carved reach each side of the axis, measured along the river
RAMP_M = 500.0       # last 500 m of each end ramps back up to the present surface
BANK = 0.5           # 1 vertical to 2 horizontal
PAD = 10.0           # around the weir model footprint

CREDIT_DEM = ("Elevation: Copernicus DEM GLO-30, (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH "
              "2014-2018, provided under COPERNICUS by the EU and ESA.")
CREDIT_RIV = ("River outline: contains modified Copernicus Sentinel data 2026 (26 Apr 2026); river line "
              "(c) OpenStreetMap contributors, ODbL, via Overture.")
NOTE = "Not a survey: river bed ASSUMED from design levels (the surface model has no bed)."

BOX = json.load(open(f"{BASE}/geo/box.json"))["fine"]
FINE = (BOX["west"], BOX["south"], BOX["east"], BOX["north"])


def guard(path):
    p = os.path.abspath(path)
    if not any(p == a or p.startswith(a) for a in ALLOWED):
        raise SystemExit(f"refusing to write outside owned paths: {p}")
    return p


def levels():
    p = json.load(open(f"{REPO}/site/data/params.json"))["flat"]
    w = json.load(open(f"{REPO}/site/data/weir.json"))
    off = p["datum.offset_m"]
    basin = w.get("stilling_basin", {}).get("floor_el", {}).get("v", 73.0)
    L = {"offset": off,
         "bed_up": round(p["weir.riverbed_el"] + off, 2),
         "bed_down": round(p["weir.tail_bed_el"] + off, 2),
         "pond_surface_dsm": round(p["weir.pond_normal_el"] + off, 2),
         "tail_surface_dsm": round(p.get("weir.tail_flight_el", p.get("flood.ref_tail_el")) + off, 2),
         "basin_floor": round(basin + off, 2),
         "pit": round(basin - 1.0 + off, 2),
         "sills_el": {"fg1_5": p["weir.sill_fg1_5_el"], "fg6_7": p["weir.sill_fg6_7_el"],
                      "sluice": p["weir.sill_sluice_el"]},
         "axis": (w["axis"]["lon"]["v"], w["axis"]["lat"]["v"]),
         "west_end": w["axis"]["west_end"]["v"], "east_end": w["axis"]["east_end"]["v"],
         # weir model footprint (lane b08 STATUS, confirmed by building the model in node): x along the axis
         # west->east, z positive upstream (south)
         "fp": {"x0": -107.75, "x1": 107.75, "zUp": 23.5, "zDown": -58.0}}
    return L


def grid():
    import rasterio
    from rasterio.warp import transform_bounds
    w, s, e, n = transform_bounds("EPSG:4326", CRS, *FINE, densify_pts=41)
    w, s = math.floor(w / CELL) * CELL, math.floor(s / CELL) * CELL
    e, n = math.ceil(e / CELL) * CELL, math.ceil(n / CELL) * CELL
    nx, ny = int(round((e - w) / CELL)), int(round((n - s) / CELL))
    return rasterio.Affine(CELL, 0, w, 0, -CELL, n), nx, ny


def upsample():
    import rasterio
    from rasterio.warp import Resampling, reproject
    tr, nx, ny = grid()
    dst = np.full((ny, nx), np.nan, "float32")
    with rasterio.open(DEM_FINE) as src:
        reproject(rasterio.band(src, 1), dst, dst_transform=tr, dst_crs=CRS, resampling=Resampling.bilinear,
                  src_nodata=np.nan, dst_nodata=np.nan, num_threads=1)
    return dst, tr


def centreline():
    from pyproj import Transformer
    from shapely.geometry import Point, box, shape
    from shapely.ops import linemerge
    v = json.load(open(f"{FEAT}/rivers.geojson"))
    segs = [shape(f["geometry"]) for f in v["features"] if f["properties"].get("name") == "Sungai Komering"]
    fine = box(*FINE)
    m = linemerge([s for s in segs if s.intersects(fine)])
    L = levels()
    ax = Point(L["axis"])
    line = min(getattr(m, "geoms", [m]), key=lambda g: g.distance(ax))
    t = Transformer.from_crs(4326, CRS, always_xy=True)
    xy = np.array([t.transform(*c) for c in line.coords])
    seg = np.hypot(*np.diff(xy, axis=0).T)
    cum = np.concatenate([[0], np.cumsum(seg)])
    # densify every 5 m
    ss = np.arange(0, cum[-1], 5.0)
    px = np.interp(ss, cum, xy[:, 0]); py = np.interp(ss, cum, xy[:, 1])
    axy = t.transform(*L["axis"])
    i0 = int(np.argmin(np.hypot(px - axy[0], py - axy[1])))
    ch = ss - ss[i0]
    # the OSM line runs downstream (south to north here): check, flip if needed
    if py[min(i0 + 200, len(py) - 1)] < py[i0]:
        ch = -ch
    return px, py, ch, axy


def river_mask(tr, shape_):
    from rasterio.features import rasterize
    from shapely.geometry import shape
    from shapely.ops import transform as stransform
    from pyproj import Transformer
    rp = json.load(open(f"{FEAT}/river_poly.geojson"))
    t = Transformer.from_crs(4326, CRS, always_xy=True)
    polys = [shape(f["geometry"]) for f in rp["features"] if f["properties"].get("kind") == "river"]
    pu = [stransform(t.transform, p) for p in polys]
    return rasterize([(p, 1) for p in pu], out_shape=shape_, transform=tr, dtype="uint8").astype(bool), polys


def nearest(q, px, py, bb):
    """nearest centreline point (all line points inside the window, any chainage), chunked brute force"""
    k = (px > bb[0] - 700) & (px < bb[1] + 700) & (py > bb[2] - 700) & (py < bb[3] + 700)
    ki = np.where(k)[0]; P = np.c_[px[k], py[k]]
    dist = np.empty(len(q)); near = np.empty(len(q), int)
    for i in range(0, len(q), 2000):
        d2 = ((q[i:i + 2000, None, :] - P[None, :, :]) ** 2).sum(-1)
        j = d2.argmin(1); dist[i:i + 2000] = np.sqrt(d2[np.arange(len(j)), j]); near[i:i + 2000] = ki[j]
    return dist, near


def edge_distance(mask, rmax):
    """distance in cells from each True cell to the nearest False cell, exact up to rmax cells (capped there)"""
    H, W = mask.shape
    out = np.full(mask.shape, float(rmax))
    pad = np.pad(mask, rmax, constant_values=False)
    offs = sorted({(dy, dx) for dy in range(-rmax, rmax + 1) for dx in range(-rmax, rmax + 1)
                   if 0 < dy * dy + dx * dx <= rmax * rmax}, key=lambda o: o[0] ** 2 + o[1] ** 2)
    for dy, dx in offs:
        outside = ~pad[rmax + dy:rmax + dy + H, rmax + dx:rmax + dx + W]
        np.minimum(out, np.where(outside, math.hypot(dy, dx), rmax), out=out)
    return np.where(mask, out, 0.0)


def step_carve():
    import rasterio
    L = levels()
    dem, tr = upsample()
    ny, nx = dem.shape
    px, py, ch, axy = centreline()
    # work window: centreline within reach + ramp + 1.5 km
    sel = np.abs(ch) <= REACH_M + 1500
    x0w, x1w = px[sel].min() - 1500, px[sel].max() + 1500
    y0w, y1w = py[sel].min() - 1500, py[sel].max() + 1500
    c0 = max(0, int((x0w - tr.c) / CELL)); c1 = min(nx, int((x1w - tr.c) / CELL) + 1)
    r0 = max(0, int((tr.f - y1w) / CELL)); r1 = min(ny, int((tr.f - y0w) / CELL) + 1)
    trw = rasterio.Affine(CELL, 0, tr.c + c0 * CELL, 0, -CELL, tr.f - r0 * CELL)
    sub = dem[r0:r1, c0:c1].astype("float64")
    inr, _ = river_mask(trw, sub.shape)
    H, Wd = sub.shape
    xs = trw.c + (np.arange(Wd) + 0.5) * CELL
    ys = trw.f - (np.arange(H) + 0.5) * CELL
    X, Y = np.meshgrid(xs, ys)
    idx = np.where(inr.ravel())[0]
    dist, near = nearest(np.c_[X.ravel()[idx], Y.ravel()[idx]], px, py, (xs[0], xs[-1], ys[-1], ys[0]))
    S = np.full(sub.size, np.nan); S[idx] = np.where(dist < 600, ch[near], np.nan)
    S = S.reshape(sub.shape)
    E, N = X - axy[0], Y - axy[1]          # metres east / north of the axis centre
    # side of the axis: near the weir use the axis line itself (north = downstream), else the chainage
    near_ax = np.hypot(E, N) < 400
    down = np.where(near_ax, N > 0, S > 0)
    reach = inr & np.isfinite(S) & (np.abs(S) <= REACH_M)
    dedge = edge_distance(inr, 12) * CELL - CELL / 2   # metres from the outline's edge (edge cell ~2.5 m)
    # present water surface along the river: low 10th percentile per 100 m bin, made monotonic downstream
    bins = np.arange(-REACH_M - 100, REACH_M + 101, 100.0)
    surf = np.full(len(bins) - 1, np.nan)
    core = reach & (dedge > 15)
    for i in range(len(bins) - 1):
        m = core & (S >= bins[i]) & (S < bins[i + 1])
        if m.sum() > 20:
            surf[i] = np.percentile(sub[m], 10)
    mid = (bins[:-1] + bins[1:]) / 2
    ok = np.isfinite(surf)
    surf = np.interp(mid, mid[ok], surf[ok])
    surf = np.minimum.accumulate(surf)        # water never rises going downstream
    depth_up = L["pond_surface_dsm"] - L["bed_up"]
    depth_dn = L["tail_surface_dsm"] - L["bed_down"]
    Sc = np.where(np.isfinite(S), S, 0.0)
    s_here = np.interp(Sc, mid, surf)
    bed = np.where(down, np.minimum(L["bed_down"], s_here - depth_dn), np.minimum(L["bed_up"], s_here - depth_up))
    target = np.maximum(bed, sub - BANK * np.maximum(dedge, 0))
    f = np.clip((REACH_M - np.abs(Sc)) / RAMP_M, 0, 1)
    carved = np.where(reach, sub - f * np.maximum(sub - target, 0), sub)
    # weir footprint + 10 m: 1 m below the model's lowest floor (stilling basin floor)
    fp = L["fp"]
    xm, zm = E, -N                                  # model frame: x east, z south (UTM grid convergence 0.05 deg)
    inrect = (xm >= fp["x0"] - PAD) & (xm <= fp["x1"] + PAD) & (zm <= fp["zUp"] + PAD) & (zm >= fp["zDown"] - PAD)
    carved = np.where(inrect, np.minimum(carved, L["pit"]), carved)
    # inside the river outline, slope 1:2 up from the pit so there is no wall under the water
    dx = np.maximum(np.maximum(fp["x0"] - PAD - xm, xm - fp["x1"] - PAD), 0)
    dz = np.maximum(np.maximum(fp["zDown"] - PAD - zm, zm - fp["zUp"] - PAD), 0)
    drect = np.hypot(dx, dz)
    apron = inr & (drect > 0) & (drect < 60)
    carved = np.where(apron, np.minimum(carved, L["pit"] + BANK * drect), carved)
    carved = np.minimum(carved, sub)               # never raise a cell
    out = dem.copy()
    out[r0:r1, c0:c1] = carved.astype("float32")
    prof = dict(driver="GTiff", height=ny, width=nx, count=1, dtype="float32", crs=CRS, transform=tr, nodata=np.nan,
                compress="deflate", predictor=3, tiled=True, blockxsize=512, blockysize=512)
    with rasterio.open(guard(CARVED), "w", **prof) as d:
        d.write(out, 1)
        d.update_tags(source="Copernicus GLO-30 fine box (BASE/geo/dem_fine.tif) up-sampled bilinear to 5 m UTM 48S, "
                      "then river bed carved by lane g07", vertical="m above EGM2008 (terrain metres = project EL + "
                      f"{L['offset']})", note=NOTE, credit=CREDIT_DEM + " " + CREDIT_RIV)
    np.savez_compressed(guard(f"{LANE}/work.npz"), r0=r0, r1=r1, c0=c0, c1=c1, S=S.astype("float32"),
                        down=down, inr=inr, reach=reach, inrect=inrect, mid=mid, surf=surf)
    dlt = carved - sub
    print("grid", nx, ny, "window", r0, r1, c0, c1, "carved cells", int((dlt < -0.01).sum()),
          f"area {int((dlt < -0.01).sum()) * 25 / 1e4:.1f} ha", "max cut", round(-dlt.min(), 2))
    print("levels", {k: L[k] for k in ("bed_up", "bed_down", "pond_surface_dsm", "tail_surface_dsm", "pit")},
          "depth up/down", round(depth_up, 2), round(depth_dn, 2))
    print("surface profile (chainage m: m)", [(int(m), round(float(s), 2)) for m, s in zip(mid[::5], surf[::5])])
    print("min carved in reach", round(float(carved[reach].min()), 2), "pit cells", int(inrect.sum()))
    write_carve_json(L, trw, S, down, reach, inr, mid, surf)


def write_carve_json(L, trw, S, down, reach, inr, mid, surf):
    from pyproj import Transformer
    from rasterio.features import shapes
    from shapely.geometry import mapping, shape
    from shapely.ops import transform as stransform, unary_union
    _, polys = river_mask(trw, S.shape)
    river = unary_union(polys)
    t = Transformer.from_crs(CRS, 4326, always_xy=True)
    out = {}
    for name, m in (("pond", reach & ~down), ("tail", reach & down)):
        geoms = [shape(g).buffer(CELL * 0.75) for g, v in shapes(m.astype("uint8"), mask=m, transform=trw) if v == 1]
        g = stransform(t.transform, unary_union(geoms).buffer(-CELL * 0.75))
        g = g.intersection(river).buffer(0).simplify(0.00002, preserve_topology=True)
        g = g.buffer(0)
        geo = mapping(g)

        def rnd(c):
            if isinstance(c[0], (float, int)):
                return [round(c[0], 6), round(c[1], 6)]
            return [rnd(x) for x in c]
        out[name] = {"type": geo["type"], "coordinates": rnd(json.loads(json.dumps(geo["coordinates"])))}
        print(name, geo["type"], f"{g.area * 111320 * 110574 / 1e4:.1f} ha (approx)")
    cj = {"reach": {"upstream_km": REACH_M / 1000, "downstream_km": REACH_M / 1000,
                    "ramp_m": RAMP_M, "measured": "along the OpenStreetMap Sungai Komering line from the weir axis"},
          "levels_model_m": {"bed_up": L["bed_up"], "bed_down": L["bed_down"],
                             "pond_surface_dsm": L["pond_surface_dsm"], "tail_surface_dsm": L["tail_surface_dsm"],
                             "weir_pit": L["pit"]},
          "levels_source": {
              "bed_up": f"params weir.riverbed_el {L['bed_up'] - L['offset']:.2f} EL + datum.offset_m {L['offset']}",
              "bed_down": f"params weir.tail_bed_el {L['bed_down'] - L['offset']:.2f} EL + offset",
              "pond_surface_dsm": "params weir.pond_normal_el 79.70 EL + offset (surface model's pond surface near the axis)",
              "tail_surface_dsm": "params flood.ref_tail_el 78.20 EL + offset (surface model's tail surface just below the axis)",
              "weir_pit": "stilling basin floor EL 73.00 (weir.json, assumed) - 1 m + offset; under the weir model footprint + 10 m"},
          "surface_dsm_profile": {"note": ("water surface in the surface model along the reach (10th percentile per "
                                           "100 m of river, never rising downstream). It is NOT flat: it rises to about "
                                           f"{surf[0]:.1f} m 5 km upstream and falls to about {surf[-1]:.1f} m 5 km "
                                           "downstream. Where the flat bed would sit above it, the bed follows it at the "
                                           "axis depth instead (never raised)."),
                                  "chainage_m": [int(m) for m in mid[::2]],
                                  "surface_m": [round(float(s), 2) for s in surf[::2]]},
          "polygons": out,
          "axis": {"a": [round(L["west_end"][0], 6), round(L["west_end"][1], 6)],
                   "b": [round(L["east_end"][0], 6), round(L["east_end"][1], 6)]},
          "credits": [CREDIT_DEM, CREDIT_RIV],
          "note": ("Model metres = terrain metres (GLO-30, m above EGM2008) = project EL + datum.offset_m "
                   f"({L['offset']}). The river bed is ASSUMED: the surface model records the river at its water "
                   "surface and has no bed; the bed levels come from the design levels in params.json. Banks slope "
                   "1:2 from the outline's edge; 500 m ramps at both ends. pond = carved outline above (south of) the "
                   "axis, tail = below (north). Not a survey.")}
    with open(guard(f"{FEAT}/carve.json"), "w") as f:
        json.dump(cj, f, separators=(",", ":"))
    print("carve.json", os.path.getsize(f"{FEAT}/carve.json"), "bytes")


# ---------- tiles ----------
R_ = 6378137.0
HALF = math.pi * R_


def lon2x(lon, z):
    return (lon + 180.0) / 360.0 * 2 ** z


def lat2y(lat, z):
    r = math.radians(lat)
    return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z


def tile_range(box, z):
    w, s, e, n = box
    return (int(math.floor(lon2x(w, z))), int(math.floor(lon2x(e, z) - 1e-9)),
            int(math.floor(lat2y(n, z))), int(math.floor(lat2y(s, z) - 1e-9)))


def merc_grid(z, box):
    import rasterio
    x0, x1, y0, y1 = tile_range(box, z)
    res = 2 * HALF / (256 * 2 ** z)
    return x0, y0, x1 - x0 + 1, y1 - y0 + 1, rasterio.Affine(res, 0, -HALF + x0 * 256 * res, 0, -res, HALF - y0 * 256 * res)


def render(z, box, arr, src_tr, src_crs, resampling):
    from rasterio.warp import reproject
    x0, y0, nx, ny, t = merc_grid(z, box)
    dst = np.zeros((ny * 256, nx * 256), "float32")
    reproject(arr, dst, src_transform=src_tr, src_crs=src_crs, dst_transform=t, dst_crs="EPSG:3857",
              resampling=resampling, src_nodata=None, dst_nodata=None, num_threads=1)
    return x0, y0, nx, ny, dst


def encode(h):
    h = np.where(np.isfinite(h), h, 0.0)
    v = np.round((h.astype("float64") + 32768.0) * 4.0) / 4.0
    r = np.floor(v / 256.0)
    g = np.floor(v - r * 256.0)
    b = np.round((v - r * 256.0 - g) * 256.0)
    return np.dstack([r, g, b]).astype("uint8")


def decode(im):
    im = im.astype("float64")
    return im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768


def step_tiles():
    import rasterio
    from PIL import Image
    from rasterio.warp import Resampling
    wk = np.load(f"{LANE}/work.npz")
    r0, r1, c0, c1 = int(wk["r0"]), int(wk["r1"]), int(wk["c0"]), int(wk["c1"])
    orig, tr = upsample()
    with rasterio.open(CARVED) as d:
        car = d.read(1, window=((r0, r1), (c0, c1)))
    delta = (car - orig[r0:r1, c0:c1]).astype("float32")
    delta[~np.isfinite(delta)] = 0
    trw = rasterio.Affine(CELL, 0, tr.c + c0 * CELL, 0, -CELL, tr.f - r0 * CELL)
    del orig
    stats = {}
    # z10-13: base = the existing g01 tile (same GLO-30 bilinear render), plus the carved difference averaged
    # over each pixel; only tiles whose quantised heights change are rewritten
    for z in (10, 11, 12, 13):
        x0, y0, nx, ny, dz = render(z, FINE, delta, trw, CRS, Resampling.average)
        n, size = 0, 0
        for i in range(nx):
            for j in range(ny):
                d = dz[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256]
                if d.min() > -0.125:
                    continue
                p = f"{TILES}/{z}/{x0 + i}/{y0 + j}.png"
                bk = f"{LANE}/backup/{z}/{x0 + i}/{y0 + j}.png"
                h = decode(np.asarray(Image.open(bk).convert("RGB")))
                new = encode(np.minimum(h, h + d))
                Image.fromarray(new).save(guard(p), optimize=True)
                n += 1; size += os.path.getsize(p)
        stats[z] = (n, size)
        print("z", z, "rewritten", n, "bytes", size)
    # z14: whole fine box, GLO-30 bilinear exactly as g01 renders, plus the carved difference
    with rasterio.open(MOSAIC) as src:
        from rasterio.warp import reproject
        x0, y0, nx, ny, t = merc_grid(14, FINE)
        base = np.full((ny * 256, nx * 256), np.nan, "float32")
        reproject(rasterio.band(src, 1), base, dst_transform=t, dst_crs="EPSG:3857", resampling=Resampling.bilinear,
                  src_nodata=np.nan, dst_nodata=np.nan, num_threads=1)
    _, _, _, _, dz = render(14, FINE, delta, trw, CRS, Resampling.average)
    rgb = encode(np.minimum(base, base + dz))
    n, size = 0, 0
    for i in range(nx):
        d = guard(f"{TILES}/14/{x0 + i}")
        os.makedirs(d, exist_ok=True)
        for j in range(ny):
            p = f"{d}/{y0 + j}.png"
            Image.fromarray(rgb[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256]).save(p, optimize=True)
            n += 1; size += os.path.getsize(p)
    stats[14] = (n, size)
    print("z 14 tiles", n, "bytes", size, "x", x0, x0 + nx - 1, "y", y0, y0 + ny - 1)
    tj = json.load(open(f"{TILES}/tiles.json"))
    tj["fine_bounds_z14"] = list(FINE)
    man = {}
    for z in (13, 14):
        a, b, c, d = tile_range(FINE, z)
        man[str(z)] = {"x": [a, b], "y": [c, d]}
    tj["manifest"] = man
    tj["description"] = (
        "Copernicus GLO-30 surface model resampled bilinear to web mercator. Zoom 6-12 over the wide box, zoom 13 and "
        "14 inside the fine box only (manifest gives the tile ranges; MapLibre overzooms elsewhere). Heights m above "
        "EGM2008, quantised to 0.25 m; voids, sea and anything outside 103-105 E, 6-3 S are 0 m. "
        "CARVED RIVER BED (lane g07, 23 Nov 2026): the surface model records Sungai Komering at its water surface, "
        "so from 5 km above to 5 km below Bendung Perjaya (along the river, 500 m ramps at the ends) the terrain "
        "inside the 26 Apr 2026 Sentinel-2 river outline is lowered to an ASSUMED bed: 70.8 m above the axis "
        "(design bed EL 74.0) and 70.95 m below it (EL 74.15, Manning bed for the design flood), or the surface model's water "
        "surface minus the axis depth where that is lower, banks 1:2 from the outline's edge, and 68.8 m (1 m below "
        "the assumed stilling basin floor EL 73.0) under the weir model's footprint + 10 m. Levels from params.json "
        "(terrain m = project EL - 3.2). The bed is assumed, not surveyed. Tile URLs are relative to this file.")
    tj["attribution"] = tj["attribution"] + " River bed below the water surface assumed (not a survey)."
    with open(guard(f"{TILES}/tiles.json"), "w") as f:
        json.dump(tj, f, indent=1)
    json.dump({str(k): v for k, v in stats.items()}, open(guard(f"{LANE}/tile_stats.json"), "w"))


def step_check():
    import rasterio
    from PIL import Image
    from pyproj import Transformer
    src = rasterio.open(CARVED); a = src.read(1)
    t = Transformer.from_crs(4326, CRS, always_xy=True)
    wk = np.load(f"{LANE}/work.npz")
    r0, c0 = int(wk["r0"]), int(wk["c0"])
    reach = wk["reach"]

    def samp(lon, lat):
        x, y = t.transform(lon, lat)
        fc = (x - src.transform.c) / CELL - 0.5; fr = (src.transform.f - y) / CELL - 0.5
        ci, ri = int(math.floor(fc)), int(math.floor(fr)); tc, tr_ = fc - ci, fr - ri
        q = a[ri:ri + 2, ci:ci + 2].astype("float64")
        inreach = bool(reach[min(max(ri - r0, 0), reach.shape[0] - 1), min(max(ci - c0, 0), reach.shape[1] - 1)])
        return (q[0, 0] * (1 - tc) * (1 - tr_) + q[0, 1] * tc * (1 - tr_) + q[1, 0] * (1 - tc) * tr_ + q[1, 1] * tc * tr_), inreach
    L = levels()
    rng = np.random.default_rng(7)
    rows = []
    for z in (12, 13, 14):
        # tiles over the weir and the carved reach
        tx, ty = int(lon2x(L["axis"][0], z)), int(lat2y(L["axis"][1], z))
        for (x, y) in {(tx, ty), (tx + 1, ty), (tx, ty - 1), (tx - 1, ty + 1)}:
            p = f"{TILES}/{z}/{x}/{y}.png"
            if not os.path.exists(p):
                continue
            h = decode(np.asarray(Image.open(p).convert("RGB")))
            for py_ in range(4, 256, 9):
                for px_ in range(4, 256, 9):
                    mx = (x * 256 + px_ + 0.5) / (256 * 2 ** z); my = (y * 256 + py_ + 0.5) / (256 * 2 ** z)
                    lon = mx * 360 - 180; lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * my))))
                    ref, inr = samp(lon, lat)
                    rows.append((abs(h[py_, px_] - ref), z, inr, x, y, round(lon, 5), round(lat, 5), round(h[py_, px_], 2), round(ref, 2)))
    for z in (12, 13, 14):
        for flag in (True, False):
            d = np.array([r[0] for r in rows if r[1] == z and r[2] == flag])
            if len(d):
                print(f"z{z} {'in reach' if flag else 'outside '} n {len(d)} max {d.max():.2f} median {np.median(d):.3f} p95 {np.percentile(d, 95):.2f}")
    rows.sort(reverse=True)
    for r in rows[:4]:
        print("worst", r)
    # edges: rewritten z13 tile vs untouched/rewritten neighbours, and z14 neighbours
    for z in (13, 14):
        tx, ty = int(lon2x(L["axis"][0], z)), int(lat2y(L["axis"][1], z))
        A = decode(np.asarray(Image.open(f"{TILES}/{z}/{tx}/{ty}.png").convert("RGB")))
        B = decode(np.asarray(Image.open(f"{TILES}/{z}/{tx + 1}/{ty}.png").convert("RGB")))
        C = decode(np.asarray(Image.open(f"{TILES}/{z}/{tx}/{ty + 1}.png").convert("RGB")))
        print(f"z{z} edge E: mean step {np.abs(A[:, -1] - B[:, 0]).mean():.2f} m (inside {np.abs(A[:, -2] - A[:, -1]).mean():.2f}); "
              f"edge S: {np.abs(A[-1] - C[0]).mean():.2f} m (inside {np.abs(A[-2] - A[-1]).mean():.2f})")
    # zoom 13 untouched tiles byte-identical with the backup
    import filecmp
    same = diff = 0
    for root, _, files in os.walk(f"{LANE}/backup"):
        for fn in files:
            if fn.endswith(".png"):
                b = os.path.join(root, fn); p = b.replace(f"{LANE}/backup", TILES)
                if filecmp.cmp(b, p, shallow=False):
                    same += 1
                else:
                    diff += 1
    print("z10-13 tiles identical", same, "changed", diff)


def step_shots():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import rasterio
    from matplotlib.colors import LightSource
    from pyproj import Transformer
    L = levels()
    orig, tr = upsample()
    car = rasterio.open(CARVED).read(1)
    t = Transformer.from_crs(4326, CRS, always_xy=True)
    ax_, ay_ = t.transform(*L["axis"])
    # hillshade window: 6 km x 6.5 km round the reach near the weir
    def win(cx, cy, hw, hh):
        c0 = int((cx - hw - tr.c) / CELL); c1 = int((cx + hw - tr.c) / CELL)
        r0 = int((tr.f - (cy + hh)) / CELL); r1 = int((tr.f - (cy - hh)) / CELL)
        return r0, r1, c0, c1
    foot = "\n".join([NOTE, CREDIT_DEM, CREDIT_RIV, "lane g07, 23 Nov 2026"])
    for tag, (hw, hh, cx, cy) in (("reach", (3500, 4000, ax_ + 500, ay_ + 500)), ("weir", (700, 700, ax_, ay_))):
        r0, r1, c0, c1 = win(cx, cy, hw, hh)
        fig, axs = plt.subplots(1, 2, figsize=(16, 9.6), dpi=100)
        fig.subplots_adjust(left=0.04, right=0.98, top=0.93, bottom=0.17, wspace=0.08)
        ls = LightSource(azdeg=315, altdeg=40)
        for axp, arr, title in ((axs[0], orig, "before: surface model (river at its water surface)"),
                                (axs[1], car, "after: river bed carved (ASSUMED bed)")):
            s = arr[r0:r1, c0:c1].astype("float64")
            rgb = ls.shade(s, cmap=plt.cm.terrain, vert_exag=3, dx=CELL, dy=CELL, blend_mode="soft", vmin=60, vmax=110)
            ext = [(c0 * CELL + tr.c - ax_), (c1 * CELL + tr.c - ax_), (tr.f - r1 * CELL - ay_), (tr.f - r0 * CELL - ay_)]
            axp.imshow(rgb, extent=ext)
            cs = axp.contour(np.linspace(ext[0], ext[1], s.shape[1]), np.linspace(ext[3], ext[2], s.shape[0]), s,
                             levels=[70, 72, 74, 76.5], colors=["#003", "#036", "#06a", "#39f"], linewidths=0.6)
            axp.clabel(cs, fontsize=7, fmt="%.1f")
            axp.plot([-108, 108], [0, 0], color="red", lw=1.5)
            axp.set_title(title, fontsize=12)
            axp.set_xlabel("m east of the weir axis centre"); axp.set_ylabel("m north (river flows north)")
        fig.suptitle(f"Bendung Perjaya reach: terrain before and after carving ({'10 km reach' if tag == 'reach' else 'weir close-up'}); red = weir axis 217 m",
                     fontsize=13)
        fig.text(0.04, 0.02, foot, fontsize=9, va="bottom")
        out = guard(f"{SHOTS}/g07-hillshade-{tag}.png")
        fig.savefig(out); plt.close(fig); print(out)
    # cross-section 200 m above (south of) the axis
    yy = ay_ - 200
    r = int((tr.f - yy) / CELL)
    c0 = int((ax_ - 500 - tr.c) / CELL); c1 = int((ax_ + 500 - tr.c) / CELL)
    xs = tr.c + (np.arange(c0, c1) + 0.5) * CELL - ax_
    fig = plt.figure(figsize=(14, 7.4), dpi=100)
    axp = fig.add_axes([0.07, 0.30, 0.9, 0.62])
    axp.plot(xs, orig[r, c0:c1], color="#8a6", lw=2, label="before: surface model")
    axp.plot(xs, car[r, c0:c1], color="#642", lw=2, label="after: carved (ASSUMED bed)")
    axp.axhline(L["pond_surface_dsm"], color="#29f", ls="--", lw=1.5, label=f"normal pond EL 79.70 = {L['pond_surface_dsm']} m")
    axp.axhline(L["bed_up"], color="#888", ls=":", lw=1, label=f"assumed bed EL 74.00 = {L['bed_up']} m")
    axp.set_xlabel("m east of the weir axis centre (west bank left)"); axp.set_ylabel("terrain m (EGM2008) = EL - 3.2")
    axp.set_ylim(66, 100); axp.grid(alpha=0.3); axp.legend(loc="upper right", fontsize=9)
    axp.set_title("Cross-section 200 m upstream (south) of the weir axis, before and after carving", fontsize=12)
    fig.text(0.07, 0.03, foot, fontsize=9, va="bottom")
    out = guard(f"{SHOTS}/g07-section-200m-up.png")
    fig.savefig(out); plt.close(fig); print(out)


if __name__ == "__main__":
    {"carve": step_carve, "tiles": step_tiles, "check": step_check, "shots": step_shots}[sys.argv[1]]()
