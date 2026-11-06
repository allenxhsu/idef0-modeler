// One document's window: the toolbar across the top, node tree and panels on
// the left, the sheet in the middle, properties and checks on the right.
//
// Skinned as the web app is (S03): the window is the palette's background,
// the side panels its panel colour, the toolbar and status bar flat and dark,
// buttons and tabs in the display face. Every control and shortcut of the
// unskinned window is still here; only the look changed.

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
    // The palette picked in Settings — the web app's own "ui-kit.race" key —
    // read here so a change rethemes every open window as it happens.
    @AppStorage("ui-kit.race") private var race: SCRace = .steel

    init(document: IDEF0Document) {
        self.document = document
        _state = State(initialValue: EditorState(diagramId: document.model.rootDiagramId))
    }

    var body: some View {
        let palette = race.palette
        VStack(spacing: 0) {
            EditorBar(document: document, state: state)
            Hairline(strong: true)
            NavigationSplitView {
                SidebarView(document: document, state: state)
                    .navigationSplitViewColumnWidth(min: 220, ideal: 270, max: 420)
            } detail: {
                VStack(spacing: 0) {
                    SheetCanvas(document: document, state: state)
                    Hairline(strong: true)
                    StatusBar(document: document, state: state)
                }
                .inspector(isPresented: $state.showsInspector) {
                    InspectorView(document: document, state: state)
                        .inspectorColumnWidth(min: 270, ideal: 310, max: 460)
                }
            }
        }
        .background(palette.bg)
        .font(HUDType.body)
        .foregroundStyle(palette.text)
        .tint(palette.accent)
        .environment(\.palette, palette)
        // The web's adapter sets `color-scheme: dark`: every system control —
        // fields, pickers, menus, the title bar — renders dark to match.
        .preferredColorScheme(.dark)
        .toolbarBackground(palette.panel, for: .windowToolbar)
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

/// The web's `#toolbar`: the brand at the left in the display face, then the
/// controls as flat chamfered buttons, the armed tool lit in the accent.
/// The same controls the system toolbar carried, with the same shortcuts.
struct EditorBar: View {
    @ObservedObject var document: IDEF0Document
    let state: EditorState
    @Environment(\.undoManager) private var undoManager
    @Environment(\.palette) private var palette

    var body: some View {
        let model = document.model
        let isRoot = state.diagramId == model.rootDiagramId
        HStack(spacing: 6) {
            Brand()
            Separator()
            Button { state.goToParent(in: model) } label: { Label("Parent", systemImage: "arrow.up.square") }
                .help("Go to the parent diagram (Esc with nothing selected)")
                .disabled(Edits.parentTarget(of: model, diagramId: state.diagramId) == nil)
            Button { state.open(model.rootDiagramId) } label: { Label("A-0", systemImage: "house") }
                .help("Go to the A-0 context diagram")
                .disabled(isRoot)
            Separator()
            Button { state.tool = .select } label: { Label("Select", systemImage: "cursorarrow") }
                .buttonStyle(.hud(on: state.tool == .select))
                .help("Select tool (V)")
            Button { state.tool = .arrow } label: { Label("Arrow", systemImage: "arrow.right") }
                .buttonStyle(.hud(on: state.tool == .arrow))
                .help("Arrow tool (A)")
            Separator()
            Button { state.request(.addBox) } label: { Label("Add Box", systemImage: "plus.rectangle") }
                .help("Add an activity box (B)")
                .disabled(isRoot && !(model.diagrams[state.diagramId]?.boxes.isEmpty ?? true))
            // S01: boxes are never placed by hand; the staircase is re-laid
            // on request. A-0's one box is never laid out.
            Button { state.request(.arrange) } label: { Label("Arrange", systemImage: "rectangle.3.group") }
                .help("Lay the boxes out along the staircase in reading order")
                .disabled(isRoot)
            DecomposeMenu(document: document, state: state)
            Spacer(minLength: 8)
            Button { state.request(.zoom(by: 1 / 1.2)) } label: { Label("Zoom Out", systemImage: "minus.magnifyingglass").labelStyle(.iconOnly) }
                .help("Zoom out (⌘−)")
            Button { state.request(.fit) } label: { Label("Fit", systemImage: "arrow.up.left.and.down.right.magnifyingglass") }
                .help("Fit the sheet in the window (⌘0)")
            Button { state.request(.zoom(by: 1.2)) } label: { Label("Zoom In", systemImage: "plus.magnifyingglass").labelStyle(.iconOnly) }
                .help("Zoom in (⌘=)")
            Separator()
            Button { state.showsInspector.toggle() } label: { Label("Inspector", systemImage: "sidebar.trailing") }
                .buttonStyle(.hud(on: state.showsInspector))
                .help("Show or hide the inspector")
        }
        .buttonStyle(.hud)
        .labelStyle(.titleAndIcon)
        .imageScale(.small)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity)
        .background(palette.panel)
    }

    /// The web's `#toolbar .brand` under the adapter: the app's own colour,
    /// display face, wide-tracked caps.
    struct Brand: View {
        @Environment(\.palette) private var palette
        var body: some View {
            (Text("IDEF0 ").font(HUDType.brand) + Text("Modeler").font(SCFont.display(12, weight: .regular)))
                .tracking(2)
                .textCase(.uppercase)
                .foregroundStyle(SCAppColor.idef0)
                .lineLimit(1)
                .fixedSize()
                .padding(.trailing, 4)
        }
    }

    /// `.tb-sep`: a vertical hairline between groups.
    struct Separator: View {
        @Environment(\.palette) private var palette
        var body: some View { Rectangle().fill(palette.lineStrong).frame(width: 1, height: 18) }
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
            Button { state.open(child) } label: { Label("Open Child", systemImage: "arrow.down.square") }
                .help("Open the diagram that details this box")
        } else {
            Menu {
                ForEach(Sheet.decompMin...Sheet.decompMax, id: \.self) { n in
                    Button("\(n) child activities") { decompose(box, into: n) }
                }
            } label: {
                Label("Decompose", systemImage: "square.split.2x2")
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
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

/// The web's `#statusbar`: the panel colour, secondary text, node numbers
/// and counts in the mono face, the current entry in the text colour.
struct StatusBar: View {
    @ObservedObject var document: IDEF0Document
    let state: EditorState
    @Environment(\.palette) private var palette

    var body: some View {
        let model = document.model
        let d = model.diagrams[state.diagramId]
        HStack(spacing: 16) {
            if let d {
                Text(d.node).font(HUDType.mono).foregroundStyle(palette.text)
                    + Text(" \(d.title)").font(HUDType.small)
                Text("\(plural(d.boxes.count, "box", "boxes")) · \(plural(d.arrows.count, "arrow", "arrows"))")
                    .font(HUDType.monoSmall)
                Text(selectionText(model, d))
                // S01: each port is a parent concept this diagram has not
                // connected yet — the `icom-missing` error, with a handle.
                let ports = model.ports(d).count
                if ports > 0 {
                    Text("\(plural(ports, "parent concept", "parent concepts")) unconnected")
                        .foregroundStyle(SCStatus.warning)
                }
            }
            Spacer(minLength: 8)
            Text(state.hint.isEmpty ? defaultHint : state.hint)
                .lineLimit(1)
                .truncationMode(.tail)
            Text("\(Int((state.zoom * 100).rounded()))%").font(HUDType.monoSmall)
        }
        .font(HUDType.small)
        .foregroundStyle(palette.text2)
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .background(palette.panel)
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
