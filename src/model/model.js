// The IDEF0 model: creation and structural operations.
//
//   Model    { schema, title, author, project, purpose, viewpoint, status,
//              created, revised, glossary[], diagrams{}, rootDiagramId }
//   Diagram  { id, node, title, parentBoxId, boxes[], arrows[], notes[], cNumber }
//   Box      { id, name, conceptId, x, y, w, h, number, childDiagramId, note, refs }
//   Arrow    { id, label, conceptId, from, to, bend, tunnelFrom, tunnelTo, note }
//
// `conceptId` points into `glossary[]`, which is the model's concept registry.
// A child diagram's inherited boundary arrow keeps its parent's conceptId, so
// the parent/child correspondence is recorded as data rather than re-derived
// from matching label text. See model/concepts.js.
//   Endpoint { type:'box', boxId, side, pos } | { type:'boundary', side, pos }
//   Concept  { id, term, kind, definition, members? }
//
// A box, arrow, diagram and concept may also carry the optional per-element
// clocks `updatedAt` and `deletedAt` (ISO-8601 instants; `deletedAt` is a
// tombstone marking the element removed). Neither is ever invented, so an
// element the file records none for round-trips unchanged. See src/io/json.js.
//
// A concept whose `members` lists other concepts is a *bundle* (FIPS 183
// §3.2.2.3): the bundle carries the general label, its members the specific
// ones. Boxes and arrows always bind to the specific concept; the bundle is
// looked up from it (`bundleOf`, `effectiveConceptId` below), so combining
// concepts never rewrites an occurrence and un-combining is lossless.
//
// A box's node number and the node number of its detail diagram are the same
// string (FIPS 183): box 3 of diagram A2 is node A23, and if it is decomposed
// its child diagram is also A23.
//
// Boxes are never placed by hand: every structural edit (`addBox`,
// `removeBox`, `moveBox`, `decomposeBox`) lays the diagram's boxes out along
// the staircase in number order (`layoutBoxes`). Nothing is laid out on load,
// so opening a file never rewrites it. The A-0 context diagram is never laid
// out: its single box stays where it is.

import { uid, todayISO } from '../util.js';
import { WORK, BOX_DEFAULT, BOX_MIN, SIDE_ROLE, SIDE_ICOM, SIDES } from './types.js';

export const SCHEMA = 'idef0-modeler/1';

/* ------------------------------------------------------------------ create */

export function newDiagram({ node, title, parentBoxId = null, titleLocked = false }) {
  return { id: uid('dg'), node, title, parentBoxId, titleLocked, boxes: [], arrows: [], notes: [], cNumber: '' };
}

export function newBox({ name = '', number = 1, x, y, w = BOX_DEFAULT.w, h = BOX_DEFAULT.h, conceptId = null }) {
  return { id: uid('bx'), name, number, x, y, w, h, conceptId, childDiagramId: null, note: '', refs: '' };
}

export function newArrow({ label = '', from, to, bend = null, conceptId = null }) {
  return { id: uid('ar'), label, from, to, bend, conceptId, ldx: 0, ldy: 0, tunnelFrom: false, tunnelTo: false, note: '' };
}

export const boxEnd = (boxId, side, pos = 0.5) => ({ type: 'box', boxId, side, pos });
export const boundaryEnd = (side, pos = 0.5) => ({ type: 'boundary', side, pos });

/** A fresh model: an A-0 context diagram holding a single box. */
export function createModel(title = 'Untitled Model') {
  const ctx = newDiagram({ node: 'A-0', title, parentBoxId: null });
  const box = newBox({
    name: title,
    number: 0,
    x: WORK.x + (WORK.w - 300) / 2,
    y: WORK.y + (WORK.h - 170) / 2,
    w: 300, h: 170,
  });
  ctx.boxes.push(box);
  return {
    schema: SCHEMA,
    id: uid('mdl'),
    title,
    author: '',
    project: '',
    purpose: '',
    viewpoint: '',
    status: 'WORKING',
    created: todayISO(),
    revised: todayISO(),
    glossary: [],
    diagrams: { [ctx.id]: ctx },
    rootDiagramId: ctx.id,
  };
}

/* ----------------------------------------------------------------- lookups */

export const getDiagram = (m, id) => m.diagrams[id] || null;
export const contextDiagram = (m) => m.diagrams[m.rootDiagramId];

export function findBox(diagram, boxId) {
  return diagram ? diagram.boxes.find((b) => b.id === boxId) || null : null;
}

export function findBoxAnywhere(m, boxId) {
  for (const d of Object.values(m.diagrams)) {
    const b = d.boxes.find((x) => x.id === boxId);
    if (b) return { diagram: d, box: b };
  }
  return null;
}

export function parentOf(m, diagram) {
  if (!diagram || !diagram.parentBoxId) return null;
  return findBoxAnywhere(m, diagram.parentBoxId);
}

export function childDiagram(m, box) {
  return box && box.childDiagramId ? m.diagrams[box.childDiagramId] || null : null;
}

/**
 * Diagrams ordered as a depth-first walk of the decomposition tree.
 *
 * A diagram that details one of its own ancestors (a cycle a hand-edited or
 * imported file can hold) is not descended into again, so the walk ends; the
 * validator reports it as decomp-cycle. The guard is the current path, not a
 * global visited set, so a diagram two boxes name is still listed under each.
 */
export function diagramTree(m) {
  const out = [];
  const path = new Set();
  const walk = (dg, depth) => {
    if (!dg) return;
    out.push({ diagram: dg, depth });
    path.add(dg.id);
    for (const b of sortedBoxes(dg)) {
      const c = childDiagram(m, b);
      if (c && !path.has(c.id)) walk(c, depth + 1);
    }
    path.delete(dg.id);
  };
  walk(contextDiagram(m), 0);
  return out;
}

export const sortedBoxes = (dg) => [...dg.boxes].sort((a, b) => a.number - b.number);

/* ----------------------------------------------------------------- bundles */

/** Whether a glossary entry is a bundle: it lists at least one member. */
export const isBundle = (c) => !!c && Array.isArray(c.members) && c.members.length > 0;

/**
 * The bundle whose `members` lists `id` — the first in glossary order, should
 * a malformed file list a concept in two — else null. A falsy id is in no
 * bundle. Defined here rather than in concepts.js because ICOM coding needs
 * it and concepts.js imports this module; concepts.js re-exports it.
 */
export const bundleOf = (m, id) =>
  (id ? m.glossary.find((g) => Array.isArray(g.members) && g.members.includes(id)) || null : null);

/**
 * The outermost bundle enclosing `id`, else `id` itself: the concept an ICOM
 * position stands for once its specifics are bundled (§3.3.2.3). Cycle-safe:
 * a bundle already visited ends the climb, so a malformed file cannot loop.
 * A falsy id comes back unchanged.
 */
export function effectiveConceptId(m, id) {
  if (!id) return id;
  let cur = id;
  const seen = new Set([cur]);
  for (;;) {
    const b = bundleOf(m, cur);
    if (!b || seen.has(b.id)) return cur;
    seen.add(b.id);
    cur = b.id;
  }
}

/**
 * Node number a box carries — the same string as its detail diagram's node
 * number. The single box of A-0 is A0; the boxes of A0 are A1..A6 (the "0" is
 * dropped, per FIPS 183); below that the parent's node is simply extended, so
 * box 2 of A3 is A32.
 */
export function boxNode(diagram, box) {
  if (diagram.node === 'A-0') return 'A0';
  if (diagram.node === 'A0') return `A${box.number}`;
  return `${diagram.node}${box.number}`;
}

/* ---------------------------------------------------------- arrow taxonomy */

/** IDEF0 role of an arrow, derived from the side of the box it touches. */
export function arrowRole(arrow) {
  if (arrow.to.type === 'box') return SIDE_ROLE[arrow.to.side] || 'unknown';
  if (arrow.from.type === 'box') return arrow.from.side === 'bottom' ? 'call' : 'output';
  return 'unknown';
}

export function arrowsTouching(diagram, boxId) {
  return diagram.arrows.filter(
    (a) => (a.from.type === 'box' && a.from.boxId === boxId) || (a.to.type === 'box' && a.to.boxId === boxId),
  );
}

/**
 * Whether a boundary end of an arrow can carry an ICOM code.
 *
 * FIPS 183 §3.3.2.7–8: a boundary arrow enters the diagram on the left, top
 * or bottom (its `from` end) and leaves it on the right (its `to` end); an end
 * running the other way corresponds to nothing on the parent box. A call
 * arrow's end never counts: it leaves a box bottom to name a called box, not
 * an arrow on the parent (§3.3.2.10), just as parentBoxArrows gives it no code.
 */
const isIcomEnd = (a, which, side) =>
  (arrowRole(a) === 'call' ? false : (side === 'right' ? which === 'to' : which === 'from'));

/**
 * Boundary arrows of a diagram, grouped by side and ordered for ICOM coding.
 *
 * Only ends that can carry a code are collected (see isIcomEnd). Tunnelled
 * ends are left out too. FIPS 183 §3.3.2.9: an arrow tunnelled at its
 * unconnected end "does not have an ICOM code", because it has no
 * corresponding arrow on the parent diagram — and leaving it in would also
 * consume an ordinal and shift the codes of the arrows beside it.
 */
export function boundaryArrowsBySide(diagram, { includeTunnelled = false } = {}) {
  const groups = { left: [], top: [], right: [], bottom: [] };
  for (const a of diagram.arrows) {
    for (const which of ['from', 'to']) {
      const e = a[which];
      if (e.type !== 'boundary') continue;
      if (!isIcomEnd(a, which, e.side)) continue;
      if (!includeTunnelled && (which === 'from' ? a.tunnelFrom : a.tunnelTo)) continue;
      groups[e.side]?.push({ arrow: a, which, pos: e.pos });
    }
  }
  for (const side of SIDES) groups[side].sort((p, q) => p.pos - q.pos);
  return groups;
}

/**
 * The arrows on a parent box, per side, each carrying the ICOM code its
 * position gives it.
 *
 * FIPS 183 §3.3.2.8: the letter says which role the arrow plays *on the parent
 * box*, and the number gives "the relative position at which the arrow is
 * shown connecting to the parent box, numbering from left to right or top to
 * bottom". So the code is a property of the parent, never of the child sheet.
 * An arrow tunnelled where it meets the box keeps its code — §3.3.2.9: "because
 * this arrow does correspond to one on its parent diagram, it is given an ICOM
 * code" — it is merely not shown on the child, so Figure 18 has C1 and C3 with
 * C2 tunnelled. Such an entry is flagged `tunnelled` so the pairing can leave
 * it alone without renumbering its neighbours. An arrow leaving the bottom is
 * a call arrow and is not ICOM-coded at all (§3.3.2.10).
 *
 * Arrows on one side that denote the same concept are one arrow forked or
 * joined at the box (§3.3.3 rule 14): they connect at one ICOM position, so
 * they share one entry and one code, numbered by the lowest of them. The
 * entry's `arrow` is that lowest member and `arrows` lists every member; the
 * entry is `tunnelled` only if every member is. "The same concept" is the
 * *effective* concept (`effectiveConceptId`): two arrows whose specific
 * concepts are members of one bundle are that bundle forked at the box
 * (§3.2.2.3), so they too share one position and one code. An arrow bound to
 * no concept is always an entry of its own.
 */
export function parentBoxArrows(m, parentDg, box) {
  const sides = { left: [], top: [], right: [], bottom: [] };
  for (const a of parentDg.arrows) {
    if (a.to.type === 'box' && a.to.boxId === box.id) {
      sides[a.to.side]?.push({ arrow: a, pos: a.to.pos, tunnelled: !!a.tunnelTo });
    }
    if (a.from.type === 'box' && a.from.boxId === box.id && a.from.side !== 'bottom') {
      sides[a.from.side]?.push({ arrow: a, pos: a.from.pos, tunnelled: !!a.tunnelFrom });
    }
  }
  for (const side of SIDES) {
    sides[side].sort((p, q) => p.pos - q.pos);
    const entries = [];
    const byConcept = new Map();
    for (const e of sides[side]) {
      const id = e.arrow.conceptId ? effectiveConceptId(m, e.arrow.conceptId) : null;
      const group = id ? byConcept.get(id) : undefined;
      if (group) {
        group.arrows.push(e.arrow);
        group.tunnelled = group.tunnelled && e.tunnelled;
        continue;
      }
      const entry = { arrow: e.arrow, arrows: [e.arrow], pos: e.pos, tunnelled: e.tunnelled };
      if (id) byConcept.set(id, entry);
      entries.push(entry);
    }
    entries.forEach((e, i) => { e.code = `${SIDE_ICOM[side]}${i + 1}`; });
    sides[side] = entries;
  }
  return sides;
}

const normLabel = (v) => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Pair a child diagram's boundary ends with the arrows on its parent box.
 * Correspondence is found side for side, by concept first, then by label,
 * then by remaining position — so an arrow keeps its code when it is
 * reordered, and keeps it when a child elaborates its label (§3.3.2.4).
 *
 * Several child ends denoting the concept of one parent entry are a fork or a
 * join drawn as separate arrows (§3.3.3 rule 14); they all take that entry's
 * code. That is settled straight after the concept pass, so a duplicate can
 * never take another arrow's code by label or position.
 *
 * Roles may differ between parent and child for inputs, controls and
 * mechanisms (§3.3.2.8, Figure 15: a parent control entering the child from
 * the left). So a child end on the left, top or bottom left unmatched on its
 * own side pairs, by concept alone, with a parent arrow of the same concept on
 * another of those sides, and keeps the parent's code ("C1" on the left edge).
 * Outputs never change role. This rescue runs last, so it only ever turns an
 * orphan into a pair; issue order is unchanged for a model that needs none.
 * A pair's `side` is the child end's side, a missing entry's the parent's.
 *
 * One pairing serves both the codes that get drawn and the consistency check,
 * so the two can never disagree.
 *
 * A parent arrow tunnelled at the box is not shown on the child (§3.3.2.9), so
 * it is neither paired nor reported missing; it keeps its code all the same.
 *
 * Concepts are compared by their effective id (`effectiveConceptId`): a child
 * end bound to one member of a bundle pairs with a parent entry bound to
 * another member of it, the way the parent's own position already stands for
 * the whole bundle (see parentBoxArrows).
 */
export function icomPairing(m, child) {
  const out = { pairs: [], orphans: [], missing: [], parent: null };
  const childEnds = boundaryArrowsBySide(child);
  const parent = parentOf(m, child);
  if (!parent) {
    for (const side of SIDES) for (const c of childEnds[side]) out.orphans.push({ side, child: c });
    return out;
  }
  out.parent = parent;
  const parentSides = parentBoxArrows(m, parent.diagram, parent.box);
  const state = {};
  const eff = (id) => effectiveConceptId(m, id);

  for (const side of SIDES) {
    const P = parentSides[side].filter((pe) => !pe.tunnelled);
    const C = childEnds[side];
    const usedP = new Set();
    const matched = new Map();
    state[side] = { P, C, usedP, matched };

    const pass = (test) => {
      C.forEach((c, ci) => {
        if (matched.has(ci)) return;
        const pi = P.findIndex((pe, k) => !usedP.has(k) && test(c, pe));
        if (pi >= 0) { usedP.add(pi); matched.set(ci, P[pi]); }
      });
    };
    const sameConcept = (c, pe) => c.arrow.conceptId && eff(c.arrow.conceptId) === eff(pe.arrow.conceptId);
    pass(sameConcept);
    // Forks and joins: further ends of a concept already paired share its code.
    C.forEach((c, ci) => {
      if (matched.has(ci)) return;
      const pi = P.findIndex((pe, k) => usedP.has(k) && sameConcept(c, pe));
      if (pi >= 0) matched.set(ci, P[pi]);
    });
    pass((c, pe) => normLabel(c.arrow.label) && normLabel(c.arrow.label) === normLabel(pe.arrow.label));

    const leftC = C.map((_, i) => i).filter((i) => !matched.has(i));
    const leftP = P.map((_, k) => k).filter((k) => !usedP.has(k));
    leftC.forEach((ci, n) => {
      if (n < leftP.length) { usedP.add(leftP[n]); matched.set(ci, P[leftP[n]]); }
    });
  }

  // Role changes (§3.3.2.8): an unmatched input, control or mechanism end
  // takes an unmatched parent arrow of its concept on another of those sides,
  // and failing that one already paired there (a fork that changes role).
  const ROLE_SIDES = ['left', 'top', 'bottom'];
  for (const used of [false, true]) {
    for (const side of ROLE_SIDES) {
      const { C, matched } = state[side];
      C.forEach((c, ci) => {
        if (matched.has(ci) || !c.arrow.conceptId) return;
        for (const ps of ROLE_SIDES) {
          if (ps === side) continue;
          const { P, usedP } = state[ps];
          const pi = P.findIndex((pe, k) => usedP.has(k) === used && eff(c.arrow.conceptId) === eff(pe.arrow.conceptId));
          if (pi >= 0) { usedP.add(pi); matched.set(ci, P[pi]); return; }
        }
      });
    }
  }

  for (const side of SIDES) {
    const { P, C, usedP, matched } = state[side];
    C.forEach((c, ci) => {
      const pe = matched.get(ci);
      if (pe) out.pairs.push({ side, child: c, parent: pe, code: pe.code });
      else out.orphans.push({ side, child: c });
    });
    P.forEach((pe, k) => { if (!usedP.has(k)) out.missing.push({ side, parent: pe }); });
  }
  return out;
}

/**
 * Map of `arrowId:which` -> ICOM code for one diagram. Empty for a context
 * diagram, which has no parent to be coded against (§3.4.2).
 */
export function icomCodes(m, diagram) {
  const out = {};
  for (const p of icomPairing(m, diagram).pairs) {
    out[`${p.child.arrow.id}:${p.child.which}`] = p.code;
  }
  return out;
}

/**
 * The parent box's ICOM concepts not yet (or no longer) connected to any
 * activity on `diagram` — one per `icomPairing(m, diagram).missing` entry, in
 * that order: `{ side, pos, code, label, conceptId, parentArrowId, role }`.
 * `side` is the child edge the concept enters or leaves by (left = I, top =
 * C, bottom = M, right = O), `pos` the parent arrow's position at the box,
 * and `conceptId`/`label` those of the entry's representative arrow (the
 * lowest of a fork, join or bundle). A port is drawn at the sheet edge and is
 * where an arrow for that concept starts; it is derived, never stored, and
 * the context diagram, which has no parent, has none. Each is still the
 * `icom-missing` error, because FIPS 183 requires the match before the model
 * is done — a port is merely the way to fix it.
 */
export function ports(m, diagram) {
  const out = [];
  const p = icomPairing(m, diagram);
  if (!p.parent) return out;
  for (const ms of p.missing) {
    // A bundled ICOM entry is one port for the whole bundle: it carries the
    // bundle's term and id, so connecting it draws the general arrow (FIPS
    // 183 §3.2.2.3) and pairs by effective concept. A member can still be
    // drawn on its own afterwards, from the glossary.
    const cid = ms.parent.arrow.conceptId ?? null;
    const eff = effectiveConceptId(m, cid);
    const bundle = eff && eff !== cid ? m.glossary.find((g) => g.id === eff) : null;
    out.push({
      side: ms.side, pos: ms.parent.pos, code: ms.parent.code, label: bundle ? bundle.term : ms.parent.arrow.label,
      conceptId: bundle ? bundle.id : cid, parentArrowId: ms.parent.arrow.id, role: SIDE_ROLE[ms.side],
    });
  }
  return out;
}

/* --------------------------------------------------------------- numbering */

/** Renumber boxes in the order FIPS 183 §3.3.4.1 lays down. */
export function renumberBoxes(diagram) {
  if (diagram.node === 'A-0') {
    diagram.boxes.forEach((b) => { b.number = 0; });
    return;
  }
  boxReadingOrder(diagram.boxes).forEach((b, i) => { b.number = i + 1; });
}

/**
 * FIPS 183 §3.3.4.1: boxes on the staircase run are numbered in order from the
 * upper left; "if off-diagonal boxes are also used, the numbering sequence
 * starts with the on-diagonal boxes and then continues, from the lower right,
 * in counter-clockwise order."
 */
export function boxReadingOrder(boxes) {
  const all = [...boxes];
  if (all.length < 2) return all;
  const onDiagonal = staircaseChain(all);
  const onIds = new Set(onDiagonal.map((b) => b.id));
  const off = all.filter((b) => !onIds.has(b.id));
  if (!off.length) return onDiagonal;

  const cx = all.reduce((n, b) => n + b.x + b.w / 2, 0) / all.length;
  const cy = all.reduce((n, b) => n + b.y + b.h / 2, 0) / all.length;
  // Angles measured with y pointing up, so counter-clockwise is increasing.
  // The sweep starts at the lower right, which is -45° in that frame.
  const START = -Math.PI / 4;
  const sweep = (b) => {
    const ang = Math.atan2(-(b.y + b.h / 2 - cy), b.x + b.w / 2 - cx);
    return (ang - START + Math.PI * 4) % (Math.PI * 2);
  };
  off.sort((p, q) => sweep(p) - sweep(q));
  return [...onDiagonal, ...off];
}

/** The longest run of boxes advancing in both x and y — the staircase. */
function staircaseChain(boxes) {
  const pts = [...boxes].sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const len = pts.map(() => 1);
  const prev = pts.map(() => -1);
  for (let i = 1; i < pts.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (pts[j].y <= pts[i].y && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    }
  }
  let best = 0;
  for (let i = 1; i < pts.length; i += 1) if (len[i] > len[best]) best = i;
  const chain = [];
  for (let i = best; i >= 0; i = prev[i]) chain.unshift(pts[i]);
  return chain;
}

/**
 * Re-derive every diagram's node number from the tree. Call after any move.
 *
 * A box detailed by one of its own ancestors — a cycle only a hand-edited or
 * imported file can hold — is skipped: renumbering that ancestor from below
 * would rename it (A-0 itself, for a box naming the root), and following the
 * link would never end. The validator reports it as decomp-cycle.
 */
export function renumberNodes(m) {
  const ctx = contextDiagram(m);
  if (!ctx) return;
  ctx.node = 'A-0';
  const path = new Set();
  const walk = (dg) => {
    path.add(dg.id);
    for (const b of dg.boxes) {
      const child = childDiagram(m, b);
      if (!child || path.has(child.id)) continue;
      child.node = boxNode(dg, b);
      // A child diagram is titled after the box it details, but only until
      // somebody titles it themselves.
      if (!child.titleLocked) child.title = b.name || child.title;
      walk(child);
    }
    path.delete(dg.id);
  };
  walk(ctx);
}

/* ------------------------------------------------------------- decompose  */

/**
 * Lay `n` boxes out along the staircase diagonal IDEF0 conventionally uses.
 *
 * The box size is derived from how many have to fit, so that the step along
 * the diagonal always exceeds the box itself: at the six boxes FIPS 183
 * allows, fixed box dimensions would overlap their neighbours.
 */
export function staircaseLayout(n) {
  const GAP_X = 20, GAP_Y = 14;
  const extentX = WORK.w - 120;          // 60 units of margin either side
  const extentY = WORK.h - 130;          // 40 above, 90 below
  const bw = Math.max(BOX_MIN.w, Math.min(BOX_DEFAULT.w, Math.floor((extentX - (n - 1) * GAP_X) / n)));
  const bh = Math.max(BOX_MIN.h, Math.min(BOX_DEFAULT.h, Math.floor((extentY - (n - 1) * GAP_Y) / n)));
  const spanX = extentX - bw;
  const spanY = extentY - bh;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    out.push({
      x: Math.round(WORK.x + 60 + spanX * t),
      y: Math.round(WORK.y + 40 + spanY * t),
      w: bw, h: bh,
    });
  }
  return out;
}

/**
 * Lay a diagram's boxes out along the staircase, in box-number order: the
 * i-th box by number takes the i-th `staircaseLayout(n)` rectangle (x, y, w,
 * h). Pure geometry — numbers are left as they are, so a diagram whose
 * numbers a hand-edited file left with gaps still reads in its own order.
 * The A-0 context diagram is never laid out: its single box stays where it
 * is. Called by every structural edit and by the "Arrange" action, never on
 * load.
 */
export function layoutBoxes(diagram) {
  if (diagram.node === 'A-0') return;
  const boxes = sortedBoxes(diagram);
  if (!boxes.length) return;
  const rects = staircaseLayout(boxes.length);
  boxes.forEach((b, i) => {
    const r = rects[i];
    b.x = r.x;
    b.y = r.y;
    b.w = r.w;
    b.h = r.h;
  });
}

/**
 * The tail of every structural edit below A-0: numbers compacted to 1..n in
 * the surviving number order (stable, so two boxes sharing a number keep
 * their array order), then the staircase. A-0 only renumbers, to 0.
 */
function settleBoxes(diagram) {
  if (diagram.node === 'A-0') { renumberBoxes(diagram); return; }
  sortedBoxes(diagram).forEach((b, i) => { b.number = i + 1; });
  layoutBoxes(diagram);
}

/**
 * Create the detail diagram for `box`, seeded with `count` unnamed boxes on
 * the staircase and no arrows. The parent box's ICOM arrows are not copied
 * down: the child starts with a port for each of them (see `ports`), drawn at
 * the sheet edge until the modeller connects it to an activity, and each is
 * reported as `icom-missing` until then. A call arrow (leaving the bottom)
 * has no counterpart at all: FIPS 183 §3.3.2.10 says a caller box is detailed
 * by another box entirely, not by a child diagram of its own.
 */
export function decomposeBox(m, parentDiagram, box, count = 3) {
  if (box.childDiagramId) return m.diagrams[box.childDiagramId];

  const node = boxNode(parentDiagram, box);
  const child = newDiagram({ node, title: box.name || node, parentBoxId: box.id });

  const layout = staircaseLayout(count);
  layout.forEach((rect, i) => {
    child.boxes.push(newBox({ name: '', number: i + 1, ...rect }));
  });

  m.diagrams[child.id] = child;
  box.childDiagramId = child.id;
  renumberNodes(m);
  return child;
}

/**
 * Delete a diagram and everything below it. A diagram already being deleted
 * further up — a decomposition cycle — is not entered again.
 */
export function deleteSubtree(m, diagramId) {
  deleteSubtreeWalk(m, diagramId, new Set());
}

function deleteSubtreeWalk(m, diagramId, path) {
  const dg = m.diagrams[diagramId];
  if (!dg || diagramId === m.rootDiagramId || path.has(diagramId)) return;
  path.add(diagramId);
  for (const b of dg.boxes) if (b.childDiagramId) deleteSubtreeWalk(m, b.childDiagramId, path);
  const parent = parentOf(m, dg);
  if (parent) parent.box.childDiagramId = null;
  delete m.diagrams[diagramId];
  path.delete(diagramId);
}

/* ---------------------------------------------------------------- editing */

/**
 * Append an unnamed box as number n+1, then lay the diagram out
 * (`layoutBoxes`). Where a box goes is never the caller's to say: the
 * staircase decides. On A-0 — reachable only to repair a file whose context
 * diagram has lost its box — the box takes the first grid cell and number 0,
 * and nothing is laid out. Returns the new box as numbered.
 */
export function addBox(m, diagram) {
  const n = diagram.boxes.length;
  const box = newBox({
    name: '',
    number: n + 1,
    x: WORK.x + 60 + (n % 3) * 210,
    y: WORK.y + 40 + Math.floor(n / 3) * 150,
  });
  diagram.boxes.push(box);
  settleBoxes(diagram);
  renumberNodes(m);
  return box;
}

/**
 * Remove a box with its detail subtree and every arrow touching it, compact
 * the survivors' numbers to 1..n in their number order, then lay them out.
 */
export function removeBox(m, diagram, boxId) {
  const box = findBox(diagram, boxId);
  if (!box) return;
  if (box.childDiagramId) deleteSubtree(m, box.childDiagramId);
  diagram.boxes = diagram.boxes.filter((b) => b.id !== boxId);
  diagram.arrows = diagram.arrows.filter(
    (a) => !(a.from.type === 'box' && a.from.boxId === boxId) && !(a.to.type === 'box' && a.to.boxId === boxId),
  );
  settleBoxes(diagram);
  renumberNodes(m);
}

/**
 * Move a box one step earlier (`by` = -1) or later (`by` = +1) in the reading
 * order: it swaps numbers with its neighbour in number order, numbers are
 * compacted to 1..n, the diagram is laid out again and node numbers follow.
 * Returns false, changing nothing, when there is no such box, no neighbour
 * that way (the first box cannot move earlier), `by` is not ±1, or the
 * diagram is A-0.
 */
export function moveBox(m, diagram, boxId, by) {
  if (diagram.node === 'A-0' || (by !== -1 && by !== 1)) return false;
  const order = sortedBoxes(diagram);
  const i = order.findIndex((b) => b.id === boxId);
  if (i < 0) return false;
  const j = i + by;
  if (j < 0 || j >= order.length) return false;
  const t = order[i].number;
  order[i].number = order[j].number;
  order[j].number = t;
  settleBoxes(diagram);
  renumberNodes(m);
  return true;
}

export function removeArrow(diagram, arrowId) {
  diagram.arrows = diagram.arrows.filter((a) => a.id !== arrowId);
}

/** Free position along a side, avoiding endpoints already in use there. */
export function freePos(diagram, endpointMatch) {
  const used = [];
  for (const a of diagram.arrows) {
    for (const e of [a.from, a.to]) {
      if (endpointMatch(e)) used.push(e.pos);
    }
  }
  for (let n = 1; n <= 9; n += 1) {
    for (let i = 1; i <= n; i += 1) {
      const p = i / (n + 1);
      if (!used.some((u) => Math.abs(u - p) < 0.06)) return p;
    }
  }
  return 0.5;
}
