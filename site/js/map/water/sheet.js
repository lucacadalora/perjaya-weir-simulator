// One water sheet: a flat plane over a grid crop with a mask texture and a ground-height texture. Owner: lane b06.
// Moving the level is one uniform (no texture is rebuilt); a new mask of the same size is copied into the existing
// texture. The sheet is built in its own metres (x east, y up, z south) with its origin at the crop's centre.
// fitTerrain() swaps the 30 m ground for the terrain the map draws, where water may show (lane w, 24 Nov 2026), so
// the depth the shader knows is the depth at the waterline the terrain cuts: the shore band sits on the real edge.

import { createWaterMaterial, createWetMaterial, WAKE_BAYS } from './shader.js';
import { waterKit } from './surface.js';

function halfFloats(THREE, values, base) {
  const out = new Uint16Array(values.length);
  const toHalf = THREE.DataUtils.toHalfFloat;
  for (let i = 0; i < values.length; i++) out[i] = toHalf(values[i] - base);
  return out;
}

function dataTexture(THREE, data, cols, rows, type) {
  const tex = new THREE.DataTexture(data, cols, rows, THREE.RedFormat, type);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

// opts: {cols, rows, ground: Float32Array metres, groundMin, mask: Uint8Array 0/255, width_m, height_m,
//        opacity, depthScale, colours, name, flow: {data: Uint8Array RGBA, cols, rows} (water/flowfield.js)}
export function createSheet(THREE, opts) {
  const { cols, rows, ground, mask, width_m, height_m } = opts;
  const base = Math.floor(opts.groundMin ?? 0);
  // the mask may be finer than the ground (maskCols x maskRows over the same box)
  const mCols = opts.maskCols || cols;
  const mRows = opts.maskRows || rows;
  const maskTex = dataTexture(THREE, mask, mCols, mRows, THREE.UnsignedByteType);
  let groundTex = dataTexture(THREE, halfFloats(THREE, ground, base), cols, rows, THREE.HalfFloatType);
  // hug mode (a river channel in a surface model, where the model's "ground" is the river's own surface on the
  // day it was flown): opts.floor gives a smoothed river surface; the sheet never drops below floor + lift
  const floorTex = opts.floor ? dataTexture(THREE, halfFloats(THREE, opts.floor, base), cols, rows, THREE.HalfFloatType) : null;
  let flowTex = null;
  if (opts.flow && opts.flow.data) {
    flowTex = new THREE.DataTexture(opts.flow.data, opts.flow.cols, opts.flow.rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    flowTex.magFilter = flowTex.minFilter = THREE.LinearFilter;
    flowTex.wrapS = flowTex.wrapT = THREE.ClampToEdgeWrapping;
    flowTex.generateMipmaps = false;
    flowTex.flipY = false;
    flowTex.needsUpdate = true;
  }
  const kit = waterKit(THREE, opts.colours);
  const material = createWaterMaterial(THREE, {
    maskTex, groundTex, floorTex, flowTex, groundBase: base, size: [width_m, height_m],
    opacity: opts.opacity, depthScale: opts.depthScale, colours: opts.colours, lift: opts.lift, minDepth: opts.minDepth, hugShift: opts.hugShift, hugRef: opts.hugRef,
    shore: opts.shore,
  });
  const seg = (n) => (floorTex ? Math.min(n, 320) : 1);
  const geometry = new THREE.PlaneGeometry(width_m, height_m, seg(cols), seg(rows));
  geometry.rotateX(-Math.PI / 2); // into x east, z south (the plane's top edge, +y, becomes north, -z)
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = opts.name || 'water';
  mesh.renderOrder = 5; // after opaque models, so the water blends over sunk structure parts
  mesh.frustumCulled = false;

  kit.watch(mesh); // the eye position, for the reflection

  // the wet band on the bank above the waterline: the same plane drawn again a little higher (shader.js WET); a
  // child of the sheet, so it moves and hides with it
  let wetMat = null;
  if (opts.wet !== false && !(opts.floor && opts.minDepth !== 0)) {
    wetMat = createWetMaterial(THREE, material);
    const wet = new THREE.Mesh(geometry, wetMat);
    wet.name = (opts.name || 'water') + ':wet';
    wet.renderOrder = 4;
    wet.frustumCulled = false;
    mesh.add(wet);
  }

  let level = null;
  let disposed = false;
  let fitted = null;
  return {
    mesh,
    cols,
    rows,
    base,
    get level() {
      return level;
    },
    // level in model metres (the same heights as the terrain)
    setLevel(v) {
      level = v;
      material.uniforms.uLevelRel.value = v - base;
    },
    setMask(bytes) {
      if (bytes.length !== mCols * mRows) return false;
      if (bytes !== maskTex.image.data) maskTex.image.data.set(bytes);
      maskTex.needsUpdate = true;
      return true;
    },
    setTime(t) {
      kit.setTime(t); // one clock for every piece of water
    },
    // a new surface for a hug sheet (same size as the one it was built with), heights in model metres
    setFloor(values) {
      if (!floorTex || values.length !== cols * rows) return false;
      floorTex.image.data.set(halfFloats(THREE, values, base));
      floorTex.needsUpdate = true;
      return true;
    },
    // a new current texture (same size as the one it was built with): RGBA bytes as water/flowfield.js makes them
    setFlowData(bytes) {
      if (!flowTex || bytes.length !== flowTex.image.data.length) return false;
      if (bytes !== flowTex.image.data) flowTex.image.data.set(bytes);
      flowTex.needsUpdate = true;
      return true;
    },
    // the sheet stops on a straight line: (x, z) a point on it in sheet metres, unit (dx, dz) into the sheet;
    // for its first `flat` metres from the line it lies flat at the level (so it meets the weir's water exactly)
    setCut(x, z, dx, dz, flat) {
      material.uniforms.uCut.value.set(x, z, dx, dz);
      material.uniforms.uCutFlat.value = flat > 0 ? flat : 0;
    },
    // the current: mid-channel speed in m/s at a depth of depth_m
    setFlow(speed, depth_m) {
      material.uniforms.uFlowSpeed.value = Number.isFinite(speed) ? Math.max(0, speed) : 0;
      if (depth_m > 0) material.uniforms.uFlowDepth.value = depth_m;
    },
    // white water below the weir: axis centre (x, z) and unit axis direction (dx, dz) in sheet metres, z0 = metres
    // downstream of the axis where this sheet starts, bays = [{x, w, foam, len}] (x along the axis from its centre)
    setWake(x, z, dx, dz, z0, bays) {
      const u = material.uniforms;
      u.uWakeAxis.value.set(x, z, dx, dz);
      u.uWakeZ0.value = z0 > 0 ? z0 : 0;
      for (let i = 0; i < WAKE_BAYS; i++) {
        const b = bays && bays[i];
        if (b) u.uBay.value[i].set(b.x, b.w, b.foam, b.len);
        else u.uBay.value[i].set(0, 0, 0, 1);
      }
    },
    // is there water at (x, z) sheet metres? (the mask says yes and the ground there is below the level)
    wetAt(x, z) {
      if (level == null || !mesh.visible) return false;
      const u = x / width_m + 0.5;
      const v = z / height_m + 0.5;
      if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) return false;
      if (!maskTex.image.data[Math.floor(v * mRows) * mCols + Math.floor(u * mCols)]) return false;
      const cu = material.uniforms.uCut.value;
      if (material.uniforms.uCutFlat.value > 0 && (x - cu.x) * cu.z + (z - cu.y) * cu.w < 0) return false;
      if (floorTex) return true;
      return ground[Math.floor(v * rows) * cols + Math.floor(u * cols)] < level;
    },
    // fade out along a direction: from (x, z) in sheet metres, unit (dx, dz) away, between distances from and to
    setFade(x, z, dx, dz, from, to) {
      material.uniforms.uFade.value.set(x, z, dx, dz);
      material.uniforms.uFadeRange.value.set(from, to);
    },
    setOpacity(a) {
      material.uniforms.uOpacity.value = a;
    },
    // The ground under the water from the terrain the map draws. sampler = ctx.sampler (elevation, elevationSync:
    // the map's own terrain tiles, bilinear); box = the sheet's {west, east, north, south} in degrees. Heights are
    // taken on the mask's grid where the mask may show water and two cells around it; elsewhere the 30 m grid,
    // spread bilinear, stays (it only feeds the reflection of the banks there). Once, in slices of rows that leave
    // the page free between them. Resolves to {texels, ms} or null.
    async fitTerrain(sampler, box) {
      if (fitted) return fitted;
      if (!sampler || typeof sampler.elevation !== 'function' || typeof sampler.elevationSync !== 'function' || !box) return null;
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const W = mCols;
      const H = mRows;
      if (!(W * H > 0) || W * H > 4e6) return null;
      const grid = spreadGround(ground, cols, rows, W, H);
      const near = nearMask(maskTex.image.data, W, H, 2);
      // texel centres: lon linear in x; lat through Mercator, as the sheet itself is laid out on the map
      const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
      const latOf = (y) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;
      const yN = mercY(box.north);
      const yS = mercY(box.south);
      const lonAt = (i) => box.west + ((i + 0.5) / W) * (box.east - box.west);
      const latAt = (j) => latOf(yN + ((j + 0.5) / H) * (yS - yN));
      // load the terrain tiles under the water first: one height every ~600 m over the rows and columns that matter
      const step = Math.max(1, Math.round(W / Math.max(1, (Math.abs(box.east - box.west) * 111000) / 600)));
      const warm = [];
      for (let j = 0; j < H; j += step) for (let i = 0; i < W; i += step) {
        let any = false;
        for (let jj = j; jj < Math.min(H, j + step) && !any; jj++) for (let ii = i; ii < Math.min(W, i + step); ii++) if (near[jj * W + ii]) { any = true; break; }
        if (any) warm.push([lonAt(Math.min(W - 1, i + (step >> 1))), latAt(Math.min(H - 1, j + (step >> 1)))]);
      }
      await Promise.all(warm.map(([lo, la]) => sampler.elevation(lo, la).catch(() => null)));
      let miss = [];
      let got = 0;
      const pass = async (list) => {
        const missed = [];
        let n = 0;
        for (const k of list) {
          const v = sampler.elevationSync(lonAt(k % W), latAt((k / W) | 0));
          if (Number.isFinite(v)) (grid[k] = v), got++;
          else missed.push(k);
          if (++n % 40000 === 0) await new Promise((r) => setTimeout(r, 0));
          if (disposed) return missed;
        }
        return missed;
      };
      const todo = [];
      for (let k = 0; k < W * H; k++) if (near[k]) todo.push(k);
      miss = await pass(todo);
      // tiles that were not loaded yet: load them through a few of the points they hold, then try those again
      for (let round = 0; round < 3 && miss.length && !disposed; round++) {
        const pick = [];
        const every = Math.max(1, Math.floor(miss.length / 48));
        for (let q = 0; q < miss.length; q += every) pick.push(miss[q]);
        await Promise.all(pick.map((k) => sampler.elevation(lonAt(k % W), latAt((k / W) | 0)).catch(() => null)));
        miss = await pass(miss);
      }
      if (disposed) return null;
      const tex = dataTexture(THREE, halfFloats(THREE, grid, base), W, H, THREE.HalfFloatType);
      const old = groundTex;
      groundTex = tex;
      material.uniforms.uGround.value = tex;
      material.uniforms.uGroundTexel.value.set(1 / W, 1 / H);
      if (!floorTex) material.uniforms.uFloor.value = tex;
      old.dispose();
      const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      fitted = { texels: got, missed: miss.length, ms: Math.round(t1 - t0), cols: W, rows: H };
      if (typeof opts.onFit === 'function') opts.onFit(fitted);
      return fitted;
    },
    get fitted() {
      return fitted;
    },
    dispose() {
      disposed = true;
      geometry.dispose();
      material.dispose();
      if (wetMat) wetMat.dispose();
      maskTex.dispose();
      groundTex.dispose();
      if (floorTex) floorTex.dispose();
      if (flowTex) flowTex.dispose();
      if (material.userData.ownFlowTex) material.userData.ownFlowTex.dispose();
    },
  };
}

// A cols x rows grid of heights spread bilinear onto W x H texels over the same box (cell centres to texel centres,
// as the GPU would sample it). Pure.
export function spreadGround(ground, cols, rows, W, H) {
  const out = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    const v = Math.max(0, Math.min(rows - 1, ((j + 0.5) / H) * rows - 0.5));
    const r0 = Math.min(rows - 2, Math.floor(v));
    const fy = rows > 1 ? v - Math.max(0, r0) : 0;
    const ra = Math.max(0, r0);
    const rb = Math.min(rows - 1, ra + 1);
    for (let i = 0; i < W; i++) {
      const u = Math.max(0, Math.min(cols - 1, ((i + 0.5) / W) * cols - 0.5));
      const c0 = Math.max(0, Math.min(cols - 2, Math.floor(u)));
      const ca = c0;
      const cb = Math.min(cols - 1, ca + 1);
      const fx = cols > 1 ? u - ca : 0;
      const a = ground[ra * cols + ca];
      const b = ground[ra * cols + cb];
      const c = ground[rb * cols + ca];
      const d = ground[rb * cols + cb];
      out[j * W + i] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

// 1 where a mask byte is set or lies within `r` cells of one (a square neighbourhood). Pure.
export function nearMask(mask, W, H, r) {
  const rowHit = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    let last = -1e9;
    for (let i = 0; i < W; i++) {
      if (mask[j * W + i]) last = i;
      if (i - last <= r) rowHit[j * W + i] = 1;
    }
    last = 1e9;
    for (let i = W - 1; i >= 0; i--) {
      if (mask[j * W + i]) last = i;
      if (last - i <= r) rowHit[j * W + i] = 1;
    }
  }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W; i++) {
    let last = -1e9;
    for (let j = 0; j < H; j++) {
      if (rowHit[j * W + i]) last = j;
      if (j - last <= r) out[j * W + i] = 1;
    }
    last = 1e9;
    for (let j = H - 1; j >= 0; j--) {
      if (rowHit[j * W + i]) last = j;
      if (last - j <= r) out[j * W + i] = 1;
    }
  }
  return out;
}
