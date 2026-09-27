// Creation and read-only lookups — the top half of src/model/model.js.
// Operations that restructure a model (numbering, decomposition, ICOM coding)
// build on these in ModelOps.swift.

// MARK: - Creation

/// `newDiagram({ node, title, parentBoxId, titleLocked })`.
public func newDiagram(node: String, title: String, parentBoxId: String? = nil, titleLocked: Bool = false) -> Diagram {
    Diagram(id: uid("dg"), node: node, title: title, titleLocked: titleLocked, parentBoxId: parentBoxId)
}

/// `newBox({ name, number, x, y, w, h, conceptId })`.
public func newBox(
    name: String = "", number: Int = 1, x: Double, y: Double,
    w: Double = Sheet.boxDefault.w, h: Double = Sheet.boxDefault.h, conceptId: String? = nil
) -> Box {
    Box(id: uid("bx"), name: name, number: number, conceptId: conceptId, x: x, y: y, w: w, h: h)
}

/// `newArrow({ label, from, to, bend, conceptId })`.
public func newArrow(label: String = "", from: Endpoint, to: Endpoint, bend: Double? = nil, conceptId: String? = nil) -> Arrow {
    Arrow(id: uid("ar"), label: label, conceptId: conceptId, from: from, to: to, bend: bend)
}

extension IDEF0Model {
    /// `createModel(title)`: an A-0 context diagram holding a single box.
    public static func create(title: String = "Untitled Model") -> IDEF0Model {
        var context = newDiagram(node: "A-0", title: title)
        let w = Sheet.work
        context.boxes.append(newBox(
            name: title,
            number: 0,
            x: w.x + (w.w - 300) / 2,
            y: w.y + (w.h - 170) / 2,
            w: 300, h: 170
        ))
        var diagrams = OrderedMap<Diagram>()
        diagrams[context.id] = context
        let today = todayISO()
        return IDEF0Model(
            id: uid("mdl"), title: title, status: ModelStatus.working.rawValue,
            created: today, revised: today, diagrams: diagrams, rootDiagramId: context.id
        )
    }
}

// MARK: - Lookups

/// A box together with the diagram it sits on.
public struct BoxLocation: Hashable, Sendable {
    public var diagramId: String
    public var box: Box
    public init(diagramId: String, box: Box) { self.diagramId = diagramId; self.box = box }
}

extension IDEF0Model {
    /// `contextDiagram(m)` — the A-0 diagram.
    public var contextDiagram: Diagram? { diagrams[rootDiagramId] }

    public func diagram(_ id: String?) -> Diagram? {
        guard let id else { return nil }
        return diagrams[id]
    }

    /// Mutate one diagram in place; returns nil when there is no such diagram.
    @discardableResult
    public mutating func updateDiagram<R>(_ id: String, _ body: (inout Diagram) throws -> R) rethrows -> R? {
        guard var d = diagrams[id] else { return nil }
        let result = try body(&d)
        diagrams[id] = d
        return result
    }

    /// `findBoxAnywhere(m, boxId)` — first match in diagram order.
    public func findBoxAnywhere(_ boxId: String) -> BoxLocation? {
        for (id, d) in diagrams {
            if let b = d.boxes.first(where: { jsStrictEquals($0.id, boxId) }) { return BoxLocation(diagramId: id, box: b) }
        }
        return nil
    }

    /// `parentOf(m, diagram)` — the box a diagram details.
    public func parentOf(_ diagram: Diagram?) -> BoxLocation? {
        guard let diagram, let parentBoxId = diagram.parentBoxId, !parentBoxId.isEmpty else { return nil }
        return findBoxAnywhere(parentBoxId)
    }

    /// `childDiagram(m, box)` — the diagram detailing a box.
    public func childDiagram(of box: Box?) -> Diagram? {
        guard let box, let childId = box.childDiagramId, !childId.isEmpty else { return nil }
        return diagrams[childId]
    }

    /// `diagramTree(m)` — diagrams as a depth-first walk of the decomposition tree.
    ///
    /// A diagram that details one of its own ancestors (a cycle a hand-edited
    /// or imported file can hold) is not descended into again, so the walk
    /// ends; the validator reports it as decomp-cycle. The guard is the current
    /// path, not a global visited set, so a diagram two boxes name is still
    /// listed under each.
    public func diagramTree() -> [(diagram: Diagram, depth: Int)] {
        var out: [(diagram: Diagram, depth: Int)] = []
        var path = Set<JSStringKey>()
        func walk(_ d: Diagram?, _ depth: Int) {
            guard let d else { return }
            out.append((d, depth))
            path.insert(JSStringKey(d.id))
            for b in d.sortedBoxes {
                if let c = childDiagram(of: b), !path.contains(JSStringKey(c.id)) { walk(c, depth + 1) }
            }
            path.remove(JSStringKey(d.id))
        }
        walk(contextDiagram, 0)
        return out
    }

    /// `activityTree(m)` — every box in reading order, each followed by the
    /// boxes of its own decomposition: the node tree the sidebar draws (the
    /// web's `activityNode` recursion in src/ui/panels.js).
    ///
    /// Guarded exactly like `diagramTree`: a box is always listed, and only
    /// descending into a detail diagram already on the current path is skipped,
    /// so a cyclic hand-edited or imported file lists finitely instead of
    /// overflowing the stack. A diagram two boxes name is still listed twice.
    public func activityTree() -> [(diagram: Diagram, box: Box, depth: Int)] {
        var out: [(diagram: Diagram, box: Box, depth: Int)] = []
        var path = Set<JSStringKey>()
        func walk(_ d: Diagram, _ depth: Int) {
            path.insert(JSStringKey(d.id))
            for b in d.sortedBoxes {
                out.append((d, b, depth))
                if let c = childDiagram(of: b), !path.contains(JSStringKey(c.id)) { walk(c, depth + 1) }
            }
            path.remove(JSStringKey(d.id))
        }
        if let ctx = contextDiagram { walk(ctx, 0) }
        return out
    }

    /// True for the A-0 diagram. The validator keys on the root id; numbering
    /// keys on the node string. They agree for any well-formed model.
    public func isContext(_ diagram: Diagram) -> Bool { jsStrictEquals(diagram.id, rootDiagramId) }
}

extension Diagram {
    /// `findBox(diagram, boxId)`.
    public func findBox(_ boxId: String?) -> Box? {
        guard let boxId else { return nil }
        return boxes.first { jsStrictEquals($0.id, boxId) }
    }

    /// `findArrow(diagram, arrowId)`. The app layer needs this for the same
    /// reason the core does: an id is a sequence of code units, and Swift's
    /// `==` would quietly match a canonically equivalent one the model layer
    /// treats as a different arrow.
    public func findArrow(_ arrowId: String?) -> Arrow? {
        guard let arrowId else { return nil }
        return arrows.first { jsStrictEquals($0.id, arrowId) }
    }

    public func boxIndex(_ boxId: String) -> Int? { boxes.firstIndex { jsStrictEquals($0.id, boxId) } }
    public func arrowIndex(_ arrowId: String) -> Int? { arrows.firstIndex { jsStrictEquals($0.id, arrowId) } }

    /// `sortedBoxes(dg)` — boxes by number, stable.
    public var sortedBoxes: [Box] { boxes.stableSorted { $0.number < $1.number } }

    /// `arrowsTouching(diagram, boxId)`.
    public func arrowsTouching(_ boxId: String) -> [Arrow] {
        arrows.filter { $0.from.isOnBox(boxId) || $0.to.isOnBox(boxId) }
    }

    /// `boxNode(diagram, box)` — the node number a box carries. Below A0 the
    /// parent's node is extended (box 2 of A3 is A32); the top box is A0.
    public func node(of box: Box) -> String { boxNode(self, box) }
}

/// `boxNode(diagram, box)`.
public func boxNode(_ diagram: Diagram, _ box: Box) -> String {
    if diagram.node == "A-0" { return "A0" }
    if diagram.node == "A0" { return "A\(box.number)" }
    return "\(diagram.node)\(box.number)"
}

extension Arrow {
    /// `arrowRole(arrow)` — derived from the side of the box it touches, never stored.
    public var role: Role {
        if to.kind == .box { return to.side.role }
        if from.kind == .box { return from.side == .bottom ? .call : .output }
        return .unknown
    }
}
