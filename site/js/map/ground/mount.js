// The ground up close (lane g, 24 Nov 2026). Module 'map/ground/mount': a raster layer 'g-ground' from the protocol
// 'pjground://{z}/{x}/{y}', drawn by the terrain store's worker pool (terrain-sampler.js -> ground/worker.js ->
// ground/core.js + ground/look.js): grass, crops, tree crowns, yards, exposed earth on steep banks, sand and mud on low
// banks, a wet band at the water's edge and stone riprap beside the weir, lit by the scene's sun from the smooth
// terrain. It sits right above lane b05's hillshade, so contours, water, canals, roads, buildings, the flood tint and
// names still drape on top; it fades in from zoom 13.6 to 14.8 over the pale drawn base (CONTRACT A4, A8), and is off
// on the satellite base ('sat').
// Sets ctx.ground = { layerId, sourceId, setVisible(bool) }.

const SRC = 'g-ground';
const LAYER = 'g-ground';
const FADE = [13.6, 0, 14.8, 1]; // zoom, opacity (DISPLAY CHOICE: the 10 m pictures are blurred from about zoom 14)

function placeBelow(map) {
  const ids = map.getStyle().layers.map((l) => l.id);
  const hs = ids.indexOf('b05-hillshade');
  if (hs >= 0 && hs + 1 < ids.length) return ids[hs + 1];
  for (const id of ['b05-dc-minor', 'b05-contour-wide', 'b05-lakes', 'b05-under-roads', 'three']) if (ids.includes(id)) return id;
  return undefined;
}

export async function init(ctx) {
  const map = ctx.map;
  if (!map || typeof maplibregl === 'undefined') return;
  const store = maplibregl.__pjterrain;
  if (!store || typeof store.groundTile !== 'function') return;
  // map/map resolved only after the map's 'load' (the style is in). isStyleLoaded() may still be false while other
  // lanes' GeoJSON sources load, and 'load' never fires twice, so it is not waited on here.
  if (!(await store.groundReady())) return ctx.log('ground: no worker, close ground off');

  if (!maplibregl.__pjground) maplibregl.addProtocol('pjground', (params, abort) => maplibregl.__pjground(params, abort));
  maplibregl.__pjground = (params, abort) => maplibregl.__pjterrain.groundTile(params, abort);

  const b = store.avail.bounds;
  if (!map.getSource(SRC)) map.addSource(SRC, { type: 'raster', tiles: ['pjground://{z}/{x}/{y}'], tileSize: 256, minzoom: 14, maxzoom: 18, bounds: b });
  if (!map.getLayer(LAYER)) {
    map.addLayer({ id: LAYER, type: 'raster', source: SRC, minzoom: FADE[0],
      paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], ...FADE], 'raster-resampling': 'linear',
        'raster-fade-duration': ctx.shot ? 0 : 200 } }, placeBelow(map));
  }

  let on = true;
  const vis = () => map.getLayer(LAYER) && map.setLayoutProperty(LAYER, 'visibility', on && (ctx.store.get('view') || {}).base !== 'sat' ? 'visible' : 'none');
  ctx.store.on('view', vis);
  vis();
  ctx.ground = { layerId: LAYER, sourceId: SRC, setVisible: (v) => ((on = !!v), vis()) };
}
