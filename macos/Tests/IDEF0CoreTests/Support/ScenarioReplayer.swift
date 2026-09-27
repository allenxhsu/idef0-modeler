// Replays the edit DSL in Fixtures/scenarios.json against the Swift model.
// The golden generator applied the same steps to the web app's model, so a
// scenario replayed here must reproduce that scenario's golden exactly.

import Foundation
@testable import IDEF0Core

struct ReplayError: Error, CustomStringConvertible {
    let description: String
}

/// Applies the edit DSL of scenarios.json. Diagrams are named by node, boxes by
/// name or index, arrows by label or index; each op mirrors the one-line edit
/// the golden generator made to the web app's model.
enum ScenarioReplayer {
    /// The sample model after one named scenario from scenarios.json has been
    /// applied — the state every golden-scenarios.json entry was computed from.
    static func model(for scenario: String) throws -> IDEF0Model {
        var m = try ModelFile.deserialize(Fixtures.sampleText)
        m.bindAll()
        guard let entry = Fixtures.json("scenarios.json").arrayValue?
            .first(where: { $0.objectValue?["name"]?.stringValue == scenario })?.objectValue,
              let ops = entry["ops"]?.arrayValue
        else { throw ReplayError(description: "no scenario \(scenario)") }
        try replay(ops, on: &m)
        return m
    }

    /// Every scenario name, in file order.
    static var names: [String] {
        (Fixtures.json("scenarios.json").arrayValue ?? []).compactMap { $0.objectValue?["name"]?.stringValue }
    }

    static func replay(_ ops: [JSONValue], on m: inout IDEF0Model) throws {
        for step in ops {
            let op = step.objectValue!
            let kind = op["op"]!.stringValue!
            switch kind {
            case "renumberNodes":
                m.renumberNodes()
            // S05: a diagram's or a concept's own field, the way setBox and
            // setArrow write a box's or an arrow's — the only way to reach the
            // per-element clocks those two carry.
            case "setDiagram":
                let d = try diagramId(m, op)
                let field = op["field"]!.stringValue!
                let value = op["value"] ?? .null
                try m.updateDiagram(d) { dg in try setDiagramField(&dg, field, value) }
            case "setConcept":
                let term = op["term"]!.stringValue!
                guard let c = m.findConcept(term), let i = m.glossary.firstIndex(where: { $0.id == c.id }) else {
                    throw ReplayError(description: "no concept \(term)")
                }
                try setConceptField(&m.glossary[i], op["field"]!.stringValue!, op["value"] ?? .null)
            case "renumberBoxes":
                let d = try diagramId(m, op)
                m.updateDiagram(d) { $0.renumberBoxes() }
            case "setArrow":
                let d = try diagramId(m, op)
                let i = try arrowIndex(m.diagrams[d]!, op)
                let value = op["value"]!
                try m.updateDiagram(d) { dg in try setArrowField(&dg.arrows[i], op["field"]!.stringValue!, value) }
            case "setBox":
                let d = try diagramId(m, op)
                let i = try boxIndex(m.diagrams[d]!, op)
                // `op.valueNode` names a diagram whose id is the value — a detail
                // link to a diagram the scenario made or the sample holds.
                var value = op["value"] ?? .null
                if let node = op["valueNode"]?.stringValue {
                    guard let hit = m.diagrams.first(where: { $0.value.node == node }) else {
                        throw ReplayError(description: "no diagram \(node)")
                    }
                    value = .string(hit.key)
                }
                try m.updateDiagram(d) { dg in try setBoxField(&dg.boxes[i], op["field"]!.stringValue!, value) }
            case "setEnd":
                // `a[op.end] = resolveEnd(dg, op.value)`: one endpoint moved, the
                // arrow's label and binding kept — an endpoint drag.
                let d = try diagramId(m, op)
                let dg = m.diagrams[d]!
                let i = try arrowIndex(dg, op)
                let end = ArrowEnd(rawValue: op["end"]!.stringValue!)!
                let value = try endpoint(dg, op["value"]!)
                m.updateDiagram(d) { $0.arrows[i][end] = value }
            case "addArrow":
                let d = try diagramId(m, op)
                let dg = m.diagrams[d]!
                let arrow = Arrow(
                    id: op["id"]!.stringValue!,
                    label: op["label"]?.stringValue ?? "",
                    from: try endpoint(dg, op["from"]!),
                    to: try endpoint(dg, op["to"]!),
                    bend: op["bend"].flatMap { $0.isNull ? nil : JSONValue.toNumber($0) }
                )
                m.updateDiagram(d) { $0.arrows.append(arrow) }
            case "removeArrow":
                let d = try diagramId(m, op)
                let i = try arrowIndex(m.diagrams[d]!, op)
                let id = m.diagrams[d]!.arrows[i].id
                m.updateDiagram(d) { $0.removeArrow(id) }
            case "swapPos":
                let d = try diagramId(m, op)
                let dg = m.diagrams[d]!
                let labels = op["labels"]!.arrayValue!.map { $0.stringValue! }
                let end = ArrowEnd(rawValue: op["end"]!.stringValue!)!
                guard let a = dg.arrows.firstIndex(where: { $0.label == labels[0] }),
                      let b = dg.arrows.firstIndex(where: { $0.label == labels[1] })
                else { throw ReplayError(description: "swapPos: no arrows \(labels)") }
                m.updateDiagram(d) { dg in
                    let pa = dg.arrows[a][end].pos
                    dg.arrows[a][end].pos = dg.arrows[b][end].pos
                    dg.arrows[b][end].pos = pa
                }
            case "pushBox":
                let d = try diagramId(m, op)
                let box = Box(
                    id: op["id"]!.stringValue!, name: op["name"]?.stringValue ?? "",
                    number: Int(JSONValue.toNumber(op["number"])),
                    x: JSONValue.toNumber(op["x"]), y: JSONValue.toNumber(op["y"]),
                    w: JSONValue.toNumber(op["w"]), h: JSONValue.toNumber(op["h"])
                )
                m.updateDiagram(d) { $0.boxes.append(box) }
            case "decompose":
                let d = try diagramId(m, op)
                let i = try boxIndex(m.diagrams[d]!, op)
                let count = op["count"].map { Int(JSONValue.toNumber($0)) } ?? 3
                m.decomposeBox(diagramId: d, boxId: m.diagrams[d]!.boxes[i].id, count: count)
            case "removeBox":
                let d = try diagramId(m, op)
                let i = try boxIndex(m.diagrams[d]!, op)
                m.removeBox(diagramId: d, boxId: m.diagrams[d]!.boxes[i].id)
            case "deleteSubtree":
                // F85: `deleteSubtree(m, diagramId)` called directly, as the
                // inspector's "Delete decomposition" button does (panels.js:310)
                // — as opposed to removeBox, which reaches it indirectly.
                let d = try diagramId(m, op)
                m.deleteSubtree(d)
            case "renameConcept":
                let from = op["from"]!.stringValue!
                guard let c = m.findConcept(from) else { throw ReplayError(description: "no concept \(from)") }
                m.renameConcept(c.id, to: op["to"]!.stringValue!)
            case "relabelBox":
                let d = try diagramId(m, op)
                let i = try boxIndex(m.diagrams[d]!, op)
                m.relabelBox(diagramId: d, boxId: m.diagrams[d]!.boxes[i].id, to: op["value"]!.stringValue ?? "")
            case "relabelArrow":
                let d = try diagramId(m, op)
                let i = try arrowIndex(m.diagrams[d]!, op)
                m.relabelArrow(diagramId: d, arrowId: m.diagrams[d]!.arrows[i].id, to: op["value"]!.stringValue ?? "")
            case "bindAll":
                m.bindAll()
            case "addBox":
                // S01: addBox takes no position — the staircase decides.
                let d = try diagramId(m, op)
                m.addBox(diagramId: d)
            // S01: a term that names no concept is passed through as an
            // unknown id, which combineConcepts refuses; a refused
            // combine/uncombine is what the web app's null return is, so the
            // scenario carries on with the model unchanged.
            case "combine":
                let ids = op["members"]!.arrayValue!.map { $0.stringValue! }.map { m.findConcept($0)?.id ?? $0 }
                do { try m.combineConcepts(ids, term: op["term"]!.stringValue!) } catch is BundleError {}
            case "uncombine":
                let term = op["term"]!.stringValue!
                guard let c = m.findConcept(term) else { throw ReplayError(description: "no concept \(term)") }
                do { try m.uncombineConcept(c.id) } catch is BundleError {}
            case "removeConcept":
                let term = op["term"]!.stringValue!
                guard let c = m.findConcept(term) else { throw ReplayError(description: "no concept \(term)") }
                m.removeConcept(c.id)
            case "moveBox":
                let d = try diagramId(m, op)
                let i = try boxIndex(m.diagrams[d]!, op)
                m.moveBox(diagramId: d, boxId: m.diagrams[d]!.boxes[i].id, by: Int(JSONValue.toNumber(op["by"])))
            case "layout":
                let d = try diagramId(m, op)
                m.updateDiagram(d) { $0.layoutBoxes() }
            case "connectPort":
                // S01: the port with ICOM code `op.code` on the diagram is
                // connected to the box at `op.index`, on `op.side` at `op.pos`
                // — what the canvas does when a port is dragged onto a box
                // side: an arrow from the port's boundary endpoint carrying the
                // port's conceptId and label, the box side being the `from`
                // end for an O port and the `to` end otherwise.
                let d = try diagramId(m, op)
                let dg = m.diagrams[d]!
                let code = op["code"]!.stringValue!
                guard let port = m.ports(dg).first(where: { $0.code == code }) else {
                    throw ReplayError(description: "no port \(code) on \(dg.node)")
                }
                let box = dg.boxes[Int(JSONValue.toNumber(op["index"]))]
                let edge = Endpoint.boundary(port.side, port.pos)
                let at = Endpoint.box(box.id, Side(rawValue: op["side"]!.stringValue!)!, JSONValue.toNumber(op["pos"]))
                let (from, to) = port.role == .output ? (at, edge) : (edge, at)
                let arrow = Arrow(id: op["id"]!.stringValue!, label: port.label, conceptId: port.conceptId, from: from, to: to)
                m.updateDiagram(d) { $0.arrows.append(arrow) }
            default:
                throw ReplayError(description: "unsupported op \(kind)")
            }
        }
    }

    static func diagramId(_ m: IDEF0Model, _ op: JSONObject) throws -> String {
        let node = op["diagram"]!.stringValue!
        guard let hit = m.diagrams.first(where: { $0.value.node == node }) else {
            throw ReplayError(description: "no diagram \(node)")
        }
        return hit.key
    }

    static func arrowIndex(_ d: Diagram, _ op: JSONObject) throws -> Int {
        if let i = op["index"] { return Int(JSONValue.toNumber(i)) }
        let label = op["label"]!.stringValue!
        guard let i = d.arrows.firstIndex(where: { $0.label == label }) else {
            throw ReplayError(description: "no arrow \(label) on \(d.node)")
        }
        return i
    }

    static func boxIndex(_ d: Diagram, _ op: JSONObject) throws -> Int {
        if let i = op["index"] { return Int(JSONValue.toNumber(i)) }
        let name = op["name"]!.stringValue!
        guard let i = d.boxes.firstIndex(where: { $0.name == name }) else {
            throw ReplayError(description: "no box \(name) on \(d.node)")
        }
        return i
    }

    static func endpoint(_ d: Diagram, _ v: JSONValue) throws -> Endpoint {
        let o = v.objectValue!
        let side = Side(rawValue: o["side"]!.stringValue!)!
        let pos = JSONValue.toNumber(o["pos"])
        guard o["type"] == .string("box") else { return .boundary(side, pos) }
        let name = o["box"]!.stringValue!
        guard let box = d.boxes.first(where: { $0.name == name }) else {
            throw ReplayError(description: "no box \(name) on \(d.node)")
        }
        return .box(box.id, side, pos)
    }

    static func setArrowField(_ a: inout Arrow, _ field: String, _ v: JSONValue) throws {
        switch field {
        case "id": a.id = v.stringValue ?? ""
        case "label": a.label = v.stringValue ?? ""
        case "conceptId": a.conceptId = v.stringValue
        case "tunnelFrom": a.tunnelFrom = JSONValue.truthy(v)
        case "tunnelTo": a.tunnelTo = JSONValue.truthy(v)
        case "bend": a.bend = v.isNull ? nil : JSONValue.toNumber(v)
        case "note": a.note = v.stringValue ?? ""
        case "updatedAt": a.updatedAt = clockValue(v)
        case "deletedAt": a.deletedAt = clockValue(v)
        default: throw ReplayError(description: "setArrow: unsupported field \(field)")
        }
    }

    static func setBoxField(_ b: inout Box, _ field: String, _ v: JSONValue) throws {
        switch field {
        case "id": b.id = v.stringValue ?? ""
        case "name": b.name = v.stringValue ?? ""
        case "number": b.number = Int(JSONValue.toNumber(v))
        case "conceptId": b.conceptId = v.stringValue
        case "childDiagramId": b.childDiagramId = v.stringValue
        case "x": b.x = JSONValue.toNumber(v)
        case "y": b.y = JSONValue.toNumber(v)
        case "w": b.w = JSONValue.toNumber(v)
        case "h": b.h = JSONValue.toNumber(v)
        case "updatedAt": b.updatedAt = clockValue(v)
        case "deletedAt": b.deletedAt = clockValue(v)
        default: throw ReplayError(description: "setBox: unsupported field \(field)")
        }
    }

    /// A clock written straight onto an element by `setBox`/`setArrow`/
    /// `setDiagram`/`setConcept`. The web app will hold an empty string there
    /// as readily as an instant, and json.js treats absent, null and empty
    /// alike; the Swift model has one representation for unset, so an empty
    /// clock is nil here, exactly as `ModelFile.clock` reads one.
    static func clockValue(_ v: JSONValue) -> String? {
        guard let s = v.stringValue, !s.isEmpty else { return nil }
        return s
    }

    static func setDiagramField(_ d: inout Diagram, _ field: String, _ v: JSONValue) throws {
        switch field {
        case "updatedAt": d.updatedAt = clockValue(v)
        case "deletedAt": d.deletedAt = clockValue(v)
        default: throw ReplayError(description: "setDiagram: unsupported field \(field)")
        }
    }

    static func setConceptField(_ c: inout Concept, _ field: String, _ v: JSONValue) throws {
        switch field {
        case "updatedAt": c.updatedAt = clockValue(v)
        case "deletedAt": c.deletedAt = clockValue(v)
        default: throw ReplayError(description: "setConcept: unsupported field \(field)")
        }
    }
}
