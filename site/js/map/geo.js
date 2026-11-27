// Geographic helpers (ctx.geo). Owner: lane b04. Pure functions, no map, usable in node and in workers.
// Spherical earth (R = 6,371,008.8 m) for distance, bearing and destination; WGS84 metres per degree.
// Bearings are compass degrees: 0 north, 90 east, clockwise.

export const R = 6371008.8;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// metres per degree of latitude / longitude at a latitude (WGS84 series, good to about 1 cm)
export function mPerDegLat(lat) {
  const p = lat * D2R;
  return 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p);
}
export function mPerDegLon(lat) {
  const p = lat * D2R;
  return 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p);
}
export const metresPerDegree = (lat) => ({ lat: mPerDegLat(lat), lon: mPerDegLon(lat) });

// great-circle distance in metres
export function distance(lon1, lat1, lon2, lat2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R;
  const dp = p2 - p1, dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// initial compass bearing from point 1 to point 2, degrees 0..360
export function bearing(lon1, lat1, lon2, lat2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

// the point reached from (lon, lat) after dist metres on a compass bearing: [lon, lat]
export function destination(lon, lat, dist, bearingDeg) {
  const d = dist / R, t = bearingDeg * D2R, p1 = lat * D2R, l1 = lon * D2R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [((l2 * R2D + 540) % 360) - 180, p2 * R2D];
}

// local east/north metres of (lon, lat) from an origin (flat, fine within a few tens of km)
export function toEN(lon0, lat0, lon, lat) {
  const m = lat0 + (lat - lat0) / 2;
  return [(lon - lon0) * mPerDegLon(m), (lat - lat0) * mPerDegLat(m)];
}
export function fromEN(lon0, lat0, east, north) {
  const lat = lat0 + north / mPerDegLat(lat0);
  return [lon0 + east / mPerDegLon((lat0 + lat) / 2), lat];
}

// --- web mercator, MapLibre's world units: x, y in 0..1 (y grows south), z in the same units ---
const MAX_LAT = 85.051129;
export function mercX(lon) {
  return (180 + lon) / 360;
}
export function mercY(lat) {
  const l = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  return (180 - R2D * Math.log(Math.tan(Math.PI / 4 + (l * D2R) / 2))) / 360;
}
export function lonFromMercX(x) {
  return x * 360 - 180;
}
export function latFromMercY(y) {
  return R2D * (2 * Math.atan(Math.exp(((180 - y * 360) * D2R))) - Math.PI / 2);
}
// MapLibre's earth circumference for mercator units (matches MercatorCoordinate)
export const EARTH_CIRC = 2 * Math.PI * 6371008.8;
// one metre in mercator units at a latitude (MercatorCoordinate.meterInMercatorCoordinateUnits)
export function mercPerMetre(lat) {
  return 1 / (EARTH_CIRC * Math.cos(lat * D2R));
}
export function toMerc(lon, lat, el = 0) {
  return [mercX(lon), mercY(lat), el * mercPerMetre(lat)];
}

// slippy-map tiles
export function lonToTileX(lon, z) {
  return mercX(lon) * 2 ** z;
}
export function latToTileY(lat, z) {
  return mercY(lat) * 2 ** z;
}
export function tileToLonLat(x, y, z) {
  const n = 2 ** z;
  return [lonFromMercX(x / n), latFromMercY(y / n)];
}

// a scale bar at a latitude and MapLibre zoom (512 px world): the longest round length (1, 2 or 5 x 10^n m) that
// fits in maxPx. Returns {metres, px} or null when the inputs are not usable.
export function scaleBar(lat, zoom, maxPx = 110) {
  if (!Number.isFinite(lat) || !Number.isFinite(zoom) || Math.abs(lat) >= 85.06) return null;
  const mpp = (EARTH_CIRC * Math.cos(lat * D2R)) / (512 * 2 ** zoom);
  if (!(mpp > 0) || !Number.isFinite(mpp)) return null;
  const max = mpp * maxPx;
  const p = 10 ** Math.floor(Math.log10(max));
  const metres = max >= 5 * p ? 5 * p : max >= 2 * p ? 2 * p : p;
  return { metres, px: metres / mpp };
}
