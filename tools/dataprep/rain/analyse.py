import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import json, glob, os, sys, math
import numpy as np
LANE=WORK + '/lanes/r14'
OUTJ=REPO + '/site/data/climate/rain.json'
ALLOWED=[LANE, REPO + '/site/data/climate/rain.json']
def ok(p):
    p=os.path.realpath(p); return any(p==a or p.startswith(a+'/') for a in ALLOWED)
def load(model):
    pts=[];series=[];et=[]
    for f in sorted(glob.glob(f'{LANE}/raw/openmeteo/{model}_-*.json')):
        d=json.load(open(f))
        key=(d['latitude'],d['longitude'])
        if key in [p[:2] for p in pts]: continue
        pts.append((d['latitude'],d['longitude'],d['elevation'],os.path.basename(f)))
        series.append(np.array([np.nan if v is None else v for v in d['daily']['precipitation_sum']],float))
        et.append(np.array([np.nan if v is None else v for v in d['daily']['et0_fao_evapotranspiration']],float))
        t=d['daily']['time']
    return pts,np.array(series),np.array(et),np.array(t,dtype='datetime64[D]')
res={}
for model in ['era5']:
    pts,P,E,t=load(model)
    if len(pts)==0: continue
    yrs=t.astype('datetime64[Y]').astype(int)+1970; mon=t.astype('datetime64[M]').astype(int)%12+1
    basin=np.nanmean(P,axis=0); ebasin=np.nanmean(E,axis=0)
    ys=sorted(set(yrs.tolist()))
    def mtab(y0,y1,x=basin):
        out=[]
        for m in range(1,13):
            vals=[x[(yrs==y)&(mon==m)].sum() for y in range(y0,y1+1)]
            out.append(vals)
        return np.array(out)  # 12 x years
    M9120=mtab(1991,2020); M1524=mtab(2015,2024); Mall=mtab(1991,2025)
    ann={y:float(basin[yrs==y].sum()) for y in ys}
    mx1={};mx3={}
    r3=np.convolve(basin,np.ones(3),'valid'); t3=t[2:]; y3=yrs[2:]
    for y in ys:
        mx1[y]=float(basin[yrs==y].max()); mx3[y]=float(r3[y3==y].max())
    def gumbel(vals):
        v=np.array(vals); mu=v.mean(); s=v.std(ddof=1); out={}
        for T in [2,5,10,25,50,100]:
            K=-(math.sqrt(6)/math.pi)*(0.5772+math.log(math.log(T/(T-1))))
            out[f'R{T}']=float(round(mu+K*s,1))
        return out
    # per point annual means 1991-2020 & point max1day
    ptann=[float(np.nansum(P[i][(yrs>=1991)&(yrs<=2020)])/30) for i in range(len(pts))]
    ptmx=[float(np.mean([P[i][yrs==y].max() for y in range(1991,2021)])) for i in range(len(pts))]
    ev=mtab(1991,2020,ebasin).mean(axis=1)
    # dry season Jun-Nov
    js={y:float(basin[(yrs==y)&(mon>=6)&(mon<=11)].sum()) for y in ys}
    res[model]=dict(pts=pts,t0=str(t[0]),basin=basin,m9120=M9120.mean(axis=1),m1524=M1524.mean(axis=1),
        p10=np.percentile(M9120,10,axis=1),p90=np.percentile(M9120,90,axis=1),ann=ann,mx1=mx1,mx3=mx3,
        g1=gumbel([mx1[y] for y in ys if y<=2025]),g3=gumbel([mx3[y] for y in ys if y<=2025]),ptann=ptann,ptmx=ptmx,ev=ev,js=js,
        cv=float(np.std([ann[y] for y in range(1991,2021)],ddof=1)/np.mean([ann[y] for y in range(1991,2021)])),
        n=len(pts))
r=res['era5']
for model,x in res.items():
    print('=====',model,'npts',x['n'])
    for p,a,m in zip(x['pts'],x['ptann'],x['ptmx']): print('  pt',p[:3],'annual',round(a),'mean max1d',round(m,1))
    print(' m9120',np.round(x['m9120']).tolist(),'sum',round(x['m9120'].sum()))
    print(' m1524',np.round(x['m1524']).tolist(),'sum',round(x['m1524'].sum()))
    print(' p10',np.round(x['p10']).tolist()); print(' p90',np.round(x['p90']).tolist())
    print(' ann',{k:round(v) for k,v in x['ann'].items()})
    print(' CV annual 1991-2020',round(x['cv'],3))
    print(' max1',{k:round(v,1) for k,v in x['mx1'].items()}); print(' max3',{k:round(v,1) for k,v in x['mx3'].items()})
    print(' g1',x['g1'],' g3',x['g3']); print(' ET0',np.round(x['ev']).tolist(),round(x['ev'].sum()))
    js=x['js']; jm=np.mean([js[y] for y in range(1991,2021)]); am=np.mean([x['ann'][y] for y in range(1991,2021)])
    for y in [1994,1997,2002,2006,2015,2019,2023]:
        print('  dry check',y,'annual',round(x['ann'][y]),f"{100*(x['ann'][y]/am-1):+.0f}%",'Jun-Nov',round(js[y]),f"{100*(js[y]/jm-1):+.0f}%")
    srt=sorted(x['ann'].items(),key=lambda kv:kv[1]); print(' driest',[(k,round(v)) for k,v in srt[:5]],' wettest',[(k,round(v)) for k,v in srt[-5:]])
json.dump({m:{k:(v.tolist() if isinstance(v,np.ndarray) else v) for k,v in x.items() if k!='basin'} for m,x in res.items()},open(f'{LANE}/summary.json','w'),default=str)
if '--write' in sys.argv:
    assert ok(OUTJ)
    out={"meta":{
      "sources":["ERA5 reanalysis daily precipitation_sum and et0_fao_evapotranspiration (FAO-56 reference ET, computed by Open-Meteo from ERA5) via Open-Meteo Historical Weather API, https://archive-api.open-meteo.com/v1/archive, models=era5, 1991-01-01 to 2025-12-31, timezone Asia/Jakarta",
                 "Station check: BMG daily rain, Banding Agung (Danau Ranau) 1985-1995 and Belitang 1985-2001, data book of JICA/CTI 'Study on Comprehensive Water Management of Musi River Basin' (2003), openjicareport.jica.go.jp/pdf/11740503_02.pdf"],
      "credits":["Weather data by Open-Meteo.com (https://open-meteo.com/)","Generated using Copernicus Climate Change Service information 2026. Hersbach et al. (2023) ERA5 hourly data on single levels from 1940 to present, ECMWF, doi:10.24381/cds.adbb2d47","Zippenfenig, P. (2023). Open-Meteo.com Weather API. Zenodo. doi:10.5281/zenodo.7970649"],
      "licences":["Open-Meteo API data: CC BY 4.0 (open-meteo.com/en/licence); free API is for non-commercial use only, under 10,000 calls/day (open-meteo.com/en/terms); commercial use needs a paid plan","ERA5: Copernicus licence (C3S), attribution required"],
      "points":[{"lat":p[0],"lon":p[1],"elev_m":p[2]} for p in r['pts']],
      "basin_mean_method":"equal-weight mean of the distinct ERA5 0.25-degree cells returned for a 4 x 3 grid (lon 103.70-104.40 E, lat 4.40-4.90 S); daily totals Asia/Jakarta days",
      "fetched":"2026-11-23",
      "caveats":["ERA5 is a reanalysis, not a measurement; see station check in the research note (r14).","The box is a rectangle, not the traced catchment; it includes some ground outside the Komering divide.","Areal-mean 1-day maxima are much lower than point (gauge) maxima; do not use them as point design rain.","Gumbel fitted by method of moments to 35 annual maxima 1991-2025.","evap_monthly_mm is FAO-56 reference evapotranspiration (grass), not pan or lake evaporation; open water is roughly 1.0-1.2 x ET0 (assumption).","Station check (BMG gauges in the JICA 2003 data book): over paired months ERA5 totals are 0.99x Banding Agung (1985-1995, 109 months) and 1.01x Belitang (1985-2001, 176 months), monthly correlation 0.50 and 0.74; ERA5 annual 1-day maxima at the same cells are about 0.66x (77 vs 117 mm) and 0.52x (54 vs 104 mm) the gauge maxima.","ERA5-Land via Open-Meteo returned no precipitation for these points, so ERA5 (0.25 deg) is used.","CHIRPS not used: the UCSB data server's robots.txt disallows all automated access."]},
      "units":"mm",
      "monthly_mean_1991_2020":[round(v,1) for v in r['m9120']],
      "monthly_mean_2015_2024":[round(v,1) for v in r['m1524']],
      "monthly_p10":[round(v,1) for v in r['p10']],
      "monthly_p90":[round(v,1) for v in r['p90']],
      "annual":{str(k):round(v,1) for k,v in r['ann'].items()},
      "daily_basin_mean":{"start":r['t0'],"step":"1 day","scale":0.1,"values":[int(round(v*10)) for v in r['basin']]},
      "max1day":{str(k):round(v,1) for k,v in r['mx1'].items()},
      "max3day":{str(k):round(v,1) for k,v in r['mx3'].items()},
      "gumbel":{"max1day":r['g1'],"max3day":r['g3']},
      "evap_monthly_mm":[round(v,1) for v in r['ev']]}
    s=json.dumps(out,separators=(',',':')); open(OUTJ,'w').write(s); print('wrote',len(s))
