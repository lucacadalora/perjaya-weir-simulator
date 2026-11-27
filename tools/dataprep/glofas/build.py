import os as _os  # paths for the public repo: REPO = repository root, WORK = scratch folder for downloads
REPO = _os.path.abspath(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "..", ".."))
WORK = _os.environ.get("PERJAYA_WORK", _os.path.join(REPO, ".scratch", "work"))
import json, sys, os, math, datetime
import numpy as np
SRC = WORK + '/lanes/r07/glofas_-4.30_104.35.json'
OUT = REPO + '/site/data/climate/flow_glofas.json'
assert os.path.realpath(OUT) == OUT
d = json.load(open(SRC)); t = d['daily']['time']; v = d['daily']['river_discharge']
i0 = next(i for i, x in enumerate(v) if x is not None)
t = t[i0:]; v = v[i0:]
assert all(x is not None for x in v), 'gap inside series'
a = np.array(v, float); dates = [datetime.date.fromisoformat(s) for s in t]
mon = np.array([x.month for x in dates]); yr = np.array([x.year for x in dates])
mm = [round(float(a[mon == m].mean()), 1) for m in range(1, 13)]
p10 = [round(float(np.percentile(a[mon == m], 10)), 1) for m in range(1, 13)]
p90 = [round(float(np.percentile(a[mon == m], 90)), 1) for m in range(1, 13)]
amax = {str(y): round(float(a[yr == y].max()), 1) for y in sorted(set(yr))}
full = [y for y in sorted(set(yr)) if (yr == y).sum() >= 365]
x = np.array([a[yr == y].max() for y in full]); mu, sd = x.mean(), x.std(ddof=1)
def q(T):
    K = -(math.sqrt(6) / math.pi) * (0.5772 + math.log(math.log(T / (T - 1))))
    return round(float(mu + K * sd), 0)
ff = {"method": "Gumbel", "fit": "method of moments on annual maxima of complete years %d-%d (n=%d), K_T = -(sqrt6/pi)(0.5772+ln ln(T/(T-1)))" % (full[0], full[-1], len(full))}
for T in (2, 5, 10, 25, 50, 100): ff['Q%d' % T] = q(T)
ff['annual_max_mean'] = round(float(mu), 1); ff['annual_max_sd'] = round(float(sd), 1)
out = {"meta": {
  "source": "Copernicus Emergency Management Service, GloFAS v4 river discharge (seamless: consolidated reanalysis to 31 May 2025, then GloFAS day-1 forecast values), served by the Open-Meteo Flood API (flood-api.open-meteo.com/v1/flood, default model, cell_selection default)",
  "credit": "River discharge: Copernicus Emergency Management Service, GloFAS v4 (modelled), via Open-Meteo.com (CC BY 4.0); summary statistics computed by us",
  "licence": "Open-Meteo API data CC BY 4.0 (link to open-meteo.com next to the data; free API for non-commercial use only, under 10,000 calls a day); underlying GloFAS data under the Copernicus/CEMS licence (free, attribution required)",
  "point": {"lon": round(d['longitude'], 4), "lat": round(d['latitude'], 4)},
  "requested_point": {"lon": 104.35, "lat": -4.30},
  "cell": "0.05 deg GloFAS cell centred 4.275 S 104.375 E, the cell the weir point falls in; neighbours tested: 4.225 S 104.375 E mean 215.4, 4.275 S 104.325 E mean 211.7, 4.325 S 104.325 E (Martapura gauge cell) mean 207.8, 4.325 S 104.375 E mean 2.5 (a side stream, rejected); all main-river cells within 4 percent of each other",
  "fetched": "2026-11-23",
  "period": "%s to %s" % (t[0], t[-1]),
  "units": "m3/s, daily mean, day boundaries in UTC",
  "caveat": "Modelled reanalysis, not a measurement: GloFAS v4 is a global hydrological model (LISFLOOD on a 0.05 deg grid) driven by ERA5 weather. It does not know Bendung Perjaya, its gates, the Komering canal intakes or Danau Ranau's outlet control, and it is not calibrated to any public Komering gauge. Open-Meteo serves this point only from 1997-01-01 (1984-1996 returned empty), so no values before 1997 are given. The mean (about 214 m3/s) is about 9 percent below the JICA 2003 simulated natural annual mean for Komering 1 (235.9 m3/s, 4,527 km2). Dry-season low flows are far too low: the model falls to about 2 m3/s in droughts, while JICA gives a 10-year 355th-day flow of 23.0 m3/s and the irrigation project keeps 35 m3/s as river maintenance flow; do not use the low tail for design. 2026 is a part year and not in the flood fit.",
}, "monthly_mean": mm, "monthly_p10": p10, "monthly_p90": p90, "annual_max": amax,
 "flood_frequency": ff,
 "daily": {"start": t[0], "values": [round(float(z), 1) for z in a]}}
s = json.dumps(out, separators=(',', ':'), ensure_ascii=False)
open(OUT, 'w').write(s)
print(len(s), 'bytes'); print('mean', a.mean(), 'MM', mm); print('p10', p10); print('p90', p90); print(ff)
print('days<23', (a < 23).mean(), 'days<35', (a < 35).mean())
print({k: v for k, v in amax.items()})
lo = [(t[i], v[i]) for i in np.argsort(a)[:3]]; print('lowest', lo)
