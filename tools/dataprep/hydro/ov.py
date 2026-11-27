import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import duckdb, time, sys
OUT=WORK + '/lanes/g02/ov'
REL='2026-11-18.0'
W,S,E,N=103.25,-5.25,105.05,-3.45
con=duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2'; SET enable_progress_bar=false; SET memory_limit='2GB'; SET threads=2;")
B=f"bbox.xmin < {E} AND bbox.xmax > {W} AND bbox.ymin < {N} AND bbox.ymax > {S}"
for th,ty in [('base','water'),('base','infrastructure')]:
    t=time.time()
    src=f"s3://overturemaps-us-west-2/release/{REL}/theme={th}/type={ty}/*"
    con.execute(f"""COPY (SELECT id, subtype, class, names."primary" AS name, source_tags, ST_AsWKB(geometry) AS wkb FROM read_parquet('{src}', hive_partitioning=1) WHERE {B}) TO '{OUT}/{ty}.parquet' (FORMAT PARQUET)""")
    print(ty, con.execute(f"select count(*) from '{OUT}/{ty}.parquet'").fetchone(), round(time.time()-t), flush=True)
