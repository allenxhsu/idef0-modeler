// IDEF0 XML interchange and the IDL listing — a port of src/io/idef0xml.js.
//
// FIPS 183 specifies the graphic language and the IDL text form, not an XML
// schema, and the commercial tools each shipped their own. This is the tool's
// own documented, self-describing XML (doc/idef0-xml.md), carrying activities,
// ICOM arrows, tunnels, node numbers, the decomposition tree, purpose/viewpoint
// and the glossary; it round-trips with the reader below.
//
// The writer always emits `version="2"`: titleLocked as a diagram attribute,
// box refs and diagram notes when present, a bundle's members as <member>
// children of its <term>, a single <extensions> element for unknown
// model/glossary members, activities in array order, and numbers at full
// precision. A reader seeing `version="2"` or higher reads text content
// untrimmed and restores all of that; one seeing `version="1"` or no version
// attribute at all reads exactly as version 1 always did (trimmed text,
// titleLocked derived from the title, no refs/notes/members/extensions), so
// files written before this version, or by another tool, keep reading the
// same way.
//
// The web app reads with DOMParser and CSS selectors, and the reader keeps
// those semantics rather than a tidier reading of the format: `header > title`
// matches at any depth below the root while `:scope > title` is a direct child
// only; text is DOM `textContent` (CDATA and nested elements in, comments out),
// trimmed for version 1 and raw for version 2+; an absent element falls back
// where a present-but-empty one does not (`??` against `||`); and numeric
// attributes go through JavaScript's `Number`, so `x=""` is 0 and a missing
// `position` is 0, not 0.5.

import Foundation

/// Why `fromXml` rejected a file. Messages match the web app's word for word,
/// except the parser's own detail after "XML is not well formed: ".
public struct XMLInterchangeError: Error, Hashable, Sendable, CustomStringConvertible {
    public var message: String
    public var description: String { message }
}

public enum XMLInterchange {
    /// `XML_NS`.
    public static let namespace = "urn:idef0-modeler:xml:1"

    // MARK: - Writing

    /// `toXml(model)`. Always writes `version="2"`.
    public static func toXml(_ model: IDEF0Model) -> String {
        var L: [String] = []
        L.append(#"<?xml version="1.0" encoding="UTF-8"?>"#)
        L.append(#"<idef0Model xmlns="\#(namespace)" version="2" id="\#(xmlAttr(model.id))">"#)
        L.append("  <header>")
        L.append("    <title>\(xmlText(model.title))</title>")
        L.append("    <author>\(xmlText(model.author))</author>")
        L.append("    <project>\(xmlText(model.project))</project>")
        L.append("    <status>\(xmlText(model.status))</status>")
        L.append("    <created>\(xmlText(model.created))</created>")
        L.append("    <revised>\(xmlText(model.revised))</revised>")
        L.append("    <purpose>\(xmlText(model.purpose))</purpose>")
        L.append("    <viewpoint>\(xmlText(model.viewpoint))</viewpoint>")
        L.append("  </header>")

        L.append("  <glossary>")
        for g in model.glossary {
            // A bundle's members follow its definition text as empty <member/>
            // elements, on the same line: the reader takes the definition
            // from the element's whole text content, so no whitespace may
            // sit between them.
            let members = g.members.map { #"<member id="\#(xmlAttr($0))"/>"# }.joined()
            L.append(#"    <term id="\#(xmlAttr(g.id))" name="\#(xmlAttr(g.term))" kind="\#(xmlAttr(g.kind))"\#(clockAttrs(g.updatedAt, g.deletedAt))>\#(xmlText(g.definition))\#(members)</term>"#)
        }
        L.append("  </glossary>")

        L.append("  <diagrams>")
        for dg in model.diagrams.values {
            let codes = model.exactIcomCodes(dg)
            let parentBox = dg.parentBoxId.flatMap { $0.isEmpty ? nil : #" parentBox="\#(xmlAttr($0))""# } ?? ""
            let context = jsStrictEquals(dg.id, model.rootDiagramId) ? #" context="true""# : ""
            let titleLocked = dg.titleLocked ? "true" : "false"
            L.append(#"    <diagram id="\#(xmlAttr(dg.id))" node="\#(xmlAttr(dg.node))" titleLocked="\#(titleLocked)"\#(parentBox)\#(context)\#(clockAttrs(dg.updatedAt, dg.deletedAt))>"#)
            L.append("      <title>\(xmlText(dg.title))</title>")
            if !dg.cNumber.isEmpty { L.append("      <cNumber>\(xmlText(dg.cNumber))</cNumber>") }
            if !dg.notes.isEmpty { L.append("      <notes>\(xmlText(JSONValue.array(dg.notes).stringified(indent: 0)))</notes>") }
            L.append("      <activities>")
            // Array order, not number order: the file reflects the model's own
            // array, which the reader already rebuilds from `number` alone.
            for b in dg.boxes {
                let concept = b.conceptId.flatMap { $0.isEmpty ? nil : #" concept="\#(xmlAttr($0))""# } ?? ""
                let detail = b.childDiagramId.flatMap { $0.isEmpty ? nil : #" detail="\#(xmlAttr($0))""# } ?? ""
                L.append(#"        <activity id="\#(xmlAttr(b.id))" number="\#(b.number)" node="\#(xmlAttr(boxNode(dg, b)))"\#(concept)\#(detail)\#(clockAttrs(b.updatedAt, b.deletedAt))>"#)
                L.append("          <name>\(xmlText(b.name))</name>")
                L.append(#"          <bounds x="\#(num(b.x))" y="\#(num(b.y))" width="\#(num(b.w))" height="\#(num(b.h))"/>"#)
                if !b.refs.isEmpty { L.append("          <refs>\(xmlText(b.refs))</refs>") }
                if !b.note.isEmpty { L.append("          <note>\(xmlText(b.note))</note>") }
                L.append("        </activity>")
            }
            L.append("      </activities>")
            L.append("      <arrows>")
            for a in dg.arrows {
                let concept = a.conceptId.flatMap { $0.isEmpty ? nil : #" concept="\#(xmlAttr($0))""# } ?? ""
                L.append(#"        <arrow id="\#(xmlAttr(a.id))" role="\#(a.role.rawValue)"\#(concept)\#(clockAttrs(a.updatedAt, a.deletedAt))>"#)
                L.append("          <label>\(xmlText(a.label))</label>")
                L.append("          \(endpointXml("source", a, .from, codes))")
                L.append("          \(endpointXml("destination", a, .to, codes))")
                if let bend = a.bend { L.append(#"          <route bend="\#(num(bend))"/>"#) }
                // `a.ldx || a.ldy`: NaN is falsy, like 0.
                if truthy(a.ldx) || truthy(a.ldy) {
                    L.append(#"          <labelOffset dx="\#(num(a.ldx))" dy="\#(num(a.ldy))"/>"#)
                }
                if !a.note.isEmpty { L.append("          <note>\(xmlText(a.note))</note>") }
                L.append("        </arrow>")
            }
            L.append("      </arrows>")
            L.append("    </diagram>")
        }
        L.append("  </diagrams>")
        L.append(#"  <root diagram="\#(xmlAttr(model.rootDiagramId))"/>"#)
        if let ext = extensionsPayload(model) {
            L.append("  <extensions>\(xmlText(ext.stringified(indent: 0)))</extensions>")
        }
        L.append("</idef0Model>")
        return L.joined(separator: "\n")
    }

    /// `endpointXml(tag, arrow, which, codes)`. Only a boundary end carries an
    /// ICOM code; a tunnelled end carries none (FIPS 183 §3.3.2.9), which the
    /// pairing has already decided.
    private static func endpointXml(_ tag: String, _ arrow: Arrow, _ end: ArrowEnd, _ codes: [JSStringKey: String]) -> String {
        let e = arrow[end]
        let tunnel = arrow.isTunnelled(end) ? #" tunnelled="true""# : ""
        if e.kind == .box {
            return #"<\#(tag) type="activity" activity="\#(xmlAttr(e.boxId ?? ""))" side="\#(e.side.rawValue)" position="\#(num(e.pos))"\#(tunnel)/>"#
        }
        let code = codes[JSStringKey("\(arrow.id):\(end.rawValue)")].flatMap { $0.isEmpty ? nil : #" icom="\#($0)""# } ?? ""
        return #"<\#(tag) type="boundary" side="\#(e.side.rawValue)" position="\#(num(e.pos))"\#(code)\#(tunnel)/>"#
    }

    /// `num(v)`: `String(Number(v))` — full precision, printed as JavaScript prints it.
    private static func num(_ v: Double) -> String { jsNumberString(v) }

    private static func truthy(_ v: Double) -> Bool { !(v == 0 || v.isNaN) }

    /// XML 1.0's forbidden code points (§2.2): the C0 controls other than tab,
    /// LF and CR, plus the two non-characters. Not even a numeric character
    /// reference can carry one, so it becomes U+FFFD — documented,
    /// application-level lossy behaviour (doc/idef0-xml.md), never applied to
    /// the native JSON format.
    private static func isXMLForbidden(_ u: Unicode.Scalar) -> Bool {
        switch u.value {
        case 0x0...0x8, 0xB, 0xC, 0xE...0x1F, 0xFFFE, 0xFFFF: return true
        default: return false
        }
    }

    /// Element text content: the five markup escapes (code point by code
    /// point — the web app's regex replaces them wherever they occur, and
    /// walking Swift Characters would miss one a combining mark has joined
    /// into a single grapheme), plus a literal CR encoded as `&#13;` so a
    /// CRLF survives the parser's line-end normalisation (XML §2.11 turns a
    /// raw CRLF, and a raw CR, into a single LF on the way in).
    private static func xmlText(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        for scalar in s.unicodeScalars {
            if isXMLForbidden(scalar) { out.append("\u{FFFD}"); continue }
            switch scalar {
            case "<": out.append(contentsOf: "&lt;".unicodeScalars)
            case ">": out.append(contentsOf: "&gt;".unicodeScalars)
            case "&": out.append(contentsOf: "&amp;".unicodeScalars)
            case "\"": out.append(contentsOf: "&quot;".unicodeScalars)
            case "'": out.append(contentsOf: "&apos;".unicodeScalars)
            case "\r": out.append(contentsOf: "&#13;".unicodeScalars)
            default: out.append(scalar)
            }
        }
        return String(out)
    }

    /// Attribute value: `xmlText`, plus TAB and LF encoded so attribute-value
    /// normalisation (XML §3.3.3) does not turn them into plain spaces.
    /// `clockAttrs(o)` — the per-element clocks as attributes, written only
    /// when set, so an element that carries neither is written exactly as
    /// before. A version-1 reader ignores an attribute it does not know, and
    /// this one reads them for version 2 or higher only.
    private static func clockAttrs(_ updatedAt: String?, _ deletedAt: String?) -> String {
        var out = ""
        if let v = updatedAt, !v.isEmpty { out += #" updatedAt="\#(xmlAttr(v))""# }
        if let v = deletedAt, !v.isEmpty { out += #" deletedAt="\#(xmlAttr(v))""# }
        return out
    }

    private static func xmlAttr(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        for scalar in xmlText(s).unicodeScalars {
            switch scalar {
            case "\u{9}": out.append(contentsOf: "&#9;".unicodeScalars)
            case "\n": out.append(contentsOf: "&#10;".unicodeScalars)
            default: out.append(scalar)
            }
        }
        return String(out)
    }

    /// Top-level members `IDEF0Model.create`/`ModelFile.deserialize` populate;
    /// anything else is an extra this format does not otherwise carry, kept
    /// in the <extensions> element. Matches `ModelFile.modelKeys` /
    /// `conceptKeys`.
    private static let knownModelKeys = ModelFile.modelKeys
    private static let knownConceptKeys = ModelFile.conceptKeys

    /// `extensionsPayload(model)`: `{ model, glossary }` — the model's own
    /// extras (already kept in file order by `IDEF0Model.extras`) and every
    /// glossary entry's, keyed by concept id — or nil when there is nothing
    /// to carry, so the element is omitted rather than written empty.
    private static func extensionsPayload(_ model: IDEF0Model) -> JSONValue? {
        var out = JSONObject()
        if !model.extras.isEmpty { out["model"] = .object(model.extras) }
        var glossaryExtras = JSONObject()
        for g in model.glossary where !g.extras.isEmpty { glossaryExtras[g.id] = .object(g.extras) }
        if !glossaryExtras.isEmpty { out["glossary"] = .object(glossaryExtras) }
        return out.isEmpty ? nil : .object(out)
    }

    // MARK: - Reading

    /// `fromXml(text)`. Starts from `createModel('Imported Model')`, so the
    /// model id falls back to a fresh one; a missing date stays empty. A second
    /// `<diagram>` with an id already read is rejected rather than replacing it.
    ///
    /// `version="2"` or higher reads element text untrimmed and restores
    /// titleLocked, refs, notes and extensions; `version="1"` or no version
    /// attribute at all keeps every version-1 reading behaviour byte-for-byte.
    public static func fromXml(_ text: String) throws -> IDEF0Model {
        let x = try parse(text)
        let root = 0
        if x.elements[root].localName != "idef0Model" {
            throw XMLInterchangeError(message: "Expected <idef0Model>, found <\(x.elements[root].localName)>.")
        }
        let v2 = (x.attr(root, "version").map { JSONValue.toNumber(.string($0)) } ?? 0) >= 2
        /// `el.textContent` for version 1 (trimmed) or version 2+ (raw).
        func elText(_ i: Int) -> String { v2 ? x.textContent(i) : jsTrim(x.textContent(i)) }
        /// `parent.querySelector(':scope > tag')?.textContent…`, nil when absent.
        func childText(_ parent: Int?, _ tag: String) -> String? { x.child(parent, tag).map(elText) }

        var model = IDEF0Model.create(title: "Imported Model")
        model.diagrams = OrderedMap()
        /// `rootEl.querySelector(sel)?.textContent… ?? d`.
        func t(_ parent: String, _ child: String, _ fallback: String = "") -> String {
            guard let i = x.selectAll(root, parent: parent, child: child).first else { return fallback }
            return elText(i)
        }
        model.id = orNil(x.attr(root, "id")) ?? model.id
        model.title = t("header", "title", "Imported Model")
        model.author = t("header", "author")
        model.project = t("header", "project")
        model.status = t("header", "status", ModelStatus.working.rawValue)
        model.created = t("header", "created")
        model.revised = t("header", "revised")
        model.purpose = t("header", "purpose")
        model.viewpoint = t("header", "viewpoint")
        model.glossary = x.selectAll(root, parent: "glossary", child: "term").map { n in
            Concept(
                id: orNil(x.attr(n, "id")) ?? uid("gl"),
                term: orNil(x.attr(n, "name")) ?? "",
                kind: orNil(x.attr(n, "kind")) ?? ConceptKind.other.rawValue,
                // Version 2 reads the definition from the term's own text nodes
                // only, so a hand-formatted file's whitespace between <member/>
                // children is not read into it.
                definition: v2 ? x.directText(n) : elText(n),
                // Version 2 only: `:scope > member` children name the bundle's
                // members; one with no id (or an empty one) names nothing and
                // is skipped. A version-1 reader never sees them.
                members: v2 ? x.children(n, "member").compactMap { orNil(x.attr($0, "id")) } : [],
                updatedAt: v2 ? orNil(x.attr(n, "updatedAt")) : nil,
                deletedAt: v2 ? orNil(x.attr(n, "deletedAt")) : nil
            )
        }

        if v2 { restoreExtensions(&model, x, root) }

        let diagramElements = x.selectAll(root, parent: "diagrams", child: "diagram")
        for d in diagramElements {
            let title = childText(d, "title") ?? ""
            let titleLocked = x.attr(d, "titleLocked").map { $0 == "true" } ?? !jsTrim(title).isEmpty
            var dg = Diagram(
                id: orNil(x.attr(d, "id")) ?? uid("dg"),
                node: orNil(x.attr(d, "node")) ?? "A0",
                title: title,
                titleLocked: titleLocked,
                parentBoxId: orNil(x.attr(d, "parentBox")),
                cNumber: childText(d, "cNumber") ?? "",
                notes: readNotes(v2 ? x.child(d, "notes") : nil, x),
                updatedAt: v2 ? orNil(x.attr(d, "updatedAt")) : nil,
                deletedAt: v2 ? orNil(x.attr(d, "deletedAt")) : nil
            )
            for a in x.selectAll(d, parent: "activities", child: "activity") {
                let b = x.child(a, "bounds")
                dg.boxes.append(Box(
                    id: orNil(x.attr(a, "id")) ?? uid("bx"),
                    name: childText(a, "name") ?? "",
                    number: boxNumber(x.numAttr(a, "number") ?? 1),
                    conceptId: orNil(x.attr(a, "concept")),
                    x: x.numAttr(b, "x") ?? 100,
                    y: x.numAttr(b, "y") ?? 100,
                    w: x.numAttr(b, "width") ?? 190,
                    h: x.numAttr(b, "height") ?? 112,
                    childDiagramId: orNil(x.attr(a, "detail")),
                    note: childText(a, "note") ?? "",
                    refs: v2 ? (childText(a, "refs") ?? "") : "",
                    updatedAt: v2 ? orNil(x.attr(a, "updatedAt")) : nil,
                    deletedAt: v2 ? orNil(x.attr(a, "deletedAt")) : nil
                ))
            }
            for a in x.selectAll(d, parent: "arrows", child: "arrow") {
                let src = x.child(a, "source")
                let dst = x.child(a, "destination")
                let route = x.child(a, "route")
                let off = x.child(a, "labelOffset")
                dg.arrows.append(Arrow(
                    id: orNil(x.attr(a, "id")) ?? uid("ar"),
                    label: childText(a, "label") ?? "",
                    conceptId: orNil(x.attr(a, "concept")),
                    from: readEndpoint(x, src),
                    to: readEndpoint(x, dst),
                    bend: x.numAttr(route, "bend"),
                    ldx: x.numAttr(off, "dx") ?? 0,
                    ldy: x.numAttr(off, "dy") ?? 0,
                    tunnelFrom: x.attr(src, "tunnelled") == "true",
                    tunnelTo: x.attr(dst, "tunnelled") == "true",
                    note: childText(a, "note") ?? "",
                    updatedAt: v2 ? orNil(x.attr(a, "updatedAt")) : nil,
                    deletedAt: v2 ? orNil(x.attr(a, "deletedAt")) : nil
                ))
            }
            if model.diagrams.contains(dg.id) {
                throw XMLInterchangeError(message: "Diagram \(dg.id) appears more than once.")
            }
            model.diagrams[dg.id] = dg
        }
        model.diagrams = inJavaScriptKeyOrder(model.diagrams)

        // `(rootAttr && diagrams[rootAttr] ? rootAttr : null) || context id || first key`.
        let rootAttr = x.selectFirst(root, "root").flatMap { x.attr($0, "diagram") }
        let contextElement = diagramElements.first { x.attr($0, "context") == "true" }
        var rootId: String?
        if let r = orNil(rootAttr), model.diagrams[r] != nil { rootId = r }
        if rootId == nil, let c = contextElement { rootId = orNil(x.attr(c, "id")) }
        if rootId == nil { rootId = model.diagrams.keys.first }
        guard let rootId, !rootId.isEmpty, model.diagrams[rootId] != nil else {
            throw XMLInterchangeError(message: "The file declares no context (A-0) diagram.")
        }
        model.rootDiagramId = rootId
        return model
    }

    /// `JSON.parse` of a `<notes>` element's text, ignoring anything malformed
    /// or not an array — the shape `Diagram.notes` holds. Absent for version 1.
    private static func readNotes(_ i: Int?, _ x: XTree) -> [JSONValue] {
        guard let i, let parsed = try? JSONValue.parse(x.textContent(i)) else { return [] }
        return parsed.arrayValue ?? []
    }

    /// Restores the members `extensionsPayload` set aside: unknown top-level
    /// model members, and unknown members of a glossary entry the extension
    /// keys by concept id. Malformed JSON, or an id naming no concept, is
    /// ignored rather than thrown — an extension a newer app cannot use
    /// should not stop this one opening the file. Known members are never
    /// overwritten, even by a hand-edited file.
    private static func restoreExtensions(_ model: inout IDEF0Model, _ x: XTree, _ root: Int) {
        guard let i = x.selectFirst(root, "extensions"), let ext = try? JSONValue.parse(x.textContent(i)),
              let obj = ext.objectValue
        else { return }
        if let modelExt = obj["model"]?.objectValue {
            for m in modelExt.jsOrderedMembers where !knownModelKeys.contains(where: { jsStrictEquals($0, m.key) }) {
                model.extras[m.key] = m.value
            }
        }
        if let glossaryExt = obj["glossary"]?.objectValue {
            for (i, g) in model.glossary.enumerated() {
                guard let extra = glossaryExt[g.id]?.objectValue else { continue }
                for m in extra.jsOrderedMembers where !knownConceptKeys.contains(where: { jsStrictEquals($0, m.key) }) {
                    model.glossary[i].extras[m.key] = m.value
                }
            }
        }
    }

    /// `readEndpoint(n)`. `Number(getAttribute('position'))` is `Number(null)`,
    /// 0, when the attribute is absent; only a non-numeric one falls back to 0.5.
    private static func readEndpoint(_ x: XTree, _ n: Int?) -> Endpoint {
        guard let n else { return .boundary(.left, 0.5) }
        // The web app keeps an unknown side string; Side has no case for one.
        let side = Side(rawValue: orNil(x.attr(n, "side")) ?? "left") ?? .left
        let pos = x.attr(n, "position").map { JSONValue.toNumber(.string($0)) } ?? 0
        let p = pos.isFinite ? pos : 0.5
        return x.attr(n, "type") == "activity"
            ? Endpoint(kind: .box, boxId: x.attr(n, "activity"), side: side, pos: p)
            : .boundary(side, p)
    }

    /// A box number read as a JavaScript number. Box numbers are integers in
    /// this model, so a fractional one truncates, as `ModelFile` does.
    private static func boxNumber(_ n: Double) -> Int { Int(clamp(n, -1e15, 1e15)) }

    /// `v || fallback` for an attribute: absent and empty are both falsy.
    private static func orNil(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }

    /// The order `Object.keys` enumerates a plain object in: array-index keys
    /// ascending, then the rest as inserted. `model.diagrams` is such an object.
    private static func inJavaScriptKeyOrder(_ map: OrderedMap<Diagram>) -> OrderedMap<Diagram> {
        let keys = JSONObject(map.keys.map { JSONMember($0, .null) }).jsOrderedMembers.map(\.key)
        guard keys != map.keys else { return map }
        var out = OrderedMap<Diagram>()
        for k in keys { out[k] = map[k] }
        return out
    }

    // MARK: - Parsing

    /// DOMParser's reading of `text`, as an element tree.
    ///
    /// Neither Foundation parser reads a document as DOMParser does on its own.
    /// XMLDocument is strict and says why a file is malformed, expands DTD
    /// entities, but drops whitespace-only text beside child elements, which DOM
    /// `textContent` keeps. XMLParser reports every text chunk and applies DTD
    /// attribute defaults, but loses text inside entity expansions. So both run,
    /// and `XTree(dom:sax:)` takes from each what it gets right.
    private static func parse(_ text: String) throws -> XTree {
        let data = Data(ignoringDeclaredEncoding(text).utf8)
        let doc: XMLDocument
        do {
            doc = try XMLDocument(data: data, options: [.nodeLoadExternalEntitiesNever, .nodePreserveWhitespace])
        } catch {
            throw XMLInterchangeError(message: "XML is not well formed: \(firstLine((error as NSError).localizedDescription))")
        }
        guard let dom = XTree(document: doc) else {
            throw XMLInterchangeError(message: "XML is not well formed: no document element")
        }
        let tree = XTreeBuilder.tree(data).flatMap { XTree(dom: dom, sax: $0) } ?? dom
        // `doc.querySelector('parsererror')` finds such an element wherever it is,
        // including in a well-formed file that happens to contain one.
        if let e = tree.elements.indices.first(where: { tree.elements[$0].localName == "parsererror" }) {
            throw XMLInterchangeError(message: "XML is not well formed: \(firstLine(tree.textContent(e)))")
        }
        return tree
    }

    /// `s.trim().split('\n')[0]`.
    private static func firstLine(_ s: String) -> String {
        jsTrim(s).components(separatedBy: "\n")[0]
    }

    /// DOMParser receives an already-decoded string and ignores an `encoding`
    /// declaration; libxml2 receiving bytes would honour it. Declare the UTF-8
    /// the bytes really are.
    private static func ignoringDeclaredEncoding(_ text: String) -> String {
        guard text.hasPrefix("<?xml") || text.hasPrefix("\u{FEFF}<?xml"),
              let regex = try? NSRegularExpression(pattern: #"^\x{FEFF}?<\?xml[ \t\r\n][^?>]*?encoding[ \t\r\n]*=[ \t\r\n]*(["'])([A-Za-z][A-Za-z0-9._-]*)\1"#),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(match.range(at: 2), in: text)
        else { return text }
        return text.replacingCharacters(in: range, with: "UTF-8")
    }
}

// MARK: - Element tree

/// The slice of the DOM the reader uses: elements in document order, their
/// attributes by qualified name, and text for `textContent`.
private struct XTree {
    enum Content {
        case element(Int)
        case text(String)
        /// A comment or processing instruction: no text, but it separates text nodes.
        case other
    }

    struct Element {
        var localName: String
        var attributes: [String: String]
        var parent: Int?
        var children: [Content] = []
        /// One past the index of the last descendant: descendants are `index + 1 ..< end`.
        var end = 0
    }

    /// Document order; element 0 is the document element.
    var elements: [Element] = []

    init() {}

    init?(document: XMLDocument) {
        guard let root = document.rootElement() else { return nil }
        add(root, parent: nil)
    }

    private mutating func add(_ e: XMLElement, parent: Int?) {
        let i = elements.count
        var attributes: [String: String] = [:]
        for a in e.attributes ?? [] { if let name = a.name { attributes[name] = a.stringValue ?? "" } }
        elements.append(Element(localName: e.localName ?? e.name ?? "", attributes: attributes, parent: parent))
        if let parent { elements[parent].children.append(.element(i)) }
        for c in e.children ?? [] {
            switch c.kind {
            case .element: if let ce = c as? XMLElement { add(ce, parent: i) }
            case .text: elements[i].children.append(.text(c.stringValue ?? ""))
            default: elements[i].children.append(.other)
            }
        }
        elements[i].end = elements.count
    }

    /// One document read by both parsers. Structure and attribute values come
    /// from XMLDocument, plus any attribute only XMLParser saw (a DTD default).
    /// For each run of text between markup, XMLParser's is used when it differs
    /// from XMLDocument's by whitespace alone — the chunks XMLDocument dropped —
    /// and XMLDocument's otherwise. Nil when the two disagree on structure.
    init?(dom: XTree, sax: XTree) {
        guard dom.elements.count == sax.elements.count else { return nil }
        self = dom
        for k in dom.elements.indices {
            let d = dom.elements[k], s = sax.elements[k]
            guard d.localName == s.localName, d.parent == s.parent else { return nil }
            for (name, value) in s.attributes where d.attributes[name] == nil { elements[k].attributes[name] = value }
            let (dRuns, dMarks) = Self.runs(d.children), (sRuns, sMarks) = Self.runs(s.children)
            guard dMarks.count == sMarks.count else { return nil }
            var children: [Content] = []
            for (n, run) in dRuns.enumerated() {
                let text = Self.withoutWhitespace(sRuns[n]) == Self.withoutWhitespace(run) ? sRuns[n] : run
                if !text.isEmpty { children.append(.text(text)) }
                if n < dMarks.count { children.append(dMarks[n]) }
            }
            elements[k].children = children
        }
    }

    /// Children as text runs separated by markup: `runs.count == marks.count + 1`.
    private static func runs(_ children: [Content]) -> (runs: [String], marks: [Content]) {
        var runs = [""], marks: [Content] = []
        for c in children {
            if case .text(let t) = c { runs[runs.count - 1] += t } else { marks.append(c); runs.append("") }
        }
        return (runs, marks)
    }

    /// XML's whitespace (§2.3 S), the only characters a parser drops as blank.
    private static func withoutWhitespace(_ s: String) -> String {
        String(String.UnicodeScalarView(s.unicodeScalars.filter { !["\u{20}", "\u{9}", "\u{A}", "\u{D}"].contains($0) }))
    }

    /// `getAttribute(name)`; nil for a missing element, as `el?.getAttribute`.
    func attr(_ i: Int?, _ name: String) -> String? {
        guard let i else { return nil }
        return elements[i].attributes[name]
    }

    /// `numAttr(el, name, fallback)` with the fallback left to the caller: nil
    /// when the element or attribute is absent or `Number(value)` is not finite.
    func numAttr(_ i: Int?, _ name: String) -> Double? {
        guard let s = attr(i, name) else { return nil }
        let v = JSONValue.toNumber(.string(s))
        return v.isFinite ? v : nil
    }

    /// DOM `textContent`: every descendant text and CDATA node, in order.
    /// The element's own text nodes, in order, without descending into child
    /// elements — the DOM's `childNodes` text and CDATA, joined. Once the
    /// element has element children, the whitespace around each text node is
    /// formatting, not text, and each is trimmed (the web reader's
    /// `nodeValue.trim()`, by JS whitespace).
    func directText(_ i: Int) -> String {
        let hasElements = elements[i].children.contains { if case .element = $0 { return true } else { return false } }
        var out = ""
        for c in elements[i].children {
            if case .text(let s) = c { out += hasElements ? jsTrim(s) : s }
        }
        return out
    }

    func textContent(_ i: Int) -> String {
        var out = ""
        func collect(_ k: Int) {
            for c in elements[k].children {
                switch c {
                case .text(let s): out += s
                case .element(let j): collect(j)
                case .other: break
                }
            }
        }
        collect(i)
        return out
    }

    /// `el.querySelector(name)`: the first descendant with that local name.
    func selectFirst(_ i: Int, _ name: String) -> Int? {
        (i + 1 ..< elements[i].end).first { elements[$0].localName == name }
    }

    /// `el.querySelectorAll('parent > child')`: descendants named `child` whose
    /// parent is named `parent`, at any depth.
    func selectAll(_ i: Int, parent: String, child: String) -> [Int] {
        (i + 1 ..< elements[i].end).filter { k in
            guard elements[k].localName == child, let p = elements[k].parent else { return false }
            return elements[p].localName == parent
        }
    }

    /// `el.querySelector(':scope > name')`: the first direct child element so named.
    func child(_ i: Int?, _ name: String) -> Int? {
        children(i, name).first
    }

    /// `el.querySelectorAll(':scope > name')`: every direct child element so named, in order.
    func children(_ i: Int?, _ name: String) -> [Int] {
        guard let i else { return [] }
        return elements[i].children.compactMap { c in
            if case .element(let j) = c, elements[j].localName == name { return j }
            return nil
        }
    }
}

/// Builds an `XTree` from XMLParser's events, which report every text chunk.
private final class XTreeBuilder: NSObject, XMLParserDelegate {
    private var tree = XTree()
    private var stack: [Int] = []

    /// Nil when XMLParser rejects the document or finds no element in it.
    static func tree(_ data: Data) -> XTree? {
        let builder = XTreeBuilder()
        let parser = XMLParser(data: data)
        parser.delegate = builder
        parser.shouldProcessNamespaces = false
        parser.shouldResolveExternalEntities = false
        guard parser.parse(), builder.stack.isEmpty, !builder.tree.elements.isEmpty else { return nil }
        return builder.tree
    }

    func parser(
        _ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?,
        qualifiedName qName: String?, attributes attributeDict: [String: String] = [:]
    ) {
        let i = tree.elements.count
        // Namespaces unprocessed, so the name is qualified; DOM matches the local part.
        let localName = elementName.firstIndex(of: ":").map { String(elementName[elementName.index(after: $0)...]) } ?? elementName
        tree.elements.append(XTree.Element(localName: localName, attributes: attributeDict, parent: stack.last))
        if let p = stack.last { tree.elements[p].children.append(.element(i)) }
        stack.append(i)
    }

    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
        guard let i = stack.popLast() else { return }
        tree.elements[i].end = tree.elements.count
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) { append(.text(string)) }

    func parser(_ parser: XMLParser, foundIgnorableWhitespace whitespaceString: String) { append(.text(whitespaceString)) }

    func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) { append(.text(String(decoding: CDATABlock, as: UTF8.self))) }

    func parser(_ parser: XMLParser, foundComment comment: String) { append(.other) }

    func parser(_ parser: XMLParser, foundProcessingInstructionWithTarget target: String, data: String?) { append(.other) }

    private func append(_ c: XTree.Content) {
        guard let p = stack.last else { return }
        tree.elements[p].children.append(c)
    }
}

// MARK: - IDL

extension XMLInterchange {
    /// `toIdl(model)`: a readable node/ICOM listing in the spirit of the FIPS 183
    /// IDL text form. Export only — a report, not a round-trip format.
    public static func toIdl(_ model: IDEF0Model) -> String {
        var L: [String] = []
        L.append("MODEL \(idlQuote(model.title))")
        L.append("  AUTHOR \(idlQuote(model.author))  PROJECT \(idlQuote(model.project))  STATUS \(model.status)")
        L.append("  PURPOSE \(idlQuote(oneLine(model.purpose)))")
        L.append("  VIEWPOINT \(idlQuote(oneLine(model.viewpoint)))")
        L.append("")
        var path = Set<JSStringKey>()
        func walk(_ dg: Diagram, _ depth: Int) {
            path.insert(JSStringKey(dg.id))
            defer { path.remove(JSStringKey(dg.id)) }
            let pad = String(repeating: "  ", count: depth + 1)
            L.append("\(pad)DIAGRAM \(dg.node) \(idlQuote(dg.title))")
            let codes = model.exactIcomCodes(dg)
            for a in dg.arrows {
                let from = a.from.kind == .boundary
                    ? orNil(codes[JSStringKey("\(a.id):from")]) ?? "BOUNDARY.\(a.from.side.icomLetter)"
                    : "BOX\(idlBoxNumber(dg, a.from.boxId))"
                let to = a.to.kind == .boundary
                    ? orNil(codes[JSStringKey("\(a.id):to")]) ?? "BOUNDARY.\(a.to.side.icomLetter)"
                    : "BOX\(idlBoxNumber(dg, a.to.boxId))"
                let tunnelled = a.tunnelFrom || a.tunnelTo ? " TUNNELLED" : ""
                L.append("\(pad)  ARROW \(idlQuote(a.label)) \(a.role.rawValue.uppercased()) FROM \(from) TO \(to)\(tunnelled)")
            }
            for b in dg.sortedBoxes {
                L.append("\(pad)  ACTIVITY \(boxNode(dg, b)) \(idlQuote(b.name))")
                // A diagram detailing its own ancestor would recurse for ever; the
                // web app overflows its stack there. Stop instead.
                if let child = model.childDiagram(of: b), !path.contains(JSStringKey(child.id)) { walk(child, depth + 2) }
            }
        }
        // Without a context diagram the web app throws; there is nothing to list.
        if let ctx = model.contextDiagram { walk(ctx, 0) }
        L.append("END MODEL")
        return L.joined(separator: "\n")
    }

    /// `boxNumber(dg, id)`: the number of the box an endpoint names, or "?".
    private static func idlBoxNumber(_ dg: Diagram, _ boxId: String?) -> String {
        dg.findBox(boxId).map { String($0.number) } ?? "?"
    }

    /// `oneLine(s)`: whitespace runs collapsed to one space, trimmed.
    private static func oneLine(_ s: String) -> String { jsTrim(jsCollapseWhitespace(s)) }

    /// A double-quoted IDL string literal: backslash first, then the quote,
    /// then any line ending collapsed to the two characters `\n`, so a label
    /// or title holding a quote, a backslash or a newline cannot break the
    /// statement it sits in or merge into the next line. Order matters —
    /// quoting the backslash introduced by escaping a newline would
    /// double-escape it. Scalar by scalar, like `xmlText` — the web app's
    /// regexes match wherever a character occurs, and walking Swift
    /// `Character`s (extended grapheme clusters) would miss a quote or a
    /// backslash a combining mark has joined into a single grapheme.
    private static func idlQuote(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        let scalars = Array(s.unicodeScalars)
        var i = 0
        while i < scalars.count {
            switch scalars[i] {
            case "\\": out.append(contentsOf: "\\\\".unicodeScalars)
            case "\"": out.append(contentsOf: "\\\"".unicodeScalars)
            case "\r":
                out.append(contentsOf: "\\n".unicodeScalars)
                // A CRLF pair collapses to one `\n`, not two.
                if i + 1 < scalars.count, scalars[i + 1] == "\n" { i += 1 }
            case "\n": out.append(contentsOf: "\\n".unicodeScalars)
            default: out.append(scalars[i])
            }
            i += 1
        }
        return "\"\(String(out))\""
    }
}

extension ModelFile {
    /// A file's bytes as text, the way `Blob.text()` hands them to the web
    /// app: UTF-8 with one leading byte-order mark dropped and malformed
    /// sequences replaced by U+FFFD. Files from Windows editors and PowerShell
    /// often carry the mark; a U+FEFF anywhere else is content and stays.
    public static func decodeText(_ data: Data) -> String {
        let bom: [UInt8] = [0xEF, 0xBB, 0xBF]
        if data.count >= 3, data.prefix(3).elementsEqual(bom) {
            return String(decoding: data.dropFirst(3), as: UTF8.self)
        }
        return String(decoding: data, as: UTF8.self)
    }

    /// Read a model from either format by the web app's rule: XML when the type
    /// says so, or when the text starts with "<" after JavaScript's whitespace
    /// (`trimStart`, whose set has U+FEFF and U+2028/9 but not U+0085); the
    /// project JSON otherwise. One leading byte-order mark is dropped, as the
    /// web app's file reading drops it before either parser sees the text;
    /// `deserialize` itself stays as strict as `JSON.parse`. Concepts are not
    /// bound here; callers bind on load.
    public static func read(_ text: String, isXML: Bool = false) throws -> IDEF0Model {
        let t = text.unicodeScalars.first == "\u{FEFF}" ? String(text.unicodeScalars.dropFirst()) : text
        let looksLikeXML = t.unicodeScalars.first(where: { !isJSWhitespace($0) }) == "<"
        if isXML || looksLikeXML { return try XMLInterchange.fromXml(t) }
        return try deserialize(t)
    }
}
