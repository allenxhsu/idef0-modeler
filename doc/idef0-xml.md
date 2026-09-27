# IDEF0 XML interchange format

Namespace: `urn:idef0-modeler:xml:1`

Written by `src/io/idef0xml.js` (`toXml`) and read back by `fromXml`; the
Swift port in `macos/Sources/IDEF0Core/XMLInterchange.swift` produces and
reads byte-identical files. The writer always emits `version="2"`. A reader
checks that attribute to decide how to read the file — see **Versions**
below — so an old file, or one written by another tool, still opens.

There is no single universally implemented XML form of IDEF0. FIPS PUB 183
standardises the graphic language and the IDL text form; the commercial tools
each shipped their own XML. This format is therefore local to this tool, but
it is plain and self-describing, so a converter to another tool's format is a
stylesheet's worth of work.

## Shape

```xml
<idef0Model xmlns="urn:idef0-modeler:xml:1" version="2" id="mdl_…">
  <header>
    <title>…</title> <author>…</author> <project>…</project>
    <status>WORKING|DRAFT|RECOMMENDED|PUBLICATION</status>
    <created>YYYY-MM-DD</created> <revised>YYYY-MM-DD</revised>
    <purpose>…</purpose>       <!-- required by IDEF0 -->
    <viewpoint>…</viewpoint>   <!-- required by IDEF0 -->
  </header>

  <glossary>
    <term id="gl_…" name="Work Order" kind="data">definition text</term>
    <term id="gl_…" name="Inputs" kind="data">definition text<member id="gl_…"/><member id="gl_…"/></term>
  </glossary>

  <diagrams>
    <diagram id="dg_…" node="A-0" titleLocked="false" context="true">
      <title>…</title>
      <cNumber>…</cNumber>                       <!-- optional -->
      <notes>[{"text":"…"}]</notes>               <!-- optional, JSON -->
      <activities>
        <!-- updatedAt/deletedAt are optional here and on diagram, arrow and term -->
        <activity id="bx_…" number="1" node="A1" concept="gl_…" detail="dg_…" updatedAt="2026-09-27T14:05:00Z">
          <name>Plan Production</name>
          <bounds x="100" y="172" width="190" height="112"/>
          <refs>SOP-17</refs>                      <!-- optional -->
          <note>…</note>                          <!-- optional -->
        </activity>
      </activities>
      <arrows>
        <arrow id="ar_…" role="input|control|output|mechanism|call" concept="gl_…">
          <label>Customer Order</label>
          <source type="boundary" side="left" position="0.18" icom="I1"/>
          <destination type="activity" activity="bx_…" side="left" position="0.5"/>
          <route bend="620"/>                     <!-- optional -->
          <labelOffset dx="0" dy="-6"/>           <!-- optional -->
          <note>…</note>                          <!-- optional -->
        </arrow>
      </arrows>
    </diagram>
  </diagrams>

  <root diagram="dg_…"/>
  <extensions>{"model":{…},"glossary":{"gl_…":{…}}}</extensions>  <!-- optional -->
</idef0Model>
```

## Semantics

- `id` on `<idef0Model>`, `<term>`, `<diagram>`, `<activity>` and `<arrow>` is
  the element's identity in the native `.idef0.json` — the same string the
  app joins on internally and the one a `concept=`/`detail=`/`parentBox=`
  reference below names. It is never derived from text (a name or a label can
  change, or repeat, without changing what it identifies), which is what lets
  boxes and arrows bind to a glossary concept by id rather than by matching
  text — see the concept identity layer this format is part of. A reader that
  finds no `id` attribute, or an empty one, invents a fresh one, so a
  hand-written file need not supply ids at all; one written by this tool
  always does.
- `concept` on `<activity>` and `<arrow>` names the `<term id="…">` the box or
  arrow denotes — the same `conceptId` the native JSON carries. It is omitted
  when the box or arrow denotes no concept. A `concept` naming no `<term>` in
  the file is kept as a dangling reference, exactly as an unbound `conceptId`
  is in JSON; nothing here validates it.
- `<member id="…"/>` children of a `<term>` name the concepts that term
  bundles (FIPS 183 §3.2.2.3) — the native JSON's `members` list, in order.
  A plain concept has none, and a term with none reads back as a concept
  with no `members` field at all (the same rule as `titleLocked`: absent
  means none). The writer puts them directly after the definition text on
  the term's one line, with no whitespace between them. The `version="2"`
  reader takes the definition from the term's **own text nodes only** — text
  inside a `<member>` is never part of it — and, once the term has any
  element children, trims each of those text nodes, so the line breaks and
  indentation a hand-formatted file puts between `<member/>`s are formatting,
  not definition text; a term with no element children keeps its definition
  exactly as written, as every other v2 text does. A `<member>` with no `id`
  (or an empty one) names nothing and is skipped on read; one naming no
  `<term>` in the file is kept as a dangling reference, like a dangling
  `concept`. Read only from `version="2"` files — a version-1 reader ignores
  the elements and reads the definition as the element's whole text
  content, trimmed — see **Versions**. Both apps' readers apply the same
  rules.
- `node` on `<diagram>` is the node number (`A-0`, `A0`, `A1`, `A32`, …).
  `<activity node>` repeats the node number the box carries, which is the same
  string as its detail diagram's; it is derived and ignored on import (the
  box's `number` attribute and its diagram's own `node` are what the reader
  keeps).
- `parentBox` on `<diagram>` names the activity this diagram decomposes; the
  context diagram carries `context="true"` instead and is also named by
  `<root diagram>`.
- `detail` on `<activity>` names the diagram that decomposes it, if any.
- A second `<diagram>` element carrying an `id` an earlier one in the file
  already used is a read error, rather than silently replacing the first
  diagram — so a hand-edited or merged file cannot lose a diagram unnoticed.
- `titleLocked` on `<diagram>` records whether the diagram's title was set
  explicitly rather than inherited from its parent box's name — see
  **Versions** for how it is read.
- `updatedAt` and `deletedAt` on `<diagram>`, `<activity>`, `<arrow>` and
  `<term>` are the per-element clocks the native JSON carries: when the
  element last changed, and — as a tombstone — when it was removed. Each is an
  ISO-8601 instant and each is written only when the element has it, so an
  element with neither is written exactly as it was before the clocks existed.
  Read only from `version="2"` files; a version-1 reader ignores them as it
  ignores any attribute it does not know.
- `role` on `<arrow>` is **derived**, not authoritative — it is written out for
  readers, and on import it is recomputed from the sides the arrow touches:
  left = input, top = control, right = output, bottom in = mechanism,
  bottom out = call.
- `side` is `left|top|right|bottom` and `position` is 0–1 along that side,
  measured left to right or top to bottom. An endpoint (`<source>` or
  `<destination>`) that is missing entirely reads as a boundary end on the
  left at position 0.5. When the element is present, a missing `side` reads
  as `left`, and a missing `position` reads as **0**, not 0.5: the reader
  converts whatever it finds — including nothing — the way JavaScript's
  `Number()` does, and the Swift port matches that exactly; converting
  nothing (`null`) gives 0, not `NaN`, so only a `position` value that fails
  to parse as a number at all falls back to 0.5. A `side` outside the four
  listed values is kept as written by the web reader, which does not
  restrict the attribute to an enumeration; the Swift port, whose `Side` type
  has no catch-all case, reads it as `left` instead. A writer should stick to
  the four values.
- Every other numeric attribute falls back to a fixed default — `x`/`y` to
  100, `width`/`height` to 190/112, `number` to 1, `dx`/`dy` to 0 — only when
  its element or the attribute itself is entirely absent, or present but not
  a finite number; an attribute present with an empty value parses, like
  `position`, to 0 rather than triggering the fallback. `bend` has no fixed
  default: an arrow with no `<route>` (or no `bend` on it) simply has no
  manual bend.
- `icom` on a boundary endpoint is the generated ICOM code (`I1`, `C2`, `O1`,
  `M1`). It is derived from the order of boundary arrows on each side, so it is
  informational on import.
- `tunnelled="true"` on an endpoint marks a tunnelled arrow end: the arrow is
  deliberately absent from the diagram on the other side of that boundary, and
  the parent/child consistency check skips it.
- `bounds` is in sheet units. The sheet is 1100 × 850, the drawing area is
  x 40–1060, y 132–754. Coordinates and offsets are written at full precision
  (`String(Number(v))` in JavaScript, the equivalent `jsNumberString` in
  Swift) — not rounded, so an editor-placed box round-trips to the pixel.
- `<refs>` on an activity and `<notes>` on a diagram mirror the native JSON's
  `refs` string and `notes` array; `<notes>` holds `JSON.stringify(notes)` as
  element text (escaped like any other text — see **Escaping**), so its shape
  is whatever the app's notes feature stores, not fixed by this format.
- `<extensions>`, once per file, carries members this version of the format
  does not otherwise model: unmodelled top-level members of the native JSON
  (an IRI, a provenance block, anything another tool or a newer version added)
  under `model`, and unmodelled members of a glossary entry under
  `glossary`, keyed by that entry's concept id so a renamed or rebound entry
  still finds its extras. Its text is `JSON.stringify({model, glossary})`,
  omitted entirely when there is nothing to carry. Diagram-, activity- and
  arrow-level extras are **not** carried this way — see **What does not
  survive**.

## Versions

The `version` attribute on `<idef0Model>` controls how far the reader trusts
the file. `version="2"` (or higher) is the writer's own output; `version="1"`
or an absent attribute is read exactly as this format's first version always
was, so a file written before v2 existed, or by another tool that never
adopted it, keeps opening the same way it always did:

| | absent, or `version="1"` | `version="2"` or higher |
|---|---|---|
| element text (`<title>`, `<name>`, `<label>`, …) | trimmed | kept exactly as written |
| `titleLocked` | derived: `true` when the title is non-empty after trimming | read from the `titleLocked` attribute when present, else derived the same way |
| `<refs>` on an activity | ignored — `refs` reads as `""` | read |
| `<notes>` on a diagram | ignored — `notes` reads as `[]` | read and `JSON.parse`d |
| `<member>` children of a term | ignored — the term has no members | read as the term's `members` |
| `<extensions>` | ignored entirely | read and merged back into the model and glossary |

A hand-written file gains nothing from claiming `version="2"` unless it also
supplies these elements untrimmed and in full; claiming it while still relying
on trimmed, padded text is safe (nothing forces padding), but a title with
meaningful leading or trailing space needs the version bump to survive.

## Escaping

XML 1.0 cannot represent every Unicode scalar. The writer never emits an
invalid file:

- The five markup characters (`< > & " '`) are escaped everywhere, as usual.
- A literal carriage return in text content is written as `&#13;` rather than
  raw, so a CRLF or a lone CR is not silently turned into a bare LF by the
  parser's line-ending normalisation (XML §2.11) before this app ever sees it.
- Inside an attribute value (the glossary `name=`/`kind=`/`id=` attributes and
  every element `id=`/`node=`/… attribute), TAB and LF are additionally
  written as `&#9;`/`&#10;`, because attribute-value normalisation (XML
  §3.3.3) would otherwise turn either into a plain space on read-back.
- A code point XML 1.0 forbids outright — the C0 controls other than TAB, LF
  and CR (U+0000–U+0008, U+000B, U+000C, U+000E–U+001F), and U+FFFE/U+FFFF —
  cannot be carried even as a numeric character reference (`&#11;` is itself
  ill-formed), so it is replaced with U+FFFD (the Unicode replacement
  character) instead. This is the one place export is lossy by necessity, not
  by omission: the alternative was a file that does not parse at all. Text
  reaching the editor from typing or from the native JSON format is
  unaffected; only XML export replaces these code points.

Reading is unaffected by any of this beyond what the XML parser normalises on
its own — a reader sees ordinary decoded text.

## What survives, and what does not

A `version="2"` round trip (`fromXml(toXml(m))`, or the Swift equivalent)
reproduces the native `.idef0.json` exactly: every model, diagram, activity
and arrow field, `titleLocked`, box `refs`, diagram `notes`, tunnel flags,
concept bindings, a bundle's `members`, the per-element clocks
(`updatedAt`/`deletedAt`), activity array order, and unmodelled
top-level model and glossary-entry members (via `<extensions>`). Two things do
not survive, by design:

- **Diagram-, activity- and arrow-level extras.** The native JSON keeps
  unmodelled members at every level (a diagram, a box, an arrow); this XML
  format's `<extensions>` element only reaches the model and the glossary.
  An unmodelled member on a diagram, activity or arrow is dropped by export.
- **Text this format cannot carry at all.** See **Escaping** — a handful of
  control code points become U+FFFD rather than being carried through, since
  XML 1.0 has no well-formed way to hold them.

`version="1"` reading is deliberately not lossless by the same measure — see
**Versions** — because it exists to keep old files, and other tools' output,
opening exactly as they always have, not to carry new data.

## IDL export

`toIdl` produces a readable node/ICOM listing in the spirit of the FIPS 183
IDL text form. It is export only — a report, not a round-trip format: it
carries no ids or concept bindings, and reading it back is not supported by
either app. A quoted field (`MODEL`/`AUTHOR`/`PROJECT`'s titles, `PURPOSE`,
`VIEWPOINT`, a `DIAGRAM` title, an `ARROW` label, an `ACTIVITY` name) is
escaped so a quote, a backslash or a line ending inside it cannot break the
statement it sits in or merge into the next line: a backslash becomes `\\`,
a `"` becomes `\"`, and any of CRLF/CR/LF becomes the two characters `\n` —
in that order, so escaping a newline never gets re-escaped by the quote step
that follows it. `PURPOSE` and `VIEWPOINT` are additionally collapsed to one
line (`oneLine`) before quoting, as before; every other quoted field is
quoted as written.
