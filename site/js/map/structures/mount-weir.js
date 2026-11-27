// Mounts the weir model on the map (lane b08). Reads weir.json and params.json, places the model on the weir axis
// through ctx.scene3d and follows weir.gates, weir.sluices, weir.pond_el and weir.tail_el from the store.
// Levels: the store holds project EL; the model's y IS project EL (see weir.js), so the model is placed at
// el = params.datum.offset_m (model metres = EL + offset, CONTRACT 2.3) and levels go in unchanged.
import { buildWeir } from './weir.js';

export async function init(ctx) {
  const s3 = ctx && ctx.scene3d;
  if (!s3 || !s3.THREE || typeof s3.add !== 'function') return; // no 3D host (module run alone, or no WebGL)
  let W = null, params = null;
  try { W = await ctx.data.json('weir.json'); } catch { W = null; }
  try { params = await ctx.data.json('params.json'); } catch { params = null; }
  const leaf = (x) => (x && typeof x === 'object' && 'v' in x ? x.v : x);
  const offset = Number(leaf(params?.datum?.offset_m) ?? leaf(W?.meta?.datum_offset_m) ?? 0); // FALLBACK 0
  const lon = Number(leaf(W?.axis?.lon) ?? 104.38101); // FALLBACK: SETTLE.md / lead addendum
  const lat = Number(leaf(W?.axis?.lat) ?? -4.30512); // FALLBACK
  const axisBearing = Number(leaf(W?.axis?.bearing_deg) ?? 90); // FALLBACK

  let water = null; // lane b06's shared water palette (CONTRACT A8.1); the model keeps its own blue without it
  try { const pal = await import('../water/palette.js'); water = pal.WATER || pal.default || null; } catch { water = null; }
  const model = buildWeir(s3.THREE, { ...(W || {}), water });
  model.group.name = 'weir';
  const handle = s3.add(model.group, { lon, lat, el: offset, bearing_deg: axisBearing - 90 });
  const P = model.params;
  const store = ctx.store;
  const arr = (x) => (Array.isArray(x) || ArrayBuffer.isView(x) ? x : null);

  const apply = () => {
    const w = (store && store.get('weir')) || {};
    const g = arr(w.gates), sl = arr(w.sluices);
    if (g) model.setGates(g);
    if (sl) model.setSluices(sl);
    const pond = Number.isFinite(w.pond_el) ? w.pond_el : P.pond;
    const tail = Number.isFinite(w.tail_el) ? w.tail_el : P.riverbed + 2; // FALLBACK until the engine runs
    model.setLevels({ pond_y: pond, tail_y: tail });
    // the flow through every bay, from the engine (weir.solve); without it the model estimates from the openings
    model.setFlows({ gate_q: arr(w.gate_q), sluice_q: arr(w.sluice_q) });
    s3.requestRender();
  };
  apply();
  model.settle(); // the first picture shows the state as it is, with no glide from nothing
  const offs = [];
  if (store && typeof store.on === 'function') {
    for (const k of ['weir.gates', 'weir.sluices', 'weir.pond_el', 'weir.tail_el', 'weir.gate_q', 'weir.sluice_q']) offs.push(store.on(k, apply));
  }
  if (typeof s3.onFrame === 'function') offs.push(s3.onFrame((dt, t) => model.update(dt, t)));

  ctx.weirModel = { model, handle, offset, dispose() { offs.forEach((f) => f && f()); handle.remove(); } };
  if (ctx.log) ctx.log(`weir model: ${model.triangles} triangles`);
}
