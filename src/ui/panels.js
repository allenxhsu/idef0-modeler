// Side panels: node tree, model properties, glossary, inspector and checks.

import { el, clear } from '../util.js';
import { STATUS_VALUES, GLOSSARY_KINDS, ROLE_LABEL, SIDE_ROLE, DECOMP_MIN, DECOMP_MAX } from '../model/types.js';
import {
  arrowRole, arrowsTouching, boxNode, childDiagram, contextDiagram, decomposeBox,
  deleteSubtree, diagramTree, findBox, findBoxAnywhere, icomCodes, moveBox, ports, sortedBoxes,
} from '../model/model.js';
import { renameBox, labelArrow, setModelTitle } from '../model/edits.js';
import { store, set, commit, currentDiagram, goToDiagram } from '../state/store.js';
import { persistenceState, persistenceAdvice } from '../state/persistence.js';
import { PORTAL_CREDENTIAL_LINE, syncNow, syncSnapshot, syncView, updateSyncSettings } from '../sync/index.js';
import { syncSettings } from '../sync/settings.js';
import { syncIssues } from '../sync/checks.js';
import { renderCanvas } from './canvas.js';
import { confirmDialog, promptNumber, promptText } from './dialog.js';
import {
  bundleOf, combineConcepts, conceptById, conceptUsage, effectiveConceptId, isBundle, occurrencesOf,
  removeConcept, renameConcept, resolveConcept, transitiveMembers, uncombineConcept,
} from '../model/concepts.js';

/* --------------------------------------------------------------- helpers */

function field(label, control) {
  return el('div', { class: 'field' }, el('label', { text: label }), control);
}

/**
 * A text field that commits on `change`. `onchange` may return the text the
 * model actually stored (a name is trimmed), which the field then shows: on
 * Enter the field keeps the focus, so the panel is not rebuilt around it —
 * the Mac's CommitTextField reloads the same way.
 */
function textInput(value, onchange, attrs = {}) {
  const i = el('input', { type: 'text', value: value ?? '', ...attrs });
  i.addEventListener('change', () => {
    const stored = onchange(i.value);
    if (typeof stored === 'string') i.value = stored;
  });
  return i;
}

function textArea(value, onchange, rows = 3) {
  const t = el('textarea', { rows });
  t.value = value ?? '';
  t.addEventListener('change', () => onchange(t.value));
  return t;
}

function selectInput(value, options, onchange) {
  const s = el('select', {}, ...options.map((o) => {
    const v = typeof o === 'string' ? o : o.value;
    const label = typeof o === 'string' ? o : o.label;
    return el('option', { value: v, text: label, selected: v === value });
  }));
  s.value = value;
  s.addEventListener('change', () => onchange(s.value));
  return s;
}

function checkbox(label, checked, onchange) {
  const i = el('input', { type: 'checkbox', checked });
  i.addEventListener('change', () => onchange(i.checked));
  return el('label', { class: 'checkline' }, i, el('span', { text: label }));
}

/* ------------------------------------------------------------- node tree */

export function renderTree() {
  const host = document.getElementById('tree');
  clear(host);
  const m = store.model;
  const ctx = contextDiagram(m);
  if (!ctx || !ctx.boxes.length) { host.appendChild(el('p', { class: 'empty', text: 'No context box.' })); return; }

  const wrapEl = el('div', { class: 'tree' });
  const ul = el('ul');
  for (const b of sortedBoxes(ctx)) ul.appendChild(activityNode(m, ctx, b, new Set([ctx.id])));
  wrapEl.appendChild(ul);
  host.appendChild(wrapEl);
}

/**
 * One activity row, with its decomposition nested under it. `path` holds the
 * diagrams on the way down from A-0: a box whose detail diagram is already on
 * it (a cycle a hand-edited or imported file can hold, reported as
 * decomp-cycle) is still drawn, but not descended into, so the tree ends. The
 * guard is the path, not a visited set, so a diagram two boxes name is still
 * expanded under each.
 */
function activityNode(m, diagram, box, path) {
  const node = boxNode(diagram, box);
  const child = childDiagram(m, box);
  const isCurrent = store.ui.currentDiagramId === (child ? child.id : diagram.id)
    && (child ? true : store.ui.selection?.id === box.id);

  const row = el('div', {
    class: `node${isCurrent ? ' current' : ''}${child ? '' : ' leaf'}`,
    title: child ? `Open ${node}` : `Show ${node} on ${diagram.node}`,
    onclick: () => {
      if (child) { goToDiagram(child.id); } else { goToDiagram(diagram.id); set({ selection: { kind: 'box', id: box.id } }); }
      renderCanvas();
    },
  },
  el('span', { class: 'nn', text: node }),
  el('span', { class: 'nm', text: box.name || '(unnamed)' }));

  const li = el('li', {}, row);
  if (child && !path.has(child.id)) {
    const ul = el('ul');
    path.add(child.id);
    for (const b of sortedBoxes(child)) ul.appendChild(activityNode(m, child, b, path));
    path.delete(child.id);
    li.appendChild(ul);
  }
  return li;
}

/* ------------------------------------------------------- model properties */

export function renderModelProps() {
  const host = document.getElementById('modelprops');
  clear(host);
  const m = store.model;
  const upd = (key) => (v) => { commit(`Edit model ${key}`, (mm) => { mm[key] = v; }); renderCanvas(); };

  host.append(
    el('h3', { class: 'sect', text: 'Identification' }),
    field('Title', textInput(m.title, (v) => {
      commit('Edit model title', (mm) => { setModelTitle(mm, v); });
      renderCanvas();
    })),
    field('Author', textInput(m.author, upd('author'))),
    field('Project', textInput(m.project, upd('project'))),
    el('div', { class: 'row' },
      field('Status', selectInput(m.status, STATUS_VALUES, upd('status'))),
      field('Revised', textInput(m.revised, upd('revised'), { placeholder: 'YYYY-MM-DD' }))),

    el('h3', { class: 'sect', text: 'Context' }),
    field('Purpose — why the model exists', textArea(m.purpose, upd('purpose'))),
    field('Viewpoint — whose perspective', textArea(m.viewpoint, upd('viewpoint'))),

    el('h3', { class: 'sect', text: 'Statistics' }),
    stat('Diagrams', Object.keys(m.diagrams).length),
    stat('Activities', Object.values(m.diagrams).reduce((n, d) => n + d.boxes.length, 0)),
    stat('Arrows', Object.values(m.diagrams).reduce((n, d) => n + d.arrows.length, 0)),
    stat('Glossary terms', m.glossary.length),
    // Depth in the decomposition tree (A-0 = 0, A0 = 1, A1 = 2, A11 = 3), as the
    // Mac shows it; a diagram the tree does not reach does not count.
    stat('Deepest level', Math.max(0, ...diagramTree(m).map((n) => n.depth))),

    el('h3', { class: 'sect', text: 'This browser' }),
    ...storageRows(),

    el('h3', { class: 'sect', text: 'Saving online' }),
    ...syncRows(),
  );
}

/**
 * Whether the browser has promised to keep the autosaved copy of this model,
 * and what to do when it has not (S04).
 *
 * The state arrives asynchronously and the panel is rebuilt when it does, so
 * "checking…" is what a first paint shows rather than a wrong answer.
 */
function storageRows() {
  const { state } = persistenceState();
  const label = { persisted: 'Persisted', 'at-risk': 'At risk', unknown: 'Checking…' }[state];
  const badge = { persisted: 'ok', 'at-risk': 'warning', unknown: '' }[state];
  const advice = persistenceAdvice(state);
  return [
    el('div', { class: 'kv' },
      el('span', { text: 'Autosaved copy' }),
      el('span', { class: `badge ${badge}`.trim(), text: label })),
    ...(advice ? [el('div', { class: 'mnote', text: advice })] : []),
  ];
}

/**
 * Where this browser saves online, and whether it managed to.
 *
 * Two shapes, one section. Under the Portal there is nothing to configure: the
 * workspace comes from the toolkit and the credential is the session cookie, so
 * the URL and token fields are replaced by the single line “Signed in via the
 * toolkit”. Off the Portal the fields are there for somebody running a server
 * of their own, and sync is off until they fill them in — nothing about the app
 * changes for anyone who never does.
 *
 * `<sc-sync-status>` is the shared kit's readout, mounted beside the rest: it
 * listens for the sync status event itself, shows “Synced · 4 min ago”, offers
 * its own Sync now, and turns into a Sign in link when a session has run out.
 */
function syncRows() {
  const view = syncView();
  const rows = [
    checkbox('Save this model to the workspace', view.enabled, (on) => { void updateSyncSettings({ enabled: on }); }),
  ];

  if (view.portal) {
    rows.push(el('div', { class: 'kv' },
      el('span', { text: 'Account' }),
      el('span', { text: PORTAL_CREDENTIAL_LINE })));
    if (view.workspace) {
      rows.push(el('div', { class: 'kv' }, el('span', { text: 'Workspace' }), el('span', { class: 'mono', text: view.workspace })));
    }
  } else {
    const settings = syncSettings();
    rows.push(field('Server — the workspace URL', textInput(settings.url, (v) => {
      const url = v.trim();
      void updateSyncSettings({ url });
      return url;
    }, { placeholder: 'https://host/w/idef0' })));
    rows.push(field('Token', textInput(settings.token, (v) => {
      const token = v.trim();
      void updateSyncSettings({ token });
      return token;
    }, { type: 'password', placeholder: 'Bearer token, if the server wants one' })));
  }

  const status = el('div', { class: 'syncline' });
  const readout = document.createElement('sc-sync-status');
  // The kit's element offers a Sync now of its own; this section already has
  // one, and that one knows whether there is a server to sync with.
  readout.setAttribute('no-button', '');
  status.appendChild(readout);
  rows.push(status);
  rows.push(el('div', { class: 'row' },
    el('button', { class: 'btn', text: 'Sync now', disabled: !view.configured, onclick: () => { void syncNow(); } })));
  if (view.message) rows.push(el('div', { class: 'mnote', text: view.message }));
  return rows;
}

const stat = (k, v) => el('div', { class: 'kv' }, el('span', { text: k }), el('span', { class: 'mono', text: String(v) }));

/* -------------------------------------------------------------- glossary */

export function renderGlossary() {
  const host = document.getElementById('glossary');
  clear(host);
  const m = store.model;
  const usage = conceptUsage(m);

  /* ---- add a concept ---- */
  const term = el('input', { type: 'text', placeholder: 'Term' });
  const kind = selectInput('data', GLOSSARY_KINDS, () => {});
  const def = el('textarea', { rows: 2, placeholder: 'Definition' });
  const add = el('button', {
    class: 'btn',
    text: 'Add concept',
    onclick: () => {
      const t = term.value.trim();
      if (!t) return;
      // An existing term is found, not overwritten (F15): the typed kind is
      // ignored for it, as `resolveConcept` documents, and a blank Definition
      // box must not wipe out a definition that concept already carries.
      commit('Add concept', (mm) => {
        const c = resolveConcept(mm, t, kind.value);
        const d = def.value.trim();
        if (d) c.definition = d;
      });
      term.value = ''; def.value = '';
      renderGlossary();
    },
  });

  // The ticks survive a redraw, but not a concept that is gone or has since
  // been put in a bundle (it could not be combined again anyway).
  for (const id of [...combineTicks]) {
    if (!conceptById(m, id) || bundleOf(m, id)) combineTicks.delete(id);
  }
  const combineBtn = el('button', {
    class: 'btn', text: combineLabel(), disabled: combineTicks.size < 2,
    title: 'Combine the ticked concepts into one bundle (FIPS 183 \u00a73.2.2.3)',
    onclick: () => { combineTicked(); },
  });
  const refreshCombine = () => { combineBtn.textContent = combineLabel(); combineBtn.disabled = combineTicks.size < 2; };

  host.append(
    el('h3', { class: 'sect', text: 'Add' }),
    field('Term', term), field('Kind', kind), field('Definition', def), add,
    el('h3', { class: 'sect', text: `Concepts (${m.glossary.length})` }),
  );

  if (!m.glossary.length) {
    host.appendChild(el('p', { class: 'empty', text: 'No concepts yet. Naming a box or labelling an arrow registers one automatically.' }));
    return;
  }

  host.append(
    el('p', { class: 'empty', text: 'Tick two or more concepts and combine them into a bundle: one general arrow standing for its members.' }),
    combineBtn,
    el('div', { style: 'height:8px' }),
  );

  const undefinedN = m.glossary.filter((g) => !g.definition.trim()).length;
  if (undefinedN) {
    host.appendChild(el('p', { class: 'empty', text: `${undefinedN} of ${m.glossary.length} have no definition yet. Every activity and object needs one.` }));
  }

  // Top level: every concept that is in no bundle, in glossary order. A
  // bundle's members are drawn nested under it (`conceptRow`), so a member
  // appears once, under the bundle that holds it \u2014 the first, in glossary
  // order, should a malformed file list it in two (as `bundleOf` reads it).
  // A bundle on a cycle (a hand-edited file: it contains itself through its
  // members) is in a bundle too, yet nothing above it would ever reach it;
  // it is listed here as well, with the bundle-cycle warning, so its
  // Un-combine stays reachable \u2014 the Mac's flat list shows the same.
  for (const g of m.glossary) {
    if (bundleOf(m, g.id) && !onCycle(m, g)) continue;
    host.appendChild(conceptRow(m, usage, g, 0, new Set(), refreshCombine));
  }
}

/** Whether a bundle contains itself through its members (validate.js's bundle-cycle). */
const onCycle = (m, g) => isBundle(g) && transitiveMembers(m, g.id).has(g.id);

/** Concept ids ticked for "Combine selected" \u2014 UI-only, kept across redraws. */
const combineTicks = new Set();

const combineLabel = () => `Combine selected (${combineTicks.size})`;

/**
 * One glossary row: its term, kind, definition, usage and occurrences, with
 * a tick for combining. A bundle also lists its members nested beneath it
 * (each with the same controls, indented by `depth`) and offers Un-combine;
 * a member's tick is disabled, since it cannot be combined again until its
 * bundle is dissolved. `path` holds the bundles above this row, so a cycle a
 * hand-edited file can hold is drawn once and not descended into again.
 */
function conceptRow(m, usage, g, depth, path, refreshCombine) {
  const n = usage.get(g.id) || 0;
  const bundle = isBundle(g);
  const inBundle = bundleOf(m, g.id);

  const tick = el('input', {
    type: 'checkbox', checked: combineTicks.has(g.id), disabled: !!inBundle,
    title: inBundle ? `Already in the bundle \u201c${inBundle.term}\u201d \u2014 un-combine that first` : 'Tick to combine with other ticked concepts',
  });
  tick.addEventListener('change', () => {
    if (tick.checked) combineTicks.add(g.id); else combineTicks.delete(g.id);
    refreshCombine();
  });

  const head = el('div', { class: 't' }, tick,
    textInput(g.term, (v) => {
      commit('Rename concept', (mm) => { renameConcept(mm, g.id, v); });
      renderGlossary(); renderCanvas();
    }, { title: 'Renaming carries every box and arrow that denotes this concept along' }));

  if (bundle) {
    head.appendChild(el('button', {
      class: 'xbtn', text: 'Un-combine',
      title: n ? 'Dissolve this bundle; its members stand on their own again, and it stays as the concept its own arrows denote'
        : 'Dissolve this bundle; its members stand on their own again',
      onclick: () => { uncombineBundle(g.id); },
    }));
  } else if (!n) {
    // Through `removeConcept`, the one place both apps delete a concept: a
    // member is dropped from its bundle's list as it goes.
    head.appendChild(el('button', {
      class: 'xbtn', text: '\u2715', title: 'Remove \u2014 nothing uses this concept',
      onclick: () => { commit('Remove concept', (mm) => { removeConcept(mm, g.id); }); renderGlossary(); },
    }));
  }

  const use = n ? `used ${n}\u00d7` : 'unused';
  const item = el('div', { class: 'gl-item', style: depth ? `margin-left:${depth * 12}px` : null }, head,
    el('div', { class: 'd' },
      selectInput(g.kind, GLOSSARY_KINDS, (v) => {
        commit('Set concept kind', (mm) => { const c = conceptById(mm, g.id); if (c) c.kind = v; });
        renderGlossary();
      }),
      el('span', { class: 'gl-use', text: bundle ? `bundle of ${g.members.length} \u00b7 ${use}` : use })),
    textArea(g.definition, (v) => {
      commit('Define concept', (mm) => { const c = conceptById(mm, g.id); if (c) c.definition = v; });
      renderGlossary();
    }, 2));

  if (onCycle(m, g)) {
    item.appendChild(el('p', { class: 'empty', text: `⚠ Bundle “${g.term}” contains itself through its members. Un-combine it to break the cycle.` }));
  }

  if (n) {
    const occ = el('div', { class: 'gl-occ' });
    for (const o of occurrencesOf(m, g.id)) {
      occ.appendChild(el('button', {
        class: 'occ', text: `${o.node} ${o.kind === 'box' ? '\u25ad' : '\u2192'}`,
        title: `${o.text} on ${o.node}`,
        onclick: () => {
          goToDiagram(o.diagramId);
          set({ selection: { kind: o.kind, id: o.id } });
          renderCanvas();
        },
      }));
    }
    item.appendChild(occ);
  }

  if (bundle) {
    const members = el('div', { class: 'gl-members', style: 'margin-top:6px' });
    path.add(g.id);
    for (const id of g.members) {
      const c = conceptById(m, id);
      if (!c) { members.appendChild(el('p', { class: 'empty', text: `(member ${id} is not in the glossary)` })); continue; }
      if (path.has(c.id)) { members.appendChild(el('p', { class: 'empty', text: `${c.term} \u2014 contains this bundle (cycle)` })); continue; }
      members.appendChild(conceptRow(m, usage, c, depth + 1, path, refreshCombine));
    }
    path.delete(g.id);
    item.appendChild(members);
  }
  return item;
}

/**
 * Why `combineConcepts(m, ids, \u2026)` would refuse, as a sentence for the status
 * line, or null when it would go ahead \u2014 the same checks, in the same order,
 * so the hint names the concept at fault instead of a bare "refused".
 */
export function combineRefusal(m, memberIds) {
  const ids = [];
  for (const id of memberIds || []) if (!ids.includes(id)) ids.push(id);
  if (ids.length < 2) return 'Tick at least two concepts to combine them.';
  for (const id of ids) {
    const c = conceptById(m, id);
    if (!c) return 'One of those concepts is no longer in the glossary.';
    const b = bundleOf(m, id);
    if (b) return `\u201c${c.term}\u201d is already in the bundle \u201c${b.term}\u201d. Un-combine that first.`;
  }
  return null;
}

/**
 * Combine the concepts `ids` (in that order) into a new bundle: ask for its
 * term \u2014 the member terms joined by " & " to start with \u2014 then commit
 * `combineConcepts`. Cancelling the prompt, a blank term, or a refusal (shown
 * as a hint) changes nothing. Resolves to the bundle, or null.
 */
async function combineIds(ids) {
  const refusal = combineRefusal(store.model, ids);
  if (refusal) { set({ hint: refusal }); return null; }
  const terms = ids.map((id) => conceptById(store.model, id).term);
  const term = await promptText('Combine concepts', 'Term for the bundle \u2014 the general label its members share:', terms.join(' & '));
  if (term == null) return null;
  if (!term.trim()) { set({ hint: 'A bundle needs a term.' }); return null; }
  const bundle = commit('Combine Concepts', (mm) => combineConcepts(mm, ids, term));
  if (!bundle) { set({ hint: combineRefusal(store.model, ids) || 'Those concepts cannot be combined.' }); return null; }
  for (const id of ids) combineTicks.delete(id);
  set({ hint: `Combined ${terms.length} concepts into \u201c${bundle.term}\u201d.` });
  renderGlossary(); renderCanvas();
  return bundle;
}

/** "Combine selected": the ticked concepts, in glossary order. */
function combineTicked() {
  return combineIds(store.model.glossary.filter((g) => combineTicks.has(g.id)).map((g) => g.id));
}

/**
 * Dissolve a bundle (`uncombineConcept`) \u2014 one "Un-combine Concept" edit,
 * as on the Mac, with nothing to confirm: nothing bound to a member changes,
 * and an arrow bound to the bundle itself (drawn from its port) keeps a
 * concept to denote, since the core then keeps the entry as a plain concept
 * rather than leaving the arrow dangling. Returns true when the bundle was
 * dissolved.
 */
function uncombineBundle(bundleId) {
  const m = store.model;
  const b = conceptById(m, bundleId);
  if (!isBundle(b)) { set({ hint: 'That concept is not a bundle.' }); return false; }
  const dissolved = commit('Un-combine Concept', (mm) => uncombineConcept(mm, bundleId));
  if (!dissolved) { set({ hint: 'That concept is not a bundle.' }); return false; }
  const kept = !!conceptById(store.model, bundleId);
  set({ hint: `Un-combined \u201c${b.term}\u201d; its members stand on their own again${kept ? `, and \u201c${b.term}\u201d stays as the concept its own arrows denote` : ''}.` });
  renderGlossary(); renderCanvas();
  return true;
}

/* ------------------------------------------------------------- inspector */

export function renderProps() {
  const host = document.getElementById('props');
  clear(host);
  const m = store.model;
  const dg = currentDiagram();
  if (!dg) return;
  const sel = store.ui.selection;

  if (sel?.kind === 'box') { renderBoxProps(host, m, dg, findBox(dg, sel.id)); return; }
  if (sel?.kind === 'arrow') { renderArrowProps(host, m, dg, dg.arrows.find((a) => a.id === sel.id)); return; }
  renderDiagramProps(host, m, dg);
}

function renderDiagramProps(host, m, dg) {
  const parent = dg.parentBoxId ? findBoxAnywhere(m, dg.parentBoxId) : null;
  host.append(
    el('h3', { class: 'sect', text: 'Diagram' }),
    stat('Node', dg.node),
    stat('Boxes', `${dg.boxes.length}${dg.node === 'A-0' ? '' : ` (want ${DECOMP_MIN}–${DECOMP_MAX})`}`),
    stat('Arrows', dg.arrows.length),
    field('Title', textInput(dg.title, (v) => {
      commit('Rename diagram', (mm) => {
        const d = mm.diagrams[dg.id];
        d.title = v;
        d.titleLocked = !!v.trim();
      });
      renderCanvas();
    })),
    field('C-Number', textInput(dg.cNumber, (v) => { commit('Set C-number', (mm) => { mm.diagrams[dg.id].cNumber = v; }); renderCanvas(); })),
  );

  if (parent) {
    host.append(el('h3', { class: 'sect', text: 'Parent' }),
      el('button', {
        class: 'btn', text: `↑ Go to ${parent.diagram.node} — box ${parent.box.number}`,
        onclick: () => { goToDiagram(parent.diagram.id); set({ selection: { kind: 'box', id: parent.box.id } }); renderCanvas(); },
      }));
  }

  host.append(el('h3', { class: 'sect', text: 'Boundary arrows (ICOM)' }));
  const codes = icomCodes(m, dg);
  const rows = [];
  for (const a of dg.arrows) {
    for (const which of ['from', 'to']) {
      const e = a[which];
      if (e.type !== 'boundary') continue;
      rows.push({ code: codes?.[`${a.id}:${which}`] || '—', label: a.label || '(unlabelled)', arrow: a });
    }
  }
  // Parent concepts not yet connected here are listed after the arrows, as
  // the ports they are drawn as (model.js `ports`): drag one onto a box.
  const unconnected = ports(m, dg);
  if (!rows.length && !unconnected.length) host.appendChild(el('p', { class: 'empty', text: 'None. A decomposition normally carries its parent’s ICOM arrows across the boundary.' }));
  rows.sort((p, q) => p.code.localeCompare(q.code));
  for (const r of rows) {
    host.appendChild(el('div', {
      class: 'kv', style: 'cursor:pointer',
      onclick: () => { set({ selection: { kind: 'arrow', id: r.arrow.id } }); renderCanvas(); },
    }, el('span', { class: 'mono', text: r.code }), el('span', { text: r.label })));
  }
  if (unconnected.length) {
    host.appendChild(el('p', { class: 'empty', text: `${unconnected.length} parent concept${unconnected.length === 1 ? '' : 's'} unconnected — drag each port from the sheet edge onto a box side.` }));
    for (const p of unconnected) {
      host.appendChild(el('div', { class: 'kv' },
        el('span', { class: 'mono', text: p.code }),
        el('span', { text: `${p.label || '(unlabelled)'} — unconnected` })));
    }
  }
}

function renderBoxProps(host, m, dg, box) {
  if (!box) return;
  const node = boxNode(dg, box);
  const child = childDiagram(m, box);

  host.append(
    el('h3', { class: 'sect', text: `Activity ${node}` }),
    field('Name (active verb phrase)', textInput(box.name, (v) => {
      commit('Rename box', (mm) => { renameBox(mm, dg.id, box.id, v); });
      renderCanvas();
      return findBox(store.model.diagrams[dg.id], box.id)?.name;
    })),
    stat('Box number', box.number),
    stat('Node number', node),
    field('Notes', textArea(box.note, (v) => { commit('Edit box note', (mm) => { const b = findBox(mm.diagrams[dg.id], box.id); if (b) b.note = v; }); })),
  );

  host.append(el('h3', { class: 'sect', text: 'Decomposition' }));
  if (child) {
    host.append(
      el('button', { class: 'btn', text: `↓ Open ${child.node} (${child.boxes.length} boxes)`, onclick: () => { goToDiagram(child.id); renderCanvas(); } }),
      el('div', { style: 'height:6px' }),
      el('button', {
        class: 'btn danger', text: 'Delete decomposition',
        onclick: async () => {
          if (!await confirmDialog(`Delete ${child.node} and everything below it?`, 'This cannot be undone except with Undo.')) return;
          commit('Delete decomposition', (mm) => { deleteSubtree(mm, child.id); });
          renderCanvas();
        },
      }),
    );
  } else {
    host.append(
      el('p', { class: 'empty', text: 'Not yet decomposed. A new child diagram starts with a port at its sheet edge for each of this box’s ICOM arrows, to connect to its activities.' }),
      el('button', {
        class: 'btn', text: 'Decompose…',
        onclick: async () => {
          const n = await promptNumber('Decompose', `How many child activities for ${node}?`, 3, DECOMP_MIN, DECOMP_MAX);
          if (!n) return;
          const created = commit('Decompose box', (mm) => decomposeBox(mm, mm.diagrams[dg.id], findBox(mm.diagrams[dg.id], box.id), n));
          goToDiagram(created.id);
          renderCanvas();
        },
      }),
    );
  }

  host.append(el('h3', { class: 'sect', text: 'Arrows on this box' }));
  const touching = arrowsTouching(dg, box.id);
  if (!touching.length) host.appendChild(el('p', { class: 'empty', text: 'None. IDEF0 requires at least one control and one output.' }));
  for (const a of touching) {
    const role = a.to.type === 'box' && a.to.boxId === box.id
      ? ROLE_LABEL[SIDE_ROLE[a.to.side]]
      : ROLE_LABEL[a.from.side === 'bottom' ? 'call' : 'output'];
    host.appendChild(el('div', {
      class: 'kv', style: 'cursor:pointer',
      onclick: () => { set({ selection: { kind: 'arrow', id: a.id } }); renderCanvas(); },
    }, el('span', { text: role }), el('span', { text: a.label || '(unlabelled)' })));
  }

  // Boxes are never placed by hand (S01): the staircase lays them out in
  // number order, so the only thing to change is a box's place in that
  // order. `moveBox` swaps numbers with the neighbour and lays out again.
  const order = sortedBoxes(dg);
  const at = order.findIndex((b) => b.id === box.id);
  const isRoot = dg.id === m.rootDiagramId;
  const shift = (by) => {
    commit('Move Activity', (mm) => moveBox(mm, mm.diagrams[dg.id], box.id, by));
    renderCanvas();
  };
  host.append(
    el('h3', { class: 'sect', text: 'Order' }),
    el('p', { class: 'empty', text: 'Boxes sit on the staircase in number order; moving one earlier or later renumbers and lays the diagram out again.' }),
    el('div', { class: 'row' },
      el('button', { class: 'btn', text: 'Move earlier', title: 'Swap with the box before it', disabled: isRoot || at <= 0, onclick: () => shift(-1) }),
      el('button', { class: 'btn', text: 'Move later', title: 'Swap with the box after it', disabled: isRoot || at < 0 || at >= order.length - 1, onclick: () => shift(1) })),
  );
}

/**
 * A number field that commits on `change`, the way the Mac's CommitNumberField
 * does: text that is not a finite number (an emptied field reads as NaN)
 * shows the value again instead of writing 0, and the same number is not
 * committed back. The field shows the value in full (String(n), the web's
 * jsNumberString), never rounded, so re-entering what it shows can never
 * rewrite a fractional stored coordinate. `onchange` may return the number
 * the model now holds (a position is kept off the corners), which the field
 * then shows; a caller that shows a rounded figure passes and returns it
 * rounded, as the Mac's Position field does.
 */
function numInput(value, onchange) {
  const i = el('input', { type: 'number', value: String(value), step: 5 });
  i.addEventListener('change', () => {
    const v = i.valueAsNumber;
    if (Number.isFinite(v) && v !== value) {
      const stored = onchange(v);
      if (Number.isFinite(stored)) value = stored;
    }
    i.value = String(value);
  });
  return i;
}

function renderArrowProps(host, m, dg, arrow) {
  if (!arrow) return;
  const role = arrowRole(arrow);
  const codes = icomCodes(m, dg);

  // Commit `fn` on the arrow, if the diagram still has it; hands back what `fn` returns.
  const editArrow = (label, fn) => {
    const result = commit(label, (mm) => { const a = mm.diagrams[dg.id].arrows.find((x) => x.id === arrow.id); return a ? fn(a, mm) : undefined; });
    renderCanvas();
    return result;
  };

  host.append(
    el('h3', { class: 'sect', text: `${ROLE_LABEL[role]} arrow` }),
    field('Label (noun phrase)', textInput(arrow.label, (v) => editArrow('Label arrow', (a, mm) => { labelArrow(mm, dg.id, arrow.id, v); return a.label; }))),
    endpointEditor('Source', dg, arrow, 'from', codes, editArrow),
    endpointEditor('Destination', dg, arrow, 'to', codes, editArrow),
  );
  renderArrowConcept(host, m, dg, arrow);

  // FIPS 183 §3.4.2 bars a tunnel only at an unconnected (boundary) end: A-0
  // has no parent to hide it from. A tunnel at a box end is ordinary notation
  // (§3.3.2.9) that happens to be moot on A-0, so its checkbox still shows —
  // an imported file can already carry one, and this is the only way to
  // clear it. Routing and notes are not about the parent, so they stay too.
  const isRoot = dg.id === m.rootDiagramId;
  if (!isRoot || arrow.from.type === 'box' || arrow.to.type === 'box') host.append(
    el('h3', { class: 'sect', text: 'Tunnelling' }),
    el('p', { class: 'empty', text: 'A tunnel means the arrow is deliberately absent from the connected diagram — it is not an inconsistency.' }),
    ...(!isRoot || arrow.from.type === 'box'
      ? [checkbox('Tunnel at source ( )', arrow.tunnelFrom, (v) => editArrow('Tunnel arrow', (a) => { a.tunnelFrom = v; }))]
      : []),
    ...(!isRoot || arrow.to.type === 'box'
      ? [checkbox('Tunnel at destination ( )', arrow.tunnelTo, (v) => editArrow('Tunnel arrow', (a) => { a.tunnelTo = v; }))]
      : []),
  );
  host.append(
    el('h3', { class: 'sect', text: 'Routing' }),
    el('button', { class: 'btn', text: 'Reset bend & label offset', onclick: () => editArrow('Reset routing', (a) => { a.bend = null; a.ldx = 0; a.ldy = 0; }) }),
    el('div', { style: 'height:6px' }),
    el('button', {
      class: 'btn', text: '⇄ Reverse direction',
      onclick: () => editArrow('Reverse arrow', (a) => {
        const f = a.from; a.from = a.to; a.to = f;
        const t = a.tunnelFrom; a.tunnelFrom = a.tunnelTo; a.tunnelTo = t;
        a.bend = null;
      }),
    }),
    field('Notes', textArea(arrow.note, (v) => editArrow('Edit arrow note', (a) => { a.note = v; }), 2)),
  );
}

/**
 * The arrow's concept and the bundle it belongs to, if any (S01): "Bundle:
 * <term>" with Un-combine when the arrow's effective concept (the outermost
 * bundle holding its own) differs from its own — or when its own concept is
 * a bundle, as an arrow drawn from a bundle's port is bound. Otherwise
 * "Combine with…" offers the other concepts arrows on this diagram denote,
 * and combining goes through the same prompt as the glossary's button: this
 * is how two concepts are picked and combined from the canvas.
 */
function renderArrowConcept(host, m, dg, arrow) {
  const own = conceptById(m, arrow.conceptId);
  host.append(el('h3', { class: 'sect', text: 'Concept' }));
  if (!own) {
    host.append(el('p', { class: 'empty', text: arrow.conceptId ? 'Bound to a concept the glossary no longer has; relabel the arrow to bind it again.' : 'Unbound until the arrow is labelled.' }));
    return;
  }
  host.append(stat('Concept', own.term));
  const effId = effectiveConceptId(m, own.id);
  const bundle = effId !== own.id ? conceptById(m, effId) : (isBundle(own) ? own : null);
  if (bundle) {
    host.append(
      stat('Bundle', bundle.term),
      el('p', { class: 'empty', text: `Members: ${bundle.members.map((id) => conceptById(m, id)?.term ?? id).join(', ')}` }),
      el('button', { class: 'btn', text: 'Un-combine', onclick: () => { uncombineBundle(bundle.id); } }),
    );
    return;
  }
  // The other object concepts on this diagram, each as the thing that can
  // actually be combined: an arrow bound to a bundle's member stands for the
  // bundle (its effective concept, which may itself be nested further), since
  // the member alone would only be refused.
  const others = [];
  for (const a of dg.arrows) {
    const c = a.conceptId ? conceptById(m, effectiveConceptId(m, a.conceptId)) : null;
    if (c && c.id !== own.id && !others.some((x) => x.id === c.id)) others.push(c);
  }
  others.sort((p, q) => TERM_ORDER.compare(p.term, q.term));
  if (!others.length) {
    host.append(el('p', { class: 'empty', text: 'No other concept on this diagram to combine with.' }));
    return;
  }
  const pick = selectInput('', [{ value: '', label: 'Choose a concept…' }, ...others.map((c) => ({ value: c.id, label: c.term }))], async (otherId) => {
    if (!otherId) return;
    const done = await combineIds([own.id, otherId]);
    if (!done) pick.value = '';
  });
  host.append(field('Combine with…', pick));
}

// Pinned to en-US, as the glossary sort is (concepts.js), so the list reads
// the same on every machine.
const TERM_ORDER = new Intl.Collator('en-US');

function endpointEditor(title, dg, arrow, which, codes, editArrow) {
  const e = arrow[which];
  const wrapEl = el('div', {});
  const desc = e.type === 'boundary'
    ? `Sheet boundary · ${codes?.[`${arrow.id}:${which}`] || '—'}`
    : `Box ${findBox(dg, e.boxId)?.number ?? '?'} — ${findBox(dg, e.boxId)?.name || '(unnamed)'}`;

  wrapEl.append(
    el('div', { class: 'kv' }, el('span', { text: title }), el('span', { text: desc })),
    el('div', { class: 'row' },
      field('Side', selectInput(e.side, ['left', 'top', 'right', 'bottom'], (v) => editArrow('Move arrow end', (a) => { a[which].side = v; a.bend = null; }))),
      field('Position', numInput(Math.round(e.pos * 100), (v) => editArrow('Move arrow end', (a) => {
        a[which].pos = Math.min(0.98, Math.max(0.02, v / 100));
        return Math.round(a[which].pos * 100);
      })))),
  );
  return wrapEl;
}

/* ---------------------------------------------------------------- checks */

export function renderChecks() {
  const host = document.getElementById('checks');
  const badge = document.getElementById('checkcount');
  clear(host);
  // The model's own rules, plus the two web-only checks about the copy in the
  // workspace. They are merged here rather than added to src/model/validate.js
  // because that file is mirrored byte for byte by the Swift port and pinned by
  // goldens; see src/sync/checks.js for the whole argument.
  const issues = [...store.issues, ...syncIssues(syncSnapshot())];
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;

  badge.textContent = issues.length ? String(issues.length) : '✓';
  badge.className = `badge ${errors ? 'error' : warnings ? 'warning' : 'ok'}`;

  host.append(el('div', { class: 'kv' },
    el('span', { text: 'Rule violations' }),
    el('span', { class: 'mono', text: `${errors} error · ${warnings} warning` })));

  if (!issues.length) {
    host.appendChild(el('p', { class: 'empty', text: 'The model satisfies every check: box counts, box names, required controls and outputs, arrow labels, arrow attachment sides, node numbering and parent/child ICOM consistency.' }));
    return;
  }

  for (const i of issues) {
    const dgNode = i.diagramId ? store.model.diagrams[i.diagramId]?.node : '';
    host.appendChild(el('div', {
      class: `issue ${i.severity}`,
      onclick: () => {
        if (i.diagramId) goToDiagram(i.diagramId);
        if (i.kind && i.id) set({ selection: { kind: i.kind, id: i.id } });
        renderCanvas();
      },
    },
    el('div', { class: 'where', text: `${dgNode || 'model'} · ${i.code}` }),
    el('div', { class: 'msg', text: i.message })));
  }
}

/* -------------------------------------------------------------- statusbar */

export function renderStatus() {
  const host = document.getElementById('statusbar');
  clear(host);
  const dg = currentDiagram();
  const m = store.model;
  const sel = store.ui.selection;
  let what = 'nothing selected';
  if (sel?.kind === 'box') {
    const b = findBox(dg, sel.id);
    if (b) what = `box ${b.number} — ${boxNode(dg, b)}${b.name ? ` — ${b.name}` : ''}`;
  } else if (sel?.kind === 'arrow') {
    const a = dg.arrows.find((x) => x.id === sel.id);
    if (a) what = `${ROLE_LABEL[arrowRole(a)].toLowerCase()} — ${a.label || 'unlabelled'}`;
  }
  // A child diagram reports its parent's concepts not yet connected here —
  // the ports drawn at the sheet edge — after the counts, for as long as any
  // remain (S01).
  const unconnected = dg ? ports(m, dg).length : 0;
  const counts = `${plural(dg ? dg.boxes.length : 0, 'box', 'boxes')} · ${plural(dg ? dg.arrows.length : 0, 'arrow', 'arrows')}`
    + (unconnected ? ` · ${plural(unconnected, 'parent concept', 'parent concepts')} unconnected` : '');
  const idle = store.ui.tool === 'arrow'
    ? 'Arrow tool: click a source, then a destination.'
    : `Drag to pan · scroll to zoom · double-click to rename${unconnected ? ' · drag a port onto a box side to connect it' : ''}`;
  const parts = [
    el('span', {}, el('b', { text: dg ? dg.node : '—' }), ' ', dg ? dg.title || '' : ''),
    el('span', { text: counts }),
    el('span', { text: what }),
    el('span', { text: `${Math.round(store.ui.view.scale * 100)}%` }),
    el('span', { text: store.ui.hint || idle }),
  ];
  if (store.ui.dirty) parts.push(el('span', { text: '• unsaved changes' }));
  host.append(...parts);
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
