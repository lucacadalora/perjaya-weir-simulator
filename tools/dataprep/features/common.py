import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import json, os, duckdb
BASE = WORK + ""
REPO = REPO + ""
AR = BASE + "/geo/around"
FEAT = REPO + "/site/data/feat"
REL = "2026-11-18.0"
WIDE = (103.30, -5.20, 105.00, -3.50)
FINE = (104.20, -4.50, 104.55, -4.10)
ALLOWED = [BASE + "/lanes/g04/", AR + "/", BASE + "/geo/water_occurrence_fine.tif", BASE + "/geo/shots/g04-",
           FEAT + "/", REPO + "/site/data/grid/"]
OSM_CREDIT = ("(c) OpenStreetMap contributors, ODbL 1.0; data via Overture Maps Foundation (release %s)" % REL)
def guard(p):
    p = os.path.abspath(p)
    if not any(p.startswith(a) or p == a for a in ALLOWED):
        raise SystemExit("refusing output path " + p)
    if p.startswith(FEAT + "/"):
        ok = {"rivers.geojson","lakes.geojson","roads.geojson","roads_fine.geojson","rail.geojson","places.geojson",
              "admin.geojson","buildings.bin","buildings.json","buildings_fine.geojson"}
        if os.path.basename(p) not in ok: raise SystemExit("refusing " + p)
    if p.startswith(REPO + "/site/data/grid/") and os.path.basename(p) not in {"wide.lc.u8","fine.lc.u8","lc.json"}:
        raise SystemExit("refusing " + p)
    return p
def con():
    c = duckdb.connect(); c.execute("LOAD spatial; SET threads=4; SET memory_limit='6GB'; SET geometry_always_xy=true"); return c
def write_fc(path, rows, extra=None):
    """rows: list of (geojson_str, props dict)"""
    path = guard(path)
    fc = {"type": "FeatureCollection", "credit": OSM_CREDIT, "license": "ODbL-1.0"}
    if extra: fc.update(extra)
    feats = []
    for g, p in rows:
        if g is None or "\"coordinates\":[]" in g or "EMPTY" in g: continue
        feats.append('{"type":"Feature","properties":%s,"geometry":%s}' % (json.dumps(p, ensure_ascii=False, separators=(",", ":")), g))
    head = json.dumps(fc, ensure_ascii=False, separators=(",", ":"))[:-1]
    with open(path, "w") as f:
        f.write(head + ',"features":[' + ",".join(feats) + "]}")
    return len(feats), os.path.getsize(path)
