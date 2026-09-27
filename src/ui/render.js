// Draws one IDEF0 diagram — the standard sheet form, the boxes and the arrows.
// Used by both the on-screen canvas and by SVG/PNG/PDF export, so what you see
// is exactly what you get.

import { svg, wrapText, fitText, boxNameLines, clamp, escapeXml, textWidth } from '../util.js';
import { FRAME, HEADER_H, FOOTER_H, SHEET, STATUS_VALUES, WORK } from '../model/types.js';
import { routeArrow, pointsToPath, longestSegmentMid, labelPlacement, labelPosition, squigglePoints, rectOf, portShape } from '../model/geometry.js';
import { boxNode, icomCodes, sortedBoxes, effectiveConceptId, ports } from '../model/model.js';
import { conceptById } from '../model/concepts.js';

/* ------------------------------------------------------------ sheet form */

export function renderFrame(model, diagram) {
  const g = svg('g', { class: 'frame-layer' });
  const F = FRAME;
  const headBottom = F.y + HEADER_H;
  const footTop = F.y + F.h - FOOTER_H;

  g.appendChild(svg('rect', { class: 'sheet-bg', x: 0, y: 0, width: SHEET.w, height: SHEET.h }));
  g.appendChild(svg('rect', { class: 'frm', x: F.x, y: F.y, width: F.w, height: F.h }));
  g.appendChild(svg('line', { class: 'frm', x1: F.x, y1: headBottom, x2: F.x + F.w, y2: headBottom }));
  g.appendChild(svg('line', { class: 'frm', x1: F.x, y1: footTop, x2: F.x + F.w, y2: footTop }));

  // Header columns.
  const cuts = [204, 564, 724, 844];
  for (const x of cuts) g.appendChild(svg('line', { class: 'frm-thin', x1: x, y1: F.y, x2: x, y2: headBottom }));

  const lbl = (x, y, t) => g.appendChild(svg('text', { class: 'frm-lbl', x, y, text: t }));
  // FIPS 183 C.4.1.1/C.4.5.1: each header/footer field has a fixed cell width
  // on the printed form, so a value too long to fit is shrunk to an ellipsis
  // rather than overprinting its neighbour.
  const val = (x, y, t, w, fontSize, big = false) =>
    g.appendChild(svg('text', { class: `frm-val${big ? ' big' : ''}`, x, y, text: fitText(t || '', w, fontSize) }));

  lbl(F.x + 6, F.y + 13, 'USED AT:');
  lbl(210, F.y + 13, 'AUTHOR:');
  val(252, F.y + 14, model.author, 174, 10.5);
  lbl(430, F.y + 13, 'DATE:');
  val(458, F.y + 14, model.revised, 102, 10.5);
  lbl(210, F.y + 30, 'PROJECT:');
  val(256, F.y + 31, model.project, 170, 10.5);
  lbl(430, F.y + 30, 'REV:');
  // The C-number belongs in NUMBER (C.4.5.1), not here; REV stays blank
  // rather than inventing a stored revision field.
  lbl(210, F.y + 50, 'NOTES:');
  for (let i = 1; i <= 10; i += 1) {
    g.appendChild(svg('text', { class: 'frm-lbl', x: 246 + (i - 1) * 15, y: F.y + 50, text: String(i) }));
    g.appendChild(svg('rect', { class: 'frm-thin', x: 243 + (i - 1) * 15, y: F.y + 54, width: 11, height: 11 }));
  }

  STATUS_VALUES.forEach((s, i) => {
    const y = F.y + 16 + i * 19;
    const on = (model.status || 'WORKING') === s;
    // A class, not a fill attribute: `.frm-thin { fill: none }` in both
    // stylesheets would override the attribute and never show the status.
    // The stylesheets colour `.frm-mark` — themed on screen, fixed in export.
    g.appendChild(svg('rect', {
      class: `frm-thin frm-mark${on ? ' on' : ''}`, x: 572, y: y - 8, width: 10, height: 10,
    }));
    g.appendChild(svg('text', { class: 'frm-lbl', x: 588, y, text: s }));
  });

  lbl(730, F.y + 13, 'READER');
  lbl(800, F.y + 13, 'DATE');
  g.appendChild(svg('line', { class: 'frm-thin', x1: 794, y1: F.y, x2: 794, y2: headBottom }));
  lbl(850, F.y + 13, 'CONTEXT:');
  renderContextThumb(g, model, diagram, { x: 850, y: F.y + 20, w: 220, h: HEADER_H - 26 });

  // Footer columns.
  g.appendChild(svg('line', { class: 'frm-thin', x1: 174, y1: footTop, x2: 174, y2: F.y + F.h }));
  g.appendChild(svg('line', { class: 'frm-thin', x1: 876, y1: footTop, x2: 876, y2: F.y + F.h }));
  lbl(F.x + 6, footTop + 12, 'NODE:');
  val(F.x + 6, footTop + 34, diagram.node, 140, 13, true);
  lbl(180, footTop + 12, 'TITLE:');
  val(180, footTop + 34, diagram.title || model.title, 690, 13, true);
  lbl(882, footTop + 12, 'NUMBER:');
  // FIPS 183 C.4.5.1: the large area of the Number field carries the
  // C-number, not a repeat of NODE/TITLE.
  val(882, footTop + 34, diagram.cNumber, 188, 10.5);

  // FIPS 183 §3.3.1.1: the A-0 context diagram presents brief statements of
  // the model's viewpoint and purpose. Drawn in the sheet layer, before
  // arrows and boxes, so a box or arrow the modeller places low on the
  // canvas paints over the statement rather than the other way round.
  if (diagram.id === model.rootDiagramId) {
    const statementLines = [];
    if ((model.purpose || '').trim()) statementLines.push(...wrapText(`PURPOSE: ${model.purpose}`, WORK.w - 16, 10.5, 2));
    if ((model.viewpoint || '').trim()) statementLines.push(...wrapText(`VIEWPOINT: ${model.viewpoint}`, WORK.w - 16, 10.5, 2));
    const n = statementLines.length;
    statementLines.forEach((text, i) => {
      g.appendChild(svg('text', {
        class: 'frm-note', x: WORK.x + 8, y: WORK.y2 - 4 - (n - 1 - i) * 13, text,
      }));
    });
  }

  return g;
}

/**
 * The "where am I" sketch in the CONTEXT cell of the header (FIPS 183
 * C.4.1.5). On the A-0 sheet the field just reads "TOP", centred. On any
 * other sheet the node label stays at the cell's lower-left and a small,
 * to-scale sketch of the parent diagram's box layout sits to its right, the
 * parent box highlighted and its siblings outlined.
 */
function renderContextThumb(g, model, diagram, cell) {
  if (diagram.id === model.rootDiagramId) {
    g.appendChild(svg('text', {
      class: 'frm-lbl', x: cell.x + cell.w / 2, y: cell.y + cell.h / 2 + 4, 'text-anchor': 'middle', text: 'TOP',
    }));
    return;
  }
  const parentBox = findParent(model, diagram);
  if (!parentBox) return;
  const { diagram: pdg, box: pbx } = parentBox;
  g.appendChild(svg('text', { class: 'frm-lbl', x: cell.x, y: cell.y + cell.h - 2, text: pdg.node }));

  // A strip on the left is reserved for the node label above; the sketch maps
  // WORK, at the parent's own scale, into the remaining area.
  const sx = cell.x + 40, sy = cell.y + 2, sw = cell.w - 44, sh = cell.h - 6;
  const s = Math.min(sw / WORK.w, sh / WORK.h);
  for (const b of sortedBoxes(pdg)) {
    const x = clamp(sx + (b.x - WORK.x) * s, sx, sx + sw - 2);
    const y = clamp(sy + (b.y - WORK.y) * s, sy, sy + sh - 2);
    const w = Math.max(2, b.w * s);
    const h = Math.max(2, b.h * s);
    const cur = b.id === pbx.id;
    g.appendChild(svg('rect', { class: `frm-thumb${cur ? ' cur' : ''}`, x, y, width: w, height: h }));
  }
}

function findParent(model, diagram) {
  if (!diagram.parentBoxId) return null;
  for (const d of Object.values(model.diagrams)) {
    const b = d.boxes.find((x) => x.id === diagram.parentBoxId);
    if (b) return { diagram: d, box: b };
  }
  return null;
}

/* ----------------------------------------------------------------- boxes */

export function renderBox(diagram, box, opts = {}) {
  const selected = opts.selection && opts.selection.kind === 'box' && opts.selection.id === box.id;
  const g = svg('g', { class: 'box', 'data-box': box.id });
  // FIPS 183 §3.2.1.3: "Boxes shall be drawn with solid lines" — an unnamed
  // box too; the placeholder text alone says it is unnamed.
  g.appendChild(svg('rect', {
    class: `box-shape${selected ? ' sel' : ''}`,
    x: box.x, y: box.y, width: box.w, height: box.h,
  }));

  const named = Boolean(box.name.trim());
  const name = box.name || '(unnamed)';
  // FIPS 183 §3.2.1.3: try the box name at its usual size, then shrink it a
  // step at a time until it fits without truncation (or floors out at 10).
  let fontSize = 13;
  let lines = [];
  for (const fs of [13, 12, 11, 10]) {
    lines = boxNameLines(name, box.w, box.h, box.number, fs);
    fontSize = fs;
    const truncated = lines.length > 0 && lines[lines.length - 1].endsWith('…');
    if (!truncated) break;
  }
  const lh = 16;
  // The block centres in the box height minus a bottom band reserved for the
  // box number, so a full set of lines never runs under it.
  const y0 = box.y + (box.h - 12) / 2 - ((lines.length - 1) * lh) / 2;
  lines.forEach((ln, i) => {
    const styleParts = [];
    // Inline, not attributes: the stylesheets' `text { fill }` rule would
    // override a fill attribute and paint the placeholder in ink, and a class
    // rule would beat a font-size attribute the same way.
    if (!named) styleParts.push('fill:#8a929c;font-style:italic');
    if (fontSize !== 13) styleParts.push(`font-size:${fontSize}px`);
    g.appendChild(svg('text', {
      class: 'box-name', x: box.x + box.w / 2, y: y0 + i * lh,
      style: styleParts.length ? styleParts.join(';') : null,
      text: ln,
    }));
  });

  g.appendChild(svg('text', { class: 'box-num', x: box.x + box.w - 7, y: box.y + box.h - 7, text: String(box.number) }));

  const node = boxNode(diagram, box);
  if (box.childDiagramId) {
    g.appendChild(svg('text', {
      class: 'box-node', x: box.x + box.w + 4, y: box.y + box.h + 11, text: node,
    }));
  }
  return g;
}

/* ---------------------------------------------------------------- arrows */

/**
 * `{ strokes, annotations }`: the arrow's path, arrowhead and tunnel marks,
 * kept apart from its label and ICOM codes. FIPS 183 §3.2.2.3 rule 3 requires
 * every arrow to carry a visible label, but a box drawn on top of the old
 * single arrow group could paint over it (F60); `renderDiagram` draws every
 * arrow's strokes, then every box, then every arrow's annotations, so a label
 * that lands over a box stays on top of its fill.
 */
export function renderArrow(entry, opts = {}) {
  const { arrow, pts, label, labelPath } = entry;
  const selected = opts.selection && opts.selection.kind === 'arrow' && opts.selection.id === arrow.id;
  const strokes = svg('g', { class: 'arrow', 'data-arrow': arrow.id });
  const annotations = svg('g', { class: 'arrow-annotations', 'data-arrow': arrow.id });

  strokes.appendChild(svg('path', { class: `arr${selected ? ' sel' : ''}`, d: pointsToPath(pts) }));
  if (!opts.forExport) strokes.appendChild(svg('path', { class: 'arr-hit', d: pointsToPath(pts) }));

  // Arrowhead at the destination, pointing the way the line travels. A join
  // (S02) has one: its representative's — every branch ends on the same
  // trailing segment, so a second head would only overprint the first.
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2] || last;
  const len = Math.hypot(last.x - prev.x, last.y - prev.y) || 1;
  const dx = (last.x - prev.x) / len, dy = (last.y - prev.y) / len;
  const forkBranch = isForkBranch(entry), joinBranch = isJoinBranch(entry);
  if (!joinBranch) {
    strokes.appendChild(svg('path', {
      class: `arr-head${selected ? ' sel' : ''}`,
      d: head(last, dx, dy),
    }));
  }

  // Tunnel marks likewise belong to the trunk: a branch's grouped end is
  // the representative's end, and the representative marks it — so the
  // trunk is marked exactly when the representative's own end is tunnelled,
  // whatever the branches record (`parentBoxArrows` treats the group as
  // tunnelled only when every member is).
  if (arrow.tunnelFrom && !forkBranch) strokes.appendChild(tunnelMark(pts[0], dirAt(pts, 0)));
  if (arrow.tunnelTo && !joinBranch) {
    // Step back from the tip: the parentheses belong on the arrow, clear of
    // the arrowhead — not past the end of it, inside the box it points at.
    const base = { x: last.x - dx * HEAD_L, y: last.y - dy * HEAD_L };
    strokes.appendChild(tunnelMark(base, { dx: -dx, dy: -dy }));
  }

  // Label (F59): an unoffset label auto-places clear of boxes, ICOM codes and
  // the frame; one the modeller has dragged keeps rendering at
  // `legacyLabelBase` + ldx/ldy exactly as before (`labelPosition` makes that
  // choice). A label whose displayed position lands far enough from its own
  // route gets a short squiggle back to it (F66), per FIPS 183 §3.2.2.3 rule 4.
  // `labelPath` (S02) is the part of the route the label belongs to — the
  // trunk for a fork or join's representative, the branch alone for a member
  // with a label of its own — or null for a branch whose label the trunk
  // already shows.
  if (label && labelPath) {
    // Placed for the text actually drawn (a bundle's term may be wider or
    // narrower than the arrow's own label); ldx/ldy still come from the arrow.
    const pos = labelPosition(labelPath, { ...arrow, label }, { icomEnds: opts.icomEnds, boxes: opts.boxes });
    annotations.appendChild(svg('text', {
      class: `arr-lbl${selected ? ' sel' : ''}`,
      x: pos.x,
      y: pos.y,
      'text-anchor': pos.anchor,
      text: label,
    }));
    const width = textWidth(label, 10.5);
    const squiggle = squigglePoints(labelPath, pos, width);
    if (squiggle) {
      annotations.appendChild(svg('path', { class: `squiggle${selected ? ' sel' : ''}`, d: pointsToPath(squiggle, 0) }));
    }
  }

  // ICOM code beside each boundary end (child diagrams only) — the codes
  // `drawnCodes` leaves to this arrow, so a boundary fork or join (S02) writes
  // its shared code once, at the trunk.
  if (opts.icom) {
    const codes = drawnCodes(entry, opts.icom);
    for (const which of ['from', 'to']) {
      const code = codes[which];
      if (!code) continue;
      const p = which === 'from' ? pts[0] : last;
      const place = icomAnchor(arrow[which].side, p, code);
      annotations.appendChild(svg('text', { class: 'icom', x: place.x, y: place.y, 'text-anchor': place.anchor, text: code }));
    }
  }
  return { strokes, annotations };
}

/** Whether `entry` (S02) is a fork member other than its representative —
 *  its `from` end is the trunk's, drawn once by the representative. */
const isForkBranch = (entry) => entry.fork != null && entry.fork !== entry.arrow.id;
/** The same at the `to` end: a join member other than its representative. */
const isJoinBranch = (entry) => entry.join != null && entry.join !== entry.arrow.id;

/**
 * `drawnCodes(entry, codes)` — the ICOM codes `entry` draws at its two ends:
 * its own boundary ends' codes (`icomCodes`), except that a branch of a
 * boundary fork or join (S02) leaves the grouped end's code to the
 * representative, which already draws the same code at the same point. A
 * branch keeps its code only where the representative has none to draw.
 * Shared by `renderArrow` and `icomRects`, so a label is scored against
 * exactly the codes that are inked.
 */
export function drawnCodes(entry, codes) {
  const { arrow } = entry;
  const own = (which) => (arrow[which].type === 'boundary' ? codes[`${arrow.id}:${which}`] ?? null : null);
  const out = { from: own('from'), to: own('to') };
  if (isForkBranch(entry) && codes[`${entry.fork}:from`]) out.from = null;
  if (isJoinBranch(entry) && codes[`${entry.join}:to`]) out.to = null;
  return out;
}

// Menlo/Consolas mono, matching the ICOM code's export CSS and stylesheet
// font-size — a flat per-character width, unlike the label's Helvetica
// advance table, because every glyph of a monospace face is the same width.
const ICOM_FONT_SIZE = 9;
const ICOM_MONO_ADVANCE = 0.602;
const ICOM_HALF_H = 6;
const monoWidth = (text) => String(text).length * ICOM_MONO_ADVANCE * ICOM_FONT_SIZE;

function icomPlace(side, p) {
  if (side === 'left') return { x: p.x - 4, y: p.y - 5, anchor: 'end' };
  if (side === 'right') return { x: p.x + 4, y: p.y - 5, anchor: 'start' };
  if (side === 'top') return { x: p.x + 4, y: p.y - 4, anchor: 'start' };
  return { x: p.x + 4, y: p.y + 11, anchor: 'start' };
}

/**
 * `icomAnchor(side, p, code)` — `icomPlace`'s SVG placement, its x clamped
 * back onto the sheet when `code`'s measured width would otherwise run past
 * the frame's left or right edge (F59) — the 'I10' case FIPS 183 B.2.4.2
 * leaves unaddressed. Only 'left' and 'right'-side codes sit close enough to
 * an edge to need it: a 'top'/'bottom' boundary anchor's own 0.02..0.98 clamp
 * never lets its code reach the frame's far edge.
 */
function icomAnchor(side, p, code) {
  const place = icomPlace(side, p);
  const w = monoWidth(code);
  if (place.anchor === 'end') return { ...place, x: Math.max(place.x, FRAME.x + 4 + w) };
  return { ...place, x: Math.min(place.x, FRAME.x + FRAME.w - 4 - w) };
}

function icomRect(side, p, code) {
  const place = icomAnchor(side, p, code);
  const w = monoWidth(code);
  const x0 = place.anchor === 'end' ? place.x - w : place.x;
  return { x: x0, y: place.y - ICOM_HALF_H, w, h: ICOM_HALF_H * 2 };
}

/**
 * Every ICOM code's rectangle for one diagram (F59): computed once so a
 * label placement decision — and its hit test — can penalise landing on top
 * of a code exactly where `renderArrow` will draw it.
 */
export function icomRects(model, diagram, drawn = drawnArrows(model, diagram)) {
  const codes = icomCodes(model, diagram);
  const rects = [];
  for (const entry of drawn) {
    const { arrow, pts } = entry;
    const own = drawnCodes(entry, codes);
    for (const which of ['from', 'to']) {
      const code = own[which];
      if (!code) continue;
      const p = which === 'from' ? pts[0] : pts[pts.length - 1];
      rects.push(icomRect(arrow[which].side, p, code));
    }
  }
  return rects;
}

const HEAD_L = 11;

function head(p, dx, dy) {
  const L = HEAD_L, W = 4.6;
  const bx = p.x - dx * L, by = p.y - dy * L;
  const px = -dy, py = dx;
  return `M${r(p.x)} ${r(p.y)} L${r(bx + px * W)} ${r(by + py * W)} L${r(bx - px * W)} ${r(by - py * W)} Z`;
}

function dirAt(pts, i) {
  const a = pts[i], b = pts[i + 1] || pts[i];
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { dx: (b.x - a.x) / L, dy: (b.y - a.y) / L };
}

/** The parentheses that mark a tunnelled arrow end. */
function tunnelMark(p, d) {
  const g = svg('g', { class: 'tunnel-mark' });
  const px = -d.dy, py = d.dx;                       // perpendicular
  const arc = (offset, bulge) => {
    const cx = p.x + d.dx * offset, cy = p.y + d.dy * offset;
    const x1 = cx + px * 7, y1 = cy + py * 7;
    const x2 = cx - px * 7, y2 = cy - py * 7;
    const qx = cx + d.dx * bulge, qy = cy + d.dy * bulge;
    return svg('path', { class: 'tunnel', d: `M${r(x1)} ${r(y1)} Q${r(qx)} ${r(qy)} ${r(x2)} ${r(y2)}` });
  };
  g.appendChild(arc(5, -5));
  g.appendChild(arc(13, 5));
  return g;
}

const r = (v) => Math.round(v * 10) / 10;

/* ------------------------------------------------ bundles, forks and joins */

/**
 * `drawnArrows(m, dg)` — which of a diagram's arrows are drawn, and how, in
 * array order: one entry per drawn arrow,
 *
 *   `{ arrow, label, hidden, drawn, pts, fork, join, forkTrunk, joinTrunk, labelPath }`
 *
 * `arrow` the model's arrow, `label` the text its label shows, `hidden` the
 * ids of the arrows it stands for, `drawn` the arrow as it is routed (S02:
 * its grouped ends moved onto the group's representative), `pts` that route,
 * `fork`/`join` the id of the representative of the fork (`from` face) or
 * join (`to` face) group it belongs to — its own id when it is the
 * representative — or null, `forkTrunk`/`joinTrunk` the leading/trailing run
 * every member of that group shares, and `labelPath` the part of the route
 * its label is placed against, or null when it draws no label.
 *
 * FIPS 183 §3.2.2.3 bundling (S01): arrows whose concepts are members of one
 * bundle (`effectiveConceptId` differs from the arrow's own `conceptId`) and
 * that run between the same faces — the same endpoint types, boxes and sides,
 * at any position — are one general arrow. The first of them in array order
 * is its representative: it draws normally except that its label reads the
 * bundle's term — the general label, where the specifics are actually merged
 * into one line; the rest draw nothing at all (their ICOM code is already the
 * representative's, since `parentBoxArrows` shares one position by effective
 * concept). A member alone on its faces hides nothing and keeps its own
 * specific label (§3.2.2.3: the general label on the bundle, the specific
 * ones on its branches), as does an arrow whose concept is in no bundle.
 *
 * FIPS 183 §3.3.2.2, Figure 6 (S02): drawn arrows that leave the same face —
 * the same endpoint type, box (for a box end) and side — and denote the same
 * effective concept are one arrow forked at that face; the same at the `to`
 * face is a join. `icomCodes` already gives such a group one code (§3.3.3
 * rule 14, `parentBoxArrows`); here it is drawn as one: every member is
 * routed as if its grouped end sat at the representative's stored `pos`, so
 * the members' routes coincide over a leading (fork) or trailing (join) run
 * — the trunk — and part where their targets differ. Nothing in the file
 * changes: each member keeps its own `pos`. The representative is the arrow
 * the group's ICOM code is numbered by — the earliest on that face (lowest
 * stored `pos`, then array order), exactly `parentBoxArrows`'s order. A
 * hidden bundle member is not drawn and is not a branch; the members' own
 * hidden ends never enter the routing, so a representative is routed as the
 * one line it is (no lane is spread for a member that draws nothing). The
 * fork group draws one label, the representative's, on the trunk — or on the
 * representative's whole route when the trunk is too short to carry the text
 * (`trunkLabelPath`); a branch whose own label reads the same draws none, and
 * one whose label differs (a bundle member keeping its specific label) draws
 * it against its branch alone (`branchLabelPath`). Joins mirror this. One
 * shared rule, so the canvases hit-test
 * exactly what was drawn; Drawing.swift's `SheetDrawing.drawnArrows` is the
 * same function, in the same order.
 */
export function drawnArrows(m, dg) {
  const out = [];
  const groups = new Map();
  for (const a of dg.arrows) {
    const eff = a.conceptId ? effectiveConceptId(m, a.conceptId) : null;
    if (!eff || eff === a.conceptId) { out.push(newEntry(a, a.label)); continue; }
    // A box endpoint's box is part of the face; a boundary endpoint has none
    // (whatever stray `boxId` a hand-edited file left on it).
    const key = JSON.stringify([eff, faceKey(a.from), faceKey(a.to)]);
    const group = groups.get(key);
    if (group) {
      // A second member on the same faces: the representative now stands
      // for a merged line, and reads the bundle's general term.
      group.hidden.push(a.id);
      const bundle = conceptById(m, eff);
      if (bundle) group.label = bundle.term;
      continue;
    }
    const entry = newEntry(a, a.label);
    groups.set(key, entry);
    out.push(entry);
  }

  // Forks and joins (S02): the drawn arrows grouped by face and effective
  // concept, each group's representative the earliest on that face.
  const forks = endGroups(m, out, 'from');
  const joins = endGroups(m, out, 'to');
  for (const e of out) {
    const f = forks.get(e), j = joins.get(e);
    if (f && f.members.length > 1) { e.fork = f.rep.arrow.id; e.drawn.from = { ...f.rep.arrow.from }; }
    if (j && j.members.length > 1) { e.join = j.rep.arrow.id; e.drawn.to = { ...j.rep.arrow.to }; }
  }

  // Routed as the diagram they draw: only drawn arrows, at their drawn ends.
  const drawnDg = { ...dg, arrows: out.map((e) => e.drawn) };
  for (const e of out) e.pts = routeArrow(drawnDg, e.drawn);

  // The trunk of a group is the run every member's route shares: a common
  // prefix (fork) or suffix (join) of the representative's route.
  const byId = new Map(out.map((e) => [e.arrow.id, e]));
  for (const g of new Set(forks.values())) {
    if (g.members.length < 2) continue;
    let trunk = g.rep.pts;
    for (const e of g.members) trunk = commonPrefix(trunk, e.pts);
    for (const e of g.members) e.forkTrunk = trunk;
  }
  for (const g of new Set(joins.values())) {
    if (g.members.length < 2) continue;
    let trunk = [...g.rep.pts].reverse();
    for (const e of g.members) trunk = commonPrefix(trunk, [...e.pts].reverse());
    trunk.reverse();
    for (const e of g.members) e.joinTrunk = trunk;
  }
  for (const e of out) {
    const forkRep = e.fork != null ? byId.get(e.fork) : null;
    const joinRep = e.join != null ? byId.get(e.join) : null;
    if (forkRep === e) e.labelPath = trunkLabelPath(e.forkTrunk, e.pts, e.label);
    else if (joinRep === e) e.labelPath = trunkLabelPath(e.joinTrunk, e.pts, e.label);
    else {
      const shown = (forkRep != null && forkRep.label === e.label) || (joinRep != null && joinRep.label === e.label);
      e.labelPath = shown ? null : branchLabelPath(branchPart(e.pts, e.forkTrunk, e.joinTrunk), e.pts);
    }
  }
  return out;
}

// The label's Helvetica size and line height, as `renderArrow` measures it
// and `labelRect` boxes it (geometry.js's LABEL_FONT_SIZE, 2 × LABEL_HALF_H).
const LABEL_FONT_SIZE = 10.5;
const LABEL_H = 16;

/**
 * `trunkLabelPath(trunk, pts, label)` — what a representative's label is
 * placed against: the trunk, when its longest segment — the one
 * `labelPlacement` tries first — is long enough to carry the text, or else
 * the representative's whole route `pts`. A horizontal segment carries the
 * label above or below its midpoint, so it must be at least `textWidth(label)`
 * long for the text to sit against the trunk rather than hang off its ends; a
 * vertical one carries the label beside its midpoint, so a line's height is
 * enough. The common boundary fork — an input shared by boxes 1 and 2, box 1
 * by the left edge — has a trunk of only the stub before the branches turn,
 * and a label placed against that stub runs into the frame (FIPS 183 §3.2.2.3
 * rule 2e) where the whole route offers `labelPlacement` a clear segment.
 * Still one label per group: the branches draw none either way.
 */
export function trunkLabelPath(trunk, pts, label) {
  if (trunk.length < 2) return pts;
  const seg = longestSegmentMid(trunk);
  const need = seg.horizontal ? textWidth(label, LABEL_FONT_SIZE) : LABEL_H;
  return seg.length >= need ? trunk : pts;
}

/**
 * `branchLabelPath(part, pts)` — what a branch's own label is placed against:
 * its `branchPart`, or its whole route `pts` when the trunks it lies between
 * overlap and leave the branch a single point — a label path always has a
 * segment to sit against (`legacyLabelBase` reads one once the label has
 * been dragged).
 */
export const branchLabelPath = (part, pts) => (part.length >= 2 ? part : pts);

const newEntry = (a, label) => ({
  arrow: a, label, hidden: [], drawn: { ...a }, pts: [], fork: null, join: null,
  forkTrunk: null, joinTrunk: null, labelPath: null,
});

/** An endpoint's face: its type, its box (a box end only) and its side. */
const faceKey = (e) => [e.type, e.type === 'box' ? e.boxId ?? null : null, e.side];

/**
 * The fork (`which` = 'from') or join ('to') groups among the drawn entries
 * (S02): entry → `{ rep, members }`, members in array order and `rep` the
 * earliest on the face — the lowest stored `pos`, then array order, which is
 * the member `parentBoxArrows` numbers the group's ICOM code by. An arrow
 * bound to no concept is in no group. Only drawn entries take part: a hidden
 * bundle member with a lower `pos` than every drawn member still orders
 * `parentBoxArrows`' ICOM numbering on that side, but draws nothing and so
 * never places the trunk.
 */
function endGroups(m, entries, which) {
  const groups = new Map();
  const byEntry = new Map();
  for (const e of entries) {
    const a = e.arrow;
    const eff = a.conceptId ? effectiveConceptId(m, a.conceptId) : null;
    if (!eff) continue;
    const key = JSON.stringify([eff, faceKey(a[which])]);
    let g = groups.get(key);
    if (!g) { g = { rep: e, members: [] }; groups.set(key, g); }
    g.members.push(e);
    if (a[which].pos < g.rep.arrow[which].pos) g.rep = e;
    byEntry.set(e, g);
  }
  return byEntry;
}

const NEAR = 1e-6;
const nearPoint = (p, q) => Math.abs(p.x - q.x) < NEAR && Math.abs(p.y - q.y) < NEAR;

/**
 * `commonPrefix(a, b)` — the run two polylines share from their common first
 * point: they walk together while their next segments head the same way,
 * ending at the first vertex where one turns, or where the shorter of two
 * collinear segments ends (the longer one carries on past it). Routes are
 * simplified (geometry.js `simplify`), so a vertex on a straight run is a
 * turn or a reversal, and the shared run is exactly the trunk.
 */
export function commonPrefix(a, b) {
  if (!a.length || !b.length || !nearPoint(a[0], b[0])) return a.length ? [a[0]] : [];
  const out = [a[0]];
  let i = 1, j = 1;
  while (i < a.length && j < b.length) {
    const cur = out[out.length - 1];
    const ax = a[i].x - cur.x, ay = a[i].y - cur.y;
    const bx = b[j].x - cur.x, by = b[j].y - cur.y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < NEAR || lb < NEAR) break;
    if (ax * bx + ay * by <= 0 || Math.abs(ax * by - ay * bx) > NEAR) break;
    if (Math.abs(la - lb) < NEAR) { out.push(a[i]); i += 1; j += 1; } else if (la < lb) { out.push(a[i]); break; } else { out.push(b[j]); break; }
  }
  return out;
}

/**
 * `branchPart(pts, forkTrunk, joinTrunk)` — the part of a branch's route that
 * is its own: after the fork trunk it leaves and before the join trunk it
 * enters (either may be null). Every trunk vertex but its last is a vertex of
 * the route (`commonPrefix` only carries a vertex both share); the last lies
 * on the next segment, so the branch starts at that point and continues with
 * the route's vertices from there, mirrored at a join. Trunks that overlap
 * leave a single point (`branchLabelPath` then labels the whole route).
 */
export function branchPart(pts, forkTrunk, joinTrunk) {
  const P = pts.length;
  let start = pts[0], kf = 0;
  if (forkTrunk && forkTrunk.length >= 2) { start = forkTrunk[forkTrunk.length - 1]; kf = forkTrunk.length - 1; }
  let end = pts[P - 1], kj = P - 1;
  if (joinTrunk && joinTrunk.length >= 2) { end = joinTrunk[0]; kj = P - joinTrunk.length; }
  const out = [start];
  const push = (p) => { if (!nearPoint(out[out.length - 1], p)) out.push(p); };
  if (kf > kj + 1) return out;
  if (kf === kj + 1) {
    // Both on one segment: the branch is the stretch between them, if any.
    const seg = pts[kf], prev = pts[kj];
    if ((end.x - start.x) * (seg.x - prev.x) + (end.y - start.y) * (seg.y - prev.y) > 0) push(end);
    return out;
  }
  for (let k = kf; k <= kj; k += 1) push(pts[k]);
  push(end);
  return out;
}

/* ----------------------------------------------------------------- ports */

/** Radius of the open circle at a port's inner end. */
const PORT_R = 4;

/**
 * The two-point path a port's label is placed against: the circle's vertical
 * diameter. `labelPlacement` then offers the spots 12 units right of the
 * circle's centre (start-anchored) and 12 units left of it (end-anchored) —
 * beside the inner end, 8 clear of the rim — and scores them against the
 * boxes, the ICOM codes (the port's own included) and the frame, so a
 * right-edge port's label, which would run off the sheet, lands to the left of
 * its circle instead. The same path, in the same order, as Drawing.swift.
 */
const portLabelPath = (shape) => [
  { x: shape.inner.x, y: shape.inner.y - PORT_R },
  { x: shape.inner.x, y: shape.inner.y + PORT_R },
];

/** The rectangle a port's ICOM code occupies, where `renderPort` draws it. */
const portCodeRect = (port) => icomRect(port.side, portShape(port).edge, port.code);

/**
 * `renderPort(port, { icomEnds, boxes })` — a parent-box ICOM concept not yet
 * connected on this diagram (model.js `ports`), drawn at the sheet edge: a
 * dashed stub from `edge` to `inner` (`portShape`), an open circle at `inner`,
 * the ICOM code at the edge end placed exactly as a boundary arrow's code
 * would be (`icomAnchor`), and the label in a muted italic beside the inner
 * end. One `<g class="port" data-port="<parentArrowId>">` per port; the texts
 * take no pointer events (styles.css), so a press lands on the stub or the
 * circle. A port is not an arrow: it is no routing obstacle and never reaches
 * the ICOM/IDL/report exports.
 */
function renderPort(port, opts = {}) {
  const shape = portShape(port);
  const g = svg('g', { class: 'port', 'data-port': port.parentArrowId });
  g.appendChild(svg('path', { class: 'port-stub', d: pointsToPath([shape.edge, shape.inner]) }));
  g.appendChild(svg('circle', { class: 'port-dot', cx: shape.inner.x, cy: shape.inner.y, r: PORT_R }));
  const place = icomAnchor(port.side, shape.edge, port.code);
  g.appendChild(svg('text', { class: 'icom', x: place.x, y: place.y, 'text-anchor': place.anchor, text: port.code }));
  if (port.label) {
    const pos = labelPlacement(portLabelPath(shape), port.label, { icomEnds: opts.icomEnds, boxes: opts.boxes });
    g.appendChild(svg('text', { class: 'port-lbl', x: pos.x, y: pos.y, 'text-anchor': pos.anchor, text: port.label }));
  }
  return g;
}

/* ------------------------------------------------------------ whole sheet */

export function renderDiagram(model, diagram, opts = {}) {
  const g = svg('g', { class: 'sheet' });
  g.appendChild(renderFrame(model, diagram));
  const icom = icomCodes(model, diagram);
  const drawn = drawnArrows(model, diagram);
  // Computed once for the whole diagram (F59): every arrow's `labelPlacement`
  // call scores against the same box and ICOM-code rectangles renderArrow is
  // about to draw, rather than each recomputing its own partial view of them.
  const icomEnds = icomRects(model, diagram, drawn);
  const boxes = diagram.boxes.map(rectOf);
  // Three passes (F60): every arrow's strokes, then every box, then every
  // arrow's label and ICOM codes — so a label that overlaps a box paints on
  // top of its fill instead of being erased by it. Only the arrows
  // `drawnArrows` lists are drawn: a bundle's representative stands for its
  // hidden members (S01), and a fork or join draws as one trunk with
  // branches (S02).
  const strokeLayer = svg('g', { class: 'content-layer' });
  const boxLayer = svg('g', { class: 'box-layer' });
  const labelLayer = svg('g', { class: 'label-layer' });
  for (const entry of drawn) {
    const { strokes, annotations } = renderArrow(entry, { ...opts, icom, icomEnds, boxes });
    strokeLayer.appendChild(strokes);
    labelLayer.appendChild(annotations);
  }
  for (const b of diagram.boxes) boxLayer.appendChild(renderBox(diagram, b, opts));
  // Ports (S01) go in the annotations pass too, after every arrow's: a parent
  // concept still unconnected here sits at the sheet edge, on top of whatever
  // a box or an arrow put there. Their labels keep clear of every ICOM code
  // an arrow draws and of every port's own.
  const portList = ports(model, diagram);
  const portEnds = icomEnds.concat(portList.map(portCodeRect));
  for (const p of portList) labelLayer.appendChild(renderPort(p, { icomEnds: portEnds, boxes }));
  g.appendChild(strokeLayer);
  g.appendChild(boxLayer);
  g.appendChild(labelLayer);
  return g;
}

/** Stand-alone SVG document text for one diagram (export). */
export function diagramToSvgString(model, diagram) {
  const root = svg('svg', {
    xmlns: 'http://www.w3.org/2000/svg', width: SHEET.w, height: SHEET.h,
    viewBox: `0 0 ${SHEET.w} ${SHEET.h}`,
  });
  root.appendChild(svg('style', { text: EXPORT_CSS }));
  root.appendChild(renderDiagram(model, diagram, { forExport: true }));
  const head = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- IDEF0 diagram ${commentText(diagram.node)}: ${commentText(diagram.title)} -->\n`;
  return head + new XMLSerializer().serializeToString(root);
}

/**
 * Text for the header comment. XML forbids "--" inside a comment, so a space
 * goes between every pair of adjacent hyphens ("--" → "- -", "---" → "- - -");
 * the Mac's SVGWriter applies the same rule, so both headers read alike.
 */
function commentText(s) {
  return escapeXml(s).replace(/-(?=-)/g, '- ');
}

export const EXPORT_CSS = `
svg{background:#fff}
text{font-family:Helvetica,Arial,sans-serif;fill:#111418}
.sheet-bg{fill:#fff}
.frm{fill:none;stroke:#111418;stroke-width:1.4}
.frm-thin{fill:none;stroke:#111418;stroke-width:.8}
.frm-mark{fill:#fff}
.frm-mark.on{fill:#111418}
.frm-thumb{fill:#fff;stroke:#111418;stroke-width:.8}
.frm-thumb.cur{fill:#111418}
.frm-lbl{font-size:8px;fill:#444c56;letter-spacing:.04em}
.frm-val{font-size:10.5px}
.frm-val.big{font-size:13px;font-weight:600}
.frm-note{font-size:10.5px;pointer-events:none}
.box-shape{fill:#fff;stroke:#111418;stroke-width:1.6}
.box-name{font-size:13px;text-anchor:middle;dominant-baseline:middle}
.box-num{font-size:10px;text-anchor:end}
.box-node{font-size:9px;fill:#5b6470}
.arr{fill:none;stroke:#111418;stroke-width:1.4;stroke-linejoin:round}
.arr-head{fill:#111418}
.arr-lbl{font-size:10.5px;dominant-baseline:middle;paint-order:stroke;stroke:#fff;stroke-width:3.5;stroke-linejoin:round;pointer-events:none}
.squiggle{fill:none;stroke:#111418;stroke-width:0.9;stroke-linejoin:round}
.icom{font-size:9px;font-family:Menlo,Consolas,monospace;fill:#1f5fa9;font-weight:700}
.tunnel{fill:none;stroke:#111418;stroke-width:1.4}
.port-stub{fill:none;stroke:#5b6470;stroke-width:1.2;stroke-dasharray:4 3}
.port-dot{fill:#fff;stroke:#111418;stroke-width:1.4}
.port-lbl{font-size:10.5px;fill:#5b6470;font-style:italic;dominant-baseline:middle}
`;
