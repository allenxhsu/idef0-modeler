// The left column: the decomposition as a node tree, the model's
// identification and objectives, and the concept registry.

import IDEF0Core
import IDEF0Editing
import SwiftUI

struct SidebarView: View {
    @ObservedObject var document: IDEF0Document
    let state: EditorState
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 0) {
            // The web's `.panel-tabs`: Node Tree · Model · Glossary.
            HUDTabs(tabs: EditorState.SidebarTab.allCases.map { ($0, $0.rawValue) },
                    selection: Binding(get: { state.sidebarTab }, set: { state.sidebarTab = $0 }))
            switch state.sidebarTab {
            case .tree: NodeTreeView(document: document, state: state)
            case .model: ModelPanel(document: document)
            case .concepts: ConceptsPanel(document: document, state: state)
            }
        }
        .background(palette.panel)
    }
}

// MARK: - Node tree

struct NodeTreeView: View {
    @ObservedObject var document: IDEF0Document
    let state: EditorState
    @Environment(\.palette) private var palette

    struct Row: Identifiable {
        let id: String
        let node: String
        let name: String
        let depth: Int
        let diagramId: String
        let boxId: String
        let childId: String?
    }

    /// Activities in reading order, each followed by its own decomposition.
    /// `activityTree` guards the walk against a decomposition cycle, which a
    /// hand-edited or imported file can hold and this tab would otherwise
    /// follow until the process ran out of stack.
    static func rows(_ m: IDEF0Model) -> [Row] {
        m.activityTree().map { d, b, depth in
            Row(id: "\(d.id)/\(b.id)", node: boxNode(d, b), name: b.name, depth: depth,
                diagramId: d.id, boxId: b.id, childId: m.childDiagram(of: b)?.id)
        }
    }

    private var rows: [Row] { Self.rows(document.model) }

    var body: some View {
        List {
            ForEach(rows) { row in
                Button { open(row) } label: {
                    HStack(spacing: 6) {
                        // `.tree .nn`: the node number in the mono face, accent.
                        Text(row.node)
                            .font(HUDType.mono)
                            .foregroundStyle(palette.accent)
                            .frame(minWidth: 34, alignment: .leading)
                        Text(row.name.isEmpty ? "(unnamed)" : row.name)
                            .italic(row.name.isEmpty)
                            .foregroundStyle(row.name.isEmpty ? palette.text2 : palette.text)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if row.childId != nil {
                            Image(systemName: "square.split.2x2").foregroundStyle(palette.text2).imageScale(.small)
                                .help("Decomposed")
                        }
                    }
                    .padding(.leading, CGFloat(row.depth) * 14)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .hudRow(current: isCurrent(row), palette)
            }
        }
        .listStyle(.plain)
        .onPanel(palette)
    }

    /// A decomposed box stands for its child diagram; any other for itself.
    private func isCurrent(_ row: Row) -> Bool {
        if let child = row.childId { return child == state.diagramId }
        return row.diagramId == state.diagramId && state.selection == .box(row.boxId)
    }

    private func open(_ row: Row) {
        if let child = row.childId { state.open(child) } else { state.open(row.diagramId, selecting: .box(row.boxId)) }
    }
}

// MARK: - Model

struct ModelPanel: View {
    @ObservedObject var document: IDEF0Document
    @Environment(\.undoManager) private var undoManager
    @Environment(\.palette) private var palette

    var body: some View {
        let m = document.model
        Form {
            Section {
                CommitTextField(label: "Title", value: m.title) { v in edit("Edit Model Title") { Edits.setModelTitle(&$0, title: v) } }
                CommitTextField(label: "Author", value: m.author) { v in edit("Edit Author") { $0.author = v } }
                CommitTextField(label: "Project", value: m.project) { v in edit("Edit Project") { $0.project = v } }
                Picker("Status", selection: Binding(get: { m.status }, set: { v in edit("Edit Status") { $0.status = v } })) {
                    ForEach(ModelStatus.allCases, id: \.rawValue) { Text($0.rawValue.capitalized).tag($0.rawValue) }
                    if m.knownStatus == nil { Text(m.status).tag(m.status) }
                }
                CommitTextField(label: "Revised", value: m.revised, prompt: "YYYY-MM-DD") { v in edit("Edit Revision Date") { $0.revised = v } }
            } header: {
                SectionTitle("Identification")
            }
            Section {
                CommitTextField(label: "Purpose", value: m.purpose, prompt: "Why the model exists", multiline: true) { v in
                    edit("Edit Purpose") { $0.purpose = v }
                }
                CommitTextField(label: "Viewpoint", value: m.viewpoint, prompt: "Whose perspective", multiline: true) { v in
                    edit("Edit Viewpoint") { $0.viewpoint = v }
                }
            } header: {
                SectionTitle("Objectives")
            } footer: {
                SectionNote("FIPS 183 §3.3.1.1: the A-0 diagram states the model's purpose and viewpoint.")
            }
            Section {
                Group {
                    LabeledContent("Diagrams", value: "\(m.diagrams.count)")
                    LabeledContent("Activities", value: "\(m.diagrams.values.reduce(0) { $0 + $1.boxes.count })")
                    LabeledContent("Arrows", value: "\(m.diagrams.values.reduce(0) { $0 + $1.arrows.count })")
                    LabeledContent("Concepts", value: "\(m.glossary.count)")
                    LabeledContent("Deepest level", value: "\(m.diagramTree().map(\.depth).max() ?? 0)")
                }
                .font(HUDType.mono)
            } header: {
                SectionTitle("Statistics")
            }
        }
        .formStyle(.grouped)
        .onPanel(palette)
    }

    private func edit(_ name: String, _ change: (inout IDEF0Model) -> Void) {
        document.apply(name, undoManager: undoManager, change)
    }
}

// MARK: - Concepts

/// What "Combine Selected" or "Combine with…" is about to combine (S01):
/// the member ids. The term offered for the bundle — the members' terms
/// joined by " & " (`Edits.defaultBundleTerm`) — is the caller's own state,
/// set before the request is, so the prompt's field shows it as it opens.
struct BundleRequest: Identifiable, Equatable {
    let id = UUID()
    let memberIds: [String]
}

/// The small prompt both combine paths share (S01): an alert asking for the
/// bundle's term, whose Combine button hands the request and the term back.
/// Cancel, or a dismissed alert, combines nothing.
struct BundleTermPrompt: ViewModifier {
    @Binding var request: BundleRequest?
    @Binding var term: String
    let onCombine: (BundleRequest, String) -> Void

    func body(content: Content) -> some View {
        content
            .alert("Combine Concepts", isPresented: Binding(get: { request != nil }, set: { if !$0 { request = nil } }), presenting: request) { req in
                TextField("Bundle term", text: $term)
                Button("Combine") { onCombine(req, term) }
                Button("Cancel", role: .cancel) {}
            } message: { req in
                Text("A bundle of \(req.memberIds.count) concepts (FIPS 183 §3.2.2.3). Its term labels the general arrow; the members keep their own arrows and can be un-combined later.")
            }
    }
}

extension View {
    func bundleTermPrompt(_ request: Binding<BundleRequest?>, term: Binding<String>, onCombine: @escaping (BundleRequest, String) -> Void) -> some View {
        modifier(BundleTermPrompt(request: request, term: term, onCombine: onCombine))
    }
}

struct ConceptsPanel: View {
    @ObservedObject var document: IDEF0Document
    let state: EditorState
    @Environment(\.undoManager) private var undoManager
    @State private var search = ""
    @State private var newTerm = ""
    @State private var newKind = ConceptKind.data.rawValue
    @State private var newDefinition = ""
    @State private var showsAdd = false
    /// The concepts ticked for combining (S01), by id, in the order ticked.
    /// Kept as ids compared by code units, never as a `Set<String>`, so a
    /// Unicode twin of a ticked id is not taken for it; an id whose concept
    /// has since gone is simply never found among the glossary.
    @State private var ticked: [String] = []
    @State private var combineRequest: BundleRequest?
    @State private var bundleTerm = ""
    @Environment(\.palette) private var palette

    var body: some View {
        let m = document.model
        let usage = m.conceptUsage()
        let concepts = m.glossary.filter { search.isEmpty || normTerm($0.term).contains(normTerm(search)) }
        let undefined = m.glossary.filter { jsTrim($0.definition).isEmpty }.count
        // In glossary (term) order, whatever order they were ticked in. A
        // concept that has since joined a bundle (combined from the arrow
        // inspector, say) no longer counts: it could not be combined again,
        // and its row shows no tick — as the web glossary drops such ticks.
        let chosen = m.glossary.filter { c in isTicked(c.id) && m.bundleOf(c.id) == nil }.map(\.id)
        List {
            Section {
                DisclosureGroup("Add concept", isExpanded: $showsAdd) {
                    TextField("Term", text: $newTerm)
                    Picker("Kind", selection: $newKind) {
                        ForEach(ConceptKind.allCases, id: \.rawValue) { Text($0.rawValue.capitalized).tag($0.rawValue) }
                    }
                    TextField("Definition", text: $newDefinition, axis: .vertical).lineLimit(2...4)
                    Button("Add") {
                        let term = newTerm, kind = newKind, def = newDefinition
                        document.apply("Add Concept", undoManager: undoManager) { Edits.addConcept(&$0, term: term, kind: kind, definition: def) }
                        newTerm = ""; newDefinition = ""
                    }
                    .disabled(jsTrim(newTerm).isEmpty)
                }
            }
            Section {
                HStack {
                    Button("Combine Selected (\(chosen.count))") {
                        bundleTerm = Edits.defaultBundleTerm(m, memberIds: chosen)
                        combineRequest = BundleRequest(memberIds: chosen)
                    }
                    .disabled(chosen.count < 2)
                    .help("Combine the ticked concepts into one bundle (FIPS 183 §3.2.2.3)")
                    if !chosen.isEmpty {
                        Button("Clear") { ticked = [] }
                            .buttonStyle(.borderless)
                    }
                }
            } footer: {
                SectionNote("Tick two or more concepts to combine them into a bundle. A concept already in a bundle cannot be ticked.")
            }
            Section {
                ForEach(concepts) { c in
                    ConceptRow(document: document, state: state, concept: c, uses: usage[c.id, default: 0],
                               ticked: m.bundleOf(c.id) == nil ? Binding(get: { isTicked(c.id) }, set: { tick(c.id, $0) }) : nil)
                        .id(c.id)
                }
            } header: {
                SectionTitle("\(m.glossary.count) concepts")
            } footer: {
                if undefined > 0 {
                    SectionNote("\(undefined) of \(m.glossary.count) have no definition yet. Every activity and object needs one.", tone: .warning)
                }
            }
        }
        .onPanel(palette)
        .searchable(text: $search, placement: .sidebar, prompt: "Filter concepts")
        .bundleTermPrompt($combineRequest, term: $bundleTerm) { req, term in
            do {
                try document.apply("Combine Concepts", undoManager: undoManager) { try Edits.combineConcepts(&$0, memberIds: req.memberIds, term: term) }
                ticked = []
            } catch {
                state.hint = String(describing: error)
            }
        }
        // The ticks survive a redraw, but not a concept that is gone or has
        // since been put in a bundle (it could not be combined again anyway,
        // and must not come back ticked once that bundle is un-combined).
        .onChange(of: m.glossary) { _, _ in pruneTicks() }
    }

    private func isTicked(_ id: String) -> Bool {
        ticked.contains { $0.utf16.elementsEqual(id.utf16) }
    }

    private func pruneTicks() {
        let m = document.model
        ticked.removeAll { m.conceptById($0) == nil || m.bundleOf($0) != nil }
    }

    private func tick(_ id: String, _ on: Bool) {
        ticked.removeAll { $0.utf16.elementsEqual(id.utf16) }
        if on { ticked.append(id) }
    }
}

struct ConceptRow: View {
    @ObservedObject var document: IDEF0Document
    let state: EditorState
    let concept: Concept
    let uses: Int
    /// The row's tick for combining (S01); nil for a concept already in a
    /// bundle, which shows the bundle it belongs to instead.
    var ticked: Binding<Bool>?
    @Environment(\.undoManager) private var undoManager
    @Environment(\.palette) private var palette

    var body: some View {
        let m = document.model
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                if let ticked {
                    Toggle("Combine", isOn: ticked)
                        .toggleStyle(.checkbox)
                        .labelsHidden()
                        .help("Tick to combine with other ticked concepts")
                }
                CommitTextField(label: "Term", value: concept.term) { v in
                    let id = concept.id
                    // Renaming carries every box and arrow along; onto an existing term, it merges.
                    document.apply("Rename Concept", undoManager: undoManager) { $0.renameConcept(id, to: v) }
                }
                .font(SCFont.ui(13, weight: .semibold))
                .textFieldStyle(.plain)
                Spacer(minLength: 4)
                // `.gl-use`: the count, secondary.
                Text(uses == 0 ? "unused" : "used \(uses)×").font(HUDType.caption).foregroundStyle(palette.text2)
                if uses == 0 {
                    Button(role: .destructive) {
                        let id = concept.id
                        // Through the core's removeConcept: a bundle is
                        // un-combined, a member leaves its bundle's list.
                        // A refusal is reported, as on every other edit path
                        // here: `try?` left the person with no hint and no
                        // beep when the concept could not be removed.
                        do {
                            try document.apply("Remove Concept", undoManager: undoManager) { try Edits.removeConcept(&$0, conceptId: id) }
                        } catch {
                            state.hint = String(describing: error)
                        }
                    } label: { Image(systemName: "xmark.circle") }
                        .buttonStyle(.borderless)
                        .help(concept.isBundle ? "Remove — un-combines the bundle; its members stay" : "Remove — nothing uses this concept")
                }
            }
            if concept.isBundle {
                // A bundle's members, nested (S01); un-combining dissolves
                // the bundle and leaves every member, and every arrow, as it
                // was — the entry itself stays as a plain concept while an
                // arrow drawn from its port denotes it. A bundle on a cycle
                // (a hand-edited file) is marked as the checks report it, so
                // Un-combine, the way out, is at hand — every concept is in
                // this flat list, as the web's glossary lists one on a cycle
                // at its top level too.
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(concept.members.enumerated()), id: \.offset) { _, mid in
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.turn.down.right").imageScale(.small).foregroundStyle(palette.text2)
                            Text(m.conceptById(mid)?.term ?? "(missing concept \(mid))")
                                .font(HUDType.small)
                                .foregroundStyle(m.conceptById(mid) == nil ? SCStatus.danger : palette.text)
                        }
                    }
                    if Self.onCycle(m, concept) {
                        Text("⚠ Bundle “\(concept.term)” contains itself through its members. Un-combine it to break the cycle.")
                            .font(HUDType.caption).foregroundStyle(SCStatus.warning)
                    }
                    Button("Un-combine") {
                        let id = concept.id
                        do {
                            try document.apply("Un-combine Concept", undoManager: undoManager) { try Edits.uncombineConcept(&$0, bundleId: id) }
                        } catch {
                            state.hint = String(describing: error)
                        }
                    }
                    .controlSize(.small)
                    .help(uses == 0 ? "Dissolve this bundle; its members and their arrows stay as they are"
                          : "Dissolve this bundle; its members and their arrows stay as they are, and it stays as the concept its own arrows denote")
                }
                .padding(.leading, 12)
            } else if let bundle = m.bundleOf(concept.id) {
                Text("in bundle “\(bundle.term)”").font(HUDType.caption).foregroundStyle(palette.text2)
            }
            Picker("Kind", selection: Binding(get: { concept.kind }, set: { v in
                let id = concept.id
                document.apply("Set Concept Kind", undoManager: undoManager) { Edits.setConceptKind(&$0, conceptId: id, kind: v) }
            })) {
                ForEach(ConceptKind.allCases, id: \.rawValue) { Text($0.rawValue.capitalized).tag($0.rawValue) }
                if concept.knownKind == nil { Text(concept.kind).tag(concept.kind) }
            }
            .labelsHidden()
            .controlSize(.small)
            CommitTextField(label: "Definition", value: concept.definition, prompt: "Definition", multiline: true) { v in
                let id = concept.id
                document.apply("Define Concept", undoManager: undoManager) { Edits.defineConcept(&$0, conceptId: id, definition: v) }
            }
            .font(HUDType.small)
            let occurrences = document.model.occurrencesOf(concept.id)
            if !occurrences.isEmpty {
                FlowChips(items: occurrences.map { o in
                    (label: "\(o.node) \(o.kind == .box ? "▭" : "→")", help: "\(o.text) on \(o.node)", action: {
                        state.open(o.diagramId, selecting: o.kind == .box ? .box(o.id) : .arrow(o.id))
                    })
                })
            }
        }
        .padding(.vertical, 4)
        // `.gl-item`: each concept on a card of the second panel colour.
        .listRowBackground(palette.panel2)
    }

    /// Whether a bundle contains itself through its members — the validator's
    /// bundle-cycle, by code-unit identity as `transitiveMemberIds` keeps it.
    static func onCycle(_ m: IDEF0Model, _ concept: Concept) -> Bool {
        concept.isBundle && m.transitiveMemberIds(concept.id).contains { $0.utf16.elementsEqual(concept.id.utf16) }
    }
}

/// Small buttons that wrap onto as many lines as they need.
struct FlowChips: View {
    let items: [(label: String, help: String, action: () -> Void)]

    var body: some View {
        FlowLayout(spacing: 4) {
            ForEach(items.indices, id: \.self) { i in
                // `.occ`: a mono chip.
                Button(items[i].label, action: items[i].action)
                    .font(HUDType.monoSmall)
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                    .help(items[i].help)
            }
        }
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, maxX: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { x = 0; y += lineHeight + spacing; lineHeight = 0 }
            x += size.width + spacing
            maxX = max(maxX, x)
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: min(maxX, width), height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, lineHeight: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX { x = bounds.minX; y += lineHeight + spacing; lineHeight = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}
