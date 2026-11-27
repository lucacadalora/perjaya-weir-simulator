// The water colours of the simulator: the one place they are written. Owner: lane b06 (lane w, 24 Nov 2026).
// STABLE EXPORTS: lanes b05, b08, b09 and b24 import WATER, so the river never changes colour where one drawing
// hands over to another.
//   import { WATER, RIVER } from '../water/palette.js';   // hex strings '#rrggbb'
//
// WATER (CONTRACT A8 point 1): the blue map family. Names of rivers, canal lines, the flood legend's outline: map
// symbols, which read as water at a glance on a drawn map.
export const WATER = Object.freeze({
  shallow: '#7fb2cc', // edges and shallow water
  body: '#3f7fa6', // ordinary river and lake water
  deep: '#1f5a85', // deep water; nothing drawn as water is ever darker than this
  foam: '#ffffff', // white water below gates and spillways
  shore: '#e6f1f2', // the pale line where water meets land
});

// RIVER (proposed CONTRACT A10, 24 Nov 2026): the Komering as it really looks, for every moving water surface
// (water/surface.js: the river sheets, the weir's own water, the flooded land). The Komering carries a lot of
// sediment: olive-brown at an ordinary flow, greener and clearer at low flow, chocolate brown in a flood. Display
// choices taken from pictures, not measurements:
//   - normal: the river in the 0.6 m aerial of the weir (refs/weir/03, sampled #9a8862 pond, #8f7d55 tail) and the
//     Sentinel-2 picture of 26 Apr 2026 (site/data/tiles/sat2026, #967148 pond, #8f6a46 tail);
//   - clear: the same water with less mud in it (dry season); flood: the same water carrying a flood's mud.
// `see_m` is how deep the eye sees into the water before the bed is lost (metres): the bed shows only in the
// shallowest band. Which look shows is set by the flow (surface.js turbidityFor), never the other way round.
export const RIVER = Object.freeze({
  clear: Object.freeze({ shallow: '#93976b', body: '#6a744c', deep: '#4f5d3d', see_m: 0.8 }),
  normal: Object.freeze({ shallow: '#a69169', body: '#8c7852', deep: '#6f5f3f', see_m: 0.3 }),
  flood: Object.freeze({ shallow: '#8f6a4a', body: '#714f34', deep: '#5a3c27', see_m: 0.06 }),
  bed: '#9b8762', // wet sand and mud seen through the shallowest water
  bank: '#4d5838', // the green and earth bank where the water reflects it
  foam: '#f2ede2', // foam on a muddy river is cream, not snow white
  floodFoam: '#e2d3bb', // and in a flood more so
  // A flat colour for river and lake areas the map draws itself (proposed A10: basemap fills of the Komering, so
  // a river sheet fading out at the end of its reach meets the same colour). The normal look seen from above.
  map: '#9a8a67',
});
