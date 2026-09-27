// The editing canvas's rules — a port of the pure logic in src/ui/canvas.js.
//
// Hit testing, grab radii, snapping, and exactly what each drag does to the
// model live here, with no AppKit, so the Mac canvas behaves like the web
// canvas and every rule can be tested without a window.

import IDEF0Core

public enum CanvasRules {
    /// Arrow bends snap to multiples of this.
    public static let snapStep = 5.0
    /// How close to the drawing-area edge counts as a boundary anchor.
    public static let edgeGrab = 26.0
    /// How far outside a box its sides still catch an arrow end.
    public static let boxGrab = 14.0
    /// How close to an arrow's route a click selects it.
    public static let arrowGrab = 9.0
    /// How close to a label's anchor a drag moves the label instead.
    public static let labelGrab = 26.0
    /// Half the width of the band along a port's stub that catches a press
    /// (S01): the stub is drawn as a hairline, so the band is 10 units wide —
    /// the web canvas's `PORT_HALF_W`.
    public static let portGrab = 5.0
    /// How far from the centre of a port's open circle (drawn at r 4) a press
    /// still takes hold of the port — the web canvas's `PORT_RING`.
    public static let portRingGrab = 6.0

    /// `snap(v)`: `Math.round(v / SNAP) * SNAP`.
    public static func snap(_ v: Double) -> Double { jsRound(v / snapStep) * snapStep }
}

/// What the modeller has selected on the current diagram. A port (S01) is
/// never a selection: it is an affordance for drawing an arrow, not an object.
public enum Selection: Hashable, Sendable {
    case box(String)
    case arrow(String)

}

public enum BendAxis: String, Hashable, Sendable { case x, y }

/// `a === b` for ids, as the web app compares them: the same code units.
func sameId(_ a: String?, _ b: String?) -> Bool {
    guard let a, let b else { return a == nil && b == nil }
    return a.utf16.elementsEqual(b.utf16)
}

/// One arrow of a fork or join group at one end (S02), with the end and
/// bend it has stored when the drag began: `Edits.moveEndpoint` moves every
/// member along the face together and puts the others back as they were
/// when the dragged end leaves the face.
public struct EndMember: Hashable, Sendable {
    public var id: String
    public var endpoint: Endpoint
    public var bend: Double?
    public init(id: String, endpoint: Endpoint, bend: Double?) { self.id = id; self.endpoint = endpoint; self.bend = bend }
    public init(_ arrow: Arrow, _ end: ArrowEnd) { self.init(id: arrow.id, endpoint: arrow[end], bend: arrow.bend) }
}

// MARK: - Hit testing

public enum HitTest {
    /// `anchorAt(dg, pt)`: the arrow endpoint a pointer position implies — a box
    /// side when near a box (the first box in drawing order wins, as in the web
    /// app), otherwise the nearest drawing-area edge within reach.
    public static func anchor(in diagram: Diagram, at pt: Point, boxesOnly: Bool = false) -> Endpoint? {
        let grab = CanvasRules.boxGrab
        for b in diagram.boxes {
            let r = b.rect
            let inside = pt.x >= r.x - grab && pt.x <= r.x + r.w + grab && pt.y >= r.y - grab && pt.y <= r.y + r.h + grab
            guard inside else { continue }
            let hit = nearestSide(r, pt)
            return .box(b.id, hit.side, hit.pos)
        }
        if boxesOnly { return nil }
        let w = Sheet.work
        let near: [Side: Double] = [
            .left: abs(pt.x - w.x), .right: abs(pt.x - w.x2),
            .top: abs(pt.y - w.y), .bottom: abs(pt.y - w.y2),
        ]
        var best: Side?
        for side in Side.allCases {
            guard near[side]! <= CanvasRules.edgeGrab else { continue }
            if side == .left || side == .right {
                if pt.y < w.y - 4 || pt.y > w.y2 + 4 { continue }
            } else if pt.x < w.x - 4 || pt.x > w.x2 + 4 {
                continue
            }
            if best == nil || near[side]! < near[best!]! { best = side }
        }
        guard let best else { return nil }
        return .boundary(best, posOnSide(w, best, pt))
    }

    /// `boxAt(dg, pt)`: the topmost box under the pointer — the last drawn.
    public static func box(in diagram: Diagram, at pt: Point) -> Box? {
        diagram.boxes.last { pt.x >= $0.x && pt.x <= $0.x + $0.w && pt.y >= $0.y && pt.y <= $0.y + $0.h }
    }

    /// The arrow whose own route (`routeArrow`, at its stored ends) passes
    /// nearest, within reach; ties go to the arrow drawn first. The route
    /// alone, whether or not the arrow is drawn that way: what a press
    /// resolves through is `arrow(_:in:at:)`.
    public static func arrow(in diagram: Diagram, at pt: Point) -> Arrow? {
        var best: Arrow?
        var bestDistance = CanvasRules.arrowGrab
        for a in diagram.arrows {
            let d = distToPolyline(routeArrow(diagram, a), pt)
            if d < bestDistance { bestDistance = d; best = a }
        }
        return best
    }

    /// `arrowAt(dg, pt)` (S01, S02): the arrow a press near a drawn route
    /// selects — the nearest drawn route within reach (the first in array
    /// order on a tie). A bundle member hidden behind its representative
    /// (`SheetDrawing.drawnArrows`) has no ink and no route of its own to
    /// press; the representative is what is drawn there. On the trunk of a
    /// fork or join every member's route coincides, and the press selects
    /// the group's representative — the arrow the trunk is; on a branch it
    /// selects that branch. The drawn routes are walked once and the trunk
    /// test is one more polyline, so this stays O(arrows) in what it adds.
    public static func arrow(_ model: IDEF0Model, in diagram: Diagram, at pt: Point) -> Arrow? {
        let drawn = SheetDrawing.drawnArrows(model, diagram)
        var best: DrawnArrow?
        var bestDistance = CanvasRules.arrowGrab
        for entry in drawn {
            let d = distToPolyline(entry.pts, pt)
            if d < bestDistance { bestDistance = d; best = entry }
        }
        guard let best else { return nil }
        // The nearest point lies on the trunk when the trunk — a piece of
        // this very route — is no farther than the route itself.
        if best.isForkBranch, let trunk = best.forkTrunk, let rep = best.fork,
           distToPolyline(trunk, pt) <= bestDistance + 1e-6 {
            return drawn.first { sameId($0.arrow.id, rep) }?.arrow ?? best.arrow
        }
        if best.isJoinBranch, let trunk = best.joinTrunk, let rep = best.join,
           distToPolyline(trunk, pt) <= bestDistance + 1e-6 {
            return drawn.first { sameId($0.arrow.id, rep) }?.arrow ?? best.arrow
        }
        return best.arrow
    }

    /// The members of the fork (`end` = .from) or join (.to) group `arrowId`
    /// belongs to on this diagram (S02) — every arrow drawn from that trunk,
    /// with the end each has stored — or the arrow alone when it is not
    /// grouped there. What an endpoint drag moves together, captured at the
    /// press so the drag can restore members it leaves behind.
    public static func endGroup(_ model: IDEF0Model, in diagram: Diagram, arrowId: String, end: ArrowEnd) -> [EndMember] {
        let drawn = SheetDrawing.drawnArrows(model, diagram)
        guard let own = drawn.first(where: { sameId($0.arrow.id, arrowId) }) else {
            return diagram.arrows.first { sameId($0.id, arrowId) }.map { [EndMember($0, end)] } ?? []
        }
        let rep = end == .from ? own.fork : own.join
        guard let rep else { return [EndMember(own.arrow, end)] }
        return drawn.filter { sameId(end == .from ? $0.fork : $0.join, rep) }.map { EndMember($0.arrow, end) }
    }

    /// The drawn entry standing for the arrow `arrowId` (S01): the entry
    /// drawing it, or the representative hiding it as a bundle member; nil
    /// when the diagram has no such arrow. Ids match by code unit, as the
    /// web app's `Map` keys do.
    public static func drawnEntry(_ model: IDEF0Model, in diagram: Diagram, standingFor arrowId: String) -> DrawnArrow? {
        SheetDrawing.drawnArrows(model, diagram).first { entry in
            sameId(entry.arrow.id, arrowId) || entry.hidden.contains { sameId($0, arrowId) }
        }
    }

    /// `drawnLabelOf(dg, arrow)` (S01): the text drawn as `arrow`'s label —
    /// the bundle's term where the arrow stands for merged members, else its
    /// own label. The label hit test, the label drag and the inline editor
    /// all work on this, so what the sheet shows is what the pointer finds.
    /// A hidden member is not drawn at all and reads as its own label.
    public static func drawnLabel(_ model: IDEF0Model, in diagram: Diagram, of arrow: Arrow) -> String {
        guard let entry = drawnEntry(model, in: diagram, standingFor: arrow.id),
              sameId(entry.arrow.id, arrow.id) else { return arrow.label }
        return entry.label
    }

    /// Whether `arrow`'s drawn label is its bundle's term rather than its
    /// own (S01): it is drawn, and stands for at least one hidden member.
    public static func drawsBundleTerm(_ model: IDEF0Model, in diagram: Diagram, _ arrow: Arrow) -> Bool {
        guard let entry = drawnEntry(model, in: diagram, standingFor: arrow.id),
              sameId(entry.arrow.id, arrow.id) else { return false }
        return !entry.hidden.isEmpty
    }

    /// The entry drawing `arrow` itself (S01, S02) — nil for a hidden bundle
    /// member, which is not drawn at all.
    public static func ownEntry(_ model: IDEF0Model, in diagram: Diagram, _ arrow: Arrow) -> DrawnArrow? {
        SheetDrawing.drawnArrows(model, diagram).first { sameId($0.arrow.id, arrow.id) }
    }

    /// The route an arrow is drawn along (`SheetDrawing.drawnArrows`): with
    /// its grouped ends at the trunk (S02), grouped with any other unpinned
    /// drawn arrow between the same faces so parallel arrows do not overlap.
    /// A hidden bundle member, drawn nowhere, routes on its own for the
    /// handles a selection from the sidebar shows.
    public static func route(_ model: IDEF0Model, in diagram: Diagram, _ arrow: Arrow) -> [Point] {
        ownEntry(model, in: diagram, arrow)?.pts ?? routeArrow(diagram, arrow)
    }

    /// The part of the drawn route `arrow`'s label is placed against (S02):
    /// the trunk for a fork or join's representative, the branch alone for a
    /// member with a label of its own, the whole route otherwise. A branch
    /// whose label the trunk shows has none drawn, but its own label is still
    /// edited on its route.
    public static func labelPath(_ model: IDEF0Model, in diagram: Diagram, _ arrow: Arrow) -> [Point] {
        let entry = ownEntry(model, in: diagram, arrow)
        return entry?.labelPath ?? entry?.pts ?? routeArrow(diagram, arrow)
    }

    /// `bendHandle(a, b, pts)`: where the middle run's drag handle sits, and the
    /// axis it moves along. Only a route with a visible bend to grab — not a
    /// feedback, whose shape is fixed, and not ends whose runs already point
    /// straight at each other — has one. Read off the drawn ends (S02).
    public static func bendHandle(_ model: IDEF0Model, in diagram: Diagram, _ arrow: Arrow) -> (point: Point, axis: BendAxis)? {
        let entry = ownEntry(model, in: diagram, arrow)
        let drawn = entry?.drawn ?? arrow
        let a = anchorOf(diagram, drawn.from), b = anchorOf(diagram, drawn.to)
        guard let axisName = bendAxis(a, b), let axis = BendAxis(rawValue: axisName) else { return nil }
        let pts = entry?.pts ?? routeArrow(diagram, arrow)
        guard !pts.isEmpty else { return nil }
        let mid = pts[pts.count / 2]
        let second = pts[min(1, pts.count - 1)], penultimate = pts[max(0, pts.count - 2)]
        return axis == .x
            ? (Point(x: mid.x, y: (second.y + penultimate.y) / 2), .x)
            : (Point(x: (second.x + penultimate.x) / 2, y: mid.y), .y)
    }

    /// Whether a press on a selected, labelled arrow lands on its label. The web
    /// app measures from the route's longest-segment midpoint plus the label's
    /// offset — not from where the text is drawn — and so does this. Kept as a
    /// fallback alongside `HitTest.label` (F39): its 26-unit radius around the
    /// legacy base still catches a press near the route even where the actual
    /// label rectangle (auto-placed, or drawn well off to one side) does not.
    public static func isOnLabel(_ model: IDEF0Model, in diagram: Diagram, _ arrow: Arrow, at pt: Point) -> Bool {
        guard !arrow.label.isEmpty else { return false }
        let mid = longestSegmentMid(route(model, in: diagram, arrow))
        let dx = pt.x - (mid.x + arrow.ldx), dy = pt.y - (mid.y + arrow.ldy)
        return (dx * dx + dy * dy).squareRoot() < CanvasRules.labelGrab
    }

    /// `HitTest.label(_:in:at:)` (F39): the drawn arrow, if any, whose
    /// label's actual displayed rectangle contains `pt` — `labelPosition`'s
    /// auto-placed spot (F59), or the legacy base plus a manual ldx/ldy,
    /// whichever `SheetDrawing.arrow` really drew, for the text really drawn:
    /// a bundle representative's label is the bundle's term (S01), placed
    /// and measured as that, and a hidden member has no label to hit. Walked
    /// from the last-drawn back, matching paint order, so a label painted
    /// over another arrow's route still wins the hit. Tried before
    /// `HitTest.arrow` (after handles and `HitTest.box`, since boxes paint
    /// over arrows), with `HitTest.arrow` + `isOnLabel` kept as a fallback.
    public static func label(_ model: IDEF0Model, in diagram: Diagram, at pt: Point) -> Arrow? {
        let entries = SheetDrawing.drawnArrows(model, diagram)
        let icomEnds = SheetDrawing.icomRects(entries, codes: model.icomCodes(diagram))
        let boxes = diagram.boxes.map(\.rect)
        for drawn in entries.reversed() where !drawn.label.isEmpty {
            // Placed against the part of the route the label belongs to
            // (S02: a trunk, a branch), and measured as the drawn text; a
            // branch whose label the trunk shows draws none to hit.
            guard let labelPath = drawn.labelPath else { continue }
            var labelled = drawn.arrow
            labelled.label = drawn.label
            let pos = labelPosition(labelPath, labelled, icomEnds: icomEnds, boxes: boxes)
            if pointInRect(labelRect(pos, textWidth(drawn.label, fontSize: 10.5)), pt) { return drawn.arrow }
        }
        return nil
    }

    /// `HitTest.port(in:at:)` (S01): the port — a parent concept not yet
    /// connected on this diagram, drawn at the sheet edge — whose stub or
    /// open circle the pointer is on: the `2 × portGrab`-wide rectangle
    /// along the stub from `edge` to `inner` (`portShape`), or within
    /// `portRingGrab` of the circle's centre at `inner` — the web canvas's
    /// `portAt`, unit for unit. The first port in `ports` order wins where
    /// two overlap, as the first box wins an anchor. Pure geometry over the
    /// list `IDEF0Model.ports(_:)` derives, so it needs no model of its own.
    public static func port(in ports: [ICOMPort], at pt: Point) -> ICOMPort? {
        let grab = CanvasRules.portGrab
        for port in ports {
            let s = portShape(port)
            let horizontal = port.side == .left || port.side == .right
            let stub = horizontal
                ? SheetRect(x: Swift.min(s.edge.x, s.inner.x), y: s.edge.y - grab, w: abs(s.inner.x - s.edge.x), h: grab * 2)
                : SheetRect(x: s.edge.x - grab, y: Swift.min(s.edge.y, s.inner.y), w: grab * 2, h: abs(s.inner.y - s.edge.y))
            if pointInRect(stub, pt) || hypot(pt.x - s.inner.x, pt.y - s.inner.y) <= CanvasRules.portRingGrab { return port }
        }
        return nil
    }

    /// Which end handle of a selected arrow the pointer is on, if either.
    public static func endHandle(_ model: IDEF0Model, of arrow: Arrow, in diagram: Diagram, at pt: Point, zoom: Double, reach: Double = 7) -> ArrowEnd? {
        let pts = route(model, in: diagram, arrow)
        guard let first = pts.first, let last = pts.last else { return nil }
        let r = reach / zoom
        if hypot(pt.x - first.x, pt.y - first.y) <= r { return .from }
        if hypot(pt.x - last.x, pt.y - last.y) <= r { return .to }
        return nil
    }

    /// Whether the pointer is on a selected arrow's bend handle.
    public static func isOnBendHandle(_ model: IDEF0Model, of arrow: Arrow, in diagram: Diagram, at pt: Point, zoom: Double, reach: Double = 7) -> BendAxis? {
        guard let h = bendHandle(model, in: diagram, arrow) else { return nil }
        let r = reach / zoom
        return abs(pt.x - h.point.x) <= r && abs(pt.y - h.point.y) <= r ? h.axis : nil
    }

    private static func hypot(_ x: Double, _ y: Double) -> Double { (x * x + y * y).squareRoot() }
}

// MARK: - Drags

/// What each drag does to the model. Only arrows are dragged (S01): a box's
/// place is the staircase's to decide — `layoutBoxes` after every structural
/// edit and on "Arrange" — so there is no move or resize rule here, and a
/// press on a box only selects it.
public enum DragRules {
    /// Dragging a bend pins the middle run at the snapped pointer position,
    /// kept inside the drawing area.
    public static func bend(axis: BendAxis, pointer: Point) -> Double {
        let w = Sheet.work
        let v = CanvasRules.snap(axis == .x ? pointer.x : pointer.y)
        return axis == .x ? clamp(v, w.x, w.x2) : clamp(v, w.y, w.y2)
    }

    /// Dragging a label moves its offset with the pointer, in whole units.
    public static func labelOffset(original: Point, dragStart: Point, pointer: Point) -> Point {
        Point(x: jsRound(original.x + (pointer.x - dragStart.x)), y: jsRound(original.y + (pointer.y - dragStart.y)))
    }

    /// The `(dx, dy)` a label drag should start from (F59): a label already
    /// offset keeps its own ldx/ldy, since that already says how far it sits
    /// past the auto position; one still at its auto-placed spot starts from
    /// the gap between that spot and `legacyLabelBase`, so ldx/ldy keep
    /// meaning "how far past the (unmoved) legacy base" once the drag ends,
    /// and the label does not jump the moment it starts moving.
    public static func labelDragOrigin(_ model: IDEF0Model, _ diagram: Diagram, _ arrow: Arrow) -> Point {
        let dx = (arrow.ldx == 0 || arrow.ldx.isNaN) ? 0 : arrow.ldx
        let dy = (arrow.ldy == 0 || arrow.ldy.isNaN) ? 0 : arrow.ldy
        if dx != 0 || dy != 0 { return Point(x: dx, y: dy) }
        // Against the part of the route the label is drawn on (S02).
        let pts = HitTest.labelPath(model, in: diagram, arrow)
        let icomEnds = SheetDrawing.icomRects(model, diagram)
        let boxes = diagram.boxes.map(\.rect)
        let auto = labelPlacement(pts, arrow.label, icomEnds: icomEnds, boxes: boxes)
        let base = legacyLabelBase(pts)
        return Point(x: auto.x - base.x, y: auto.y - base.y)
    }
}
