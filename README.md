# IDEF0 Modeler

A browser-based editor for IDEF0 function models (FIPS PUB 183 / IEEE 1320.1):
context diagrams, decompositions, ICOM arrows, tunnelling, node numbering, rule
checking, and export to SVG / PNG / PDF, XML and a written report. A native
macOS app and an `idef0` command-line tool share the same model format and the
same rule set — see [macOS app and command line](#macos-app-and-command-line).

No build step, no package manager, no dependencies — plain ES modules and SVG.

## Running it

```bash
./serve.sh
```

Then open <http://localhost:8123>. (ES modules need `http://`; opening
`index.html` from the filesystem will not work. Any static server does —
`./serve.sh` just wraps `python3 -m http.server`.)

The app opens on a worked sample model. `File ▸ New model` starts an empty one.

## What it enforces

The **Checks** panel re-runs on every edit and reports, with a click-through to
the offending box or arrow. The command-line `idef0 validate --json` (see
[macOS app and command line](#macos-app-and-command-line)) reports the same
findings; every `code` below is a stable identifier shared by the web Checks
panel, the Mac Checks panel and that JSON output, so a downstream tool can key
off the code rather than parse the message text.

Most rules are FIPS 183's own; a few, whose Basis reads `toolkit`, exist
because this model feeds a concept registry other tools read, and have no
FIPS clause of their own.

| Code | Level | Rule | Basis |
|---|---|---|---|
| `no-context` | error | The model has no A-0 context diagram | structural |
| `model-purpose` | warning | The model states no purpose | FIPS 183 (every model states a purpose) |
| `model-viewpoint` | warning | The model states no viewpoint | FIPS 183 (every model states a viewpoint) |
| `model-title` | warning | The model has no title | toolkit |
| `node-dup` | error | A node number is used by more than one diagram | structural |
| `ctx-single-box` | error | A-0 holds anything but exactly one box | FIPS 183 §3.3.3 rule 4 |
| `decomp-count` | warning under 3 boxes, error over 6 | A decomposition should hold 3–6 boxes | FIPS 183 §3.3.3 rule 4 |
| `box-number-dup` | error | A box number appears twice on one diagram | structural |
| `box-number-range` | error | A box number is outside what IDEF0 allows (0 on A-0, 1–6 elsewhere) | structural |
| `box-number-order` | warning | Box numbers do not follow the diagram's reading order | FIPS 183 §3.3.4.1 |
| `box-name` | error | A box is unnamed | FIPS 183 §3.2.2.2 |
| `reserved-term` | error | A box name, or an arrow label, is a bare reserved IDEF0 word | FIPS 183 §3.3.3 rule 15 (box) / §3.2.2.3 rule 5 (arrow) |
| `box-verb` | warning | A box name may not be an active verb phrase | FIPS 183 §3.2.2.2 |
| `box-name-fit` | warning | A box is too small to show its full name at any size the renderer will try | FIPS 183 §3.2.1.3 |
| `box-control` | error | A box has no control arrow | FIPS 183 (every activity needs a control) |
| `box-output` | error | A box has no output arrow | FIPS 183 (every activity needs an output) |
| `box-call-count` | error | A box has more than one call arrow | FIPS 183 §3.3.3 rule 11 |
| `call-decomposed` | error | A box with a call arrow also has a child diagram of its own | FIPS 183 §3.3.2.10 |
| `concept-unbound` | error | A named box, or a labelled arrow, is not bound to a glossary concept | toolkit |
| `concept-kind` | warning | A box is bound to a data or mechanism concept, or an arrow to an activity concept | FIPS 183 §3.2.2 |
| `arrow-label` | error | An arrow carries no label | FIPS 183 (arrow labels are noun phrases) |
| `arrow-dangling` | error | An arrow points at a box that no longer exists | toolkit |
| `arrow-passthrough` | error | An arrow runs boundary to boundary without touching a box | structural |
| `boundary-direction` | error | A boundary arrow enters or leaves the wrong way for its edge | FIPS 183 §3.3.2.7–8 |
| `arrow-origin` | error | An arrow leaves a box from its left or top | structural (arrows leave a box only from the right or bottom) |
| `call-target` | error | A call arrow ends at a box instead of unconnected | FIPS 183 §3.2.2.3 |
| `arrow-target` | error | An arrow enters a box on its right | structural (the right side carries outputs only) |
| `arrow-self` | error | An arrow starts and ends on the same box | structural |
| `ctx-tunnel` | error | An arrow is tunnelled on the A-0 context diagram | structural (A-0 has no parent to tunnel against) |
| `id-dup` | error | A box, arrow or concept id is used more than once in the model | toolkit |
| `detail-dangling` | error | A box names a detail diagram the model does not hold | toolkit |
| `detail-parent` | error | A detail diagram is claimed by more than one box, or does not name its claimed parent back | toolkit |
| `decomp-cycle` | error | A diagram is detailed by one of its own ancestors | structural (the decomposition tree cannot cycle) |
| `diagram-unreachable` | warning | A diagram is not reached from A-0 through any decomposition | structural |
| `icom-orphan` | error | A child's boundary arrow has no matching arrow on its parent box | FIPS 183 §3.3.2.8 |
| `icom-missing` | error | A parent box's arrow has no matching boundary arrow on the child diagram (it waits there as a [port](#parent-concepts-arrive-as-ports) until connected) | FIPS 183 §3.3.2.8 |
| `icom-relabel` | warning | A paired child arrow's label differs from its parent's | FIPS 183 §3.3.2.4 |
| `icom-concept-mismatch` | warning | The two ends of an ICOM pair are bound to different concepts | FIPS 183 §3.3.2.4, toolkit |
| `concept-undefined` | warning | A concept the model uses has no glossary definition | FIPS 183 §3.2.2.1, toolkit |
| `bundle-member-dup` | error | A concept is listed in two bundles, or twice in one | FIPS 183 §3.2.2.3 (a concept belongs to at most one bundle) |
| `bundle-cycle` | error | A bundle contains itself through its members | structural |
| `bundle-thin` | warning | A bundle has fewer than two members that name a glossary concept | FIPS 183 §3.2.2.3 (a bundle combines at least two concepts) |
| `bundle-mixed-kind` | warning | A bundle combines concepts of different kinds | toolkit |
| `provenance-date` | error | A box, arrow, diagram or concept records a change or removal time that is not an ISO-8601 instant | toolkit |
| `provenance-order` | error | An element records being removed before its own last change | toolkit |

Arrow roles are not stored — they are *derived* from which side of the box the
arrow touches, so an input can never accidentally be recorded as a control.

Node numbers are derived too. The context box is `A0`; the boxes of `A0` are
`A1…A6`; below that the parent's node is extended, so box 2 of `A3` is `A32`.
Box numbers are the reading order of the staircase, and the staircase is laid
out from the numbers (see [Editing](#editing)), so **moving a box earlier or
later renumbers the diagram and the branch below it** — that is the IDEF0
convention, and ⌘Z undoes it.

**ICOM coding.** Boundary arrows are numbered per side, left to right or top
to bottom (FIPS 183 §3.3.2.8), into `I1`, `I2` / `C1`, `C2` / `O1`, `O2` /
`M1`, `M2`; a call arrow leaving a box's bottom carries no code at all
(§3.3.2.10). Several arrows on one box side that denote the same glossary
concept — or concepts combined into the same [bundle](#bundles) — are one
arrow forked or joined at the box (§3.3.3 rule 14) and share a single code,
numbered by the earliest of them — and are drawn that way, as one line that
branches (see **Forks and joins** below). A child diagram's boundary arrow may also
change role from its parent's: an input, control or mechanism arriving on the
parent's left, top or bottom may reappear on a different one of those three
sides in the child (§3.3.2.8, Figure 15) as long as the two denote the same
concept — outputs never change role.

**Tunnelling** (drawn as parentheses on the arrow end) marks an arrow as
deliberately absent from the connected diagram, and excludes that end from the
parent/child consistency check.

## Editing

| | |
|---|---|
| Select a box or an arrow | click it |
| Rename a box, label an arrow | double-click it, or select and press Enter |
| Add a box | `B` — it takes the next place on the staircase |
| Reorder boxes | Move earlier / Move later in the Properties panel |
| Lay the diagram out again | Arrange, on the toolbar |
| Draw an arrow | `A`, then click the source and the destination |
| Boundary arrow | start or end the arrow on the edge of the drawing area |
| Connect a parent concept | drag its port from the sheet edge onto a box side |
| Re-route an arrow | drag the diamond handle; drag either end to re-attach |
| Fork or join arrows | draw the branches from the same box side (or into it) with the same label; they draw as one line that branches |
| Move a label | drag it |
| Combine concepts into a bundle | tick them in the Glossary panel, then Combine selected; or Combine with… in an arrow's Properties |
| Un-combine a bundle | Un-combine, on the bundle's Glossary row or in an arrow's Properties |
| Open a decomposition | Alt + double-click a box, or the node tree |
| Up to the parent | `Esc`, or the ↑ Parent button |
| Delete | `Delete` / `Backspace` |
| Undo / redo | ⌘Z / ⇧⌘Z |
| Pan / zoom | drag the background, scroll; ⌘0 fits the sheet |

Unsaved work is autosaved to this browser's local storage and offered back on
the next visit. A browser only keeps that copy if it has agreed to: by default
site storage is best-effort and can be evicted when the disk runs short, so on
launch the app asks for persistent storage and the Model panel's **This
browser** section reports the answer — *Persisted*, or *At risk* with the one
thing that changes it (install the app from the browser's menu; on iPhone add
it to the Home Screen). Nothing waits on that question, and a browser too old
to be asked is simply not asked. The file you save is still the copy that
outlives any browser.

### Activities are laid out for you

Boxes are never moved or resized by hand: there are no move or resize drags,
no handles and no coordinate fields. An activity is added, deleted or moved
earlier or later in the reading order, and the software places the boxes
itself, along the staircase diagonal from the upper left to the lower right in
box-number order (FIPS 183 §3.3.4.1), sized so that the six boxes a
decomposition may hold still fit. The layout is recomputed on each of those
structural edits and when you press **Arrange**, and at no other time — in
particular **never when a file is opened**, so a model laid out by hand in an
earlier version opens, checks and saves byte for byte as it was until one of
its activities is edited. The A-0 context diagram is never laid out: its single
box stays where it is.

### Parent concepts arrive as ports

Decomposing a box gives the child diagram its boxes but no arrows. Each ICOM
arrow on the parent box (every one except a call arrow, and except one
tunnelled at the box, which is deliberately absent from the child) instead
appears on the child as a **port** at the sheet edge — a dashed stub with an open circle, its
ICOM code and its label — on the edge its role enters or leaves by: inputs on
the left, controls on the top, mechanisms on the bottom, outputs on the right.
Drag the port onto a box side and the arrow is drawn from that boundary point
to the box, labelled with the parent's label and bound to the parent's
concept (or, when the parent's concept is in a [bundle](#bundles), the
bundle's term and the bundle itself); drop it anywhere else and nothing
happens. Any box side accepts the
drop — whether the role fits is the checker's business, as for any arrow.
Delete that arrow and the port comes back.

Ports are derived from the parent on every redraw; nothing about them is
stored, they cannot be selected, and arrows route straight through them. The
SVG, PNG and PDF pictures draw them exactly as the screen does; the XML, the
report and the IDL listing never mention them, since a port is not an arrow
and has no ICOM data of its own. A child diagram reports how many parent concepts are
still unconnected, and each one is still the `icom-missing` error above,
because FIPS 183 requires the match before the model is done — a port is only
the way to fix it. A-0, having no parent, has no ports.

### Bundles

FIPS 183 §3.2.2.3 lets one arrow stand for several: the general arrow carries
a general label, and where it forks the branches carry the specific ones.
Here that is a **bundle** — a glossary concept that combines two or more other
concepts, its *members*. Combine concepts by ticking them in the Glossary
panel and pressing **Combine selected**, or from a selected arrow's
Properties with **Combine with…** (which offers the other concepts the
diagram's arrows denote); either way you are asked for the bundle's term
(the members' terms joined by " & " to start with; a blank term is refused).
The bundle takes its members' kind when they agree and `other` otherwise. A
concept belongs to at most one bundle at a time (combining one that already
does is refused — un-combine that bundle first); bundles may themselves be
combined, and a bundle can never contain itself.

Boxes and arrows keep the *specific* concept they always denoted — combining
never rewrites an occurrence. What changes is how the diagrams read:

- Arrows on one diagram whose concepts are members of the same bundle, and
  that run between the same faces (the same endpoint types, boxes and sides,
  at any position), are drawn as **one** arrow carrying the bundle's term. A
  member alone on its faces keeps its own specific label — the general label
  on the merged arrow, the specific ones on the branches, as the standard has
  it.
- A box side carries **one ICOM code per bundle**, and a bundled ICOM entry
  on a parent box is a **single port** on the child, carrying the bundle's
  term; connecting it draws the general arrow, bound to the bundle itself. A
  member can still be drawn on its own from the glossary afterwards.
- The Glossary panel lists a bundle's members nested beneath it, so every
  concept is listed once.

**Un-combine** (on the bundle's Glossary row, or in the Properties of any
arrow the bundle covers) dissolves it: the members stand on their own again,
and the arrows read exactly as they did before, since none of them changed.
If the bundle was itself a member of a larger bundle, its members take its
place there. The bundle's own glossary entry is removed when nothing uses it;
if a box or an arrow is bound to it (an arrow drawn from a bundle's port, say),
the entry is kept as a plain concept — still a member of any larger bundle,
its former members now listed beside it — so nothing is ever left dangling.
Deleting a member concept drops it from its bundle's list. Renaming a concept
onto another's term merges the two as before, and rewrites every members list
to match; merging a bundle into one of its own members, or two members of
different bundles into one, is refused.

In the file a bundle is just its glossary entry with a `members` list of
concept ids (written only when non-empty); a concept with no `members` is a
plain concept. See [Concepts, not just labels](#concepts-not-just-labels).

### Forks and joins

FIPS 183 §3.3.2.2 draws a fork as one line leaving a box that branches, and a
join as branches that merge into one line entering it. Draw the branches as
separate arrows from the same box side (or into the same side) with the same
label — the same glossary concept, or concepts in one bundle — and they are
drawn that way automatically: one trunk out of (or into) the box, branching
where the destinations part, one label on the trunk (or, when the trunk is
too short to carry the text — a boundary stub, say — on the first branch's
line), and one ICOM code where the trunk meets the sheet edge. A branch whose
label differs from the trunk's
(a bundle member keeping its specific label) shows it on its own branch. The
file records each branch as its own arrow, with its own position on the side;
dragging a trunk's end moves every branch together, while dragging it onto
another side or box takes only that arrow out of the group.

## Files

| | |
|---|---|
| `*.idef0.json` | native project file — the canonical format, plain JSON, diff-friendly |
| `*.idef0.xml` | XML interchange; a current-version file round-trips exactly, with two narrow, documented exceptions ([schema](doc/idef0-xml.md)) |
| `*.svg` / `*.png` | one diagram, exactly as drawn on screen |
| PDF | the current diagram or the whole kit, one landscape page each, via the browser's print dialog (choose *Save as PDF*) |
| `*-report.md` / `.html` | node index, per-diagram activity and arrow tables, glossary, rule-check results |
| IDL listing | a FIPS 183-style textual node/ICOM listing (export only) |

Open a model with `File ▸ Open`, or drop the file anywhere on the window.

Note on XML: there is no single universally implemented "IDEF0 XML" — FIPS 183
standardises the graphic language and the IDL text form, not an XML schema, and
the commercial tools each shipped their own. The format here is documented in
[`doc/idef0-xml.md`](doc/idef0-xml.md) and carries the full IDEF0 semantics.

## Layout of the source

```
index.html            shell
src/main.js           entry point: wiring, keyboard shortcuts, file open, autosave recovery
src/styles.css
src/util.js           DOM/SVG builders, text wrapping, downloads
src/model/
  types.js            sheet geometry, IDEF0 vocabulary, limits
  model.js            model structure, decomposition, staircase layout, node
                      numbering, ICOM codes, ports, bundles
  geometry.js         anchor resolution, rectilinear arrow routing, port shapes
  concepts.js         the concept registry — identity behind every name and
                      label; combining and un-combining
  edits.js            naming edits (rename a box, label an arrow) as model operations
  validate.js         the rule checker
  sample.js           the worked example
src/state/store.js    state, snapshot undo/redo, autosave
src/ui/
  render.js           draws the IDEF0 sheet — shared by screen and export
  canvas.js           hit testing, arrow and port drags, arrow drawing, pan/zoom
  panels.js           node tree, model properties, glossary, inspector, checks
  toolbar.js, dialog.js
src/io/
  json.js  idef0xml.js  exportImage.js  report.js
tests/web/             fast, Swift-free tests against the web modules directly —
                       includes goldens-staleness.test.mjs (below)
macos/                 native macOS app, `idef0` CLI and Swift port of src/model
                       and src/io — see macos/README.md
  scripts/golden-harness.js   shared plumbing behind regen-goldens.sh's headless
                              fixture capture (below)
ui-kit/  sync-kit/     vendored copies of the shared kits (theme and sync
                       clients) so a clone runs with no build step and no npm
                       install; each kit's own copy script owns what lands
                       there and records the source in COPY.md — edit the kit,
                       not these folders
toolkit-app.json       the Portal contract: what this app is called, which
                       files it ships and which sync workspace it uses
src/portal.js          mounts the Portal's bar when the page is served under
                       the Portal; inert everywhere else
src/state/persistence.js    asks the browser to keep this app's data, and
                            reports whether it agreed
scripts/vendor-kits.sh      refreshes both copies, and the Mac target's
                            SCTheme.swift, from ../ui-kit and ../sync-kit;
                            `--check` fails on drift and runs from build-app.sh
                            and serve.sh
```

`render.js` is used unchanged by the exporters, so what you see on screen is
what lands in the SVG, the PNG and the PDF.

## Concepts, not just labels

The model is meant to be read by other tools, not only looked at, so every box
and arrow carries a `conceptId` into the model's concept registry (the
glossary) alongside its drawn text. Naming a box or labelling an arrow resolves
or creates the concept automatically; a child diagram's inherited boundary
arrow keeps its parent's `conceptId`, so the parent/child correspondence is
recorded rather than re-derived from matching text.

That is what makes the model analysable: occurrences of one object can be
traced across diagrams, renaming a concept carries every occurrence with it,
renaming onto an existing term merges the two, and the exported report lists
each concept with its kind, its use count and the nodes it occurs on. Labels
may still differ from the concept they denote — FIPS 183 §3.3.2.4 allows a
child to elaborate a parent's label — and the report calls those out
separately.

A [bundle](#bundles) is a concept like any other, with one extra field:
`members`, the ids of the concepts it combines, in order. It is written only
when non-empty, after `definition`, and a concept without it is a plain
concept; a concept appears in at most one bundle's list. Boxes and arrows
never point at a bundle on a member's behalf — they keep the specific
concept's id, and the bundle is looked up from its members — so the file
records which concept each occurrence denotes, and un-combining is lossless.
The XML interchange carries the same list as `<member>` children of the
`<term>` ([schema](doc/idef0-xml.md)).

## When an element changed

A box, an arrow, a diagram and a glossary concept may each record two times:
`updatedAt`, when it last changed, and `deletedAt`, when it was removed.
Both are ISO-8601 instants with an explicit zone — `2026-09-27T14:05:00Z`, or
`2026-09-27T16:05:00+02:00` — and the rule checker reads them itself rather
than leaving it to the platform, so the two apps order any pair of them
identically. `provenance-date` above reports one it cannot read;
`provenance-order` reports a removal that predates the element's own last
change.

`deletedAt` is a tombstone: the element stays in the file, marked as gone, so
that anything comparing two copies of a model can tell "removed here" from
"never existed here". Nothing else in the app acts on it yet — opening a file
keeps it as it found it.

Neither time is ever invented. An element the file records none for is written
back with none, so a model saved before these fields existed saves byte for
byte as it did, and a file carrying them keeps them whichever app saves it.
They are written after everything else the element carries, and are absent
rather than `null` when unset. The XML interchange carries them as attributes
([schema](doc/idef0-xml.md)).

## Not yet supported

- No FEO (for-exposition-only) pages, activation rules, or call-arrow references
  to another model.
- Diagrams are one fixed landscape sheet size.

## macOS app and command line

The Swift package in `macos/` is a byte-exact port of this model — same
`.idef0.json`, same XML interchange, same rule checker and the same message
text — built into two things:

- **IDEF0 Modeler.app**, a native SwiftUI editor for macOS 14+.
- **`idef0`**, a command-line tool that checks, converts, reports on and
  renders a model without opening either app — the shape `--json` prints is a
  documented, stable contract for the ontology toolkit this project is part
  of.

Requirements are macOS 14 and a Swift 6 toolchain. Build the app with
`macos/scripts/build-app.sh` (`CONFIG`, `OUT_DIR` and `VERSION` environment
variables control the build type, output location and version string) — it
has to run as an actual `.app` bundle, because SwiftUI's `DocumentGroup` reads
its document types from `Info.plist`, so the bare built executable can
neither open nor save a model. Run the Swift test suite with `swift test`
from `macos/`.

Full detail — the CLI's commands, exit codes and exact `--json` shapes, every
keyboard shortcut, how the app opens and saves files, and the parity workflow
that keeps this Swift port in lockstep with the modules above — is in
[`macos/README.md`](macos/README.md).
