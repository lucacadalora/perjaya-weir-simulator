// The 3D host (ctx.scene3d). Owner: lane b04. CONTRACT 4.7; recipe: baseline plan/T1-render-findings.md.
// One MapLibre custom layer ('three', renderingMode '3d', shared WebGL context) draws one three.js scene.
// Terrain depth is in the depth buffer when it draws, so the ground hides what is below it.
//
// Scene frame: metres at true scale, +X east, +Y up, +Z south (north is -Z). Origin: the opening point (the weir)
// at elevation 0 model metres. `el` everywhere is model metres (the terrain's own heights; CONTRACT 2.3).
//
//   add(object3D, {lon, lat, el, bearing_deg}) -> { object, set({lon, lat, el, bearing_deg}), remove() }
//       bearing_deg turns the object clockwise seen from above: its -Z axis (model north) then points to that
//       compass bearing. Any field left out of set() keeps its value.
//   toLocal(lon, lat, el) -> [x, y, z]      fromLocal(x, z) -> [lon, lat]
//   onFrame(fn(dtSeconds, timeSeconds)) -> off()   called on each store 'frame' event (lane s01), then a repaint
//   requestRender()   THREE   scene   origin {lon, lat}   layerId 'three'

import * as THREE from 'three';

export function createScene3d(ctx, map) {
  const c = map.getCenter();
  const origin = { lon: c.lng, lat: c.lat };
  const o = maplibregl.MercatorCoordinate.fromLngLat([origin.lon, origin.lat], 0);
  const s = o.meterInMercatorCoordinateUnits();
  // scene (x east, y up, z south) -> mercator (x east, y south, z up), all in mercator units
  const localToMerc = new THREE.Matrix4().set(
    s, 0, 0, o.x,
    0, 0, s, o.y,
    0, s, 0, o.z,
    0, 0, 0, 1,
  );

  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  // sky and ground light, and a sun high in the north-east (tropics, mid-morning)
  const sky = new THREE.HemisphereLight(0xe4eef7, 0x7d7462, 1.5);
  scene.add(sky);
  const sun = new THREE.DirectionalLight(0xfff6e8, 2.4);
  sun.position.set(0.45, 1.0, -0.3);
  scene.add(sun);
  scene.add(sun.target);

  let renderer = null;
  const mvp = new THREE.Matrix4();
  const layer = {
    id: 'three',
    type: 'custom',
    renderingMode: '3d',
    onAdd(m, gl) {
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    render(gl, args) {
      if (!renderer) return;
      mvp.fromArray(args.defaultProjectionData.mainMatrix).multiply(localToMerc);
      camera.projectionMatrix.copy(mvp);
      camera.projectionMatrixInverse.copy(mvp).invert();
      renderer.resetState();
      renderer.render(scene, camera);
    },
    onRemove() {
      renderer = null;
    },
  };
  map.addLayer(layer);

  function toLocal(lon, lat, el = 0) {
    const m = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0);
    return [(m.x - o.x) / s, el || 0, (m.y - o.y) / s];
  }
  function fromLocal(x, z) {
    const ll = new maplibregl.MercatorCoordinate(o.x + x * s, o.y + z * s, 0).toLngLat();
    return [ll.lng, ll.lat];
  }

  const requestRender = () => map.triggerRepaint();

  function add(object, place = {}) {
    const holder = new THREE.Group();
    holder.add(object);
    const at = { lon: origin.lon, lat: origin.lat, el: 0, bearing_deg: 0 };
    const set = (p = {}) => {
      for (const k of ['lon', 'lat', 'el', 'bearing_deg']) if (Number.isFinite(p[k])) at[k] = p[k];
      const [x, y, z] = toLocal(at.lon, at.lat, at.el);
      holder.position.set(x, y, z);
      holder.rotation.set(0, -THREE.MathUtils.degToRad(at.bearing_deg), 0);
      holder.updateMatrixWorld(true);
      requestRender();
    };
    set(place);
    scene.add(holder);
    return {
      object: holder,
      set,
      get: () => ({ ...at }),
      remove() {
        scene.remove(holder);
        requestRender();
      },
    };
  }

  const frameFns = new Set();
  ctx.store.listen('frame', (p) => {
    if (!frameFns.size) return;
    const dt = p && Number.isFinite(p.dt) ? p.dt : 0;
    const t = p && Number.isFinite(p.t) ? p.t : 0;
    for (const fn of [...frameFns]) {
      try {
        fn(dt, t);
      } catch (e) {
        console.error('[scene3d] frame function failed', e);
        frameFns.delete(fn);
      }
    }
    requestRender();
  });
  function onFrame(fn) {
    frameFns.add(fn);
    return () => frameFns.delete(fn);
  }

  return { THREE, scene, camera, origin, layerId: 'three', add, toLocal, fromLocal, onFrame, requestRender, sun, sky,
    get renderer() {
      return renderer;
    } };
}
