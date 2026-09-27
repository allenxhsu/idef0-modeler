// The native project file: `*.idef0.json`. Plain JSON, diffable, and the
// canonical representation — every other export is derived from it.

import { SCHEMA, createModel } from '../model/model.js';
import { downloadText, slugify, uid } from '../util.js';

/**
 * Write members in one fixed order — the order `deserialize` builds them in —
 * so a file's bytes depend only on the model, never on the edit history that
 * produced it. (A diagram created by decomposition used to serialize its keys
 * differently from the same diagram after a reload.) The macOS app writes the
 * identical order, so the two produce byte-identical files.
 */
export function serialize(model) {
  return JSON.stringify(canonical(model), null, 2);
}

const MODEL_KEYS = ['schema', 'id', 'title', 'author', 'project', 'purpose', 'viewpoint',
  'status', 'created', 'revised', 'glossary', 'diagrams', 'rootDiagramId'];
/**
 * The per-element clocks, written after everything else the element models
 * and before its extras — `updatedAt`, the ISO-8601 instant the element last
 * changed, and `deletedAt`, the instant it was removed. `deletedAt` is a
 * tombstone: the element stays in the file, marked as gone, so a load keeps
 * it rather than treating it as live. Both are optional and written only when
 * set, so a file that never carried them round-trips byte for byte.
 */
const CLOCK_KEYS = ['updatedAt', 'deletedAt'];

const DIAGRAM_KEYS = ['id', 'node', 'title', 'titleLocked', 'parentBoxId', 'cNumber', 'notes', 'boxes', 'arrows', ...CLOCK_KEYS];
const BOX_KEYS = ['id', 'name', 'number', 'conceptId', 'x', 'y', 'w', 'h', 'childDiagramId', 'note', 'refs', ...CLOCK_KEYS];
const ARROW_KEYS = ['id', 'label', 'conceptId', 'from', 'to', 'bend', 'ldx', 'ldy', 'tunnelFrom', 'tunnelTo', 'note', ...CLOCK_KEYS];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The clocks an element carries, in `CLOCK_KEYS` order: absent, null and the
 * empty string all mean unset, and an unset clock is no member at all —
 * never `null`, which would change the bytes of every file written before
 * the clocks existed. A value is coerced to a string exactly as `id` is.
 */
const clocksOf = (o) => {
  const out = {};
  for (const k of CLOCK_KEYS) {
    if (o[k] === undefined || o[k] === null) continue;
    const s = String(o[k]);
    if (s) out[k] = s;
  }
  return out;
};

/**
 * The members of a diagram, box or arrow this version does not model (an IRI,
 * a cost), in `Object.entries` order. They are kept on the element
 * and written after the members it does model, so annotations survive a save.
 * `Object.fromEntries` and spreading define own properties, so even a
 * `__proto__` member stays an ordinary member. Endpoints are rebuilt whole by
 * the editors, so their unknown members are not kept.
 */
const extrasOf = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

function canonical(m) {
  const out = {
    schema: SCHEMA, id: m.id, title: m.title, author: m.author, project: m.project,
    purpose: m.purpose, viewpoint: m.viewpoint, status: m.status, created: m.created, revised: m.revised,
    // A bundle's `members` is written only when non-empty, after `definition`
    // and before any extras; a plain concept carries no such member at all.
    glossary: (m.glossary || []).map(({ id, term, kind, definition, members, updatedAt, deletedAt, ...rest }) => ({
      id, term, kind, definition,
      ...(Array.isArray(members) && members.length ? { members } : {}),
      ...clocksOf({ updatedAt, deletedAt }),
      ...rest,
    })),
    diagrams: {},
    rootDiagramId: m.rootDiagramId,
  };
  for (const [key, d] of Object.entries(m.diagrams)) {
    out.diagrams[key] = {
      id: d.id, node: d.node, title: d.title, titleLocked: d.titleLocked, parentBoxId: d.parentBoxId,
      cNumber: d.cNumber, notes: d.notes,
      boxes: d.boxes.map((b) => ({
        id: b.id, name: b.name, number: b.number, conceptId: b.conceptId ?? null,
        x: b.x, y: b.y, w: b.w, h: b.h, childDiagramId: b.childDiagramId ?? null, note: b.note, refs: b.refs,
        ...clocksOf(b),
        ...extrasOf(b, BOX_KEYS),
      })),
      arrows: d.arrows.map((a) => ({
        id: a.id, label: a.label, conceptId: a.conceptId ?? null, from: canonicalEnd(a.from), to: canonicalEnd(a.to),
        bend: a.bend ?? null, ldx: a.ldx, ldy: a.ldy, tunnelFrom: a.tunnelFrom, tunnelTo: a.tunnelTo, note: a.note,
        ...clocksOf(a),
        ...extrasOf(a, ARROW_KEYS),
      })),
      ...clocksOf(d),
      ...extrasOf(d, DIAGRAM_KEYS),
    };
  }
  // Members this version does not model stay, after the ones it does.
  for (const key of Object.keys(m)) if (!MODEL_KEYS.includes(key)) out[key] = m[key];
  return out;
}

// A box endpoint always carries `boxId`, null when it names no box, like
// every other optional reference in the file.
const canonicalEnd = (e) => (e.type === 'box'
  ? { type: 'box', boxId: e.boxId ?? null, side: e.side, pos: e.pos }
  : { type: 'boundary', side: e.side, pos: e.pos });

export function saveModel(model, fileName) {
  const name = fileName || `${slugify(model.title)}.idef0.json`;
  downloadText(serialize(model), name, 'application/json');
  return name;
}

/**
 * Parse and repair a project file. Throws on anything unusable.
 *
 * Repairs that invent data — an id given to a glossary entry, box or arrow
 * that had none, a glossary entry that is not an object dropped — are
 * described in `options.repairs` (pushed onto the array the caller passes),
 * never on the model, whose unknown members would be saved into the file.
 * Missing `created` / `revised` dates stay empty: a date the file never
 * recorded is not invented.
 *
 * A file with no top-level `id` (`!raw.id`) falls back to `base`'s freshly
 * minted one (F13): that id exists only in memory until the model is saved,
 * so it is flagged on the returned model as a non-enumerable `__idMinted`,
 * the way `bindAll`'s minted concept ids are flagged by `unboundCount`
 * before binding. Non-enumerable so it is invisible to `canonical()`'s
 * `Object.keys(m)` extras loop and never gets written into the file.
 */
export function deserialize(text, { repairs = [] } = {}) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`Not valid JSON: ${e.message}`); }
  if (!raw || typeof raw !== 'object') throw new Error('File does not contain an object.');
  if (!raw.diagrams || !raw.rootDiagramId) throw new Error('File is not an IDEF0 model (no diagrams / rootDiagramId).');

  const base = createModel('Untitled Model');
  const glossary = [];
  (Array.isArray(raw.glossary) ? raw.glossary : []).forEach((g, i) => {
    if (!isPlainObject(g)) {
      repairs.push(`Glossary entry ${i + 1} is not an object; it was dropped.`);
      return;
    }
    const { id, term, kind, definition, members, updatedAt, deletedAt, ...rest } = g;
    const conceptId = id == null ? uid('gl') : String(id);
    if (id == null) repairs.push(`Glossary entry ${i + 1} has no id; it was given ${conceptId}.`);
    glossary.push({
      id: conceptId,
      term: term === undefined ? '' : String(term),
      kind: kind === undefined ? 'other' : String(kind),
      definition: definition == null ? '' : String(definition),
      // A bundle's member list, its ids coerced as `id` is; absent (or not a
      // list) means no members. An empty list is the same as none.
      ...(Array.isArray(members) && members.length ? { members: members.map((x) => String(x)) } : {}),
      ...clocksOf({ updatedAt, deletedAt }),
      ...rest,
    });
  });

  const model = {
    ...base,
    ...raw,
    schema: SCHEMA,
    created: raw.created ?? '',
    revised: raw.revised ?? '',
    glossary,
    diagrams: {},
  };

  for (const [id, d] of Object.entries(raw.diagrams)) {
    if (d === null) throw new Error(`Diagram ${id} is not an object.`);
    const dg = isPlainObject(d) ? d : {};
    model.diagrams[id] = {
      id,
      node: dg.node || 'A0',
      title: dg.title || '',
      titleLocked: dg.titleLocked ?? !!String(dg.title || '').trim(),
      parentBoxId: dg.parentBoxId ?? null,
      cNumber: dg.cNumber || '',
      notes: Array.isArray(dg.notes) ? dg.notes : [],
      boxes: (dg.boxes || []).map((v, i) => {
        const b = isPlainObject(v) ? v : {};
        const boxId = b.id == null ? uid('bx') : b.id;
        if (b !== v) repairs.push(`Diagram ${id}: box ${i + 1} is not an object; it was replaced by an empty box ${boxId}.`);
        else if (b.id == null) repairs.push(`Diagram ${id}: box ${i + 1} has no id; it was given ${boxId}.`);
        return {
          id: boxId, name: b.name || '', number: Number(b.number) || 0, conceptId: b.conceptId ?? null,
          x: num(b.x, 100), y: num(b.y, 100), w: num(b.w, 190), h: num(b.h, 112),
          childDiagramId: b.childDiagramId ?? null, note: b.note || '', refs: b.refs || '',
          ...clocksOf(b),
          ...extrasOf(b, BOX_KEYS),
        };
      }),
      arrows: (dg.arrows || []).map((v, i) => {
        const a = isPlainObject(v) ? v : {};
        const arrowId = a.id == null ? uid('ar') : a.id;
        if (a !== v) repairs.push(`Diagram ${id}: arrow ${i + 1} is not an object; it was replaced by an empty arrow ${arrowId}.`);
        else if (a.id == null) repairs.push(`Diagram ${id}: arrow ${i + 1} has no id; it was given ${arrowId}.`);
        return {
          id: arrowId, label: a.label || '', conceptId: a.conceptId ?? null,
          from: endpoint(a.from), to: endpoint(a.to),
          bend: a.bend ?? null, ldx: num(a.ldx, 0), ldy: num(a.ldy, 0),
          tunnelFrom: !!a.tunnelFrom, tunnelTo: !!a.tunnelTo, note: a.note || '',
          ...clocksOf(a),
          ...extrasOf(a, ARROW_KEYS),
        };
      }),
      ...clocksOf(dg),
      ...extrasOf(dg, DIAGRAM_KEYS),
    };
  }

  if (!model.diagrams[model.rootDiagramId]) {
    throw new Error('rootDiagramId does not name a diagram in the file.');
  }
  if (!raw.id) {
    Object.defineProperty(model, '__idMinted', { value: true, enumerable: false, configurable: true });
  }
  return model;
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

function endpoint(e) {
  if (!e || typeof e !== 'object') return { type: 'boundary', side: 'left', pos: 0.5 };
  if (e.type === 'box') return { type: 'box', boxId: e.boxId, side: e.side || 'left', pos: num(e.pos, 0.5) };
  return { type: 'boundary', side: e.side || 'left', pos: num(e.pos, 0.5) };
}
