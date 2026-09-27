// ModelOps.swift against goldens captured from the web app: staircase layout,
// reading order, free positions, and every scenario whose edits need nothing
// beyond model.js — replayed with the Swift operations and compared diagram by
// diagram (numbering, ICOM codes and pairing) and as the saved file.
//
// Every comparison is exact: none of these values pass through Math.hypot.

import Foundation
import Testing
@testable import IDEF0Core

@Suite("ModelOpsParity")
struct ModelOpsParityTests {

    private static let geometry = Fixtures.json("golden-geometry.json").objectValue!
    private static let goldenScenarios = Fixtures.json("golden-scenarios.json").objectValue!
    private static let scenarioSteps = Fixtures.json("scenarios.json").arrayValue!

    /// The edit DSL ops that need nothing beyond model.js.
    static let supported: Set<String> = [
        "setArrow", "setBox", "setEnd", "addArrow", "removeArrow", "swapPos", "pushBox",
        "renumberBoxes", "renumberNodes", "decompose", "removeBox", "addBox",
        // F85: deleteSubtree(m, diagramId) — the inspector's "Delete
        // decomposition" button, needing nothing beyond model.js.
        "deleteSubtree",
        // S01: layout, ports and the reading-order move.
        "moveBox", "layout", "connectPort",
        // S05: a diagram's or a concept's own field, written directly — the
        // per-element clocks need nothing beyond the model itself.
        "setDiagram", "setConcept",
    ]

    /// Ops that reach into another module: `renameConcept`, `relabelBox`,
    /// `relabelArrow` and `bindAll` all need the concept registry, and the
    /// scenarios using them are covered by ConceptsParity (F11/F14 — see
    /// `everyScenarioQueries`, which checks every scenario's saved file
    /// against its concepts section, and the named F11/F14 scenario tests);
    /// `combine`, `uncombine` and `removeConcept` (S01) by BundleParity.
    static let elsewhere: Set<String> = ["renameConcept", "relabelBox", "relabelArrow", "bindAll", "combine", "uncombine", "removeConcept"]

    /// Scenarios replayable with model.js operations alone — read from the
    /// fixture, so a new scenario needs no edit here.
    static let replayable: [String] = ModelOpsParityTests.scenarioSteps.compactMap { s in
        let o = s.objectValue!
        let ops = o["ops"]!.arrayValue!.map { $0.objectValue!["op"]!.stringValue! }
        return ops.allSatisfy { ModelOpsParityTests.supported.contains($0) } ? o["name"]!.stringValue! : nil
    }

    // MARK: Layout and ordering

    @Test("staircaseLayout(n) matches the web app for n = 1…8")
    func staircase() {
        let cases = Self.geometry["staircase"]!.arrayValue!
        #expect(cases.count == 8)
        for entry in cases {
            let o = entry.objectValue!
            let n = Int(JSONValue.toNumber(o["n"]))
            let actual = JSONValue.array(staircaseLayout(n).map { r in
                .object(JSONObject([
                    JSONMember("x", .number(r.x)), JSONMember("y", .number(r.y)),
                    JSONMember("w", .number(r.w)), JSONMember("h", .number(r.h)),
                ]))
            })
            let diff = jsonDiff(o["rects"]!, actual, path: "staircase[\(n)]", tolerance: 0)
            #expect(diff == nil, "\(diff ?? "")")
        }
    }

    @Test("boxReadingOrder matches the web app on 120 layouts")
    func readingOrder() {
        let cases = Self.geometry["reading"]!.arrayValue!
        #expect(cases.count == 120)
        for (i, entry) in cases.enumerated() {
            let o = entry.objectValue!
            let boxes = o["boxes"]!.arrayValue!.map { v -> Box in
                let b = v.objectValue!
                return Box(
                    id: b["id"]!.stringValue!, name: "", number: Int(JSONValue.toNumber(b["number"])),
                    x: JSONValue.toNumber(b["x"]), y: JSONValue.toNumber(b["y"]),
                    w: JSONValue.toNumber(b["w"]), h: JSONValue.toNumber(b["h"])
                )
            }
            let expected = o["order"]!.arrayValue!.map { $0.stringValue! }
            #expect(boxReadingOrder(boxes).map(\.id) == expected, "reading[\(i)]")
        }
    }

    @Test("freePos matches the web app on 60 sides")
    func freePositions() {
        let cases = Self.geometry["free"]!.arrayValue!
        #expect(cases.count == 60)
        for (i, entry) in cases.enumerated() {
            let o = entry.objectValue!
            var diagram = Diagram(id: "dg_free", node: "A0", title: "")
            for (k, u) in o["used"]!.arrayValue!.enumerated() {
                diagram.arrows.append(Arrow(
                    id: "ar_free\(k)", label: "",
                    from: .boundary(.left, JSONValue.toNumber(u)), to: .box("bx_free", .right, 0.5)
                ))
            }
            let actual = diagram.freePos { $0.kind == .boundary && $0.side == .left }
            #expect(actual == JSONValue.toNumber(o["pos"]), "free[\(i)]")
        }
    }

    // MARK: Scenarios

    @Test("Every scenario is either replayed here or needs more than model.js")
    func scenarioCoverage() {
        #expect(!Self.replayable.isEmpty)
        for s in Self.scenarioSteps {
            let o = s.objectValue!
            let name = o["name"]!.stringValue!
            let ops = o["ops"]!.arrayValue!.map { $0.objectValue!["op"]!.stringValue! }
            // An op that is neither replayed here nor known to belong to another
            // suite is a scenario nothing replays.
            let unknown = ops.filter { !Self.supported.contains($0) && !Self.elsewhere.contains($0) }
            #expect(unknown.isEmpty, "scenario \(name): no suite replays \(unknown)")
            let needsMore = ops.contains { !Self.supported.contains($0) }
            #expect(Self.replayable.contains(name) != needsMore, "scenario \(name): ops \(ops)")
            #expect(Self.goldenScenarios[name] != nil, "scenario \(name) has no golden")
        }
    }

    @Test("Replayed scenarios number, code and pair exactly as the web app", arguments: replayable)
    func scenario(_ name: String) throws {
        let steps = try #require(Self.scenarioSteps.first { $0.objectValue?["name"] == .string(name) }?.objectValue)
        var model = try ModelFile.deserialize(Fixtures.sampleText)
        try ScenarioReplayer.replay(steps["ops"]!.arrayValue!, on: &model)

        let golden = try #require(Self.goldenScenarios[name]?.objectValue)
        let fixed = IdNormaliser.fixedIds

        // Per diagram, in model.diagrams order. The golden normalised ids in order
        // of first appearance with `tree` ahead of `diagrams`, so the Swift side is
        // written in that same order before normalising.
        var expected = JSONObject()
        expected["tree"] = golden["tree"]
        expected["diagrams"] = .array(golden["diagrams"]!.arrayValue!.map { d in
            var o = d.objectValue!
            o["arrows"] = nil   // routing geometry: covered by the geometry suite
            return .object(o)
        })
        let actualText = IdNormaliser.normalise(snapshot(model).stringified(indent: 0), fixed: fixed)
        let actual = try JSONValue.parse(actualText)
        let diff = jsonDiff(.object(expected), actual, path: name, tolerance: 0)
        #expect(diff == nil, "\(diff ?? "")")

        // The saved file.
        let goldenFile = golden["file"]!.stringValue!
        let file = IdNormaliser.normalise(ModelFile.serialize(model), fixed: fixed)
        let goldenJSON = try JSONValue.parse(goldenFile), fileJSON = try JSONValue.parse(file)
        let fileDiff = jsonDiff(goldenJSON, fileJSON, path: "\(name).file", tolerance: 0)
        #expect(fileDiff == nil, "\(fileDiff ?? "")")
        // jsonDiff ignores member order, but the order of `diagrams` is the model's
        // own (Object.values order), so hold it to the golden separately.
        #expect(goldenJSON.objectValue?["diagrams"]?.objectValue?.keys == fileJSON.objectValue?["diagrams"]?.objectValue?.keys,
                "\(name): diagram order in the file")
        // Byte for byte, including scenarios that create objects: the web app's
        // serialize writes one canonical member order regardless of edit history.
        #expect(textDiff(goldenFile, file) == nil, "\(name).file \(textDiff(goldenFile, file) ?? "")")
    }

    // MARK: Snapshot — the fields golden-scenarios.json records per diagram

    private func snapshot(_ m: IDEF0Model) -> JSONValue {
        var root = JSONObject()
        root["tree"] = .array(m.diagramTree().map { t in
            .array([.string(t.diagram.id), .string(t.diagram.node), .number(Double(t.depth))])
        })
        root["diagrams"] = .array(m.diagrams.values.map { dg in
            var o = JSONObject()
            o["id"] = .string(dg.id)
            o["node"] = .string(dg.node)
            o["title"] = .string(dg.title)
            o["titleLocked"] = .bool(dg.titleLocked)
            o["parentBoxId"] = dg.parentBoxId.map(JSONValue.string) ?? .null
            o["boxes"] = .array(dg.boxes.map { b in
                var bo = JSONObject()
                bo["id"] = .string(b.id)
                bo["name"] = .string(b.name)
                bo["number"] = .number(Double(b.number))
                bo["node"] = .string(boxNode(dg, b))
                bo["x"] = .number(b.x)
                bo["y"] = .number(b.y)
                bo["w"] = .number(b.w)
                bo["h"] = .number(b.h)
                bo["conceptId"] = b.conceptId.map(JSONValue.string) ?? .null
                bo["childDiagramId"] = b.childDiagramId.map(JSONValue.string) ?? .null
                return .object(bo)
            })
            o["sortedBoxes"] = .array(dg.sortedBoxes.map { .string($0.id) })
            o["readingOrder"] = .array(boxReadingOrder(dg.boxes).map { .string($0.id) })
            let codes = m.icomCodes(dg)
            o["icom"] = .array(dg.arrows.flatMap { a in
                ArrowEnd.allCases.map { end in
                    JSONValue.array([
                        .string(a.id), .string(end.rawValue),
                        codes["\(a.id):\(end.rawValue)"].map(JSONValue.string) ?? .null,
                    ])
                }
            })
            let p = m.icomPairing(dg)
            var po = JSONObject()
            po["pairs"] = .array(p.pairs.map {
                .array([.string($0.side.rawValue), .string($0.child.arrow.id), .string($0.child.end.rawValue),
                        .string($0.parent.arrow.id), .string($0.code)])
            })
            po["orphans"] = .array(p.orphans.map {
                .array([.string($0.side.rawValue), .string($0.child.arrow.id), .string($0.child.end.rawValue)])
            })
            po["missing"] = .array(p.missing.map {
                .array([.string($0.side.rawValue), .string($0.parent.arrow.id), .string($0.parent.code)])
            })
            o["pairing"] = .object(po)
            o["ports"] = .array(m.ports(dg).map { ScenarioParityTests.portJSON($0) })
            return .object(o)
        })
        return .object(root)
    }
}
