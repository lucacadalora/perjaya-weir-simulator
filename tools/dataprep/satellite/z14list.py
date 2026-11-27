import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
# write z14 tile list: fine box, plus 4 km band along Komering main stem (if rivers.geojson exists)
import json, math, os, sys
sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from fetch import bbox_tiles, t
box=json.load(open(WORK + "/geo/box.json")); f=box["fine"]
T=bbox_tiles(f["west"],f["south"],f["east"],f["north"],14)
print("fine",len(T))
R=REPO + "/site/data/feat/rivers.geojson"
band=set()
if os.path.exists(R):
    from shapely.geometry import shape, Point, box as sbox
    from shapely.ops import unary_union, transform
    from pyproj import Transformer
    g=json.load(open(R)); feats=g["features"]
    km=[ft for ft in feats if ft["properties"].get("name")=="Sungai Komering"]
    print("features",len(feats),"komering",len(km), [ft["properties"] for ft in km[:3]])
    line=unary_union([shape(ft["geometry"]) for ft in km])
    fw=Transformer.from_crs(4326,32748,always_xy=True).transform; bw=Transformer.from_crs(32748,4326,always_xy=True).transform
    L=transform(fw,line)
    # main stem from Muaradua (-4.53,104.07) to north edge of wide box (-3.50): clip by lat range of that stretch
    clip=transform(fw,sbox(103.9,-4.60,box["east"],box["north"]))
    poly=L.intersection(clip).buffer(2000)
    P=transform(bw,poly)
    w,s,e,n=P.bounds
    for (z,x,y) in bbox_tiles(w,s,e,n,14):
        # tile bounds
        N=2**14; lon0=x/N*360-180; lon1=(x+1)/N*360-180
        la=lambda yy: math.degrees(math.atan(math.sinh(math.pi*(1-2*yy/N))))
        if P.intersects(sbox(lon0,la(y+1),lon1,la(y))): band.add((z,x,y))
    print("band",len(band))
open(sys.argv[1],"w").write("".join(f"{z} {x} {y}\n" for z,x,y in sorted(T|band)))
print("total",len(T|band))
