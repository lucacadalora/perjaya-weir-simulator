import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import sys, os, math, time, json, urllib.request
OUT = REPO + "/site/data/tiles/sat"
URL = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg"
def t(lon, lat, z):
    n = 2**z; x = int((lon+180)/360*n)
    lr = math.radians(lat); y = int((1-math.asinh(math.tan(lr))/math.pi)/2*n)
    return x, y
def bbox_tiles(w,s,e,n,z):
    x0,y0=t(w,n,z); x1,y1=t(e,s,z)
    return {(z,x,y) for x in range(x0,x1+1) for y in range(y0,y1+1)}
import threading
from concurrent.futures import ThreadPoolExecutor
_lock=threading.Lock(); _next=[0.0]; _err=[0]; _stop=[False]
def _one(zxy, log):
    z,x,y=zxy
    if _stop[0]: return 0
    p=f"{OUT}/{z}/{x}/{y}.jpg"
    assert os.path.realpath(p).startswith(OUT+"/")
    with _lock:
        w=_next[0]-time.time()
        if w>0: time.sleep(w)
        _next[0]=max(time.time(),_next[0])+0.26
    try:
        r=urllib.request.urlopen(urllib.request.Request(URL.format(z=z,x=x,y=y),headers={"User-Agent":"research-tile-fetch"}),timeout=30)
        b=r.read(); assert b[:2]==b"\xff\xd8", "not jpeg"
        os.makedirs(os.path.dirname(p),exist_ok=True); open(p,"wb").write(b); _err[0]=0; return 1
    except Exception as ex:
        with _lock:
            _err[0]+=1; print("ERR",z,x,y,ex,file=log,flush=True)
            if _err[0]>=5: _stop[0]=True; print("STOP: 5 errors in a row",flush=True)
        return 0
def run(tiles, log):
    todo=[t for t in sorted(tiles) if not (os.path.exists(f"{OUT}/{t[0]}/{t[1]}/{t[2]}.jpg") and os.path.getsize(f"{OUT}/{t[0]}/{t[1]}/{t[2]}.jpg")>0)]
    t0=time.time()
    with ThreadPoolExecutor(32) as ex: got=sum(ex.map(lambda t:_one(t,log),todo))
    print(f"fetched {got} of {len(todo)} todo ({len(tiles)} total) in {time.time()-t0:.0f}s",flush=True)
if __name__=="__main__":
    mode=sys.argv[1]
    box=json.load(open(WORK + "/geo/box.json"))
    if mode=="wide":
        T=set()
        for z in range(6,14): T|=bbox_tiles(box["west"],box["south"],box["east"],box["north"],z)
    elif mode=="tiles":
        T={tuple(map(int,l.split())) for l in open(sys.argv[2])}
    print(len(T),"tiles",flush=True)
    if len(sys.argv)>2 and sys.argv[-1]=="count": sys.exit()
    run(T, open(WORK + "/lanes/g03/fetch.log","a"))
