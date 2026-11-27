import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import sys; sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from common import *
c = con()
P = AR + "/water.parquet"
tol = float(sys.argv[1]) if len(sys.argv) > 1 else 0.0001
q = f"""select ST_AsGeoJSON(ST_ReducePrecision(ST_SimplifyPreserveTopology(geometry,{tol}),0.00001)) g, name, subtype, class
from '{P}' where ST_GeometryType(geometry) in ('LINESTRING','MULTILINESTRING')
and ((subtype in ('river','stream') and name is not null) or subtype='canal')"""
rows = [(g, {"name": n, "kind": cl if st == "canal" else st}) for g, n, st, cl in c.sql(q).fetchall()]
print(write_fc(FEAT + "/rivers.geojson", rows, {"note": "named rivers and streams, all canals/ditches/drains; simplified %g deg" % tol}))
q = f"""select ST_AsGeoJSON(ST_ReducePrecision(ST_SimplifyPreserveTopology(geometry,{tol}),0.00001)) g, name, subtype, class
from '{P}' where ST_GeometryType(geometry) in ('POLYGON','MULTIPOLYGON') and subtype in ('lake','reservoir','river','pond','water')
and class not in ('swimming_pool','wastewater')"""
rows = [(g, {"name": n, "kind": st if st != "water" else cl}) for g, n, st, cl in c.sql(q).fetchall()]
print(write_fc(FEAT + "/lakes.geojson", rows, {"note": "lake, reservoir, river-area, pond and water polygons"}))
