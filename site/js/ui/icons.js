// Icons. Owner: lane b02. CONTRACT section 5.
//   icon(name, {size, title}) -> inline SVG string (24 by 24 grid, 1.6 px stroke in currentColor, square ends).
//   ICON_NAMES -> the list of names. An unknown name returns ''.
// Drawn for this app: an instrument's plain line icons, no fills except where a shape must read as solid.

const P = {
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none"/>',
  layers: '<path d="M12 3.5 2.5 8.5 12 13.5l9.5-5z"/><path d="m2.5 12.5 9.5 5 9.5-5"/><path d="m2.5 16.5 9.5 5 9.5-5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5.5 5.5"/>',
  camera: '<path d="M3 7.5h4l1.5-2.5h7L17 7.5h4V19H3z"/><circle cx="12" cy="13" r="3.5"/>',
  film: '<path d="M3 5h18v14H3z"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
  plus: '<path d="M12 4.5v15M4.5 12h15"/>',
  minus: '<path d="M4.5 12h15"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M12 5.5 14.5 12h-5z" fill="currentColor" stroke="none"/><path d="M12 18.5 9.5 12h5z"/>',
  gate:
    '<path d="M3 20.5h18"/><path d="M4.5 20.5V5M19.5 20.5V5M3 5h18"/><path d="M7.5 9h9v6h-9z"/><path d="M12 5v4"/>',
  drop: '<path d="M12 3.5s-6 6.6-6 11a6 6 0 0 0 12 0c0-4.4-6-11-6-11z"/>',
  wave: '<path d="M2.5 9c2.4-2 4.6-2 7 0s4.6 2 7 0 4.6-2 5 0"/><path d="M2.5 15c2.4-2 4.6-2 7 0s4.6 2 7 0 4.6-2 5 0"/>',
  home: '<path d="M3.5 11 12 4l8.5 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5.5h4V20"/>',
  warning: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5"/><path d="M12 16.8v.2" stroke-width="2.2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.6v.2" stroke-width="2.2"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  download: '<path d="M12 4v11"/><path d="m7 10.5 5 5 5-5"/><path d="M4 19.5h16"/>',
  rain: '<path d="M7 14.5a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 7a3.8 3.8 0 0 1-.5 7.5z"/><path d="m8 17.5-1 2.5M12.5 17.5l-1 2.5M17 17.5l-1 2.5"/>',
  dam: '<path d="M2.5 20.5h19"/><path d="M8 20.5 10 6h4l3.5 14.5"/><path d="M2.5 9.5h6.8"/><path d="M2.5 13h6.3"/><path d="M17 16c1.2-.8 2.4-.8 4.5 0"/>',
  pin: '<path d="M12 21s-6.5-6.3-6.5-11a6.5 6.5 0 0 1 13 0C18.5 14.7 12 21 12 21z"/><circle cx="12" cy="10" r="2.3"/>',
  // Extras (not in the brief's list; free to use).
  reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4v4.5H9"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  ruler: '<path d="M3 16 16 3l5 5L8 21z"/><path d="m7 12 2 2M10 9l2 2M13 6l2 2"/>',
  list: '<path d="M8 6.5h12.5M8 12h12.5M8 17.5h12.5"/><path d="M3.5 6.5h1.5M3.5 12h1.5M3.5 17.5h1.5"/>',
};

export const ICON_NAMES = Object.keys(P);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function icon(name, opts = {}) {
  const body = P[name];
  if (!body) return '';
  const size = opts.size || 18;
  const label = opts.title ? `<title>${esc(opts.title)}</title>` : '';
  const aria = opts.title ? 'role="img"' : 'aria-hidden="true" focusable="false"';
  return (
    `<svg class="icon icon--${name}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" ` +
    `fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" ${aria}>${label}${body}</svg>`
  );
}

export default icon;
