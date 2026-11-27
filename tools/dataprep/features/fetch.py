"""Fetch Overture layers for the wide box into BASE/geo/around/. usage: fetch.py layer..."""
import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import os, sys, time, duckdb
REL = "2026-11-18.0"
OUT = WORK + "/geo/around"
W, S, E, N = 103.30, -5.20, 105.00, -3.50
con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2'; SET enable_progress_bar=false;")
con.execute("SET memory_limit='4GB'; SET threads=4;")
B = f"bbox.xmin < {E} AND bbox.xmax > {W} AND bbox.ymin < {N} AND bbox.ymax > {S}"
NM = 'names."primary" AS name'
JOBS = {
 "water": ("base", "water", f"id, subtype, class, {NM}, is_intermittent, source_tags, sources, geometry"),
 "infrastructure": ("base", "infrastructure", f"id, subtype, class, {NM}, source_tags, sources, geometry"),
 "land_use": ("base", "land_use", f"id, subtype, class, {NM}, source_tags, sources, geometry"),
 "land": ("base", "land", f"id, subtype, class, {NM}, source_tags, sources, geometry"),
 "division": ("divisions", "division", f"id, subtype, class, {NM}, population, hierarchies, sources, geometry"),
 "division_area": ("divisions", "division_area", f"id, division_id, subtype, class, {NM}, sources, geometry"),
 "division_boundary": ("divisions", "division_boundary", f"id, subtype, class, sources, geometry"),
 "segment": ("transportation", "segment", f"id, subtype, class, subclass, {NM}, road_flags, rail_flags, level_rules, sources, geometry"),
 "place": ("places", "place", f"id, {NM}, basic_category, taxonomy, confidence, operating_status, sources, geometry"),
 "building": ("buildings", "building", "id, subtype, class, height, num_floors, geometry"),
}
for k in sys.argv[1:]:
    th, ty, cols = JOBS[k]
    src = f"s3://overturemaps-us-west-2/release/{REL}/theme={th}/type={ty}/*"
    t = time.time()
    try:
        con.execute(f"COPY (SELECT {cols} FROM read_parquet('{src}', hive_partitioning=1) WHERE {B}) TO '{OUT}/{k}.parquet' (FORMAT PARQUET)")
    except Exception as e:
        print(k, "ERR", str(e)[:300]); continue
    n = con.execute(f"SELECT count(*) FROM read_parquet('{OUT}/{k}.parquet')").fetchone()[0]
    print(k, "rows", n, "s", round(time.time() - t), flush=True)
