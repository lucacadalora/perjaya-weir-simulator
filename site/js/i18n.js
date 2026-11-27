// Text lookup. FROZEN API (CONTRACT section 4.3).
//   t(key, fallbackEnglish, vars) -> string in the current language
//   apply(root) fills every element that has data-t="key" (its own text is the English fallback)
// A key missing from the Indonesian table shows the English fallback, so a new string never blocks a lane.
// Owner of the tables and of this file: lane b03. Other lanes only call t() with a key and an English fallback.

import ID from './i18n/id.js';
import EN from './i18n/en.js';

const TABLES = { id: ID, en: EN };

export function createI18n(store) {
  const missing = new Set();

  function t(key, fallback, vars) {
    const lang = store.get('lang') || 'id';
    let s = TABLES[lang]?.[key];
    if (s == null) {
      if (lang !== 'en') missing.add(key);
      s = TABLES.en?.[key] ?? fallback ?? key;
    }
    if (vars) s = String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
    return s;
  }

  function apply(root = document) {
    for (const el of root.querySelectorAll('[data-t]')) {
      if (el.dataset.tFallback == null) el.dataset.tFallback = el.textContent;
      el.textContent = t(el.dataset.t, el.dataset.tFallback);
    }
    for (const el of root.querySelectorAll('[data-t-title]')) {
      if (el.dataset.tTitleFallback == null) el.dataset.tTitleFallback = el.getAttribute('title') || '';
      const s = t(el.dataset.tTitle, el.dataset.tTitleFallback);
      el.setAttribute('title', s);
      el.setAttribute('aria-label', s);
    }
  }

  t.apply = apply;
  t.missing = () => [...missing].sort();
  t.lang = () => store.get('lang') || 'id';
  return t;
}
