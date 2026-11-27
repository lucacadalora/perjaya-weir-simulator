// Title card and credit line burnt into every film frame and still picture. Owner: lane b10.
// Pure 2D canvas drawing: no store, no map. The card is the only dark element allowed (CONTRACT 2.8).
//
// drawFrame(g, src, w, h, info): draws the map canvas `src` cover-fitted into w x h, then the card and credit line.
// info = { name, kind, date, numbers: [{label, value, unit}] (at most 3), note, credit, progress (0..1 or null) }
// Values are drawn in a monospaced face in fixed cells, so the card never jitters between frames.

export const FONT_SANS = "'IBM Plex Sans', system-ui, sans-serif";
export const FONT_MONO = "'IBM Plex Mono', ui-monospace, monospace";

export async function loadFonts() {
  if (typeof document === 'undefined' || !document.fonts) return;
  const want = [`600 30px ${FONT_SANS}`, `400 14px ${FONT_SANS}`, `600 22px ${FONT_MONO}`, `500 12px ${FONT_MONO}`, `400 12px ${FONT_MONO}`];
  try {
    await Promise.race([Promise.all(want.map((f) => document.fonts.load(f))), new Promise((r) => setTimeout(r, 2500))]);
  } catch { /* the fallback faces are fine */ }
}

// Cover-fit source rectangle of a src (sw x sh) for a target aspect w/h.
export function coverRect(sw, sh, w, h) {
  const s = Math.max(w / sw, h / sh);
  const cw = w / s, ch = h / s;
  return [(sw - cw) / 2, (sh - ch) / 2, cw, ch];
}

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function wrap(g, text, maxW) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const tryL = line ? line + ' ' + w : w;
    if (g.measureText(tryL).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = tryL;
  }
  if (line) lines.push(line);
  return lines;
}

function ellipsis(g, text, maxW) {
  let s = String(text || '');
  if (g.measureText(s).width <= maxW) return s;
  while (s.length > 1 && g.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

export function drawFrame(g, src, w, h, info = {}) {
  g.save();
  g.fillStyle = '#e9ecee';
  g.fillRect(0, 0, w, h);
  if (src && src.width && src.height) {
    const [sx, sy, sw, sh] = coverRect(src.width, src.height, w, h);
    try { g.drawImage(src, sx, sy, sw, sh, 0, 0, w, h); } catch { /* a lost context draws nothing */ }
  }
  drawOverlay(g, w, h, info);
  g.restore();
}

export function drawOverlay(g, w, h, info = {}) {
  const k = Math.max(0.6, Math.min(w, h) / 720);
  const pad = Math.round(16 * k);
  const margin = Math.round(22 * k);

  // ---- credit line: a light band along the bottom, wrapped to at most two lines ----
  g.font = `400 ${Math.round(11 * k)}px ${FONT_SANS}`;
  const creditLines = wrap(g, info.credit || '', w - 2 * margin).slice(0, 2);
  const lh = Math.round(15 * k);
  const bandH = creditLines.length ? creditLines.length * lh + Math.round(10 * k) : 0;
  if (bandH) {
    g.fillStyle = 'rgba(255,255,255,0.84)';
    g.fillRect(0, h - bandH, w, bandH);
    g.fillStyle = '#28323c';
    g.textBaseline = 'alphabetic';
    creditLines.forEach((l, i) => g.fillText(l, margin, h - bandH + Math.round(5 * k) + (i + 1) * lh - Math.round(3 * k)));
  }

  // ---- the title card, bottom left above the band ----
  const nums = (info.numbers || []).slice(0, 3);
  const cellW = Math.round(150 * k);
  const cardW = Math.min(w - 2 * margin, Math.max(Math.round(360 * k), pad * 2 + nums.length * cellW));
  const nameH = Math.round(34 * k), subH = Math.round(20 * k), numH = nums.length ? Math.round(50 * k) : 0;
  const noteH = info.note ? Math.round(18 * k) : 0, barH = Number.isFinite(info.progress) ? Math.round(4 * k) : 0;
  const cardH = pad * 2 + nameH + subH + (numH ? numH + Math.round(8 * k) : 0) + noteH + (barH ? barH + Math.round(8 * k) : 0);
  const x = margin, y = h - bandH - margin - cardH;
  g.fillStyle = 'rgba(17,27,36,0.86)';
  rr(g, x, y, cardW, cardH, Math.round(4 * k));
  g.fill();

  const inner = cardW - 2 * pad;
  let cy = y + pad;
  g.textBaseline = 'top';
  g.fillStyle = '#ffffff';
  g.font = `600 ${Math.round(26 * k)}px ${FONT_SANS}`;
  g.fillText(ellipsis(g, info.name || '', inner), x + pad, cy);
  cy += nameH;
  g.fillStyle = '#b8c4ce';
  g.font = `500 ${Math.round(12 * k)}px ${FONT_MONO}`;
  const sub = [info.kind, info.date].filter(Boolean).join('  ·  ').toUpperCase();
  g.fillText(ellipsis(g, sub, inner), x + pad, cy);
  cy += subH;

  if (nums.length) {
    cy += Math.round(8 * k);
    const cw = inner / nums.length;
    nums.forEach((n, i) => {
      const cx = x + pad + i * cw;
      g.fillStyle = '#8fa2b2';
      g.font = `500 ${Math.round(10.5 * k)}px ${FONT_MONO}`;
      g.fillText(ellipsis(g, String(n.label || '').toUpperCase(), cw - 8 * k), cx, cy);
      g.fillStyle = '#ffffff';
      g.font = `600 ${Math.round(21 * k)}px ${FONT_MONO}`;
      const v = String(n.value ?? '–');
      g.fillText(v, cx, cy + Math.round(16 * k));
      const vw = g.measureText(v).width;
      g.fillStyle = '#b8c4ce';
      g.font = `400 ${Math.round(12 * k)}px ${FONT_MONO}`;
      if (n.unit) g.fillText(ellipsis(g, n.unit, Math.max(0, cw - vw - 14 * k)), cx + vw + Math.round(5 * k), cy + Math.round(24 * k));
    });
    cy += numH;
  }
  if (info.note) {
    g.fillStyle = '#8fa2b2';
    g.font = `400 ${Math.round(11 * k)}px ${FONT_SANS}`;
    g.fillText(ellipsis(g, info.note, inner), x + pad, cy);
    cy += noteH;
  }
  if (barH) {
    cy += Math.round(8 * k) - Math.round(4 * k);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(x + pad, cy, inner, barH);
    g.fillStyle = '#5aa7e0';
    g.fillRect(x + pad, cy, inner * Math.max(0, Math.min(1, info.progress)), barH);
  }
}
