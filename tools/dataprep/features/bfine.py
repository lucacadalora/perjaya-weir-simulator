import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import sys; sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from common import *
c = con()
fx0, fy0, fx1, fy1 = FINE
c.execute(f"""create table kom as select ST_Transform(ST_Union_Agg(geometry),'OGC:CRS84','EPSG:32748') g from '{AR}/water.parquet'
  where name='Sungai Komering' and subtype='river' and ST_Intersects(geometry, ST_MakeEnvelope({fx0-0.05},{fy0-0.05},{fx1+0.05},{fy1+0.05}))""")
c.execute(f"""create table bf as select ST_AsGeoJSON(ST_ReducePrecision(ST_SimplifyPreserveTopology(geometry,0.000004), 0.000001)) gj,
  ST_Distance(ST_Transform(ST_Centroid(geometry),'OGC:CRS84','EPSG:32748'), (select g from kom)) d
  from '{AR}/building.parquet' where ST_X(ST_Centroid(geometry)) between {fx0} and {fx1} and ST_Y(ST_Centroid(geometry)) between {fy0} and {fy1}""")
tot = c.sql("select count(*) from bf").fetchall()[0][0]
rows = c.sql("select gj, d from bf order by d").fetchall()
lim = 5_900_000; size = 120; n = 0
for gj, d in rows:
    s = len(gj) + 50
    if size + s > lim: break
    size += s; n += 1
D = int(rows[n-1][1] // 100 * 100) if n < len(rows) else None
keep = [(gj, {}) for gj, d in rows if D is None or d <= D]
print(tot, len(keep), D)
print(write_fc(FEAT + "/buildings_fine.geojson", keep, {"credit": "Buildings: Overture Maps Foundation release %s: (c) OpenStreetMap contributors (ODbL 1.0); Google Open Buildings (CC BY 4.0 / ODbL); Microsoft ML Buildings (ODbL)" % REL,
  "license": "ODbL-1.0 (Overture buildings theme)", "note": f"Fine box holds {tot} footprints; to stay under 6 MB this file keeps those whose centre lies within {D} m of Sungai Komering. All {tot} are in buildings.bin as points with area."}))
