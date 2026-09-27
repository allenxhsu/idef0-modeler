// The per-element clocks, against the web app's own behaviour: the format
// stays additive, `clockInstant` reads exactly the ISO-8601 instants the rule
// allows, and the two rules say what the modeller has to fix.
//
// The instant table below is the one in tests/web/clocks.test.mjs, character
// for character, so a reading that drifts in one app fails in the other. Every
// scenario in Fixtures/scenarios.json that carries a clock is compared against
// the web app's record by ScenarioParityTests as well; these tests are the
// hand-written cases that has no scenario.

import Testing
@testable import IDEF0Core

@Suite("Clocks")
struct ClockTests {
    static func sample() throws -> IDEF0Model {
        var m = try ModelFile.deserialize(Fixtures.sampleText)
        m.bindAll()
        return m
    }

    /// The id of the diagram at `index` in model order.
    static func diagramId(_ m: IDEF0Model, _ index: Int) -> String { m.diagrams.keys[index] }

    /// The sample with a clock on one of everything, as `clocked()` builds it
    /// in tests/web/clocks.test.mjs.
    static func clocked() throws -> IDEF0Model {
        var m = try Self.sample()
        let d = Self.diagramId(m, 1)
        m.updateDiagram(d) { dg in
            dg.updatedAt = "2026-09-25T11:30:00.500+02:00"
            dg.boxes[0].updatedAt = "2026-09-26T09:15:00Z"
            dg.boxes[1].deletedAt = "2026-09-26T10:00:00Z"
            dg.arrows[0].updatedAt = "2026-09-26T09:20:00Z"
        }
        m.glossary[0].updatedAt = "2026-09-24T08:00:00Z"
        return m
    }

    // MARK: The format

    @Test("A file written without clocks round-trips byte for byte")
    func roundTripWithout() throws {
        #expect(ModelFile.serialize(try ModelFile.deserialize(Fixtures.sampleText)) == Fixtures.sampleText)
    }

    @Test("A file written with clocks round-trips byte for byte")
    func roundTripWith() throws {
        let text = ModelFile.serialize(try Self.clocked())
        #expect(ModelFile.serialize(try ModelFile.deserialize(text)) == text)
        #expect(text.components(separatedBy: "\"updatedAt\":").count - 1 == 4)
        #expect(text.components(separatedBy: "\"deletedAt\":").count - 1 == 1)
    }

    @Test("An absent, null or empty clock writes no member at all")
    func unsetWritesNothing() throws {
        var m = try ModelFile.deserialize(Fixtures.sampleText)
        let d = Self.diagramId(m, 1)
        m.updateDiagram(d) { dg in
            dg.updatedAt = ""
            dg.deletedAt = nil
            dg.boxes[0].updatedAt = ""
            dg.arrows[0].deletedAt = nil
        }
        m.glossary[0].updatedAt = ""
        #expect(ModelFile.serialize(m) == Fixtures.sampleText)
    }

    @Test("A file whose clocks are null or empty reads them as unset")
    func readsUnset() throws {
        let text = """
        {"id":"m1","created":"","revised":"","rootDiagramId":"d1","glossary":[{"id":"g1","term":"T","kind":"data","updatedAt":""}],\
        "diagrams":{"d1":{"node":"A-0","updatedAt":null,"boxes":[{"id":"b1","name":"Do","updatedAt":"","deletedAt":null}],\
        "arrows":[{"id":"a1","label":"Thing","deletedAt":""}]}}}
        """
        let m = try ModelFile.deserialize(text)
        let dg = m.diagrams["d1"]!
        #expect(dg.updatedAt == nil)
        #expect(dg.boxes[0].updatedAt == nil && dg.boxes[0].deletedAt == nil)
        #expect(dg.arrows[0].deletedAt == nil)
        #expect(m.glossary[0].updatedAt == nil)
        #expect(!ModelFile.serialize(m).contains("updatedAt"))
        #expect(!ModelFile.serialize(m).contains("deletedAt"))
    }

    @Test("A clock is written after everything else the element models, before its extras")
    func writtenLast() throws {
        var m = try ModelFile.deserialize(Fixtures.sampleText)
        let d = Self.diagramId(m, 1)
        m.updateDiagram(d) { dg in
            dg.boxes[0].extras["iri"] = .string("urn:example:box")
            dg.boxes[0].updatedAt = "2026-09-26T09:15:00Z"
        }
        let box = ModelFile.jsonValue(m.diagrams[d]!.boxes[0]).objectValue!
        #expect(box.jsOrderedMembers.map(\.key).suffix(3) == ["refs", "updatedAt", "iri"])
    }

    @Test("A clock is never invented for an element that has none")
    func neverInvented() {
        let m = IDEF0Model.create(title: "Fresh")
        let box = m.contextDiagram!.boxes[0]
        #expect(box.updatedAt == nil && box.deletedAt == nil)
        #expect(!ModelFile.serialize(m).contains("updatedAt"))
    }

    @Test("A clock survives the XML interchange, and only for version 2")
    func xmlRoundTrip() throws {
        let m = try Self.clocked()
        let xml = XMLInterchange.toXml(m)
        #expect(xml.contains(#"updatedAt="2026-09-25T11:30:00.500+02:00""#))
        #expect(xml.contains(#"deletedAt="2026-09-26T10:00:00Z""#))
        let back = try XMLInterchange.fromXml(xml)
        #expect(ModelFile.serialize(back) == ModelFile.serialize(m))
        // A file with no version attribute reads as version 1 always did: the
        // clocks are attributes version 1 never knew, so they are ignored.
        let v1 = try XMLInterchange.fromXml(xml.replacingOccurrences(of: #" version="2""#, with: ""))
        #expect(v1.diagrams.values.allSatisfy { $0.updatedAt == nil && $0.deletedAt == nil })
        #expect(v1.diagrams.values.allSatisfy { dg in dg.boxes.allSatisfy { $0.updatedAt == nil } })
        #expect(v1.glossary.allSatisfy { $0.updatedAt == nil })
    }

    // MARK: Reading an ISO-8601 instant

    /// (text, instant) — the same table as tests/web/clocks.test.mjs.
    static let accepted: [(String, Double)] = [
        ("1970-01-01T00:00:00Z", 0),
        ("2026-09-27T14:05:00Z", 1_790_517_900_000),
        ("2026-09-27T14:05:00.5Z", 1_790_517_900_500),
        ("2026-09-27T14:05:00.123456Z", 1_790_517_900_123),
        ("2026-09-27T16:05:00+02:00", 1_790_517_900_000),
        ("2026-09-27T12:05:00-02:00", 1_790_517_900_000),
        ("2026-09-27T14:05:00+00:00", 1_790_517_900_000),
        ("2024-02-29T00:00:00Z", 1_709_164_800_000),
        ("1900-03-01T00:00:00Z", -2_203_891_200_000),
        ("0000-01-01T00:00:00Z", -62_167_219_200_000),
    ]

    static let rejected = [
        "", "yesterday",
        "2026-09-27T14:05:00",        // no zone at all
        "2026-09-27 14:05:00Z",       // a space where the T belongs
        "2026-09-27t14:05:00Z",       // a lowercase designator
        "2026-09-27T14:05:00z",
        "2026-02-30T00:00:00Z",       // a day February never has
        "1900-02-29T00:00:00Z",       // 1900 is no leap year
        "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z",
        "2026-09-27T24:00:00Z", "2026-09-27T14:60:00Z", "2026-09-27T14:05:60Z",
        "2026-09-27T14:05:00.Z",      // a fraction with no digits
        "2026-09-27T14:05:00+0200",   // no colon in the offset
        "2026-09-27T14:05:00+24:00",
        "2026-09-27T14:05:00Z ", "2026-09-27T14:05:00Zx",
        "2026-9-27T14:05:00Z",        // no padding
    ]

    @Test("clockInstant reads exactly the ISO-8601 instants the rule allows")
    func instants() {
        for (text, instant) in Self.accepted { #expect(clockInstant(text) == instant, "\(text)") }
        for text in Self.rejected { #expect(clockInstant(text) == nil, "\(text)") }
    }

    // MARK: The rules

    static func provenanceIssues(_ m: IDEF0Model) -> [ValidationIssue] {
        validate(m).filter { $0.code.hasPrefix("provenance") }
    }

    @Test("A valid clock on any element is reported as nothing at all")
    func validSaysNothing() throws {
        #expect(Self.provenanceIssues(try Self.clocked()).isEmpty)
    }

    @Test("provenance-date names the element, the field and what to write instead")
    func unreadable() throws {
        var m = try Self.sample()
        let d = Self.diagramId(m, 1)
        m.updateDiagram(d) { $0.boxes[0].updatedAt = "yesterday" }
        let found = Self.provenanceIssues(m)
        #expect(found.count == 1)
        #expect(found.first?.severity == .error)
        #expect(found.first?.code == "provenance-date")
        #expect(found.first?.message == "A1: updatedAt reads \u{201C}yesterday\u{201D}, which is not an ISO-8601 instant. Write it as 2026-09-27T14:05:00Z, or clear it.")
        #expect(found.first?.target == .box)
        #expect(found.first?.targetId == m.diagrams[d]!.boxes[0].id)
    }

    @Test("provenance-order catches a tombstone earlier than the change it ends, across zones")
    func outOfOrder() throws {
        var m = try Self.sample()
        let d = Self.diagramId(m, 1)
        m.updateDiagram(d) { dg in
            dg.arrows[0].updatedAt = "2026-09-26T12:00:00+02:00"
            dg.arrows[0].deletedAt = "2026-09-26T09:59:00Z"
        }
        let found = Self.provenanceIssues(m)
        #expect(found.count == 1)
        #expect(found.first?.severity == .error)
        #expect(found.first?.code == "provenance-order")
        #expect(found.first?.message.hasPrefix("\u{201C}Customer Order\u{201D} on A0: deletedAt (2026-09-26T09:59:00Z) is earlier than updatedAt (2026-09-26T12:00:00+02:00).") == true)
        // The same two instants the other way round are in order.
        m.updateDiagram(d) { dg in
            dg.arrows[0].updatedAt = "2026-09-26T09:59:00Z"
            dg.arrows[0].deletedAt = "2026-09-26T12:00:00+02:00"
        }
        #expect(Self.provenanceIssues(m).isEmpty)
    }

    @Test("An unreadable clock is not also ordered, and each field is reported once")
    func unreadableNotOrdered() throws {
        var m = try Self.sample()
        let d = Self.diagramId(m, 1)
        m.updateDiagram(d) { dg in
            dg.arrows[0].updatedAt = "yesterday"
            dg.arrows[0].deletedAt = "1999-01-01T00:00:00Z"
        }
        #expect(Self.provenanceIssues(m).map(\.code) == ["provenance-date"])
    }

    @Test("Every kind of element is checked: diagram, box, arrow and concept")
    func everyElement() throws {
        var m = try Self.sample()
        let d = Self.diagramId(m, 1)
        m.updateDiagram(d) { dg in
            dg.updatedAt = "no"
            dg.boxes[0].updatedAt = "no"
            dg.arrows[0].updatedAt = "no"
        }
        m.glossary[0].updatedAt = "no"
        let found = Self.provenanceIssues(m)
        #expect(found.count == 4)
        #expect(found.map(\.target) == [nil, .box, .arrow, .box])
        #expect(found[3].message.hasPrefix("\u{201C}\(m.glossary[0].term)\u{201D}: updatedAt reads") == true)
    }
}
