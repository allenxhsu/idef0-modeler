// Small shared helpers. No dependencies anywhere in this project.

/**
 * A fresh identifier: `prefix_<milliseconds base36><64 random bits as 16 hex
 * digits>`. The random tail is fixed-width, so two ids can never spell the
 * same string from different parts, and it is wide enough that ids minted in
 * separate sessions (or parallel CLI runs) in the same millisecond do not
 * collide — an id is what the ontology toolkit joins on. The Mac's `uid()`
 * writes the same shape. Ids are opaque: nothing parses the timestamp back.
 */
export function uid(prefix = 'id') {
  const b = new Uint32Array(2);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else { b[0] = Math.random() * 0x100000000; b[1] = Math.random() * 0x100000000; }
  return `${prefix}_${Date.now().toString(36)}${b[0].toString(16).padStart(8, '0')}${b[1].toString(16).padStart(8, '0')}`;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  applyAttrs(n, attrs);
  append(n, children);
  return n;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, ...children) {
  const n = document.createElementNS(SVG_NS, tag);
  applyAttrs(n, attrs, true);
  append(n, children);
  return n;
}

function applyAttrs(n, attrs, isSvg = false) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.setAttribute('class', v);
    else if (k === 'text') n.textContent = String(v);
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (!isSvg && (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden')) n[k] = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(n, children) {
  for (const c of children.flat(4)) {
    if (c == null || c === false) continue;
    n.appendChild(typeof c === 'object' && c.nodeType ? c : document.createTextNode(String(c)));
  }
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

export function escapeXml(s) {
  return String(s ?? '').replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(text, filename, mime = 'text/plain') {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

export function slugify(s) {
  return String(s || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'model';
}

export function todayISO() { return new Date().toISOString().slice(0, 10); }

export function rafThrottle(fn) {
  let queued = false, lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...lastArgs); });
  };
}

export function deepClone(o) {
  return typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o));
}

/* ---------------------------------------------------------- text metrics */

/**
 * Helvetica AFM advance widths (em fractions — 1/1000 units — for the
 * printable ASCII range), keyed by code point, which equals the UTF-16 code
 * unit for these characters. An unlisted Latin code unit (below 0x2E80)
 * defaults to 0.556 em, the width of most Helvetica lowercase letters; a code
 * unit at or above 0x2E80 (CJK and other wide scripts, and any surrogate
 * half) defaults to a full 1.0 em, since Helvetica has no metrics for them
 * and a full-width guess keeps wrapping conservative rather than overflowing.
 */
const HELVETICA_ADVANCE = {
  32: 0.278, 33: 0.278, 34: 0.355, 35: 0.556, 36: 0.556, 37: 0.889, 38: 0.667, 39: 0.191,
  40: 0.333, 41: 0.333, 42: 0.389, 43: 0.584, 44: 0.278, 45: 0.333, 46: 0.278, 47: 0.278,
  48: 0.556, 49: 0.556, 50: 0.556, 51: 0.556, 52: 0.556, 53: 0.556, 54: 0.556, 55: 0.556,
  56: 0.556, 57: 0.556, 58: 0.278, 59: 0.278, 60: 0.584, 61: 0.584, 62: 0.584, 63: 0.556,
  64: 1.015, 65: 0.667, 66: 0.667, 67: 0.722, 68: 0.722, 69: 0.667, 70: 0.611, 71: 0.778,
  72: 0.722, 73: 0.278, 74: 0.500, 75: 0.667, 76: 0.556, 77: 0.833, 78: 0.722, 79: 0.778,
  80: 0.667, 81: 0.778, 82: 0.722, 83: 0.667, 84: 0.611, 85: 0.722, 86: 0.667, 87: 0.944,
  88: 0.667, 89: 0.667, 90: 0.611, 91: 0.278, 92: 0.278, 93: 0.278, 94: 0.469, 95: 0.556,
  96: 0.333, 97: 0.556, 98: 0.556, 99: 0.500, 100: 0.556, 101: 0.556, 102: 0.278, 103: 0.556,
  104: 0.556, 105: 0.222, 106: 0.222, 107: 0.500, 108: 0.222, 109: 0.833, 110: 0.556,
  111: 0.556, 112: 0.556, 113: 0.556, 114: 0.333, 115: 0.500, 116: 0.278, 117: 0.556,
  118: 0.500, 119: 0.722, 120: 0.500, 121: 0.500, 122: 0.500, 123: 0.334, 124: 0.260,
  125: 0.334, 126: 0.584,
};
const LATIN_DEFAULT_ADVANCE = 0.556;
const WIDE_DEFAULT_ADVANCE = 1.0;
const WIDE_THRESHOLD = 0x2e80;

function charAdvance(codeUnit) {
  const known = HELVETICA_ADVANCE[codeUnit];
  if (known !== undefined) return known;
  return codeUnit >= WIDE_THRESHOLD ? WIDE_DEFAULT_ADVANCE : LATIN_DEFAULT_ADVANCE;
}

/** Width of `text` set in Helvetica at `fontSize`, summed per UTF-16 code unit. */
export function textWidth(text, fontSize) {
  const s = String(text ?? '');
  let w = 0;
  for (let i = 0; i < s.length; i += 1) w += charAdvance(s.charCodeAt(i));
  return w * fontSize;
}

/**
 * Break `word` at the last '-', '_' or '/' whose prefix still fits
 * `maxWidth`; failing that, hard-break at the widest whole prefix that fits.
 * Always returns a non-empty `head`, so wrapping keeps making progress even
 * when no prefix fits within `maxWidth`.
 */
function breakToken(word, fontSize, maxWidth) {
  let splitAt = 0;
  for (let i = 0; i < word.length; i += 1) {
    const c = word[i];
    if (c !== '-' && c !== '_' && c !== '/') continue;
    if (textWidth(word.slice(0, i + 1), fontSize) > maxWidth) break;
    splitAt = i + 1;
  }
  if (splitAt > 0) return [word.slice(0, splitAt), word.slice(splitAt)];
  let n = 1;
  for (let k = 2; k <= word.length; k += 1) {
    if (textWidth(word.slice(0, k), fontSize) > maxWidth) break;
    n = k;
  }
  return [word.slice(0, n), word.slice(n)];
}

/** Trim `s` from the end, if it must, so `s…` fits `maxWidth` at `fontSize`. */
function ellipsize(s, fontSize, maxWidth) {
  if (textWidth(`${s}…`, fontSize) <= maxWidth) return `${s}…`;
  let out = s;
  while (out.length > 0 && textWidth(`${out}…`, fontSize) > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}

/**
 * Wrap `text` into at most `maxLines` lines that fit `width` sheet units at
 * `fontSize`, measured with the Helvetica advance table. Lines fill greedily;
 * a word wider than a line is broken (preferring '-', '_' or '/', otherwise a
 * hard character break), and if words remain once `maxLines` lines are full,
 * the LAST line — never an earlier one — is trimmed and given a trailing '…'.
 * `lastLineWidth`, when given, narrows only that final line slot: FIPS boxes
 * keep it clear of the box number sharing that row (see `boxNameLines`).
 */
export function wrapText(text, width, fontSize, maxLines = 4, lastLineWidth = width) {
  const queue = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!queue.length) return [];
  const lines = [];
  while (queue.length > 0) {
    const isLastSlot = lines.length === maxLines - 1;
    const slotWidth = isLastSlot ? lastLineWidth : width;
    let cur = '';
    while (queue.length > 0) {
      const word = queue[0];
      const cand = cur ? `${cur} ${word}` : word;
      if (textWidth(cand, fontSize) <= slotWidth) {
        cur = cand;
        queue.shift();
        continue;
      }
      if (cur) break;
      const [head, rest] = breakToken(word, fontSize, slotWidth);
      cur = head;
      if (rest) queue[0] = rest; else queue.shift();
      break;
    }
    lines.push(cur);
    if (lines.length === maxLines) break;
  }
  if (queue.length > 0 && lines.length > 0) {
    const last = lines.length - 1;
    lines[last] = ellipsize(lines[last], fontSize, lastLineWidth);
  }
  return lines;
}

/** Truncate `text` to a single line no wider than `width` at `fontSize`. */
export function fitText(text, width, fontSize) {
  const s = String(text ?? '');
  if (!s) return '';
  if (textWidth(s, fontSize) <= width) return s;
  if (width <= 0) return '';
  let out = s;
  while (out.length > 0 && textWidth(`${out}…`, fontSize) > width) out = out.slice(0, -1);
  return out.length > 0 ? `${out}…` : '…';
}

/**
 * Box-name layout shared by the renderer and the validator (FIPS 183
 * §3.2.1.3): wrap `name` for a box `w` × `h` sheet units at `fontSize`,
 * capping lines to what the box height allows and keeping the last line clear
 * of the box number drawn at its bottom-right corner.
 */
export function boxNameLines(name, w, h, number, fontSize) {
  const availWidth = w - 22;
  const maxLines = Math.max(1, Math.min(4, Math.floor((h - 18) / 16)));
  const numberWidth = textWidth(String(number), 10);
  const lastLineWidth = Math.max(0, availWidth - numberWidth - 4);
  return wrapText(name, availWidth, fontSize, maxLines, lastLineWidth);
}
