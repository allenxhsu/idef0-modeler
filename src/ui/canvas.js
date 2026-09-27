// The editing canvas: hit testing, arrow drawing, port connection, pan and zoom.
//
// Boxes are never placed by hand (S01): a press on a box selects it, and the
// staircase (`layoutBoxes`, model.js) decides where it sits. The drags that
// remain are an arrow's endpoints, bend and label — and a port's connection
// drag, which draws the arrow a parent concept is still missing on this
// diagram.

import { svg, clear, clamp, rafThrottle, textWidth } from '../util.js';
import { SHEET, WORK, SIDES, STUB } from '../model/types.js';
import {
  anchorOf, routeArrow, bendAxis, nearestSide, posOnSide, distToPolyline, rectOf, longestSegmentMid, pointsToPath,
  labelPosition, labelPlacement, legacyLabelBase, labelRect, pointInRect, portShape,
} from '../model/geometry.js';
import {
  addBox, boxEnd, boundaryEnd, effectiveConceptId, findBox, newArrow, ports, removeArrow, removeBox,
} from '../model/model.js';
import { renderDiagram, icomRects, drawnArrows } from './render.js';
import {
  store, set, commit, mutate, emit, beginDrag, endDrag, currentDiagram, goToDiagram, modelRevision,
} from '../state/store.js';
import { renameBox, labelArrow } from '../model/edits.js';
import { renameConcept } from '../model/concepts.js';
import { modalOpen } from './dialog.js';

const SNAP = 5;
const EDGE_GRAB = 26;        // how close to the frame edge counts as a boundary anchor
const BOX_GRAB = 14;         // how close to a box border counts as that side
const PORT_HALF_W = 5;       // a port's stub is grabbable within a 10-unit-wide rectangle
const PORT_RING = 6;         // and its open circle (r 4) with a little slack
const ARROW_GRAB = 9;        // CanvasRules.arrowGrab — how near an arrow's route selects it
const LABEL_GRAB = 26;       // CanvasRules.labelGrab — and how near its label starts a label drag

let root, viewport, sheetLayer, overlayLayer, wrap, editor;
let hover = null;            // candidate anchor under the cursor
let hotPort = null;          // port under the cursor (no drag in progress)
let drag = null;             // active drag descriptor

/* ------------------------------------------------------------ the frame */

/**
 * What one render derives from the model for the diagram it shows, kept for
 * the pointer events that follow it (S01): the ports (`ports()`, which walks
 * the ICOM pairing) and the drawn arrows (`drawnArrows()`, which walks the
 * bundles and routes every fork and join from its trunk, S02), plus
 * `entryOf` — arrow id → the drawn entry standing for it: its own, or the
 * representative hiding it as a bundle member — and `ownEntry`, arrow id →
 * the entry drawing that very arrow (none for a hidden member). Recomputing
 * these on every pointermove would cost the whole pairing and every route
 * per mouse step, so a frame is keyed on the store's model revision and the
 * diagram: an edit, an undo or a load starts a fresh one. A hover ring found
 * on the old frame is dropped with it, since the port or anchor it marked
 * may be gone.
 */
let frame = null;

function frameOf(dg) {
  const rev = modelRevision();
  if (frame && frame.rev === rev && frame.model === store.model && frame.dg === dg) return frame;
  if (frame) { hover = null; hotPort = null; }
  const drawn = drawnArrows(store.model, dg);
  const entryOf = new Map();
  const ownEntry = new Map();
  for (const e of drawn) {
    entryOf.set(e.arrow.id, e);
    ownEntry.set(e.arrow.id, e);
    for (const id of e.hidden) entryOf.set(id, e);
  }
  frame = { rev, model: store.model, dg, ports: ports(store.model, dg), drawn, entryOf, ownEntry };
  return frame;
}

/**
 * `representativeOf(dg, arrow)` — the arrow drawn for `arrow` (S01): itself
 * when it draws, else the bundle representative that stands for it. What a
 * press on the arrow's route selects, since only the representative is inked.
 */
export function representativeOf(dg, arrow) {
  return frameOf(dg).entryOf.get(arrow.id)?.arrow ?? arrow;
}

/**
 * `routeOf(dg, arrow)` — the route `arrow` is drawn along (S02,
 * `drawnArrows`): with its grouped ends at the trunk, and routed among the
 * drawn arrows only. A hidden bundle member, drawn nowhere, routes on its
 * own for the handles a selection from the glossary shows.
 */
export function routeOf(dg, arrow) {
  return frameOf(dg).ownEntry.get(arrow.id)?.pts ?? routeArrow(dg, arrow);
}

/**
 * `labelPathOf(dg, arrow)` — the part of the drawn route `arrow`'s label is
 * placed against (S02): the trunk for a fork or join's representative, the
 * branch alone for a member with a label of its own, the whole route
 * otherwise. A branch whose label the trunk shows has none drawn, but its
 * own label is still edited on its route.
 */
export function labelPathOf(dg, arrow) {
  const e = frameOf(dg).ownEntry.get(arrow.id);
  return e?.labelPath ?? e?.pts ?? routeArrow(dg, arrow);
}

/** The arrow as it is routed (S02): its grouped ends at the trunk. */
const drawnOf = (dg, arrow) => frameOf(dg).ownEntry.get(arrow.id)?.drawn ?? arrow;

/**
 * `endGroupOf(dg, arrowId, which)` — the members of the fork (`which` =
 * 'from') or join ('to') group the arrow belongs to on `dg` (S02): every
 * arrow drawn from that trunk, each with the end and bend it has stored, or
 * the arrow alone when it is not grouped there. What an endpoint drag moves
 * together, captured at the press so the drag can restore members it leaves.
 */
export function endGroupOf(dg, arrowId, which) {
  const { drawn, ownEntry } = frameOf(dg);
  const member = (a) => ({ id: a.id, end: { ...a[which] }, bend: a.bend ?? null });
  const own = ownEntry.get(arrowId);
  if (!own) { const a = dg.arrows.find((x) => x.id === arrowId); return a ? [member(a)] : []; }
  const rep = which === 'from' ? own.fork : own.join;
  if (rep == null) return [member(own.arrow)];
  return drawn.filter((e) => (which === 'from' ? e.fork : e.join) === rep).map((e) => member(e.arrow));
}

/**
 * `drawnLabelOf(dg, arrow)` — the text drawn as `arrow`'s label (S01): the
 * bundle's term where the arrow stands for merged members, else its own
 * label. The label hit test, the label drag and the inline editor all work
 * on this, so what the sheet shows is what the pointer finds.
 */
export function drawnLabelOf(dg, arrow) {
  const e = frameOf(dg).entryOf.get(arrow.id);
  return e && e.arrow.id === arrow.id ? e.label : arrow.label;
}

/** Whether `arrow`'s drawn label is its bundle's term rather than its own (S01). */
const drawsBundleTerm = (dg, arrow) => {
  const e = frameOf(dg).entryOf.get(arrow.id);
  return !!e && e.arrow.id === arrow.id && e.hidden.length > 0;
};

export function initCanvas() {
  root = document.getElementById('canvas');
  wrap = document.getElementById('canvas-wrap');
  editor = document.getElementById('inline-editor');

  viewport = svg('g', { id: 'viewport' });
  sheetLayer = svg('g', { id: 'sheet-layer' });
  overlayLayer = svg('g', { id: 'overlay-layer' });
  viewport.append(sheetLayer, overlayLayer);
  root.appendChild(viewport);

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerUp);
  root.addEventListener('pointercancel', onPointerUp);
  root.addEventListener('dblclick', onDoubleClick);
  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('contextmenu', (e) => e.preventDefault());
  // The canvas never takes focus on its own: a click that opens the inline
  // editor (drawing an arrow) must leave the keyboard in that editor, and
  // whatever field was focused before is released by onPointerDown instead.
  root.addEventListener('mousedown', (e) => e.preventDefault());
  // Keep the sheet framed while the user has not chosen a zoom of their own.
  const onResize = () => { if (autoFit) fitToWindow(); else applyTransform(); };
  window.addEventListener('resize', onResize);
  if (typeof ResizeObserver === 'function') new ResizeObserver(onResize).observe(wrap);

  editor.querySelector('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitEditor(); }
    if (e.key === 'Escape') { e.preventDefault(); closeEditor(); }
  });
  editor.querySelector('input').addEventListener('blur', () => commitEditor());

  fitToWindow();
}

/* -------------------------------------------------------------- rendering */

export const renderCanvas = rafThrottle(() => {
  const dg = currentDiagram();
  if (!dg) return;
  frameOf(dg);                 // a changed model or diagram starts a fresh frame (and drops a stale hover)
  clear(sheetLayer);
  sheetLayer.appendChild(renderDiagram(store.model, dg, { selection: store.ui.selection }));
  renderOverlay();
  applyTransform();
});

function renderOverlay() {
  const dg = currentDiagram();
  clear(overlayLayer);
  if (!dg) return;
  const sel = store.ui.selection;
  const s = store.ui.view.scale || 1;
  const k = (v) => v / s;                            // keep handles a constant screen size

  if (store.ui.tool === 'arrow') {
    overlayLayer.appendChild(svg('rect', {
      class: 'dropzone', x: WORK.x, y: WORK.y, width: WORK.w, height: WORK.h, 'pointer-events': 'none',
    }));
  }

  if (sel && sel.kind === 'arrow') {
    const a = dg.arrows.find((x) => x.id === sel.id);
    if (a) {
      // Handles sit on the drawn route (S02): a grouped end's at the trunk.
      const drawn = drawnOf(dg, a);
      const pa = anchorOf(dg, drawn.from), pb = anchorOf(dg, drawn.to);
      const pts = routeOf(dg, a);
      overlayLayer.appendChild(svg('circle', { class: 'handle', cx: pts[0].x, cy: pts[0].y, r: k(4.5), 'data-end': 'from' }));
      const last = pts[pts.length - 1];
      overlayLayer.appendChild(svg('circle', { class: 'handle', cx: last.x, cy: last.y, r: k(4.5), 'data-end': 'to' }));
      const bh = bendHandle(pa, pb, pts);
      if (bh) {
        overlayLayer.appendChild(svg('rect', {
          class: 'bendh', x: bh.x - k(4), y: bh.y - k(4), width: k(8), height: k(8),
          transform: `rotate(45 ${bh.x} ${bh.y})`, 'data-bend': bh.axis,
        }));
      }
    }
  }

  if (hover) {
    const p = anchorOf(dg, hover);
    overlayLayer.appendChild(svg('circle', { class: 'anchor hot', cx: p.x, cy: p.y, r: k(5), 'pointer-events': 'none' }));
  }

  // The port under the cursor lights up at its circle, the way a candidate
  // anchor does, so the modeller can see it is grabbable.
  if (hotPort && !drag) {
    const p = portShape(hotPort).inner;
    overlayLayer.appendChild(svg('circle', { class: 'anchor hot', cx: p.x, cy: p.y, r: k(6), 'pointer-events': 'none' }));
  }

  // A port being dragged previews the arrow it will draw: the real route once
  // a box side is under the pointer, else a line from the port's circle to
  // the pointer.
  if (drag && drag.kind === 'port') {
    const shape = portShape(drag.port);
    let pts;
    if (drag.target) {
      const { from, to } = portArrowEnds(drag.port, drag.target);
      pts = routeArrow(dg, { bend: null, from, to });
    } else {
      pts = [shape.inner, drag.cursor];
    }
    overlayLayer.appendChild(svg('path', { class: 'ghost', d: pointsToPath(pts, 0) }));
  }

  const pending = store.ui.pending;
  if (pending) {
    const a = anchorOf(dg, pending.from);
    const target = hover ? anchorOf(dg, hover) : { x: pending.cursor.x, y: pending.cursor.y, nx: 0, ny: 0 };
    const pts = hover
      ? routeArrow(dg, { bend: null, from: pending.from, to: hover })
      : [{ x: a.x, y: a.y }, { x: a.x + a.nx * 20, y: a.y + a.ny * 20 }, { x: target.x, y: target.y }];
    overlayLayer.appendChild(svg('path', { class: 'ghost', d: pointsToPath(pts, 0) }));
  }
}

function bendHandle(a, b, pts) {
  const axis = bendAxis(a, b, STUB);
  if (!axis) return null;
  const mid = pts[Math.floor(pts.length / 2)];
  if (!mid) return null;
  return axis === 'x' ? { x: mid.x, y: (pts[1].y + pts[pts.length - 2].y) / 2, axis: 'x' }
    : { x: (pts[1].x + pts[pts.length - 2].x) / 2, y: mid.y, axis: 'y' };
}

/* ----------------------------------------------------------- view control */

function applyTransform() {
  const { scale, tx, ty } = store.ui.view;
  viewport.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`);
  // The inline editor is a fixed-position DOM element, not part of the
  // transformed SVG, so it has to be repositioned by hand on every pan/zoom.
  if (editing) positionEditor();
}

let autoFit = true;

export function fitToWindow() {
  autoFit = true;
  const r = wrap.getBoundingClientRect();
  // The first call can land before layout; retry once the pane has a size.
  if (r.width < 60 || r.height < 60) { requestAnimationFrame(fitToWindow); return; }
  const pad = 24;
  const scale = clamp(Math.min((r.width - pad * 2) / SHEET.w, (r.height - pad * 2) / SHEET.h), 0.1, 5);
  store.ui.view = {
    scale,
    tx: (r.width - SHEET.w * scale) / 2,
    ty: (r.height - SHEET.h * scale) / 2,
  };
  applyTransform();
  renderCanvas();
  emit({ light: true });          // refresh the zoom readout in the status bar
}

export function zoomBy(factor, center) {
  autoFit = false;
  const r = wrap.getBoundingClientRect();
  const c = center || { x: r.width / 2, y: r.height / 2 };
  const v = store.ui.view;
  const next = clamp(v.scale * factor, 0.15, 5);
  const f = next / v.scale;
  store.ui.view = { scale: next, tx: c.x - (c.x - v.tx) * f, ty: c.y - (c.y - v.ty) * f };
  applyTransform();
  renderOverlay();
  emit({ light: true });
}


function onWheel(e) {
  e.preventDefault();
  const r = wrap.getBoundingClientRect();
  const c = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > 24) {
    zoomBy(Math.exp(-e.deltaY * 0.0016), c);
  } else {
    const v = store.ui.view;
    store.ui.view = { ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY };
    applyTransform();
  }
}

function toModel(e) {
  const m = viewport.getScreenCTM();
  if (!m) return { x: 0, y: 0 };
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  return { x: p.x, y: p.y };
}

/* ------------------------------------------------------------ hit testing */

/** Resolve the anchor a pointer position implies, or null. */
export function anchorAt(dg, pt, { boxesOnly = false } = {}) {
  for (const b of dg.boxes) {
    const r = rectOf(b);
    const inside = pt.x >= r.x - BOX_GRAB && pt.x <= r.x + r.w + BOX_GRAB
      && pt.y >= r.y - BOX_GRAB && pt.y <= r.y + r.h + BOX_GRAB;
    if (!inside) continue;
    const { side, pos } = nearestSide(r, pt);
    return boxEnd(b.id, side, pos);
  }
  if (boxesOnly) return null;
  const near = {
    left: Math.abs(pt.x - WORK.x), right: Math.abs(pt.x - WORK.x2),
    top: Math.abs(pt.y - WORK.y), bottom: Math.abs(pt.y - WORK.y2),
  };
  let best = null;
  for (const side of SIDES) {
    if (near[side] > EDGE_GRAB) continue;
    if (side === 'left' || side === 'right') {
      if (pt.y < WORK.y - 4 || pt.y > WORK.y2 + 4) continue;
    } else if (pt.x < WORK.x - 4 || pt.x > WORK.x2 + 4) continue;
    if (!best || near[side] < near[best]) best = side;
  }
  if (!best) return null;
  return boundaryEnd(best, posOnSide(WORK, best, pt));
}

/**
 * `portAt(m, dg, pt)` — the port (model.js `ports`) under `pt`, or null: the
 * first, in port order, whose drawn shape (`portShape`) the point lies on —
 * a 10-unit-wide rectangle along the stub from the sheet edge to the circle,
 * or the circle itself with a little slack (6 units from its centre). Purely
 * geometric, so it agrees with the renderer without reading anything back
 * from the DOM, and the same geometry as the Mac's `HitTest.port`. The
 * store's own model reads the ports from the current frame rather than
 * deriving them again for every pointer move.
 */
export function portAt(m, dg, pt) {
  const list = m === store.model ? frameOf(dg).ports : ports(m, dg);
  for (const port of list) {
    const { edge, inner } = portShape(port);
    const horizontal = port.side === 'left' || port.side === 'right';
    const stub = horizontal
      ? { x: Math.min(edge.x, inner.x), y: edge.y - PORT_HALF_W, w: Math.abs(inner.x - edge.x), h: PORT_HALF_W * 2 }
      : { x: edge.x - PORT_HALF_W, y: Math.min(edge.y, inner.y), w: PORT_HALF_W * 2, h: Math.abs(inner.y - edge.y) };
    if (pointInRect(stub, pt) || Math.hypot(pt.x - inner.x, pt.y - inner.y) <= PORT_RING) return port;
  }
  return null;
}

/**
 * The two ends of the arrow a port draws once it is dropped on `boxAnchor`
 * (a box endpoint from `anchorAt`): the port's own boundary endpoint (side,
 * pos) and the box side. An output port (the right edge) is where the arrow
 * leaves the sheet, so the box side is its `from` end and the port its `to`
 * end; an input, control or mechanism port is where the arrow comes in, so
 * the port is the `from` end.
 */
export function portArrowEnds(port, boxAnchor) {
  const boundary = boundaryEnd(port.side, port.pos);
  return port.side === 'right' ? { from: boxAnchor, to: boundary } : { from: boundary, to: boxAnchor };
}

function boxAt(dg, pt) {
  for (let i = dg.boxes.length - 1; i >= 0; i -= 1) {
    const b = dg.boxes[i];
    if (pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h) return b;
  }
  return null;
}

/**
 * `arrowAt(dg, pt)` — the arrow a press near a drawn route selects (S01,
 * S02): the nearest drawn route within reach (the first in array order on a
 * tie). A bundle member hidden behind its representative (`drawnArrows`) has
 * no ink and no route of its own to press; the representative is what is
 * drawn there. On the trunk of a fork or join every member's route
 * coincides, and the press selects the group's representative — the arrow
 * the trunk is; on a branch it selects that branch. The drawn routes are
 * walked once and the trunk test is one more polyline, so this stays
 * O(arrows) in what it adds.
 */
export function arrowAt(dg, pt) {
  const { drawn, ownEntry } = frameOf(dg);
  let best = null, bestD = ARROW_GRAB;
  for (const e of drawn) {
    const d = distToPolyline(e.pts, pt);
    if (d < bestD) { bestD = d; best = e; }
  }
  if (!best) return null;
  // The nearest point lies on the trunk when the trunk — a piece of this
  // very route — is no farther than the route itself.
  const onTrunk = (trunk) => trunk && distToPolyline(trunk, pt) <= bestD + 1e-6;
  if (best.fork != null && best.fork !== best.arrow.id && onTrunk(best.forkTrunk)) return ownEntry.get(best.fork)?.arrow ?? best.arrow;
  if (best.join != null && best.join !== best.arrow.id && onTrunk(best.joinTrunk)) return ownEntry.get(best.join)?.arrow ?? best.arrow;
  return best.arrow;
}

/** Every ICOM code and box rect for `dg` (F59) — the same context
 *  `labelPosition` scores an auto-placed label's candidates against, so a
 *  hit test always agrees with what `renderArrow` actually drew. */
function labelContext(dg) {
  return { icomEnds: icomRects(store.model, dg, frameOf(dg).drawn), boxes: dg.boxes.map(rectOf) };
}

/**
 * `labelAt(dg, pt)` — the drawn arrow, if any, whose label's actual
 * displayed rectangle contains `pt` (F39): `labelPosition`'s auto-placement
 * (F59) or the legacy base plus a manual ldx/ldy, whichever is really drawn,
 * for the text really drawn — a bundle representative's label is the
 * bundle's term (S01), placed and measured as that — against the part of the
 * route the label belongs to (S02: a trunk, a branch); a branch whose label
 * the trunk shows draws none to hit. Only drawn arrows have a label to hit;
 * walked from the last-drawn back, matching paint order.
 */
export function labelAt(dg, pt) {
  const ctx = labelContext(dg);
  const { drawn } = frameOf(dg);
  for (let i = drawn.length - 1; i >= 0; i -= 1) {
    const { arrow, label, labelPath } = drawn[i];
    if (!label || !labelPath) continue;
    const pos = labelPosition(labelPath, { ...arrow, label }, ctx);
    if (pointInRect(labelRect(pos, textWidth(label, 10.5)), pt)) return arrow;
  }
  return null;
}

/**
 * The `{dx, dy}` a label drag should start from (F59): a label already
 * offset keeps its own ldx/ldy unchanged, since that already says how far it
 * sits past the auto position; one still at its auto-placed spot starts from
 * the gap between that spot and `legacyLabelBase`, so ldx/ldy keep meaning
 * "how far past the (unmoved) legacy base" once the drag ends, and the label
 * does not jump the moment it starts moving.
 */
function labelDragOrigin(pts, arrow, ctx) {
  const dx = arrow.ldx || 0, dy = arrow.ldy || 0;
  if (dx !== 0 || dy !== 0) return { dx, dy };
  const auto = labelPlacement(pts, arrow.label, ctx);
  const base = legacyLabelBase(pts);
  return { dx: auto.x - base.x, dy: auto.y - base.y };
}

/* -------------------------------------------------------------- pointers */

function onPointerDown(e) {
  if (e.button === 2) return;
  // Whatever is being typed — an inline rename or label, a Properties field —
  // is saved to the object it belongs to before the click changes anything.
  // Escape is the only way to abandon an edit.
  flushEdits();
  const dg = currentDiagram();
  if (!dg) return;
  const pt = toModel(e);
  try { root.setPointerCapture(e.pointerId); } catch { /* no live pointer (synthetic event) */ }

  // Middle button or space always pans.
  if (e.button === 1 || spaceDown) {
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, v: { ...store.ui.view } };
    return;
  }

  // A port — a parent concept not yet connected on this diagram — starts a
  // connection drag in either tool. Ports are never selected, and an arrow
  // half-drawn with the arrow tool is abandoned: the port says what the arrow
  // denotes, so it cannot be that arrow's destination.
  const port = portAt(store.model, dg, pt);
  if (port) {
    hotPort = null;
    hover = null;
    if (store.ui.pending) set({ pending: null });
    drag = { kind: 'port', port, cursor: pt, target: null };
    set({ hint: `Drop ${port.code} “${port.label || '(unlabelled)'}” on a box side to connect it.` });
    renderOverlay();
    return;
  }

  if (store.ui.tool === 'arrow') {
    const anchor = anchorAt(dg, pt);
    if (!anchor) { set({ pending: null }); return; }
    if (!store.ui.pending) {
      set({ pending: { from: anchor, cursor: pt }, hint: 'Click the arrow’s destination — a box side, or the sheet edge for a boundary arrow.' });
    } else {
      const from = store.ui.pending.from;
      // The source may have been deleted or undone since it was picked; an
      // arrow to a box that is gone would dangle (same refusal as the Mac app).
      if ([from, anchor].some((end) => end.type === 'box' && !findBox(dg, end.boxId))) {
        set({ pending: null, hint: 'That box or arrow no longer exists.' });
        return;
      }
      commit('Draw arrow', (m) => {
        const d = m.diagrams[dg.id];
        d.arrows.push(newArrow({ label: '', from, to: anchor }));
        const created = d.arrows[d.arrows.length - 1];
        store.ui.selection = { kind: 'arrow', id: created.id };
      });
      set({ pending: null, hint: 'Arrow added. Give it a noun-phrase label.' });
      const created = currentDiagram().arrows.at(-1);
      if (created) startLabelEdit(created);
    }
    return;
  }

  // Handles first: they sit on top of everything.
  const handleEl = e.target.closest && e.target.closest('[data-end],[data-bend]');
  if (handleEl) {
    const sel = store.ui.selection;
    if (handleEl.dataset.end && sel?.kind === 'arrow') {
      // A grouped end (S02) drags its whole fork or join along the face.
      const which = handleEl.dataset.end;
      drag = { kind: 'endpoint', label: 'Move arrow end', arrowId: sel.id, which, group: endGroupOf(dg, sel.id, which) };
      return;
    }
    if (handleEl.dataset.bend && sel?.kind === 'arrow') {
      drag = { kind: 'bend', label: 'Bend arrow', arrowId: sel.id, axis: handleEl.dataset.bend };
      return;
    }
  }

  // A box is selected, never moved: the staircase places it (S01).
  const box = boxAt(dg, pt);
  if (box) {
    set({ selection: { kind: 'box', id: box.id } });
    return;
  }

  // Labels are tested before arrowAt (F39): a moved or vertical-run label can
  // sit well clear of the 9-unit route reach that used to gate its drag. The
  // drag starts from where the drawn text (S01: a bundle's term, perhaps)
  // was auto-placed, so it does not jump on the first move.
  const labelHit = labelAt(dg, pt);
  if (labelHit) {
    set({ selection: { kind: 'arrow', id: labelHit.id } });
    const pts = labelPathOf(dg, labelHit);
    drag = {
      kind: 'label', label: 'Move arrow label', arrowId: labelHit.id, start: pt,
      orig: labelDragOrigin(pts, { ...labelHit, label: drawnLabelOf(dg, labelHit) }, labelContext(dg)),
    };
    return;
  }

  const arrow = arrowAt(dg, pt);
  if (arrow) {
    set({ selection: { kind: 'arrow', id: arrow.id } });
    // Fallback (F39): labelAt already tried the label's real rectangle above;
    // this mirrors the original mid+ld radius test in case that missed, so a
    // label already found by arrowAt's route reach is never left ungrabbable.
    const pts = routeOf(dg, arrow);
    const mid = longestSegmentMid(pts);
    if (drawnLabelOf(dg, arrow) && Math.hypot(pt.x - (mid.x + (arrow.ldx || 0)), pt.y - (mid.y + (arrow.ldy || 0))) < LABEL_GRAB) {
      drag = { kind: 'label', label: 'Move arrow label', arrowId: arrow.id, start: pt, orig: { dx: arrow.ldx || 0, dy: arrow.ldy || 0 } };
    }
    return;
  }

  set({ selection: null });
  drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, v: { ...store.ui.view } };
}

function onPointerMove(e) {
  const dg = currentDiagram();
  if (!dg) return;
  const pt = toModel(e);

  if (drag && drag.kind === 'port') {
    drag.cursor = pt;
    drag.target = anchorAt(dg, pt, { boxesOnly: true });
    hover = drag.target;
    renderOverlay();
    return;
  }

  if (!drag) {
    // A port under the cursor is offered in either tool, ahead of the sheet
    // edge it sits on (the arrow tool would otherwise read it as a plain
    // boundary anchor).
    const port = portAt(store.model, dg, pt);
    const next = port ? null : (store.ui.tool === 'arrow' || store.ui.pending) ? anchorAt(dg, pt) : null;
    // `ports()` derives fresh objects on every call, so ports compare by the
    // parent arrow they stand for.
    const changed = JSON.stringify(next) !== JSON.stringify(hover)
      || (port ? port.parentArrowId : null) !== (hotPort ? hotPort.parentArrowId : null);
    hover = next;
    hotPort = port;
    if (store.ui.pending) store.ui.pending.cursor = pt;
    if (changed || store.ui.pending) renderOverlay();
    return;
  }

  switch (drag.kind) {
    case 'pan': {
      autoFit = false;
      store.ui.view = { ...drag.v, tx: drag.v.tx + (e.clientX - drag.sx), ty: drag.v.ty + (e.clientY - drag.sy) };
      applyTransform();
      break;
    }
    case 'endpoint': {
      const anchor = anchorAt(dg, pt);
      if (!anchor) break;
      touch();
      // A grouped end (S02) moves every member of its fork or join along
      // the face together, so the stored positions stay consistent with the
      // one drawn trunk; reconnected to another side or box, the dragged
      // arrow leaves the group alone and the others go back where the press
      // found them. The same rule as the Mac's `Edits.moveEndpoint`.
      const { arrowId, which, group } = drag;
      const own = group.find((g) => g.id === arrowId)?.end ?? anchor;
      const sameFace = own.type === anchor.type && own.side === anchor.side
        && (anchor.type !== 'box' || own.boxId === anchor.boxId);
      mutate((m) => {
        const arrows = m.diagrams[dg.id].arrows;
        for (const g of group) {
          const a = arrows.find((x) => x.id === g.id);
          if (!a) continue;
          if (g.id === arrowId || sameFace) { a[which] = { ...anchor }; a.bend = null; } else { a[which] = { ...g.end }; a.bend = g.bend; }
        }
      });
      renderCanvas();
      break;
    }
    case 'bend': {
      touch();
      mutate((m) => {
        const a = m.diagrams[dg.id].arrows.find((x) => x.id === drag.arrowId);
        if (!a) return;
        const v = snap(drag.axis === 'x' ? pt.x : pt.y);
        a.bend = drag.axis === 'x' ? clamp(v, WORK.x, WORK.x2) : clamp(v, WORK.y, WORK.y2);
      });
      renderCanvas();
      break;
    }
    case 'label': {
      touch();
      mutate((m) => {
        const a = m.diagrams[dg.id].arrows.find((x) => x.id === drag.arrowId);
        if (!a) return;
        a.ldx = Math.round(drag.orig.dx + (pt.x - drag.start.x));
        a.ldy = Math.round(drag.orig.dy + (pt.y - drag.start.y));
      });
      renderCanvas();
      break;
    }
    default: break;
  }
}

/** Record an undo point the first time a drag actually changes the model. */
function touch() {
  if (!drag || drag.moved) return;
  drag.moved = true;
  beginDrag(drag.label);
}

function onPointerUp(e) {
  try { if (root.hasPointerCapture?.(e.pointerId)) root.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.kind === 'port') {
    hover = null;
    // A cancelled pointer (the window lost it) draws nothing; a release does
    // whatever is under it — a box side connects, anywhere else lets go.
    if (e.type !== 'pointercancel') {
      const dg = currentDiagram();
      connectPort(d.port, dg ? anchorAt(dg, toModel(e), { boxesOnly: true }) : null);
    }
    renderOverlay();
    return;
  }
  if (d.kind === 'pan' || !d.moved) return;     // a plain click is not an edit
  endDrag();
  renderCanvas();
}

/**
 * Finish a port drag: draw the arrow the port stands for — one "Connect
 * Port" edit, as on the Mac — with the port's concept and label (S01). The
 * arrow's ends come from `portArrowEnds`; any box side takes the drop
 * (whether the role fits the side is the checks' business). Refused — with a
 * hint and no change — when the release is not on a box side, the port is
 * gone (the parent changed, or it was connected meanwhile) or the box is
 * gone. No label editor opens afterwards: the arrow already carries the
 * parent's label, and an unlabelled one is what the checks report. Returns
 * the created arrow, or null.
 */
export function connectPort(port, boxAnchor) {
  const dg = currentDiagram();
  if (!dg || !boxAnchor || boxAnchor.type !== 'box') {
    set({ hint: 'Drop the port on a box side to connect it.' });
    return null;
  }
  // The port is re-derived at release: what matters is what the parent still
  // asks for now, not what was under the pointer when the drag began.
  const live = ports(store.model, dg).find((p) => p.parentArrowId === port.parentArrowId);
  if (!live) { set({ hint: 'That port no longer exists.' }); return null; }
  const box = findBox(dg, boxAnchor.boxId);
  if (!box) { set({ hint: 'That box or arrow no longer exists.' }); return null; }
  const { from, to } = portArrowEnds(live, boxAnchor);
  const created = commit('Connect Port', (m) => {
    const d = m.diagrams[dg.id];
    d.arrows.push(newArrow({ label: live.label, conceptId: live.conceptId, from, to }));
    const a = d.arrows[d.arrows.length - 1];
    store.ui.selection = { kind: 'arrow', id: a.id };
    return a;
  });
  set({ pending: null, hint: `Connected ${live.code} “${live.label || '(unlabelled)'}” to box ${box.number}.` });
  renderCanvas();
  return created;
}

const snap = (v) => Math.round(v / SNAP) * SNAP;

let spaceDown = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !isTyping(e) && !modalOpen()) { spaceDown = true; }
  // Escape lets go of a port mid-drag, and stops there: main.js's Escape
  // (drop the selection, go up to the parent) must not also fire under a
  // drag that is being abandoned.
  if (e.key === 'Escape' && drag && drag.kind === 'port') {
    e.stopImmediatePropagation();
    drag = null;
    hover = null;
    set({ hint: '' });
    renderOverlay();
  }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });
const isTyping = (e) => /input|textarea|select/i.test(e.target.tagName || '');

/* -------------------------------------------------------- inline editing */

let editing = null;

function onDoubleClick(e) {
  const dg = currentDiagram();
  if (!dg) return;
  const pt = toModel(e);
  const box = boxAt(dg, pt);
  if (box) {
    if (e.altKey && box.childDiagramId) { goToDiagram(box.childDiagramId); return; }
    startBoxEdit(box);
    return;
  }
  // F39: a moved or vertical-run label may sit well clear of arrowAt's reach.
  const labelHit = labelAt(dg, pt);
  if (labelHit) { startLabelEdit(labelHit); return; }
  const arrow = arrowAt(dg, pt);
  if (arrow) startLabelEdit(arrow);
}

export function startBoxEdit(box) {
  const rect = { x: box.x + 8, y: box.y + box.h / 2 - 14, w: box.w - 16, h: 28 };
  openEditor(rect, box.name, { kind: 'box', id: box.id });
}

/**
 * Open the inline editor on an arrow's label — the text actually drawn
 * (S01): where the arrow stands for merged bundle members, that is the
 * bundle's term, and the editor then renames the bundle (`commitEditor`);
 * otherwise it is the arrow's own label, edited as it always was. A hidden
 * member selected from the glossary is not drawn at all and edits its own.
 */
export function startLabelEdit(arrow) {
  const dg = currentDiagram();
  // F59/S02: on the part of the route the label belongs to.
  const pts = labelPathOf(dg, arrow);
  const bundleTerm = drawsBundleTerm(dg, arrow);
  const label = bundleTerm ? drawnLabelOf(dg, arrow) : arrow.label;
  // F59: the editor box centres on the label's actual displayed position,
  // auto-placed or manually offset, rather than assuming the legacy spot.
  const pos = labelPosition(pts, { ...arrow, label }, labelContext(dg));
  const rect = { x: pos.x - 70, y: pos.y - 14, w: 140, h: 24 };
  openEditor(rect, label, {
    kind: 'arrow', id: arrow.id, bundleId: bundleTerm ? effectiveConceptId(store.model, arrow.conceptId) : null,
  });
}

function modelRectToScreen(r) {
  const { scale, tx, ty } = store.ui.view;
  return { left: r.x * scale + tx, top: r.y * scale + ty, width: r.w * scale, height: Math.max(22, r.h * scale) };
}

// F42: the model-space rect the editor is centred on, kept for as long as it
// is open so a pan or zoom (applyTransform) can reposition it — otherwise it
// floats away from the box or label it is editing.
let editingRect = null;

function positionEditor() {
  const scr = modelRectToScreen(editingRect);
  editor.style.left = `${scr.left}px`;
  editor.style.top = `${scr.top}px`;
  editor.style.width = `${Math.max(90, scr.width)}px`;
  editor.style.height = `${scr.height}px`;
}

function openEditor(rect, value, target) {
  editing = target;
  editingRect = rect;
  editor.hidden = false;
  positionEditor();
  const input = editor.querySelector('input');
  input.value = value || '';
  input.focus();
  input.select();
}

/**
 * Save the inline editor's text to its box or arrow through the same
 * `renameBox` / `labelArrow` the inspector uses (model/edits.js): trimmed,
 * bound to its concept, nodes renumbered, and renaming the A-0 box renames
 * the model. An editor opened on a bundle's term (S01, `startLabelEdit`)
 * renames the bundle instead — `renameConcept`, "Rename Concept" in both
 * apps — carrying every box and arrow bound to the bundle itself along and
 * leaving the members' own labels as they are; a blank term is refused, as
 * it is everywhere a bundle is named. A target that no longer exists is
 * skipped; an unchanged value is left to `commit`, which records nothing
 * when the model comes out the same (re-entering the name of a box whose
 * concept was removed does change it: the box is bound again).
 */
function commitEditor() {
  if (!editing) return;
  const target = editing;
  editing = null;
  editingRect = null;
  const value = editor.querySelector('input').value;
  editor.hidden = true;
  const dg = currentDiagram();
  const exists = target.kind === 'box'
    ? findBox(dg, target.id)
    : dg?.arrows.find((x) => x.id === target.id);
  if (!exists) return;
  if (target.bundleId) {
    if (!value.trim()) { set({ hint: 'A bundle needs a term.' }); return; }
    commit('Rename Concept', (m) => { renameConcept(m, target.bundleId, value); });
  } else {
    commit(target.kind === 'box' ? 'Rename box' : 'Label arrow', (m) => {
      if (target.kind === 'box') renameBox(m, dg.id, target.id, value);
      else labelArrow(m, dg.id, target.id, value);
    });
  }
  renderCanvas();
}

function closeEditor() {
  if (!editing) return;
  editing = null;
  editingRect = null;
  editor.hidden = true;
}

/** Abandon an inline edit without saving it (Escape, or the model is being replaced). */
export function cancelInlineEdit() {
  closeEditor();
  const input = editor?.querySelector('input');
  if (input && document.activeElement === input) input.blur();
}

/**
 * Commit whatever is being typed by dropping focus: the inline editor saves
 * on blur, and a panel field fires its `change`. Nothing happens when the
 * keyboard is already on the page body.
 */
export function flushEdits() {
  const a = document.activeElement;
  if (a && a !== document.body && typeof a.blur === 'function') a.blur();
}

/* ------------------------------------------------------------- commands  */

// F08: the A-0 context diagram holds exactly one box (FIPS 183 §3.4.2); once
// it has one, adding another here would give it two, which nothing else in
// either app expects. A file that already violates this (e.g. an import with
// zero boxes) stays repairable, since the guard only blocks going to two.
// Where the box goes is the staircase's decision (`addBox` lays the diagram
// out); the modeller only names it.
export function addBoxHere() {
  const dg = currentDiagram();
  if (dg.id === store.model.rootDiagramId && dg.boxes.length >= 1) {
    set({ hint: 'The A-0 context diagram must keep its single box.' });
    return;
  }
  const box = commit('Add box', (m) => addBox(m, m.diagrams[dg.id]));
  set({ selection: { kind: 'box', id: box.id } });
  renderCanvas();
  startBoxEdit(box);
}

export function deleteSelection() {
  const sel = store.ui.selection;
  const dg = currentDiagram();
  if (!sel || !dg) return;
  if (sel.kind === 'box' && dg.id === store.model.rootDiagramId) {
    set({ hint: 'The A-0 context diagram must keep its single box.' });
    return;
  }
  commit(sel.kind === 'box' ? 'Delete box' : 'Delete arrow', (m) => {
    const d = m.diagrams[dg.id];
    if (sel.kind === 'box') removeBox(m, d, sel.id); else removeArrow(d, sel.id);
  });
  // An arrow being drawn from the deleted box must not be finished.
  set({ selection: null, pending: null });
  renderCanvas();
}

export function getHover() { return hover; }
