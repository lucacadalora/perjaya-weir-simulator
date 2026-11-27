import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import numpy as np, rasterio, json, os, math, sys, io
from rasterio.warp import reproject, Resampling
from rasterio.transform import from_bounds
from PIL import Image
D = WORK + "/lanes/g06/dl/"; O = WORK + "/lanes/g06/out/"
SITE = REPO + "/site/data/tiles/"
W, S, E, N = 104.20, -4.50, 104.55, -4.10
R = 6378137.0; HALF = math.pi * R
def merc(lon, lat): return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
def tile_bounds(z, x, y):
    n = 2 ** z; s = 2 * HALF / n; return (-HALF + x * s, HALF - (y + 1) * s, -HALF + (x + 1) * s, HALF - y * s)
def tile_range(z):
    n = 2 ** z
    x0 = int((W + 180) / 360 * n); x1 = int((E + 180) / 360 * n)
    def ty(lat): return int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)
    return x0, x1, ty(N), ty(S)
bx0, by0 = merc(W, S); bx1, by1 = merc(E, N)
def in_box_mask(z, x, y):
    l, b, r, t = tile_bounds(z, x, y); xs = l + (np.arange(256) + 0.5) * (r - l) / 256; ys = t - (np.arange(256) + 0.5) * (t - b) / 256
    return (ys[:, None] >= by0) & (ys[:, None] <= by1) & (xs[None, :] >= bx0) & (xs[None, :] <= bx1)
def safe(p):
    rp = os.path.realpath(p); assert rp.startswith(SITE + "sat2026/") or rp.startswith(SITE + "lc10/"), rp; return p
def make_rgb():
    bands = []
    for b in ["B04", "B03", "B02"]:
        with rasterio.open(D + b + ".tif") as s: bands.append(s.read(1).astype("f4") * 1e-4); prof = s.profile
    a = np.dstack(bands); valid = a.min(axis=2) > 0
    lo = np.percentile(a[valid], 0.5, axis=0); hi = np.percentile(a[valid], 99.7, axis=0)
    lo = np.full(3, lo.min()); hi = np.full(3, hi.max())   # same stretch on all three bands: keeps the colour balance
    out = np.clip((a - lo) / (hi - lo), 0, 1) ** 0.9
    out = (out * 255 + 0.5).astype("u1"); out[~valid] = 0
    prof.update(count=3, dtype="uint8", nodata=None, compress="deflate")
    with rasterio.open(O + "rgb2026.tif", "w", **prof) as d:
        for i in range(3): d.write(out[..., i], i + 1)
        d.update_tags(CREDIT="Contains modified Copernicus Sentinel data 2026", STRETCH=f"linear {lo[0]:.4f}-{hi[0]:.4f} reflectance, gamma 0.9, same on R G B")
    print("stretch", lo[0], hi[0])
def cut(src_path, outdir, zooms, ext, res_for, colour=None, bg_dir=None):
    total = 0
    with rasterio.open(src_path) as src:
        for z in zooms:
            x0, x1, y0, y1 = tile_range(z)
            for x in range(x0, x1 + 1):
                for y in range(y0, y1 + 1):
                    l, b, r, t = tile_bounds(z, x, y); dt = from_bounds(l, b, r, t, 256, 256)
                    dst = np.zeros((src.count, 256, 256), "u1")
                    reproject(rasterio.band(src, list(range(1, src.count + 1))), dst, dst_transform=dt, dst_crs="EPSG:3857", resampling=res_for(z), src_nodata=None)
                    m = in_box_mask(z, x, y)
                    p = safe(f"{outdir}/{z}/{x}/{y}.{ext}"); os.makedirs(os.path.dirname(p), exist_ok=True)
                    if colour is None:
                        img = np.moveaxis(dst, 0, -1)
                        bgp = f"{bg_dir}/{z}/{x}/{y}.jpg" if bg_dir else None
                        if bgp and os.path.exists(bgp):
                            bg = np.asarray(Image.open(bgp).convert("RGB").resize((256, 256)))
                        else: bg = np.full((256, 256, 3), 200, "u1")
                        img = np.where(m[..., None] & (img.sum(axis=2, keepdims=True) > 0), img, bg)
                        Image.fromarray(img.astype("u1")).save(p, "JPEG", quality=88, optimize=True)
                    else:
                        rgba = colour[dst[0]]
                        if z >= 15:
                            from scipy.ndimage import gaussian_filter
                            rgba[..., :3] = np.clip(np.stack([gaussian_filter(rgba[..., i].astype("f4"), 0.9) for i in range(3)], -1) + 0.5, 0, 255).astype("u1")
                        rgba[~m] = 0
                        Image.fromarray(rgba).save(p, "PNG", optimize=True)
                    total += os.path.getsize(p)
            print(z, "tiles x", x0, x1, "y", y0, y1, "bytes so far", total)
    return total
if __name__ == "__main__":
    what = sys.argv[1]
    if what == "sat":
        make_rgb()
        tot = cut(O + "rgb2026.tif", SITE + "sat2026", range(11, 15), "jpg", lambda z: Resampling.bilinear if z == 14 else Resampling.average, bg_dir=SITE + "sat")
        json.dump({"tilejson": "3.0.0", "name": "Sentinel-2 26 Apr 2026 true colour, weir reach (fine box)",
                   "tiles": ["data/tiles/sat2026/{z}/{x}/{y}.jpg"], "scheme": "xyz", "format": "jpg", "tileSize": 256,
                   "bounds": [W, S, E, N], "minzoom": 11, "maxzoom": 14,
                   "attribution": "Contains modified Copernicus Sentinel data 2026",
                   "source": "Sentinel-2 L2A S2B_48MVA_20260426_0_L2A (0.22 % cloud), bands B04/B03/B02 via Element84 earth-search STAC on AWS; one linear stretch on all bands, gamma 0.9, no sharpening",
                   "edge_note": "outside the fine box each tile shows the EOX 2016 tile of data/tiles/sat underneath (JPEG has no transparency)",
                   "pixel_size_note": "native 10 m; z14 is about 9.5 m per pixel at 4.3 S, so overzoom beyond 14 adds no detail"},
                  open(safe(SITE + "sat2026/tiles.json"), "w"), indent=1)
        print("total", tot)
def lc():
    # ESA WorldCover classes -> quiet map palette (RGBA)
    pal = {10: "#cfe3bf", 20: "#dbe8c4", 30: "#e3edc8", 40: "#f1efc6", 50: "#e6e0d8", 60: "#efe6d0", 70: "#ffffff",
           80: "#c6def0", 90: "#b6dcd3", 95: "#a9d4c4", 100: "#e8eedb"}
    lut = np.zeros((256, 4), "u1")
    for k, h in pal.items(): lut[k] = [int(h[i:i + 2], 16) for i in (1, 3, 5)] + [255]
    src = WORK + "/lanes/g06/dl/wc.tif"
    tot = cut(src, SITE + "lc10", range(11, 16), "png", lambda z: Resampling.mode if z <= 13 else Resampling.nearest, colour=lut)
    return tot
if __name__ == "__main__" and sys.argv[1] == "lc":
    tot = lc()
    json.dump({"tilejson": "3.0.0", "name": "ESA WorldCover 2021 land cover, 10 m, weir reach (fine box), quiet palette",
               "tiles": ["data/tiles/lc10/{z}/{x}/{y}.png"], "scheme": "xyz", "format": "png", "tileSize": 256,
               "bounds": [W, S, E, N], "minzoom": 11, "maxzoom": 15,
               "attribution": "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium",
               "license": "CC BY 4.0",
               "source": "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_S06E102_Map.tif (window read)",
               "palette": {"10 tree cover": "#cfe3bf", "20 shrubland": "#dbe8c4", "30 grassland": "#e3edc8", "40 cropland": "#f1efc6", "50 built-up": "#e6e0d8", "60 bare / sparse": "#efe6d0", "80 permanent water": "#c6def0", "90 herbaceous wetland": "#b6dcd3", "95 mangroves": "#a9d4c4", "100 moss and lichen": "#e8eedb"},
               "resampling": "z11-13 mode of the 10 m classes (class-preserving downsample), z14 nearest neighbour (native 10 m, crisp class edges), z15 nearest then colour Gaussian blur sigma 0.9 px (soft edges, no new classes)",
               "transparency": "outside the fine box pixels are transparent"},
              open(safe(SITE + "lc10/tiles.json"), "w"), indent=1)
    print("total", tot)
