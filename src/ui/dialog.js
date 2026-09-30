// Minimal promise-based modals.
//
// While one is open it owns the keyboard: Escape dismisses it (unless the
// caller made it non-dismissable), Tab cycles inside it, and the editor's
// global shortcuts are held off by `modalOpen()`.

import { el } from '../util.js';

let openCount = 0;
let titleSeq = 0;

/** True while a modal is showing; the editor's shortcuts must not act behind it. */
export const modalOpen = () => openCount > 0;

const FOCUSABLE = 'input, textarea, select, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Show a modal built by `build(close)`. Escape and a backdrop click resolve
 * null, unless `dismissable` is false, in which case the user has to pick one
 * of the dialog's own buttons.
 */
function open(build, { dismissable = true } = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const restoreTo = document.activeElement;
    let closed = false;
    const close = (value) => {
      if (closed) return;
      closed = true;
      openCount -= 1;
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey);
      // The keyboard goes back where it was, except into a panel pane: the
      // panels are left alone while one of them holds the focus (so a field
      // being typed in survives a redraw), and the answer to a dialog opened
      // from a pane usually changes what that pane must show. A button there
      // is dropped instead, and the pane is redrawn like any other.
      if (restoreTo && restoreTo !== document.body && restoreTo.isConnected
        && typeof restoreTo.focus === 'function' && !restoreTo.closest('.tabpane')) {
        restoreTo.focus();
      }
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();                  // the editor's Escape must not also run
        e.preventDefault();
        if (dismissable) close(null);
        return;
      }
      if (e.key === 'Tab') trapTab(e, modal);
    };
    const back = el('div', {
      class: 'modal-back',
      onclick: (e) => { if (e.target === back && dismissable) close(null); },
      onmousedown: (e) => { if (e.target === back) e.preventDefault(); },   // keep the keyboard in the modal
    });
    const modal = build(close);
    describe(modal);
    back.appendChild(modal);
    openCount += 1;
    document.addEventListener('keydown', onKey);
    root.appendChild(back);
    // Prompts focus their own input; anything else starts on its safe button.
    setTimeout(() => {
      if (closed || modal.contains(document.activeElement)) return;
      const target = modal.querySelector('input, textarea, select')
        || modal.querySelector('[data-autofocus]')
        || modal.querySelector('.mfoot button');
      target?.focus();
    }, 0);
  });
}

/** Mark the modal up as a dialog named by its heading. */
function describe(modal) {
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  const h = modal.querySelector('h2');
  if (h) {
    if (!h.id) { titleSeq += 1; h.id = `modal-title-${titleSeq}`; }
    modal.setAttribute('aria-labelledby', h.id);
  }
}

/** Keep Tab / Shift+Tab cycling through the modal's own controls. */
function trapTab(e, modal) {
  const items = [...modal.querySelectorAll(FOCUSABLE)].filter((n) => !n.hidden && n.offsetParent !== null);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0], last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !modal.contains(active))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (active === last || !modal.contains(active))) { e.preventDefault(); first.focus(); }
}

/**
 * Ask a yes/no question. Resolves true for `okLabel`, false for `cancelLabel`
 * and null when dismissed. Options: `dismissable` (default true), `danger`
 * ('ok' or 'cancel': which button is the destructive one, default 'ok') and
 * `focus` ('cancel' or 'ok': which button starts focused, default 'cancel',
 * so a stray Enter never confirms).
 */
export function confirmDialog(title, body, okLabel = 'Delete', cancelLabel = 'Cancel', options = {}) {
  const { dismissable = true, danger = 'ok', focus = 'cancel' } = options;
  return open((close) => el('div', { class: 'modal' },
    el('h2', { text: title }),
    el('div', { class: 'mbody' }, el('p', { text: body })),
    el('div', { class: 'mfoot' },
      el('button', {
        class: `btn${danger === 'cancel' ? ' danger' : ''}`, text: cancelLabel,
        'data-autofocus': focus === 'cancel' ? '' : null, onclick: () => close(false),
      }),
      el('button', {
        class: `btn${danger === 'ok' ? ' danger' : ''}`, text: okLabel,
        'data-autofocus': focus === 'ok' ? '' : null, onclick: () => close(true),
      }))), { dismissable });
}

export function promptNumber(title, body, value, min, max) {
  return open((close) => {
    const input = el('input', { type: 'number', value, min, max, style: 'width:100%' });
    const ok = () => {
      const n = Math.max(min, Math.min(max, Number(input.value) || value));
      close(n);
    };
    const m = el('div', { class: 'modal' },
      el('h2', { text: title }),
      el('div', { class: 'mbody' }, el('p', { text: body }), input),
      el('div', { class: 'mfoot' },
        el('button', { class: 'btn', text: 'Cancel', onclick: () => close(null) }),
        el('button', { class: 'btn', text: 'OK', onclick: ok })));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.stopPropagation(); ok(); } });
    setTimeout(() => { input.focus(); input.select(); }, 0);
    return m;
  });
}

export function promptText(title, body, value = '') {
  return open((close) => {
    const input = el('input', { type: 'text', value, style: 'width:100%' });
    const m = el('div', { class: 'modal' },
      el('h2', { text: title }),
      el('div', { class: 'mbody' }, el('p', { text: body }), input),
      el('div', { class: 'mfoot' },
        el('button', { class: 'btn', text: 'Cancel', onclick: () => close(null) }),
        el('button', { class: 'btn', text: 'OK', onclick: () => close(input.value) })));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.stopPropagation(); close(input.value); } });
    setTimeout(() => { input.focus(); input.select(); }, 0);
    return m;
  });
}

/**
 * Pick one thing out of a grouped list — the repositories and their models, or
 * the repositories on their own.
 *
 * `groups` is `[{ name, items: [{ label, note, title, value }] }]`; a group with no
 * items is still shown, because an empty repository is a fact worth seeing.
 * Resolves the chosen `value`, or null when dismissed. The rows are buttons, so
 * the keyboard reaches them the way it reaches everything else in a modal.
 */
export function chooseDialog(title, body, groups, { empty = 'Nothing here yet.' } = {}) {
  return open((close) => {
    const list = el('div', { class: 'picklist' });
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    if (!total && !groups.length) {
      list.appendChild(el('p', { class: 'empty', text: empty }));
    }
    for (const group of groups) {
      list.appendChild(el('h3', { class: 'sect', text: group.name }));
      if (!group.items.length) list.appendChild(el('p', { class: 'empty', text: empty }));
      for (const item of group.items) {
        list.appendChild(el('button', {
          class: 'pickrow', title: item.title ?? null, onclick: () => close(item.value),
        },
        el('span', { class: 'pickname', text: item.label }),
        item.note ? el('span', { class: 'picknote', text: item.note }) : null));
      }
    }
    return el('div', { class: 'modal' },
      el('h2', { text: title }),
      el('div', { class: 'mbody' }, body ? el('p', { text: body }) : null, list),
      el('div', { class: 'mfoot' },
        el('button', { class: 'btn', text: 'Cancel', 'data-autofocus': '', onclick: () => close(null) })));
  });
}

export function showText(title, text, actions = []) {
  return open((close) => el('div', { class: 'modal' },
    el('h2', { text: title }),
    el('div', { class: 'mbody' }, el('pre', { text })),
    el('div', { class: 'mfoot' },
      ...actions.map((a) => el('button', { class: 'btn', text: a.label, onclick: () => { a.run(); } })),
      el('button', { class: 'btn', text: 'Close', 'data-autofocus': '', onclick: () => close(null) }))));
}

export function showHelp() {
  return open((close) => el('div', { class: 'modal' },
    el('h2', { text: 'IDEF0 Modeler — keys and conventions' }),
    el('div', { class: 'mbody', html: HELP_HTML }),
    el('div', { class: 'mfoot' }, el('button', { class: 'btn', text: 'Close', 'data-autofocus': '', onclick: () => close(null) }))));
}

const HELP_HTML = `
<h3 class="sect">Editing</h3>
<div class="kv"><span>Select</span><span>click a box or an arrow</span></div>
<div class="kv"><span>Rename box or label arrow</span><span>double-click it, or Enter</span></div>
<div class="kv"><span>Open a decomposition</span><span>Alt + double-click a box</span></div>
<div class="kv"><span>Add a box</span><span>B — it takes the next place on the staircase</span></div>
<div class="kv"><span>Reorder boxes</span><span>Move earlier / Move later in Properties</span></div>
<div class="kv"><span>Lay the diagram out again</span><span>Arrange, on the toolbar</span></div>
<div class="kv"><span>Draw an arrow</span><span>A, then click source and destination</span></div>
<div class="kv"><span>Connect a parent concept</span><span>drag its port from the sheet edge onto a box side</span></div>
<div class="kv"><span>Reshape an arrow</span><span>drag its end, bend or label handles</span></div>
<div class="kv"><span>Combine concepts</span><span>tick them in the Glossary, Combine selected; or Combine with… on an arrow</span></div>
<div class="kv"><span>Un-combine a bundle</span><span>Un-combine, on its Glossary row or on an arrow</span></div>
<div class="kv"><span>Delete selection</span><span>Delete / Backspace</span></div>
<div class="kv"><span>Undo / redo</span><span>⌘Z / ⇧⌘Z</span></div>
<div class="kv"><span>Pan</span><span>drag the background, or space + drag</span></div>
<div class="kv"><span>Zoom</span><span>scroll, ⌘+ / ⌘− , ⌘0 to fit</span></div>
<div class="kv"><span>Up to parent diagram</span><span>Escape</span></div>

<h3 class="sect">Placement, ports and bundles</h3>
<p>Boxes are never moved or resized by hand: the software lays them out along the staircase
in number order whenever one is added, deleted or moved earlier or later, and when you press
Arrange — never when a file is opened. A child diagram starts with no arrows: each ICOM
arrow on its parent box is shown as a <b>port</b> at the sheet edge until you drag it onto
a box side, and comes back there if that arrow is deleted. Two or more concepts can be
<b>combined</b> into a bundle (tick them in the Glossary, or use Combine with… on an arrow):
arrows of one bundle running between the same faces draw as one arrow with the bundle's
general label, while a member on its own keeps its specific label (FIPS 183 §3.2.2.3), and a
box side carries one ICOM code per bundle. Un-combining dissolves the bundle; its members and
their arrows are untouched. Arrows that leave one box side (or enter one) for the same concept
are a fork (or join) and draw as one line that branches, with one label on the trunk — or on the
first branch when the trunk is too short to carry it (FIPS 183 §3.3.2.2); dragging the trunk's
end moves every branch together.</p>

<h3 class="sect">The rules being enforced</h3>
<p>Boxes are active verb phrases and carry a number in the lower right. Arrows are noun
phrases and attach by role: <b>inputs</b> on the left, <b>controls</b> on the top,
<b>outputs</b> from the right, <b>mechanisms</b> into the bottom, <b>calls</b> out of the bottom.
Every box needs at least one control and one output. A decomposition holds three to six boxes.
A child diagram's boundary arrows must match the arrows on its parent box unless an end is
tunnelled, which is drawn as parentheses; an unconnected port is reported until it is
connected. ICOM codes (I1, C2, O1, M1…) are generated from boundary-arrow order and shown on
every child diagram.</p>
`;
