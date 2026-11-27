// Mounts one 3D model per maker dam (CONTRACT 4.4 `maker`, field `dam.line:<id>`). Owner: lane b24.
// The model is built by buildDam (structures/dam.js) on the dam line from the reservoir engine, with the ground
// under its footprint read from the terrain tiles (ctx.sampler) so its base follows the ground the map draws.
// Rebuilt when the line, crest, type or widths change; removed with the dam; white water follows `spill_m3s`.

import { buildDam } from './dam.js';
import { WATER } from '../water/palette.js';

const num = (v) => (Number.isFinite(v) ? v : null);

export async function init(ctx) {
  const s3 = ctx.scene3d, store = ctx.store, geo = ctx.geo;
  if (!s3 || !store || !ctx.fields || !geo) return;
  const THREE = s3.THREE;
  let params = null;
  try { params = await ctx.data.json('params.json'); } catch (e) { params = null; }
  const leaf = (v) => (v && typeof v === 'object' && 'v' in v ? v.v : v);
  const crestWidthDefault = num(leaf(params && params.maker && params.maker.crest_width_m));

  const live = new Map(); // id -> { key, handle, model, building }
  const watched = new Set();

  // the ground under the footprint: a grid of terrain heights in (d along the line, z upstream), bilinear
  async function groundFor(line, height) {
    const s = ctx.sampler;
    if (!s || typeof s.elevations !== 'function') return null;
    const L = line.length_m;
    const ext = Math.max(120, 0.4 * L);
    const zUp = 3.5 * height + 80, zDn = 4 * height + 360;
    const d0 = -ext, d1 = L + ext;
    const nd = Math.min(90, Math.max(20, Math.ceil((d1 - d0) / 15))), nz = Math.min(70, Math.max(16, Math.ceil((zUp + zDn) / 15)));
    const ab = line.bearing_deg, up = ab + 90;
    const pts = [];
    for (let j = 0; j < nz; j++) {
      const z = -zDn + ((zUp + zDn) * j) / (nz - 1);
      const base = z >= 0 ? geo.destination(line.a.lon, line.a.lat, z, up) : geo.destination(line.a.lon, line.a.lat, -z, up + 180);
      for (let i = 0; i < nd; i++) {
        const d = d0 + ((d1 - d0) * i) / (nd - 1);
        pts.push(d >= 0 ? geo.destination(base[0], base[1], d, ab) : geo.destination(base[0], base[1], -d, ab + 180));
      }
    }
    let h;
    try { h = await s.elevations(pts); } catch (e) { return null; }
    if (!h || h.length !== pts.length) return null;
    const dd = (d1 - d0) / (nd - 1), dz = (zUp + zDn) / (nz - 1);
    return (d, z) => {
      const fi = Math.max(0, Math.min(nd - 1.001, (d - d0) / dd)), fj = Math.max(0, Math.min(nz - 1.001, (z + zDn) / dz));
      const i = Math.floor(fi), j = Math.floor(fj), ti = fi - i, tj = fj - j;
      const v = (a, b) => h[b * nd + a];
      const q = [v(i, j), v(i + 1, j), v(i, j + 1), v(i + 1, j + 1)];
      if (q.some((x) => !Number.isFinite(x))) return null;
      return (q[0] * (1 - ti) + q[1] * ti) * (1 - tj) + (q[2] * (1 - ti) + q[3] * ti) * tj;
    };
  }

  function drop(id) {
    const e = live.get(id);
    if (!e) return;
    if (e.handle) e.handle.remove();
    if (e.model) e.model.dispose();
    live.delete(id);
  }

  async function mount(dam, line, key) {
    const entry = { key, building: true };
    const old = live.get(dam.id);
    live.set(dam.id, { ...(old || {}), key, building: true });
    const crest = num(dam.crest_el) ?? num(line.crest_el);
    const height = crest - num(line.base_el);
    const ground = await groundFor(line, Math.max(5, height || 30));
    const cur = live.get(dam.id);
    if (!cur || cur.key !== key) return; // superseded while sampling
    let model;
    try {
      model = buildDam(THREE, {
        profile: line.profile, crest_el: crest, base_el: line.base_el, type: dam.type,
        crest_width_m: num(dam.crest_width_m) ?? crestWidthDefault ?? undefined,
        spill_width_m: num(dam.spill_width_m) ?? undefined,
        ground: ground || undefined,
        water: WATER,
      });
    } catch (e) {
      ctx.log && ctx.log('mount-dam: model failed', e);
      return;
    }
    if (old && old.handle) { old.handle.remove(); if (old.model) old.model.dispose(); }
    const o = model.info.origin_d_m;
    const [lon, lat] = geo.destination(line.a.lon, line.a.lat, o, line.bearing_deg);
    const handle = s3.add(model.group, { lon, lat, el: model.info.base_el, bearing_deg: line.bearing_deg - 90 });
    model.setSpill(num(dam.spill_m3s) || 0);
    Object.assign(entry, { handle, model, building: false });
    live.set(dam.id, entry);
    if (typeof window !== 'undefined') window.__damModels = Object.fromEntries([...live].map(([k, v]) => [k, v.model && { tris: v.model.tris, info: v.model.info }]));
    s3.requestRender();
  }

  function sync() {
    const m = store.get('maker');
    const dams = (m && Array.isArray(m.dams) ? m.dams : []).filter((d) => d && d.id);
    const ids = new Set(dams.map((d) => d.id));
    for (const id of [...live.keys()]) if (!ids.has(id)) drop(id);
    for (const d of dams) {
      if (!watched.has(d.id)) { watched.add(d.id); ctx.fields.on('dam.line:' + d.id, () => sync()); }
      const line = ctx.fields.get('dam.line:' + d.id);
      if (!line || !line.ok || !line.a || !line.b || !Array.isArray(line.profile)) { drop(d.id); continue; }
      const key = [line.a.lon, line.a.lat, line.b.lon, line.b.lat, line.length_m, d.crest_el ?? line.crest_el, d.type,
        d.spill_width_m, d.crest_width_m].join('|');
      const e = live.get(d.id);
      if (!e || e.key !== key) { mount(d, line, key); continue; }
      if (e.model) e.model.setSpill(num(d.spill_m3s) || 0);
    }
    s3.requestRender();
  }

  store.on('maker', sync, { immediate: true });
  s3.onFrame((dt) => { for (const e of live.values()) if (e.model) e.model.update(dt); });
}
