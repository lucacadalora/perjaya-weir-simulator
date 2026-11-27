#!/usr/bin/env python3
"""Give every river and stream line in site/data/feat/rivers.geojson a drawn width, so a river keeps its water
when the map is zoomed in (lead, 24 Nov 2026: zoomed in on Sungai Selabung, the water was gone).

  w     drawn width in metres. DISPLAY ESTIMATE, not surveyed: w = 1.83 * A^0.5 (A = upstream area in km2 from
        grid/wide.acc.f32, the largest value within one cell of each vertex, the line's largest vertex value), set so
        Sungai Komering at Bendung Perjaya (about 4,318 km2) draws about 120 m wide, its width on the satellite
        picture at the weir (basemap.js). Clamped to 4..220 m.
  poly  1 on the pieces of Sungai Komering inside the river outline (feat/river_poly.geojson): there the filled
        outline carries the river up close and the line fades out (basemap.js). 0 elsewhere.

Run from the repo root:  python3 tools/geo/river_widths.py   (idempotent: it recomputes both properties)
"""
import json
import math
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FEAT = ROOT / 'site/data/feat'
GRID = ROOT / 'site/data/grid'

K, EXP, WMIN, WMAX = 1.83, 0.5, 4.0, 220.0


def load_acc():
    meta = json.loads((GRID / 'wide.json').read_text())
    raw = (GRID / 'wide.acc.f32').read_bytes()
    n = meta['cols'] * meta['rows']
    acc = struct.unpack('<%df' % n, raw[: 4 * n])
    return meta, acc


def acc_at(meta, acc, lon, lat):
    c = int((lon - meta['west']) / meta['cellsize_deg'])
    r = int((meta['north'] - lat) / meta['cellsize_deg'])
    best = 0.0
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            rr, cc = r + dr, c + dc
            if 0 <= rr < meta['rows'] and 0 <= cc < meta['cols']:
                best = max(best, acc[rr * meta['cols'] + cc])
    return best


def point_in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-300) + xi:
            inside = not inside
        j = i
    return inside


def in_poly(x, y, geom):
    polys = [geom['coordinates']] if geom['type'] == 'Polygon' else geom['coordinates']
    for p in polys:
        if point_in_ring(x, y, p[0]) and not any(point_in_ring(x, y, h) for h in p[1:]):
            return True
    return False


def main():
    meta, acc = load_acc()
    path = FEAT / 'rivers.geojson'
    fc = json.loads(path.read_text())
    outline = None
    rp = FEAT / 'river_poly.geojson'
    if rp.exists():
        for f in json.loads(rp.read_text())['features']:
            if f['properties'].get('kind') == 'river':
                outline = f['geometry']
    n = 0
    for f in fc['features']:
        p = f['properties']
        if p.get('kind') not in ('river', 'stream') or f['geometry']['type'] != 'LineString':
            continue
        coords = f['geometry']['coordinates']
        a = max(acc_at(meta, acc, x, y) for x, y in coords)
        p['w'] = round(max(WMIN, min(WMAX, K * math.pow(max(a, 0.0), EXP))), 1)
        p['poly'] = 0
        if outline and p.get('name') == 'Sungai Komering':
            mid = coords[len(coords) // 2]
            p['poly'] = 1 if in_poly(mid[0], mid[1], outline) else 0
        n += 1
    path.write_text(json.dumps(fc, separators=(',', ':')))
    ws = sorted(f['properties']['w'] for f in fc['features'] if 'w' in f['properties'])
    print(f'{n} lines; width m: min {ws[0]}, median {ws[len(ws)//2]}, max {ws[-1]}', file=sys.stderr)


if __name__ == '__main__':
    main()
