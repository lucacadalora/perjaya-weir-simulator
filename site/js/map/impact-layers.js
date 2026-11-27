// Impact layers: affected buildings as dots and flooded roads and rail as strong lines. Owner: lane b07.
// CONTRACT 4.5: reads the fields `impact.points` (Float32Array lon, lat pairs) and `impact.lines` (GeoJSON
// FeatureCollection, property `kind` 'road' | 'rail'); both are cleared when the fields are empty.
// Registers `legend.impact` on ctx.fields:
//   { title, note, items: [{ id, kind 'fill'|'dot'|'line'|'dash'|'outline', color, label, key, en, hatch?, edge? }] }
// (fill items: `edge` is the colour of the line round the flooded area; `hatch` true = shallow flood is hatched)
// (label already in the current language; key + en let a reader translate it again). Re-set on a language change.
// Sources / layers: 'b07-pts' (circle 'b07-pts'), 'b07-lines' (line 'b07-lines-casing', 'b07-roads', 'b07-rail').

import { FLOOD_STEPS, FLOOD_EDGE, RES_STYLE } from './floodmask.js';

const EMPTY = { type: 'FeatureCollection', features: [] };

function token(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (e) {
    return fallback;
  }
}

// Float32Array of lon, lat pairs -> GeoJSON points (at most 20,000 by contract; capped here too).
export function pointsToGeoJSON(arr, cap = 20000) {
  if (!arr || !arr.length) return EMPTY;
  const n = Math.min(cap, (arr.length / 2) | 0);
  const features = new Array(n);
  for (let i = 0; i < n; i++) {
    features[i] = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [arr[2 * i], arr[2 * i + 1]] } };
  }
  return { type: 'FeatureCollection', features };
}

const rgba = (c) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + c[3] + ')';

export function legendItems(ctx, colors) {
  const it = (id, kind, color, key, en) => ({ id, kind, color, key, en, label: ctx.t(key, en) });
  return [
    ...FLOOD_STEPS.map((s, i) => ({ ...it('flood-' + s.id, 'fill', rgba([...s.rgb, s.a]), s.key, s.en), hatch: i === 0, edge: rgba([...FLOOD_EDGE.rgb, 1]) })),
    it('buildings', 'dot', colors.dot, 'impact.legend.buildings', 'Building in the flooded area'),
    it('roads', 'line', colors.road, 'impact.legend.roads', 'Flooded road'),
    it('rail', 'dash', colors.rail, 'impact.legend.rail', 'Flooded railway'),
    it('reservoir', 'outline', rgba(RES_STYLE.edge), 'impact.legend.reservoir', 'Lake of the dam you placed'),
  ];
}

export async function init(ctx) {
  const map = ctx.map;
  if (!map || !ctx.fields || typeof map.addSource !== 'function') return;
  const colors = {
    dot: token('--flood', '#d9480f'),
    road: token('--danger', '#c0161f'),
    rail: token('--danger', '#c0161f'),
    casing: '#ffffff',
  };
  const before = map.getLayer('three') ? 'three' : undefined;
  map.addSource('b07-lines', { type: 'geojson', data: EMPTY });
  map.addSource('b07-pts', { type: 'geojson', data: EMPTY });
  const isRail = ['==', ['get', 'kind'], 'rail'];
  map.addLayer({ id: 'b07-lines-casing', type: 'line', source: 'b07-lines', layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': colors.casing, 'line-opacity': 0.9,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 5.5, 17, 9] } }, before);
  map.addLayer({ id: 'b07-roads', type: 'line', source: 'b07-lines', filter: ['!', isRail], layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': colors.road, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.4, 14, 3.2, 17, 6] } }, before);
  map.addLayer({ id: 'b07-rail', type: 'line', source: 'b07-lines', filter: isRail, layout: { 'line-join': 'round' },
    paint: { 'line-color': colors.rail, 'line-dasharray': [2, 1.2],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.6, 14, 3.4, 17, 6] } }, before);
  map.addLayer({ id: 'b07-pts', type: 'circle', source: 'b07-pts',
    paint: { 'circle-color': colors.dot, 'circle-stroke-color': '#ffffff',
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 13, 2.4, 15, 3.6, 17, 5.5],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0, 13, 0.6, 16, 1.2],
      'circle-pitch-alignment': 'map' } }, before);

  const stats = (window.__b07 = window.__b07 || {});
  stats.impact = { points: 0, lines: 0, ms: null };

  const setPts = (arr) => {
    const t0 = performance.now();
    const gj = pointsToGeoJSON(arr);
    map.getSource('b07-pts')?.setData(gj);
    stats.impact.points = gj.features.length;
    stats.impact.ms = Math.round(performance.now() - t0);
  };
  const setLines = (fc) => {
    const ok = fc && Array.isArray(fc.features) && fc.features.length ? fc : EMPTY;
    map.getSource('b07-lines')?.setData(ok);
    stats.impact.lines = ok.features.length;
  };
  ctx.fields.on('impact.points', setPts);
  ctx.fields.on('impact.lines', setLines);
  if (ctx.fields.get('impact.points')) setPts(ctx.fields.get('impact.points'));
  if (ctx.fields.get('impact.lines')) setLines(ctx.fields.get('impact.lines'));

  const legend = () =>
    ctx.fields.set('legend.impact', {
      title: ctx.t('impact.legend.title', 'On the map'),
      note: ctx.t('impact.legend.note', 'Drawn on a 30 m surface model that includes tree tops and roofs.'),
      items: legendItems(ctx, colors),
    });
  legend();
  ctx.store.on('lang', legend);
}
