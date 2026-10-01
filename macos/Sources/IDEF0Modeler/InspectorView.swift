// The right column: properties of the selection (or of the diagram), and the rule check.

import IDEF0Core
import IDEF0Editing
import SwiftUI

struct InspectorView: View {
    @ObservedObject var document: IDEF0Document
    let state: EditorState
    @Environment(\.palette) private var palette

    var body: some View {
        let summary = summarize(document.issues)
        let count = summary.errors + summary.warnings
        VStack(spacing: 0) {
            // The web's `.panel-tabs`: Properties · Checks, with the count.
            HUDTabs(tabs: [(EditorState.InspectorTab.properties, "Properties"),
                           (EditorState.InspectorTab.checks, count == 0 ? "Checks ✓" : "Checks (\(count))")],
                    selection: Binding(get: { state.inspectorTab }, set: { state.inspectorTab = $0 }))
            switch state.inspectorTab {
            case .properties: PropertiesView(document: document, state: state)
            case .checks: ChecksView(document: document, state: state)
            }
        }
        .background(palette.panel)
    }
}

struct PropertiesView: View {
    @ObservedObject var document: IDEF0Document
    let state: EditorState

    var body: some View {
        let m = document.model
        if let d = m.diagrams[state.diagramId] {
            switch state.selection {
            case .box(let id):
                if let b = d.findBox(id) { BoxInspector(document: document, state: state, diagram: d, box: b).id(b.id) }
            case .arrow(let id):
                if let a = d.findArrow(id) { ArrowInspector(document: document, state: state, diagram: d, arrow: a).id(a.id) }
            case nil:
                DiagramInspector(document: document, state: state, diagram: d).id(d.id)
            }
        }
    }
}

// MARK: - Diagram

struct DiagramInspector: View {
    @ObservedObject var document: IDEF0Document
    let state: EditorState
    let diagram: Diagram
    @Environment(\.undoManager) private var undoManager
    @Environment(\.palette) private var palette

    var body: some View {
        let m = document.model
        let isContext = diagram.id == m.rootDiagramId
        let codes = m.icomCodes(diagram)
        Form {
            Section {
                LabeledContent("Node") { Text(diagram.node).font(HUDType.mono) }
                LabeledContent("Boxes", value: isContext ? "\(diagram.boxes.count)" : "\(diagram.boxes.count) (want \(Sheet.decompMin)–\(Sheet.decompMax))")
                LabeledContent("Arrows", value: "\(diagram.arrows.count)")
                CommitTextField(label: "Title", value: diagram.title) { v in
                    let did = diagram.id
                    document.apply("Rename Diagram", undoManager: undoManager) { Edits.setDiagramTitle(&$0, diagramId: did, title: v) }
                }
                CommitTextField(label: "C-Number", value: diagram.cNumber, prompt: "Revision") { v in
                    let did = diagram.id
                    document.apply("Set C-number", undoManager: undoManager) { Edits.setCNumber(&$0, diagramId: did, cNumber: v) }
                }
            } header: {
                SectionTitle("Diagram")
            }
            if let parent = m.parentOf(diagram), let pd = m.diagrams[parent.diagramId] {
                Section {
                    Button("Go to \(pd.node) — box \(parent.box.number)") { state.open(pd.id, selecting: .box(parent.box.id)) }
                } header: {
                    SectionTitle("Parent")
                }
            }
            Section {
                let rows = Self.boundaryRows(diagram, codes: codes)
                if rows.isEmpty { Text("None").foregroundStyle(palette.text2) }
                ForEach(rows.indices, id: \.self) { i in
                    Button { state.selection = .arrow(rows[i].2.id) } label: {
                        // The ICOM code as the sheet draws it: mono, accent.
                        LabeledContent { Text(rows[i].1) } label: { Text(rows[i].0).font(HUDType.mono).foregroundStyle(palette.accent) }
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                SectionTitle(isContext ? "Boundary arrows" : "Boundary arrows (ICOM)")
            }
        }
        .formStyle(.grouped)
        .onPanel(palette)
    }

    /// Every boundary end of the diagram's arrows — code, label, arrow — in
    /// the order the web app's panel lists them: `rows.sort((p, q) =>
    /// p.code.localeCompare(q.code))`. That is JavaScript collation, not
    /// Swift's `<` — an uncoded end's "—" sorts before the letters — and a
    /// stable sort, so ends with the same code (every end on A-0) keep arrow order.
    static func boundaryRows(_ diagram: Diagram, codes: [String: String]) -> [(code: String, label: String, arrow: Arrow)] {
        diagram.arrows.flatMap { a in
            ArrowEnd.allCases.compactMap { end -> (code: String, label: String, arrow: Arrow)? in
                guard a[end].kind == .boundary else { return nil }
                // `codes?.[key] || '—'`: an empty code is no code.
                let code = codes["\(a.id):\(end.rawValue)"].flatMap { $0.isEmpty ? nil : $0 } ?? "—"
                return (code, a.label.isEmpty ? "(unlabelled)" : a.label, a)
            }
        }
        .stableSorted { jsLocaleCompare($0.code, $1.code) < 0 }
    }
}

// MARK: - Box

struct BoxInspector: View {
    @ObservedObject var document: IDEF0Document
    let state: EditorState
    let diagram: Diagram
    let box: Box
    @Environment(\.undoManager) private var undoManager
    @Environment(\.palette) private var palette
    @State private var confirmsDeleteDecomposition = false

    var body: some View {
        let m = document.model
        let node = boxNode(diagram, box)
        let child = m.childDiagram(of: box)
        Form {
            Section {
                CommitTextField(label: "Name", value: box.name, prompt: "Active verb phrase") { v in
                    perform("Rename Box") { try Edits.renameBox(&$0, diagramId: diagram.id, boxId: box.id, to: v) }
                }
                LabeledContent("Box number", value: "\(box.number)")
                LabeledContent("Node number") { Text(node).font(HUDType.mono) }
                if let c = m.conceptById(box.conceptId) {
                    LabeledContent("Concept") {
                        Text(jsTrim(c.definition).isEmpty ? "\(c.term) — no definition" : c.term)
                            .foregroundStyle(jsTrim(c.definition).isEmpty ? SCStatus.warning : palette.text)
                    }
                }
                CommitTextField(label: "Notes", value: box.note, multiline: true) { v in
                    perform("Edit Box Note") { Edits.setBoxNote(&$0, diagramId: diagram.id, boxId: box.id, note: v) }
                }
            } header: {
                SectionTitle("Activity \(node)")
            }
            Section {
                if let child {
                    Button("Open \(child.node) (\(child.boxes.count) boxes)") { state.open(child.id) }
                    Button("Delete Decomposition…", role: .destructive) { confirmsDeleteDecomposition = true }
                        .foregroundStyle(SCStatus.danger)
                } else {
                    Text("Not yet decomposed. A new child diagram starts with a port at its sheet edge for each of this box’s ICOM arrows, to connect to its activities.")
                        .font(HUDType.small).foregroundStyle(palette.text2)
                    DecomposeMenu(document: document, state: state)
                }
            } header: {
                SectionTitle("Decomposition")
            }
            Section {
                let touching = diagram.arrowsTouching(box.id)
                if touching.isEmpty {
                    Text("None. IDEF0 requires at least one control and one output.").foregroundStyle(palette.text2)
                }
                ForEach(touching) { a in
                    let role: Role = a.to.isOnBox(box.id) ? a.to.side.role : (a.from.side == .bottom ? .call : .output)
                    Button { state.selection = .arrow(a.id) } label: {
                        LabeledContent(role.label) { Text(a.label.isEmpty ? "(unlabelled)" : a.label) }
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                SectionTitle("Arrows on this box")
            }
            // S01: a box has no geometry of its own to edit. It sits on the
            // staircase at its place in the reading order, and only that
            // order can be changed — through the canvas, which commits a
            // name still being typed before the box moves out from under it.
            Section {
                if m.isRootDiagram(diagram.id) {
                    Text("The A-0 context diagram holds this one box; the child diagrams' boxes are laid out along the staircase.")
                        .font(HUDType.small).foregroundStyle(palette.text2)
                } else {
                    HStack {
                        Button("Move Earlier") { state.request(.moveSelection(by: -1)) }
                            .disabled(!Edits.canMoveBox(m, diagramId: diagram.id, boxId: box.id, by: -1))
                        Button("Move Later") { state.request(.moveSelection(by: 1)) }
                            .disabled(!Edits.canMoveBox(m, diagramId: diagram.id, boxId: box.id, by: 1))
                    }
                }
            } header: {
                SectionTitle("Order")
            } footer: {
                if !m.isRootDiagram(diagram.id) {
                    SectionNote("Boxes are laid out along the staircase in reading order. Moving one earlier or later renumbers it and lays the diagram out again.")
                }
            }
        }
        .formStyle(.grouped)
        .onPanel(palette)
        .confirmationDialog("Delete \(child?.node ?? "") and everything below it?", isPresented: $confirmsDeleteDecomposition) {
            Button("Delete Decomposition", role: .destructive) {
                if let cid = child?.id {
                    perform("Delete Decomposition") { Edits.deleteDecomposition(&$0, childDiagramId: cid) }
                }
            }
        } message: {
            Text("You can undo this.")
        }
    }

    private func perform(_ name: String, _ change: (inout IDEF0Model) throws -> Void) {
        do { try document.apply(name, undoManager: undoManager, change) } catch { state.hint = String(describing: error) }
    }
}

// MARK: - Arrow

struct ArrowInspector: View {
    @ObservedObject var document: IDEF0Document
    let state: EditorState
    let diagram: Diagram
    let arrow: Arrow
    @Environment(\.undoManager) private var undoManager
    /// The concept picked under "Combine with…", until the term prompt takes it.
    @State private var combineWith: String?
    @State private var combineRequest: BundleRequest?
    @State private var bundleTerm = ""
    @Environment(\.palette) private var palette

    var body: some View {
        let m = document.model
        let codes = m.icomCodes(diagram)
        Form {
            Section {
                CommitTextField(label: "Label", value: arrow.label, prompt: "Noun phrase") { v in
                    perform("Label Arrow") { try Edits.labelArrow(&$0, diagramId: diagram.id, arrowId: arrow.id, to: v) }
                }
                if let c = m.conceptById(arrow.conceptId) {
                    LabeledContent("Concept") {
                        Text(c.term == arrow.label ? c.kind : "\(c.term) (\(c.kind))")
                    }
                }
            } header: {
                SectionTitle("\(arrow.role.label) arrow")
            }
            bundleSection(m)
            ForEach(ArrowEnd.allCases, id: \.self) { end in
                endpointSection(end, codes: codes)
            }
            // FIPS 183 §3.4.2 bars a tunnel only at an unconnected (boundary)
            // end: A-0 has no parent to hide it from. A tunnel at a box end
            // is ordinary notation (§3.3.2.9) that happens to be moot on
            // A-0, so its toggle still shows — an imported file can already
            // carry one, and this is the only way to clear it.
            let isRoot = diagram.id == m.rootDiagramId
            if !isRoot || arrow.from.isBox || arrow.to.isBox {
                Section {
                    if !isRoot || arrow.from.isBox { Toggle("Tunnel at source ( )", isOn: tunnel(.from)) }
                    if !isRoot || arrow.to.isBox { Toggle("Tunnel at destination ( )", isOn: tunnel(.to)) }
                } header: {
                    SectionTitle("Tunnelling")
                } footer: {
                    SectionNote("A tunnel means the arrow is deliberately absent from the connected diagram — not an inconsistency.")
                }
            }
            Section {
                Button("Reset Bend and Label Offset") {
                    perform("Reset Routing") { Edits.resetRouting(&$0, diagramId: diagram.id, arrowId: arrow.id) }
                }
                Button("Reverse Direction") {
                    perform("Reverse Arrow") { Edits.reverseArrow(&$0, diagramId: diagram.id, arrowId: arrow.id) }
                }
            } header: {
                SectionTitle("Routing")
            }
            Section {
                CommitTextField(label: "Notes", value: arrow.note, multiline: true) { v in
                    perform("Edit Arrow Note") { Edits.setArrowNote(&$0, diagramId: diagram.id, arrowId: arrow.id, note: v) }
                }
            } header: {
                SectionTitle("Notes")
            }
        }
        .formStyle(.grouped)
        .onPanel(palette)
        .bundleTermPrompt($combineRequest, term: $bundleTerm) { req, term in
            combineWith = nil
            perform("Combine Concepts") { try Edits.combineConcepts(&$0, memberIds: req.memberIds, term: term) }
        }
    }

    /// The bundle this arrow's concept belongs to (S01, FIPS 183 §3.2.2.3) —
    /// or is, for an arrow drawn from a bundle's port and so bound to the
    /// bundle itself — with its members and "Un-combine"; or, for a concept
    /// in no bundle, "Combine with…" over the other object concepts drawn on
    /// this diagram. The arrow keeps its own concept either way: a bundle is
    /// looked up, never written in. The web's arrow inspector shows the same.
    @ViewBuilder
    private func bundleSection(_ m: IDEF0Model) -> some View {
        if let own = m.conceptById(arrow.conceptId) {
            Section {
                if let bundle = Self.enclosingBundle(m, of: own.id) ?? (own.isBundle ? own : nil) {
                    LabeledContent("Bundle") { Text(bundle.term) }
                    Text("Members: \(bundle.members.map { m.conceptById($0)?.term ?? $0 }.joined(separator: ", "))")
                        .font(HUDType.small).foregroundStyle(palette.text2)
                    Button("Un-combine") {
                        perform("Un-combine Concept") { try Edits.uncombineConcept(&$0, bundleId: bundle.id) }
                    }
                } else if m.bundleOf(own.id) == nil {
                    let others = Self.combinableConcepts(m, diagram, excluding: own.id)
                    if others.isEmpty {
                        Text("No other concept on this diagram to combine with.").foregroundStyle(palette.text2)
                    } else {
                        Picker("Combine with…", selection: $combineWith) {
                            Text("Choose a concept").tag(String?.none)
                            ForEach(others) { Text($0.term).tag(String?.some($0.id)) }
                        }
                        Button("Combine…") {
                            guard let other = combineWith else { return }
                            let ids = [own.id, other]
                            bundleTerm = Edits.defaultBundleTerm(m, memberIds: ids)
                            combineRequest = BundleRequest(memberIds: ids)
                        }
                        .disabled(combineWith == nil)
                    }
                }
            } header: {
                SectionTitle("Bundle")
            } footer: {
                SectionNote("A bundle's term labels the one arrow drawn where its members run between the same faces; a member alone keeps its own label.")
            }
        }
    }

    /// The outermost bundle enclosing `id`, when there is one: the concept
    /// the arrow stands for on the parent (`effectiveConceptId`), compared
    /// by code units so a mere Unicode twin of the id is not taken for it.
    static func enclosingBundle(_ m: IDEF0Model, of id: String) -> Concept? {
        guard let eff = m.effectiveConceptId(id), !eff.utf16.elementsEqual(id.utf16) else { return nil }
        return m.conceptById(eff)
    }

    /// The concepts an arrow on `diagram` could be combined with: each other
    /// arrow's effective concept — the bundle it already belongs to, else its
    /// own — that is in no bundle itself, once each, in term order.
    static func combinableConcepts(_ m: IDEF0Model, _ diagram: Diagram, excluding own: String) -> [Concept] {
        var out: [Concept] = []
        for a in diagram.arrows {
            guard let id = m.effectiveConceptId(a.conceptId), !id.isEmpty, !id.utf16.elementsEqual(own.utf16),
                  !out.contains(where: { $0.id.utf16.elementsEqual(id.utf16) }),
                  let c = m.conceptById(id), m.bundleOf(id) == nil
            else { continue }
            out.append(c)
        }
        return out.stableSorted { jsLocaleCompare($0.term, $1.term) < 0 }
    }

    @ViewBuilder
    private func endpointSection(_ end: ArrowEnd, codes: [String: String]) -> some View {
        let e = arrow[end]
        let describe: String = {
            if e.kind == .boundary { return "Sheet boundary · \(codes["\(arrow.id):\(end.rawValue)"] ?? "—")" }
            let b = diagram.findBox(e.boxId)
            return "Box \(b.map { String($0.number) } ?? "?") — \(b.map { $0.name.isEmpty ? "(unnamed)" : $0.name } ?? "(missing)")"
        }()
        Section {
            Text(describe).foregroundStyle(palette.text2)
            Picker("Side", selection: Binding(get: { e.side }, set: { side in
                perform("Move Arrow End") { Edits.setEndpointSide(&$0, diagramId: diagram.id, arrowId: arrow.id, end: end, side: side) }
            })) {
                ForEach(Side.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
            }
            CommitNumberField(label: "Position (%)", value: jsRound(e.pos * 100)) { v in
                perform("Move Arrow End") { Edits.setEndpointPosition(&$0, diagramId: diagram.id, arrowId: arrow.id, end: end, percent: v) }
            }
        } header: {
            SectionTitle(end == .from ? "Source" : "Destination")
        }
    }

    private func tunnel(_ end: ArrowEnd) -> Binding<Bool> {
        Binding(get: { arrow.isTunnelled(end) }, set: { on in
            perform("Tunnel Arrow") { try Edits.setTunnel(&$0, diagramId: diagram.id, arrowId: arrow.id, end: end, on: on) }
        })
    }

    private func perform(_ name: String, _ change: (inout IDEF0Model) throws -> Void) {
        do { try document.apply(name, undoManager: undoManager, change) } catch { state.hint = String(describing: error) }
    }
}

// MARK: - Checks

struct ChecksView: View {
    @ObservedObject var document: IDEF0Document
    let state: EditorState
    @Environment(\.palette) private var palette

    var body: some View {
        let issues = document.issues
        let summary = summarize(issues)
        List {
            Section {
                LabeledContent("Rule check") {
                    Text("\(summary.errors) error\(summary.errors == 1 ? "" : "s") · \(summary.warnings) warning\(summary.warnings == 1 ? "" : "s")")
                        .font(HUDType.mono)
                }
                if issues.isEmpty {
                    Text("The model satisfies every check: box counts, box names, required controls and outputs, arrow labels, arrow attachment sides, node numbering, parent/child ICOM consistency and concept definitions.")
                        .font(HUDType.small).foregroundStyle(palette.text2)
                }
            }
            // The web's `.issue`: a card of the second panel colour with a
            // rule down its left edge in the severity's colour, the place and
            // code above the message in small mono caps.
            ForEach(issues.indices, id: \.self) { i in
                let issue = issues[i]
                let tone = issue.severity == .error ? SCStatus.danger : SCStatus.warning
                Button { reveal(issue) } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: issue.severity == .error ? "xmark.octagon.fill" : "exclamationmark.triangle.fill")
                            .foregroundStyle(tone)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(issue.diagramId.flatMap { document.model.diagrams[$0]?.node } ?? "model") · \(issue.code)")
                                .font(HUDType.monoSmall).textCase(.uppercase).tracking(0.4).foregroundStyle(palette.text2)
                            Text(issue.message).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowBackground(
                    ZStack(alignment: .leading) {
                        palette.panel2
                        Rectangle().fill(tone).frame(width: 3)
                    }
                )
            }
        }
        .onPanel(palette)
    }

    private func reveal(_ issue: ValidationIssue) {
        guard let did = issue.diagramId, document.model.diagrams[did] != nil else { return }
        let selection: Selection? = {
            guard let id = issue.targetId else { return nil }
            switch issue.target {
            case .box: return .box(id)
            case .arrow: return .arrow(id)
            case nil: return nil
            }
        }()
        state.open(did, selecting: selection)
        state.inspectorTab = .checks
    }
}
