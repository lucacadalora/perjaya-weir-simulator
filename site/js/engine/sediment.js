// Sediment through the intake and the five settling basins (kantong lumpur, "Bak Desilting Perjaya"). Owner: lane s
// (24 Nov 2026). CONTRACT 4.8: pure, no DOM, no imports; every constant comes from params.json (group `sediment`)
// and weir.json (`settling_basins`) through sedimentParams(), never from a number typed here (unit conversions only).
//
// What one step does (cut into sub-steps of at most SUB_S seconds, so a year-per-second clock gives the same answer
// as an hour-per-second one):
//   river    load from the sourced rating Qs = a Qw^b (t/day, Qw m3/s; 1986-87 survey, JICA 2003). With
//            `rating_fit_yield` the coefficient a is scaled so that the mean year's monthly flows carry the sourced
//            yield (5.02 Mt/yr at Martapura); the exponent stays the sourced one. Concentration held at conc_max_mgL.
//   intake   draws intake_factor x the river's mean concentration (the scouring sluices and the intake sill keep the
//            bed load out). The canal flow is shared equally by the basins that are not being flushed.
//   basins   each keeps trap_sand of the sand share and trap_fine of the rest, less when it runs over its design flow
//            (Hazen: x q_design / q) and less as it fills (falls to nothing from trap_full_from to full).
//            Deposit volume = tonnes / dry density; storage per basin = width x length x storage depth.
//   flushing automatic: the fullest basin once it reaches flush_at, one basin at a time, so the canal keeps running
//            from the others; by hand: queued. A flush empties the deposit exponentially to flush_left of it in
//            flush_hours while flush_q_m3s runs through the flushing gates and Saluran Bilas back to the river; it
//            waits while the river has no water to spare beyond what the intake takes.
//
// sedimentParams(paramsJson, weirJson) -> P | null
// ratingA(P) -> a used (t/day per (m3/s)^b)          riverLoad(q_m3s, P) -> { t_day, c_mgL }
// storageM3(P) -> m3 per basin                       initState(P) -> state
// requestFlush(state, basin | null, P) -> { state, basin }   (null: the fullest basin not already flushing or queued)
// step(state, { q_river, q_intake, dt_s, auto }, P) -> { state, out }   (state is never changed in place)

const DAY_S = 86400; // seconds in a day (unit)
const MGL_PER_KGM3 = 1000; // mg/L per kg/m3 (unit)
const SUB_S = 900; // numerics, not a model parameter: the longest sub-step (15 minutes)
const MONTH_DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // calendar (unit)

const val = (x) => (x && typeof x === 'object' && !Array.isArray(x) && 'v' in x ? x.v : x);
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// Plain parameters from the data files. Null when a needed value is missing.
export function sedimentParams(paramsJson, weirJson) {
  const flat = (paramsJson && paramsJson.flat) || {};
  const grp = (paramsJson && paramsJson.sediment) || {};
  const get = (k) => {
    const f = flat['sediment.' + k];
    return f !== undefined ? val(f) : val(grp[k]);
  };
  const SB = (weirJson && weirJson.settling_basins) || {};
  const depth = val(SB.depth_m);
  const P = {
    rating_a: get('rating_a'), rating_b: get('rating_b'), yield_t_yr: get('yield_t_yr'),
    rating_fit_yield: get('rating_fit_yield') === true,
    monthly_q_m3s: val(flat['hydro.monthly_mean_m3s']) ?? val(paramsJson && paramsJson.hydro && paramsJson.hydro.monthly_mean_m3s),
    conc_max_mgL: get('conc_max_mgL'), intake_factor: get('intake_factor'), intake_sand_share: get('intake_sand_share'),
    trap_sand: get('trap_sand'), trap_fine: get('trap_fine'), trap_full_from: get('trap_full_from'),
    dry_density_t_m3: get('dry_density_t_m3'), storage_depth_m: get('storage_depth_m'),
    flush_at: get('flush_at'), flush_hours: get('flush_hours'), flush_left: get('flush_left'), flush_q_m3s: get('flush_q_m3s'),
    start_fill: get('start_fill'),
    count: val(SB.count), width_m: val(SB.width_m), length_m: val(SB.length_m),
    depth_m: Array.isArray(depth) ? Math.max(...depth) : depth,
    q_design_m3s: val(SB.capacity_each_m3s),
  };
  const need = ['rating_a', 'rating_b', 'intake_factor', 'intake_sand_share', 'trap_sand', 'trap_fine', 'trap_full_from',
    'dry_density_t_m3', 'storage_depth_m', 'flush_at', 'flush_hours', 'flush_left', 'flush_q_m3s', 'count', 'width_m',
    'length_m', 'q_design_m3s'];
  for (const k of need) if (!fin(P[k])) return null;
  return P;
}

// The rating coefficient in use: the sourced one, or scaled to the sourced yield over the mean year's monthly flows.
export function ratingA(P) {
  if (!P.rating_fit_yield || !fin(P.yield_t_yr) || !Array.isArray(P.monthly_q_m3s) || P.monthly_q_m3s.length !== 12) return P.rating_a;
  let s = 0;
  for (let m = 0; m < 12; m++) s += MONTH_DAYS[m] * P.rating_a * Math.pow(Math.max(0, P.monthly_q_m3s[m]), P.rating_b);
  return s > 0 ? (P.rating_a * P.yield_t_yr) / s : P.rating_a;
}

// River load and its mean concentration at a flow.
export function riverLoad(q_m3s, P, a = ratingA(P)) {
  const q = fin(q_m3s) ? Math.max(0, q_m3s) : 0;
  if (q <= 0) return { t_day: 0, c_mgL: 0 };
  let c = (a * Math.pow(q, P.rating_b - 1) * 1e6) / DAY_S; // t/day / (m3/s x s/day) -> t/m3 -> g/m3 = mg/L
  if (fin(P.conc_max_mgL)) c = Math.min(c, P.conc_max_mgL);
  return { t_day: (c * q * DAY_S) / 1e6, c_mgL: c };
}

export const storageM3 = (P) => P.width_m * P.length_m * P.storage_depth_m;

export function initState(P) {
  const S = storageM3(P);
  const f = Array.isArray(P.start_fill) ? P.start_fill : [];
  const basins = Array.from({ length: P.count }, (_, i) => ({
    deposit_m3: Math.max(0, Math.min(1, fin(f[i]) ? f[i] : 0)) * S, flush_h: 0, flushes: 0,
  }));
  return { basins, active: null, queue: [] };
}

const copy = (s) => ({ basins: s.basins.map((b) => ({ ...b })), active: s.active, queue: s.queue.slice() });

function fullest(st, P, exclude) {
  const S = storageM3(P);
  let k = null;
  for (let i = 0; i < st.basins.length; i++) {
    if (exclude(i)) continue;
    if (k == null || st.basins[i].deposit_m3 / S > st.basins[k].deposit_m3 / S) k = i;
  }
  return k;
}

// A flush by hand: started at once when nothing is flushing, else queued. Asking twice for a basin changes nothing.
export function requestFlush(state, basin, P) {
  const st = copy(state);
  const busy = (i) => i === st.active || st.queue.includes(i);
  let k = Number.isInteger(basin) && basin >= 0 && basin < st.basins.length ? basin : null;
  if (k == null) k = fullest(st, P, busy);
  if (k == null || busy(k)) return { state: st, basin: k };
  if (st.active == null) {
    st.active = k;
    st.basins[k].flush_h = 0;
  } else st.queue.push(k);
  return { state: st, basin: k };
}

// Trap share of the intake's load in one settling basin at flow q (m3/s) and fill (0..1).
export function trapShare(q, fill, P) {
  if (!(q > 0)) return 0;
  const base = P.intake_sand_share * P.trap_sand + (1 - P.intake_sand_share) * P.trap_fine;
  const over = Math.min(1, P.q_design_m3s / q);
  const from = P.trap_full_from;
  const full = fill <= from ? 1 : Math.max(0, (1 - fill) / Math.max(1e-9, 1 - from));
  return base * over * full;
}

export function step(state, inp, P) {
  const st = copy(state);
  const a = ratingA(P);
  const S = storageM3(P);
  const rho = P.dry_density_t_m3 * 1000; // kg/m3
  const qr = fin(inp.q_river) ? Math.max(0, inp.q_river) : 0;
  const qi = fin(inp.q_intake) ? Math.max(0, inp.q_intake) : 0;
  const auto = inp.auto !== false;
  const river = riverLoad(qr, P, a);
  const cIn = river.c_mgL * P.intake_factor; // mg/L = g/m3
  const kFlush = Math.log(1 / Math.max(1e-6, P.flush_left)) / (P.flush_hours * 3600); // 1/s
  const spare = Math.max(0, qr - qi);
  const speed = Math.min(1, spare / P.flush_q_m3s); // a flush runs only on water the river can spare
  let trapped_kg = 0;
  let returned_kg = 0;

  const startNext = () => {
    if (st.active != null) return;
    if (st.queue.length) {
      st.active = st.queue.shift();
      st.basins[st.active].flush_h = 0;
      return;
    }
    if (!auto) return;
    const k = fullest(st, P, () => false);
    if (k != null && st.basins[k].deposit_m3 >= P.flush_at * S) {
      st.active = k;
      st.basins[k].flush_h = 0;
    }
  };

  let left = fin(inp.dt_s) ? Math.max(0, inp.dt_s) : 0;
  startNext();
  while (left > 1e-9) {
    let h = Math.min(SUB_S, left);
    if (st.active != null && speed > 0) h = Math.min(h, Math.max(1e-6, (P.flush_hours - st.basins[st.active].flush_h) * 3600 / speed)); // end a flush on time
    left -= h;
    const nSet = st.basins.length - (st.active != null ? 1 : 0);
    const qb = nSet > 0 ? qi / nSet : 0;
    for (let i = 0; i < st.basins.length; i++) {
      const b = st.basins[i];
      if (i === st.active) {
        const before = b.deposit_m3;
        b.deposit_m3 = before * Math.exp(-kFlush * speed * h);
        returned_kg += (before - b.deposit_m3) * rho;
        b.flush_h += (speed * h) / 3600;
      } else if (qb > 0) {
        const kg = ((qb * cIn) / 1000) * trapShare(qb, b.deposit_m3 / S, P) * h; // g/m3 x m3/s -> g/s -> kg/s
        b.deposit_m3 = Math.min(S, b.deposit_m3 + kg / rho);
        trapped_kg += kg;
      }
    }
    if (st.active != null && st.basins[st.active].flush_h >= P.flush_hours - 1e-9) {
      st.basins[st.active].flushes += 1;
      st.basins[st.active].flush_h = 0;
      st.active = null;
    }
    startNext();
  }

  // the picture at the end of the step: rates now, per basin
  const nSet = st.basins.length - (st.active != null ? 1 : 0);
  const qb = nSet > 0 ? qi / nSet : 0;
  let trapNow = 0; // kg/s
  const basins = st.basins.map((b, i) => {
    const fill = b.deposit_m3 / S;
    if (i === st.active) {
      return { deposit_m3: b.deposit_m3, fill, state: 'flushing', progress: Math.min(1, b.flush_h / P.flush_hours), q_m3s: P.flush_q_m3s * speed, flushes: b.flushes, waiting: speed <= 0 };
    }
    const share = trapShare(qb, fill, P);
    trapNow += ((qb * cIn) / 1000) * share;
    return { deposit_m3: b.deposit_m3, fill, state: st.queue.includes(i) ? 'queued' : 'settling', progress: 0, q_m3s: qb, flushes: b.flushes, trap: share };
  });
  const loadIn = (qi * cIn) / 1000; // kg/s into the basins that settle
  const cCanal = qi > 0 && nSet > 0 ? cIn * (1 - trapNow / Math.max(1e-12, loadIn)) : null;
  const qFlush = st.active != null ? P.flush_q_m3s * speed : 0;
  const scour = st.active != null ? st.basins[st.active].deposit_m3 * kFlush * speed * rho : 0; // kg/s
  let next = null;
  if (st.active == null) {
    const k = st.queue.length ? st.queue[0] : fullest(st, P, () => false);
    if (k != null) {
      const b = st.basins[k];
      const rate = (((qb * cIn) / 1000) * trapShare(qb, b.deposit_m3 / S, P)) / rho; // m3/s
      const need = P.flush_at * S - b.deposit_m3;
      next = { basin: k, days: st.queue.length || need <= 0 ? 0 : rate > 0 ? need / rate / DAY_S : null };
    }
  }
  const out = {
    c_river_mgL: river.c_mgL,
    c_intake_mgL: qi > 0 ? cIn : null,
    c_canal_mgL: cCanal,
    c_flush_mgL: qFlush > 0 ? (scour / qFlush) * MGL_PER_KGM3 + cIn : null,
    river_t_day: river.t_day,
    intake_t_day: (loadIn * DAY_S) / 1000,
    trapped_t_day: (trapNow * DAY_S) / 1000,
    flushed_t_day: (scour * DAY_S) / 1000,
    q_flush_m3s: qFlush,
    trapped_t: trapped_kg / 1000,
    returned_t: returned_kg / 1000,
    storage_m3: S,
    flush_at: P.flush_at,
    flush_hours: P.flush_hours,
    rating_a: a,
    basins,
    flushing: st.active,
    queue: st.queue.slice(),
    next,
  };
  return { state: st, out };
}
