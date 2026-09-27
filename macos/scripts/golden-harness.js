// The scenario edit DSL and per-model snapshot goldens.html uses to build
// golden-scenarios.json — factored out (F88) so tests/web's staleness suite
// (tests/web/goldens-staleness.test.mjs) replays the exact same logic that
// produced the fixture, instead of a second, hand-kept copy that could
// quietly drift from it. A DOM-free ES module: it loads unchanged in
// goldens.html (served over HTTP, real or headless Chrome) and in plain Node.
//
// goldens.html still owns the modules needed only for the batteries this file
// does not compute (geometry, labels, exports, deserialize, …) and still
// posts every fixture itself; this module only holds what both callers need
// byte-for-byte identical: the scenario list, how an op is applied, and how a
// model's diagrams/concepts/issues/file are snapshotted for comparison.

import * as M from '../../src/model/model.js';
import * as G from '../../src/model/geometry.js';
import * as C from '../../src/model/concepts.js';
import * as V from '../../src/model/validate.js';
import * as J from '../../src/io/json.js';

/* ---------------- scenarios, replayed identically by the Swift tests ---------------- */
export const scenarios = [
  { name: 'baseline', ops: [] },
  { name: 'ctx-tunnel', ops: [{ op: 'setArrow', diagram: 'A-0', index: 0, field: 'tunnelFrom', value: true }] },
  { name: 'box-number-range', ops: [{ op: 'setBox', diagram: 'A0', index: 0, field: 'number', value: 9 }] },
  // F10: a resize (or a typed X/Y) moves a box without renumbering, so a
  // stored number can stop matching boxReadingOrder. Ship Product's x/y are
  // written directly here, the way a raw resize leaves them before the
  // canvas re-derives numbers — box-number-order is the safety net.
  { name: 'box-number-order-resize', ops: [
    { op: 'setBox', diagram: 'A0', name: 'Ship Product', field: 'x', value: 20 },
    { op: 'setBox', diagram: 'A0', name: 'Ship Product', field: 'y', value: 20 },
  ] },
  // F10: a hand-placed or imported file can carry numbers that never
  // matched reading order at all — swapping two without moving either box
  // reproduces that without touching layout.
  { name: 'box-number-order-import', ops: [
    { op: 'setBox', diagram: 'A0', name: 'Plan Production', field: 'number', value: 4 },
    { op: 'setBox', diagram: 'A0', name: 'Ship Product', field: 'number', value: 1 },
  ] },
  { name: 'relabel', ops: [{ op: 'setArrow', diagram: 'A0', label: 'Customer Order', field: 'label', value: 'Customer Records' }] },
  { name: 'orphan', ops: [{ op: 'addArrow', diagram: 'A0', id: 'ar_fxorphan', label: 'Mystery Input', from: { type: 'boundary', side: 'left', pos: 0.95 }, to: { type: 'box', box: 'Plan Production', side: 'left', pos: 0.9 } }] },
  { name: 'missing', ops: [{ op: 'removeArrow', diagram: 'A0', label: 'Quality Standards' }] },
  { name: 'swap-controls', ops: [{ op: 'swapPos', diagram: 'A-0', labels: ['Production Schedule', 'Quality Standards'], end: 'to' }] },
  { name: 'feedback', ops: [
    { op: 'addArrow', diagram: 'A0', id: 'ar_fxfb1', label: 'Rework', from: { type: 'box', box: 'Ship Product', side: 'right', pos: 0.2 }, to: { type: 'box', box: 'Plan Production', side: 'left', pos: 0.8 } },
    { op: 'addArrow', diagram: 'A0', id: 'ar_fxfb2', label: 'Defect Report', from: { type: 'box', box: 'Assemble Product', side: 'right', pos: 0.2 }, to: { type: 'box', box: 'Fabricate Components', side: 'top', pos: 0.6 } },
    { op: 'addArrow', diagram: 'A0', id: 'ar_fxfb3', label: 'Returned Tooling', from: { type: 'box', box: 'Ship Product', side: 'right', pos: 0.1 }, to: { type: 'box', box: 'Fabricate Components', side: 'bottom', pos: 0.8 } },
    { op: 'addArrow', diagram: 'A0', id: 'ar_fxbent', label: 'Pinned', from: { type: 'box', box: 'Plan Production', side: 'right', pos: 0.3 }, to: { type: 'box', box: 'Ship Product', side: 'left', pos: 0.3 }, bend: 640 },
  ] },
  { name: 'tunnelled-boundary', ops: [{ op: 'setArrow', diagram: 'A0', label: 'Raw Materials', field: 'tunnelFrom', value: true }] },
  { name: 'seven-boxes', ops: [
    { op: 'pushBox', diagram: 'A0', id: 'bx_fx5', name: 'Inspect Parts', number: 5, x: 820, y: 170, w: 150, h: 90 },
    { op: 'pushBox', diagram: 'A0', id: 'bx_fx6', name: 'Store Stock', number: 6, x: 110, y: 560, w: 150, h: 90 },
    { op: 'pushBox', diagram: 'A0', id: 'bx_fx7', name: 'Scrap Waste', number: 7, x: 620, y: 600, w: 150, h: 90 },
    { op: 'renumberBoxes', diagram: 'A0' }, { op: 'renumberNodes' },
  ] },
  { name: 'unnamed-and-verb', ops: [
    { op: 'setBox', diagram: 'A0', name: 'Ship Product', field: 'name', value: 'The Shipping' },
    { op: 'pushBox', diagram: 'A0', id: 'bx_fxunnamed', name: '', number: 5, x: 700, y: 150, w: 120, h: 80 },
  ] },
  { name: 'decompose', ops: [
    { op: 'decompose', diagram: 'A0', name: 'Plan Production', count: 3 },
    { op: 'decompose', diagram: 'A0', name: 'Fabricate Components', count: 6 },
  ] },
  { name: 'rename-merge', ops: [
    { op: 'renameConcept', from: 'Work Order', to: 'Job Ticket' },
    { op: 'renameConcept', from: 'Components', to: 'Assembled Product' },
  ] },
  // F15: renaming Work Order (defined) onto Components (undefined, since
  // this merges) carries the definition to the survivor rather than
  // losing it.
  { name: 'merge-keeps-definition', ops: [{ op: 'renameConcept', from: 'Work Order', to: 'Components' }] },
  { name: 'unbound', ops: [{ op: 'setArrow', diagram: 'A0', label: 'Components', field: 'conceptId', value: 'gl_doesnotexist' }] },
  // F11 rule 4: a child boundary arrow relabelled away from its parent's
  // label (§3.3.2.4 elaboration) keeps the concept it shares with its ICOM
  // counterpart on A-0 and shows up as drift, rather than rebinding.
  { name: 'relabel-keeps-concept-on-drift', ops: [
    { op: 'relabelArrow', diagram: 'A0', label: 'Raw Materials', value: 'Raw Materials (Steel Stock)' },
  ] },
  // F11 rules 5, 3 and 1, in turn: a typo fix on a sole, undefined concept
  // renames it in place; relabelling onto an existing term rebinds to it;
  // clearing the name unbinds.
  { name: 'relabel-rename-in-place', ops: [
    { op: 'relabelBox', diagram: 'A0', name: 'Ship Product', value: 'Ship Products' },
    { op: 'relabelBox', diagram: 'A0', name: 'Ship Products', value: 'Plan Production' },
  ] },
  // F11 rule 2: a hand-edit points one side of an ICOM pair at a different
  // concept while the label text still reads the same, so icom-relabel
  // cannot catch it — icom-concept-mismatch does.
  { name: 'icom-concept-mismatch', ops: [
    { op: 'setArrow', diagram: 'A0', label: 'Customer Order', field: 'conceptId', value: 'gl2' },
  ] },
  // F14: a hand-edit renames a box and gives it a conceptId no glossary
  // entry defines; bindAll restores a concept under that orphan id rather
  // than discarding it.
  { name: 'orphan-restore', ops: [
    { op: 'setBox', diagram: 'A0', name: 'Ship Product', field: 'name', value: 'Package Product' },
    { op: 'setBox', diagram: 'A0', name: 'Package Product', field: 'conceptId', value: 'ext_ontology_1' },
    { op: 'bindAll' },
  ] },
  // F14: an orphan conceptId whose text already names a different concept
  // is left alone (so 'concept-unbound' reports the clash) rather than
  // silently rewritten onto that concept.
  { name: 'orphan-collision', ops: [
    { op: 'setArrow', diagram: 'A0', label: 'Components', field: 'conceptId', value: 'ext_ontology_2' },
    { op: 'bindAll' },
  ] },
  { name: 'remove-box', ops: [{ op: 'removeBox', diagram: 'A0', name: 'Assemble Product' }] },
  // S01: a box is never placed by hand — addBox appends number n+1 and lays
  // the diagram out along the staircase (here, six boxes on A0).
  { name: 'add-box', ops: [{ op: 'addBox', diagram: 'A0' }, { op: 'addBox', diagram: 'A0' }] },
  // FIPS 183 §3.3.2.10: a call arrow leaving a box bottom is no boundary
  // mechanism of the parent — it pairs with nothing and takes no code,
  // whether the parent has mechanisms or not, and it cannot take the code
  // of a mechanism the child elaborates (relabelled, rebound) to its right.
  { name: 'call-seeded', ops: [
    { op: 'addArrow', diagram: 'A0', id: 'ar_fxcall', label: 'OTHER/A22', from: { type: 'box', box: 'Ship Product', side: 'bottom', pos: 0.5 }, to: { type: 'boundary', side: 'bottom', pos: 0.8 } },
  ] },
  { name: 'call-no-mechanism', ops: [
    { op: 'removeArrow', diagram: 'A-0', label: 'Plant Equipment' },
    { op: 'removeArrow', diagram: 'A-0', label: 'Production Staff' },
    { op: 'removeArrow', diagram: 'A0', label: 'Plant Equipment' },
    { op: 'removeArrow', diagram: 'A0', label: 'Production Staff' },
    { op: 'addArrow', diagram: 'A0', id: 'ar_fxcall', label: 'OTHER/A22', from: { type: 'box', box: 'Ship Product', side: 'bottom', pos: 0.5 }, to: { type: 'boundary', side: 'bottom', pos: 0.8 } },
  ] },
  { name: 'call-left-of-mechanism', ops: [
    { op: 'setArrow', diagram: 'A0', label: 'Plant Equipment', field: 'conceptId', value: null },
    { op: 'setArrow', diagram: 'A0', label: 'Plant Equipment', field: 'label', value: 'Machine Tools' },
    { op: 'addArrow', diagram: 'A0', id: 'ar_fxcall', label: 'SUPPLIER/A2', from: { type: 'box', box: 'Plan Production', side: 'bottom', pos: 0.5 }, to: { type: 'boundary', side: 'bottom', pos: 0.2 } },
  ] },
  // FIPS 183 §3.3.2.9, Figure 18: a control tunnelled where it meets the box
  // keeps its code and is left off the child — the child shows C1 and C3.
  { name: 'tunnel-at-box', ops: [
    { op: 'addArrow', diagram: 'A0', id: 'ar_fxtun', label: 'Tooling Plan', from: { type: 'box', box: 'Plan Production', side: 'right', pos: 0.6 }, to: { type: 'box', box: 'Fabricate Components', side: 'top', pos: 0.5 } },
    { op: 'setArrow', diagram: 'A0', label: 'Tooling Plan', field: 'tunnelTo', value: true },
    { op: 'decompose', diagram: 'A0', name: 'Fabricate Components', count: 3 },
  ] },
  // FIPS 183 §3.3.2.7–8: a boundary end running the wrong way — an output
  // to the left edge, an input from the right edge — takes no code.
  { name: 'reversed-boundary', ops: [
    { op: 'setEnd', diagram: 'A0', label: 'Raw Materials', end: 'from', value: { type: 'box', box: 'Fabricate Components', side: 'right', pos: 0.3 } },
    { op: 'setEnd', diagram: 'A0', label: 'Raw Materials', end: 'to', value: { type: 'boundary', side: 'left', pos: 0.45 } },
    { op: 'setEnd', diagram: 'A0', label: 'Shipping Notice', end: 'from', value: { type: 'boundary', side: 'right', pos: 0.88 } },
    { op: 'setEnd', diagram: 'A0', label: 'Shipping Notice', end: 'to', value: { type: 'box', box: 'Ship Product', side: 'left', pos: 0.7 } },
  ] },
  // FIPS 183 §3.3.3 rule 11, §3.2.2.3 rule 2e and §3.3.2.10: at most one call
  // arrow per box, ending unconnected, on a box that is not decomposed.
  { name: 'two-calls', ops: [
    { op: 'addArrow', diagram: 'A0', id: 'ar_fxcall1', label: 'SUPPLIER/A23.2', from: { type: 'box', box: 'Assemble Product', side: 'bottom', pos: 0.3 }, to: { type: 'boundary', side: 'bottom', pos: 0.5 } },
    { op: 'addArrow', diagram: 'A0', id: 'ar_fxcall2', label: 'VENDOR/A4.1', from: { type: 'box', box: 'Assemble Product', side: 'bottom', pos: 0.7 }, to: { type: 'boundary', side: 'bottom', pos: 0.55 } },
  ] },
  { name: 'call-into-box', ops: [
    { op: 'addArrow', diagram: 'A0', id: 'ar_fxcall', label: 'Scrap', from: { type: 'box', box: 'Fabricate Components', side: 'bottom', pos: 0.8 }, to: { type: 'box', box: 'Ship Product', side: 'left', pos: 0.7 } },
  ] },
  { name: 'call-decomposed', ops: [
    { op: 'addArrow', diagram: 'A0', id: 'ar_fxcall', label: 'OTHER/A3', from: { type: 'box', box: 'Plan Production', side: 'bottom', pos: 0.5 }, to: { type: 'boundary', side: 'bottom', pos: 0.15 } },
    { op: 'decompose', diagram: 'A0', name: 'Plan Production', count: 3 },
  ] },
  // FIPS 183 §3.3.3 rule 15 and §3.2.2.3 rule 5: names and labels that are
  // solely a reserved word; a phrase holding one ("Process Control") is fine.
  { name: 'reserved-terms', ops: [
    { op: 'setBox', diagram: 'A0', name: 'Ship Product', field: 'name', value: 'Process' },
    { op: 'setBox', diagram: 'A0', name: 'Assemble Product', field: 'name', value: 'Activity' },
    { op: 'setBox', diagram: 'A0', name: 'Fabricate Components', field: 'name', value: 'Process Control' },
    { op: 'setArrow', diagram: 'A0', label: 'Components', field: 'label', value: 'Output' },
    { op: 'setArrow', diagram: 'A0', label: 'Assembled Product', field: 'label', value: 'CALL' },
  ] },
  // FIPS 183 §3.3.3 rule 14: a fork or join drawn as separate arrows sharing
  // a concept connects at one ICOM position. A child that feeds I1 to two
  // boxes pairs both ends with I1; a parent that forks a control into two
  // arrows on the box top gives both one code, and the child's one boundary
  // arrow for it leaves nothing missing.
  { name: 'fork-join', ops: [
    { op: 'addArrow', diagram: 'A0', id: 'ar_fxfork', label: 'Order Copy', from: { type: 'boundary', side: 'left', pos: 0.3 }, to: { type: 'box', box: 'Fabricate Components', side: 'left', pos: 0.25 } },
    { op: 'setArrow', diagram: 'A0', label: 'Order Copy', field: 'conceptId', value: 'gl1' },
    { op: 'setArrow', diagram: 'A0', label: 'Order Copy', field: 'label', value: 'Customer Order' },
    { op: 'addArrow', diagram: 'A-0', id: 'ar_fxqs', label: 'Standards Copy', from: { type: 'boundary', side: 'top', pos: 0.85 }, to: { type: 'box', box: 'Manufacture Product', side: 'top', pos: 0.88 } },
    { op: 'setArrow', diagram: 'A-0', label: 'Standards Copy', field: 'conceptId', value: 'gl3' },
    { op: 'setArrow', diagram: 'A-0', label: 'Standards Copy', field: 'label', value: 'Quality Standards' },
  ] },
  // S02: forks and joins drawn as one line that branches (FIPS 183 §3.3.2.2,
  // Figure 6). The sample's three Work Orders already fork off Plan
  // Production's right side; here two same-concept outputs — Inspection
  // Report, bound by bindAll — join at Ship Product's top, and a copy of
  // Customer Order forks off the left edge into Fabricate Components. The
  // codes and pairing are rule 14's (one code per group, numbered by the
  // lowest position); the drawing is golden-render.json's 'render-fork-join'.
  { name: 'fork-join-drawn', ops: [
    { op: 'addArrow', diagram: 'A0', id: 'ar_fxjoin1', label: 'Inspection Report', from: { type: 'box', box: 'Fabricate Components', side: 'right', pos: 0.8 }, to: { type: 'box', box: 'Ship Product', side: 'top', pos: 0.75 } },
    { op: 'addArrow', diagram: 'A0', id: 'ar_fxjoin2', label: 'Inspection Report', from: { type: 'box', box: 'Assemble Product', side: 'right', pos: 0.8 }, to: { type: 'box', box: 'Ship Product', side: 'top', pos: 0.6 } },
    { op: 'bindAll' },
    { op: 'addArrow', diagram: 'A0', id: 'ar_fxfork', label: 'Order Copy', from: { type: 'boundary', side: 'left', pos: 0.3 }, to: { type: 'box', box: 'Fabricate Components', side: 'left', pos: 0.25 } },
    { op: 'setArrow', diagram: 'A0', label: 'Order Copy', field: 'conceptId', value: 'gl1' },
    { op: 'setArrow', diagram: 'A0', label: 'Order Copy', field: 'label', value: 'Customer Order' },
  ] },
  // FIPS 183 §3.3.2.8, Figure 15: roles may differ between parent and child.
  // A parent control entering the child from the left keeps its code (C1),
  // and a further input of the same concept shares a control's code.
  { name: 'role-change', ops: [
    { op: 'setEnd', diagram: 'A0', label: 'Production Schedule', end: 'from', value: { type: 'boundary', side: 'left', pos: 0.08 } },
    { op: 'setEnd', diagram: 'A0', label: 'Production Schedule', end: 'to', value: { type: 'box', box: 'Plan Production', side: 'left', pos: 0.2 } },
    { op: 'addArrow', diagram: 'A0', id: 'ar_fxqsin', label: 'Standards Sheet', from: { type: 'boundary', side: 'left', pos: 0.7 }, to: { type: 'box', box: 'Assemble Product', side: 'left', pos: 0.75 } },
    { op: 'setArrow', diagram: 'A0', label: 'Standards Sheet', field: 'conceptId', value: 'gl3' },
  ] },
  // FIPS 183 §3.2.2: a box denotes a function and an arrow an object, so a
  // box bound to a data or mechanism concept, or an arrow bound to an
  // activity, is flagged.
  { name: 'concept-kind', ops: [
    { op: 'setBox', diagram: 'A0', name: 'Ship Product', field: 'conceptId', value: 'gl2' },
    { op: 'setBox', diagram: 'A0', name: 'Assemble Product', field: 'conceptId', value: 'gl4' },
    { op: 'renameConcept', from: 'Customer Order', to: 'Plan Production' },
  ] },
  // Referential integrity: duplicated ids, a detail link to no diagram, a
  // diagram two boxes name, and a diagram no box names any more.
  { name: 'structure', ops: [
    { op: 'setArrow', diagram: 'A0', label: 'Components', field: 'id', value: 'ar_fxdup' },
    { op: 'setArrow', diagram: 'A0', label: 'Assembled Product', field: 'id', value: 'ar_fxdup' },
    { op: 'pushBox', diagram: 'A0', id: 'bx_fxdup', name: 'Inspect Parts', number: 5, x: 820, y: 170, w: 150, h: 90 },
    { op: 'pushBox', diagram: 'A0', id: 'bx_fxdup', name: 'Store Stock', number: 6, x: 110, y: 560, w: 150, h: 90 },
    { op: 'setBox', diagram: 'A0', name: 'Ship Product', field: 'childDiagramId', value: 'dg_fxmissing' },
    { op: 'decompose', diagram: 'A0', name: 'Plan Production', count: 3 },
    { op: 'setBox', diagram: 'A0', name: 'Plan Production', field: 'childDiagramId', value: null },
    { op: 'decompose', diagram: 'A0', name: 'Fabricate Components', count: 3 },
    { op: 'setBox', diagram: 'A0', name: 'Assemble Product', field: 'childDiagramId', valueNode: 'A2' },
  ] },
  // A decomposition cycle — a box detailed by its own diagram, by an
  // ancestor, by A-0 — is reported, and every walk of the tree ends.
  { name: 'decomp-cycle', ops: [
    { op: 'decompose', diagram: 'A0', name: 'Assemble Product', count: 3 },
    { op: 'setBox', diagram: 'A3', index: 0, field: 'childDiagramId', valueNode: 'A0' },
    { op: 'setBox', diagram: 'A3', index: 1, field: 'childDiagramId', valueNode: 'A-0' },
    { op: 'setBox', diagram: 'A0', name: 'Ship Product', field: 'childDiagramId', valueNode: 'A0' },
    { op: 'addBox', diagram: 'A3', at: null },
    { op: 'renumberNodes' },
  ] },
  { name: 'cycle-delete', ops: [
    { op: 'decompose', diagram: 'A0', name: 'Assemble Product', count: 3 },
    { op: 'setBox', diagram: 'A3', index: 0, field: 'childDiagramId', valueNode: 'A0' },
    { op: 'removeBox', diagram: 'A0', name: 'Assemble Product' },
  ] },
  // F85: removeBox on a decomposed box walks and deletes the whole subtree
  // (model.js's deleteSubtreeWalk) — untested until now, since every other
  // 'removeBox' scenario above targets a leaf. Decomposing twice (A0 and
  // then a box of the new A3) leaves 2 diagrams behind after the box at the
  // top of that chain is removed.
  { name: 'remove-decomposed', ops: [
    { op: 'decompose', diagram: 'A0', name: 'Plan Production', count: 3 },
    { op: 'decompose', diagram: 'A1', index: 0, count: 3 },
    { op: 'removeBox', diagram: 'A0', name: 'Plan Production' },
  ] },
  // F85: the inspector's "Delete decomposition" button (panels.js:310) calls
  // deleteSubtree directly, on the child diagram itself rather than through
  // removeBox — recursing the same way but leaving the parent box in place,
  // unhooked. Same decomposition shape as 'remove-decomposed' so the two
  // fixtures are easy to compare.
  { name: 'delete-decomposition', ops: [
    { op: 'decompose', diagram: 'A0', name: 'Plan Production', count: 3 },
    { op: 'decompose', diagram: 'A1', index: 0, count: 3 },
    { op: 'deleteSubtree', diagram: 'A1' },
  ] },
  /* ---- S01: structured editing — bundles, ports and auto-layout ---- */
  // FIPS 183 §3.2.2.3 bundling: two inputs combined into one bundle. On A-0
  // the top box's two left arrows now share one ICOM position (I1), and on
  // A0 both boundary arrows pair with it by their effective concept; the
  // second member is an unbundled specific, not a relabel to question.
  { name: 'combine', ops: [{ op: 'combine', members: ['Customer Order', 'Raw Materials'], term: 'Inputs' }] },
  // Bundles nest: the outer bundle is every member's effective concept, and
  // it spans the top box's left (I1, both inputs) and top (C1) sides.
  { name: 'combine-nested', ops: [
    { op: 'combine', members: ['Customer Order', 'Raw Materials'], term: 'Inputs' },
    { op: 'combine', members: ['Inputs', 'Production Schedule'], term: 'Planning Inputs' },
  ] },
  // Un-combining is lossless: the glossary and every code read as the
  // baseline again (the bundle's own id was fresh, so nothing else moved).
  { name: 'uncombine', ops: [
    { op: 'combine', members: ['Customer Order', 'Raw Materials'], term: 'Inputs' },
    { op: 'uncombine', term: 'Inputs' },
  ] },
  // Un-combining a bundle something denotes keeps it: the child's arrow was
  // drawn from the bundle's port, so it is bound to the bundle id itself.
  // The entry stays as a plain concept (no members) rather than leaving that
  // arrow dangling; the members stand on their own, and the child's arrow no
  // longer pairs with the parent's I1 (an orphan, and the port is back).
  { name: 'uncombine-used', ops: [
    { op: 'combine', members: ['Customer Order', 'Raw Materials'], term: 'Inputs' },
    { op: 'decompose', diagram: 'A0', name: 'Plan Production', count: 3 },
    { op: 'connectPort', diagram: 'A1', code: 'I1', id: 'ar_fxport1', index: 0, side: 'left', pos: 0.5 },
    { op: 'uncombine', term: 'Inputs' },
  ] },
  // Un-combining an inner bundle splices its members into the outer list at
  // its own position, in order.
  { name: 'uncombine-nested', ops: [
    { op: 'combine', members: ['Customer Order', 'Raw Materials'], term: 'Inputs' },
    { op: 'combine', members: ['Inputs', 'Production Schedule'], term: 'Planning Inputs' },
    { op: 'uncombine', term: 'Inputs' },
  ] },
  // Refusals leave the model as it was: a member already in a bundle, a
  // single member, an unknown concept, and un-combining a plain concept.
  { name: 'combine-refused', ops: [
    { op: 'combine', members: ['Customer Order', 'Raw Materials'], term: 'Inputs' },
    { op: 'combine', members: ['Customer Order', 'Work Order'], term: 'Refused' },
    { op: 'combine', members: ['Work Order'], term: 'Solo' },
    { op: 'combine', members: ['Work Order', 'No Such Concept'], term: 'Unknown' },
    { op: 'combine', members: ['Work Order', 'Work Order'], term: 'Twice' },
    { op: 'uncombine', term: 'Work Order' },
  ] },
  // removeConcept of a member drops it from its bundle's list and leaves its
  // arrows unbound, as deleting a concept always has. The bundle's kind is
  // derived from every member's at creation, so a mechanism among data
  // members makes it 'other' and, once combined, bundle-mixed-kind.
  { name: 'remove-member', ops: [
    { op: 'combine', members: ['Customer Order', 'Raw Materials', 'Plant Equipment'], term: 'Inputs' },
    { op: 'removeConcept', term: 'Raw Materials' },
  ] },
  // removeConcept of a bundle un-combines it: the inner bundle's members
  // take its place in the outer one.
  { name: 'remove-bundle', ops: [
    { op: 'combine', members: ['Customer Order', 'Raw Materials'], term: 'Inputs' },
    { op: 'combine', members: ['Inputs', 'Production Schedule'], term: 'Planning Inputs' },
    { op: 'removeConcept', term: 'Inputs' },
  ] },
  // A rename that merges rewrites every members list fromId→intoId,
  // de-duplicated: the bundle is left with one member, and says so.
  { name: 'merge-rewrites-members', ops: [
    { op: 'combine', members: ['Customer Order', 'Raw Materials'], term: 'Inputs' },
    { op: 'renameConcept', from: 'Raw Materials', to: 'Customer Order' },
  ] },
  // A bundle may not be merged into its own member: the rename is refused
  // and nothing changes.
  { name: 'merge-into-member-refused', ops: [
    { op: 'combine', members: ['Customer Order', 'Raw Materials'], term: 'Inputs' },
    { op: 'renameConcept', from: 'Inputs', to: 'Customer Order' },
  ] },
  // Members of two different bundles cannot be merged into one concept: the
  // survivor would sit in both bundles. The rename is refused and nothing moves.
  { name: 'merge-across-bundles-refused', ops: [
    { op: 'combine', members: ['Customer Order', 'Raw Materials'], term: 'Inputs' },
    { op: 'combine', members: ['Production Schedule', 'Quality Standards'], term: 'Controls' },
    { op: 'renameConcept', from: 'Raw Materials', to: 'Quality Standards' },
  ] },
  // A bundled parent ICOM entry is one port carrying the bundle's term and
  // id: with both member arrows removed from A0, the parent's I1 (the bundle)
  // is missing and its port names "Inputs", not the first member.
  { name: 'bundle-port', ops: [
    { op: 'combine', members: ['Customer Order', 'Raw Materials'], term: 'Inputs' },
    { op: 'removeArrow', diagram: 'A0', label: 'Customer Order' },
    { op: 'removeArrow', diagram: 'A0', label: 'Raw Materials' },
  ] },
  // A member merged into its own bundle is absorbed by it: its arrows now
  // carry the bundle's id and it leaves the list rather than making the
  // bundle contain itself.
  { name: 'merge-member-into-bundle', ops: [
    { op: 'combine', members: ['Customer Order', 'Raw Materials'], term: 'Inputs' },
    { op: 'renameConcept', from: 'Customer Order', to: 'Inputs' },
  ] },
  // A bundle merged into a plain concept stays a bundle under the survivor's
  // id: the members are inherited rather than orphaned.
  { name: 'merge-bundle-into-plain', ops: [
    { op: 'combine', members: ['Customer Order', 'Raw Materials'], term: 'Inputs' },
    { op: 'renameConcept', from: 'Inputs', to: 'Components' },
  ] },
  // Decomposing seeds no arrows: the child starts with one port per parent
  // ICOM entry (I1, C1 and the three Work Orders' single O1), each still an
  // icom-missing error until it is connected.
  { name: 'decompose-ports', ops: [{ op: 'decompose', diagram: 'A0', name: 'Plan Production', count: 3 }] },
  // Connecting a port draws an arrow from its boundary endpoint carrying its
  // concept and label (an O port's box side is the `from` end); the port
  // goes and the pair takes its code. Disconnecting brings the port back.
  { name: 'connect-port', ops: [
    { op: 'decompose', diagram: 'A0', name: 'Plan Production', count: 3 },
    { op: 'connectPort', diagram: 'A1', code: 'I1', id: 'ar_fxport1', index: 0, side: 'left', pos: 0.5 },
    { op: 'connectPort', diagram: 'A1', code: 'O1', id: 'ar_fxport2', index: 2, side: 'right', pos: 0.5 },
  ] },
  { name: 'disconnect-port', ops: [
    { op: 'decompose', diagram: 'A0', name: 'Plan Production', count: 3 },
    { op: 'connectPort', diagram: 'A1', code: 'I1', id: 'ar_fxport1', index: 0, side: 'left', pos: 0.5 },
    { op: 'connectPort', diagram: 'A1', code: 'O1', id: 'ar_fxport2', index: 2, side: 'right', pos: 0.5 },
    { op: 'removeArrow', diagram: 'A1', label: 'Customer Order' },
  ] },
  // Adding boxes to a child re-lays the staircase for five, numbered 1..5;
  // laying out A-0 leaves its single box where it is.
  { name: 'add-box-layout', ops: [
    { op: 'decompose', diagram: 'A0', name: 'Plan Production', count: 3 },
    { op: 'addBox', diagram: 'A1' },
    { op: 'addBox', diagram: 'A1' },
    { op: 'layout', diagram: 'A-0' },
  ] },
  // Removing a box compacts the numbers to 1..4 in the surviving order and
  // re-lays the staircase for four.
  { name: 'remove-box-layout', ops: [
    { op: 'decompose', diagram: 'A0', name: 'Fabricate Components', count: 5 },
    { op: 'removeBox', diagram: 'A2', index: 1 },
  ] },
  // moveBox swaps a box with its neighbour in number order and re-lays the
  // staircase; the first box cannot move earlier nor the last later.
  { name: 'move-box', ops: [
    { op: 'moveBox', diagram: 'A0', name: 'Ship Product', by: -1 },
    { op: 'moveBox', diagram: 'A0', name: 'Plan Production', by: -1 },
    { op: 'moveBox', diagram: 'A0', name: 'Assemble Product', by: 1 },
  ] },
  // The per-element clocks (src/io/json.js): set on a diagram, a box, an
  // arrow and a concept, each in a different ISO-8601 zone form, they are
  // written after everything else the element models and nothing complains.
  { name: 'clocks', ops: [
    { op: 'setDiagram', diagram: 'A0', field: 'updatedAt', value: '2026-09-25T11:30:00.500+02:00' },
    { op: 'setBox', diagram: 'A0', name: 'Plan Production', field: 'updatedAt', value: '2026-09-26T09:15:00Z' },
    { op: 'setBox', diagram: 'A0', name: 'Ship Product', field: 'deletedAt', value: '2026-09-26T10:00:00Z' },
    { op: 'setArrow', diagram: 'A0', label: 'Customer Order', field: 'updatedAt', value: '2026-09-26T09:20:00Z' },
    { op: 'setArrow', diagram: 'A0', label: 'Customer Order', field: 'deletedAt', value: '2026-09-26T09:21:00Z' },
    { op: 'setConcept', term: 'Components', field: 'updatedAt', value: '2026-09-24T08:00:00+00:00' },
  ] },
  // A clock that is not an ISO-8601 instant: a word, an instant with no zone
  // at all, a day February never has, and an hour past 23 — one
  // provenance-date error each, whichever element carries it.
  { name: 'clocks-unreadable', ops: [
    { op: 'setBox', diagram: 'A0', name: 'Plan Production', field: 'updatedAt', value: 'yesterday' },
    { op: 'setArrow', diagram: 'A0', label: 'Raw Materials', field: 'deletedAt', value: '2026-09-26T09:15:00' },
    { op: 'setConcept', term: 'Components', field: 'deletedAt', value: '2026-02-30T00:00:00Z' },
    { op: 'setDiagram', diagram: 'A-0', field: 'updatedAt', value: '2026-09-26T24:00:00Z' },
  ] },
  // A tombstone earlier than the change it ends — once by a millisecond, and
  // once only after both zones are applied, which is what the clocks are
  // ordered by.
  { name: 'clocks-out-of-order', ops: [
    { op: 'setArrow', diagram: 'A0', label: 'Customer Order', field: 'updatedAt', value: '2026-09-26T09:20:00Z' },
    { op: 'setArrow', diagram: 'A0', label: 'Customer Order', field: 'deletedAt', value: '2026-09-26T09:19:59.999Z' },
    { op: 'setConcept', term: 'Components', field: 'updatedAt', value: '2026-09-26T12:00:00+02:00' },
    { op: 'setConcept', term: 'Components', field: 'deletedAt', value: '2026-09-26T09:59:00Z' },
  ] },
  // An empty or null clock is unset: no member is written, so the file is the
  // baseline's byte for byte and the checker has nothing to say.
  { name: 'clocks-unset', ops: [
    { op: 'setDiagram', diagram: 'A0', field: 'deletedAt', value: null },
    { op: 'setBox', diagram: 'A0', name: 'Plan Production', field: 'updatedAt', value: '' },
    { op: 'setArrow', diagram: 'A0', label: 'Customer Order', field: 'deletedAt', value: null },
    { op: 'setConcept', term: 'Components', field: 'updatedAt', value: '' },
  ] },
  // An explicit Arrange puts hand-placed (or imported) boxes back on the
  // staircase in their number order without touching the numbers.
  { name: 'arrange', ops: [
    { op: 'setBox', diagram: 'A0', name: 'Ship Product', field: 'x', value: 20 },
    { op: 'setBox', diagram: 'A0', name: 'Ship Product', field: 'y', value: 20 },
    { op: 'layout', diagram: 'A0' },
  ] },
];

export const byNode = (m, node) => Object.values(m.diagrams).find((d) => d.node === node);
export const boxByName = (dg, name) => dg.boxes.find((b) => b.name === name);
export const arrowByLabel = (dg, label) => dg.arrows.find((a) => a.label === label);
const resolveEnd = (dg, e) => (e.type === 'box'
  ? { type: 'box', boxId: boxByName(dg, e.box).id, side: e.side, pos: e.pos }
  : { type: 'boundary', side: e.side, pos: e.pos });

export const apply = (m, op) => {
  const dg = op.diagram ? byNode(m, op.diagram) : null;
  switch (op.op) {
    case 'setArrow': { const a = op.label != null ? arrowByLabel(dg, op.label) : dg.arrows[op.index]; a[op.field] = op.value; break; }
    case 'setEnd': { const a = op.label != null ? arrowByLabel(dg, op.label) : dg.arrows[op.index]; a[op.end] = resolveEnd(dg, op.value); break; }
    case 'setBox': { const b = op.name != null ? boxByName(dg, op.name) : dg.boxes[op.index]; b[op.field] = op.valueNode != null ? byNode(m, op.valueNode).id : op.value; break; }
    case 'removeArrow': M.removeArrow(dg, arrowByLabel(dg, op.label).id); break;
    case 'addArrow': dg.arrows.push({ id: op.id, label: op.label, conceptId: null, from: resolveEnd(dg, op.from), to: resolveEnd(dg, op.to), bend: op.bend ?? null, ldx: 0, ldy: 0, tunnelFrom: false, tunnelTo: false, note: '' }); break;
    case 'swapPos': { const [p, q] = op.labels.map((l) => arrowByLabel(dg, l)); const t = p[op.end].pos; p[op.end].pos = q[op.end].pos; q[op.end].pos = t; break; }
    case 'pushBox': dg.boxes.push({ id: op.id, name: op.name, number: op.number, conceptId: null, x: op.x, y: op.y, w: op.w, h: op.h, childDiagramId: null, note: '', refs: '' }); break;
    // S05: a diagram's or a concept's own field, the way setBox/setArrow write
    // a box's or an arrow's — the only way to reach the per-element clocks
    // those two carry.
    case 'setDiagram': dg[op.field] = op.value; break;
    case 'setConcept': C.findConcept(m, op.term)[op.field] = op.value; break;
    case 'renumberBoxes': M.renumberBoxes(dg); break;
    case 'renumberNodes': M.renumberNodes(m); break;
    // F85: a child diagram's staircase boxes are unnamed, so decompose (like
    // setBox/setArrow already do) falls back to addressing one by index.
    case 'decompose': M.decomposeBox(m, dg, op.name != null ? boxByName(dg, op.name) : dg.boxes[op.index], op.count); break;
    case 'renameConcept': C.renameConcept(m, C.findConcept(m, op.from).id, op.to); break;
    // S01: like decompose, a child's unnamed boxes are addressed by index.
    case 'removeBox': M.removeBox(m, dg, (op.name != null ? boxByName(dg, op.name) : dg.boxes[op.index]).id); break;
    // F85: deleteSubtree(m, diagramId) — the inspector's "Delete
    // decomposition" button (panels.js:310), called on the child diagram
    // directly rather than through removeBox.
    case 'deleteSubtree': M.deleteSubtree(m, dg.id); break;
    // S01: addBox takes no position — the staircase decides.
    case 'addBox': M.addBox(m, dg); break;
    // S01: a term that names no concept is passed through as an unknown id,
    // which combineConcepts refuses; a refused combine/uncombine returns
    // null and the scenario carries on, as the web app would.
    case 'combine': C.combineConcepts(m, op.members.map((t) => C.findConcept(m, t)?.id ?? t), op.term); break;
    case 'uncombine': C.uncombineConcept(m, C.findConcept(m, op.term).id); break;
    case 'removeConcept': C.removeConcept(m, C.findConcept(m, op.term).id); break;
    case 'moveBox': M.moveBox(m, dg, (op.name != null ? boxByName(dg, op.name) : dg.boxes[op.index]).id, op.by); break;
    case 'layout': M.layoutBoxes(dg); break;
    // S01: the port with ICOM code `op.code` on `dg` is connected to the
    // box at `op.index`, on `op.side` at `op.pos` — what the canvas does
    // when a port is dragged onto a box side: an arrow from the port's
    // boundary endpoint carrying the port's conceptId and label, the box
    // side being the `from` end for an O port and the `to` end otherwise.
    case 'connectPort': {
      const port = M.ports(m, dg).find((p) => p.code === op.code);
      if (!port) throw new Error(`no port ${op.code} on ${op.diagram}`);
      const box = dg.boxes[op.index];
      const edge = { type: 'boundary', side: port.side, pos: port.pos };
      const at = { type: 'box', boxId: box.id, side: op.side, pos: op.pos };
      const [from, to] = port.role === 'output' ? [at, edge] : [edge, at];
      dg.arrows.push({ id: op.id, label: port.label, conceptId: port.conceptId, from, to, bend: null, ldx: 0, ldy: 0, tunnelFrom: false, tunnelTo: false, note: '' });
      break;
    }
    // F11: an edit to a box's name or an arrow's label, as opposed to
    // 'setBox'/'setArrow' which write the field directly with no binding.
    case 'relabelBox': { const b = op.name != null ? boxByName(dg, op.name) : dg.boxes[op.index]; C.relabelBox(m, dg, b, op.value); break; }
    case 'relabelArrow': { const a = op.label != null ? arrowByLabel(dg, op.label) : dg.arrows[op.index]; C.relabelArrow(m, dg, a, op.value); break; }
    // F14: re-run the load-time binding pass after a scenario has hand-set
    // a dangling or colliding conceptId, so its orphan-handling rules apply.
    case 'bindAll': C.bindAll(m); break;
    default: throw new Error('unknown op ' + op.op);
  }
};

/* ---------------- generated ids become new1, new2… ---------------- */
const EXTRA_FIXED_IDS = [
  'ar_fxorphan', 'ar_fxfb1', 'ar_fxfb2', 'ar_fxfb3', 'ar_fxbent', 'bx_fx5', 'bx_fx6', 'bx_fx7', 'bx_fxunnamed', 'gl_doesnotexist',
  'ar_fxcall', 'ar_fxcall1', 'ar_fxcall2', 'ar_fxtun', 'ar_fxfork', 'ar_fxqs', 'ar_fxqsin', 'ar_fxdup', 'bx_fxdup', 'dg_fxmissing',
  'ar_fxport1', 'ar_fxport2', 'ar_fxjoin1', 'ar_fxjoin2',
];

/** Every id already fixed before normalisation: the sample's own ids (found
 * by scanning its serialized text) plus every id an op above writes by hand. */
export function fixedIdsFor(sampleText) {
  return new Set([...(sampleText.match(/\b(?:dg|bx|ar|gl|mdl)_[a-z0-9]+\b/g) || []), ...EXTRA_FIXED_IDS]);
}

/** Every id not in `fixedIds` becomes new1, new2… in order of appearance. */
export function normalize(text, fixedIds) {
  const map = new Map();
  return text.replace(/\b(?:dg|bx|ar|gl|mdl)_[a-z0-9]+\b/g, (id) => {
    if (fixedIds.has(id)) return id;
    if (!map.has(id)) map.set(id, `new${map.size + 1}`);
    return map.get(id);
  });
}

/** Every diagram's numbering, ICOM coding and pairing, plus the model's
 * concepts, validation issues and saved file — what golden-scenarios.json
 * records for one model. */
export function computeAll(m) {
  const diagrams = [];
  for (const dg of Object.values(m.diagrams)) {
    const codes = M.icomCodes(m, dg);
    const p = M.icomPairing(m, dg);
    diagrams.push({
      id: dg.id, node: dg.node, title: dg.title, titleLocked: dg.titleLocked, parentBoxId: dg.parentBoxId,
      boxes: dg.boxes.map((b) => ({ id: b.id, name: b.name, number: b.number, node: M.boxNode(dg, b), x: b.x, y: b.y, w: b.w, h: b.h, conceptId: b.conceptId, childDiagramId: b.childDiagramId })),
      sortedBoxes: M.sortedBoxes(dg).map((b) => b.id),
      readingOrder: M.boxReadingOrder(dg.boxes).map((b) => b.id),
      icom: dg.arrows.flatMap((a) => ['from', 'to'].map((w) => [a.id, w, codes[`${a.id}:${w}`] ?? null])),
      pairing: {
        pairs: p.pairs.map((x) => [x.side, x.child.arrow.id, x.child.which, x.parent.arrow.id, x.code]),
        orphans: p.orphans.map((x) => [x.side, x.child.arrow.id, x.child.which]),
        missing: p.missing.map((x) => [x.side, x.parent.arrow.id, x.parent.code]),
      },
      // S01: the parent concepts not yet connected on this diagram, each with
      // where it is drawn.
      ports: M.ports(m, dg).map((port) => ({ ...port, shape: G.portShape(port) })),
      arrows: dg.arrows.map((a) => {
        const A = G.anchorOf(dg, a.from), B = G.anchorOf(dg, a.to);
        const pts = G.routePoints(A, B, a.bend, dg.boxes);
        return { id: a.id, label: a.label, role: M.arrowRole(a), conceptId: a.conceptId, from: A, to: B, pts, path: G.pointsToPath(pts), mid: G.longestSegmentMid(pts), at: G.pointAt(pts, 0.5), dist: G.distToPolyline(pts, { x: 500, y: 400 }) };
      }),
    });
  }
  const issues = V.validate(m);
  return {
    tree: M.diagramTree(m).map((t) => [t.diagram.id, t.diagram.node, t.depth]),
    diagrams,
    concepts: {
      glossary: m.glossary.map((g) => [g.id, g.term, g.kind, g.definition]),
      usage: m.glossary.map((g) => [g.id, C.conceptUsage(m).get(g.id) || 0]),
      occurrences: m.glossary.map((g) => [g.id, C.occurrencesOf(m, g.id)]),
      unused: C.unusedConcepts(m).map((g) => g.id),
      drift: C.driftedOccurrences(m),
      // S01: per concept, the bundle it is a member of, its effective (outermost
      // bundle) id, and its own members.
      bundles: m.glossary.map((g) => [g.id, C.bundleOf(m, g.id)?.id ?? null, C.effectiveConceptId(m, g.id), g.members ?? []]),
    },
    issues: issues.map((i) => [i.severity, i.code, i.message, i.diagramId ?? null, i.kind ?? null, i.id ?? null]),
    summary: V.summarize(issues),
    file: J.serialize(m),
  };
}
