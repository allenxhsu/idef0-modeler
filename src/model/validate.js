// IDEF0 rule checking (FIPS 183 discipline).
//
// Every issue is { severity, code, message, diagramId, kind, id }, where
// kind/id point at the box or arrow to select when the issue is clicked.

import { DECOMP_MIN, DECOMP_MAX, ROLE_LABEL, SIDE_ROLE } from './types.js';
import { arrowRole, boxNode, boxReadingOrder, childDiagram, contextDiagram, effectiveConceptId, findBox, icomPairing, isBundle, sortedBoxes } from './model.js';
import { conceptById, conceptUsage, occurrencesOf, transitiveMembers } from './concepts.js';
import { boxNameLines } from '../util.js';

const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Words a box name or arrow label may not consist solely of. FIPS 183 §3.3.3
 * rule 15 lists them for both; §3.2.2.3 rule 5 adds "call" for labels. Only a
 * whole normalised name is matched: "Process Control" is a real phrase.
 */
const RESERVED_BOX = new Set(['function', 'activity', 'process', 'input', 'output', 'control', 'mechanism']);
const RESERVED_ARROW = new Set([...RESERVED_BOX, 'call']);

export function validate(m) {
  const issues = [];
  const add = (severity, code, message, diagramId, kind = null, id = null) =>
    issues.push({ severity, code, message, diagramId, kind, id });

  const ctx = contextDiagram(m);
  if (!ctx) return [{ severity: 'error', code: 'no-context', message: 'The model has no A-0 context diagram.', diagramId: null }];

  checkStructure(m, ctx, add);

  /* ---- model-level requirements (FIPS 183 §: purpose and viewpoint) ---- */
  if (!m.purpose.trim()) add('warning', 'model-purpose', 'The model states no purpose. Every IDEF0 model must declare one.', ctx.id);
  if (!m.viewpoint.trim()) add('warning', 'model-viewpoint', 'The model states no viewpoint. Every IDEF0 model must declare one.', ctx.id);
  if (!m.title.trim()) add('warning', 'model-title', 'The model has no title.', ctx.id);

  const nodeSeen = new Map();

  for (const dg of Object.values(m.diagrams)) {
    const isContext = dg.id === m.rootDiagramId;

    /* ---- node numbers are unique ---- */
    if (nodeSeen.has(dg.node)) add('error', 'node-dup', `Node number ${dg.node} is used by more than one diagram.`, dg.id);
    nodeSeen.set(dg.node, dg.id);

    /* ---- box count ---- */
    if (isContext) {
      if (dg.boxes.length !== 1) {
        add('error', 'ctx-single-box', `The A-0 context diagram holds ${dg.boxes.length} boxes; it must hold exactly one.`, dg.id);
      }
    } else if (dg.boxes.length < DECOMP_MIN) {
      add('warning', 'decomp-count', `${dg.node} has ${dg.boxes.length} box(es). A decomposition should have ${DECOMP_MIN}–${DECOMP_MAX}; fewer than ${DECOMP_MIN} adds no detail.`, dg.id);
    } else if (dg.boxes.length > DECOMP_MAX) {
      add('error', 'decomp-count', `${dg.node} has ${dg.boxes.length} boxes. A decomposition may hold at most ${DECOMP_MAX}.`, dg.id);
    }

    /* ---- box numbering ---- */
    const numbers = new Map();
    let numberIssue = false;
    for (const b of dg.boxes) {
      if (numbers.has(b.number)) { add('error', 'box-number-dup', `Box number ${b.number} appears twice on ${dg.node}.`, dg.id, 'box', b.id); numberIssue = true; }
      numbers.set(b.number, b.id);
      if (isContext) {
        if (b.number !== 0) {
          add('error', 'box-number-range', `The A-0 top box is numbered ${b.number}; it must be 0.`, dg.id, 'box', b.id);
          numberIssue = true;
        }
      } else if (!Number.isInteger(b.number) || b.number < 1 || b.number > DECOMP_MAX) {
        add('error', 'box-number-range', `Box number ${b.number} on ${dg.node} is outside the 1–${DECOMP_MAX} range IDEF0 allows.`, dg.id, 'box', b.id);
        numberIssue = true;
      }
    }

    /* ---- box numbers follow reading order (§3.3.4.1): a completed move or
       resize re-derives numbers from boxReadingOrder, but a hand-edited or
       imported file, or a stale number left by some other path, can still
       disagree with it. Skipped on A-0, whose single box is always 0
       (box-number-range covers that), and skipped once box-number-dup or
       box-number-range has already flagged this diagram's numbers, which
       would only make the order check noise. ---- */
    if (!isContext && !numberIssue && !boxReadingOrder(dg.boxes).every((b, i) => b.number === i + 1)) {
      add('warning', 'box-number-order', `${dg.node}: box numbers do not follow reading order (FIPS 183 §3.3.4.1); move a box or renumber to re-derive them.`, dg.id);
    }

    /* ---- per-box rules ---- */
    for (const b of dg.boxes) {
      const node = boxNode(dg, b);
      if (!b.name.trim()) {
        add('error', 'box-name', `Box ${b.number} on ${dg.node} is unnamed. Box names are active verb phrases.`, dg.id, 'box', b.id);
      } else if (RESERVED_BOX.has(norm(b.name))) {
        add('error', 'reserved-term', `“${b.name}” (${node}) is a reserved IDEF0 word. Name the function it performs (FIPS 183 §3.3.3).`, dg.id, 'box', b.id);
      } else if (!looksLikeVerbPhrase(b.name)) {
        add('warning', 'box-verb', `“${b.name}” (${node}) may not be an active verb phrase — IDEF0 box names are verbs, e.g. “Assemble Chassis”.`, dg.id, 'box', b.id);
      }
      /* ---- the box is too small to show its full name, even at the
         smallest size the renderer will try (§3.2.1.3) ---- */
      if (b.name.trim()) {
        const lines = boxNameLines(b.name, b.w, b.h, b.number, 10);
        if (lines.length && lines[lines.length - 1].endsWith('…')) {
          add('warning', 'box-name-fit', `${node} is too small to show its full name (FIPS 183 §3.2.1.3)`, dg.id, 'box', b.id);
        }
      }

      const touching = dg.arrows.filter(
        (a) => (a.from.type === 'box' && a.from.boxId === b.id) || (a.to.type === 'box' && a.to.boxId === b.id),
      );
      const roles = new Set();
      let calls = 0;
      for (const a of touching) {
        if (a.to.type === 'box' && a.to.boxId === b.id) roles.add(ROLE_OF_SIDE(a.to.side));
        if (a.from.type === 'box' && a.from.boxId === b.id) {
          roles.add(a.from.side === 'bottom' ? 'call' : 'output');
          if (a.from.side === 'bottom') calls += 1;
        }
      }
      if (!roles.has('control')) add('error', 'box-control', `${node} has no control. Every IDEF0 box requires at least one control arrow on its top.`, dg.id, 'box', b.id);
      if (!roles.has('output')) add('error', 'box-output', `${node} has no output. Every IDEF0 box requires at least one output arrow from its right.`, dg.id, 'box', b.id);

      /* ---- call arrows: at most one per box (§3.3.3 rule 11), and a caller
         is detailed by the box it calls, not by a child of its own (§3.3.2.10) ---- */
      if (calls > 1) {
        add('error', 'box-call-count', `${node} has ${calls} call arrows. A box may have at most one (FIPS 183 §3.3.3).`, dg.id, 'box', b.id);
      }
      if (calls > 0 && childDiagram(m, b)) {
        add('error', 'call-decomposed', `${node} has a call arrow and a child diagram. A caller box is detailed by the box it calls, not by a decomposition of its own (FIPS 183 §3.3.2.10).`, dg.id, 'box', b.id);
      }

      if (b.name.trim() && !conceptById(m, b.conceptId)) {
        add('error', 'concept-unbound', `${node} is not bound to a glossary concept. Re-enter its name to bind it.`, dg.id, 'box', b.id);
      }
      /* ---- a box denotes a function, never an object (§3.2.2); 'other'
         is a kind somebody chose deliberately, so it passes ---- */
      const bc = conceptById(m, b.conceptId);
      if (b.name.trim() && bc && (bc.kind === 'data' || bc.kind === 'mechanism')) {
        add('warning', 'concept-kind', `${node} is bound to “${bc.term}”, which the glossary records as ${bc.kind}. A box denotes an activity.`, dg.id, 'box', b.id);
      }
    }

    /* ---- per-arrow rules ---- */
    for (const a of dg.arrows) {
      const role = arrowRole(a);
      if (!a.label.trim()) {
        add('error', 'arrow-label', `An unlabelled ${ROLE_LABEL[role].toLowerCase()} arrow on ${dg.node}. Arrow labels are noun phrases.`, dg.id, 'arrow', a.id);
      } else if (RESERVED_ARROW.has(norm(a.label))) {
        add('error', 'reserved-term', `“${a.label}” on ${dg.node} is a reserved IDEF0 word. Label the arrow with the object it carries (FIPS 183 §3.2.2.3).`, dg.id, 'arrow', a.id);
      }
      for (const which of ['from', 'to']) {
        const e = a[which];
        if (e.type === 'box' && !findBox(dg, e.boxId)) {
          add('error', 'arrow-dangling', `An arrow on ${dg.node} points at a box that no longer exists.`, dg.id, 'arrow', a.id);
        }
      }
      if (a.from.type === 'boundary' && a.to.type === 'boundary') {
        add('error', 'arrow-passthrough', `“${a.label || 'unlabelled'}” runs from boundary to boundary on ${dg.node} without touching a box.`, dg.id, 'arrow', a.id);
      }
      /* ---- boundary ends run inward on the left, top and bottom and outward
         on the right (§3.3.2.7–8); a call arrow may end at the bottom edge ---- */
      for (const which of ['from', 'to']) {
        const e = a[which];
        if (e.type !== 'boundary') continue;
        if (e.side === 'right' ? which === 'to' : which === 'from') continue;
        if (role === 'call' && which === 'to' && e.side === 'bottom') continue;
        add('error', 'boundary-direction', `“${a.label || 'unlabelled'}” runs the wrong way at the ${e.side} edge of ${dg.node}. Boundary arrows enter a diagram on the left, top or bottom and leave it on the right.`, dg.id, 'arrow', a.id);
      }
      if (a.from.type === 'box' && (a.from.side === 'left' || a.from.side === 'top')) {
        add('error', 'arrow-origin', `“${a.label || 'unlabelled'}” leaves a box from its ${a.from.side}. Arrows leave a box only from the right (output) or bottom (call).`, dg.id, 'arrow', a.id);
      }
      if (a.from.type === 'box' && a.from.side === 'bottom' && a.to.type === 'box') {
        add('error', 'call-target', `“${a.label || 'unlabelled'}” leaves a box from its bottom and runs into a box on ${dg.node}. A call arrow ends unconnected, labelled with the reference expression of the box it calls (FIPS 183 §3.2.2.3).`, dg.id, 'arrow', a.id);
      }
      if (a.to.type === 'box' && a.to.side === 'right') {
        add('error', 'arrow-target', `“${a.label || 'unlabelled'}” enters a box on its right. The right side carries outputs only.`, dg.id, 'arrow', a.id);
      }
      if (a.from.type === 'box' && a.to.type === 'box' && a.from.boxId === a.to.boxId) {
        add('error', 'arrow-self', `“${a.label || 'unlabelled'}” starts and ends on the same box.`, dg.id, 'arrow', a.id);
      }
      // FIPS 183 §3.4.2 bars a tunnel only at an unconnected (boundary) end:
      // A-0 has no parent to resolve it against. A tunnel at the box end is
      // ordinary notation (§3.3.2.9) that happens to be moot on A-0.
      if (isContext && ((a.tunnelFrom && a.from.type === 'boundary') || (a.tunnelTo && a.to.type === 'boundary'))) {
        add('error', 'ctx-tunnel', `“${a.label || 'unlabelled'}” is tunnelled at its unconnected end on the A-0 context diagram. A-0 has no parent, so it carries neither ICOM codes nor tunnels.`, dg.id, 'arrow', a.id);
      }
      if (a.label.trim() && !conceptById(m, a.conceptId)) {
        add('error', 'concept-unbound', `“${a.label}” on ${dg.node} is not bound to a glossary concept. Re-enter its label to bind it.`, dg.id, 'arrow', a.id);
      }
      const ac = conceptById(m, a.conceptId);
      if (a.label.trim() && ac && ac.kind === 'activity') {
        add('warning', 'concept-kind', `“${a.label}” on ${dg.node} is bound to activity “${ac.term}”. An arrow denotes an object; give it a distinct term or change the concept’s kind.`, dg.id, 'arrow', a.id);
      }
    }

    /* ---- parent / child ICOM consistency ---- */
    for (const b of sortedBoxes(dg)) {
      const child = childDiagram(m, b);
      if (!child) continue;
      issues.push(...checkIcomConsistency(m, child));
    }
  }

  /* ---- every concept the model uses must be defined ----
     Lecture W2.2 p.53: "All activities and all concepts must have a glossary
     entry"; FIPS 183 §3.2.2.1 asks the same of key words and phrases. Reported
     once per concept rather than once per occurrence, and pointed at the first
     place the concept is used. */
  const used = conceptUsage(m);
  /* ---- bundles (FIPS 183 §3.2.2.3): a concept belongs to at most one
     bundle, once; no bundle contains itself; a bundle combines at least two
     concepts, ideally of one kind. Each issue points at the first place the
     member concerned is used, so clicking it lands on an arrow of the bundle;
     failing that, at A-0. ---- */
  const memberIn = new Map();
  const termOf = (id) => conceptById(m, id)?.term ?? id;
  const target = (ids) => {
    for (const id of ids) {
      const first = occurrencesOf(m, id)[0];
      if (first) return [first.diagramId, first.kind, first.id];
    }
    return [ctx.id, null, null];
  };
  for (const g of m.glossary) {
    if (used.has(g.id) && !g.definition.trim()) {
      const first = occurrencesOf(m, g.id)[0];
      add('warning', 'concept-undefined',
        `“${g.term}” (${g.kind}) is used ${used.get(g.id)}× but has no glossary definition.`,
        first ? first.diagramId : ctx.id, first ? first.kind : null, first ? first.id : null);
    }
    if (!isBundle(g)) continue;
    const seenHere = new Set();
    for (const id of g.members) {
      if (seenHere.has(id)) {
        add('error', 'bundle-member-dup', `Bundle “${g.term}” lists “${termOf(id)}” more than once.`, ...target([id]));
      } else if (memberIn.has(id)) {
        add('error', 'bundle-member-dup', `“${termOf(id)}” is a member of both “${memberIn.get(id)}” and “${g.term}”. A concept belongs to at most one bundle.`, ...target([id]));
      } else {
        memberIn.set(id, g.term);
      }
      seenHere.add(id);
    }
    if (transitiveMembers(m, g.id).has(g.id)) {
      add('error', 'bundle-cycle', `Bundle “${g.term}” contains itself through its members. Un-combine it to break the cycle.`, ...target(g.members));
    }
    const known = g.members.filter((id) => conceptById(m, id));
    if (known.length < 2) {
      add('warning', 'bundle-thin', `Bundle “${g.term}” has ${known.length} member(s). A bundle combines at least two concepts (FIPS 183 §3.2.2.3).`, ...target(g.members));
    }
    const kinds = [];
    for (const id of known) { const k = conceptById(m, id).kind; if (!kinds.includes(k)) kinds.push(k); }
    if (kinds.length > 1) {
      add('warning', 'bundle-mixed-kind', `Bundle “${g.term}” combines concepts of different kinds (${kinds.join(', ')}). Its members should be of one kind.`, ...target(g.members));
    }
  }

  const order = { error: 0, warning: 1 };
  return issues.sort((p, q) => order[p.severity] - order[q.severity]);
}

/**
 * Referential integrity of the decomposition, checked before any rule that
 * follows its links. A file the editors wrote always passes; these catch
 * hand-edited, merged or imported files, which an ontology toolkit ingests.
 *
 * FIPS 183 builds a model as a tree of diagrams: each detail diagram details
 * exactly one parent box. Ids are the join keys, so each must name one thing. A cycle
 * is found by a depth-first walk from A-0 that keeps the diagrams on the
 * current path and the diagrams already finished, so the walk is linear even
 * where boxes share a detail diagram.
 */
function checkStructure(m, ctx, add) {
  /* ---- ids are unique: boxes and arrows model-wide, concepts in the glossary ---- */
  const boxIds = new Set();
  const arrowIds = new Set();
  for (const dg of Object.values(m.diagrams)) {
    for (const b of dg.boxes) {
      if (boxIds.has(b.id)) add('error', 'id-dup', `Box id ${b.id} on ${dg.node} is already used by another box. Ids must be unique across the model.`, dg.id, 'box', b.id);
      boxIds.add(b.id);
    }
    for (const a of dg.arrows) {
      if (arrowIds.has(a.id)) add('error', 'id-dup', `Arrow id ${a.id} on ${dg.node} is already used by another arrow. Ids must be unique across the model.`, dg.id, 'arrow', a.id);
      arrowIds.add(a.id);
    }
  }
  const conceptIds = new Set();
  for (const g of m.glossary) {
    if (conceptIds.has(g.id)) add('error', 'id-dup', `Concept id ${g.id} (“${g.term}”) is already used by another glossary entry. Ids must be unique across the model.`, ctx.id);
    conceptIds.add(g.id);
  }

  /* ---- every detail link names a diagram that details that box alone ---- */
  const claimed = new Set();
  for (const dg of Object.values(m.diagrams)) {
    for (const b of dg.boxes) {
      if (!b.childDiagramId) continue;
      const node = boxNode(dg, b);
      const child = childDiagram(m, b);
      if (!child) {
        add('error', 'detail-dangling', `${dg.node}: box ${node} names a detail diagram the model does not hold. Clear the link or restore the diagram.`, dg.id, 'box', b.id);
        continue;
      }
      if (claimed.has(child.id)) {
        add('error', 'detail-parent', `${dg.node}: box ${node} names ${child.node} as its detail diagram, which another box already names. A diagram details exactly one box.`, dg.id, 'box', b.id);
      } else if (child.parentBoxId !== b.id) {
        add('error', 'detail-parent', `${dg.node}: box ${node} names ${child.node} as its detail diagram, but ${child.node} does not name that box as its parent.`, dg.id, 'box', b.id);
      }
      claimed.add(child.id);
    }
  }

  /* ---- no diagram details one of its own ancestors ---- */
  const onPath = new Set();
  const done = new Set();
  const walk = (dg) => {
    onPath.add(dg.id);
    for (const b of sortedBoxes(dg)) {
      const child = childDiagram(m, b);
      if (!child || done.has(child.id)) continue;
      if (onPath.has(child.id)) {
        add('error', 'decomp-cycle', `${dg.node}: box ${boxNode(dg, b)} is detailed by ${child.node}, which is one of its own ancestors. Unlink the decomposition.`, dg.id, 'box', b.id);
      } else {
        walk(child);
      }
    }
    onPath.delete(dg.id);
    done.add(dg.id);
  };
  walk(ctx);

  /* ---- every diagram hangs off the tree ---- */
  for (const dg of Object.values(m.diagrams)) {
    if (dg.id === m.rootDiagramId || done.has(dg.id)) continue;
    add('warning', 'diagram-unreachable', `${dg.node} is not reached from the A-0 context diagram through any decomposition. Link it to the box it details or delete it.`, dg.id);
  }
}

const ROLE_OF_SIDE = (side) => SIDE_ROLE[side] || 'unknown';

/**
 * A child diagram's boundary arrows must match the arrows on its parent box,
 * unless one end is tunnelled: side for side, or by concept across the input,
 * control and mechanism sides where a role changes (§3.3.2.8).
 *
 * This reads the very pairing that produces the drawn ICOM codes, so a code
 * and the check that justifies it can never disagree. Correspondence is
 * structural — concept, then label, then position — never label text alone,
 * because §3.3.2.4 lets a child give an arrow a more specific label than its
 * parent carries. Only a count that fails to line up is an error.
 */
function checkIcomConsistency(m, child) {
  const out = [];
  const { pairs, orphans, missing, parent } = icomPairing(m, child);
  if (!parent) return out;
  const parentDg = parent.diagram;
  const node = boxNode(parentDg, parent.box);
  const name = (a) => a.label.trim() || '(unlabelled)';
  const role = SIDE_ROLE;

  for (const p of pairs) {
    // Both ends are bound but to different concepts (F11): a hand-edit or an
    // explicit rebind pointed one side of a pair somewhere the other side
    // does not follow. `icom-relabel` alone cannot catch this, since text can
    // still read the same while the ids diverge. Two members of one bundle
    // are the same object at this level (§3.2.2.3), so the effective ids are
    // what is compared.
    const cc = p.child.arrow.conceptId;
    const pc = p.parent.arrow.conceptId;
    if (cc && pc && effectiveConceptId(m, cc) !== effectiveConceptId(m, pc)) {
      out.push({
        severity: 'warning', code: 'icom-concept-mismatch',
        message: `${child.node}: ${p.code} “${name(p.child.arrow)}” is bound to a different concept than parent box ${node} carries as “${name(p.parent.arrow)}”. The two ends of an ICOM pair should denote the same object (§3.3.2.4).`,
        diagramId: child.id, kind: 'arrow', id: p.child.arrow.id,
      });
    }
    // Two different members of one bundle: the child unbundles the parent's
    // general arrow into a specific one (§3.2.2.3), so their labels differ by
    // design and are not a relabel to question.
    if (cc && pc && cc !== pc && effectiveConceptId(m, cc) === effectiveConceptId(m, pc)) continue;
    if (norm(p.child.arrow.label) === norm(p.parent.arrow.label)) continue;
    out.push({
      severity: 'warning', code: 'icom-relabel',
      message: `${child.node}: ${p.code} reads “${name(p.child.arrow)}” where parent box ${node} carries “${name(p.parent.arrow)}”. Fine if it details that arrow — otherwise the two have drifted apart.`,
      diagramId: child.id, kind: 'arrow', id: p.child.arrow.id,
    });
  }
  for (const o of orphans) {
    out.push({
      severity: 'error', code: 'icom-orphan',
      message: `${child.node}: boundary ${role[o.side]} “${name(o.child.arrow)}” on the ${o.side} has no matching arrow on parent box ${node}. Connect it on ${parentDg.node} or tunnel it.`,
      diagramId: child.id, kind: 'arrow', id: o.child.arrow.id,
    });
  }
  for (const ms of missing) {
    out.push({
      severity: 'error', code: 'icom-missing',
      message: `${parentDg.node}: ${ms.parent.code} “${name(ms.parent.arrow)}” on box ${node} (${ms.side}) does not appear as a boundary arrow on ${child.node}. Add it there or tunnel it.`,
      diagramId: parentDg.id, kind: 'box', id: parent.box.id,
    });
  }
  return out;
}

const NOUNY = /^(the|a|an)\s/i;
function looksLikeVerbPhrase(name) {
  const first = name.trim().split(/\s+/)[0] || '';
  if (NOUNY.test(name)) return false;
  if (/(?:ing|tion|sion|ment|ness|ity|ance|ence)$/i.test(first) && name.trim().split(/\s+/).length === 1) return false;
  return true;
}

export function summarize(issues) {
  return {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
  };
}
