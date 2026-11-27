// Settling basins (lane s, 24 Nov 2026): pure shape helpers for the sediment drawing. No THREE, no map, no DOM.
// Site frame: metres, +X east, +Y up (model metres), +Z south. A basin runs SOUTH to NORTH: its inlet tip (from the
// feed channel) is its southern end, its outlet to the canal its northern end; the flushing gates stand on the bar
// across it. `s` runs 0 at the inlet tip to 1 at the north end, `w` -1 at the west wall to +1 at the east wall.
//
// The deposit is a delta that grows from the inlet towards the bar: its thickness at (s, w) is
//   D x tip(s) x top(s) x front(s, F) x across(w)
// with D the thickness that holds the whole storage when the front F reaches the bar. depositShape() is that formula;
// the GLSL in sediment-glsl.js repeats it (keep both the same). frontTable() gives the volume for each front so the
// drawing holds the engine's deposit volume (metres cubed, at true scale).

export const SHAPE = {
  tip: 0.06, // the inlet transition: no deposit in the jet where the feed channel enters (display shape)
  topFall: 0.35, // the delta's top falls by this share from the inlet to the bar (display shape)
  ramp: 0.12, // the front's slope, as a share of the basin's length (display shape)
  across: 0.14, // a little more against the walls than in the middle (display shape)
};

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (x) => x * x * (3 - 2 * x);
export const smoothstep = (a, b, x) => smooth(clamp((x - a) / (b - a), 0, 1));

// Unit thickness (D = 1) at s, w for a front at F; sbar is the bar's s.
export function depositShape(s, w, F, sbar) {
  const tip = smoothstep(0, SHAPE.tip, s);
  const top = 1 - (SHAPE.topFall * Math.min(s, sbar)) / sbar;
  const front = smooth(clamp((F - s) / SHAPE.ramp, 0, 1));
  const across = 1 - SHAPE.across + SHAPE.across * w * w;
  return tip * top * front * across;
}

// One basin's frame from its smoothed inner ring ([x, z] points) and the bar's z: the inlet tip, the north end,
// rows of [x0, x1] across it, and a 16-step table of centre and half width for the particles.
export function basinFrame(inner, barZ, rows = 56) {
  let zS = -Infinity, zN = Infinity, tipX = 0;
  for (const [x, z] of inner) {
    if (z > zS) { zS = z; tipX = x; }
    if (z < zN) zN = z;
  }
  const L = zS - zN;
  const n = inner.length;
  const span = (zc) => {
    const xs = [];
    for (let i = 0; i < n; i++) {
      const a = inner[i], b = inner[(i + 1) % n];
      if ((a[1] - zc) * (b[1] - zc) <= 0 && a[1] !== b[1]) xs.push(a[0] + ((b[0] - a[0]) * (zc - a[1])) / (b[1] - a[1]));
    }
    return xs.length >= 2 ? [Math.min(...xs), Math.max(...xs)] : null;
  };
  const at = (s) => {
    const z = zS - s * L;
    const sp = span(z);
    return { s, z, x0: sp ? sp[0] : tipX, x1: sp ? sp[1] : tipX };
  };
  const lo = 0.003, hi = 0.997;
  const R = [];
  for (let i = 0; i <= rows; i++) R.push(at(lo + ((hi - lo) * i) / rows));
  const lens = new Float32Array(32);
  for (let k = 0; k < 16; k++) {
    const r = at(lo + ((hi - lo) * k) / 15);
    lens[2 * k] = (r.x0 + r.x1) / 2;
    lens[2 * k + 1] = (r.x1 - r.x0) / 2;
  }
  const sbar = Number.isFinite(barZ) ? clamp((zS - barZ) / L, 0.2, 0.95) : 0.65;
  return { zS, zN, L, sbar, rows: R, lens, span };
}

// Volume (m3 per metre of D) for fronts F = 0 .. sbar in `steps` steps, over the frame's rows (cols across).
export function frontTable(frame, steps = 64, cols = 12) {
  const F = new Float32Array(steps + 1);
  const V = new Float32Array(steps + 1);
  const { rows, sbar, L } = frame;
  for (let k = 0; k <= steps; k++) {
    const f = (sbar * k) / steps;
    let v = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      const ds = (b.s - a.s) * L;
      const width = ((a.x1 - a.x0) + (b.x1 - b.x0)) / 2;
      const sm = (a.s + b.s) / 2;
      let g = 0;
      for (let j = 0; j < cols; j++) g += depositShape(sm, -1 + (2 * (j + 0.5)) / cols, f, sbar);
      v += (g / cols) * width * ds;
    }
    F[k] = f;
    V[k] = v;
  }
  return { F, V };
}

// The front that holds volume v (m3 per metre of D), by interpolation in the table.
export function frontFor(table, v) {
  const { F, V } = table;
  if (!(v > 0)) return 0;
  if (v >= V[V.length - 1]) return F[F.length - 1];
  let i = 1;
  while (i < V.length && V[i] < v) i++;
  const t = (v - V[i - 1]) / Math.max(1e-9, V[i] - V[i - 1]);
  return F[i - 1] + t * (F[i] - F[i - 1]);
}

// The delta's full thickness D for a storage (m3), never deeper than `maxD` (then the drawing holds less: noted).
export function fullThickness(table, storage_m3, maxD) {
  const vFull = table.V[table.V.length - 1];
  if (!(vFull > 0) || !(storage_m3 > 0)) return { D: 0, clamped: false };
  const D = storage_m3 / vFull;
  return D > maxD ? { D: maxD, clamped: true } : { D, clamped: false };
}

// Display turbidity 0..1 from a concentration (mg/L): 1 - exp(-c / cRef). Display choice: cRef 1,000 mg/L puts the
// river at its mean flow (about 700 mg/L) half-way between the clear and the flood look.
export const C_REF_MGL = 1000;
export const turbidity = (c, cRef = C_REF_MGL) => (Number.isFinite(c) && c > 0 ? 1 - Math.exp(-c / cRef) : 0);

// The centre line of the plume a flush sends into the river: from the flushing channel's mouth along its last
// heading, turning to the river's downstream direction; points every `step` metres to `length` metres.
export function plumePath(mouth, heading, downstream, length = 300, step = 6) {
  const n = Math.max(2, Math.round(length / step));
  const a0 = Math.atan2(heading[1], heading[0]);
  let a1 = Math.atan2(downstream[1], downstream[0]);
  while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
  while (a1 - a0 < -Math.PI) a1 += 2 * Math.PI;
  const pts = [[mouth[0], mouth[1]]];
  for (let i = 1; i <= n; i++) {
    const u = i / n;
    const a = a0 + (a1 - a0) * smoothstep(0, 0.3, u);
    const p = pts[i - 1];
    pts.push([p[0] + Math.cos(a) * (length / n), p[1] + Math.sin(a) * (length / n)]);
  }
  return pts;
}
