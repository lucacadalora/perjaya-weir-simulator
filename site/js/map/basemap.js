// Base map. Owner: lane b05. CONTRACT 2.7, 4.4 (`view`), 5.
// Three bases switched by store key view.base: 'topo' (paper, land-cover tint, hillshade, contours), 'sat' (the
// satellite picture) and 'blend' (satellite darkened by hillshade, with contours; the default). Over every base:
// lakes and river areas, rivers, canals in their own colour, roads by class with casings, rail, admin lines, building
// footprints and names. Each group follows its view.layers flag. All names sit in the top layers, above the 3D scene,
// and never overlap each other (MapLibre collision; nothing here allows overlap).
// Sources added: b05-rivers, b05-lakes, b05-roads, b05-roads-fine, b05-rail, b05-places, b05-admin, b05-contours-wide,
// b05-contours-fine, b05-buildings (added when the flag first turns on), b05-lc (image).
// Anchors for other lanes (empty layers): 'b05-under-roads' (above water and contours, below roads, rail, buildings)
// and 'b05-under-labels' (above all base lines, below every name). Use map.addLayer(layer, 'b05-under-labels').
// ctx.basemap.raiseLabels() puts the names back on top after a lane added a layer at the very top.

import { WATER as PALETTE, RIVER } from './water/palette.js';

const FONT = ['Noto Sans Regular'];
const FONT_M = ['Noto Sans Medium'];
const HALO = '#ffffff';
const INK = '#1d2833';
// A8.1: one water colour family, from lane b06's palette (shallow for fills, body for outlines and names);
// canals take the deep tone of the same family so they stay distinct from the river.
const WATER = PALETTE.body;
const SHALLOW = PALETTE.shallow;
// proposed A10 (lane w): river areas and river lines up close take the river's real colour; lakes, ponds and
// reservoirs keep the blue family (Danau Ranau is a clear lake)
const RIVER_FILL = RIVER.map;
const CANAL = PALETTE.deep;
// The fine data box (contours_fine, roads_fine): from tiles/terrain/tiles.json "fine_bounds_z13". FALLBACK if absent.
const FINE_BOX = [104.2, -4.5, 104.55, -4.1];

const boxPoly = (b) => ({ type: 'Polygon', coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]] });
const notInFine = (b) => ['!', ['within', { type: 'Feature', properties: {}, geometry: boxPoly(b) }]];
// River names by the length of the named river (km, from chainNamed): long rivers from afar, all of them up close;
// Sungai Komering always. In films only rivers of at least FILM_RIVER_KM.
const FILM_RIVER_KM = 80;
// Contour inks: warm brown on the drawn bases, light cream on the satellite photo ('sat').
const CONTOUR_INK = { minor: '#7a5636', index: '#5e3f22', label: '#5e3f22' };
const CONTOUR_SAT = { minor: '#fff4e0', index: '#fffaf0', label: '#3d2a17' };
const elevText = (lang, key = 'e') => ['concat', ['number-format', ['get', key], { locale: lang === 'en' ? 'en' : 'id', 'max-fraction-digits': 1 }], ' m'];
const riverMinF = (km) => ['any', ['>=', ['coalesce', ['get', 'km'], 0], km], ['==', ['get', 'name'], 'Sungai Komering']];
const zoomed = (pairs) => ['interpolate', ['linear'], ['zoom'], ...pairs];

// Land-cover tints (WorldCover class code -> light colour), drawn only on the topo base.
const LC_TINT = {
  10: [196, 219, 184], 20: [214, 224, 180], 30: [226, 233, 196], 40: [241, 233, 186], 50: [226, 204, 196],
  60: [234, 228, 214], 80: [176, 208, 232], 90: [198, 225, 218], 95: [178, 212, 192],
};

function absUrl(rel) {
  return new URL(rel, location.href).href.replace(/%7B/g, '{').replace(/%7D/g, '}');
}

function sourceDefs(ctx) {
  const g = (p) => ({ type: 'geojson', data: absUrl(ctx.data.url('feat/' + p)), tolerance: 0.3, buffer: 64 });
  return {
    'b05-contours-wide': g('contours_wide.geojson'),
    'b05-contours-fine': g('contours_fine.geojson'),
    'b05-lakes': g('lakes.geojson'),
    'b05-rivers': g('rivers.geojson'),
    'b05-admin': g('admin.geojson'),
    'b05-roads': g('roads.geojson'),
    'b05-roads-fine': g('roads_fine.geojson'),
    'b05-rail': g('rail.geojson'),
    'b05-places': g('places.geojson'),
  };
}

// Road widths by class (px at zoom 10, 13, 16). Classes as in roads(.fine).geojson.
const ROAD = {
  motorway: { w: [2.2, 5, 11], c: '#e8925a' },
  trunk: { w: [2, 4.5, 10], c: '#f0a96a' },
  primary: { w: [1.6, 4, 9], c: '#f6c77e' },
  secondary: { w: [1.2, 3.4, 8], c: '#fbe29a' },
  tertiary: { w: [0.8, 2.6, 7], c: '#ffffff' },
  minor: { w: [0, 1.4, 5], c: '#ffffff' }, // residential, unclassified, living_street, service, unknown
  track: { w: [0, 0.8, 2.4], c: '#f4efe6' }, // track, path, steps
};
const MINOR = ['residential', 'unclassified', 'living_street', 'service', 'unknown'];
const TRACK = ['track', 'path', 'steps'];
const classMatch = (fn) => ['match', ['get', 'class'],
  'motorway', fn(ROAD.motorway), 'trunk', fn(ROAD.trunk), 'primary', fn(ROAD.primary), 'secondary', fn(ROAD.secondary),
  'tertiary', fn(ROAD.tertiary), MINOR, fn(ROAD.minor), fn(ROAD.track)];
const roadWidth = (extra) => zoomed([7, classMatch((r) => (r.w[0] >= 1 ? r.w[0] * 0.45 + extra * 0.3 : 0)), 10, classMatch((r) => r.w[0] + (r.w[0] ? extra * 0.6 : 0)),
  13, classMatch((r) => r.w[1] + extra), 16, classMatch((r) => r.w[2] + extra * 1.4)]);

function roadLayers(id, source, filter, minzoom, maxzoom) {
  const base = { source, minzoom, ...(maxzoom ? { maxzoom } : {}), layout: { 'line-cap': 'round', 'line-join': 'round' } };
  return [
    { ...base, id: id + '-case', type: 'line', filter, group: 'roads',
      paint: { 'line-color': '#8a7f72', 'line-width': roadWidth(1.6), 'line-opacity': zoomed([7, 0.35, 11, 0.9]) } },
    { ...base, id: id + '-fill', type: 'line', filter, group: 'roads',
      paint: { 'line-color': classMatch((r) => r.c), 'line-width': roadWidth(0), 'line-opacity': zoomed([7, 0.7, 10, 1]) } },
  ];
}

// Every layer of the base map, bottom to top, with the group (view.layers flag) it follows and its place:
// 'base' layers go under the 3D scene, 'label' layers on top of everything.
function layerDefs(ctx, fine) {
  const T = (k, en) => ctx.t(k, en);
  const out = [];
  const add = (l) => out.push(l);
  // contours: wide 100 m everywhere outside the fine box, fine 12.5 m inside it from zoom 10.5
  const contour = (id, src, filter, index, minzoom) => add({ id, type: 'line', source: src, filter, minzoom, group: 'contours',
    layout: { 'line-join': 'round' },
    paint: { 'line-color': index ? '#7a5634' : '#8c6a48', 'line-opacity': index ? 0.7 : 0.42,
      'line-width': zoomed([8, index ? 0.7 : 0.4, 14, index ? 1.4 : 0.8, 17, index ? 2 : 1.1]) } });
  const wideIdx = ['==', ['%', ['get', 'e'], 500], 0];
  const fineIdx = ['==', ['%', ['get', 'e'], 50], 0];
  const wideLow = (l) => add({ ...l, maxzoom: 10.5 });
  const wideOut = (id, f, idx) => contour(id, 'b05-contours-wide', ['all', f, notInFine(fine)], idx, 10.5);
  contour('b05-contour-wide', 'b05-contours-wide', ['!', wideIdx], false, 6);
  contour('b05-contour-wide-index', 'b05-contours-wide', wideIdx, true, 6);
  for (const l of out.splice(-2)) wideLow(l);
  wideOut('b05-contour-wide-out', ['!', wideIdx], false);
  wideOut('b05-contour-wide-out-index', wideIdx, true);
  contour('b05-contour-fine', 'b05-contours-fine', ['!', fineIdx], false, 10.5);
  contour('b05-contour-fine-index', 'b05-contours-fine', fineIdx, true, 10.5);
  // lakes and river areas
  // the settling basins (Bak Desilting Perjaya) are built in 3D with their own water and mud (structures/site.js,
  // lane s 24 Nov 2026): their flat map outline would show between and beside the 3D basins
  const notBasins = ['!=', ['get', 'name'], 'Bak Desilting Perjaya'];
  add({ id: 'b05-lakes', type: 'fill', source: 'b05-lakes', group: 'water', filter: notBasins,
    paint: { 'fill-color': ['case', ['==', ['get', 'kind'], 'river'], RIVER_FILL, SHALLOW], 'fill-opacity': 0.8, 'fill-antialias': true } });
  add({ id: 'b05-lakes-edge', type: 'line', source: 'b05-lakes', minzoom: 11, group: 'water', filter: notBasins,
    paint: { 'line-color': WATER, 'line-width': zoomed([11, 0.6, 16, 1.6]), 'line-opacity': 0.9 } });
  // rivers: casing so the line stays crisp on the satellite picture, then the line
  const riverF = ['match', ['get', 'kind'], ['river', 'stream'], true, false];
  const isKom = ['==', ['get', 'name'], 'Sungai Komering'];
  // Line width: a drawn width in screen points far out, the river's own width up close (lead, 24 Nov 2026: zoomed in
  // on Sungai Selabung the water was gone). `w` = drawn width in metres per line, a DISPLAY ESTIMATE from the upstream
  // area (tools/geo/river_widths.py); metres to points at zoom z = 2^z / RIVER_M_PX0 (512-point tiles, latitude of
  // the basin). Whichever is wider wins, so a river never gets thinner as you zoom in.
  const RIVER_M_PX0 = 78052; // metres per point at zoom 0, 40,075 km x cos(4.3 deg) / 512
  const styleW = (z, kom) => {
    const s = kom ? [[6, 1.5], [10, 2.6], [13, 3.6], [16, 4.5]] : [[6, 0.6], [10, 1.3], [13, 2.4], [16, 4.5]];
    if (z <= s[0][0]) return s[0][1];
    for (let i = 1; i < s.length; i++) if (z <= s[i][0]) return s[i - 1][1] + ((s[i][1] - s[i - 1][1]) * (z - s[i - 1][0])) / (s[i][0] - s[i - 1][0]);
    return s[s.length - 1][1];
  };
  const rw = (x) => {
    const stops = [];
    for (const z of [6, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22]) {
      const own = ['*', ['coalesce', ['get', 'w'], 0], Math.pow(2, z) / RIVER_M_PX0];
      stops.push(z, ['+', ['max', ['case', isKom, styleW(z, true), styleW(z, false)], own], x]);
    }
    return ['interpolate', ['exponential', 2], ['zoom'], ...stops];
  };
  const riverW = rw(0);
  // Sungai Komering as a band of its true width (about 120 m, read from the satellite picture at the weir) until
  // lane g06's river_poly.geojson exists; then 'b05-river-poly' fills the real outline and this band is hidden.
  add({ id: 'b05-komering-band', type: 'line', source: 'b05-rivers', minzoom: 11, group: 'water', riverBand: true,
    filter: ['==', ['get', 'name'], 'Sungai Komering'], layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': RIVER_FILL, 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 11, 1.6, 18, 205] } });
  // far out a white casing keeps the line crisp; up close, where the line is the river's own width, the casing
  // becomes its bank line and the line takes the river-area colour (as lakes and the Komering outline)
  add({ id: 'b05-river-case', type: 'line', source: 'b05-rivers', filter: riverF, group: 'water',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': zoomed([12, HALO, 14, WATER]), 'line-opacity': zoomed([8, 0, 11, 0.75, 14, 0.9]), 'line-width': rw(2) } });
  add({ id: 'b05-river', type: 'line', source: 'b05-rivers', filter: riverF, group: 'water',
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': zoomed([12, WATER, 14, RIVER_FILL]), 'line-width': riverW } });
  // canals (own colour), ditches and drains finer and later
  const canalF = ['==', ['get', 'kind'], 'canal'];
  const ditchF = ['match', ['get', 'kind'], ['ditch', 'drain'], true, false];
  add({ id: 'b05-ditch', type: 'line', source: 'b05-rivers', filter: ditchF, minzoom: 11.5, group: 'canals',
    layout: { 'line-cap': 'round' }, paint: { 'line-color': CANAL, 'line-opacity': 0.8, 'line-width': zoomed([11.5, 0.5, 16, 2]) } });
  add({ id: 'b05-canal-case', type: 'line', source: 'b05-rivers', filter: canalF, group: 'canals',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': HALO, 'line-opacity': 0.85, 'line-width': zoomed([7, 2.4, 12, 4.4, 16, 8]) } });
  add({ id: 'b05-canal', type: 'line', source: 'b05-rivers', filter: canalF, group: 'canals',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': CANAL, 'line-width': zoomed([7, 1.2, 12, 2.6, 16, 5.5]) } });
  add({ id: 'b05-under-roads', type: 'background', layout: { visibility: 'none' }, group: 'anchor' });
  // admin lines
  add({ id: 'b05-admin-kec', type: 'line', source: 'b05-admin', filter: ['==', ['get', 'level'], 'kecamatan'], minzoom: 9,
    group: 'admin', paint: { 'line-color': '#8a6fa8', 'line-opacity': 0.6, 'line-width': 0.8, 'line-dasharray': [3, 2] } });
  add({ id: 'b05-admin-kab', type: 'line', source: 'b05-admin', filter: ['==', ['get', 'level'], 'kabupaten'],
    group: 'admin', paint: { 'line-color': '#6d4f91', 'line-opacity': 0.8, 'line-width': zoomed([7, 1, 12, 2]), 'line-dasharray': [4, 2, 1, 2] } });
  // roads: the basin file below zoom 11.5 everywhere and outside the fine box above it; the fine file above 11.5
  const isMajor = ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'], true, false];
  out.push(...roadLayers('b05-road-low', 'b05-roads', true, 6, 11.5));
  out.push(...roadLayers('b05-road-out', 'b05-roads', notInFine(fine), 11.5));
  const isTrack = ['match', ['get', 'class'], TRACK, true, false];
  out.push(...roadLayers('b05-road-track', 'b05-roads-fine', isTrack, 14));
  out.push(...roadLayers('b05-road-fine', 'b05-roads-fine', ['!', isTrack], 11.5));
  // rail: dark line with white ticks
  add({ id: 'b05-rail-case', type: 'line', source: 'b05-rail', group: 'roads',
    paint: { 'line-color': '#3b3b3b', 'line-width': zoomed([7, 1.6, 13, 3.4, 16, 5]) } });
  add({ id: 'b05-rail', type: 'line', source: 'b05-rail', minzoom: 10, group: 'roads',
    paint: { 'line-color': '#ffffff', 'line-width': zoomed([10, 0.8, 13, 1.8, 16, 2.8]), 'line-dasharray': [3, 3] } });
  add({ id: 'b05-buildings', type: 'fill', source: 'b05-buildings', minzoom: 13.5, group: 'buildings', lazy: true,
    paint: { 'fill-color': '#e9d6bc', 'fill-opacity': zoomed([13.5, 0, 14, 0.85, 16, 0.95]), 'fill-outline-color': '#6e5a45' } });
  add({ id: 'b05-buildings-edge', type: 'line', source: 'b05-buildings', minzoom: 15, group: 'buildings', lazy: true,
    paint: { 'line-color': '#6e5a45', 'line-width': zoomed([15, 0.5, 18, 1.2]) } });
  add({ id: 'b05-under-labels', type: 'background', layout: { visibility: 'none' }, group: 'anchor' });
  out.push(...labelDefs(ctx, T, isMajor));
  return out;
}

// Names, bottom to top. MapLibre places the top layers first, so towns win over villages, villages over rivers,
// rivers over roads, roads over contour heights. No layer allows overlap: a name that would collide is not drawn.
function labelDefs(ctx, T, isMajor) {
  const halo = { 'text-halo-color': HALO, 'text-halo-width': 1.6, 'text-halo-blur': 0.2 };
  const lbl = (l) => ({ ...l, type: 'symbol', group: l.group || 'labels', label: true,
    layout: { 'text-font': FONT, 'text-padding': 3, 'text-pitch-alignment': 'viewport', 'text-rotation-alignment': l.layout?.['symbol-placement'] ? 'map' : 'viewport', ...l.layout },
    paint: { 'text-color': INK, ...halo, ...l.paint } });
  const lineLbl = (size) => ({ 'symbol-placement': 'line', 'text-max-angle': 30, 'symbol-spacing': 320, 'text-size': size });
  const elev = (lang) => elevText(lang);
  const lang = ctx.store.get('lang');
  const named = ['all', ['has', 'name'], ['!=', ['get', 'name'], null], ['!=', ['get', 'name'], '']];
  return [
    lbl({ id: 'b05-contour-label-wide', source: 'b05-contours-wide', minzoom: 9, maxzoom: 10.5, group: 'contours',
      filter: ['==', ['%', ['get', 'e'], 500], 0], layout: { ...lineLbl(10), 'text-field': elev(lang), 'symbol-spacing': 500 },
      paint: { 'text-color': '#6b4a2b' } }),
    lbl({ id: 'b05-contour-label-fine', source: 'b05-contours-fine', minzoom: 12, group: 'contours',
      filter: ['==', ['%', ['get', 'e'], 50], 0], layout: { ...lineLbl(11), 'text-field': elev(lang) },
      paint: { 'text-color': '#6b4a2b' } }),
    lbl({ id: 'b05-road-label', source: 'b05-road-names', minzoom: 10.5, maxzoom: 13, group: 'roads',
      filter: named, layout: { ...lineLbl(11), 'text-field': ['get', 'name'], 'symbol-spacing': 420 },
      paint: { 'text-color': '#4a3b2c' } }),
    lbl({ id: 'b05-road-label-fine', source: 'b05-roads-fine', minzoom: 13, group: 'roads',
      filter: named, layout: { ...lineLbl(12), 'text-field': ['get', 'name'] }, paint: { 'text-color': '#4a3b2c' } }),
    lbl({ id: 'b05-canal-label', source: 'b05-rivers', minzoom: 10, group: 'canals',
      // only named canals: the main canal is unnamed in the map data and lane b23 names it from facts.json
      filter: ['all', named, ['match', ['get', 'kind'], ['canal', 'drain'], true, false]],
      layout: { ...lineLbl(12), 'text-font': FONT_M, 'text-field': ['get', 'name'], 'symbol-spacing': 360 },
      paint: { 'text-color': CANAL } }),
    lbl({ id: 'b05-lake-label', source: 'b05-lakes', minzoom: 11, group: 'water',
      filter: ['all', named, ['match', ['get', 'kind'], ['lake', 'reservoir'], true, false], ['!=', ['get', 'name'], 'Danau Ranau'], ['!', ['in', 'PT', ['get', 'name']]],
        // A8.3: the settling basins are named by lane b09's leader label, not by their map name
        ['!', ['in', 'Desilting', ['get', 'name']]]],
      layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-max-width': 8, 'text-padding': 40 }, paint: { 'text-color': WATER } }),
    // the big lake keeps its name from the basin view; other lakes from zoom 11
    lbl({ id: 'b05-lake-label-big', source: 'b05-lakes', minzoom: 7, group: 'water', filter: ['==', ['get', 'name'], 'Danau Ranau'],
      layout: { 'text-field': ['get', 'name'], 'text-size': 13, 'text-font': FONT_M }, paint: { 'text-color': WATER } }),
    // villages from zoom 12.5, hamlets and neighbourhoods from 13.5; none while a film is recorded (view.film)
    lbl({ id: 'b05-place-hamlet', source: 'b05-places', minzoom: 13.5, film: false,
      filter: ['match', ['get', 'kind'], ['city', 'town', 'village'], false, true],
      layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-max-width': 8,
        'text-variable-anchor': ['center', 'top', 'bottom', 'left', 'right'], 'text-radial-offset': 0.4 } }),
    lbl({ id: 'b05-place-village', source: 'b05-places', minzoom: 12.5, film: false,
      filter: ['==', ['get', 'kind'], 'village'],
      layout: { 'text-field': ['get', 'name'], 'text-size': zoomed([12.5, 12, 15, 13.5]), 'text-max-width': 8,
        'text-variable-anchor': ['center', 'top', 'bottom', 'left', 'right'], 'text-radial-offset': 0.4,
        'symbol-sort-key': ['match', ['get', 'kind'], 'village', 1, 2] } }),
    lbl({ id: 'b05-river-label', source: 'b05-river-names', minzoom: 7.5, maxzoom: 9.5, group: 'water',
      filter: riverMinF(40), riverKm: 40,
      layout: { ...lineLbl(zoomed([8, 11.5, 13, 13, 16, 15])), 'text-font': FONT_M, 'text-letter-spacing': 0.06,
        'text-field': ['get', 'name'], 'symbol-spacing': 700, 'text-max-angle': 45,
        'symbol-sort-key': ['case', ['==', ['get', 'name'], 'Sungai Komering'], 0, 1] },
      paint: { 'text-color': WATER } }),
    lbl({ id: 'b05-river-label-mid', source: 'b05-river-names-mid', minzoom: 9.5, maxzoom: 11.5, group: 'water',
      filter: riverMinF(12), riverKm: 12,
      layout: { ...lineLbl(zoomed([8, 11.5, 13, 13, 16, 15])), 'text-font': FONT_M, 'text-letter-spacing': 0.06,
        'text-field': ['get', 'name'], 'symbol-spacing': 420, 'text-max-angle': 45,
        'symbol-sort-key': ['case', ['==', ['get', 'name'], 'Sungai Komering'], 0, 1] },
      paint: { 'text-color': WATER } }),
    lbl({ id: 'b05-river-label-near', source: 'b05-river-names-near', minzoom: 11.5, group: 'water',
      filter: riverMinF(0), riverKm: 0,
      layout: { ...lineLbl(zoomed([8, 11.5, 13, 13, 16, 15])), 'text-font': FONT_M, 'text-letter-spacing': 0.06,
        'text-field': ['get', 'name'], 'symbol-spacing': 300, 'text-max-angle': 45,
        'symbol-sort-key': ['case', ['==', ['get', 'name'], 'Sungai Komering'], 0, 1] },
      paint: { 'text-color': WATER } }),
    lbl({ id: 'b05-place-town', source: 'b05-places', minzoom: 6,
      filter: ['match', ['get', 'kind'], ['city', 'town'], true, false],
      layout: { 'text-field': ['get', 'name'], 'text-font': FONT_M, 'text-max-width': 8,
        'text-size': zoomed([6, ['match', ['get', 'kind'], 'city', 13, 12], 10, ['match', ['get', 'kind'], 'city', 16, 14],
          14, ['match', ['get', 'kind'], 'city', 18, 16]]),
        'text-variable-anchor': ['center', 'top', 'bottom', 'left', 'right'], 'text-radial-offset': 0.4,
        'symbol-sort-key': ['match', ['get', 'kind'], 'city', 0, 1] },
      paint: { 'text-halo-width': 2 } }),
  ];
}

// Land-cover tint: one image source drawn from wide.lc.u8 (3 arc-seconds over the basin), shown on the topo base.
async function landCoverImage(ctx) {
  const meta = await ctx.data.json('grid/lc.json');
  const w = meta.wide;
  const buf = new Uint8Array(await ctx.data.bin('grid/' + w.file));
  if (buf.length !== w.cols * w.rows) throw new Error('land cover grid size');
  const cv = document.createElement('canvas');
  cv.width = w.cols;
  cv.height = w.rows;
  const g = cv.getContext('2d');
  const img = g.createImageData(w.cols, w.rows);
  const px = img.data;
  for (let i = 0; i < buf.length; i++) {
    const c = LC_TINT[buf[i]];
    if (!c) continue;
    const o = i * 4;
    px[o] = c[0];
    px[o + 1] = c[1];
    px[o + 2] = c[2];
    px[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
  return { url: URL.createObjectURL(blob), coordinates: [[w.west, w.north], [w.east, w.north], [w.east, w.south], [w.west, w.south]] };
}

// The default base's background and satellite paint, exported so lane b04 can create its 'bg' and 'sat' layers with
// them from the first frame (the map is never dark while the drawn layers load). A lighter, calmer picture at every
// zoom, fading to 0.25 over the drawn base by zoom 15 (CONTRACT A4).
export const PALE_BG = '#f3efe5';
export const BLEND_SAT = Object.freeze({
  'raster-opacity': zoomed([13, 1, 15, 0.25]),
  'raster-brightness-min': zoomed([8, 0.12, 13, 0.15, 15, 0.25]),
  'raster-brightness-max': 1,
  'raster-saturation': zoomed([8, -0.15, 13, -0.2, 15, -0.3]),
  'raster-contrast': zoomed([8, 0, 13, 0, 15, -0.1]),
});

// How each base paints the satellite layer (lane b04's 'sat'), the background and the hillshade.
const BASES = {
  topo: { sat: false, lc: true, bg: '#f3efe5',
    hs: { 'hillshade-shadow-color': '#4a3020', 'hillshade-highlight-color': 'rgba(255,248,236,0.55)', 'hillshade-accent-color': '#6b4e36',
      'hillshade-exaggeration': zoomed([8, 0.75, 13, 0.72, 16, 0.62]) } },
  sat: { sat: true, sat2026: true, lc: false, bg: '#e9e4d8',
    satPaint: { 'raster-opacity': 1, 'raster-saturation': 0, 'raster-contrast': 0, 'raster-brightness-min': 0, 'raster-brightness-max': 1 } },
  // CONTRACT A4: the 10 m picture is sharp from afar and a blur up close, so it fades over the drawn base by zoom 15
  blend: { sat: true, lc: true, bg: PALE_BG, satPaint: BLEND_SAT,
    // relief reads at every zoom (more contour lines were asked for); the shading DEM stops at zoom 12, so no tree crowns
    hs: { 'hillshade-shadow-color': '#4a3020', 'hillshade-highlight-color': 'rgba(255,248,236,0.45)', 'hillshade-accent-color': '#6b4e36',
      'hillshade-exaggeration': zoomed([8, 0.7, 13, 0.66, 16, 0.6]) } },
};

// Contour heights never print on the river (lane w proposal, 24 Nov 2026): the carved bed under the water has its
// own contours (70 m, 75 m), and their heights would print over the water. A height label whose contour lies inside
// the river outline is dropped ('within' on line features: the whole line inside).
let riverGeom = null;
let keepMap = null;
function waterGeom(g) {
  const polys = [];
  for (const f of (g && g.features) || []) {
    const geo = f.geometry || {};
    if (geo.type === 'Polygon') polys.push(geo.coordinates);
    else if (geo.type === 'MultiPolygon') polys.push(...geo.coordinates);
  }
  return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
}
function keepOffWater() {
  const map = keepMap;
  if (!riverGeom || !map) return;
  for (const l of map.getStyle().layers) {
    if (!/^b05-(dc|dc-out|dcf)-label$|^b05-contour-label-(fine|wide)$/.test(l.id)) continue;
    const f = map.getFilter(l.id);
    if (f && JSON.stringify(f).includes('"within"')) continue;
    map.setFilter(l.id, f ? ['all', f, ['!', ['within', riverGeom]]] : ['!', ['within', riverGeom]]);
  }
}

export async function init(ctx) {
  const map = ctx.map;
  keepMap = map;
  if (!map || !ctx.store) return;
  if (!map.isStyleLoaded()) await new Promise((res) => map.once('load', res));
  const store = ctx.store;
  let fine = FINE_BOX; // FALLBACK
  try {
    const tj = await ctx.data.json('tiles/terrain/tiles.json');
    if (Array.isArray(tj.fine_bounds_z13) && tj.fine_bounds_z13.length === 4) fine = tj.fine_bounds_z13;
  } catch (e) {
    ctx.log('basemap: terrain tiles.json not read, fine box fallback');
  }

  map.setGlyphs(new URL('../../vendor/glyphs/{fontstack}/{range}.pbf', import.meta.url).href.replace(/%7B/g, '{').replace(/%7D/g, '}'));
  for (const [id, src] of Object.entries(sourceDefs(ctx))) if (!map.getSource(id)) map.addSource(id, src);
  // River names run along whole rivers: the named pieces are chained end to end, so a name fits at basin zoom.
  if (!map.getSource('b05-river-names')) map.addSource('b05-river-names', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  if (!map.getSource('b05-river-names-mid')) map.addSource('b05-river-names-mid', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  if (!map.getSource('b05-river-names-near')) map.addSource('b05-river-names-near', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  ctx.data.json('feat/rivers.geojson').then((fc) => {
    const chained = chainNamed(fc);
    // a name only fits along a line that does not turn too much: far views get a smoothed copy of each river
    map.getSource('b05-river-names')?.setData(smoothed(chained, 0.015));
    map.getSource('b05-river-names-mid')?.setData(smoothed(chained, 0.004));
    map.getSource('b05-river-names-near')?.setData(smoothed(chained, 0.0012));
  }, () => {});
  if (!map.getSource('b05-road-names')) map.addSource('b05-road-names', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  ctx.data.json('feat/roads.geojson').then((fc) => map.getSource('b05-road-names')?.setData(smoothed(chainNamed(fc, () => true), 0.0008)), () => {});

  const below3d = () => (map.getLayer('three') ? 'three' : undefined);
  const meta = new Map(); // layer id -> { group, label }
  const pending = []; // lazy layers waiting for their source
  // hillshade from lane b04's 'terrain-hs' source (or the 3D terrain source), right above the satellite picture
  // Hillshade from lane b04's DEM, but read no deeper than zoom 12: the deeper tiles of a surface model carry tree
  // crowns and roofs, whose shading up close looks like a dark blurred photograph instead of ground relief.
  let hsSource = map.getSource('terrain-hs') ? 'terrain-hs' : map.getSource('terrain') ? 'terrain' : null;
  if (hsSource && !map.getSource('b05-hs-dem')) {
    try {
      const def = map.getStyle().sources[hsSource];
      map.addSource('b05-hs-dem', { ...def, maxzoom: Math.min(12, def.maxzoom ?? 12) });
      hsSource = 'b05-hs-dem';
    } catch (e) {
      ctx.log('basemap: own hillshade source not made', e && e.message);
    }
  } else if (map.getSource('b05-hs-dem')) hsSource = 'b05-hs-dem';
  if (hsSource && !map.getLayer('b05-hillshade')) {
    map.addLayer({ id: 'b05-hillshade', type: 'hillshade', source: hsSource,
      paint: { 'hillshade-illumination-direction': 315, 'hillshade-method': 'igor', ...BASES.blend.hs } }, below3d());
    meta.set('b05-hillshade', { group: 'base' });
  }
  for (const l of layerDefs(ctx, fine)) {
    const { group, label, lazy, riverBand, riverKm, film, ...spec } = l;
    meta.set(spec.id, { group, label: !!label, riverBand: !!riverBand, riverKm, film });
    if (lazy) {
      pending.push(spec);
      continue;
    }
    if (map.getLayer(spec.id)) continue;
    try {
      map.addLayer(spec, label ? undefined : below3d());
    } catch (e) {
      console.error('[basemap] layer ' + spec.id, e);
    }
  }
  const labelIds = () => [...meta].filter(([id, m]) => m.label && map.getLayer(id)).map(([id]) => id);
  const raiseLabels = () => {
    for (const id of labelIds()) map.moveLayer(id);
  };
  ctx.basemap = { raiseLabels, anchors: { underRoads: 'b05-under-roads', underLabels: 'b05-under-labels' }, layers: () => [...meta.keys()] };

  // Optional pictures and outlines from lane g06 (CONTRACT A4), used when they are on disk.
  const tileSrc = async (dir) => {
    const tj = await ctx.data.json('tiles/' + dir + '/tiles.json');
    const fileBase = new URL(ctx.data.url('tiles/' + dir + '/'), location.href).href;
    const tiles = (tj.tiles || []).map((u) => absUrl(new URL(u, u.startsWith('data/') ? new URL('../', new URL(ctx.data.url(''), location.href)) : fileBase).href));
    return { type: 'raster', tiles, tileSize: tj.tileSize || 256, minzoom: tj.minzoom ?? 11, maxzoom: tj.maxzoom ?? 15, ...(tj.bounds ? { bounds: tj.bounds } : {}) };
  };
  const there = async (path) => {
    try {
      const r = await fetch(ctx.data.url(path), { headers: { Range: 'bytes=0-0' } });
      await r.arrayBuffer();
      return r.ok;
    } catch (e) {
      return false;
    }
  };
  const extras = { lc10: false, sat2026: false, riverPoly: false };
  const addExtras = async () => {
    const [lc10, s26, rp] = await Promise.all([there('tiles/lc10/tiles.json'), there('tiles/sat2026/tiles.json'), there('feat/river_poly.geojson')]);
    try {
      if (lc10 && !map.getSource('b05-lc10')) {
        map.addSource('b05-lc10', await tileSrc('lc10'));
        const before = map.getLayer('sat') ? 'sat' : map.getLayer('b05-hillshade') ? 'b05-hillshade' : undefined;
        map.addLayer({ id: 'b05-lc10', type: 'raster', source: 'b05-lc10', minzoom: 11,
          paint: { 'raster-opacity': zoomed([11, 0, 11.6, 0.9]), 'raster-resampling': 'nearest', 'raster-fade-duration': ctx.shot ? 0 : 250 } }, before);
        meta.set('b05-lc10', { group: 'base' });
        extras.lc10 = true;
      }
      if (s26 && !map.getSource('b05-sat2026') && map.getLayer('sat')) {
        map.addSource('b05-sat2026', await tileSrc('sat2026'));
        const order = map.getStyle().layers.map((l) => l.id);
        const next = order[order.indexOf('sat') + 1];
        map.addLayer({ id: 'b05-sat2026', type: 'raster', source: 'b05-sat2026', minzoom: 12.5, layout: { visibility: 'none' },
          paint: { 'raster-fade-duration': 0 } }, next);
        meta.set('b05-sat2026', { group: 'base' });
        extras.sat2026 = true;
      }
      if (rp && !map.getSource('b05-river-poly')) {
        map.addSource('b05-river-poly', { type: 'geojson', data: absUrl(ctx.data.url('feat/river_poly.geojson')), tolerance: 0.2 });
        map.addLayer({ id: 'b05-river-poly', type: 'fill', source: 'b05-river-poly', filter: ['!=', ['get', 'kind'], 'basin'],
          paint: { 'fill-color': RIVER_FILL, 'fill-opacity': 0.95 } }, 'b05-river-case');
        map.addLayer({ id: 'b05-river-poly-edge', type: 'line', source: 'b05-river-poly', minzoom: 11, filter: ['!=', ['get', 'kind'], 'basin'],
          paint: { 'line-color': WATER, 'line-width': zoomed([11, 0.6, 15, 1.4, 18, 2.4]), 'line-opacity': zoomed([13, 1, 15, 0]) } }, 'b05-river-case');
        meta.set('b05-river-poly', { group: 'water' });
        meta.set('b05-river-poly-edge', { group: 'water' });
        extras.riverPoly = true;
        ctx.data.json('feat/river_poly.geojson').then((g) => { riverGeom = waterGeom(g); keepOffWater(); }).catch(() => {});
        // the filled outline carries Sungai Komering up close, so ITS line fades out there (`poly` = 1 on the pieces
        // inside the outline, tools/geo/river_widths.py). Every other river keeps its line at its own width: before
        // 24 Nov this fade hit every river and the water vanished when zoomed in anywhere else.
        const inPoly = ['==', ['coalesce', ['get', 'poly'], 0], 1];
        map.setPaintProperty('b05-river', 'line-opacity', zoomed([12, 1, 14, ['case', inPoly, 0, 1]]));
        map.setPaintProperty('b05-river-case', 'line-opacity', zoomed([8, 0, 11, 0.75, 12, 0.75, 14, ['case', inPoly, 0, 0.9]]));
      }
    } catch (e) {
      ctx.log('basemap: extra layers', e && e.message);
    }
    apply();
  };
  let lcAdded = false;
  const addLandCover = () =>
    landCoverImage(ctx).then((lc) => {
      if (map.getSource('b05-lc')) return;
      map.addSource('b05-lc', { type: 'image', url: lc.url, coordinates: lc.coordinates });
      const before = ['b05-lc10', 'sat', 'b05-hillshade'].find((id) => map.getLayer(id));
      map.addLayer({ id: 'b05-lc', type: 'raster', source: 'b05-lc',
        paint: { 'raster-opacity': 0.85, 'raster-resampling': 'linear', 'raster-fade-duration': ctx.shot ? 0 : 250 } }, before);
      meta.set('b05-lc', { group: 'base' });
      lcAdded = true;
      apply();
    }).catch((e) => ctx.log('basemap: land cover not drawn', e && e.message));

  const ensureBuildings = () => {
    if (!map.getSource('b05-buildings'))
      map.addSource('b05-buildings', { type: 'geojson', data: absUrl(ctx.data.url('feat/buildings_fine.geojson')), tolerance: 0.2 });
    for (const spec of pending.splice(0)) if (!map.getLayer(spec.id)) map.addLayer(spec, 'b05-under-labels');
  };

  let filmState = false;
  const vis = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  function apply() {
    const view = store.get('view') || {};
    const flags = view.layers || {};
    const base = BASES[view.base] ? view.base : 'blend';
    const b = BASES[base];
    if (flags.buildings) ensureBuildings();
    if (b.lc && !lcAdded) addLandCover();
    vis('sat', b.sat);
    if (b.sat && map.getLayer('sat')) for (const [k, v] of Object.entries(b.satPaint)) map.setPaintProperty('sat', k, v);
    if (map.getLayer('bg')) map.setPaintProperty('bg', 'background-color', b.bg);
    vis('b05-lc', b.lc);
    vis('b05-lc10', b.lc);
    vis('b05-sat2026', !!b.sat2026);
    vis('b05-hillshade', !!b.hs);
    if (b.hs && map.getLayer('b05-hillshade')) for (const [k, v] of Object.entries(b.hs)) map.setPaintProperty('b05-hillshade', k, v);
    const ink = base === 'sat' ? CONTOUR_SAT : CONTOUR_INK;
    for (const [id, m] of meta) {
      if (m.group !== 'contours' || !map.getLayer(id)) continue;
      const idx = /index/.test(id);
      if (m.label) map.setPaintProperty(id, 'text-color', ink.label);
      else {
        map.setPaintProperty(id, 'line-color', idx ? ink.index : ink.minor);
        map.setPaintProperty(id, 'line-opacity', base === 'sat' ? (idx ? 0.7 : 0.4) : idx ? 0.55 : 0.28);
      }
    }
    for (const [id, m] of meta) {
      if (m.group === 'base' || m.group === 'anchor') continue;
      const groupOn = m.group === 'water' || flags[m.group] !== false;
      vis(id, groupOn && (!m.label || flags.labels !== false) && !(m.riverBand && extras.riverPoly) && !(view.film && m.film === false));
    }
    // films (view.film, set by lane b10): only the main river names
    if (filmState !== !!view.film) {
      filmState = !!view.film;
      for (const [id, m] of meta)
        if (m.riverKm != null && map.getLayer(id)) map.setFilter(id, filmState ? riverMinF(FILM_RIVER_KM) : riverMinF(m.riverKm));
    }
  }
  function relabel() {
    const lang = store.get('lang');
    for (const id of ['b05-contour-label-wide', 'b05-contour-label-fine']) if (map.getLayer(id)) map.setLayoutProperty(id, 'text-field', elevText(lang));
    for (const [id, m] of meta) if (m.elev && map.getLayer(id)) map.setLayoutProperty(id, 'text-field', elevText(lang, 'ele'));
  }
  apply();
  addExtras();
  demContours(ctx, map, meta, apply).catch((e) => ctx.log('basemap: computed contours off', e && e.message));
  store.on('view', apply);
  store.on('lang', relabel);
  store.listen('app:ready', raiseLabels);

  try {
    const menu = await import('./layers-menu.js');
    await menu.init(ctx);
  } catch (e) {
    ctx.log('basemap: layers menu not started', e && e.message);
  }
}

// Join the pieces of each named river whose ends meet into longer lines (greedy, ends matched to about 1 m).
export function chainNamed(fc, keep = (p) => p.kind === 'river' || p.kind === 'stream') {
  const byName = new Map();
  for (const f of fc.features || []) {
    const p = f.properties || {};
    if (!p.name || !keep(p) || f.geometry?.type !== 'LineString') continue;
    if (!byName.has(p.name)) byName.set(p.name, []);
    byName.get(p.name).push(f.geometry.coordinates.slice());
  }
  const key = (c) => c[0].toFixed(5) + ',' + c[1].toFixed(5);
  const out = [];
  for (const [name, lines] of byName) {
    const left = new Set(lines.map((_, i) => i));
    while (left.size) {
      const first = left.values().next().value;
      left.delete(first);
      let line = lines[first];
      let grew = true;
      while (grew) {
        grew = false;
        for (const i of left) {
          const l = lines[i];
          const a = key(line[0]), b = key(line[line.length - 1]), c = key(l[0]), d = key(l[l.length - 1]);
          if (b === c) line = line.concat(l.slice(1));
          else if (b === d) line = line.concat(l.slice(0, -1).reverse());
          else if (a === d) line = l.concat(line.slice(1));
          else if (a === c) line = l.slice().reverse().concat(line.slice(1));
          else continue;
          left.delete(i);
          grew = true;
        }
      }
      let km = 0;
      for (let i = 1; i < line.length; i++)
        km += Math.hypot((line[i][0] - line[i - 1][0]) * Math.cos((line[i][1] * Math.PI) / 180), line[i][1] - line[i - 1][1]) * 111.32;
      out.push({ type: 'Feature', properties: { name, kind: 'river', class: 'named', km: Math.round(km) }, geometry: { type: 'LineString', coordinates: line } });
    }
  }
  return { type: 'FeatureCollection', features: out };
}

// Douglas-Peucker (tolerance in degrees) then two rounds of corner cutting: a calm line for a name to follow.
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > best) (best = d), (bi = i);
    }
    if (best > tol) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
function chaikin(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
export function smoothed(fc, tol) {
  return { type: 'FeatureCollection', features: fc.features.map((f) => ({ ...f,
    geometry: { type: 'LineString', coordinates: chaikin(chaikin(simplify(f.geometry.coordinates, tol))) } })) };
}

// ---- Contours computed in the browser from our own terrain tiles (library maplibre-contour 0.2.0, vendored) ----
// Minor and index interval (m) by zoom; a zoom without an entry uses the next lower one.
// Coarse enough that a steep slope reads as hatching, never as a fill.
export const CONTOUR_STEPS = { 9: [100, 500], 10: [50, 250], 11: [40, 200], 12: [20, 100], 13: [10, 50], 14: [5, 25] };
// Inside the fine box (flat land at the weir; terrain tiles to zoom 14 there) from zoom 14: close lines.
export const CONTOUR_STEPS_FINE = { 14: [2, 10], 15: [1, 5] };
const FINE_MINZOOM = 14;
const DEM_MAXZOOM = 12; // deeper terrain tiles exist only inside the fine box (and carry tree crowns)
const DEM_MINZOOM = 9; // below this the basin GeoJSON contours (100 m) are drawn: no interior tiles to compute from

// The box in which every computed tile has all 8 neighbouring terrain tiles on disk, at every zoom from DEM_MINZOOM:
// the tiles strictly inside the covered tile range at DEM_MINZOOM (deeper zooms only gain margin).
export function interiorBounds(b, z = DEM_MINZOOM) {
  const n = 2 ** z;
  const tx = (lon) => ((lon + 180) / 360) * n;
  const ty = (lat) => ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * n;
  const lon = (x) => (x / n) * 360 - 180;
  const lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const x0 = Math.floor(tx(b[0])) + 1, x1 = Math.floor(tx(b[2])) - 1, y0 = Math.floor(ty(b[3])) + 1, y1 = Math.floor(ty(b[1])) - 1;
  if (x1 < x0 || y1 < y0) return null;
  const e = 1e-6; // stay off the tile edges so no outer tile is touched
  return [lon(x0) + e, lat(y1 + 1) + e, lon(x1 + 1) - e, lat(y0) - e];
}

function loadScript(src) {
  if (window.mlcontour) return Promise.resolve(window.mlcontour);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => (window.mlcontour ? res(window.mlcontour) : rej(new Error('mlcontour missing')));
    s.onerror = () => rej(new Error('contour library not loaded'));
    document.head.appendChild(s);
  });
}

// Adds the computed contours; on the first tile it retires the GeoJSON contours inside the computed box.
// Any failure (script, worker blocked by a content policy, tile errors before the first tile) leaves the GeoJSON ones.
async function demContours(ctx, map, meta, apply) {
  if (typeof maplibregl === 'undefined' || typeof Worker === 'undefined') return;
  let lib;
  try {
    lib = await loadScript(new URL('../../vendor/maplibre-contour/maplibre-contour.min.js', import.meta.url).href);
  } catch (e) {
    return ctx.log('basemap: computed contours off', e.message);
  }
  let tj;
  try {
    tj = await ctx.data.json('tiles/terrain/tiles.json');
  } catch (e) {
    return;
  }
  const inner = interiorBounds(tj.bounds || [103.3, -5.2, 105.0, -3.5]); // FALLBACK bounds
  if (!inner) return;
  // the fine box: computed only where every z14 terrain tile and its neighbours are on disk
  const fineBox = tj.fine_bounds_z14 || tj.fine_bounds_z13 || FINE_BOX;
  const fineIn = (tj.maxzoom ?? 12) >= FINE_MINZOOM || tj.fine_bounds_z14 ? interiorBounds(fineBox, FINE_MINZOOM) : null;
  const stamp = window.__BUILD ? '?v=' + encodeURIComponent(window.__BUILD) : '';
  const url = new URL('./data/tiles/terrain/', new URL(ctx.data.url(''), location.href).href.replace(/data\/(\?.*)?$/, '')).href + '{z}/{x}/{y}.png' + stamp;
  const opts = (thresholds) => ({ multiplier: 1, thresholds, elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours', buffer: 1 });
  let ok = false;
  try {
    const dem = new lib.DemSource({ id: 'pjdem', url, encoding: tj.encoding || 'terrarium', maxzoom: DEM_MAXZOOM, minzoom: DEM_MINZOOM,
      sparse: true, worker: true, cacheSize: 120, timeoutMs: 20000 });
    dem.setupMaplibre(maplibregl);
    map.addSource('b05-dem-contours', { type: 'vector', minzoom: DEM_MINZOOM, maxzoom: 15, bounds: inner, tiles: [dem.contourProtocolUrl(opts(CONTOUR_STEPS))] });
    if (fineIn) {
      const demF = new lib.DemSource({ id: 'pjdemfine', url, encoding: tj.encoding || 'terrarium', maxzoom: FINE_MINZOOM, minzoom: DEM_MAXZOOM,
        sparse: true, worker: true, cacheSize: 80, timeoutMs: 20000 });
      demF.setupMaplibre(maplibregl);
      map.addSource('b05-dem-contours-fine', { type: 'vector', minzoom: FINE_MINZOOM, maxzoom: 16, bounds: fineIn,
        tiles: [demF.contourProtocolUrl(opts(CONTOUR_STEPS_FINE))] });
    }
  } catch (e) {
    return ctx.log('basemap: computed contours off', e && e.message);
  }
  const below = map.getLayer('b05-lakes') ? 'b05-lakes' : undefined;
  const lang = ctx.store.get('lang');
  const fineOut = fineIn ? ['!', ['within', { type: 'Feature', properties: {}, geometry: boxPoly(fineIn) }]] : true;
  const made = []; // [id, meta]
  // one set of layers per source and zoom band: line minor, line index, heights on the index lines
  const set = (pre, source, minzoom, maxzoom, area) => {
    const z = { minzoom, ...(maxzoom ? { maxzoom } : {}) };
    const f = (lv) => (area === true ? lv : ['all', lv, area]);
    const line = (idx) => ({ id: pre + (idx ? '-index' : '-minor'), type: 'line', source, 'source-layer': 'contours', ...z,
      filter: f(idx ? ['>=', ['get', 'level'], 1] : ['==', ['get', 'level'], 0]), layout: { 'line-join': 'round' },
      paint: { 'line-color': idx ? CONTOUR_INK.index : CONTOUR_INK.minor, 'line-opacity': idx ? 0.55 : 0.28,
        'line-width': idx ? zoomed([9, 0.8, 13, 1, 16, 1.2]) : zoomed([9, 0.4, 13, 0.5, 16, 0.6]) } });
    for (const idx of [false, true]) {
      map.addLayer(line(idx), below);
      made.push([line(idx).id, { group: 'contours' }]);
    }
    // heights: small, thin halo, far apart, index lines only, from zoom 11; the lowest of all names
    const lab = { id: pre + '-label', type: 'symbol', source, 'source-layer': 'contours', ...z, minzoom: Math.max(11, minzoom),
      filter: f(['>=', ['get', 'level'], 1]),
      layout: { 'symbol-placement': 'line', 'text-field': elevText(lang, 'ele'), 'text-font': FONT, 'text-size': 10, 'text-max-angle': 30,
        'symbol-spacing': 700, 'text-padding': 6, 'text-pitch-alignment': 'viewport', 'text-rotation-alignment': 'map' },
      paint: { 'text-color': CONTOUR_INK.label, 'text-halo-color': 'rgba(255,255,255,0.85)', 'text-halo-width': 1, 'text-halo-blur': 0.5 } };
    map.addLayer(lab);
    made.push([lab.id, { group: 'contours', label: true, elev: true }]);
  };
  // basin-wide source: everywhere up to zoom 14, and above 14 outside the fine box (no doubled line)
  set('b05-dc', 'b05-dem-contours', DEM_MINZOOM, fineIn ? FINE_MINZOOM : 0, true);
  if (fineIn) {
    set('b05-dc-out', 'b05-dem-contours', FINE_MINZOOM, 0, fineOut);
    set('b05-dcf', 'b05-dem-contours-fine', FINE_MINZOOM, 0, true);
  }
  const rest = [...meta];
  meta.clear();
  for (const [k, v] of made) meta.set(k, v);
  for (const [k, v] of rest) meta.set(k, v);
  apply();
  keepOffWater();
  ctx.basemap?.raiseLabels();

  const retireOld = () => {
    // inside the computed box the GeoJSON contours step back: basin lines only below zoom 9 or outside the box
    for (const id of ['b05-contour-fine', 'b05-contour-fine-index', 'b05-contour-label-fine', 'b05-contour-label-wide']) {
      if (map.getLayer(id)) map.removeLayer(id);
      meta.delete(id);
    }
    const out = ['!', ['within', { type: 'Feature', properties: {}, geometry: boxPoly(inner) }]];
    for (const id of ['b05-contour-wide', 'b05-contour-wide-index']) if (map.getLayer(id)) map.setLayerZoomRange(id, 6, DEM_MINZOOM);
    for (const [id, idx] of [['b05-contour-wide-out', false], ['b05-contour-wide-out-index', true]]) {
      if (!map.getLayer(id)) continue;
      map.setLayerZoomRange(id, DEM_MINZOOM, 24);
      map.setFilter(id, ['all', idx ? ['==', ['%', ['get', 'e'], 500], 0] : ['!=', ['%', ['get', 'e'], 500], 0], out]);
    }
  };
  const giveUp = () => {
    for (const [id] of made) {
      if (map.getLayer(id)) map.removeLayer(id);
      meta.delete(id);
    }
    for (const id of ['b05-dem-contours', 'b05-dem-contours-fine']) if (map.getSource(id)) map.removeSource(id);
    ctx.log('basemap: computed contours failed, GeoJSON contours kept');
  };
  const onData = (e) => {
    if (ok || e.sourceId !== 'b05-dem-contours' || !e.tile || e.tile.state !== 'loaded') return;
    ok = true;
    map.off('sourcedata', onData);
    retireOld();
  };
  const onErr = (e) => {
    if (ok || !e || e.sourceId !== 'b05-dem-contours') return;
    map.off('error', onErr);
    map.off('sourcedata', onData);
    giveUp();
  };
  map.on('sourcedata', onData);
  map.on('error', onErr);
}
