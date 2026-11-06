# IDEF0 Modeler for macOS

A native front-end to the model the [web app](../README.md) edits, and a
command-line tool for scripting and the ontology toolkit. Both are built from
the same Swift package, on top of `IDEF0Core`: a Foundation-only, byte-exact
port of `src/model` and `src/io` — the same `.idef0.json` and XML interchange
bytes, the same rule checker with the same message text and issue codes, the
same node numbering and ICOM coding, the same reports. A model checked,
converted or reported by either the app or `idef0` gives the identical
findings and bytes the web app would.

## Requirements

macOS 14 and a Swift 6 toolchain (Xcode 16 or a matching command-line-tools
install). The package has no other dependencies.

## Building the app

```
macos/scripts/build-app.sh
```

produces `macos/build/IDEF0 Modeler.app`, ad-hoc signed so a locally built
copy launches without Gatekeeper friction. Three environment variables steer
it:

| Variable | Default | |
|---|---|---|
| `CONFIG` | `release` | `swift build`'s `-c` — pass `debug` for a debug build |
| `OUT_DIR` | `macos/build` | where the `.app` is written |
| `VERSION` | `1.0` | `CFBundleShortVersionString` |

The app has to run as an actual bundle rather than the bare built executable:
SwiftUI's `DocumentGroup` reads the document types it can open from
`Info.plist`, so a binary run directly, outside a bundle, can neither open
nor save a model — `build-app.sh` writes that `Info.plist` and assembles the
bundle around the executable `swift build` produces.

`swift build --product idef0` (or `swift build` for everything) builds the
command-line tool on its own; it needs no bundle.

## Appearance and fonts

The app looks like the web app: the same dark HUD chrome from the shared
ui-kit — panels, toolbar and status bar in the palette, Orbitron for
headings, tabs and buttons, Exo 2 for text, Share Tech Mono for node numbers
and codes — and, on screen, the same dark sheet, whose boxes sit a step
lighter than the paper, with ICOM codes and the selection in the accent. The
app bundles its own copies of the three faces (OFL-licensed; the licenses
travel alongside them in `Resources/Fonts`) and registers them for its own
use only via `ATSApplicationFontsPath` in `Info.plist`, without installing
them system-wide. `Settings…` (`⌘,`) offers the same palette choice as the
web app's own theme picker, stored under the same key so it is one shared
personal preference, not part of the file format; changing it rethemes every
open window at once. The sheet's theming is a colour remap applied at draw
time on screen alone (`SheetTheme` in `IDEF0Render`): the drawing core and
its display list are untouched, and every export — SVG, PNG, PDF, and the
`idef0 render` command — prints the sheet in FIPS white and black exactly as
before, whatever the palette.

The palette itself lives in `Sources/IDEF0Modeler/SCTheme.swift`, a generated
copy of the kit's own Swift tokens rather than a hand-written file: refresh it
(and the web app's vendored `ui-kit/` and `sync-kit/`) with `scripts/vendor-kits.sh` from the
repository root when the kit changes. `build-app.sh` runs that script's
`--check` first and refuses to build a bundle whose theme has drifted from the
kit; a clone with no kit checked out beside it skips the check.

## Opening and saving files

`File ▸ Open` reads either a `.json` project file or the web app's `.idef0.xml`
interchange file. `File ▸ Import IDEF0 XML…` (`⌘⇧I`) instead reads an XML file
into a new, untitled document, never tied back to that file. Either way, the
app can only *write* `.idef0.json` — the canonical format the web app writes
— so the first save of a model that came in as XML asks where to save a new
`.idef0.json` rather than overwriting the `.xml` (use `Export ▸ IDEF0 XML
Interchange…`, or the `idef0` CLI's `convert`, to write XML back out).

The app registers as an **Alternate** handler for both `public.json` and
`public.xml` in `Info.plist` — it can open files of either type, but macOS
will not make it the default opener for plain JSON or XML just because it is
installed. Choose it per file with Finder's *Open With*, or set it as the
default for `.idef0.json`/`.idef0.xml` from a file's Get Info panel.

## Keyboard shortcuts

With the canvas focused — including the diagram-navigation chords, which the
canvas answers itself rather than as menu key equivalents, precisely so they
still move the caret, not the diagram, while a text field has focus:

| | |
|---|---|
| Select tool | `V` |
| Arrow tool | `A` |
| Add a box | `B` |
| Rename the selected box, or label the selected arrow | `Return` |
| Delete the selection | `Delete` / `Backspace` / fn-Delete |
| Cancel a pending arrow, then clear the selection, then go up a level | `Esc` |
| Pan | hold Space and drag, or scroll |
| Zoom | scroll with `⌘`/`⌃`/`⌥` held, or pinch |
| Go to the parent diagram | `⌘↑` |
| Open the selected box's child diagram | `⌘↓` |
| Go to A-0 | `⌘Home` |

Pressing on a box only selects it: boxes are never dragged, resized or given
coordinates — the staircase places them, exactly as in the web app (see the
root README's [Editing](../README.md#editing)). What the canvas does drag is
an arrow's two ends, its bend handle and its label, and a **port**: press on
a port at the sheet edge and release on a box side to draw the arrow that
parent concept is still missing here, as one undo step. Releasing anywhere
else connects nothing. Ports cannot be selected.

Menu shortcuts, which work regardless of what has focus (except while a text
field is being edited):

| | |
|---|---|
| Add a box | `⌘⇧B` |
| Rename the selection | `⌘Return` |
| Undo / Redo | `⌘Z` / `⇧⌘Z` |
| Zoom in / out | `⌘=` / `⌘-` |
| Fit the sheet in the window | `⌘0` |
| Actual size | `⌘9` |
| Show the Checks panel | `⌘⇧K` |
| Import IDEF0 XML… | `⌘⇧I` |

Three Diagram-menu items deliberately have no key equivalent, since a chord
would fire before a field being typed in sees the key:

| | |
|---|---|
| Arrange | lay the diagram's boxes out along the staircase again, in number order — also on the toolbar |
| Move Earlier / Move Later | swap the selected box with its neighbour in the reading order — also in the box inspector |

Arrange is disabled on A-0, which is never laid out; Move Earlier / Move
Later are disabled at either end of the order. Every structural edit — adding
a box, deleting one, moving one — lays the diagram out again by itself;
opening a file never does.

## Ports and bundles

The model behind these is the web app's — see the root README's
[Editing](../README.md#editing) — and the two apps read and write the same
bytes for it. What the Mac app shows:

- **Ports.** A child diagram draws each parent ICOM concept it has not yet
  connected as a port at the sheet edge, and the status bar counts them
  ("2 parent concepts unconnected"). Each is still the `icom-missing` error
  in the Checks panel until it is connected by dragging it onto a box side
  (above). The arrow drawn carries the parent's label and concept (the
  bundle's, when that concept is in a bundle); delete it and the port is
  back. `idef0 render` and the SVG, PNG and PDF exports draw ports as the
  screen does; `xml`, `report` and `idl` never mention them, as in the web
  app.
- **Combining.** Every glossary row in the sidebar has a Combine toggle;
  tick two or more and press **Combine Selected** to be asked for the
  bundle's term (the members' terms joined by " & " to start with; a blank
  term is refused). A concept already in a bundle cannot be ticked until that
  bundle is un-combined. The bundle's row lists its members nested beneath
  it, with **Un-combine**. An arrow's inspector has a Bundle section: for an
  arrow whose concept is in no bundle, **Combine with…** picks another
  concept drawn on this diagram and **Combine…** asks for the term (the
  web app asks as soon as a concept is picked — that extra press is the one
  difference between the two); for an arrow the bundle covers, it names the
  bundle and offers **Un-combine**.
- **Un-combining** leaves every member and every arrow as it was; the former
  bundle's entry is removed when nothing uses it and kept as a plain concept
  when a box or arrow is bound to it, so nothing dangles. Removing a concept
  from the glossary (the ✕ on an unused row) un-combines a bundle and drops a
  member from its bundle's list.
- The four bundle rule checks (`bundle-member-dup`, `bundle-cycle`,
  `bundle-thin`, `bundle-mixed-kind`) are the same as the web app's, with
  the same message text, and `idef0 validate` reports them too.
- The per-element clocks a box, arrow, diagram or concept may carry
  (`updatedAt`, `deletedAt`) are read, written and checked here exactly as in
  the web app — the same two rules (`provenance-date`, `provenance-order`),
  the same message text, and the same hand-rolled reading of an ISO-8601
  instant, so both apps order any pair of clocks identically. Neither is ever
  invented for an element the file records none for. There is no editor field
  for them yet; the Checks panel and `idef0 validate` are where they surface.

## The `idef0` command line

```
idef0 <command> <model> [options]

  validate <model> [--json]                 check FIPS 183 rules; exit 1 on errors
  convert  <model> -o <out.json|out.xml>    write canonical project JSON or XML interchange
  idl      <model> [-o out.txt]             IDEF0 IDL listing
  report   <model> [--html] [-o out]        model report (Markdown, or HTML)
  concepts <model> [--json]                 glossary with usage, occurrences and drift
  render   <model> [--diagram NODE] [--scale N] -o <out.png|out.pdf|out.svg>
```

`<model>` is a `.idef0.json` project or an IDEF0 XML file, sniffed by
extension and, failing that, by content — `-` reads standard input. Options
may come before or after `<model>`; `-h`/`--help` anywhere prints the usage
above. `idl` and `report` write to standard output unless `-o` names a file
(`-o -` is standard output too); `validate` and `concepts` always write to
standard output; `convert` and `render` write only to a file, whose extension
picks the output format. `render` draws the root diagram unless `--diagram`
names one by its node (e.g. `A21`); a PDF with no `--diagram` holds the whole
kit, one landscape page per diagram. `--scale` is pixels per sheet unit for a
PNG (default 2); the rendered image may be at most 32,768 pixels on a side.

**Exit status:** `0` success, `1` the model has rule errors (`validate`
only — a model with only warnings still exits `0`), `2` a usage or I/O error
(a bad flag, a missing file, a write that failed).

Loading a file that needed a repair — an element with no concept id got one
freshly minted, or the model itself had no top-level `id` — prints a warning
to standard error naming the fix, since those ids exist only for this run
until the model is saved; run `idef0 convert <model> -o <model>` to write
them back to the same file.

### `--json` output

`validate --json` prints:

```json
{
  "errors": 0,
  "warnings": 1,
  "issues": [
    {
      "severity": "warning",
      "code": "model-title",
      "message": "The model has no title.",
      "diagramId": "dg_…",
      "node": "A-0",
      "kind": null,
      "id": null
    }
  ]
}
```

`kind` is `"box"` or `"arrow"` (or `null` for a model- or diagram-level
issue), and `id` names that box or arrow. `code` is the same stable
identifier the web app's Checks panel and this app's Checks panel use — see
the root README's [What it enforces](../README.md#what-it-enforces) for the
full list.

`concepts --json` prints:

```json
{
  "modelId": "mdl_…",
  "concepts": [
    {
      "id": "gl_…",
      "term": "Work Order",
      "kind": "data",
      "definition": "…",
      "uses": 3,
      "occurrences": [
        { "diagramId": "dg_…", "node": "A0", "kind": "arrow", "id": "ar_…", "text": "Work Order" }
      ]
    }
  ],
  "drift": [
    { "diagramId": "dg_…", "node": "A1", "kind": "arrow", "id": "ar_…", "text": "Order", "conceptId": "gl_…", "term": "Work Order" }
  ]
}
```

`occurrences` lists every box or arrow bound to a concept; `drift` lists only
those whose drawn text no longer matches the glossary term it is bound to
(FIPS 183 §3.3.2.4 allows a child to elaborate a parent's label, so drift is
reported, not treated as an error). Both output shapes are a stable contract
for downstream tooling: a field is added to, never removed or repurposed
from, either shape.

## Tests

```
swift test
```

from `macos/` runs the whole suite: `IDEF0Core`'s model, validation, JSON and
XML parity against fixtures generated from the web app (below); rendering
parity in `IDEF0Render`; the editing rules in `IDEF0Editing`; the app's own
canvas behaviour in `IDEF0ModelerTests`, driven with synthesized events in an
offscreen window; and `idef0CLITests`, which runs the built `idef0` binary as
a subprocess.

## Keeping this in parity with the web app

`IDEF0Core`'s golden fixtures
(`macos/Tests/IDEF0CoreTests/Fixtures/*.json`) are captured from the web
modules, not hand-written, so a Swift port and its web counterpart are
compared against the same recorded output rather than against each other's
assumptions:

```
macos/scripts/regen-goldens.sh
```

needs a local Chrome and `python3`. It serves this checkout, loads
`macos/scripts/goldens.html` in headless Chrome, and has the page compute
every fixture from the live `src/` modules and post the results back. Output
is staged into a temporary directory first and only copied over
`Fixtures/` once every fixture posts successfully and the run diffs staged
against committed, so a run that fails partway never leaves `Fixtures` in a
mixed state. Regenerating re-rolls the sample model's random ids; no Swift
test depends on them holding a particular value.

`tests/web/*.test.mjs` (`node --test tests/web/`) is the faster, Swift-free
half of the same idea: rather than exercising the Swift side, it recomputes
several of `goldens.html`'s own DOM-free outputs directly from the current
`src/` modules and fails if they no longer match the committed fixture —
catching a stale golden without opening Chrome or running `swift test` at
all.
