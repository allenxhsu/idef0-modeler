// The editing canvas: an AppKit view that draws one IDEF0 sheet and turns
// mouse and keyboard input into edits.
//
// Drawing goes through SheetRenderer — the same code that writes PNG and PDF —
// so what the canvas shows is exactly what exports. Every decision about what
// a click or drag means is delegated to IDEF0Editing, which ports the web
// app's canvas rules; this file only maps events and draws handles.
//
// Boxes are placed by the staircase, never by hand (S01): a press on a box
// selects it, and only an arrow's ends, bend and label are dragged. A port —
// a parent concept not yet connected on this diagram, drawn at the sheet edge
// — is dragged onto a box side to draw the arrow it stands for.

import AppKit
import IDEF0Core
import IDEF0Editing
import IDEF0Render
import SwiftUI

final class SheetCanvasView: NSView, NSTextFieldDelegate, NSUserInterfaceValidations {
    var document: IDEF0Document!
    var state: EditorState! {
        didSet {
            guard state !== oldValue else { return }
            // A view arriving on a live state must not replay the request it
            // last carried out; a new view fits itself anyway.
            lastCanvasRequestSerial = state?.canvasRequest?.serial ?? 0
            // Navigation commits an edit in progress through this, so the
            // field never outlives the diagram it was opened on.
            state?.commitPendingEdit = { [weak self] in self?.commitTextEdit() }
        }
    }

    /// The palette the canvas is drawn in (S03) — the user's choice in
    /// Settings, handed down by `SheetCanvas`. The sheet is remapped into it
    /// on screen only (`SheetTheme`); exports never see it.
    var race: SCRace = .steel {
        didSet {
            guard race != oldValue else { return }
            colors = CanvasColors(race.palette)
            styleTextField()
            needsDisplay = true
        }
    }
    private(set) var colors = CanvasColors(SCRace.steel.palette)

    // The view transform: screen = sheet × scale + translation.
    private(set) var scale: CGFloat = 1
    private var translation = CGPoint.zero
    private var autoFit = true

    /// What a press began. Boxes are not dragged (S01): their place is the
    /// staircase's, so a press on one only selects it. A port drag changes
    /// no geometry as it goes — it only draws a ghost line — and writes its
    /// arrow once, on release; `diagramId` and `baseline` are the diagram
    /// and the document's model at the press, so a navigation, an undo or a
    /// revert that lands while the button is down is not written over, as
    /// `DragDraft` guards the other drags.
    private enum Drag {
        case pan(start: CGPoint, origin: CGPoint)
        case connect(port: ICOMPort, diagramId: String, baseline: IDEF0Model)
        /// `members` (S02): every arrow of the fork or join group the end
        /// belongs to, as stored at the press — moved along the face
        /// together, and put back when the dragged end leaves the face.
        case endpoint(arrowId: String, end: ArrowEnd, members: [EndMember])
        case bend(arrowId: String, axis: BendAxis)
        case label(arrowId: String, original: Point, start: Point)

        var actionName: String {
            switch self {
            case .pan: return ""
            case .connect: return "Connect Port"
            case .endpoint: return "Move Arrow End"
            case .bend: return "Bend Arrow"
            case .label: return "Move Arrow Label"
            }
        }
    }

    private var drag: Drag?
    private var dragMoved = false

    /// The geometry of a drag in progress. The document is not touched until
    /// the mouse comes up — as the web app's light updates redraw only the
    /// canvas — so the sidebar and inspector are not re-evaluated on every
    /// mouse move. Meanwhile the draft is what the canvas draws and
    /// hit-tests; at the end it is applied as one edit, or dropped should
    /// the document have changed underneath it.
    private struct DragDraft {
        /// The document's model when the drag began: the drag is applied
        /// only while the document still holds it, so an undo or a revert
        /// that arrives mid-drag is not written over.
        let baseline: IDEF0Model
        var model: IDEF0Model
        /// The diagram the drag began on, whatever the window shows by the end.
        let diagramId: String

        init(_ model: IDEF0Model, diagramId: String) {
            baseline = model
            self.model = model
            self.diagramId = diagramId
        }
    }

    private var dragDraft: DragDraft?
    /// The model a drag in progress has reached, readable so tests can watch a drag.
    var draftModel: IDEF0Model? { dragDraft?.model }

    private var hoverAnchor: Endpoint?
    private var cursorPoint: Point?
    /// Space is held: the next press-and-drag pans. Cleared when the key
    /// comes up here, and whenever the key-up could go elsewhere.
    private(set) var spaceDown = false
    /// The floating field of an inline edit in progress; readable so tests can type into it.
    private(set) var textField: NSTextField?
    /// What the field edits and the diagram it was opened on, captured at the
    /// start so the commit goes there whatever the window shows by then.
    /// `bundleId` is set when the field opened on an arrow whose drawn label
    /// is its bundle's term (S01): the commit then renames that bundle.
    private var activeEdit: (target: TextEditTarget, diagramId: String, bundleId: String?)?
    private var lastCanvasRequestSerial = 0

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// What is drawn and hit-tested: the drag draft while one is in progress.
    private var model: IDEF0Model { dragDraft?.model ?? document.model }
    private var diagram: Diagram? { model.diagrams[state.diagramId] }

    // MARK: - Transform

    private func sheetPoint(_ event: NSEvent) -> Point {
        let p = convert(event.locationInWindow, from: nil)
        return sheetPoint(p)
    }

    /// A sheet point in this view's coordinates — the inverse of `sheetPoint`.
    func viewPoint(_ p: Point) -> CGPoint {
        CGPoint(x: translation.x + CGFloat(p.x) * scale, y: translation.y + CGFloat(p.y) * scale)
    }

    private func sheetPoint(_ p: CGPoint) -> Point {
        Point(x: Double((p.x - translation.x) / scale), y: Double((p.y - translation.y) / scale))
    }

    private func screenRect(_ r: SheetRect) -> CGRect {
        CGRect(x: translation.x + CGFloat(r.x) * scale, y: translation.y + CGFloat(r.y) * scale,
               width: CGFloat(r.w) * scale, height: CGFloat(r.h) * scale)
    }

    /// Frame the whole sheet in the view.
    func fitToWindow() {
        autoFit = true
        guard bounds.width > 60, bounds.height > 60 else { return }
        let pad: CGFloat = 24
        let s = min((bounds.width - pad * 2) / CGFloat(Sheet.size.w), (bounds.height - pad * 2) / CGFloat(Sheet.size.h))
        scale = min(max(s, 0.1), 5)
        translation = CGPoint(x: (bounds.width - CGFloat(Sheet.size.w) * scale) / 2,
                              y: (bounds.height - CGFloat(Sheet.size.h) * scale) / 2)
        publishZoom()
    }

    /// Zoom about a point in view coordinates, keeping that point still.
    func zoom(by factor: CGFloat, around center: CGPoint? = nil) {
        autoFit = false
        let c = center ?? CGPoint(x: bounds.midX, y: bounds.midY)
        let next = min(max(scale * factor, 0.15), 5)
        let f = next / scale
        translation = CGPoint(x: c.x - (c.x - translation.x) * f, y: c.y - (c.y - translation.y) * f)
        scale = next
        publishZoom()
    }

    private func publishZoom() {
        repositionTextField()
        needsDisplay = true
        // Deferred out of the current layout pass — SwiftUI must not see state
        // change while it is laying out — as a main-actor job, which runs as soon
        // as the pass returns and can be awaited in tests.
        let z = Double(scale)
        Task { @MainActor [weak self] in self?.state?.zoom = z }
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        if autoFit { fitToWindow() }
    }

    /// Pan — never zoom — until the selection is wholly in view, with a
    /// margin; nothing when it already is. What a selection made from the node
    /// tree, a concept chip or a check needs when the sheet is zoomed in on
    /// some other part.
    func revealSelection() {
        guard let d = diagram, let target = selectionRect(d) else { return }
        let pad: CGFloat = 24
        let area = bounds.insetBy(dx: pad, dy: pad)
        guard area.width > 0, area.height > 0 else { return }
        let r = screenRect(target)
        // The least pan that brings a span inside the area; a span too wide
        // for it is centred.
        func shift(_ lo: CGFloat, _ hi: CGFloat, into areaLo: CGFloat, _ areaHi: CGFloat) -> CGFloat {
            if hi - lo > areaHi - areaLo { return (areaLo + areaHi) / 2 - (lo + hi) / 2 }
            if lo < areaLo { return areaLo - lo }
            if hi > areaHi { return areaHi - hi }
            return 0
        }
        let dx = shift(r.minX, r.maxX, into: area.minX, area.maxX)
        let dy = shift(r.minY, r.maxY, into: area.minY, area.maxY)
        guard dx != 0 || dy != 0 else { return }
        autoFit = false
        translation = CGPoint(x: translation.x + dx, y: translation.y + dy)
        repositionTextField()
        needsDisplay = true
    }

    /// The sheet rectangle the selection occupies: a box's, or the bounds of
    /// an arrow's route.
    private func selectionRect(_ d: Diagram) -> SheetRect? {
        switch state.selection {
        case .box(let id):
            return d.findBox(id)?.rect
        case .arrow(let id):
            guard let i = d.arrowIndex(id) else { return nil }
            let pts = HitTest.route(model, in: d, d.arrows[i])
            guard let first = pts.first else { return nil }
            var x0 = first.x, y0 = first.y, x1 = first.x, y1 = first.y
            for p in pts {
                x0 = min(x0, p.x); y0 = min(y0, p.y)
                x1 = max(x1, p.x); y1 = max(y1, p.y)
            }
            return SheetRect(x: x0, y: y0, w: x1 - x0, h: y1 - y0)
        case nil:
            return nil
        }
    }

    /// Take up a request from a menu or toolbar. The serial is recorded at
    /// once, so the update pass that delivers it cannot deliver it twice; the
    /// work runs after that pass, as a main-actor job, because SwiftUI forbids
    /// publishing changes — the model, the selection — from inside one.
    func handle(_ request: (request: CanvasRequest, serial: Int)?) {
        guard let request, request.serial != lastCanvasRequestSerial else { return }
        lastCanvasRequestSerial = request.serial
        let r = request.request
        Task { @MainActor [weak self] in self?.carryOut(r) }
    }

    private func carryOut(_ request: CanvasRequest) {
        switch request {
        case .fit: fitToWindow()
        case .reveal: revealSelection()
        case .zoom(let factor): zoom(by: CGFloat(factor))
        case .actualSize: zoom(by: 1 / scale)
        case .addBox: addBox()
        case .deleteSelection: deleteSelection()
        case .renameSelection:
            switch state.selection {
            case .box(let id): beginTextEdit(.boxName(id))
            case .arrow(let id): beginTextEdit(.arrowLabel(id))
            case nil: break
            }
        case .arrange: arrange()
        case .moveSelection(let by): moveSelection(by: by)
        case .escape: escape()
        }
    }

    // MARK: - Drawing

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext, document != nil, let state else { return }
        // The desk around the sheet: the palette's background, as the web's
        // `#canvas-wrap` is under the kit.
        ctx.setFillColor(colors.desk.cgColor)
        ctx.fill(bounds)
        guard model.diagrams[state.diagramId] != nil else { return }

        ctx.saveGState()
        ctx.translateBy(x: translation.x, y: translation.y)
        ctx.scaleBy(x: scale, y: scale)

        // The sheet, lifted off the desk.
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: 3), blur: 14, color: NSColor.black.withAlphaComponent(0.6).cgColor)
        ctx.setFillColor(colors.sheet.cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: Sheet.size.w, height: Sheet.size.h))
        ctx.restoreGState()

        var options = DrawingOptions()
        switch state.selection {
        case .box(let id): options.selectedBoxId = id
        case .arrow(let id): options.selectedArrowId = id
        case nil: break
        }
        // The same display list every export draws, in the palette's colours
        // (S03): the core's ops are untouched, only their paint is remapped.
        SheetRenderer.draw(SheetDrawing.build(model, diagramId: state.diagramId, options: options), in: ctx, theme: colors.sheetTheme)
        drawOverlay(ctx)
        ctx.restoreGState()
    }

    private func drawOverlay(_ ctx: CGContext) {
        guard let d = diagram else { return }
        let k = 1 / scale
        // The palette's accent, as the web's `.anchor`, `.handle`, `.ghost`,
        // `.bendh` and `.dropzone` take `--accent`; a handle's fill is the
        // sheet's own colour.
        let accentColor = colors.accent
        let accent = accentColor.cgColor
        let handleFill = colors.sheet.cgColor

        if state.tool == .arrow {
            let w = Sheet.work
            ctx.setFillColor(accentColor.withAlphaComponent(0.08).cgColor)
            ctx.fill(CGRect(x: w.x, y: w.y, width: w.w, height: w.h))
            ctx.setStrokeColor(accentColor.withAlphaComponent(0.5).cgColor)
            ctx.setLineWidth(1.2 * k)
            ctx.setLineDash(phase: 0, lengths: [6 * k, 4 * k])
            ctx.stroke(CGRect(x: w.x, y: w.y, width: w.w, height: w.h))
            ctx.setLineDash(phase: 0, lengths: [])
        }

        func handle(_ rect: CGRect, round: Bool) {
            ctx.setFillColor(handleFill)
            ctx.setStrokeColor(accent)
            ctx.setLineWidth(1.4 * k)
            if round { ctx.fillEllipse(in: rect); ctx.strokeEllipse(in: rect) } else { ctx.fill(rect); ctx.stroke(rect) }
        }

        switch state.selection {
        case .box:
            // A selected box draws in the accent colour and nothing more: it
            // has no handles, since it is neither moved nor resized (S01).
            break
        case .arrow(let id):
            if let a = d.findArrow(id) {
                let pts = HitTest.route(model, in: d, a)
                if let first = pts.first, let last = pts.last {
                    for p in [first, last] {
                        handle(CGRect(x: CGFloat(p.x) - 4.5 * k, y: CGFloat(p.y) - 4.5 * k, width: 9 * k, height: 9 * k), round: true)
                    }
                }
                if let bend = HitTest.bendHandle(model, in: d, a) {
                    ctx.saveGState()
                    ctx.translateBy(x: CGFloat(bend.point.x), y: CGFloat(bend.point.y))
                    ctx.rotate(by: .pi / 4)
                    ctx.setFillColor(accentColor.withAlphaComponent(0.85).cgColor)
                    ctx.fill(CGRect(x: -4 * k, y: -4 * k, width: 8 * k, height: 8 * k))
                    ctx.restoreGState()
                }
            }
        case nil:
            break
        }

        let connecting: ICOMPort? = { if case .connect(let port, _, _) = drag { return port }; return nil }()

        if let hover = hoverAnchor, state.tool == .arrow || state.pendingFrom != nil || connecting != nil {
            let p = anchorOf(d, hover)
            ctx.setFillColor(accent)
            ctx.fillEllipse(in: CGRect(x: CGFloat(p.x) - 5 * k, y: CGFloat(p.y) - 5 * k, width: 10 * k, height: 10 * k))
        }

        // A port being dragged (S01): a ghost line from the port's open
        // circle to the pointer, or to the box side it would connect to.
        if let port = connecting {
            let inner = portShape(port).inner
            let end: Point? = hoverAnchor.map { let a = anchorOf(d, $0); return Point(x: a.x, y: a.y) } ?? cursorPoint
            if let end {
                ctx.move(to: CGPoint(x: inner.x, y: inner.y))
                ctx.addLine(to: CGPoint(x: end.x, y: end.y))
                ctx.setStrokeColor(accent)
                ctx.setLineWidth(1.6 * k)
                ctx.setLineDash(phase: 0, lengths: [5 * k, 4 * k])
                ctx.strokePath()
                ctx.setLineDash(phase: 0, lengths: [])
            }
        }

        if let from = state.pendingFrom {
            let a = anchorOf(d, from)
            let pts: [Point]
            if let hover = hoverAnchor {
                pts = routeArrow(d, Arrow(id: "", label: "", from: from, to: hover))
            } else if let c = cursorPoint {
                pts = [Point(x: a.x, y: a.y), Point(x: a.x + a.nx * 20, y: a.y + a.ny * 20), c]
            } else {
                pts = []
            }
            if pts.count > 1 {
                ctx.addPath(SheetRenderer.cgPath(roundedPathCommands(pts)))
                ctx.setStrokeColor(accent)
                ctx.setLineWidth(1.6 * k)
                ctx.setLineDash(phase: 0, lengths: [5 * k, 4 * k])
                ctx.strokePath()
                ctx.setLineDash(phase: 0, lengths: [])
            }
        }
    }

    // MARK: - Mouse

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .cursorUpdate, .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        commitTextEdit()
        // A drag whose mouse-up never arrived is abandoned, not applied later.
        dragDraft = nil
        dragMoved = false
        guard let d = diagram else { return }
        let pt = sheetPoint(event)

        if spaceDown {
            drag = .pan(start: convert(event.locationInWindow, from: nil), origin: translation)
            return
        }

        if event.clickCount >= 2 {
            if let box = HitTest.box(in: d, at: pt) {
                // Option-double-click opens a decomposed box's child diagram.
                if event.modifierFlags.contains(.option), let child = box.childDiagramId, model.diagrams[child] != nil {
                    state.open(child)
                } else {
                    beginTextEdit(.boxName(box.id))
                }
            } else if let labelHit = HitTest.label(model, in: d, at: pt) {
                // F39: a moved or vertical-run label may sit well clear of
                // HitTest.arrow's reach.
                beginTextEdit(.arrowLabel(labelHit.id))
            } else if let arrow = HitTest.arrow(model, in: d, at: pt) {
                // A hidden bundle member's route opens its representative (S01).
                beginTextEdit(.arrowLabel(arrow.id))
            }
            return
        }

        // A port (S01) — a parent concept still unconnected, at the sheet
        // edge — starts a connection drag in either tool: the arrow it
        // stands for is drawn when the button comes up on a box side. It
        // sits where the arrow tool would otherwise find a boundary anchor,
        // so it is tried first, and a half-drawn arrow gives way to it.
        if let port = HitTest.port(in: model.ports(d), at: pt) {
            state.pendingFrom = nil
            drag = .connect(port: port, diagramId: d.id, baseline: document.model)
            cursorPoint = pt
            hoverAnchor = nil
            state.hint = "Drop \(port.code) “\(Self.portName(port))” on a box side to connect it."
            needsDisplay = true
            return
        }

        if state.tool == .arrow {
            guard let anchor = HitTest.anchor(in: d, at: pt) else { state.pendingFrom = nil; return }
            guard let from = state.pendingFrom else {
                state.pendingFrom = anchor
                state.hint = "Click the arrow’s destination — a box side, or the sheet edge for a boundary arrow."
                return
            }
            var created: String?
            perform("Draw Arrow") { m in created = try Edits.drawArrow(&m, diagramId: d.id, from: from, to: anchor) }
            state.pendingFrom = nil
            if let created {
                state.selection = .arrow(created)
                state.hint = "Arrow added. Give it a noun-phrase label."
                beginTextEdit(.arrowLabel(created))
            }
            return
        }

        // A selected arrow's handles sit on top of everything else. A
        // selected box has none (S01): it is neither moved nor resized.
        if case .arrow(let id) = state.selection, let a = d.findArrow(id) {
            if let end = HitTest.endHandle(model, of: a, in: d, at: pt, zoom: Double(scale)) {
                // A grouped end (S02) drags its whole fork or join along the face.
                drag = .endpoint(arrowId: id, end: end, members: HitTest.endGroup(model, in: d, arrowId: id, end: end))
                return
            }
            if let axis = HitTest.isOnBendHandle(model, of: a, in: d, at: pt, zoom: Double(scale)) {
                drag = .bend(arrowId: id, axis: axis)
                return
            }
        }

        // A press on a box selects it, and that is all: where it sits is the
        // staircase's to decide (S01), so there is no drag to begin.
        if let box = HitTest.box(in: d, at: pt) {
            state.selection = .box(box.id)
            drag = nil
            return
        }
        // Labels are tested before HitTest.arrow (F39): a moved or
        // vertical-run label can sit well clear of the 9-unit route reach
        // that used to gate its drag. The drag starts from where the drawn
        // text (S01: a bundle's term, perhaps) was auto-placed, so it does
        // not jump on the first move.
        if let labelHit = HitTest.label(model, in: d, at: pt) {
            state.selection = .arrow(labelHit.id)
            drag = .label(arrowId: labelHit.id, original: DragRules.labelDragOrigin(model, d, Self.asDrawn(model, d, labelHit)), start: pt)
            return
        }
        // A press on a hidden bundle member's route selects its representative (S01).
        if let arrow = HitTest.arrow(model, in: d, at: pt) {
            state.selection = .arrow(arrow.id)
            drag = HitTest.isOnLabel(model, in: d, Self.asDrawn(model, d, arrow), at: pt)
                ? .label(arrowId: arrow.id, original: Point(x: arrow.ldx, y: arrow.ldy), start: pt)
                : nil
            return
        }
        state.selection = nil
        drag = .pan(start: convert(event.locationInWindow, from: nil), origin: translation)
    }

    override func otherMouseDown(with event: NSEvent) {
        // The middle button always pans.
        dragDraft = nil
        dragMoved = false
        drag = .pan(start: convert(event.locationInWindow, from: nil), origin: translation)
    }

    override func otherMouseDragged(with event: NSEvent) { mouseDragged(with: event) }
    override func otherMouseUp(with event: NSEvent) { mouseUp(with: event) }

    override func mouseDragged(with event: NSEvent) {
        guard let drag, diagram != nil else { return }
        let pt = sheetPoint(event)
        if case .pan(let start, let origin) = drag {
            autoFit = false
            let p = convert(event.locationInWindow, from: nil)
            translation = CGPoint(x: origin.x + p.x - start.x, y: origin.y + p.y - start.y)
            repositionTextField()
            needsDisplay = true
            return
        }
        // A port drag edits nothing as it goes: the ghost line follows the
        // pointer, snapping to the box side it would connect to.
        if case .connect = drag, let d = diagram {
            dragMoved = true
            cursorPoint = pt
            hoverAnchor = HitTest.anchor(in: d, at: pt, boxesOnly: true)
            needsDisplay = true
            return
        }
        // The first move takes the draft from the document; every move after
        // edits the draft alone, and only the canvas redraws.
        var draft = dragDraft ?? DragDraft(document.model, diagramId: state.diagramId)
        dragDraft = nil
        dragMoved = true
        let did = draft.diagramId
        switch drag {
        case .pan, .connect: break
        case .endpoint(let arrowId, let end, let members):
            // Anchors are found on the diagram as the drag has left it so far.
            if let d = draft.model.diagrams[did], let anchor = HitTest.anchor(in: d, at: pt) {
                Edits.moveEndpoint(&draft.model, diagramId: did, arrowId: arrowId, end: end, to: anchor, members: members)
            }
        case .bend(let arrowId, let axis):
            Edits.setBend(&draft.model, diagramId: did, arrowId: arrowId, axis: axis, pointer: pt)
        case .label(let arrowId, let original, let start):
            Edits.moveLabel(&draft.model, diagramId: did, arrowId: arrowId, original: original, dragStart: start, pointer: pt)
        }
        dragDraft = draft
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        defer { refreshCursor() }
        guard let finished = drag else { return }
        drag = nil
        let draft = dragDraft
        dragDraft = nil
        if case .connect(let port, let diagramId, let baseline) = finished {
            finishConnect(port, diagramId: diagramId, baseline: baseline, at: sheetPoint(event))
            return
        }
        guard dragMoved, let draft else { return }
        if case .pan = finished { return }
        needsDisplay = true
        // An undo, a revert or a key's edit that arrived while the button was
        // down has changed what the draft was made from: the drag is dropped
        // rather than written over it.
        guard document.model == draft.baseline else { return }
        let result = draft.model
        // One edit, so the whole drag is one undo step, and a drag that
        // changed nothing records none.
        document.apply(finished.actionName, undoManager: undoManager) { m in m = result }
    }

    /// The end of a port drag (S01): released on any box side, the port's
    /// arrow is drawn there — one edit, "Connect Port", as on the web; the
    /// checks say whether the role fits the side — and selected, with no
    /// label editor to follow (the arrow already carries the parent's
    /// label); released anywhere else, nothing changes and the status bar
    /// says how to connect it. The port is never selected: it is not an object.
    private func finishConnect(_ port: ICOMPort, diagramId did: String, baseline: IDEF0Model, at pt: Point) {
        cursorPoint = nil
        hoverAnchor = nil
        needsDisplay = true
        guard dragMoved, let d = diagram, let target = HitTest.anchor(in: d, at: pt, boxesOnly: true),
              let boxId = target.boxId, let box = d.findBox(boxId) else {
            state.hint = "Drop the port on a box side to connect it."
            return
        }
        // A navigation, an undo or a revert that landed while the button was
        // down has changed the diagram the port was read from: the drop is
        // not written over it (the port may no longer exist there).
        guard state.diagramId.utf16.elementsEqual(did.utf16), document.model == baseline else {
            state.hint = "The diagram changed during the drag; the port was not connected."
            return
        }
        var created: String?
        perform("Connect Port") { m in
            created = try Edits.connectPort(&m, diagramId: did, port: port, boxId: boxId, side: target.side, pos: target.pos)
        }
        if let created {
            state.selection = .arrow(created)
            state.hint = "Connected \(port.code) “\(Self.portName(port))” to box \(box.number)."
        }
    }

    /// A port's label as the status bar names it — the web's `port.label || '(unlabelled)'`.
    private static func portName(_ port: ICOMPort) -> String { port.label.isEmpty ? "(unlabelled)" : port.label }

    /// `arrow` carrying the text drawn as its label (S01, `HitTest.drawnLabel`)
    /// — a bundle's term where it stands for merged members — for the label
    /// rules that place or measure that text.
    private static func asDrawn(_ model: IDEF0Model, _ diagram: Diagram, _ arrow: Arrow) -> Arrow {
        var labelled = arrow
        labelled.label = HitTest.drawnLabel(model, in: diagram, of: arrow)
        return labelled
    }

    override func mouseMoved(with event: NSEvent) {
        let pt = sheetPoint(event)
        setCursor(for: event)
        guard let d = diagram, state.tool == .arrow || state.pendingFrom != nil else {
            if hoverAnchor != nil { hoverAnchor = nil; needsDisplay = true }
            return
        }
        cursorPoint = pt
        hoverAnchor = HitTest.anchor(in: d, at: pt)
        needsDisplay = true
    }

    override func cursorUpdate(with event: NSEvent) { setCursor(for: event) }

    private func setCursor(for event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        // The floating field of an inline edit shows its own text cursor.
        if let field = textField, field.frame.contains(p) { return }
        cursorKind(at: sheetPoint(p)).cursor.set()
    }

    /// What the pointer shows over a point of the sheet. The web app's
    /// stylesheet gives its handles their cursors — a move on a bend handle,
    /// a pointer over an arrow — and these are the same affordances in
    /// native cursors. A port, and an anchor under the arrow tool, show the
    /// crosshair an arrow is drawn with. Space-to-pan's open hand wins over
    /// all of them.
    enum CursorKind: Equatable {
        case arrow, pointingHand, crosshair, openHand, closedHand
        case bend(BendAxis)

        var cursor: NSCursor {
            switch self {
            case .arrow: return .arrow
            case .pointingHand: return .pointingHand
            case .crosshair: return .crosshair
            case .openHand: return .openHand
            case .closedHand: return .closedHand
            case .bend(let axis):
                if #available(macOS 15, *) {
                    return axis == .x ? .columnResize : .rowResize
                }
                return axis == .x ? .resizeLeftRight : .resizeUpDown
            }
        }
    }

    /// The cursor for a sheet point, in the order a press there is resolved
    /// (see `mouseDown`): a port first, then the arrow tool's anchors, then
    /// the handles of a selected arrow, then boxes, then arrows. A box shows
    /// the plain pointer: a press on it selects and nothing more (S01).
    func cursorKind(at pt: Point) -> CursorKind {
        if spaceDown { return .openHand }
        if case .pan = drag { return .closedHand }
        if case .connect = drag { return .crosshair }
        guard let state, document != nil, let d = diagram else { return .arrow }
        if HitTest.port(in: model.ports(d), at: pt) != nil { return .crosshair }
        if state.tool == .arrow || state.pendingFrom != nil {
            return HitTest.anchor(in: d, at: pt) != nil ? .crosshair : .arrow
        }
        let zoom = Double(scale)
        if case .arrow(let id) = state.selection, let i = d.arrowIndex(id) {
            let a = d.arrows[i]
            if HitTest.endHandle(model, of: a, in: d, at: pt, zoom: zoom) != nil { return .crosshair }
            if let axis = HitTest.isOnBendHandle(model, of: a, in: d, at: pt, zoom: zoom) { return .bend(axis) }
        }
        if HitTest.box(in: d, at: pt) != nil { return .arrow }
        if HitTest.arrow(model, in: d, at: pt) != nil { return .pointingHand }
        return .arrow
    }

    /// Set the cursor for wherever the pointer is now, after something other
    /// than a mouse move — a drag ending, Space coming up — changed what it
    /// should be.
    private func refreshCursor() {
        guard let window else { return }
        let p = convert(window.mouseLocationOutsideOfEventStream, from: nil)
        guard bounds.contains(p), !(textField?.frame.contains(p) ?? false) else { return }
        cursorKind(at: sheetPoint(p)).cursor.set()
    }

    override func scrollWheel(with event: NSEvent) {
        let modifiers = event.modifierFlags.intersection([.command, .control, .option])
        if !modifiers.isEmpty {
            let dy = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY : event.scrollingDeltaY * 10
            zoom(by: exp(dy * 0.01), around: convert(event.locationInWindow, from: nil))
            return
        }
        autoFit = false
        translation.x += event.scrollingDeltaX * (event.hasPreciseScrollingDeltas ? 1 : 10)
        translation.y += event.scrollingDeltaY * (event.hasPreciseScrollingDeltas ? 1 : 10)
        repositionTextField()
        needsDisplay = true
    }

    override func magnify(with event: NSEvent) {
        zoom(by: 1 + event.magnification, around: convert(event.locationInWindow, from: nil))
    }

    // MARK: - Keyboard

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 49 { // space
            if !event.isARepeat {
                spaceDown = true
                NSCursor.openHand.set()
            }
            return
        }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
        // Diagram navigation chords. They are handled here, not as menu key
        // equivalents, because a key equivalent fires before the first
        // responder sees the key: ⌘↑, ⌘↓ and ⌘Home must still move the caret
        // in a text field. Here they act only when the canvas has focus.
        if flags == [.command] {
            switch event.keyCode {
            case 126: state.goToParent(in: model); return // up arrow
            case 125: state.openChild(in: model); return // down arrow
            case 115: state.open(model.rootDiagramId); return // home
            default: break
            }
        }
        guard flags.isEmpty, let chars = event.charactersIgnoringModifiers?.lowercased() else {
            super.keyDown(with: event)
            return
        }
        switch chars {
        case "v": state.tool = .select // the tool's own prompt follows from the change
        case "a": state.tool = .arrow
        case "b": addBox()
        // Delete, Backspace and forward Delete (fn-Delete, ⌦), as the web app
        // answers both "Backspace" and "Delete".
        case "\u{7F}", "\u{8}", "\u{F728}": deleteSelection()
        case "\r":
            switch state.selection {
            case .box(let id): beginTextEdit(.boxName(id))
            case .arrow(let id): beginTextEdit(.arrowLabel(id))
            case nil: break
            }
        case "\u{1B}": escape()
        default: super.keyDown(with: event)
        }
    }

    override func keyUp(with event: NSEvent) {
        if event.keyCode == 49 {
            releaseSpacePan()
            return
        }
        super.keyUp(with: event)
    }

    /// End Space-to-pan. Besides the key-up, this runs whenever that key-up
    /// could reach some other view — focus moving to the sidebar or a field,
    /// the window ceasing to be key — so a stale flag cannot turn every later
    /// click into a pan.
    private func releaseSpacePan() {
        guard spaceDown else { return }
        spaceDown = false
        NSCursor.arrow.set()
        refreshCursor()
    }

    override func resignFirstResponder() -> Bool {
        releaseSpacePan()
        return super.resignFirstResponder()
    }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if let window {
            NotificationCenter.default.removeObserver(self, name: NSWindow.didResignKeyNotification, object: window)
        }
        super.viewWillMove(toWindow: newWindow)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let window {
            NotificationCenter.default.addObserver(self, selector: #selector(windowDidResignKey(_:)),
                                                   name: NSWindow.didResignKeyNotification, object: window)
        }
    }

    @objc private func windowDidResignKey(_ note: Notification) { releaseSpacePan() }

    override func cancelOperation(_ sender: Any?) { escape() }

    /// The standard Edit ▸ Delete action, reaching the canvas only while it is
    /// first responder — a text field being edited answers `delete:` itself.
    @objc func delete(_ sender: Any?) { deleteSelection() }

    func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(delete(_:)) { return state?.selection != nil }
        return true
    }

    func escape() {
        if state.pendingFrom != nil { state.pendingFrom = nil; needsDisplay = true; return }
        if state.selection != nil { state.selection = nil; return }
        state.goToParent(in: model)
    }

    func addBox() {
        let did = state.diagramId
        var added: Box?
        perform("Add Box") { m in added = try Edits.addBox(&m, diagramId: did) }
        if let added {
            state.selection = .box(added.id)
            beginTextEdit(.boxName(added.id))
        }
    }

    func deleteSelection() {
        guard let sel = state.selection else { return }
        let did = state.diagramId
        let name: String
        if case .box = sel { name = "Delete Box" } else { name = "Delete Arrow" }
        if perform(name, { m in try Edits.delete(&m, diagramId: did, selection: sel) }) {
            state.selection = nil
        }
    }

    /// Lay the diagram's boxes out along the staircase again (S01). A name
    /// still being typed is committed first: the field floats over the box's
    /// old place, and the box may be about to leave it.
    func arrange() {
        commitTextEdit()
        let did = state.diagramId
        if perform("Arrange", { m in try Edits.arrange(&m, diagramId: did) }) {
            state.hint = "Boxes arranged along the staircase in reading order."
        }
    }

    /// Move the selected box one step in the reading order (S01); the
    /// staircase follows, so the box keeps its selection but not its place.
    func moveSelection(by: Int) {
        guard case .box(let id) = state.selection else { return }
        commitTextEdit()
        let did = state.diagramId
        perform("Move Activity") { m in try Edits.moveBox(&m, diagramId: did, boxId: id, by: by) }
    }

    /// Apply an edit, turning a refusal into a hint rather than an alert.
    @discardableResult
    private func perform(_ name: String, _ change: (inout IDEF0Model) throws -> Void) -> Bool {
        do {
            try document.apply(name, undoManager: undoManager, change)
            needsDisplay = true
            return true
        } catch {
            state.hint = String(describing: error)
            NSSound.beep()
            return false
        }
    }

    // MARK: - Inline text editing

    /// Open the floating field on a box name or an arrow label — the text
    /// actually drawn (S01): where the arrow stands for merged bundle
    /// members, that is the bundle's term, and the field then renames the
    /// bundle (`finishTextEdit`); otherwise it is the arrow's own label,
    /// edited as it always was. A hidden member selected from the sidebar is
    /// not drawn at all and edits its own.
    func beginTextEdit(_ target: TextEditTarget) {
        commitTextEdit()
        guard let d = diagram else { return }
        let value: String
        let rect: SheetRect
        var bundleId: String?
        switch target {
        case .boxName(let id):
            guard let b = d.findBox(id) else { return }
            value = b.name
            rect = SheetRect(x: b.x + 8, y: b.y + b.h / 2 - 14, w: b.w - 16, h: 28)
        case .arrowLabel(let id):
            guard let a = d.findArrow(id) else { return }
            let bundleTerm = HitTest.drawsBundleTerm(model, in: d, a)
            let labelled = bundleTerm ? Self.asDrawn(model, d, a) : a
            value = labelled.label
            if bundleTerm { bundleId = model.effectiveConceptId(a.conceptId) }
            // F59: the editor box centres on the label's actual displayed
            // position, auto-placed or manually offset, not the legacy spot
            // — on the part of the route the label belongs to (S02).
            let pts = HitTest.labelPath(model, in: d, a)
            let icomEnds = SheetDrawing.icomRects(model, d)
            let boxes = d.boxes.map(\.rect)
            let pos = labelPosition(pts, labelled, icomEnds: icomEnds, boxes: boxes)
            rect = SheetRect(x: pos.x - 70, y: pos.y - 14, w: 140, h: 24)
        }
        let field = NSTextField(string: value)
        field.delegate = self
        field.alignment = .center
        field.focusRingType = .none
        field.isBezeled = false
        field.isBordered = false
        field.drawsBackground = true
        field.placeholderString = {
            if case .boxName = target { return "Active verb phrase" }
            return "Noun phrase"
        }()
        state.editing = target
        activeEdit = (target, d.id, bundleId)
        editingRect = rect
        textField = field
        styleTextField()
        addSubview(field)
        repositionTextField()
        window?.makeFirstResponder(field)
        field.currentEditor()?.selectAll(nil)
    }

    private var editingRect: SheetRect?

    /// The field in the palette (S03) — the web's `#inline-editor input`: a
    /// 2 px accent border, the sunken surface behind the palette's text, so
    /// it stays legible over a dark sheet whatever the palette. Explicit
    /// colours, not the appearance's, so the field cannot come up light
    /// should the window's appearance lag the palette.
    private func styleTextField() {
        guard let field = textField else { return }
        field.appearance = NSAppearance(named: .darkAqua)
        field.backgroundColor = colors.sunken
        field.textColor = colors.text
        field.wantsLayer = true
        field.layer?.borderColor = colors.accent.cgColor
        field.layer?.borderWidth = 2
        field.layer?.cornerRadius = 2
        placeholderInPalette(field)
    }

    /// The placeholder in the tertiary text colour, at the field's own size.
    private func placeholderInPalette(_ field: NSTextField) {
        guard let prompt = field.placeholderString ?? field.placeholderAttributedString?.string else { return }
        field.placeholderAttributedString = NSAttributedString(
            string: prompt, attributes: [.foregroundColor: colors.text3, .font: field.font ?? NSFont.systemFont(ofSize: 13)])
    }

    private func repositionTextField() {
        guard let field = textField, let r = editingRect else { return }
        let frame = screenRect(r)
        field.font = .systemFont(ofSize: max(11, min(18, 13 * scale)))
        placeholderInPalette(field)
        field.frame = CGRect(x: frame.minX, y: frame.midY - 12, width: max(frame.width, 120), height: 24)
    }

    /// Commit the field in progress, if any.
    func commitTextEdit() { finishTextEdit(commit: true) }

    private func finishTextEdit(commit: Bool) {
        guard let field = textField, let edit = activeEdit else { return }
        let value = field.stringValue
        // Cleared before the field leaves the window: taking it down and
        // moving focus both end its editing, and those calls find nothing left to finish.
        textField = nil
        activeEdit = nil
        editingRect = nil
        if state.editing != nil { state.editing = nil }
        field.removeFromSuperview()
        window?.makeFirstResponder(self)
        guard commit else { return }
        switch edit.target {
        case .boxName(let id):
            perform("Rename Box") { m in try Edits.renameBox(&m, diagramId: edit.diagramId, boxId: id, to: value) }
        case .arrowLabel(let id):
            if let bundleId = edit.bundleId {
                // The drawn label was the bundle's term (S01): renaming it
                // renames the bundle — "Rename Concept", as on the web —
                // carrying every box and arrow bound to the bundle itself
                // along and leaving the members' own labels as they are. A
                // blank term is refused, as it is everywhere a bundle is named.
                guard !jsTrim(value).isEmpty else { state.hint = Edits.Refusal.blankTerm.description; return }
                perform("Rename Concept") { m in m.renameConcept(bundleId, to: value) }
            } else {
                perform("Label Arrow") { m in try Edits.labelArrow(&m, diagramId: edit.diagramId, arrowId: id, to: value) }
            }
        }
    }

    func controlTextDidEndEditing(_ note: Notification) {
        let movement = (note.userInfo?["NSTextMovement"] as? Int).flatMap(NSTextMovement.init(rawValue:))
        finishTextEdit(commit: movement != .cancel)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.cancelOperation(_:)) {
            finishTextEdit(commit: false)
            return true
        }
        return false
    }
}

/// The canvas in SwiftUI.
struct SheetCanvas: NSViewRepresentable {
    @ObservedObject var document: IDEF0Document
    let state: EditorState
    /// The palette picked in Settings (S03) — the same key the web app's
    /// theme picker writes — so a change there redraws every canvas at once.
    @AppStorage("ui-kit.race") private var race: SCRace = .steel

    func makeNSView(context: Context) -> SheetCanvasView {
        let view = SheetCanvasView()
        view.document = document
        view.state = state
        view.race = race
        return view
    }

    func updateNSView(_ view: SheetCanvasView, context: Context) {
        view.document = document
        view.state = state
        view.race = race
        // Reading these registers the dependencies that bring SwiftUI back here.
        _ = document.model
        _ = (state.diagramId, state.selection, state.tool, state.pendingFrom, state.editing)
        view.handle(state.canvasRequest)
        // Should anything but the canvas end an edit, its field is not left
        // behind — committed after this pass, since a commit edits the model.
        if view.textField != nil, state.editing == nil {
            DispatchQueue.main.async { view.commitTextEdit() }
        }
        view.needsDisplay = true
    }
}
