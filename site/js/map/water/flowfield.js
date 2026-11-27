// Which way the river runs at every point of a channel mask. Owner: lane b06. Pure: no DOM, no three.js.
//
// The distance along the channel from the weir is found by walking through the wet cells only (so it follows
// every bend); the current points along the slope of that distance. Display only: it steers how the ripples and
// the foam travel, never a number on a panel.
//
// flowField(mask, cols, rows, seeds, {away, step})
//   mask   Uint8Array, 1 = channel            seeds  [[col, row, distance_cells], ...] cells where the walk starts
//   away   true: the current runs away from the seeds (a reach below the weir); false: towards them (above it)
//   step   keep every step-th cell in each direction (the field is smooth; a coarse texture is enough)
// -> { data: Uint8Array RGBA (R, G = direction east, south packed 0..255; B = 255 in mid-channel, less at the
//      banks, 0 on land; A = 255), cols, rows, reached }

const SQRT2 = Math.SQRT2;

export function channelDistance(mask, cols, rows, seeds) {
  const dist = new Float32Array(cols * rows).fill(Infinity);
  // binary heap of [distance, index]
  const hd = [];
  const hi = [];
  const push = (d, i) => {
    let k = hd.length;
    hd.push(d);
    hi.push(i);
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (hd[p] <= d) break;
      hd[k] = hd[p];
      hi[k] = hi[p];
      k = p;
    }
    hd[k] = d;
    hi[k] = i;
  };
  const pop = () => {
    const d0 = hd[0];
    const i0 = hi[0];
    const d = hd.pop();
    const i = hi.pop();
    const n = hd.length;
    if (n) {
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= n) break;
        if (c + 1 < n && hd[c + 1] < hd[c]) c++;
        if (hd[c] >= d) break;
        hd[k] = hd[c];
        hi[k] = hi[c];
        k = c;
      }
      hd[k] = d;
      hi[k] = i;
    }
    return [d0, i0];
  };
  for (const [c, r, d] of seeds) {
    if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
    const i = r * cols + c;
    const ds = Math.fround(d);
    if (!mask[i] || dist[i] <= ds) continue;
    dist[i] = ds;
    push(ds, i);
  }
  let reached = 0;
  while (hd.length) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    reached++;
    const c = i % cols;
    const r = (i - c) / cols;
    for (let dr = -1; dr <= 1; dr++) {
      const rr = r + dr;
      if (rr < 0 || rr >= rows) continue;
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const cc = c + dc;
        if (cc < 0 || cc >= cols) continue;
        const j = rr * cols + cc;
        if (!mask[j]) continue;
        const nd = Math.fround(d + (dr && dc ? SQRT2 : 1)); // as the array stores it, so a stale heap entry is told apart
        if (nd < dist[j]) {
          dist[j] = nd;
          push(nd, j);
        }
      }
    }
  }
  return { dist, reached };
}

export function flowField(mask, cols, rows, seeds, { away = true, step = 2 } = {}) {
  const { dist, reached } = channelDistance(mask, cols, rows, seeds);
  const oc = Math.ceil(cols / step);
  const or = Math.ceil(rows / step);
  const gx = new Float32Array(oc * or);
  const gy = new Float32Array(oc * or);
  const wet = new Float32Array(oc * or); // share of wet cells around the point: 1 in mid-channel
  const R = 4; // cells either side for the slope: wide enough to hide the walk's eight directions
  for (let r = 0; r < or; r++) for (let c = 0; c < oc; c++) {
    const c0 = Math.min(cols - 1, c * step);
    const r0 = Math.min(rows - 1, r * step);
    let sx = 0;
    let sy = 0;
    let n = 0;
    let all = 0;
    for (let dr = -R; dr <= R; dr++) {
      const rr = r0 + dr;
      if (rr < 0 || rr >= rows) continue;
      for (let dc = -R; dc <= R; dc++) {
        const cc = c0 + dc;
        if (cc < 0 || cc >= cols) continue;
        all++;
        const d = dist[rr * cols + cc];
        if (d === Infinity) continue;
        n++;
        // least-squares slope of the distance over the wet cells around the point
        sx += dc * d;
        sy += dr * d;
      }
    }
    const o = r * oc + c;
    wet[o] = all ? n / all : 0;
    if (n < 3) continue;
    // remove the mean (the window is lopsided at a bank): slope = sum((x - mx)(d - md)) / spread
    let mx = 0;
    let my = 0;
    let md = 0;
    for (let dr = -R; dr <= R; dr++) {
      const rr = r0 + dr;
      if (rr < 0 || rr >= rows) continue;
      for (let dc = -R; dc <= R; dc++) {
        const cc = c0 + dc;
        if (cc < 0 || cc >= cols) continue;
        const d = dist[rr * cols + cc];
        if (d === Infinity) continue;
        mx += dc;
        my += dr;
        md += d;
      }
    }
    mx /= n;
    my /= n;
    md /= n;
    gx[o] = sx - n * mx * md;
    gy[o] = sy - n * my * md;
  }
  // one smoothing pass over the directions, then pack
  const data = new Uint8Array(oc * or * 4);
  const sgn = away ? 1 : -1;
  for (let r = 0; r < or; r++) for (let c = 0; c < oc; c++) {
    let x = 0;
    let y = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = Math.min(or - 1, Math.max(0, r + dr));
      const cc = Math.min(oc - 1, Math.max(0, c + dc));
      const l = Math.hypot(gx[rr * oc + cc], gy[rr * oc + cc]);
      if (l > 0) {
        x += gx[rr * oc + cc] / l;
        y += gy[rr * oc + cc] / l;
      }
    }
    const l = Math.hypot(x, y);
    const o = (r * oc + c) * 4;
    data[o] = l > 0 ? Math.round(127.5 + (127.5 * sgn * x) / l) : 128;
    data[o + 1] = l > 0 ? Math.round(127.5 + (127.5 * sgn * y) / l) : 128;
    // slack water at the banks: full speed once two thirds of the cells around are wet
    const w = wet[r * oc + c];
    data[o + 2] = Math.round(255 * Math.min(1, Math.max(0, (w - 0.2) / 0.45)));
    data[o + 3] = 255;
  }
  return { data, cols: oc, rows: or, reached };
}
