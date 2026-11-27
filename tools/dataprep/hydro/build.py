"""g02: build a conditioned hydrology grid (WIDE 3" or FINE 1") from Copernicus GLO-30.
usage: python -I build.py wide|fine
Writes only into BASE/lanes/g02/out/.
"""
import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import json, os, sys, time
import numpy as np
if not hasattr(np, 'in1d'):
    np.in1d = np.isin
import rasterio
from rasterio.merge import merge
from rasterio.transform import from_origin
from rasterio.features import rasterize
from shapely.geometry import shape, box as sbox
from pyproj import Geod

L = WORK + '/lanes/g02'
OUT = L + '/out'


def guard(p):
    p = os.path.abspath(p)
    assert p.startswith(OUT + '/'), p
    return p


which = sys.argv[1]
BOX = json.load(open(WORK + '/geo/box.json'))
H = 1 / 7200.0  # half arc-second: GLO-30 pixel centres sit on whole arc-seconds
if which == 'wide':
    b = BOX; f = 3
else:
    b = BOX['fine']; f = 1
M = 0.06 if which == 'fine' else 0.0  # FINE is conditioned on a box 0.06 deg larger, then cropped
CW0, CS0, CE0, CN0 = b['west'] - H, b['south'] + H, b['east'] - H, b['north'] + H
W0, S0, E0, N0 = CW0 - M, CS0 - M, CE0 + M, CN0 + M
src, st = merge(sorted(__import__('glob').glob(L + '/dl/*.tif')), bounds=(W0, S0, E0, N0), nodata=-9999)
src = src[0].astype(np.float64)
assert (src == -9999).sum() == 0, 'gap in mosaic'
r1, c1 = src.shape
assert r1 % f == 0 and c1 % f == 0, src.shape
dem = src.reshape(r1 // f, f, c1 // f, f).mean(axis=(1, 3))  # average resampling
rows, cols = dem.shape
cs = f / 3600.0
T = from_origin(W0, N0, cs, cs)
print(which, rows, cols, 'cell deg', cs, flush=True)

# true cell area by latitude (WGS84 ellipsoid), km2
g = Geod(ellps='WGS84')
lat_c = N0 - (np.arange(rows) + 0.5) * cs
area = np.array([abs(g.polygon_area_perimeter([0, cs, cs, 0], [la - cs / 2, la - cs / 2, la + cs / 2, la + cs / 2])[0]) / 1e6
                 for la in lat_c])
cell_km2 = np.repeat(area[:, None], cols, axis=1)

# vectors (Overture 2026-11-18.0, OSM-derived)
wat = json.load(open(L + '/ov/water.geojson'))['features']
gbox = sbox(W0, S0, E0, N0)
lake = [shape(x['geometry']) for x in wat if x['properties']['name'] == 'Danau Ranau']
rivers = [shape(x['geometry']) for x in wat
          if x['properties']['subtype'] == 'river' and x['geometry']['type'] == 'LineString']
rivers = [r for r in rivers if r.intersects(gbox)]
kom = [shape(x['geometry']) for x in wat if x['properties']['name'] == 'Sungai Komering'
       and x['geometry']['type'] == 'LineString']

cond = dem.copy()
# sea: cells <= 0 m connected to the box edge
from scipy import ndimage
lab, n = ndimage.label(dem <= 0.5)
edge = set(np.unique(np.r_[lab[0], lab[-1], lab[:, 0], lab[:, -1]])) - {0}
sea = np.isin(lab, list(edge))
print('sea cells', int(sea.sum()))

lakemask = np.zeros(dem.shape, bool)
if lake and lake[0].intersects(gbox):
    lakemask = rasterize([(lake[0], 1)], out_shape=dem.shape, transform=T, fill=0, all_touched=False).astype(bool)
    lv = float(np.median(dem[lakemask]))
    cond[lakemask] = lv
    print('lake cells', int(lakemask.sum()), 'level', round(lv, 1))
else:
    lv = None

# stream burning in the flat lowland only (surface < 120 m): mapped river lines lowered by BURN m
LOW, BURN = 120.0, 20.0
rv = rasterize([(r, 1) for r in rivers], out_shape=dem.shape, transform=T, fill=0, all_touched=True).astype(bool)
km = rasterize([(r, 1) for r in kom], out_shape=dem.shape, transform=T, fill=0, all_touched=True).astype(bool)
burn = rv & (dem < LOW) & ~lakemask & ~sea
burn_k = km & (dem < LOW + 40) & ~lakemask & ~sea  # Komering main stem burned a bit further up
cond[burn] -= BURN
cond[burn_k] = np.minimum(cond[burn_k], dem[burn_k] - BURN - 5)
print('burned cells', int(burn.sum()), 'komering cells', int(burn_k.sum()))
cond[sea] = -50.0

# inflow from outside the FINE box, taken from the WIDE result
inflow = np.zeros(dem.shape)
if which == 'fine':
    wz = np.load(OUT + '/wide.npz')
    wT = rasterio.Affine(*wz['transform'][:6])
    wdir, wacc = wz['dir'], wz['acc']
    off = {64: (-1, 0), 128: (-1, 1), 1: (0, 1), 2: (1, 1), 4: (1, 0), 8: (1, -1), 16: (0, -1), 32: (-1, -1)}
    wr, wc = wdir.shape
    for d, (dr, dc) in off.items():
        rr, cc = np.nonzero(wdir == d)
        tr, tc = rr + dr, cc + dc
        ok = (tr >= 0) & (tr < wr) & (tc >= 0) & (tc < wc)
        rr, cc, tr, tc = rr[ok], cc[ok], tr[ok], tc[ok]
        # source centre outside the fine box, target centre inside
        sx, sy = wT * (cc + 0.5, rr + 0.5)
        tx, ty = wT * (tc + 0.5, tr + 0.5)
        ins = lambda x, y: (x > W0) & (x < E0) & (y > S0) & (y < N0)
        k = ~ins(sx, sy) & ins(tx, ty)
        for s_r, s_c, x, y in zip(rr[k], cc[k], tx[k], ty[k]):
            a = wacc[s_r, s_c]
            if a < 1:
                continue
            fc, fr = ~T * (x, y)
            fr, fc = int(fr), int(fc)
            r0, r1_, c0, c1_ = max(fr - 2, 1), min(fr + 3, rows - 1), max(fc - 2, 1), min(fc + 3, cols - 1)
            win = cond[r0:r1_, c0:c1_]
            i = np.unravel_index(np.argmin(win), win.shape)
            inflow[r0 + i[0], c0 + i[1]] += a
    print('inflow injected km2 total', round(inflow.sum(), 1), 'max', round(inflow.max(), 1))
    # walls on the domain edge, except where the WIDE flow leaves the domain (nested outlets)
    wall = np.zeros(dem.shape, bool)
    wall[0] = wall[-1] = True; wall[:, 0] = wall[:, -1] = True
    nout = 0
    for d, (dr, dc) in off.items():
        rr, cc = np.nonzero(wdir == d)
        tr, tc = rr + dr, cc + dc
        sx, sy = wT * (cc + 0.5, rr + 0.5)
        tx, ty = wT * (tc + 0.5, tr + 0.5)
        k = ins(sx, sy) & ~ins(tx, ty)
        for x, y, a in zip(sx[k], sy[k], wacc[rr[k], cc[k]]):
            fc, fr = ~T * (x, y)
            fr, fc = min(max(int(fr), 0), rows - 1), min(max(int(fc), 0), cols - 1)
            # nearest edge
            dists = [fr, rows - 1 - fr, fc, cols - 1 - fc]
            e = int(np.argmin(dists))
            if e == 0: cand = [(0, j) for j in range(max(fc - 3, 0), min(fc + 4, cols))]
            elif e == 1: cand = [(rows - 1, j) for j in range(max(fc - 3, 0), min(fc + 4, cols))]
            elif e == 2: cand = [(i, 0) for i in range(max(fr - 3, 0), min(fr + 4, rows))]
            else: cand = [(i, cols - 1) for i in range(max(fr - 3, 0), min(fr + 4, rows))]
            i, j = min(cand, key=lambda q: cond[q])
            wall[i, j] = False; nout += 1
    cond[wall] += 1000.0
    print('nested outlets', nout)

# pysheds conditioning
from pysheds.grid import Grid
from pysheds.sview import Raster, ViewFinder
vf = ViewFinder(affine=T, shape=dem.shape, crs=__import__('pyproj').Proj('EPSG:4326'), nodata=np.nan)
R = lambda a, nd=np.nan: Raster(a, viewfinder=ViewFinder(affine=T, shape=dem.shape, crs=vf.crs, nodata=nd))
grid = Grid(viewfinder=vf)
t = time.time()
c = R(cond.astype(np.float64))
c = grid.fill_pits(c)
c = grid.fill_depressions(c)
print('filled', round(time.time() - t), flush=True)
c = grid.resolve_flats(c, max_iter=20000)
print('flats resolved', round(time.time() - t), flush=True)
fd = grid.flowdir(c)
fdn = np.asarray(fd).astype(np.int32)
print('unresolved flats', int((fdn == -1).sum()), 'pits', int((fdn == -2).sum()), 'on land', int(((fdn < 0) & ~sea).sum()))
fd2 = fdn.copy()
fd2[fd2 < 0] = 0
fd2[sea] = 0
fdr = R(fd2.astype(np.int64), 0)
acc = grid.accumulation(fdr, weights=R(cell_km2 + inflow, 0.0), nodata_out=0.0)
acc = np.asarray(acc).astype(np.float64)
print('acc max km2', round(acc.max(), 1), 'time', round(time.time() - t), flush=True)
mc = int(round(M / cs))
cr = (slice(mc, rows - mc), slice(mc, cols - mc))
c = np.asarray(c).astype(np.float64)
fdc = fd2[cr].copy()
# a cell on the crop edge whose D8 points out of the crop becomes an outlet (code 0)
Tc = from_origin(CW0, CN0, cs, cs)
print('crop', fdc.shape)
np.savez_compressed(guard(OUT + f'/{which}.npz'), dem=dem[cr].astype(np.float32), cond=c[cr],
                    dir=fdc.astype(np.uint8), acc=acc[cr].astype(np.float32), cell_km2=area[cr[0]], sea=sea[cr], lake=lakemask[cr],
                    burn=(burn | burn_k)[cr], inflow=inflow[cr].astype(np.float32), transform=np.array(tuple(Tc)),
                    bounds=np.array([CW0, CS0, CE0, CN0]), full_dir=fd2.astype(np.uint8), full_acc=acc.astype(np.float32), full_inflow=inflow.astype(np.float32), full_cond=c, full_dem=dem.astype(np.float32), full_T=np.array(tuple(T)), lake_level=np.array([lv if lv is not None else np.nan]))
print('saved')
