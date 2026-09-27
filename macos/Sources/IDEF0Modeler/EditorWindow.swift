// One document's window: node tree and panels on the left, the sheet in the
// middle, properties and checks on the right.

import IDEF0Core
import IDEF0Editing
import SwiftUI

/// What the menu bar needs to act on the frontmost editor window.
struct EditorContext {
    let document: IDEF0Document
    let state: EditorState
    let undoManager: UndoManager?
}

struct EditorContextKey: FocusedValueKey {
    typealias Value = EditorContext
}

extension FocusedValues {
    var editor: EditorContext? {
        get { self[EditorContextKey.self] }
        set { self[EditorContextKey.self] = newValue }
    }
}

struct EditorWindow: View {
    @ObservedObject var document: IDEF0Document
    @State private var state: EditorState
    @Environment(\.undoManager) private var undoManager

    init(document: IDEF0Document) {
        self.document = document
        _state = State(initialValue: EditorState(diagramId: document.model.rootDiagramId))
    }

    var body: some View {
        NavigationSplitView {
            SidebarView(document: document, state: state)
                .navigationSplitViewColumnWidth(min: 220, ideal: 270, max: 420)
        } detail: {
            VStack(spacing: 0) {
                SheetCanvas(document: document, state: state)
                Divider()
                StatusBar(document: document, state: state)
            }
            .inspector(isPresented: $state.showsInspector) {
                InspectorView(document: document, state: state)
                    .inspectorColumnWidth(min: 270, ideal: 310, max: 460)
            }
        }
        .toolbar { EditorToolbar(document: document, state: state) }
        .navigationTitle(document.model.diagrams[state.diagramId].map { "\($0.node) — \(document.model.title)" } ?? document.model.title)
        .focusedSceneValue(\.editor, EditorContext(document: document, state: state, undoManager: undoManager))
        .onChange(of: document.model) { _, model in state.reconcile(with: model) }
        // The first appearance of a window is the first point this document
        // can be handed an undoManager — what turns the concepts bound on
        // load into one saved, undoable edit (F13).
        .onAppear { document.assignConceptsIfNeeded(undoManager: undoManager) }
    }
}

// MARK: - Toolbar

struct EditorToolbar: ToolbarContent {
    @ObservedObject var document: IDEF0Document
    let state: EditorState
    @Environment(\.undoManager) private var undoManager

    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .navigation) {
            Button { state.goToParent(in: document.model) } label: { Label("Parent Diagram", systemImage: "arrow.up.square") }
                .help("Go to the parent diagram (Esc with nothing selected)")
                .disabled(Edits.parentTarget(of: document.model, diagramId: state.diagramId) == nil)
            Button { state.open(document.model.rootDiagramId) } label: { Label("A-0", systemImage: "house") }
                .help("Go to the A-0 context diagram")
                .disabled(state.diagramId == document.model.rootDiagramId)
        }
        ToolbarItemGroup(placement: .principal) {
            Picker("Tool", selection: Binding(get: { state.tool }, set: { state.tool = $0 })) {
                Label("Select", systemImage: "cursorarrow").tag(Tool.select)
                Label("Arrow", systemImage: "arrow.right").tag(Tool.arrow)
            }
            .pickerStyle(.segmented)
            .help("Select (V) or draw arrows (A)")
            Button { state.request(.addBox) } label: { Label("Add Box", systemImage: "plus.rectangle") }
                .help("Add an activity box (B)")
                .disabled(state.diagramId == document.model.rootDiagramId && !(document.model.diagrams[state.diagramId]?.boxes.isEmpty ?? true))
            // S01: boxes are never placed by hand; the staircase is re-laid
            // on request. A-0's one box is never laid out.
            Button { state.request(.arrange) } label: { Label("Arrange", systemImage: "rectangle.3.group") }
                .help("Lay the boxes out along the staircase in reading order")
                .disabled(state.diagramId == document.model.rootDiagramId)
            DecomposeMenu(document: document, state: state)
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Button { state.request(.zoom(by: 1 / 1.2)) } label: { Label("Zoom Out", systemImage: "minus.magnifyingglass") }
                .help("Zoom out (⌘−)")
            Button { state.request(.fit) } label: { Label("Fit", systemImage: "arrow.up.left.and.down.right.magnifyingglass") }
                .help("Fit the sheet in the window (⌘0)")
            Button { state.request(.zoom(by: 1.2)) } label: { Label("Zoom In", systemImage: "plus.magnifyingglass") }
                .help("Zoom in (⌘=)")
            Button { state.showsInspector.toggle() } label: { Label("Inspector", systemImage: "sidebar.trailing") }
                .help("Show or hide the inspector")
        }
    }
}

/// Decompose the selected box into 3–6 activities, or open its existing child.
struct DecomposeMenu: View {
    @ObservedObject var document: IDEF0Document
    let state: EditorState
    @Environment(\.undoManager) private var undoManager

    var body: some View {
        let box: Box? = {
            guard case .box(let id) = state.selection else { return nil }
            return document.model.diagrams[state.diagramId]?.findBox(id)
        }()
        if let box, let child = box.childDiagramId, document.model.diagrams[child] != nil {
            Button { state.open(child) } label: { Label("Open Child Diagram", systemImage: "arrow.down.square") }
                .help("Open the diagram that details this box")
        } else {
            Menu {
                ForEach(Sheet.decompMin...Sheet.decompMax, id: \.self) { n in
                    Button("\(n) child activities") { decompose(box, into: n) }
                }
            } label: {
                Label("Decompose", systemImage: "square.split.2x2")
            }
            .help("Detail the selected box in a child diagram, which starts with a port for each of its arrows")
            .disabled(box == nil)
        }
    }

    private func decompose(_ box: Box?, into n: Int) {
        guard let box else { return }
        // A name still being typed is committed first, so the child diagram
        // is titled from it rather than from the name it replaces.
        state.commitPendingEdit?()
        let did = state.diagramId
        var child: String?
        do {
            try document.apply("Decompose Box", undoManager: undoManager) { m in
                child = try Edits.decompose(&m, diagramId: did, boxId: box.id, count: n)
            }
        } catch {
            state.hint = String(describing: error)
        }
        if let child { state.open(child) }
    }
}

// MARK: - Status bar

struct StatusBar: View {
    @ObservedObject var document: IDEF0Document
    let state: EditorState

    var body: some View {
        let model = document.model
        let d = model.diagrams[state.diagramId]
        HStack(spacing: 16) {
            if let d {
                Text(d.node).font(.system(.callout, design: .monospaced).weight(.semibold))
                    + Text(" \(d.title)").font(.callout)
                Text("\(plural(d.boxes.count, "box", "boxes")) · \(plural(d.arrows.count, "arrow", "arrows"))")
                Text(selectionText(model, d))
                // S01: each port is a parent concept this diagram has not
                // connected yet — the `icom-missing` error, with a handle.
                let ports = model.ports(d).count
                if ports > 0 {
                    Text("\(plural(ports, "parent concept", "parent concepts")) unconnected")
                        .foregroundStyle(.orange)
                }
            }
            Spacer(minLength: 8)
            Text(state.hint.isEmpty ? defaultHint : state.hint)
                .lineLimit(1)
                .truncationMode(.tail)
            Text("\(Int((state.zoom * 100).rounded()))%").monospacedDigit()
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .background(.bar)
    }

    private var defaultHint: String {
        state.tool == .arrow
            ? "Arrow tool: click a source, then a destination."
            : "Drag to pan · ⌘-scroll or pinch to zoom · double-click to rename · drag a port onto a box side to connect it"
    }

    private func selectionText(_ model: IDEF0Model, _ d: Diagram) -> String {
        switch state.selection {
        case .box(let id):
            guard let b = d.findBox(id) else { return "nothing selected" }
            return "box \(b.number) — \(boxNode(d, b))\(b.name.isEmpty ? "" : " — \(b.name)")"
        case .arrow(let id):
            guard let a = d.findArrow(id) else { return "nothing selected" }
            return "\(a.role.label.lowercased()) — \(a.label.isEmpty ? "unlabelled" : a.label)"
        case nil:
            return "nothing selected"
        }
    }

    private func plural(_ n: Int, _ one: String, _ many: String) -> String { "\(n) \(n == 1 ? one : many)" }
}
