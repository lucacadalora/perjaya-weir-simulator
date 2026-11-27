import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import sys; sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from common import *
import numpy as np, math
c = con()
B = AR + "/building.parquet"
fx0, fy0, fx1, fy1 = FINE
WLON, WLAT = 104.381, -4.305   # Bendung Perjaya (Overture/OSM weir feature)
c.execute(f"create table bands as select ST_GeomFromWKB(b15) b15 from '{BASE}/lanes/g04/bands.parquet'")
c.execute(f"""create table b as select ST_X(ST_Centroid(geometry)) x, ST_Y(ST_Centroid(geometry)) y, ST_Area_Spheroid(geometry) a, geometry from '{B}'
""")
tot = c.sql("select count(*) from b").fetchall()[0][0]
c.execute(f"""create table k as select b.* from b, bands where (x <= {WLON+0.02} and y <= {WLAT+0.05})
  or (x between {fx0} and {fx1} and y between {fy0} and {fy1}) or ST_Contains(b15, ST_Point(x, y))""")
kept = c.sql("select count(*) from k").fetchall()[0][0]
print("total", tot, "kept", kept)
x, y, a = [np.array(v) for v in zip(*c.sql("select x, y, a from k").fetchall())]
n = 4096
tx = np.floor((x + 180) / 360 * n).astype(np.int64)
lr = np.radians(y)
ty = np.floor((1 - np.log(np.tan(lr) + 1 / np.cos(lr)) / math.pi) / 2 * n).astype(np.int64)
key = tx * n + ty
o = np.lexsort((y, x, key))
key = key[o]
arr = np.stack([x[o], y[o], a[o]], 1).astype("<f4")
with open(guard(FEAT + "/buildings.bin"), "wb") as f: f.write(arr.tobytes())
u, st, cnt = np.unique(key, return_index=True, return_counts=True)
idx = {str(int(k)): [int(s), int(cc)] for k, s, cc in zip(u, st, cnt)}
meta = {"count": int(kept), "count_in_wide_box": int(tot), "format": "little-endian Float32 triplets (lon, lat, footprint_m2), 12 bytes per building, sorted by tile key",
  "tile_key": "zoom 12 web-mercator tile: key = x*4096 + y; index maps key -> [offset (in buildings), count]",
  "kept_area": "wide box held 1,957,750 footprints (over 1.5 million), so kept: the catchment side south-west of Martapura (lon <= 104.401, lat <= -4.255), the fine box, and a 15 km band along Sungai Komering below Bendung Perjaya",
  "footprint": "area on the WGS84 spheroid of the Overture footprint polygon",
  "index": idx,
  "credits": ["Buildings: Overture Maps Foundation release %s, buildings theme: (c) OpenStreetMap contributors (ODbL 1.0) and Microsoft, Google Open Buildings and Esri Community Maps footprints, licensed CDLA Permissive 2.0 / ODbL as stated per record in Overture's sources" % REL]}
c.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2'")
srcs = c.sql(f"select s.dataset, count(*) from (select unnest(sources) s from read_parquet('s3://overturemaps-us-west-2/release/{REL}/theme=buildings/type=building/*',hive_partitioning=1) where bbox.xmin<105 and bbox.xmax>103.3 and bbox.ymin<-3.5 and bbox.ymax>-5.2) group by all order by 2 desc").fetchall()
meta["sources_in_wide_box"] = {d: n_ for d, n_ in srcs}
json.dump(meta, open(guard(FEAT + "/buildings.json"), "w"), separators=(",", ":"))
print(srcs)
rows = [(g, {"m2": round(ar, 1)}) for g, ar in c.sql(f"""select ST_AsGeoJSON(ST_ReducePrecision(geometry, 0.000001)), a from b
  where x between {fx0} and {fx1} and y between {fy0} and {fy1}""").fetchall()]
print("fine", write_fc(FEAT + "/buildings_fine.geojson", rows, {"credit": meta["credits"][0], "license": "ODbL-1.0 / CDLA-Permissive-2.0 per source"}))
