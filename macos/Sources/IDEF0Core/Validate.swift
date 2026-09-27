// IDEF0 rule checking (FIPS 183 discipline) — a port of src/model/validate.js.
//
// Every issue names the diagram it belongs to and, where there is one, the box
// or arrow to select when the issue is clicked. Messages are the web app's
// text to the character: the toolkit reading a model must see the same
// findings whichever front-end checked it.

import Foundation

// MARK: - Issues

public enum IssueSeverity: String, Hashable, Sendable {
    case error, warning
}

/// What an issue points at — the web app's `kind`.
public enum IssueTarget: String, Hashable, Sendable {
    case box, arrow
}

public struct ValidationIssue: Hashable, Sendable {
    public var severity: IssueSeverity
    public var code: String
    public var message: String
    public var diagramId: String?
    /// The web app's `kind`.
    public var target: IssueTarget?
    /// The web app's `id`: the box or arrow `target` names.
    public var targetId: String?

    public init(
        severity: IssueSeverity, code: String, message: String,
        diagramId: String?, target: IssueTarget?, targetId: String?
    ) {
        self.severity = severity; self.code = code; self.message = message
        self.diagramId = diagramId; self.target = target; self.targetId = targetId
    }
}

public struct IssueSummary: Hashable, Sendable {
    public var errors: Int
    public var warnings: Int
    public init(errors: Int, warnings: Int) { self.errors = errors; self.warnings = warnings }
}

// MARK: - Validation

/// Words a box name or arrow label may not consist solely of. FIPS 183 §3.3.3
/// rule 15 lists them for both; §3.2.2.3 rule 5 adds "call" for labels. Only a
/// whole normalised name is matched: "Process Control" is a real phrase. Keyed
/// by code units, as the web app's `Set.has` is.
private let reservedBoxTerms: Set<JSStringKey> = Set(
    ["function", "activity", "process", "input", "output", "control", "mechanism"].map(JSStringKey.init)
)
private let reservedArrowTerms: Set<JSStringKey> = reservedBoxTerms.union([JSStringKey("call")])

// MARK: - The per-element clocks

/// The optional clocks a box, arrow, diagram or concept carries (see
/// ModelFile.swift): `updatedAt`, when the element last changed, and
/// `deletedAt`, the tombstone marking it removed. Checked in this order.
private let clockFields = ["updatedAt", "deletedAt"]

private let daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
private func isLeapYear(_ y: Int) -> Bool { (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 }

/// `Math.floor(a / b)` on integers — Swift's own `/` truncates toward zero,
/// which differs for the negative year `daysFromCivil` can reach.
private func floorDiv(_ a: Int, _ b: Int) -> Int {
    let q = a / b
    return (a % b != 0 && ((a < 0) != (b < 0))) ? q - 1 : q
}

/// `daysFromCivil(y, mo, d)` — days from 1970-01-01 to a proleptic-Gregorian
/// date; integer arithmetic only, so both apps count the same days.
private func daysFromCivil(_ y: Int, _ mo: Int, _ d: Int) -> Int {
    let yy = mo <= 2 ? y - 1 : y
    let era = floorDiv(yy, 400)
    let yoe = yy - era * 400
    let doy = floorDiv(153 * (mo + (mo > 2 ? -3 : 9)) + 2, 5) + d - 1
    let doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy
    return era * 146097 + doe - 719468
}

/// `clockInstant(text)` — a clock's instant in milliseconds since
/// 1970-01-01T00:00:00Z, or nil when the text is not an ISO-8601 instant:
/// `YYYY-MM-DDTHH:MM:SS`, optionally a fraction of a second, then an explicit
/// zone — `Z` or `±HH:MM`. Read code unit by code unit rather than by
/// `DateFormatter`, exactly as the web app reads it rather than by
/// `Date.parse`: two clocks must order the same way in both apps or the
/// ordering rule below means nothing.
public func clockInstant(_ text: String) -> Double? {
    let t = Array(text.utf16)
    func charAt(_ i: Int) -> Int { i >= 0 && i < t.count ? Int(t[i]) : -1 }
    func digitAt(_ i: Int) -> Int { let c = charAt(i); return c >= 48 && c <= 57 ? c - 48 : -1 }
    func numAt(_ i: Int, _ n: Int) -> Int {
        var v = 0
        for k in 0..<n {
            let d = digitAt(i + k)
            if d < 0 { return -1 }
            v = v * 10 + d
        }
        return v
    }
    let y = numAt(0, 4), mo = numAt(5, 2), d = numAt(8, 2)
    let h = numAt(11, 2), mi = numAt(14, 2), se = numAt(17, 2)
    if y < 0 || mo < 0 || d < 0 || h < 0 || mi < 0 || se < 0 { return nil }
    if charAt(4) != 45 || charAt(7) != 45 || charAt(10) != 84 { return nil }
    if charAt(13) != 58 || charAt(16) != 58 { return nil }
    if mo < 1 || mo > 12 { return nil }
    let dim = mo == 2 && isLeapYear(y) ? 29 : daysInMonth[mo - 1]
    if d < 1 || d > dim { return nil }
    if h > 23 || mi > 59 || se > 59 { return nil }
    var i = 19
    var ms = 0
    if charAt(i) == 46 {
        i += 1
        var n = 0
        while digitAt(i) >= 0 {
            if n < 3 { ms = ms * 10 + digitAt(i) }
            n += 1
            i += 1
        }
        if n == 0 { return nil }
        while n < 3 { ms *= 10; n += 1 }
    }
    let z = charAt(i)
    var offset = 0
    if z == 90 {
        i += 1
    } else if z == 43 || z == 45 {
        let oh = numAt(i + 1, 2), om = numAt(i + 4, 2)
        if oh < 0 || om < 0 || charAt(i + 3) != 58 { return nil }
        if oh > 23 || om > 59 { return nil }
        offset = (z == 43 ? 1 : -1) * (oh * 60 + om)
        i += 6
    } else {
        return nil
    }
    if i != t.count { return nil }
    return Double((daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se - offset * 60) * 1000 + ms)
}

/// `checkClocks(el, subject, …)` — one element's clocks: each must read as an
/// ISO-8601 instant, and a tombstone cannot predate the change it ends. An
/// absent or empty clock is simply unset and says nothing. `subject` names the
/// element the way the rest of these messages name it.
private func checkClocks(
    _ updatedAt: String?, _ deletedAt: String?, _ subject: String,
    _ diagramId: String?, _ target: IssueTarget?, _ targetId: String?,
    _ add: (IssueSeverity, String, String, String?, IssueTarget?, String?) -> Void
) {
    var at: [Double?] = [nil, nil]
    let values = [updatedAt, deletedAt]
    for (i, field) in clockFields.enumerated() {
        guard let value = values[i], !value.isEmpty else { continue }
        guard let instant = clockInstant(value) else {
            add(.error, "provenance-date", "\(subject): \(field) reads “\(value)”, which is not an ISO-8601 instant. Write it as 2026-09-27T14:05:00Z, or clear it.", diagramId, target, targetId)
            continue
        }
        at[i] = instant
    }
    if let u = at[0], let dd = at[1], dd < u {
        add(.error, "provenance-order", "\(subject): deletedAt (\(deletedAt ?? "")) is earlier than updatedAt (\(updatedAt ?? "")). Nothing can have been deleted before the last change to it; correct one of the two.", diagramId, target, targetId)
    }
}

/// `validate(m)` — every rule violation in the model, errors first and each
/// severity in the order it was found.
public func validate(_ model: IDEF0Model) -> [ValidationIssue] {
    let m = model
    var issues: [ValidationIssue] = []
    func add(_ severity: IssueSeverity, _ code: String, _ message: String, _ diagramId: String?,
             _ target: IssueTarget? = nil, _ targetId: String? = nil) {
        issues.append(ValidationIssue(severity: severity, code: code, message: message,
                                      diagramId: diagramId, target: target, targetId: targetId))
    }

    guard let ctx = m.contextDiagram else {
        return [ValidationIssue(severity: .error, code: "no-context", message: "The model has no A-0 context diagram.",
                                diagramId: nil, target: nil, targetId: nil)]
    }

    checkStructure(m, ctx, add)

    // Model-level requirements (FIPS 183: purpose and viewpoint).
    if jsTrim(m.purpose).isEmpty { add(.warning, "model-purpose", "The model states no purpose. Every IDEF0 model must declare one.", ctx.id) }
    if jsTrim(m.viewpoint).isEmpty { add(.warning, "model-viewpoint", "The model states no viewpoint. Every IDEF0 model must declare one.", ctx.id) }
    if jsTrim(m.title).isEmpty { add(.warning, "model-title", "The model has no title.", ctx.id) }

    let minBoxes = Sheet.decompMin
    let maxBoxes = Sheet.decompMax
    var nodeSeen = Set<JSStringKey>()

    for dg in m.diagrams.values {
        let isContext = jsStrictEquals(dg.id, m.rootDiagramId)

        // Node numbers are unique.
        if nodeSeen.contains(JSStringKey(dg.node)) { add(.error, "node-dup", "Node number \(dg.node) is used by more than one diagram.", dg.id) }
        nodeSeen.insert(JSStringKey(dg.node))

        // The diagram's own clocks.
        checkClocks(dg.updatedAt, dg.deletedAt, dg.node, dg.id, nil, nil, add)

        // Box count (§3.3.3 rule 4).
        let count = dg.boxes.count
        if isContext {
            if count != 1 {
                add(.error, "ctx-single-box", "The A-0 context diagram holds \(count) boxes; it must hold exactly one.", dg.id)
            }
        } else if count < minBoxes {
            add(.warning, "decomp-count", "\(dg.node) has \(count) box(es). A decomposition should have \(minBoxes)–\(maxBoxes); fewer than \(minBoxes) adds no detail.", dg.id)
        } else if count > maxBoxes {
            add(.error, "decomp-count", "\(dg.node) has \(count) boxes. A decomposition may hold at most \(maxBoxes).", dg.id)
        }

        // Box numbering. `Box.number` is already an integer, so the web app's
        // Number.isInteger test cannot fail here.
        var numbers = Set<Int>()
        var numberIssue = false
        for b in dg.boxes {
            if numbers.contains(b.number) { add(.error, "box-number-dup", "Box number \(b.number) appears twice on \(dg.node).", dg.id, .box, b.id); numberIssue = true }
            numbers.insert(b.number)
            if isContext {
                if b.number != 0 {
                    add(.error, "box-number-range", "The A-0 top box is numbered \(b.number); it must be 0.", dg.id, .box, b.id)
                    numberIssue = true
                }
            } else if b.number < 1 || b.number > maxBoxes {
                add(.error, "box-number-range", "Box number \(b.number) on \(dg.node) is outside the 1–\(maxBoxes) range IDEF0 allows.", dg.id, .box, b.id)
                numberIssue = true
            }
        }

        // Box numbers follow reading order (§3.3.4.1): a completed move or
        // resize re-derives numbers from boxReadingOrder, but a hand-edited or
        // imported file, or a stale number left by some other path, can still
        // disagree with it. Skipped on A-0, whose single box is always 0
        // (box-number-range covers that), and skipped once box-number-dup or
        // box-number-range has already flagged this diagram's numbers, which
        // would only make the order check noise.
        if !isContext && !numberIssue {
            let inOrder = boxReadingOrder(dg.boxes).enumerated().allSatisfy { $0.element.number == $0.offset + 1 }
            if !inOrder {
                add(.warning, "box-number-order", "\(dg.node): box numbers do not follow reading order (FIPS 183 §3.3.4.1); move a box or renumber to re-derive them.", dg.id)
            }
        }

        // Per-box rules.
        for b in dg.boxes {
            let node = boxNode(dg, b)
            let named = !jsTrim(b.name).isEmpty
            if !named {
                add(.error, "box-name", "Box \(b.number) on \(dg.node) is unnamed. Box names are active verb phrases.", dg.id, .box, b.id)
            } else if reservedBoxTerms.contains(JSStringKey(normTerm(b.name))) {
                add(.error, "reserved-term", "“\(b.name)” (\(node)) is a reserved IDEF0 word. Name the function it performs (FIPS 183 §3.3.3).", dg.id, .box, b.id)
            } else if !looksLikeVerbPhrase(b.name) {
                add(.warning, "box-verb", "“\(b.name)” (\(node)) may not be an active verb phrase — IDEF0 box names are verbs, e.g. “Assemble Chassis”.", dg.id, .box, b.id)
            }
            // The box is too small to show its full name, even at the
            // smallest size the renderer will try (§3.2.1.3).
            if named {
                let lines = boxNameLines(b.name, w: b.w, h: b.h, number: b.number, fontSize: 10)
                if let last = lines.last, last.hasSuffix("…") {
                    add(.warning, "box-name-fit", "\(node) is too small to show its full name (FIPS 183 §3.2.1.3)", dg.id, .box, b.id)
                }
            }

            var roles = Set<Role>()
            var calls = 0
            for a in dg.arrowsTouching(b.id) {
                if a.to.isOnBox(b.id) { roles.insert(a.to.side.role) }
                if a.from.isOnBox(b.id) {
                    roles.insert(a.from.side == .bottom ? .call : .output)
                    if a.from.side == .bottom { calls += 1 }
                }
            }
            if !roles.contains(.control) { add(.error, "box-control", "\(node) has no control. Every IDEF0 box requires at least one control arrow on its top.", dg.id, .box, b.id) }
            if !roles.contains(.output) { add(.error, "box-output", "\(node) has no output. Every IDEF0 box requires at least one output arrow from its right.", dg.id, .box, b.id) }

            // Call arrows: at most one per box (§3.3.3 rule 11), and a caller is
            // detailed by the box it calls, not by a child of its own (§3.3.2.10).
            if calls > 1 {
                add(.error, "box-call-count", "\(node) has \(calls) call arrows. A box may have at most one (FIPS 183 §3.3.3).", dg.id, .box, b.id)
            }
            if calls > 0 && m.childDiagram(of: b) != nil {
                add(.error, "call-decomposed", "\(node) has a call arrow and a child diagram. A caller box is detailed by the box it calls, not by a decomposition of its own (FIPS 183 §3.3.2.10).", dg.id, .box, b.id)
            }

            if named && m.conceptById(b.conceptId) == nil {
                add(.error, "concept-unbound", "\(node) is not bound to a glossary concept. Re-enter its name to bind it.", dg.id, .box, b.id)
            }
            // A box denotes a function, never an object (§3.2.2); "other" is a
            // kind somebody chose deliberately, so it passes.
            if named, let c = m.conceptById(b.conceptId), c.kind == "data" || c.kind == "mechanism" {
                add(.warning, "concept-kind", "\(node) is bound to “\(c.term)”, which the glossary records as \(c.kind). A box denotes an activity.", dg.id, .box, b.id)
            }

            checkClocks(b.updatedAt, b.deletedAt, node, dg.id, .box, b.id, add)
        }

        // Per-arrow rules. Messages quote `a.label || 'unlabelled'`: an
        // all-blank label is quoted as written.
        for a in dg.arrows {
            let shown = a.label.isEmpty ? "unlabelled" : a.label
            let role = a.role
            if jsTrim(a.label).isEmpty {
                add(.error, "arrow-label", "An unlabelled \(jsLowercase(role.label)) arrow on \(dg.node). Arrow labels are noun phrases.", dg.id, .arrow, a.id)
            } else if reservedArrowTerms.contains(JSStringKey(normTerm(a.label))) {
                add(.error, "reserved-term", "“\(a.label)” on \(dg.node) is a reserved IDEF0 word. Label the arrow with the object it carries (FIPS 183 §3.2.2.3).", dg.id, .arrow, a.id)
            }
            for end in ArrowEnd.allCases {
                let e = a[end]
                if e.kind == .box && dg.findBox(e.boxId) == nil {
                    add(.error, "arrow-dangling", "An arrow on \(dg.node) points at a box that no longer exists.", dg.id, .arrow, a.id)
                }
            }
            if a.from.kind == .boundary && a.to.kind == .boundary {
                add(.error, "arrow-passthrough", "“\(shown)” runs from boundary to boundary on \(dg.node) without touching a box.", dg.id, .arrow, a.id)
            }
            // Boundary ends run inward on the left, top and bottom and outward
            // on the right (§3.3.2.7–8); a call arrow may end at the bottom edge.
            for end in ArrowEnd.allCases {
                let e = a[end]
                if e.kind != .boundary { continue }
                if (e.side == .right ? end == .to : end == .from) { continue }
                if role == .call && end == .to && e.side == .bottom { continue }
                add(.error, "boundary-direction", "“\(shown)” runs the wrong way at the \(e.side.rawValue) edge of \(dg.node). Boundary arrows enter a diagram on the left, top or bottom and leave it on the right.", dg.id, .arrow, a.id)
            }
            if a.from.kind == .box && (a.from.side == .left || a.from.side == .top) {
                add(.error, "arrow-origin", "“\(shown)” leaves a box from its \(a.from.side.rawValue). Arrows leave a box only from the right (output) or bottom (call).", dg.id, .arrow, a.id)
            }
            if a.from.kind == .box && a.from.side == .bottom && a.to.kind == .box {
                add(.error, "call-target", "“\(shown)” leaves a box from its bottom and runs into a box on \(dg.node). A call arrow ends unconnected, labelled with the reference expression of the box it calls (FIPS 183 §3.2.2.3).", dg.id, .arrow, a.id)
            }
            if a.to.kind == .box && a.to.side == .right {
                add(.error, "arrow-target", "“\(shown)” enters a box on its right. The right side carries outputs only.", dg.id, .arrow, a.id)
            }
            if a.from.kind == .box && a.to.kind == .box && jsStrictEquals(a.from.boxId, a.to.boxId) {
                add(.error, "arrow-self", "“\(shown)” starts and ends on the same box.", dg.id, .arrow, a.id)
            }
            // FIPS 183 §3.4.2 bars a tunnel only at an unconnected (boundary)
            // end: A-0 has no parent to resolve it against. A tunnel at the
            // box end is ordinary notation (§3.3.2.9) that happens to be moot
            // on A-0.
            if isContext && ((a.tunnelFrom && a.from.kind == .boundary) || (a.tunnelTo && a.to.kind == .boundary)) {
                add(.error, "ctx-tunnel", "“\(shown)” is tunnelled at its unconnected end on the A-0 context diagram. A-0 has no parent, so it carries neither ICOM codes nor tunnels.", dg.id, .arrow, a.id)
            }
            if !jsTrim(a.label).isEmpty && m.conceptById(a.conceptId) == nil {
                add(.error, "concept-unbound", "“\(a.label)” on \(dg.node) is not bound to a glossary concept. Re-enter its label to bind it.", dg.id, .arrow, a.id)
            }
            if !jsTrim(a.label).isEmpty, let c = m.conceptById(a.conceptId), c.kind == "activity" {
                add(.warning, "concept-kind", "“\(a.label)” on \(dg.node) is bound to activity “\(c.term)”. An arrow denotes an object; give it a distinct term or change the concept’s kind.", dg.id, .arrow, a.id)
            }

            checkClocks(a.updatedAt, a.deletedAt, "“\(shown)” on \(dg.node)", dg.id, .arrow, a.id, add)
        }

        // Parent / child ICOM consistency, in box-number order.
        for b in dg.sortedBoxes {
            guard let child = m.childDiagram(of: b) else { continue }
            issues.append(contentsOf: checkIcomConsistency(m, child))
        }
    }

    // Every concept the model uses must be defined. Lecture W2.2 p.53: "All
    // activities and all concepts must have a glossary entry"; FIPS 183
    // §3.2.2.1 asks the same of key words and phrases. Reported once per
    // concept, pointed at the first place it is used.
    let used = m.exactConceptUsage()
    // Bundles (FIPS 183 §3.2.2.3): a concept belongs to at most one bundle,
    // once; no bundle contains itself; a bundle combines at least two
    // concepts, ideally of one kind. Each issue points at the first place the
    // member concerned is used, so clicking it lands on an arrow of the
    // bundle; failing that, at A-0.
    var memberIn: [JSStringKey: String] = [:]
    func termOf(_ id: String) -> String { m.conceptById(id)?.term ?? id }
    func target(_ ids: [String]) -> (String?, IssueTarget?, String?) {
        for id in ids {
            if let first = m.occurrencesOf(id).first { return (first.diagramId, IssueTarget(rawValue: first.kind.rawValue), first.id) }
        }
        return (ctx.id, nil, nil)
    }
    for g in m.glossary {
        let clockTarget = target([g.id])
        checkClocks(g.updatedAt, g.deletedAt, "“\(g.term)”", clockTarget.0, clockTarget.1, clockTarget.2, add)
        if let uses = used[JSStringKey(g.id)], jsTrim(g.definition).isEmpty {
            let first = m.occurrencesOf(g.id).first
            add(.warning, "concept-undefined",
                "“\(g.term)” (\(g.kind)) is used \(uses)× but has no glossary definition.",
                first?.diagramId ?? ctx.id, first.map { IssueTarget(rawValue: $0.kind.rawValue)! }, first?.id)
        }
        guard g.isBundle else { continue }
        var seenHere = Set<JSStringKey>()
        for id in g.members {
            let key = JSStringKey(id)
            if seenHere.contains(key) {
                let t = target([id])
                add(.error, "bundle-member-dup", "Bundle “\(g.term)” lists “\(termOf(id))” more than once.", t.0, t.1, t.2)
            } else if let first = memberIn[key] {
                let t = target([id])
                add(.error, "bundle-member-dup", "“\(termOf(id))” is a member of both “\(first)” and “\(g.term)”. A concept belongs to at most one bundle.", t.0, t.1, t.2)
            } else {
                memberIn[key] = g.term
            }
            seenHere.insert(key)
        }
        if m.transitiveMembers(g.id).contains(JSStringKey(g.id)) {
            let t = target(g.members)
            add(.error, "bundle-cycle", "Bundle “\(g.term)” contains itself through its members. Un-combine it to break the cycle.", t.0, t.1, t.2)
        }
        let known = g.members.filter { m.conceptById($0) != nil }
        if known.count < 2 {
            let t = target(g.members)
            add(.warning, "bundle-thin", "Bundle “\(g.term)” has \(known.count) member(s). A bundle combines at least two concepts (FIPS 183 §3.2.2.3).", t.0, t.1, t.2)
        }
        var kinds: [String] = []
        for id in known {
            let k = m.conceptById(id)!.kind
            if !kinds.contains(where: { jsStrictEquals($0, k) }) { kinds.append(k) }
        }
        if kinds.count > 1 {
            let t = target(g.members)
            add(.warning, "bundle-mixed-kind", "Bundle “\(g.term)” combines concepts of different kinds (\(kinds.joined(separator: ", "))). Its members should be of one kind.", t.0, t.1, t.2)
        }
    }

    // `issues.sort((p, q) => order[p.severity] - order[q.severity])` — stable.
    return issues.stableSorted { $0.severity == .error && $1.severity == .warning }
}

/// `summarize(issues)` — how many errors and warnings.
public func summarize(_ issues: [ValidationIssue]) -> IssueSummary {
    IssueSummary(errors: issues.filter { $0.severity == .error }.count,
                 warnings: issues.filter { $0.severity == .warning }.count)
}

// MARK: - Referential integrity

/// Referential integrity of the decomposition, checked before any rule that
/// follows its links. A file the editors wrote always passes; these catch
/// hand-edited, merged or imported files, which an ontology toolkit ingests.
///
/// FIPS 183 builds a model as a tree of diagrams: each detail diagram details
/// exactly one parent box. Ids are the join keys, so each must name one thing.
/// A cycle is found by a depth-first walk from A-0 that keeps the diagrams on
/// the current path and the diagrams already finished, so the walk is linear
/// even where boxes share a detail diagram.
private func checkStructure(
    _ m: IDEF0Model, _ ctx: Diagram,
    _ add: (IssueSeverity, String, String, String?, IssueTarget?, String?) -> Void
) {
    // Ids are unique: boxes and arrows model-wide, concepts in the glossary.
    var boxIds = Set<JSStringKey>()
    var arrowIds = Set<JSStringKey>()
    for dg in m.diagrams.values {
        for b in dg.boxes {
            if !boxIds.insert(JSStringKey(b.id)).inserted {
                add(.error, "id-dup", "Box id \(b.id) on \(dg.node) is already used by another box. Ids must be unique across the model.", dg.id, .box, b.id)
            }
        }
        for a in dg.arrows {
            if !arrowIds.insert(JSStringKey(a.id)).inserted {
                add(.error, "id-dup", "Arrow id \(a.id) on \(dg.node) is already used by another arrow. Ids must be unique across the model.", dg.id, .arrow, a.id)
            }
        }
    }
    var conceptIds = Set<JSStringKey>()
    for g in m.glossary where !conceptIds.insert(JSStringKey(g.id)).inserted {
        add(.error, "id-dup", "Concept id \(g.id) (“\(g.term)”) is already used by another glossary entry. Ids must be unique across the model.", ctx.id, nil, nil)
    }

    // Every detail link names a diagram that details that box alone.
    var claimed = Set<JSStringKey>()
    for dg in m.diagrams.values {
        for b in dg.boxes {
            guard let link = b.childDiagramId, !link.isEmpty else { continue }
            let node = boxNode(dg, b)
            guard let child = m.childDiagram(of: b) else {
                add(.error, "detail-dangling", "\(dg.node): box \(node) names a detail diagram the model does not hold. Clear the link or restore the diagram.", dg.id, .box, b.id)
                continue
            }
            if claimed.contains(JSStringKey(child.id)) {
                add(.error, "detail-parent", "\(dg.node): box \(node) names \(child.node) as its detail diagram, which another box already names. A diagram details exactly one box.", dg.id, .box, b.id)
            } else if !jsStrictEquals(child.parentBoxId, b.id) {
                add(.error, "detail-parent", "\(dg.node): box \(node) names \(child.node) as its detail diagram, but \(child.node) does not name that box as its parent.", dg.id, .box, b.id)
            }
            claimed.insert(JSStringKey(child.id))
        }
    }

    // No diagram details one of its own ancestors.
    var onPath = Set<JSStringKey>()
    var done = Set<JSStringKey>()
    func walk(_ dg: Diagram) {
        onPath.insert(JSStringKey(dg.id))
        for b in dg.sortedBoxes {
            guard let child = m.childDiagram(of: b), !done.contains(JSStringKey(child.id)) else { continue }
            if onPath.contains(JSStringKey(child.id)) {
                add(.error, "decomp-cycle", "\(dg.node): box \(boxNode(dg, b)) is detailed by \(child.node), which is one of its own ancestors. Unlink the decomposition.", dg.id, .box, b.id)
            } else {
                walk(child)
            }
        }
        onPath.remove(JSStringKey(dg.id))
        done.insert(JSStringKey(dg.id))
    }
    walk(ctx)

    // Every diagram hangs off the tree.
    for dg in m.diagrams.values where !jsStrictEquals(dg.id, m.rootDiagramId) && !done.contains(JSStringKey(dg.id)) {
        add(.warning, "diagram-unreachable", "\(dg.node) is not reached from the A-0 context diagram through any decomposition. Link it to the box it details or delete it.", dg.id, nil, nil)
    }
}

// MARK: - ICOM consistency

/// A child diagram's boundary arrows must match the arrows on its parent box,
/// unless one end is tunnelled: side for side, or by concept across the input,
/// control and mechanism sides where a role changes (§3.3.2.8).
///
/// Reads the very pairing that produces the drawn ICOM codes, so a code and
/// the check that justifies it can never disagree. Correspondence is
/// structural — concept, then label, then position — never label text alone,
/// because §3.3.2.4 lets a child give an arrow a more specific label than its
/// parent carries. Only a count that fails to line up is an error.
private func checkIcomConsistency(_ m: IDEF0Model, _ child: Diagram) -> [ValidationIssue] {
    var out: [ValidationIssue] = []
    let pairing = m.icomPairing(child)
    guard let parent = pairing.parent, let parentDg = m.diagrams[parent.diagramId] else { return out }
    let node = boxNode(parentDg, parent.box)
    func name(_ a: Arrow) -> String {
        let t = jsTrim(a.label)
        return t.isEmpty ? "(unlabelled)" : t
    }

    for p in pairing.pairs {
        // Both ends are bound but to different concepts (F11): a hand-edit or
        // an explicit rebind pointed one side of a pair somewhere the other
        // side does not follow. `icom-relabel` alone cannot catch this, since
        // text can still read the same while the ids diverge. Two members of
        // one bundle are the same object at this level (§3.2.2.3), so the
        // effective ids are what is compared.
        let cc = p.child.arrow.conceptId.flatMap { $0.isEmpty ? nil : $0 }
        let pc = p.parent.arrow.conceptId.flatMap { $0.isEmpty ? nil : $0 }
        if let cc, let pc, !jsStrictEquals(m.effectiveConceptId(cc), m.effectiveConceptId(pc)) {
            out.append(ValidationIssue(
                severity: .warning, code: "icom-concept-mismatch",
                message: "\(child.node): \(p.code) “\(name(p.child.arrow))” is bound to a different concept than parent box \(node) carries as “\(name(p.parent.arrow))”. The two ends of an ICOM pair should denote the same object (§3.3.2.4).",
                diagramId: child.id, target: .arrow, targetId: p.child.arrow.id))
        }
        // Two different members of one bundle: the child unbundles the
        // parent's general arrow into a specific one (§3.2.2.3), so their
        // labels differ by design and are not a relabel to question.
        if let cc, let pc, !jsStrictEquals(cc, pc), jsStrictEquals(m.effectiveConceptId(cc), m.effectiveConceptId(pc)) { continue }
        if jsStrictEquals(normTerm(p.child.arrow.label), normTerm(p.parent.arrow.label)) { continue }
        out.append(ValidationIssue(
            severity: .warning, code: "icom-relabel",
            message: "\(child.node): \(p.code) reads “\(name(p.child.arrow))” where parent box \(node) carries “\(name(p.parent.arrow))”. Fine if it details that arrow — otherwise the two have drifted apart.",
            diagramId: child.id, target: .arrow, targetId: p.child.arrow.id))
    }
    for o in pairing.orphans {
        out.append(ValidationIssue(
            severity: .error, code: "icom-orphan",
            message: "\(child.node): boundary \(o.side.role.rawValue) “\(name(o.child.arrow))” on the \(o.side.rawValue) has no matching arrow on parent box \(node). Connect it on \(parentDg.node) or tunnel it.",
            diagramId: child.id, target: .arrow, targetId: o.child.arrow.id))
    }
    for ms in pairing.missing {
        out.append(ValidationIssue(
            severity: .error, code: "icom-missing",
            message: "\(parentDg.node): \(ms.parent.code) “\(name(ms.parent.arrow))” on box \(node) (\(ms.side.rawValue)) does not appear as a boundary arrow on \(child.node). Add it there or tunnel it.",
            diagramId: parentDg.id, target: .box, targetId: parent.box.id))
    }
    return out
}

// MARK: - Box-name heuristic

/// `looksLikeVerbPhrase(name)`. Box names are active verb phrases (FIPS 183
/// §3.2.2.2); this only flags the obvious nouns. Both regexes are
/// case-insensitive without the `u` flag, which folds ASCII letters only.
///
///   NOUNY = /^(the|a|an)\s/i                — tested on the untrimmed name
///   /(?:ing|tion|sion|ment|ness|ity|ance|ence)$/i on the first word, flagged
///   only when that word is the whole name
private func looksLikeVerbPhrase(_ name: String) -> Bool {
    let words = jsWords(name)
    let first = words.first ?? ""
    let scalars = Array(name.unicodeScalars)
    for article in ["the", "a", "an"] {
        let k = article.unicodeScalars.count
        if scalars.count > k, asciiEqualFolded(scalars[0..<k], article), isJSWhitespace(scalars[k]) { return false }
    }
    // `name.trim().split(/\s+/)` has one element for a trimmed name that is
    // all whitespace too, but only named boxes reach this test.
    let wordCount = max(words.count, 1)
    let firstScalars = Array(first.unicodeScalars)
    for suffix in ["ing", "tion", "sion", "ment", "ness", "ity", "ance", "ence"] {
        let k = suffix.unicodeScalars.count
        if firstScalars.count >= k, asciiEqualFolded(firstScalars[(firstScalars.count - k)...], suffix), wordCount == 1 {
            return false
        }
    }
    return true
}

/// Case-insensitive comparison as a non-`u` JavaScript regex makes it: a
/// non-ASCII character never matches an ASCII pattern letter.
private func asciiEqualFolded(_ scalars: ArraySlice<Unicode.Scalar>, _ lowerASCII: String) -> Bool {
    let pattern = Array(lowerASCII.unicodeScalars)
    guard scalars.count == pattern.count else { return false }
    for (s, p) in zip(scalars, pattern) {
        guard s.isASCII else { return false }
        let v = s.value >= 0x41 && s.value <= 0x5A ? s.value + 0x20 : s.value
        if v != p.value { return false }
    }
    return true
}
