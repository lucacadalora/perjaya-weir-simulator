import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import urllib.request, json, time, os, sys
OUT=WORK + '/lanes/r14/raw/openmeteo'
os.makedirs(OUT,exist_ok=True)
lons=[103.70,103.93,104.17,104.40]
lats=[-4.40,-4.65,-4.90]
pts=[(la,lo) for la in lats for lo in lons]
for model in ['era5','era5_land']:
  for la,lo in pts:
    fn=f'{OUT}/{model}_{la:.2f}_{lo:.2f}.json'
    if os.path.exists(fn) and os.path.getsize(fn)>1000: continue
    url=(f'https://archive-api.open-meteo.com/v1/archive?latitude={la}&longitude={lo}'
         f'&start_date=1991-01-01&end_date=2025-12-31&daily=precipitation_sum,et0_fao_evapotranspiration'
         f'&timezone=Asia%2FJakarta&models={model}')
    for attempt in range(3):
      try:
        r=urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'research-script'}),timeout=120)
        d=r.read(); open(fn,'wb').write(d); print(model,la,lo,len(d)); break
      except Exception as e:
        print('err',model,la,lo,e); time.sleep(10)
    time.sleep(2)
