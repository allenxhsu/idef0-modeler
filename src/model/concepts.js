// Concepts: the model's vocabulary as identified things rather than as text.
//
// FIPS 183 §3.2.2 describes IDEF0 in ontological terms already — functions,
// objects, the roles objects stand in relative to functions, and the relations
// between functions formed by objects and by composition. This module supplies
// the missing half of that: identity. A box denotes an *activity* concept and
// an arrow denotes an *object* concept, each carrying a `conceptId` into the
// model glossary, so anything reading the model joins on an identifier instead
// of on display text.
//
// The label stays on the box or arrow, because §3.3.2.4 lets a child diagram
// give an arrow a more specific label than its parent carries. What travels
// between parent and child is the concept id.

import { uid } from '../util.js';
// model.js does not import this file, so no cycle.
import { boxNode, bundleOf, childDiagram, effectiveConceptId, findBox, icomPairing, isBundle } from './model.js';

// The bundle lookups live in model.js (ICOM coding needs them there); this
// module is where the rest of the concept API is, so it offers them too.
export { bundleOf, effectiveConceptId, isBundle };

/** Normalised key for a term: case- and whitespace-insensitive. */
export const normTerm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

export const conceptById = (m, id) => (id ? m.glossary.find((g) => g.id === id) || null : null);

export function findConcept(m, term) {
  const k = normTerm(term);
  return k ? m.glossary.find((g) => normTerm(g.term) === k) || null : null;
}

/** The concept for `term`, created if the model does not hold it yet. */
export function resolveConcept(m, term, kind = 'other') {
  const t = String(term || '').trim();
  if (!t) return null;
  const found = findConcept(m, t);
  if (found) return found;
  const c = { id: uid('gl'), term: t, kind, definition: '' };
  m.glossary.push(c);
  sortGlossary(m);
  return c;
}

/** An arrow's concept kind follows the role its box-side gives it. */
const arrowKind = (arrow) =>
  (arrow.to?.type === 'box' && arrow.to.side === 'bottom' ? 'mechanism' : 'data');

export function bindBox(m, box) {
  const c = resolveConcept(m, box.name, 'activity');
  box.conceptId = c ? c.id : null;
  return c;
}

export function bindArrow(m, arrow) {
  const c = resolveConcept(m, arrow.label, arrowKind(arrow));
  arrow.conceptId = c ? c.id : null;
  return c;
}

/**
 * Whether `bindAll(m)` would still give this box or arrow a new `conceptId`.
 * An unbound element (no id) needs it only when it has text to bind; an
 * orphan id — one that names no glossary entry — needs it only when its text
 * is non-blank and names no *other* concept either (see F14: a blank-text
 * orphan keeps its id for the validator to ignore, and a term clash keeps its
 * id so 'concept-unbound' reports it, rather than being silently rewritten).
 */
function needsBinding(m, conceptId, text) {
  if (conceptById(m, conceptId)) return false;
  const t = String(text || '').trim();
  if (!conceptId) return !!t;
  if (!t) return false;
  return !findConcept(m, t);
}

/**
 * How many boxes and arrows `bindAll(m)` would still have to bind — checked
 * before binding, since `bindAll` is idempotent and leaves nothing to count
 * afterward. Lets a caller (the store, the Mac document, the CLI) tell the
 * user that a load bound something that now needs saving to keep it (F13).
 */
export function unboundCount(m) {
  let n = 0;
  for (const dg of Object.values(m.diagrams)) {
    for (const b of dg.boxes) if (needsBinding(m, b.conceptId, b.name)) n += 1;
    for (const a of dg.arrows) if (needsBinding(m, a.conceptId, a.label)) n += 1;
  }
  return n;
}

/**
 * Bind or restore one box or arrow, as `bindAll` needs. An unbound element
 * (no `conceptId`) binds by text, as `bindFn` (`bindBox`/`bindArrow`) always
 * has. A non-empty `conceptId` that names no glossary entry is an orphan —
 * from a hand-edited or foreign file — and is never silently rewritten by a
 * label lookup (F14): restoring the concept under the orphan id, when
 * nothing else already holds its term, loses nothing that was on disk; a
 * term that already names a different concept leaves the id alone, so
 * 'concept-unbound' reports the clash rather than quietly rebinding to
 * someone else's concept.
 */
function bindOrRestore(m, el, textField, bindFn) {
  if (!needsBinding(m, el.conceptId, el[textField])) return;
  if (!el.conceptId) { bindFn(m, el); return; }
  const kind = textField === 'name' ? 'activity' : arrowKind(el);
  m.glossary.push({ id: el.conceptId, term: String(el[textField] || '').trim(), kind, definition: '' });
  sortGlossary(m);
}

/**
 * Bind every box and arrow that is not already bound. Idempotent, and cheap
 * enough to run on every load — which is how a model written before concepts
 * existed acquires them.
 */
export function bindAll(m) {
  if (!Array.isArray(m.glossary)) m.glossary = [];
  for (const dg of Object.values(m.diagrams)) {
    for (const b of dg.boxes) bindOrRestore(m, b, 'name', bindBox);
    for (const a of dg.arrows) bindOrRestore(m, a, 'label', bindArrow);
  }
  return m;
}

/**
 * The concept id an ICOM counterpart of `arrow` carries, if it has one
 * (§3.3.2.4): a boundary arrow's counterpart is the parent's paired arrow; an
 * arrow touching a box with a child diagram has its counterpart among that
 * diagram's boundary arrows. Only arrows have counterparts — a box's
 * activity concept is never shared with anything else.
 */
function icomCounterpartConceptId(m, dg, arrow) {
  if ((arrow.from.type === 'boundary' || arrow.to.type === 'boundary') && dg.id !== m.rootDiagramId) {
    const p = icomPairing(m, dg).pairs.find((x) => x.child.arrow.id === arrow.id);
    if (p) return p.parent.arrow.conceptId;
  }
  const boxIds = new Set();
  if (arrow.from.type === 'box') boxIds.add(arrow.from.boxId);
  if (arrow.to.type === 'box') boxIds.add(arrow.to.boxId);
  for (const boxId of boxIds) {
    const box = findBox(dg, boxId);
    const child = box && childDiagram(m, box);
    if (!child) continue;
    const p = icomPairing(m, child).pairs.find((x) => x.parent.arrows.some((a) => a.id === arrow.id));
    if (p) return p.child.arrow.conceptId;
  }
  return null;
}

/** The concept keys this version models; anything else on an entry is an
 *  extra (an IRI, a cost) a file carried. `members` is modelled (a bundle's
 *  member list, see model.js), so a bundle has no extras either, and neither
 *  has an entry carrying only the per-element clocks (see src/io/json.js):
 *  a clock is not a definition somebody wrote, so it never stops rule (5)
 *  renaming an otherwise unused concept in place. */
const CONCEPT_FIELDS = ['id', 'term', 'kind', 'definition', 'members', 'updatedAt', 'deletedAt'];
const hasNoExtras = (c) => Object.keys(c).every((k) => CONCEPT_FIELDS.includes(k));

/**
 * Decide the conceptId a relabelled box or arrow should carry, given the
 * concept it denoted before the edit (or null, if it was unbound) and its
 * new trimmed text `t`. In order: (2) `t` renormalises to the current
 * concept's own term — keep the id. (3) `findConcept(t)` names a different
 * concept — rebind to it, an explicit reuse of existing vocabulary. (4) the
 * current concept is shared with an ICOM counterpart of this element — keep
 * the id and let the text drift (`counterpartId` is null for a box, which
 * never has one). (5) nothing else uses the concept, and it carries no
 * definition or extras — rename it in place, keeping its id, rather than
 * leave a defined-looking term dangling or spawn a near-duplicate. (6)
 * otherwise resolve or create a concept by `t`, as `bindBox`/`bindArrow` do.
 * (Rule 1, the empty-text case, is handled by the caller.)
 */
function relabelledConceptId(m, before, t, createKind, counterpartId) {
  if (before) {
    if (normTerm(t) === normTerm(before.term)) return before.id;
    const found = findConcept(m, t);
    if (found && found.id !== before.id) return found.id;
    if (counterpartId && counterpartId === before.id) return before.id;
    const usage = conceptUsage(m).get(before.id) || 0;
    if (usage <= 1 && !before.definition.trim() && hasNoExtras(before)) {
      before.term = t;
      sortGlossary(m);
      return before.id;
    }
  }
  const c = resolveConcept(m, t, createKind);
  return c ? c.id : null;
}

/**
 * A box's name changed by an edit — as opposed to `bindBox`'s load-time
 * binding. Implements the rules `relabelledConceptId` documents; a box has no
 * ICOM counterpart, so rule (4) never applies to it. See `relabelArrow`.
 */
export function relabelBox(m, dg, box, text) {
  const t = String(text || '').trim();
  box.name = t;
  box.conceptId = t ? relabelledConceptId(m, conceptById(m, box.conceptId), t, 'activity', null) : null;
  return conceptById(m, box.conceptId);
}

/**
 * An arrow's label changed by an edit — as opposed to `bindArrow`'s
 * load-time binding. A child elaborating its parent's label (§3.3.2.4), or a
 * typo fixed on an undefined term nothing else uses, keeps its conceptId
 * instead of being silently moved to a new or unrelated concept (F11).
 */
export function relabelArrow(m, dg, arrow, text) {
  const t = String(text || '').trim();
  arrow.label = t;
  if (!t) { arrow.conceptId = null; return null; }
  const before = conceptById(m, arrow.conceptId);
  const counterpartId = before ? icomCounterpartConceptId(m, dg, arrow) : null;
  arrow.conceptId = relabelledConceptId(m, before, t, arrowKind(arrow), counterpartId);
  return conceptById(m, arrow.conceptId);
}

/** Rename a concept, carrying every box and arrow that denotes it along. */
export function renameConcept(m, id, term) {
  const c = conceptById(m, id);
  const t = String(term || '').trim();
  if (!c || !t) return null;
  // Renaming onto a term the model already has says the two are one thing.
  const clash = findConcept(m, t);
  if (clash && clash.id !== id) return mergeConcepts(m, id, clash.id);
  c.term = t;
  for (const dg of Object.values(m.diagrams)) {
    for (const b of dg.boxes) if (b.conceptId === id) b.name = t;
    for (const a of dg.arrows) if (a.conceptId === id) a.label = t;
  }
  sortGlossary(m);
  return c;
}

/**
 * Fold one concept into another; every reference moves across. Refuses —
 * returns null, changing nothing — when `fromId` is a bundle that holds
 * `intoId` (at any depth): merging the general concept into one of its own
 * specifics would put the survivor inside itself. Otherwise every members
 * list is rewritten fromId→intoId and de-duplicated, a bundle never lists
 * itself, and the survivor takes over the source's members, so a bundle
 * merged into a plain concept stays a bundle under the surviving id.
 */
export function mergeConcepts(m, fromId, intoId) {
  const into = conceptById(m, intoId);
  if (!into || fromId === intoId) return into;
  const from = conceptById(m, fromId);
  if (from && transitiveMembers(m, fromId).has(intoId)) return null;
  // Members of two different bundles cannot be one concept without putting
  // the survivor in both bundles; un-combine one first.
  const fromBundle = bundleOf(m, fromId);
  const intoBundle = bundleOf(m, intoId);
  if (fromBundle && intoBundle && fromBundle.id !== intoBundle.id) return null;
  // The survivor's definition wins if it has one; otherwise the source's
  // definition, if it has one, is not lost with it (F15).
  if (from && !into.definition.trim() && from.definition.trim()) into.definition = from.definition;
  rewriteMembers(m, fromId, intoId);
  if (from && Array.isArray(from.members) && from.members.length) {
    const inherited = from.members.map((x) => (x === fromId ? intoId : x));
    into.members = dedupeMembers([...(into.members || []), ...inherited], intoId);
  }
  for (const dg of Object.values(m.diagrams)) {
    for (const b of dg.boxes) if (b.conceptId === fromId) { b.conceptId = intoId; b.name = into.term; }
    for (const a of dg.arrows) if (a.conceptId === fromId) { a.conceptId = intoId; a.label = into.term; }
  }
  m.glossary = m.glossary.filter((g) => g.id !== fromId);
  return into;
}

/* ----------------------------------------------------------------- bundles */

/**
 * Every concept reachable from `id` through members lists, at any depth
 * (cycle-safe). Whether `id` itself is in the set says whether it sits on a
 * cycle.
 */
export function transitiveMembers(m, id) {
  const out = new Set();
  const c = conceptById(m, id);
  const stack = c && Array.isArray(c.members) ? [...c.members] : [];
  while (stack.length) {
    const x = stack.pop();
    if (out.has(x)) continue;
    out.add(x);
    const cx = conceptById(m, x);
    if (cx && Array.isArray(cx.members)) stack.push(...cx.members);
  }
  return out;
}

/** A members list with repeats dropped (the first occurrence stays) and any
 *  entry naming the list's own bundle dropped too. */
const dedupeMembers = (members, ownId) => {
  const seen = new Set();
  return members.filter((x) => {
    if (x === ownId || seen.has(x)) return false;
    seen.add(x);
    return true;
  });
};

/**
 * Every members list with `fromId` replaced by `intoId`, de-duplicated. In
 * `intoId`'s own list, and in the lists below it, `fromId` is dropped rather
 * than rewritten: a member merged into its own bundle (or an ancestor of it)
 * is absorbed, and rewriting it there would make the bundle contain itself.
 */
function rewriteMembers(m, fromId, intoId) {
  const below = transitiveMembers(m, intoId);
  for (const g of m.glossary) {
    if (!Array.isArray(g.members) || !g.members.length) continue;
    const absorbs = g.id === intoId || below.has(g.id);
    const rewritten = absorbs
      ? g.members.filter((x) => x !== fromId)
      : g.members.map((x) => (x === fromId ? intoId : x));
    g.members = dedupeMembers(rewritten, g.id);
  }
}

/**
 * Combine two or more concepts into a new bundle (FIPS 183 §3.2.2.3): a
 * fresh glossary entry `{ id, term, kind, definition: '', members }` whose
 * kind is the members' kind when they all agree and 'other' otherwise. The
 * members' own entries, and every box and arrow bound to them, are left as
 * they are — a bundle is looked up from its members, never written into an
 * occurrence, which is what makes un-combining lossless.
 *
 * Refuses, returning null and changing nothing, when fewer than two distinct
 * ids are given, an id names no concept, an id is already a member of a
 * bundle, or the result would nest a bundle inside itself.
 */
export function combineConcepts(m, memberIds, term) {
  const ids = [];
  for (const id of memberIds || []) if (!ids.includes(id)) ids.push(id);
  if (ids.length < 2) return null;
  const id = uid('gl');
  for (const x of ids) {
    if (!conceptById(m, x)) return null;
    if (bundleOf(m, x)) return null;
    if (x === id || transitiveMembers(m, x).has(id)) return null;
  }
  const kinds = ids.map((x) => conceptById(m, x).kind);
  const kind = kinds.every((k) => k === kinds[0]) ? kinds[0] : 'other';
  const bundle = { id, term: String(term || '').trim(), kind, definition: '', members: ids };
  m.glossary.push(bundle);
  sortGlossary(m);
  return bundle;
}

/**
 * Dissolve a bundle. Its members stand on their own again, and if the bundle
 * was itself a member of an outer bundle they join that list at its position,
 * in order. What becomes of the entry depends on whether anything denotes
 * it: an arrow drawn from the bundle's port (or a box, by a hand-edit) is
 * bound to the bundle id itself, so the entry is kept as a plain concept —
 * its members list dropped, its place in any outer bundle kept, its former
 * members inserted after it — and nothing is left dangling. When nothing
 * uses it, the entry goes, and its members simply take its place. Nothing
 * bound to a member changes either way. Refuses, returning null, when
 * `bundleId` is not a bundle. Returns the entry (with no members).
 */
export function uncombineConcept(m, bundleId) {
  const b = conceptById(m, bundleId);
  if (!isBundle(b)) return null;
  const kept = (conceptUsage(m).get(bundleId) || 0) > 0;
  const outer = bundleOf(m, bundleId);
  if (outer) {
    const at = outer.members.indexOf(bundleId);
    outer.members.splice(kept ? at + 1 : at, kept ? 0 : 1, ...b.members);
  }
  if (kept) delete b.members;
  else m.glossary = m.glossary.filter((g) => g.id !== bundleId);
  return b;
}

/**
 * Delete a glossary entry — the one place both apps remove a concept. A
 * bundle is un-combined first (its members survive, spliced into any outer
 * bundle) and then removed whether or not anything used it; a member is
 * dropped from every bundle's list; boxes and arrows bound to the concept
 * keep their now-dangling id, as they always have, for `concept-unbound` to
 * report. Returns the removed entry, or null when `id` names none.
 */
export function removeConcept(m, id) {
  const c = conceptById(m, id);
  if (!c) return null;
  if (isBundle(c)) uncombineConcept(m, id);
  for (const g of m.glossary) {
    if (Array.isArray(g.members) && g.members.includes(id)) g.members = g.members.filter((x) => x !== id);
  }
  m.glossary = m.glossary.filter((g) => g.id !== id);
  return c;
}

/** Every place a concept is used — the basis of any cross-diagram analysis. */
export function occurrencesOf(m, conceptId) {
  const out = [];
  if (!conceptId) return out;
  for (const dg of Object.values(m.diagrams)) {
    for (const b of dg.boxes) {
      // An activity is referred to by its own node number, an object by the
      // diagram it appears on.
      if (b.conceptId === conceptId) out.push({ diagramId: dg.id, node: boxNode(dg, b), kind: 'box', id: b.id, text: b.name });
    }
    for (const a of dg.arrows) {
      if (a.conceptId === conceptId) out.push({ diagramId: dg.id, node: dg.node, kind: 'arrow', id: a.id, text: a.label });
    }
  }
  return out;
}

/** conceptId -> how many places use it. */
export function conceptUsage(m) {
  const n = new Map();
  const bump = (id) => { if (id) n.set(id, (n.get(id) || 0) + 1); };
  for (const dg of Object.values(m.diagrams)) {
    for (const b of dg.boxes) bump(b.conceptId);
    for (const a of dg.arrows) bump(a.conceptId);
  }
  return n;
}

/** Concepts the model defines but never uses. */
export function unusedConcepts(m) {
  const used = conceptUsage(m);
  return m.glossary.filter((g) => !used.has(g.id));
}

/**
 * Places where the authored text has drifted from the concept it is bound to.
 * Legitimate under §3.3.2.4 when a child elaborates a parent's label, so this
 * is reported as information, not as an error.
 */
export function driftedOccurrences(m) {
  const out = [];
  for (const dg of Object.values(m.diagrams)) {
    for (const b of dg.boxes) {
      const c = conceptById(m, b.conceptId);
      if (c && b.name.trim() && normTerm(b.name) !== normTerm(c.term)) {
        out.push({ diagramId: dg.id, node: dg.node, kind: 'box', id: b.id, text: b.name, conceptId: c.id, term: c.term });
      }
    }
    for (const a of dg.arrows) {
      const c = conceptById(m, a.conceptId);
      if (c && a.label.trim() && normTerm(a.label) !== normTerm(c.term)) {
        out.push({ diagramId: dg.id, node: dg.node, kind: 'arrow', id: a.id, text: a.label, conceptId: c.id, term: c.term });
      }
    }
  }
  return out;
}

// Pinned to en-US so the glossary sorts the same on every machine, matching
// jsLocaleCompare (macos/Sources/IDEF0Core/Foundation/Util.swift), which is
// pinned the same way — a bare localeCompare follows the browser's UI
// language, so the saved file's bytes would otherwise depend on the machine.
const TERM_ORDER = new Intl.Collator('en-US');
const sortGlossary = (m) => { m.glossary.sort((a, b) => TERM_ORDER.compare(a.term, b.term)); };
