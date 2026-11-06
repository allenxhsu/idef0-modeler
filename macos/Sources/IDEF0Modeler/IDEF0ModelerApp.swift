// IDEF0 Modeler for macOS.

import IDEF0Core
import IDEF0Editing
import IDEF0Render
import SwiftUI
import UniformTypeIdentifiers

@main
struct IDEF0ModelerApp: App {
    // Shared with the web app's own picker: both read "ui-kit.race" (the
    // browser keeps it in localStorage; here it's the same key in
    // UserDefaults), so choosing a palette in one is just a personal
    // preference, not something the file format or either app depends on.
    @AppStorage("ui-kit.race") private var race: SCRace = .steel

    init() {
        // A document app with nothing to reopen shows the Open panel at launch
        // by default; a modeller should open on a blank sheet instead, like
        // the web app does. AppKit reads this default before the first
        // document is created, so it must be set here, not in a delegate.
        UserDefaults.standard.register(defaults: ["NSShowAppCentricOpenPanelInsteadOfUntitledFile": false])
    }

    var body: some Scene {
        DocumentGroup(newDocument: { IDEF0Document() }) { file in
            // The window themes itself from the same "ui-kit.race" default
            // (S03), so every open window follows a change in Settings.
            EditorWindow(document: file.document)
                .frame(minWidth: 900, minHeight: 600)
        }
        // Room for the node tree, a legible sheet and the inspector side by side.
        .defaultSize(width: 1440, height: 900)
        .commands { ModelerCommands() }

        Settings { AppearanceSettings(race: $race) }
    }
}

/// The Mac side of the toolkit's appearance picker (⌘,): the same palette
/// choice as the web app's `<sc-theme-picker>`, just as a native picker. It
/// colours the chrome and, on screen, the sheet (S03) — as the web app's
/// stylesheet does — and nothing else: every export and the CLI print the
/// sheet in FIPS white and black regardless.
struct AppearanceSettings: View {
    @Binding var race: SCRace

    var body: some View {
        let palette = race.palette
        VStack(alignment: .leading, spacing: 14) {
            Text("Appearance").font(SCFont.display(11, weight: .semibold)).tracking(1.5).textCase(.uppercase)
                .foregroundStyle(palette.text3)
            Picker("Palette", selection: $race) {
                ForEach(SCRace.allCases) { r in Text(r.label).tag(r) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            HStack(spacing: 10) {
                ForEach(Array([palette.bg, palette.panel, palette.sunken, palette.panel2, palette.accent, palette.accent2].enumerated()), id: \.offset) { _, c in
                    RoundedRectangle(cornerRadius: 2).fill(c).frame(width: 28, height: 22)
                        .overlay(RoundedRectangle(cornerRadius: 2).strokeBorder(palette.lineStrong))
                }
            }
            SheetSwatch(palette: palette)
            Text("Colours the app and, on screen, the diagram sheet — as the web app does. Exports always print the sheet in FIPS white and black.")
                .font(HUDType.small)
                .foregroundStyle(palette.text2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(20)
        .frame(width: 340)
        .background(palette.bg)
        .foregroundStyle(palette.text)
        .tint(palette.accent)
        .environment(\.palette, palette)
        .preferredColorScheme(.dark)
    }

    /// A glimpse of the sheet in this palette: sheet, box, ink, accent.
    struct SheetSwatch: View {
        let palette: SCPalette
        var body: some View {
            let theme = palette.sheetTheme
            ZStack {
                Rectangle().fill(color(theme.sheet))
                Rectangle().stroke(color(theme.ink), lineWidth: 1).padding(6)
                HStack(spacing: 10) {
                    Rectangle().fill(color(theme.box)).overlay(Rectangle().stroke(color(theme.ink), lineWidth: 1.2)).frame(width: 60, height: 30)
                    Rectangle().fill(color(theme.accent)).frame(width: 30, height: 1.5)
                    Text("I1").font(SCFont.mono(9, weight: .bold)).foregroundStyle(color(theme.icom))
                }
            }
            .frame(height: 56)
        }

        private func color(_ c: RGBA) -> Color { Color(red: c.r, green: c.g, blue: c.b, opacity: c.a) }
    }
}

struct ModelerCommands: Commands {
    @FocusedValue(\.editor) private var editor

    var body: some Commands {
        CommandGroup(after: .newItem) {
            NewDocumentButton(title: "New from Sample Model") { buildSampleModel() }
            ImportXMLButton()
        }

        CommandGroup(replacing: .importExport) {
            Menu("Export") {
                Group {
                    Button("Diagram as SVG…") { export { try Exporter.svg($0) } }
                    Button("Diagram as PNG…") { export { try Exporter.png($0) } }
                    Button("Diagram as PDF…") { export { try Exporter.pdf($0, allDiagrams: false) } }
                    Button("All Diagrams as PDF Kit…") { export { try Exporter.pdf($0, allDiagrams: true) } }
                }
                Divider()
                Button("IDEF0 XML Interchange…") { export { try Exporter.xml($0) } }
                Button("IDL Node Listing…") { export { try Exporter.idl($0) } }
                Divider()
                Button("Report as Markdown…") { export { try Exporter.report($0, html: false) } }
                Button("Report as HTML…") { export { try Exporter.report($0, html: true) } }
            }
            .disabled(editor == nil)
        }

        // Neither item has a ⌘ key equivalent: one would fire before the field
        // being typed in sees the key, and ⌘⌫ deletes to the start of the line
        // there. The canvas answers Delete, Backspace and Edit ▸ Delete itself
        // while it has focus, and both items stand down during an inline edit.
        CommandGroup(after: .pasteboard) {
            Divider()
            Button("Rename") { editor?.state.request(.renameSelection) }
                .keyboardShortcut(.return, modifiers: [.command])
                .disabled(editor?.state.selection == nil || editor?.state.editing != nil)
            Button("Delete Selection") { editor?.state.request(.deleteSelection) }
                .disabled(editor?.state.selection == nil || editor?.state.editing != nil)
        }

        CommandMenu("Diagram") {
            Group {
            Button("Select Tool (V)") { editor?.state.tool = .select }
            Button("Arrow Tool (A)") { editor?.state.tool = .arrow }
            Button("Add Box (B)") { editor?.state.request(.addBox) }
                .keyboardShortcut("b", modifiers: [.command, .shift])
                .disabled(addBoxDisabled)
            // S01: boxes sit on the staircase in reading order. None of these
            // has a key equivalent: a chord would fire before a field being
            // typed in sees the key.
            Button("Arrange") { editor?.state.request(.arrange) }
                .disabled(arrangeDisabled)
            Button("Move Earlier") { editor?.state.request(.moveSelection(by: -1)) }
                .disabled(!canMoveSelection(by: -1))
            Button("Move Later") { editor?.state.request(.moveSelection(by: 1)) }
                .disabled(!canMoveSelection(by: 1))
            Divider()
            // The chords in the titles are the canvas's own (see its keyDown),
            // so they move the caret, not the diagram, when a field has focus.
            Button("Go to Parent Diagram (⌘↑)") {
                if let e = editor { e.state.goToParent(in: e.document.model) }
            }
            Button("Open Child Diagram (⌘↓)") {
                if let e = editor { e.state.openChild(in: e.document.model) }
            }
            Button("Go to A-0 (⌘Home)") {
                if let e = editor { e.state.open(e.document.model.rootDiagramId) }
            }
            Divider()
            Button("Zoom In") { editor?.state.request(.zoom(by: 1.2)) }
                .keyboardShortcut("=", modifiers: [.command])
            Button("Zoom Out") { editor?.state.request(.zoom(by: 1 / 1.2)) }
                .keyboardShortcut("-", modifiers: [.command])
            Button("Fit Sheet in Window") { editor?.state.request(.fit) }
                .keyboardShortcut("0", modifiers: [.command])
            Button("Actual Size") { editor?.state.request(.actualSize) }
                .keyboardShortcut("9", modifiers: [.command])
            Divider()
            Button("Show Checks") {
                editor?.state.showsInspector = true
                editor?.state.inspectorTab = .checks
            }
            .keyboardShortcut("k", modifiers: [.command, .shift])
            }
            .disabled(editor == nil)
        }
    }

    private func export(_ make: @escaping (EditorContext) throws -> Void) {
        guard let editor else { return }
        do { try make(editor) } catch { editor.state.hint = String(describing: error) }
    }

    /// The A-0 context diagram holds exactly one box (FIPS 183 §3.4.2).
    private var addBoxDisabled: Bool {
        guard let editor else { return false }
        let diagramId = editor.state.diagramId
        guard diagramId == editor.document.model.rootDiagramId else { return false }
        return !(editor.document.model.diagrams[diagramId]?.boxes.isEmpty ?? true)
    }

    /// A-0 is never laid out: its single box stays where it is (S01).
    private var arrangeDisabled: Bool {
        guard let editor else { return false }
        return editor.document.model.isRootDiagram(editor.state.diagramId)
    }

    /// Whether the selected box has a neighbour to swap with that way (S01).
    private func canMoveSelection(by: Int) -> Bool {
        guard let editor, case .box(let id) = editor.state.selection, editor.state.editing == nil else { return false }
        return Edits.canMoveBox(editor.document.model, diagramId: editor.state.diagramId, boxId: id, by: by)
    }
}

/// A File menu item that opens a new window on a prepared model.
struct NewDocumentButton: View {
    let title: String
    let make: () -> IDEF0Model
    @Environment(\.newDocument) private var newDocument

    var body: some View {
        // A reference-type document is created by a closure, not passed by value.
        Button(title) { newDocument { IDEF0Document(model: make()) } }
    }
}

/// Opens an IDEF0 XML interchange file as a new, untitled model.
struct ImportXMLButton: View {
    @Environment(\.newDocument) private var newDocument

    var body: some View {
        Button("Import IDEF0 XML…") {
            let panel = NSOpenPanel()
            panel.allowedContentTypes = [.xml]
            panel.allowsMultipleSelection = false
            guard panel.runModal() == .OK, let url = panel.url else { return }
            do {
                // Decoded as the web app decodes a chosen file: a leading
                // byte-order mark dropped, malformed UTF-8 substituted, not refused.
                let text = ModelFile.decodeText(try Data(contentsOf: url))
                let model = try XMLInterchange.fromXml(text)
                newDocument { IDEF0Document(model: model) }
            } catch {
                let alert = NSAlert()
                alert.messageText = "The file could not be imported."
                alert.informativeText = String(describing: error)
                alert.runModal()
            }
        }
        .keyboardShortcut("i", modifiers: [.command, .shift])
    }
}
