// Fetch, decode and encode for the ground core (lane g, 24 Nov 2026). Works in a worker (OffscreenCanvas) and on the
// main thread (OffscreenCanvas or a <canvas>).

import { decodeTerrariumRGBA, encodeTerrariumRGBA } from './dem.js';

const hasOffscreen = () => {
  try {
    return typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('2d');
  } catch (e) {
    return false;
  }
};
export const canDraw = () => hasOffscreen() || typeof document !== 'undefined';
const canvas = (w, h) =>
  hasOffscreen() ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });

async function pixels(blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const cv = canvas(bmp.width, bmp.height);
  const c2 = cv.getContext('2d', { willReadFrequently: true });
  c2.drawImage(bmp, 0, 0);
  const img = c2.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close && bmp.close();
  return img;
}

async function toBuffer(cv, type, quality) {
  const blob = cv.convertToBlob ? await cv.convertToBlob({ type, quality }) : await new Promise((r) => cv.toBlob(r, type, quality));
  return blob.arrayBuffer();
}

// RGBA bytes (w x h) -> encoded image ArrayBuffer
export async function encodeImage(rgba, w, h, type = 'image/png', quality) {
  const cv = canvas(w, h);
  const c2 = cv.getContext('2d');
  const img = c2.createImageData(w, h);
  img.data.set(rgba);
  c2.putImageData(img, 0, 0);
  return toBuffer(cv, type, quality);
}

export const encodeTerrariumPng = (h, w) => encodeImage(encodeTerrariumRGBA(h, w * w), w, w, 'image/png');

export function createIO() {
  const whole = new Map(); // url -> Promise<ArrayBuffer> of a file a server sent whole (no Range support)
  return {
    async terrain(url) {
      const r = await fetch(url);
      if (!r.ok) return null;
      const img = await pixels(await r.blob());
      const out = decodeTerrariumRGBA(img.data, img.width * img.height);
      out.w = img.width;
      return out;
    },
    async image(url) {
      const r = await fetch(url);
      if (!r.ok) return null;
      return pixels(await r.blob());
    },
    // bytes s .. e-1 of a file: {buf, offset} (offset = where buf starts in the file). The whole file is fetched
    // ONCE per url and shared (lead, 24 Nov 2026): a server that gzips these grids answers a Range request
    // with the whole file anyway, and many parallel Range requests to one url made Chrome's cache send
    // ranges the server refused (HTTP 416, seen in testing). s and e stay for the callers.
    async bytes(url, s, e) {
      if (!whole.has(url)) {
        const p = fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null));
        whole.set(url, p);
        p.then((b) => b || whole.delete(url), () => whole.delete(url));
      }
      const buf = await whole.get(url);
      return buf ? { buf, offset: 0 } : null;
    },
    async json(url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    },
  };
}
