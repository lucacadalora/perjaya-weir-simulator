// The ground's look (lane g, 24 Nov 2026): what one pixel of a close-zoom ground tile looks like, from the fields the
// core gathers for it (smooth heights, land cover, height above the river, distance to water, special zones).
// Pure functions, no DOM: run in the ground worker, tested in node.
//
// Everything here is a DISPLAY CHOICE (colours, sizes of crowns, plots and stones, band widths): nothing is measured.
// Procedural detail is band-limited by the pixel size, so a far tile is the average of the near tiles under it and
// zooming in does not change the colour of a place, only its detail.

// Sun: the scene's own light (scene3d.js: DirectionalLight at (0.45, 1.0, -0.3), x east, y up, z south),
// here as (east, north, up). The same sun lights the water (water/surface.js SUN).
const SUN_RAW = [0.45, 0.3, 1.0];
const SL = Math.hypot(...SUN_RAW);
export const SUN = SUN_RAW.map((v) => v / SL);
const RELIEF = 1.4; // slopes drawn 1.4 x steeper in the light than they are (DISPLAY CHOICE: relief reads under a high sun)
const AMBIENT = 0.46; // share of the light that does not depend on the slope (DISPLAY CHOICE)

// colours (sRGB 0..255). DISPLAY CHOICES, picked against the 0.6 m aerial and the ground photo of the weir.
export const C = {
  grassA: [120, 156, 80], grassB: [148, 166, 96], grassDry: [170, 168, 116],
  canopyLit: [96, 140, 66], canopyMid: [64, 108, 50], canopyDeep: [48, 88, 42], gap: [40, 62, 34], canopyAvg: [68, 108, 52],
  paddyYoung: [152, 190, 94], paddyLush: [118, 166, 78], paddyRipe: [176, 178, 100], paddyWet: [132, 156, 126],
  paddyFallow: [158, 146, 106], bund: [176, 170, 132],
  earth: [164, 122, 86], earthDark: [128, 94, 68], olive: [132, 148, 84],
  compact: [192, 176, 144], compactGrey: [178, 172, 160], yard: [198, 190, 172],
  sand: [216, 200, 162], sandDark: [196, 178, 140], mud: [142, 124, 96],
  bed: [150, 132, 100], bedDeep: [104, 92, 74], otherWater: [120, 132, 120],
  stone: [152, 146, 136], stoneGap: [84, 80, 74], stoneAvg: [126, 121, 112],
  wetland: [100, 136, 82], puddle: [122, 146, 150],
  paper: [243, 239, 229],
};

// ---- noise (hash-based, deterministic, the same in every worker and at every zoom) ----
export function hash2(ix, iy, s) {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(s | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
// value noise in -1..1, lattice spacing 1
export function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
  return (a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy) * 2 - 1;
}
// fractal noise with octaves from wavelength lam (metres) down; an octave finer than 2 px is left out, 2..4 px fades
// in, so the far view is the mean of the near one. m = metres per pixel.
export function fbm(x, y, lam, oct, m, s) {
  let sum = 0, amp = 1, tot = 0;
  for (let o = 0; o < oct; o++) {
    tot += amp;
    const b = (lam / m - 2) * 0.5;
    if (b > 0) sum += amp * (b < 1 ? b : 1) * vnoise(x / lam, y / lam, s + o * 7);
    amp *= 0.55;
    lam *= 0.5;
  }
  return sum / tot;
}
// how much of a feature of size lam (metres) a pixel of m metres can show: 0 below 2 px, 1 above 4 px
export const band = (lam, m) => {
  const b = (lam / m - 2) * 0.5;
  return b <= 0 ? 0 : b >= 1 ? 1 : b;
};
// nearest jittered point of a cell grid: res = [distance m, id 0..1, dx m, dy m] (dx east, dy north of the point)
export function worley(x, y, cell, s, res) {
  const gx = x / cell, gy = y / cell;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  let best = 1e9, bid = 0, bdx = 0, bdy = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i, cy = iy + j;
      const px = cx + 0.15 + 0.7 * hash2(cx, cy, s), py = cy + 0.15 + 0.7 * hash2(cx, cy, s + 1);
      const dx = gx - px, dy = gy - py, d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        bid = hash2(cx, cy, s + 2);
        bdx = dx;
        bdy = dy;
      }
    }
  }
  res[0] = Math.sqrt(best) * cell;
  res[1] = bid;
  res[2] = bdx * cell;
  res[3] = bdy * cell;
  return res;
}

export const smooth = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const mixTo = (o, c, t) => {
  o[0] += (c[0] - o[0]) * t;
  o[1] += (c[1] - o[1]) * t;
  o[2] += (c[2] - o[2]) * t;
};
const set = (o, c) => {
  o[0] = c[0];
  o[1] = c[1];
  o[2] = c[2];
};
const scale = (o, k) => {
  o[0] *= k;
  o[1] *= k;
  o[2] *= k;
};

// ---- materials: each writes a colour into o and returns a light factor of its own small relief (1 = flat) ----
const W4 = new Float64Array(4);

function grass(o, X, Y, m) {
  const t = fbm(X, Y, 70, 3, m, 11);
  set(o, C.grassA);
  mixTo(o, C.grassB, 0.5 + 0.5 * t);
  const dry = smooth(0.3, 0.85, vnoise(X / 160, Y / 160, 13)) * 0.55;
  mixTo(o, C.grassDry, dry);
  const fine = fbm(X, Y, 4, 3, m, 17); // tufts and mowing marks
  return 1 + 0.09 * fine;
}

// tree crowns seen from above: domes lit by the sun, smaller crowns in the gaps between big ones, clumps of lighter and
// darker trees, dark shade where nothing covers the ground
const COL = [0, 0, 0];
function crown(X, Y, cell, seed, out) {
  worley(X, Y, cell, seed, W4);
  const id = W4[1];
  const rc = cell * (0.42 + 0.22 * id);
  if (W4[0] >= rc) return -1;
  const nx = W4[2] / rc, ny = W4[3] / rc, nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
  const d = nx * SUN[0] + ny * SUN[1] + nz * SUN[2];
  set(out, id < 0.3 ? C.canopyDeep : id < 0.75 ? C.canopyMid : C.canopyLit);
  mixTo(out, C.canopyLit, Math.max(0, d - 0.55) * 0.9);
  // the crown's rim darkens a little (leaves turned away)
  return (0.62 + 0.5 * Math.max(0, d)) * (1 - 0.2 * smooth(0.55, 1, W4[0] / rc));
}
function canopyDetail(X, Y, cell, seed, gapTo, out) {
  let lf = crown(X, Y, cell, seed, out);
  if (lf < 0) lf = crown(X + 0.37 * cell, Y - 0.21 * cell, cell * 0.55, seed + 3, out) * 0.92;
  if (lf < 0) {
    set(out, gapTo || C.gap);
    lf = gapTo ? 0.85 : 0.78;
  }
  return lf;
}
// the mean colour of the crowns as a far pixel sees them (so near and far tiles agree)
const MEANS = new Map();
function canopyMean(cell, seed, gapTo) {
  const key = cell + ':' + seed + ':' + (gapTo ? 1 : 0);
  let v = MEANS.get(key);
  if (v) return v;
  const s = [0, 0, 0], c = [0, 0, 0];
  const n = 72;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const lf = canopyDetail(5000 + (i * cell * 9.7) / n + 0.13 * j, -3000 + (j * cell * 9.7) / n, cell, seed, gapTo, c);
      s[0] += c[0] * lf;
      s[1] += c[1] * lf;
      s[2] += c[2] * lf;
    }
  }
  v = s.map((x) => x / (n * n));
  MEANS.set(key, v);
  return v;
}
function canopy(o, X, Y, m, cell, seed, gapTo) {
  const tone = fbm(X, Y, 110, 2, m, seed + 5);
  const clump = fbm(X, Y, 36, 2, m, seed + 7);
  const k = 1 + 0.1 * tone + 0.07 * clump; // stands of lighter and darker trees (DISPLAY)
  set(o, canopyMean(cell, seed, gapTo));
  // A far tile cannot show single crowns: it draws the same crown pattern magnified to at least 3 px a crown (groups
  // of crowns, as an eye sees them from afar), with its contrast lowered as it is magnified. So every tile zoom has
  // crown texture of about the same size on screen and the same mean colour, and the switch from one tile zoom to the
  // next is not a line across the view (DISPLAY CHOICE).
  const s = Math.min(1, cell / (3 * m));
  const contrast = s < 1 ? Math.pow(s, 0.7) : 1;
  const lf = canopyDetail(X * s, Y * s, cell, seed, gapTo, COL) * (1 + 0.04 * fbm(X, Y, 1.2, 2, m, seed + 9));
  // the mean already carries the crowns' own light: blend colour x light, then hand back the stand's light
  o[0] += (COL[0] * lf - o[0]) * contrast;
  o[1] += (COL[1] * lf - o[1]) * contrast;
  o[2] += (COL[2] * lf - o[2]) * contrast;
  return k;
}

// villages: packed-earth yards and paths, grass, and the fruit trees of house gardens (DISPLAY)
const TMP2 = [0, 0, 0];
function kampung(o, X, Y, m) {
  let lf = compacted(o, X, Y, m, C.compact);
  const tr = smooth(0.1, 0.32, fbm(X, Y, 45, 2, m, 223));
  if (tr > 0) {
    const l2 = canopy(TMP2, X, Y, m, 7, 229);
    mixTo(o, TMP2, tr);
    lf += (l2 - lf) * tr;
  }
  return lf;
}

// bare and sparse ground (WorldCover 60: clearings, quarries, a dam site): laterite earth in broad lighter and
// darker tones, wheel tracks and wet patches, sparse grass and scrub (DISPLAY)
function bare(o, X, Y, m) {
  set(o, C.earth);
  mixTo(o, C.earthDark, 0.5 + 0.6 * fbm(X, Y, 60, 3, m, 241));
  mixTo(o, C.sandDark, smooth(0.15, 0.55, fbm(X, Y, 34, 3, m, 251)) * 0.55);
  const veg = smooth(0.12, 0.45, fbm(X, Y, 20, 3, m, 263));
  if (veg > 0) {
    grass(TMP3, X, Y, m);
    mixTo(o, TMP3, veg * 0.75);
  }
  return 1 + 0.12 * fbm(X, Y, 3, 3, m, 271);
}

// gardens on slopes: olive ground under scattered crowns of rubber, coffee and fruit trees (DISPLAY)
const TMP4 = [0, 0, 0];
function garden(o, X, Y, m) {
  let lf = grass(o, X, Y, m);
  mixTo(o, C.olive, 0.55);
  const tr = smooth(-0.15, 0.25, fbm(X, Y, 28, 3, m, 283));
  if (tr > 0) {
    const l2 = canopy(TMP4, X, Y, m, 6, 289);
    mixTo(o, TMP4, tr * 0.85);
    lf += (l2 - lf) * tr * 0.85;
  }
  return lf;
}

const PADDY = [C.paddyYoung, C.paddyLush, C.paddyLush, C.paddyRipe, C.paddyWet, C.paddyFallow];
// rice fields: plots in blocks of one direction, each plot at its own stage, earth bunds between them
function paddy(o, X, Y, m) {
  const wx = X + 70 * vnoise(X / 420, Y / 420, 31), wy = Y + 70 * vnoise(X / 420, Y / 420, 37);
  const rx = Math.floor(wx / 320), ry = Math.floor(wy / 320); // blocks of about 320 m
  const th = hash2(rx, ry, 41) * Math.PI;
  const cs = Math.cos(th), sn = Math.sin(th);
  const a = X * cs + Y * sn, b = -X * sn + Y * cs;
  const pw = 22 + 16 * hash2(rx, ry, 43), ph = 12 + 10 * hash2(rx, ry, 47); // plots 22-38 m by 12-22 m
  const ia = Math.floor(a / pw), ib = Math.floor(b / ph);
  const k = hash2(ia, ib, 53 + rx * 7 + ry * 13);
  // the stage of a block leans one way (fields of one owner are planted together)
  const lean = hash2(rx, ry, 59);
  const pick = Math.min(PADDY.length - 1, Math.floor((k * 0.6 + lean * 0.4) * PADDY.length));
  const avgK = 0.6 * band(Math.min(pw, ph), m);
  set(o, C.paddyLush);
  mixTo(o, PADDY[pick], avgK);
  mixTo(o, C.paddyYoung, (1 - avgK) * 0.3);
  const fa = a / pw - ia, fb = b / ph - ib;
  const ea = Math.min(fa, 1 - fa) * pw, eb = Math.min(fb, 1 - fb) * ph; // metres to the plot's edge
  const bw = 0.7; // bund width, metres
  const cov = (e) => Math.max(0, Math.min(1, (0.5 * bw - e) / m + 0.5));
  const bund = Math.max(cov(ea), cov(eb)) * band(Math.min(pw, ph), m);
  mixTo(o, C.bund, bund * 0.85);
  return 1 + 0.06 * fbm(X, Y, 6, 2, m, 61);
}

const TMP3 = [0, 0, 0];
function compacted(o, X, Y, m, base) {
  set(o, base);
  mixTo(o, C.compactGrey, 0.5 + 0.5 * fbm(X, Y, 25, 3, m, 71));
  // ruts, gravel and puddle marks
  const g = fbm(X, Y, 2.5, 3, m, 73);
  // patches of grass that survive on the edges of yards
  const gp = smooth(0.18, 0.42, fbm(X, Y, 18, 3, m, 79));
  if (gp > 0) {
    grass(TMP3, X, Y, m);
    mixTo(o, TMP3, gp * 0.85);
  }
  return 1 + 0.08 * g;
}

function earthFace(o, X, Y, m) {
  set(o, C.earth);
  mixTo(o, C.earthDark, 0.5 + 0.5 * fbm(X, Y, 9, 3, m, 83));
  return 1 + 0.08 * fbm(X, Y, 1.5, 2, m, 89);
}

function sandBank(o, X, Y, m, dOut) {
  set(o, C.sand);
  mixTo(o, C.sandDark, 0.5 + 0.5 * fbm(X, Y, 12, 3, m, 97));
  // ripples left by the last high water, across the flow (DISPLAY CHOICE: 1.6 m apart)
  const rip = band(1.6, m) * Math.sin((X * 0.6 + Y * 0.8 + 3 * vnoise(X / 9, Y / 9, 101)) * (2 * Math.PI / 1.6));
  // mud closest to the water
  mixTo(o, C.mud, smooth(9, 2.5, dOut + 3 * vnoise(X / 7, Y / 7, 103)) * 0.85);
  return 1 + 0.05 * rip + 0.05 * fbm(X, Y, 3, 2, m, 107);
}

function riprap(o, X, Y, m) {
  const cell = 0.9; // stones about 0.9 m (DISPLAY CHOICE)
  const bc = band(cell, m);
  set(o, C.stoneAvg);
  if (bc <= 0) return 1;
  worley(X, Y, cell, 113, W4);
  const id = W4[1];
  const r = cell * 0.42;
  const col = COL;
  let lf;
  if (W4[0] < r) {
    const nx = W4[2] / r, ny = W4[3] / r, nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    const d = nx * SUN[0] + ny * SUN[1] + nz * SUN[2];
    set(col, C.stone);
    scale(col, 0.82 + 0.3 * id);
    lf = 0.72 + 0.4 * Math.max(0, d);
  } else {
    set(col, C.stoneGap);
    lf = 0.8;
  }
  mixTo(o, col, bc);
  return 1 + (lf - 1) * bc;
}

// ---- one tile ----
// f: {N, m, X0, Y0, H ((N+2)^2 heights, border 1), cls, hand, wat, dOut, dIn, rip, yard} (see core.js)
// out: Uint8ClampedArray N*N*4
export function shadeTile(f, out) {
  const { N, m, X0, Y0, H, cls, hand, wat, dOut, dIn, rip, yard } = f;
  const HW = N + 2;
  const o = [0, 0, 0], tmp = [0, 0, 0];
  const inv2m = 1 / (2 * m);
  for (let j = 0; j < N; j++) {
    const Y = Y0 - j * m;
    for (let i = 0; i < N; i++) {
      const X = X0 + i * m;
      const p = j * N + i;
      const c = (j + 1) * HW + i + 1;
      const gx = (H[c + 1] - H[c - 1]) * inv2m;
      const gy = (H[c - HW] - H[c + HW]) * inv2m; // row above is north
      const tanS = Math.sqrt(gx * gx + gy * gy);
      const w = wat ? wat[p] : 0;
      const dO = dOut ? dOut[p] : Infinity;
      const hab = hand && Number.isFinite(hand[p]) ? hand[p] : 50;
      let lf = 1;
      const k = cls ? cls[p] : 30;
      if (w === 1) {
        // under the river: sand and mud getting darker into deeper water (DISPLAY: the water is drawn over it)
        const di = dIn ? dIn[p] : 30;
        set(o, C.bed);
        mixTo(o, C.mud, smooth(0, 10, di + 4 * vnoise(X / 10, Y / 10, 131)));
        mixTo(o, C.bedDeep, smooth(6, 45, di));
        lf = 1 + 0.05 * fbm(X, Y, 5, 2, m, 137);
        scale(o, 0.8);
      } else if (w === 2) {
        set(o, C.otherWater);
      } else {
        // land: the land-cover material
        if (k === 10 || k === 95) lf = canopy(o, X, Y, m, 11, 151);
        else if (k === 20) lf = canopy(o, X, Y, m, 5, 157, C.grassB);
        else if (k === 40) {
          // rice needs flat ground; cropland on slopes (rubber, coffee, smallholder gardens) is a garden mosaic
          const flat = smooth(0.14, 0.06, tanS);
          lf = flat > 0 ? paddy(o, X, Y, m) : 1;
          if (flat < 1) {
            const l2 = garden(tmp, X, Y, m);
            if (flat > 0) {
              mixTo(o, tmp, 1 - flat);
              lf += (l2 - lf) * (1 - flat);
            } else {
              set(o, tmp);
              lf = l2;
            }
          }
        }
        else if (k === 50) lf = kampung(o, X, Y, m);
        else if (k === 60) lf = bare(o, X, Y, m);
        else if (k === 80) {
          // land cover says water but no water is drawn here: a bar or a dry channel, wet sand and mud
          lf = sandBank(o, X, Y, m, 4);
          scale(o, 0.86);
        } else if (k === 90) {
          lf = grass(o, X, Y, m);
          mixTo(o, C.wetland, 0.7);
          mixTo(o, C.puddle, smooth(0.35, 0.55, vnoise(X / 14, Y / 14, 163)) * 0.8);
        } else lf = grass(o, X, Y, m);

        // the operator's compound and its yards
        const yd = yard ? yard[p] : 0;
        if (yd > 0) {
          const l2 = compacted(tmp, X, Y, m, C.yard);
          mixTo(o, tmp, yd);
          lf += (l2 - lf) * yd;
        }
        // river banks: exposed earth on steep faces, sand and mud on low banks
        if (dO < 45) {
          const steep = smooth(0.25, 0.5, tanS) * smooth(42, 12, dO + 5 * vnoise(X / 11, Y / 11, 167));
          if (steep > 0 && k !== 50) {
            const l2 = earthFace(tmp, X, Y, m);
            mixTo(o, tmp, steep * 0.92);
            lf += (l2 - lf) * steep;
          }
          const n = vnoise(X / 16, Y / 16, 173);
          const low = smooth(3.4, 0.9, hab + 0.9 * n);
          const near = smooth(28, 6, dO + 7 * vnoise(X / 23, Y / 23, 179));
          const sw = low * near;
          if (sw > 0) {
            const l2 = sandBank(tmp, X, Y, m, dO);
            mixTo(o, tmp, sw);
            lf += (l2 - lf) * sw;
          }
        }
      }
      // stone riprap beside the weir's abutments and the flushing channel outlet
      const rp = rip ? rip[p] : 0;
      if (rp > 0) {
        const l2 = riprap(tmp, X, Y, m);
        mixTo(o, tmp, rp);
        lf += (l2 - lf) * rp;
      }
      // the wet band at the water's edge, darker and a little blue
      if (w === 0 && dO < 7) {
        const wet = smooth(3.6 + 1.6 * vnoise(X / 6, Y / 6, 181), 0.2, dO);
        if (wet > 0) {
          scale(o, 1 - 0.34 * wet);
          o[2] += 8 * wet;
        }
      }
      // light from the smooth surface: the scene's sun
      const nx = -RELIEF * gx, ny = -RELIEF * gy;
      const ndl = (nx * SUN[0] + ny * SUN[1] + SUN[2]) / Math.sqrt(nx * nx + ny * ny + 1);
      const shade = AMBIENT + (1 - AMBIENT) * Math.max(0, ndl) / SUN[2];
      const L = shade * lf;
      const q = 4 * p;
      out[q] = o[0] * L;
      out[q + 1] = o[1] * L;
      out[q + 2] = o[2] * L;
      out[q + 3] = 255;
    }
  }
  return out;
}
