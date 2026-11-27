"""g02: outlets, catchments, HAND, streams, profile and browser packs from out/wide.npz and out/fine.npz.
Writes only to the paths lane g02 owns."""
import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import json, os, sys
import numpy as np
if not hasattr(np, 'in1d'):
    np.in1d = np.isin
import rasterio
from rasterio.features import shapes
from shapely.geometry import shape, mapping, LineString, Point
from shapely.ops import unary_union
from pyproj import Geod
from pysheds.grid import Grid
from pysheds.sview import Raster, ViewFinder
import pyproj

L = WORK + '/lanes/g02'
REPO = REPO + '/site/data'
ALLOWED = [L + '/', WORK + '/geo/hydro/'] + \
          [f'{REPO}/grid/{g}.{e}' for g in ('wide', 'fine') for e in ('json', 'dem.i16', 'dir.u8', 'acc.f32', 'hand.i16')] + \
          [f'{REPO}/feat/{n}' for n in ('catchments.geojson', 'streams.geojson', 'profile.json')]


def guard(p):
    p = os.path.abspath(p)
    assert any(p == a or (a.endswith('/') and p.startswith(a)) for a in ALLOWED), p
    return p


geod = Geod(ellps='WGS84')
DIRMAP = (64, 128, 1, 2, 4, 8, 16, 32)
OFF = {64: (-1, 0), 128: (-1, 1), 1: (0, 1), 2: (1, 1), 4: (1, 0), 8: (1, -1), 16: (0, -1), 32: (-1, -1)}
G = {k: dict(np.load(f'{L}/out/{k}.npz')) for k in ('wide', 'fine')}
for k, z in G.items():
    z['T'] = rasterio.Affine(*z['transform'][:6])


def pgrid(z):
    vf = ViewFinder(affine=z['T'], shape=z['dir'].shape, crs=pyproj.Proj('EPSG:4326'), nodata=0)
    return Grid(viewfinder=vf), (lambda a, nd: Raster(a, viewfinder=ViewFinder(affine=z['T'], shape=a.shape, crs=vf.crs, nodata=nd)))


def rc(z, x, y):
    c, r = ~z['T'] * (x, y)
    return int(r), int(c)


def xy(z, r, c):
    return z['T'] * (c + 0.5, r + 0.5)


def snap(z, x, y, rad_m):
    r, c = rc(z, x, y)
    cs_m = abs(z['T'].a) * 111320 * np.cos(np.radians(y))
    k = max(1, int(round(rad_m / cs_m)))
    w = z['acc'][r - k:r + k + 1, c - k:c + k + 1]
    i = np.unravel_index(np.argmax(w), w.shape)
    return r - k + i[0], c - k + i[1]


def down(z, r, c):
    d = int(z['dir'][r, c])
    if d == 0:
        return None
    dr, dc = OFF[d]
    r2, c2 = r + dr, c + dc
    if not (0 <= r2 < z['dir'].shape[0] and 0 <= c2 < z['dir'].shape[1]):
        return None
    return r2, c2


W, F = G['wide'], G['fine']
pts = {}
# weir: Overture infrastructure feature "Bendung Perjaya" (waterway=weir), line 104.38003..104.38198, -4.30513..-4.30510
WEIR = (104.381008, -4.305116)
pts['weir'] = WEIR
pts['muaradua'] = (104.07, -4.53)
pts['tiga_dihaji'] = (103.87687, -4.62893)  # r06 note, from BBWS data via [KUR22]

# Danau Ranau outlet on WIDE: lake cell exit with the largest upstream area
lake = W['lake']
lr, lc = np.nonzero(lake)
best = None
for r, c in zip(lr, lc):
    n = down(W, r, c)
    if n and not lake[n]:
        if best is None or W['acc'][n] > W['acc'][best]:
            best = n
ranau_out = best
pts['ranau_outlet'] = tuple(float(v) for v in xy(W, *best))

out = {}
for k, z in (('wide', W), ('fine', F)):
    o = {}
    # weir cell: the cell nearest the Overture weir line among cells within 300 m holding >= 95 % of the local max upstream area
    r0, c0 = rc(z, *WEIR)
    kk = int(np.ceil(300 / (abs(z['T'].a) * 111320)))
    win = z['acc'][r0 - kk:r0 + kk + 1, c0 - kk:c0 + kk + 1]
    cand = np.argwhere(win >= 0.95 * win.max())
    xs = [xy(z, r0 - kk + a, c0 - kk + b) for a, b in cand]
    i = int(np.argmin([np.hypot((x - WEIR[0]) * np.cos(np.radians(4.3)), y - WEIR[1]) for x, y in xs]))
    r, c = r0 - kk + cand[i][0], c0 - kk + cand[i][1]
    o['weir'] = (int(r), int(c))
    if k == 'wide':
        o['ranau_outlet'] = ranau_out
        o['muaradua'] = snap(z, *pts['muaradua'], 1000)
        o['tiga_dihaji'] = snap(z, *pts['tiga_dihaji'], 500)
    out[k] = o

# catchments on WIDE
grid, R = pgrid(W)
fdr = R(W['dir'].astype(np.int64), 0)
feats = []
catch = {}
names = {'weir': 'Bendung Perjaya (weir)', 'ranau_outlet': 'Danau Ranau outlet', 'muaradua': 'Muaradua (Komering below the Selabung-Saka confluence)',
         'tiga_dihaji': 'Tiga Dihaji dam site (r06 point)'}
cellkm = np.repeat(W['cell_km2'][:, None], W['dir'].shape[1], axis=1)
for key, (r, c) in out['wide'].items():
    m = np.asarray(grid.catchment(x=c, y=r, fdir=fdr, xytype='index', dirmap=DIRMAP)).astype(bool)
    a = float(cellkm[m].sum())
    edge = bool(m[0].any() or m[-1].any() or m[:, 0].any() or m[:, -1].any())
    polys = [shape(g) for g, v in shapes(m.astype(np.uint8), mask=m, transform=W['T']) if v == 1]
    poly = max(polys, key=lambda p: p.area).simplify(0.0006, preserve_topology=True)
    x, y = xy(W, r, c)
    catch[key] = dict(area_km2=round(a, 1), acc_km2=round(float(W['acc'][r, c]), 1), touches_box_edge=edge,
                      lon=round(x, 5), lat=round(y, 5), col=int(c), row=int(r), parts=len(polys), mask=m)
    feats.append({"type": "Feature", "properties": {"name": names[key], "key": key, "area_km2": round(a, 1),
                  "outlet_lon": round(x, 5), "outlet_lat": round(y, 5), "grid": "wide 3 arc-second",
                  "status": "computed from Copernicus GLO-30 (not a survey)"},
                  "geometry": json.loads(json.dumps(mapping(poly)))})
    print(key, catch[key]['area_km2'], 'acc', catch[key]['acc_km2'], 'edge', edge, 'parts', len(polys), x, y)
for f in feats:
    f['geometry']['coordinates'] = json.loads(json.dumps(f['geometry']['coordinates'], default=float),
                                              parse_float=lambda s: round(float(s), 5))
fc = {"type": "FeatureCollection", "name": "catchments",
      "credits": "Copernicus GLO-30 DEM (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA; rivers (c) OpenStreetMap contributors via Overture Maps 2026-11-18.0 (ODbL)",
      "note": "Computed from a 30 m surface model resampled to 3 arc-seconds; not a survey.", "features": feats}
json.dump(fc, open(guard(f'{REPO}/feat/catchments.geojson'), 'w'), separators=(',', ':'))

# HAND
hand = {}
for k, z, thr in (('wide', W, 200.0), ('fine', F, 50.0)):
    if 'full_dir' in z:  # FINE: HAND on the conditioned domain with its 0.06 deg margin, then cropped
        zz = {'T': rasterio.Affine(*z['full_T'][:6]), 'dir': z['full_dir']}
        dd, da, de = z['full_dir'], z['full_acc'], z['full_dem']
    else:
        zz, dd, da, de = z, z['dir'], z['acc'], z['dem']
    g2, R2 = pgrid(zz)
    fd = R2(dd.astype(np.int64), 0)
    dem = R2(de.astype(np.float64), np.nan)
    mask = R2(da > thr, False)
    h = np.asarray(g2.compute_hand(fd, dem, mask, dirmap=DIRMAP, nodata_out=np.nan)).astype(np.float64)
    if 'full_dir' in z:
        m = (dd.shape[0] - z['dir'].shape[0]) // 2
        h = h[m:m + z['dir'].shape[0], m:m + z['dir'].shape[1]]
    h[h < 0] = 0
    if k == 'wide':
        h[z['sea']] = np.nan
    hand[k] = h
    print('hand', k, 'nan share', round(float(np.isnan(h).mean()), 4), 'p50', round(float(np.nanmedian(h)), 1))

# streams on WIDE: acc > 25 km2
z = W
S = z['acc'] > 25
rows, cols = S.shape
indeg = np.zeros(S.shape, np.int16)
dn = {}
sr, sc = np.nonzero(S)
for r, c in zip(sr, sc):
    n = down(z, r, c)
    if n and S[n]:
        indeg[n] += 1
heads = [(r, c) for r, c in zip(sr, sc) if indeg[r, c] != 1]
lines = []
for r, c in heads:
    path = [(r, c)]
    cur = (r, c)
    while True:
        n = down(z, *cur)
        if n is None or not S[n]:
            break
        path.append(n)
        if indeg[n] != 1:
            break
        cur = n
    if len(path) < 2:
        continue
    km2 = float(z['acc'][path[-2] if indeg[path[-1]] != 1 and len(path) > 1 else path[-1]])
    coords = [tuple(round(v, 5) for v in xy(z, *p)) for p in path]
    ls = LineString(coords).simplify(0.0004)
    lines.append({"type": "Feature", "properties": {"km2": round(km2, 1)},
                  "geometry": {"type": "LineString", "coordinates": [[round(a, 5), round(b, 5)] for a, b in ls.coords]}})
sfc = {"type": "FeatureCollection", "name": "streams",
       "note": "D8 streams where more than 25 km2 drain, traced on the 3 arc-second grid from Copernicus GLO-30 with mapped lowland rivers burned in; not a survey. km2 = upstream area at the segment's lower end.",
       "credits": fc['credits'], "features": lines}
sp = guard(f'{REPO}/feat/streams.geojson')
json.dump(sfc, open(sp, 'w'), separators=(',', ':'))
print('streams', len(lines), 'MB', round(os.path.getsize(sp) / 1e6, 2))

# long profile: Ranau outlet -> down the WIDE D8 to where it leaves the box
path = [ranau_out]
while True:
    n = down(W, *path[-1])
    if n is None:
        break
    path.append(n)
P = np.array([xy(W, *p) for p in path])
seg = geod.inv(P[:-1, 0], P[:-1, 1], P[1:, 0], P[1:, 1])[2] / 1000
km = np.r_[0, np.cumsum(seg)]
el = np.array([float(W['dem'][p]) for p in path])
env = np.minimum.accumulate(el)
ac = np.array([float(W['acc'][p]) for p in path])
marks = {}
for key in ('weir', 'muaradua'):
    t = tuple(out['wide'][key])
    if t in path:
        marks[key] = round(float(km[path.index(t)]), 2)
    else:
        d = np.hypot(P[:, 0] - xy(W, *t)[0], P[:, 1] - xy(W, *t)[1])
        marks[key + '_nearest'] = round(float(km[int(np.argmin(d))]), 2)
endx, endy = P[-1]
print('profile km', round(km[-1], 1), 'end', endx, endy, 'marks', marks)
prof = {"name": "Komering long profile, Danau Ranau outlet to the edge of the wide box",
        "from": {"lon": round(P[0, 0], 5), "lat": round(P[0, 1], 5), "what": "Danau Ranau outlet (D8 exit of the lake polygon)"},
        "to": {"lon": round(endx, 5), "lat": round(endy, 5), "what": "where the D8 main stem leaves the wide box"},
        "length_km": round(float(km[-1]), 2), "marks_km": marks,
        "columns": ["km", "surface_m", "lower_envelope_m", "lon", "lat", "km2"],
        "note": "surface_m = Copernicus GLO-30 surface (water surface, banks or trees, EGM2008 heights), 3 arc-second average along the D8 path; lower_envelope_m = running minimum downstream, a stand-in for the water surface, not the bed. D8 path length is longer than the real channel by a few per cent. Not a survey.",
        "credits": fc['credits'],
        "rows": [[round(float(a), 3), round(float(b), 1), round(float(e), 1), round(float(x), 5), round(float(y), 5), round(float(q), 1)]
                 for a, b, e, (x, y), q in zip(km, el, env, P, ac)]}
json.dump(prof, open(guard(f'{REPO}/feat/profile.json'), 'w'), separators=(',', ':'))

# packs
CODES = {"0": "no flow (outlet on the box edge, sea)", "1": "E", "2": "SE", "4": "S", "8": "SW", "16": "W", "32": "NW", "64": "N", "128": "NE"}
for k, z in (('wide', W), ('fine', F)):
    b = z['bounds']
    rows, cols = z['dir'].shape
    dem = np.round(z['dem'] * 10)
    dem = np.clip(dem, -32767, 32767).astype('<i2')
    h = hand[k]
    hi = np.where(np.isnan(h), -32768, np.clip(np.round(h * 10), 0, 32767)).astype('<i2')
    if k == 'wide':
        dem[z['sea']] = -32768
    z['dem'].astype(np.float32)
    dem.tofile(guard(f'{REPO}/grid/{k}.dem.i16'))
    z['dir'].astype('u1').tofile(guard(f'{REPO}/grid/{k}.dir.u8'))
    z['acc'].astype('<f4').tofile(guard(f'{REPO}/grid/{k}.acc.f32'))
    hi.tofile(guard(f'{REPO}/grid/{k}.hand.i16'))
    wr, wc = out[k]['weir']
    wx, wy = xy(z, wr, wc)
    meta = {"name": k, "west": round(float(b[0]), 8), "south": round(float(b[1]), 8), "east": round(float(b[2]), 8), "north": round(float(b[3]), 8),
            "cols": int(cols), "rows": int(rows), "cellsize_deg": abs(z['T'].a),
            "pixel_registration": "area: west/north are cell edges; GLO-30 pixel centres sit on whole arc-seconds, so the edges are half an arc-second off the round box",
            "order": "row-major from the north-west corner, little-endian",
            "files": {"dem": f"{k}.dem.i16", "dir": f"{k}.dir.u8", "acc": f"{k}.acc.f32", "hand": f"{k}.hand.i16"},
            "encodings": {"dem": "Int16, surface elevation in decimetres (EGM2008 heights), unconditioned", "dir": "Uint8 D8 code, see dir_codes (flow to that neighbour)",
                          "acc": "Float32, upstream area in km2 including the cell itself, true cell area by latitude (WGS84)" + (
                              "; includes inflow from outside the fine box taken from the wide grid" if k == 'fine' else ''),
                          "hand": f"Int16, height above nearest drainage in decimetres; drainage = cells with more than {200 if k == 'wide' else 50} km2 upstream"},
            "nodata": {"dem": -32768, "hand": -32768, "dir": 0, "acc": "none"},
            "dir_codes": CODES,
            "resampling": "average of 3x3 GLO-30 cells" if k == 'wide' else "GLO-30 cells as delivered (1 arc-second)",
            "conditioning": "pits filled, depressions filled (priority flood), flats resolved (pysheds 0.5); mapped rivers (Overture base/water, subtype river) burned 20 m where the surface is under 120 m, Sungai Komering lines burned under 160 m; Danau Ranau set flat at its median surface" + (
                "; conditioned on a box 0.06 deg larger with walls on its edge except where the wide grid's flow leaves it, then cropped" if k == 'fine' else ''),
            "weir": {"lon": round(wx, 6), "lat": round(wy, 6), "col": int(wc), "row": int(wr), "catchment_km2": round(float(z['acc'][wr, wc]), 1),
                     "feature": {"lon": WEIR[0], "lat": WEIR[1], "source": "Overture 2026-11-18.0 base/infrastructure, class weir, name 'Bendung Perjaya' (OSM-derived)"}},
            "outlets": {},
            "credits": fc['credits'], "note": "Computed from a 30 m surface model, not a survey."}
    for key in ('ranau_outlet', 'muaradua', 'tiga_dihaji'):
        if key in out[k]:
            r, c = out[k][key]
            x, y = xy(z, r, c)
            meta['outlets'][key] = {"lon": round(x, 6), "lat": round(y, 6), "col": int(c), "row": int(r),
                                    "catchment_km2": round(float(z['acc'][r, c]), 1)}
        else:
            x, y = pts[key]
            if b[0] < x < b[2] and b[1] < y < b[3]:
                r, c = snap(z, x, y, 500)
                xx, yy = xy(z, r, c)
                meta['outlets'][key] = {"lon": round(xx, 6), "lat": round(yy, 6), "col": int(c), "row": int(r),
                                        "catchment_km2": round(float(z['acc'][r, c]), 1)}
    json.dump(meta, open(guard(f'{REPO}/grid/{k}.json'), 'w'), indent=1)
    print(k, 'weir', meta['weir'], meta['outlets'])

np.savez_compressed(guard(f'{L}/out/post.npz'), hand_wide=hand['wide'], hand_fine=hand['fine'],
                    **{f'mask_{k}': v['mask'] for k, v in catch.items()}, prof_km=km, prof_el=el, prof_env=env, prof_xy=P,
                    stream_mask=S)
json.dump({k: {kk: vv for kk, vv in v.items() if kk != 'mask'} for k, v in catch.items()} | {'marks': marks, 'pts': pts},
          open(guard(f'{L}/out/summary.json'), 'w'), indent=1)
