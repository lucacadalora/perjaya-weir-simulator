// Number, unit and date formatting in the current language. FROZEN API (CONTRACT section 4.3). Owner: lane b03.
//   num(v, digits) · q(v) "123 m³/s" · vol(m3) "1,2 juta m³" · area(km2) · ha(v) · el(m) "+81,00 m" · len(m)
//   pct(fraction) "12,5%" (EYD: no space) · date(iso | Date) · every function returns "–" for null, undefined or NaN.
//   Extra (b03): mm(v) "123 mm" · lsha(v) "1,20 l/s/ha" · month(iso) "Juni 2026" · days(n) "3 hari" / "3 days"
export function createFmt(store) {
  const loc = () => ((store.get('lang') || 'id') === 'id' ? 'id-ID' : 'en-GB');
  const bad = (v) => v == null || Number.isNaN(Number(v));
  const num = (v, d = 0) => (bad(v) ? '–' : Number(v).toLocaleString(loc(), { minimumFractionDigits: d, maximumFractionDigits: d }));
  const id = () => (store.get('lang') || 'id') === 'id';
  return {
    num,
    q: (v) => (bad(v) ? '–' : num(v, Math.abs(v) < 10 ? 2 : Math.abs(v) < 100 ? 1 : 0) + ' m³/s'),
    vol: (m3) => {
      if (bad(m3)) return '–';
      const a = Math.abs(m3);
      if (a >= 1e9) return num(m3 / 1e9, 2) + (id() ? ' miliar m³' : ' billion m³');
      if (a >= 1e5) return num(m3 / 1e6, a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2) + (id() ? ' juta m³' : ' million m³');
      return num(m3, 0) + ' m³';
    },
    area: (km2) => (bad(km2) ? '–' : num(km2, Math.abs(km2) < 10 ? 2 : Math.abs(km2) < 100 ? 1 : 0) + ' km²'),
    ha: (v) => (bad(v) ? '–' : num(v, 0) + ' ha'),
    el: (m) => (bad(m) ? '–' : (m >= 0 ? '+' : '−') + num(Math.abs(m), 2) + ' m'),
    len: (m) => (bad(m) ? '–' : Math.abs(m) >= 1000 ? num(m / 1000, 1) + ' km' : num(m, 0) + ' m'),
    pct: (f) => (bad(f) ? '–' : num(f * 100, 1) + '%'),
    mm: (v) => (bad(v) ? '–' : num(v, Math.abs(v) < 10 && v !== 0 ? 1 : 0) + ' mm'),
    lsha: (v) => (bad(v) ? '–' : num(v, 2) + ' l/s/ha'),
    days: (n) => (bad(n) ? '–' : num(n, 0) + (id() ? ' hari' : Math.abs(n) === 1 ? ' day' : ' days')),
    month: (d) => {
      if (d == null) return '–';
      const x = d instanceof Date ? d : new Date(String(d).length <= 10 ? String(d).slice(0, 7) + '-01T00:00:00Z' : d);
      return Number.isNaN(x.getTime()) ? '–' : x.toLocaleDateString(loc(), { month: 'long', year: 'numeric', timeZone: 'UTC' });
    },
    date: (d) => {
      if (d == null) return '–';
      const x = d instanceof Date ? d : new Date(String(d).length <= 10 ? d + 'T00:00:00Z' : d);
      return Number.isNaN(x.getTime()) ? '–' : x.toLocaleDateString(loc(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    },
  };
}
