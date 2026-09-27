// The native project file, `*.idef0.json` — a line-by-line port of
// src/io/json.js.
//
// `deserialize` repairs a file the way the web app does, down to JavaScript's
// coercions: `num(null, 100)` is 0 because `Number(null)` is 0, while a missing
// key falls back to 100; `titleLocked ?? …` keeps an explicit `false`; a
// diagram's dictionary key wins over the `id` written inside it. The optional
// per-element clocks `updatedAt` and `deletedAt` are read and written as the
// web app does — absent, null or empty means unset, and an unset clock is no
// member at all. Members of
// the model, a glossary entry, a diagram, a box or an arrow that this app does
// not model are kept and written back after the ones it does; an endpoint's are
// not. A glossary entry, box or arrow without an id (absent or null) is given a
// fresh one, and each such repair is reported out of band, never on the model.
// Missing `created` / `revised` dates stay empty; only the model id falls back.
//
// `serialize` writes members in the order the web app's object literals create
// them and formats exactly as `JSON.stringify(model, null, 2)`, so the same
// model produces the same bytes from either front-end.

public enum ModelFileError: Error, Equatable, Sendable, CustomStringConvertible {
    case invalidJSON(String)
    case notAnObject
    case notAModel
    case missingRoot
    case invalidDiagram(String)

    /// Messages match the web app's word for word.
    public var description: String {
        switch self {
        case .invalidJSON(let detail): return "Not valid JSON: \(detail)"
        case .notAnObject: return "File does not contain an object."
        case .notAModel: return "File is not an IDEF0 model (no diagrams / rootDiagramId)."
        case .missingRoot: return "rootDiagramId does not name a diagram in the file."
        case .invalidDiagram(let id): return "Diagram \(id) is not an object."
        }
    }
}

public enum ModelFile {
    /// Top-level members the web app's `createModel` defines, in its order.
    static let modelKeys = [
        "schema", "id", "title", "author", "project", "purpose", "viewpoint",
        "status", "created", "revised", "glossary", "diagrams", "rootDiagramId",
    ]
    /// The per-element clocks, written after everything else the element
    /// models and before its extras, in this order. Absent, null and the
    /// empty string all mean unset, and an unset clock is no member at all —
    /// never `null`, which would change the bytes of every file written
    /// before the clocks existed.
    static let clockKeys = ["updatedAt", "deletedAt"]
    static let conceptKeys = ["id", "term", "kind", "definition", "members"] + clockKeys
    static let diagramKeys = ["id", "node", "title", "titleLocked", "parentBoxId", "cNumber", "notes", "boxes", "arrows"] + clockKeys
    static let boxKeys = ["id", "name", "number", "conceptId", "x", "y", "w", "h", "childDiagramId", "note", "refs"] + clockKeys
    static let arrowKeys = ["id", "label", "conceptId", "from", "to", "bend", "ldx", "ldy", "tunnelFrom", "tunnelTo", "note"] + clockKeys

    // MARK: Reading

    public static func deserialize(_ text: String) throws -> IDEF0Model {
        var repairs: [String] = []
        return try deserialize(text, repairs: &repairs)
    }

    /// `deserialize(text, { repairs })`: also appends a sentence for each
    /// repair that invented data — an id given to a glossary entry, box or
    /// arrow that had none, a glossary entry that is not an object dropped —
    /// in the web app's words and order.
    public static func deserialize(_ text: String, repairs: inout [String]) throws -> IDEF0Model {
        let raw: JSONValue
        do { raw = try JSONValue.parse(text) } catch let e as JSONParseError {
            throw ModelFileError.invalidJSON(e.description)
        }
        // `!raw || typeof raw !== 'object'` — an array passes this test.
        let obj: JSONObject
        switch raw {
        case .object(let o): obj = o
        case .array: throw ModelFileError.notAModel
        default: throw ModelFileError.notAnObject
        }
        guard JSONValue.truthy(obj["diagrams"]), JSONValue.truthy(obj["rootDiagramId"]) else {
            throw ModelFileError.notAModel
        }

        var model = IDEF0Model.create(title: "Untitled Model")
        func str(_ key: String, _ fallback: String) -> String {
            guard let v = obj[key], !v.isNull else { return fallback }
            return JSONValue.toJSString(v)
        }
        model.id = str("id", model.id)
        model.title = str("title", model.title)
        model.author = str("author", model.author)
        model.project = str("project", model.project)
        model.purpose = str("purpose", model.purpose)
        model.viewpoint = str("viewpoint", model.viewpoint)
        model.status = str("status", model.status)
        model.created = str("created", "")
        model.revised = str("revised", "")
        model.rootDiagramId = JSONValue.toJSString(obj["rootDiagramId"]!)

        model.extras = extras(of: obj, except: modelKeys)

        model.glossary = (obj["glossary"]?.arrayValue ?? []).enumerated().compactMap { i, value in
            concept(from: value, index: i, repairs: &repairs)
        }

        var diagrams = OrderedMap<Diagram>()
        for (id, value) in entries(of: obj["diagrams"]!) {
            diagrams[id] = try diagram(id: id, from: value, repairs: &repairs)
        }
        model.diagrams = diagrams

        guard model.diagrams[model.rootDiagramId] != nil else { throw ModelFileError.missingRoot }
        return model
    }

    /// `Object.entries(value)`.
    private static func entries(of value: JSONValue) -> [(String, JSONValue)] {
        switch value {
        case .object(let o): return o.jsOrderedMembers.map { ($0.key, $0.value) }
        case .array(let a): return a.enumerated().map { (String($0.offset), $0.element) }
        default: return []
        }
    }

    /// `num(v, d)`: `Number.isFinite(Number(v)) ? Number(v) : d`.
    static func num(_ v: JSONValue?, _ fallback: Double) -> Double {
        let n = JSONValue.toNumber(v)
        return n.isFinite ? n : fallback
    }

    /// `v || ''` — the value when truthy, as a string.
    static func orEmpty(_ v: JSONValue?) -> String {
        JSONValue.truthy(v) ? JSONValue.toJSString(v!) : ""
    }

    /// `v ?? null` for an identifier.
    static func optionalId(_ v: JSONValue?) -> String? {
        guard let v, !v.isNull else { return nil }
        return JSONValue.toJSString(v)
    }

    /// `clocksOf(o)` from json.js: a clock that is absent, null or the empty
    /// string is unset; anything else is coerced to a string as `id` is.
    static func clock(_ v: JSONValue?) -> String? {
        guard let v, !v.isNull else { return nil }
        let s = JSONValue.toJSString(v)
        return s.isEmpty ? nil : s
    }

    /// `Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))`.
    private static func extras(of o: JSONObject, except keys: [String]) -> JSONObject {
        var extras = JSONObject()
        for m in o.jsOrderedMembers where !keys.contains(where: { jsStrictEquals($0, m.key) }) {
            extras[m.key] = m.value
        }
        return extras
    }

    private static func concept(from value: JSONValue, index: Int, repairs: inout [String]) -> Concept? {
        guard let o = value.objectValue else {
            repairs.append("Glossary entry \(index + 1) is not an object; it was dropped.")
            return nil
        }
        let id = optionalId(o["id"]) ?? uid("gl")
        if optionalId(o["id"]) == nil { repairs.append("Glossary entry \(index + 1) has no id; it was given \(id).") }
        return Concept(
            id: id,
            term: o["term"].map(JSONValue.toJSString) ?? "",
            kind: o["kind"].map(JSONValue.toJSString) ?? ConceptKind.other.rawValue,
            definition: o["definition"].flatMap { $0.isNull ? nil : JSONValue.toJSString($0) } ?? "",
            // `Array.isArray(members) ? members.map(String) : none` — ids
            // coerced as `id` is; anything but a list means no members.
            members: (o["members"]?.arrayValue ?? []).map(JSONValue.toJSString),
            updatedAt: clock(o["updatedAt"]), deletedAt: clock(o["deletedAt"]),
            extras: extras(of: o, except: conceptKeys)
        )
    }

    private static func diagram(id: String, from value: JSONValue, repairs: inout [String]) throws -> Diagram {
        if value.isNull { throw ModelFileError.invalidDiagram(id) }
        let d = value.objectValue ?? JSONObject()
        let title = orEmpty(d["title"])

        let titleLocked: Bool
        if let v = d["titleLocked"], !v.isNull {
            titleLocked = JSONValue.truthy(v)
        } else {
            titleLocked = !jsTrim(title).isEmpty
        }

        var boxes: [Box] = []
        for (i, v) in (d["boxes"]?.arrayValue ?? []).enumerated() {
            let b = v.objectValue ?? JSONObject()
            let n = JSONValue.toNumber(b["number"])
            let boxId = optionalId(b["id"]) ?? uid("bx")
            if v.objectValue == nil {
                repairs.append("Diagram \(id): box \(i + 1) is not an object; it was replaced by an empty box \(boxId).")
            } else if optionalId(b["id"]) == nil {
                repairs.append("Diagram \(id): box \(i + 1) has no id; it was given \(boxId).")
            }
            boxes.append(Box(
                id: boxId,
                name: orEmpty(b["name"]),
                // `Number(b.number) || 0`. Clamped well inside Int's range: a
                // conversion at exactly Double(Int.max), which rounds up, traps.
                number: (n.isFinite && n != 0) ? Int(clamp(n, -1e15, 1e15)) : 0,
                conceptId: optionalId(b["conceptId"]),
                x: num(b["x"], 100), y: num(b["y"], 100),
                w: num(b["w"], 190), h: num(b["h"], 112),
                childDiagramId: optionalId(b["childDiagramId"]),
                note: orEmpty(b["note"]),
                refs: orEmpty(b["refs"]),
                updatedAt: clock(b["updatedAt"]), deletedAt: clock(b["deletedAt"]),
                extras: extras(of: b, except: boxKeys)
            ))
        }

        var arrows: [Arrow] = []
        for (i, v) in (d["arrows"]?.arrayValue ?? []).enumerated() {
            let a = v.objectValue ?? JSONObject()
            var bend: Double?
            if let bv = a["bend"], !bv.isNull {
                let n = JSONValue.toNumber(bv)
                bend = n.isFinite ? n : nil
            }
            let arrowId = optionalId(a["id"]) ?? uid("ar")
            if v.objectValue == nil {
                repairs.append("Diagram \(id): arrow \(i + 1) is not an object; it was replaced by an empty arrow \(arrowId).")
            } else if optionalId(a["id"]) == nil {
                repairs.append("Diagram \(id): arrow \(i + 1) has no id; it was given \(arrowId).")
            }
            arrows.append(Arrow(
                id: arrowId,
                label: orEmpty(a["label"]),
                conceptId: optionalId(a["conceptId"]),
                from: endpoint(a["from"]),
                to: endpoint(a["to"]),
                bend: bend,
                ldx: num(a["ldx"], 0), ldy: num(a["ldy"], 0),
                tunnelFrom: JSONValue.truthy(a["tunnelFrom"]),
                tunnelTo: JSONValue.truthy(a["tunnelTo"]),
                note: orEmpty(a["note"]),
                updatedAt: clock(a["updatedAt"]), deletedAt: clock(a["deletedAt"]),
                extras: extras(of: a, except: arrowKeys)
            ))
        }

        return Diagram(
            id: id,
            node: JSONValue.truthy(d["node"]) ? JSONValue.toJSString(d["node"]!) : "A0",
            title: title,
            titleLocked: titleLocked,
            parentBoxId: optionalId(d["parentBoxId"]),
            cNumber: orEmpty(d["cNumber"]),
            notes: d["notes"]?.arrayValue ?? [],
            boxes: boxes,
            arrows: arrows,
            updatedAt: clock(d["updatedAt"]), deletedAt: clock(d["deletedAt"]),
            extras: extras(of: d, except: diagramKeys)
        )
    }

    /// `endpoint(e)` from json.js.
    static func endpoint(_ v: JSONValue?) -> Endpoint {
        guard let v, JSONValue.truthy(v), let e = v.objectValue ?? (v.arrayValue != nil ? JSONObject() : nil) else {
            return .boundary(.left, 0.5)
        }
        let side = JSONValue.truthy(e["side"]) ? (Side(rawValue: JSONValue.toJSString(e["side"]!)) ?? .left) : .left
        let pos = num(e["pos"], 0.5)
        if e["type"] == .string("box") {
            return Endpoint(kind: .box, boxId: e["boxId"].flatMap { $0.isNull ? nil : JSONValue.toJSString($0) }, side: side, pos: pos)
        }
        return .boundary(side, pos)
    }

    // MARK: Writing

    /// `serialize(model)` — `JSON.stringify({ ...model, schema: SCHEMA }, null, 2)`.
    public static func serialize(_ model: IDEF0Model) -> String {
        jsonValue(model).stringified(indent: 2)
    }

    public static func jsonValue(_ model: IDEF0Model) -> JSONValue {
        var o = JSONObject()
        o["schema"] = .string(IDEF0Model.schema)
        o["id"] = .string(model.id)
        o["title"] = .string(model.title)
        o["author"] = .string(model.author)
        o["project"] = .string(model.project)
        o["purpose"] = .string(model.purpose)
        o["viewpoint"] = .string(model.viewpoint)
        o["status"] = .string(model.status)
        o["created"] = .string(model.created)
        o["revised"] = .string(model.revised)
        o["glossary"] = .array(model.glossary.map(jsonValue))
        var diagrams = JSONObject()
        for (id, d) in model.diagrams { diagrams[id] = jsonValue(d) }
        o["diagrams"] = .object(diagrams)
        o["rootDiagramId"] = .string(model.rootDiagramId)
        for m in model.extras where o[m.key] == nil { o[m.key] = m.value }
        return .object(o)
    }

    static func jsonValue(_ c: Concept) -> JSONValue {
        var o = JSONObject()
        o["id"] = .string(c.id)
        o["term"] = .string(c.term)
        o["kind"] = .string(c.kind)
        o["definition"] = .string(c.definition)
        // A bundle's members, only when there are any, after `definition` and
        // before any extras — the web app's canonical member order.
        if !c.members.isEmpty { o["members"] = .array(c.members.map(JSONValue.string)) }
        writeClocks(&o, c.updatedAt, c.deletedAt)
        for m in c.extras where o[m.key] == nil { o[m.key] = m.value }
        return .object(o)
    }

    static func jsonValue(_ d: Diagram) -> JSONValue {
        var o = JSONObject()
        o["id"] = .string(d.id)
        o["node"] = .string(d.node)
        o["title"] = .string(d.title)
        o["titleLocked"] = .bool(d.titleLocked)
        o["parentBoxId"] = d.parentBoxId.map(JSONValue.string) ?? .null
        o["cNumber"] = .string(d.cNumber)
        o["notes"] = .array(d.notes)
        o["boxes"] = .array(d.boxes.map(jsonValue))
        o["arrows"] = .array(d.arrows.map(jsonValue))
        writeClocks(&o, d.updatedAt, d.deletedAt)
        for m in d.extras where o[m.key] == nil { o[m.key] = m.value }
        return .object(o)
    }

    static func jsonValue(_ b: Box) -> JSONValue {
        var o = JSONObject()
        o["id"] = .string(b.id)
        o["name"] = .string(b.name)
        o["number"] = .number(Double(b.number))
        o["conceptId"] = b.conceptId.map(JSONValue.string) ?? .null
        o["x"] = .number(b.x)
        o["y"] = .number(b.y)
        o["w"] = .number(b.w)
        o["h"] = .number(b.h)
        o["childDiagramId"] = b.childDiagramId.map(JSONValue.string) ?? .null
        o["note"] = .string(b.note)
        o["refs"] = .string(b.refs)
        writeClocks(&o, b.updatedAt, b.deletedAt)
        for m in b.extras where o[m.key] == nil { o[m.key] = m.value }
        return .object(o)
    }

    static func jsonValue(_ a: Arrow) -> JSONValue {
        var o = JSONObject()
        o["id"] = .string(a.id)
        o["label"] = .string(a.label)
        o["conceptId"] = a.conceptId.map(JSONValue.string) ?? .null
        o["from"] = jsonValue(a.from)
        o["to"] = jsonValue(a.to)
        o["bend"] = a.bend.map(JSONValue.number) ?? .null
        o["ldx"] = .number(a.ldx)
        o["ldy"] = .number(a.ldy)
        o["tunnelFrom"] = .bool(a.tunnelFrom)
        o["tunnelTo"] = .bool(a.tunnelTo)
        o["note"] = .string(a.note)
        writeClocks(&o, a.updatedAt, a.deletedAt)
        for m in a.extras where o[m.key] == nil { o[m.key] = m.value }
        return .object(o)
    }

    /// The clocks a written element carries, in `clockKeys` order: only the
    /// ones that are set, as `...clocksOf(el)` writes them.
    static func writeClocks(_ o: inout JSONObject, _ updatedAt: String?, _ deletedAt: String?) {
        if let updatedAt, !updatedAt.isEmpty { o["updatedAt"] = .string(updatedAt) }
        if let deletedAt, !deletedAt.isEmpty { o["deletedAt"] = .string(deletedAt) }
    }

    static func jsonValue(_ e: Endpoint) -> JSONValue {
        var o = JSONObject()
        o["type"] = .string(e.kind.rawValue)
        // `boxId: e.boxId ?? null` — always written for a box endpoint.
        if e.kind == .box { o["boxId"] = e.boxId.map(JSONValue.string) ?? .null }
        o["side"] = .string(e.side.rawValue)
        o["pos"] = .number(e.pos)
        return .object(o)
    }
}
