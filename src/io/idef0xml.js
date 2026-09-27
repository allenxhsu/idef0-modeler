// IDEF0 XML interchange.
//
// There is no single universally implemented "IDEF0 XML" standard — FIPS 183
// specifies the graphic language and the IDL text form, not an XML schema, and
// the commercial tools each shipped their own. This module therefore writes a
// documented, self-describing XML (see doc/idef0-xml.md) that carries the full
// IDEF0 semantics: activities, ICOM arrows, tunnels, node numbers, the
// decomposition tree, purpose/viewpoint and the glossary.
//
// The writer always emits `version="2"`: titleLocked as a diagram attribute,
// box refs and diagram notes when present, a bundle's members as <member>
// children of its <term>, the per-element clocks as attributes where an
// element carries them, a single <extensions> element for unknown
// model/glossary members, activities in array order, and numbers at full
// precision. A reader seeing `version="2"` or higher reads text content
// untrimmed and restores all of that; one seeing `version="1"` or no version
// attribute at all reads exactly as version 1 always did (trimmed text,
// titleLocked derived from the title, no refs/notes/members/extensions) so
// that files written before this version, or by another tool, keep reading
// the same way.
// See doc/idef0-xml.md for the exact contract and what still does not survive
// (per-element extras; XML 1.0-forbidden control characters, replaced with
// U+FFFD).

import { uid } from '../util.js';
import { SIDE_ICOM } from '../model/types.js';
import { arrowRole, boxNode, contextDiagram, createModel, icomCodes, sortedBoxes } from '../model/model.js';

export const XML_NS = 'urn:idef0-modeler:xml:1';

// Top-level members `createModel`/`deserialize` populate; anything else on the
// model or a glossary entry is an extra this format does not otherwise carry,
// kept in the <extensions> element. Mirrors src/io/json.js's own (unexported)
// MODEL_KEYS / conceptKeys, which this module cannot import without changing
// json.js.
const KNOWN_MODEL_KEYS = ['schema', 'id', 'title', 'author', 'project', 'purpose', 'viewpoint',
  'status', 'created', 'revised', 'glossary', 'diagrams', 'rootDiagramId'];
const KNOWN_CONCEPT_KEYS = ['id', 'term', 'kind', 'definition', 'members', 'updatedAt', 'deletedAt'];

const extrasOf = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/**
 * The per-element clocks (src/io/json.js) as attributes, written only when
 * set, so an element that carries neither is written exactly as before. A
 * version-1 reader ignores an attribute it does not know, and this one reads
 * them for version 2 or higher only.
 */
const clockAttrs = (o) => ['updatedAt', 'deletedAt']
  .map((k) => (o[k] ? ` ${k}="${xmlAttr(String(o[k]))}"` : ''))
  .join('');

/** The clocks an element's attributes carry, for version 2 or higher: an
 *  absent or empty attribute is unset and writes no member at all. */
const readClocks = (el, v2) => {
  const out = {};
  if (!v2) return out;
  for (const k of ['updatedAt', 'deletedAt']) {
    const v = el.getAttribute(k);
    if (v) out[k] = v;
  }
  return out;
};

/* ------------------------------------------------------------------ write */

export function toXml(model) {
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push(`<idef0Model xmlns="${XML_NS}" version="2" id="${xmlAttr(model.id)}">`);
  L.push('  <header>');
  L.push(`    <title>${xmlText(model.title)}</title>`);
  L.push(`    <author>${xmlText(model.author)}</author>`);
  L.push(`    <project>${xmlText(model.project)}</project>`);
  L.push(`    <status>${xmlText(model.status)}</status>`);
  L.push(`    <created>${xmlText(model.created)}</created>`);
  L.push(`    <revised>${xmlText(model.revised)}</revised>`);
  L.push(`    <purpose>${xmlText(model.purpose)}</purpose>`);
  L.push(`    <viewpoint>${xmlText(model.viewpoint)}</viewpoint>`);
  L.push('  </header>');

  L.push('  <glossary>');
  for (const g of model.glossary) {
    // A bundle's members follow its definition text as empty <member/>
    // elements, on the same line: the reader takes the definition from the
    // element's whole text content, so no whitespace may sit between them.
    const members = (Array.isArray(g.members) ? g.members : []).map((id) => `<member id="${xmlAttr(id)}"/>`).join('');
    L.push(`    <term id="${xmlAttr(g.id)}" name="${xmlAttr(g.term)}" kind="${xmlAttr(g.kind)}"${clockAttrs(g)}>${xmlText(g.definition)}${members}</term>`);
  }
  L.push('  </glossary>');

  L.push('  <diagrams>');
  for (const dg of Object.values(model.diagrams)) {
    const codes = icomCodes(model, dg);
    L.push(`    <diagram id="${xmlAttr(dg.id)}" node="${xmlAttr(dg.node)}" titleLocked="${dg.titleLocked ? 'true' : 'false'}"${dg.parentBoxId ? ` parentBox="${xmlAttr(dg.parentBoxId)}"` : ''}${dg.id === model.rootDiagramId ? ' context="true"' : ''}${clockAttrs(dg)}>`);
    L.push(`      <title>${xmlText(dg.title)}</title>`);
    if (dg.cNumber) L.push(`      <cNumber>${xmlText(dg.cNumber)}</cNumber>`);
    if (dg.notes && dg.notes.length) L.push(`      <notes>${xmlText(JSON.stringify(dg.notes))}</notes>`);
    L.push('      <activities>');
    // Array order, not number order: the file reflects the model's own array,
    // which the reader already rebuilds from the `number` attribute alone.
    for (const b of dg.boxes) {
      L.push(`        <activity id="${xmlAttr(b.id)}" number="${b.number}" node="${xmlAttr(boxNode(dg, b))}"${b.conceptId ? ` concept="${xmlAttr(b.conceptId)}"` : ''}${b.childDiagramId ? ` detail="${xmlAttr(b.childDiagramId)}"` : ''}${clockAttrs(b)}>`);
      L.push(`          <name>${xmlText(b.name)}</name>`);
      L.push(`          <bounds x="${num(b.x)}" y="${num(b.y)}" width="${num(b.w)}" height="${num(b.h)}"/>`);
      if (b.refs) L.push(`          <refs>${xmlText(b.refs)}</refs>`);
      if (b.note) L.push(`          <note>${xmlText(b.note)}</note>`);
      L.push('        </activity>');
    }
    L.push('      </activities>');
    L.push('      <arrows>');
    for (const a of dg.arrows) {
      const role = arrowRole(a);
      L.push(`        <arrow id="${xmlAttr(a.id)}" role="${role}"${a.conceptId ? ` concept="${xmlAttr(a.conceptId)}"` : ''}${clockAttrs(a)}>`);
      L.push(`          <label>${xmlText(a.label)}</label>`);
      L.push(`          ${endpointXml('source', a, 'from', codes)}`);
      L.push(`          ${endpointXml('destination', a, 'to', codes)}`);
      if (a.bend != null) L.push(`          <route bend="${num(a.bend)}"/>`);
      if (a.ldx || a.ldy) L.push(`          <labelOffset dx="${num(a.ldx)}" dy="${num(a.ldy)}"/>`);
      if (a.note) L.push(`          <note>${xmlText(a.note)}</note>`);
      L.push('        </arrow>');
    }
    L.push('      </arrows>');
    L.push('    </diagram>');
  }
  L.push('  </diagrams>');
  L.push(`  <root diagram="${xmlAttr(model.rootDiagramId)}"/>`);
  const ext = extensionsPayload(model);
  if (ext) L.push(`  <extensions>${xmlText(JSON.stringify(ext))}</extensions>`);
  L.push('</idef0Model>');
  return L.join('\n');
}

function endpointXml(tag, arrow, which, codes) {
  const e = arrow[which];
  const tunnel = which === 'from' ? arrow.tunnelFrom : arrow.tunnelTo;
  if (e.type === 'box') {
    return `<${tag} type="activity" activity="${xmlAttr(e.boxId)}" side="${e.side}" position="${num(e.pos)}"${tunnel ? ' tunnelled="true"' : ''}/>`;
  }
  const code = codes[`${arrow.id}:${which}`];
  return `<${tag} type="boundary" side="${e.side}" position="${num(e.pos)}"${code ? ` icom="${code}"` : ''}${tunnel ? ' tunnelled="true"' : ''}/>`;
}

/** Full-precision number text, as JavaScript itself prints a number. */
const num = (v) => String(Number(v));

/**
 * Members of `model` (or a glossary entry) this version does not otherwise
 * model, keyed the way the reader restores them: `{ model, glossary }`, the
 * latter by concept id so a rebound entry still finds its extras. `null` when
 * there is nothing to carry, so the element is omitted rather than written
 * empty.
 */
function extensionsPayload(model) {
  const modelExtras = extrasOf(model, KNOWN_MODEL_KEYS);
  const glossaryExtras = {};
  for (const g of model.glossary) {
    const extra = extrasOf(g, KNOWN_CONCEPT_KEYS);
    if (Object.keys(extra).length) glossaryExtras[g.id] = extra;
  }
  const hasModel = Object.keys(modelExtras).length > 0;
  const hasGlossary = Object.keys(glossaryExtras).length > 0;
  if (!hasModel && !hasGlossary) return null;
  const out = {};
  if (hasModel) out.model = modelExtras;
  if (hasGlossary) out.glossary = glossaryExtras;
  return out;
}

/**
 * XML 1.0's forbidden code points (§2.2): the C0 controls other than tab, LF
 * and CR, plus the two non-characters. Not even a numeric character reference
 * can carry one, so it becomes U+FFFD — documented, application-level lossy
 * behaviour (doc/idef0-xml.md), never applied to the native JSON format.
 */
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/** Element text content: the five markup escapes, plus a literal CR encoded
 * as `&#13;` so a CRLF survives the parser's line-end normalisation (XML
 * §2.11 turns a raw CRLF, and a raw CR, into a single LF on the way in). */
export function xmlText(s) {
  return String(s ?? '').replace(FORBIDDEN, '�').replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c])).replace(/\r/g, '&#13;');
}

/** Attribute value: `xmlText`, plus TAB and LF encoded so attribute-value
 * normalisation (XML §3.3.3) does not turn them into plain spaces. */
export function xmlAttr(s) {
  return xmlText(s).replace(/\t/g, '&#9;').replace(/\n/g, '&#10;');
}

/* ------------------------------------------------------------------- read */

export function fromXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error(`XML is not well formed: ${err.textContent.trim().split('\n')[0]}`);
  const rootEl = doc.documentElement;
  if (rootEl.localName !== 'idef0Model') throw new Error(`Expected <idef0Model>, found <${rootEl.localName}>.`);

  // version="2" or higher reads text untrimmed and restores titleLocked,
  // refs, notes and extensions; version 1 or absent keeps every version-1
  // reading behaviour byte-for-byte, so old files and other tools' output
  // still read exactly as they always have.
  const v2 = Number(rootEl.getAttribute('version')) >= 2;
  const elText = (el) => {
    const s = el.textContent ?? '';
    return v2 ? s : s.trim();
  };
  const childText = (parent, tag) => {
    const el = parent?.querySelector(`:scope > ${tag}`);
    return el ? elText(el) : null;
  };

  const model = createModel('Imported Model');
  model.diagrams = {};
  const t = (sel, d = '') => {
    const el = rootEl.querySelector(sel);
    return el ? elText(el) : d;
  };
  Object.assign(model, {
    id: rootEl.getAttribute('id') || model.id,
    title: t('header > title', 'Imported Model'),
    author: t('header > author'),
    project: t('header > project'),
    status: t('header > status', 'WORKING'),
    // A date the file does not record stays empty rather than becoming today.
    created: t('header > created'),
    revised: t('header > revised'),
    purpose: t('header > purpose'),
    viewpoint: t('header > viewpoint'),
    glossary: [...rootEl.querySelectorAll('glossary > term')].map((n) => {
      // Version 2 only: a <member id="…"/> child names a member of the
      // bundle; one with no id names nothing and is skipped. A version-1
      // reader never sees them.
      const members = v2 ? [...n.querySelectorAll(':scope > member')].map((e) => e.getAttribute('id') || '').filter(Boolean) : [];
      // Version 2 reads the definition from the term's own text nodes only,
      // and once the term has element children (its <member/>s) the
      // whitespace around each text node is formatting, not text — so a
      // hand-formatted file's line breaks and indentation are not read into
      // the definition. (The writer puts everything on one line either way.)
      const hasElements = v2 && [...n.childNodes].some((c) => c.nodeType === 1);
      const definition = v2
        ? [...n.childNodes]
          .filter((c) => c.nodeType === 3 || c.nodeType === 4)
          .map((c) => (hasElements ? c.nodeValue.trim() : c.nodeValue)).join('')
        : elText(n);
      return {
        id: n.getAttribute('id') || uid('gl'), term: n.getAttribute('name') || '', kind: n.getAttribute('kind') || 'other',
        definition,
        ...(members.length ? { members } : {}),
        ...readClocks(n, v2),
      };
    }),
  });

  if (v2) restoreExtensions(model, rootEl);

  const seenDiagrams = new Set();
  for (const d of rootEl.querySelectorAll('diagrams > diagram')) {
    const title = childText(d, 'title') ?? '';
    const dg = {
      id: d.getAttribute('id') || uid('dg'),
      node: d.getAttribute('node') || 'A0',
      title,
      titleLocked: d.hasAttribute('titleLocked') ? d.getAttribute('titleLocked') === 'true' : !!title.trim(),
      parentBoxId: d.getAttribute('parentBox') || null,
      cNumber: childText(d, 'cNumber') ?? '',
      boxes: [], arrows: [], notes: readNotes(v2 ? d.querySelector(':scope > notes') : null),
      ...readClocks(d, v2),
    };
    for (const a of d.querySelectorAll('activities > activity')) {
      const b = a.querySelector(':scope > bounds');
      dg.boxes.push({
        id: a.getAttribute('id') || uid('bx'),
        number: numAttr(a, 'number', 1),
        conceptId: a.getAttribute('concept') || null,
        name: childText(a, 'name') ?? '',
        x: numAttr(b, 'x', 100),
        y: numAttr(b, 'y', 100),
        w: numAttr(b, 'width', 190),
        h: numAttr(b, 'height', 112),
        childDiagramId: a.getAttribute('detail') || null,
        note: childText(a, 'note') ?? '',
        refs: v2 ? (childText(a, 'refs') ?? '') : '',
        ...readClocks(a, v2),
      });
    }
    for (const a of d.querySelectorAll('arrows > arrow')) {
      const src = a.querySelector(':scope > source');
      const dst = a.querySelector(':scope > destination');
      const route = a.querySelector(':scope > route');
      const off = a.querySelector(':scope > labelOffset');
      dg.arrows.push({
        id: a.getAttribute('id') || uid('ar'),
        label: childText(a, 'label') ?? '',
        conceptId: a.getAttribute('concept') || null,
        from: readEndpoint(src),
        to: readEndpoint(dst),
        bend: numAttr(route, 'bend', null),
        ldx: numAttr(off, 'dx', 0),
        ldy: numAttr(off, 'dy', 0),
        tunnelFrom: src?.getAttribute('tunnelled') === 'true',
        tunnelTo: dst?.getAttribute('tunnelled') === 'true',
        note: childText(a, 'note') ?? '',
        ...readClocks(a, v2),
      });
    }
    // A second diagram with the same id would silently replace the first.
    if (seenDiagrams.has(dg.id)) throw new Error(`Diagram ${dg.id} appears more than once.`);
    seenDiagrams.add(dg.id);
    model.diagrams[dg.id] = dg;
  }

  const rootAttr = rootEl.querySelector('root')?.getAttribute('diagram');
  const contextEl = [...rootEl.querySelectorAll('diagrams > diagram')].find((d) => d.getAttribute('context') === 'true');
  model.rootDiagramId = (rootAttr && model.diagrams[rootAttr] ? rootAttr : null)
    || contextEl?.getAttribute('id')
    || Object.keys(model.diagrams)[0];

  if (!model.rootDiagramId || !model.diagrams[model.rootDiagramId]) {
    throw new Error('The file declares no context (A-0) diagram.');
  }
  return model;
}

/** `JSON.parse` of a `<notes>` element's text, ignoring anything malformed or
 * not an array — the shape `dg.notes` holds. Absent for version 1. */
function readNotes(el) {
  if (!el) return [];
  try {
    const parsed = JSON.parse(el.textContent);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Restores the members `extensionsPayload` set aside: unknown top-level
 * model members, and unknown members of a glossary entry the extension keys
 * by concept id. Malformed JSON, or an id naming no concept, is ignored
 * rather than thrown — an extension a newer app cannot use should not stop
 * this one opening the file. Known members are never overwritten, even by a
 * hand-edited file.
 */
function restoreExtensions(model, rootEl) {
  const el = rootEl.querySelector('extensions');
  if (!el) return;
  let ext;
  try { ext = JSON.parse(el.textContent); } catch { return; }
  if (!ext || typeof ext !== 'object') return;
  if (ext.model && typeof ext.model === 'object') {
    for (const [k, v] of Object.entries(ext.model)) if (!KNOWN_MODEL_KEYS.includes(k)) model[k] = v;
  }
  if (ext.glossary && typeof ext.glossary === 'object') {
    const byId = new Map(model.glossary.map((g) => [g.id, g]));
    for (const [id, extra] of Object.entries(ext.glossary)) {
      const g = byId.get(id);
      if (!g || !extra || typeof extra !== 'object') continue;
      for (const [k, v] of Object.entries(extra)) if (!KNOWN_CONCEPT_KEYS.includes(k)) g[k] = v;
    }
  }
}

/** Read a numeric attribute. `Number(x) || fallback` loses a legitimate 0. */
const numAttr = (el, name, fallback) => {
  if (!el || !el.hasAttribute(name)) return fallback;
  const v = Number(el.getAttribute(name));
  return Number.isFinite(v) ? v : fallback;
};

function readEndpoint(n) {
  if (!n) return { type: 'boundary', side: 'left', pos: 0.5 };
  const side = n.getAttribute('side') || 'left';
  const pos = Number(n.getAttribute('position'));
  const p = Number.isFinite(pos) ? pos : 0.5;
  return n.getAttribute('type') === 'activity'
    ? { type: 'box', boxId: n.getAttribute('activity'), side, pos: p }
    : { type: 'boundary', side, pos: p };
}

/* ---------------------------------------------------- IDL (FIPS 183 text) */

/**
 * A readable IDEF0 node/ICOM listing in the spirit of the FIPS 183 IDL text
 * form. Export only — it is a report, not a round-trip format.
 */
export function toIdl(model) {
  const L = [];
  const ctx = contextDiagram(model);
  L.push(`MODEL ${idlQuote(model.title)}`);
  L.push(`  AUTHOR ${idlQuote(model.author)}  PROJECT ${idlQuote(model.project)}  STATUS ${model.status}`);
  L.push(`  PURPOSE ${idlQuote(oneLine(model.purpose))}`);
  L.push(`  VIEWPOINT ${idlQuote(oneLine(model.viewpoint))}`);
  L.push('');
  const walk = (dg, depth) => {
    const pad = '  '.repeat(depth + 1);
    L.push(`${pad}DIAGRAM ${dg.node} ${idlQuote(dg.title)}`);
    const codes = icomCodes(model, dg);
    for (const a of dg.arrows) {
      const from = a.from.type === 'boundary' ? codes[`${a.id}:from`] || `BOUNDARY.${SIDE_ICOM[a.from.side]}` : `BOX${boxNumber(dg, a.from.boxId)}`;
      const to = a.to.type === 'boundary' ? codes[`${a.id}:to`] || `BOUNDARY.${SIDE_ICOM[a.to.side]}` : `BOX${boxNumber(dg, a.to.boxId)}`;
      L.push(`${pad}  ARROW ${idlQuote(a.label)} ${arrowRole(a).toUpperCase()} FROM ${from} TO ${to}${a.tunnelFrom || a.tunnelTo ? ' TUNNELLED' : ''}`);
    }
    for (const b of sortedBoxes(dg)) {
      L.push(`${pad}  ACTIVITY ${boxNode(dg, b)} ${idlQuote(b.name)}`);
      const child = b.childDiagramId ? model.diagrams[b.childDiagramId] : null;
      if (child) walk(child, depth + 2);
    }
  };
  walk(ctx, 0);
  L.push('END MODEL');
  return L.join('\n');
}

const boxNumber = (dg, id) => dg.boxes.find((b) => b.id === id)?.number ?? '?';
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * A double-quoted IDL string literal: backslash first, then the quote, then
 * any line ending collapsed to the two characters `\n`, so a label or title
 * holding a quote, a backslash or a newline cannot break the statement it
 * sits in or merge into the next line. Order matters — quoting the backslash
 * introduced by escaping a newline would double-escape it.
 */
const idlQuote = (s) => `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r\n|\r|\n/g, '\\n')}"`;
