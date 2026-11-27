import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import sys; sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from common import *
c = con()
S = AR + "/segment.parquet"
c.execute(f"create table seg as select * from '{S}'")
# bridge pieces: Overture flags carry 'between' (fractions along the segment); null = whole segment
c.execute("""create table br as select id, subtype, class, name,
  case when f.between is null then geometry else ST_LineSubstring(geometry, f.between[1], f.between[2]) end geometry
  from (select id, subtype, class, name, geometry, unnest(coalesce(road_flags, []) || coalesce(rail_flags, [])) f from seg)
  where list_contains(f."values", 'is_bridge')""")
# Komering below the weir (weir at 104.381,-4.305; the river runs north from here)
c.execute(f"""create table kom as select ST_Union_Agg(geometry) g from '{AR}/water.parquet'
  where name='Sungai Komering' and subtype='river' and ST_YMax(geometry) > -4.31""")
# 5 km and 15 km bands in degrees: transform to UTM 48S for buffering
c.execute("""create table bands as select ST_Transform(ST_Buffer(ST_Transform(g,'OGC:CRS84','EPSG:32748'),5000),'EPSG:32748','OGC:CRS84') b5,
  ST_Transform(ST_Buffer(ST_Transform(g,'OGC:CRS84','EPSG:32748'),15000),'EPSG:32748','OGC:CRS84') b15 from kom""")
c.execute("COPY (select ST_AsWKB(b5) b5, ST_AsWKB(b15) b15 from bands) TO '%s/lanes/g04/bands.parquet' (FORMAT PARQUET)" % BASE)
G = lambda tol: f"ST_AsGeoJSON(ST_ReducePrecision(ST_SimplifyPreserveTopology(geometry,{tol}),0.00001))"
tol = 0.00015
rows = [(g, {"class": cl, "name": n}) for g, cl, n in c.sql(f"""select {G(tol)}, class, name from seg where subtype='road'
  and class in ('motorway','trunk','primary','secondary','tertiary')""").fetchall()]
print("roads", write_fc(FEAT + "/roads.geojson", rows, {"note": "motorway..tertiary, wide box, simplified %g deg" % tol}))
fx0, fy0, fx1, fy1 = FINE
W = f"(ST_Intersects(geometry, ST_MakeEnvelope({fx0},{fy0},{fx1},{fy1})) or ST_Intersects(geometry, b5))"
rows = [(g, {"class": cl, "name": n}) for g, cl, n in c.sql(f"""select {G(0.00003)}, class, name from seg, bands where subtype='road' and {W}""").fetchall()]
rows += [(g, {"class": cl, "name": n, "bridge": True}) for g, cl, n in c.sql(f"""select {G(0.00001)}, class, name from br, bands where subtype='road' and {W}""").fetchall()]
print("roads_fine", write_fc(FEAT + "/roads_fine.geojson", rows, {"note": "all road classes inside the fine box and a 5 km band along Sungai Komering below Bendung Perjaya; extra features with bridge=true are the bridged parts of segments (Overture road_flags is_bridge)"}))
rows = [(g, {"class": cl, "name": n}) for g, cl, n in c.sql(f"select {G(0.00005)}, class, name from seg where subtype='rail'").fetchall()]
rows += [(g, {"class": cl, "name": n, "bridge": True}) for g, cl, n in c.sql(f"select {G(0.00001)}, class, name from br where subtype='rail'").fetchall()]
print("rail", write_fc(FEAT + "/rail.geojson", rows))
D = AR + "/division.parquet"
rows = [(f"ST_AsGeoJSON(geometry)", None)]
rows = [(g, {k: v for k, v in {"name": n, "kind": k1 or st, "population": p}.items() if v is not None}) for g, n, k1, st, p in c.sql(f"""select ST_AsGeoJSON(ST_ReducePrecision(geometry,0.00001)), name, class, subtype, population from '{D}'
  where subtype in ('locality','neighborhood','macrohood') and name is not null and ST_GeometryType(geometry)='POINT'""").fetchall()]
print("places", write_fc(FEAT + "/places.geojson", rows, {"note": "populated places from Overture divisions (OSM place=*); kind = village/hamlet/town/city or subtype"}))
DA = AR + "/division_area.parquet"
rows = [(g, {"name": n, "level": {"county": "kabupaten", "localadmin": "kecamatan"}[st]}) for g, n, st in c.sql(f"""select ST_AsGeoJSON(ST_ReducePrecision(ST_SimplifyPreserveTopology(geometry, case when subtype='county' then 0.0015 else 0.0008 end),0.00001)), name, subtype
  from '{DA}' where class='land' and subtype in ('county','localadmin')""").fetchall()]
print("admin", write_fc(FEAT + "/admin.geojson", rows, {"note": "OpenStreetMap boundaries, not official ones. kabupaten = Overture county, kecamatan = localadmin. Desa outlines: see note (few in OSM)."}))

c.execute(f"COPY (select id, subtype, class, name, geometry from br) TO '{AR}/bridges_from_segments.parquet' (FORMAT PARQUET)")
print("bridge pieces", c.sql("select subtype, count(*) from br group by all").fetchall())
