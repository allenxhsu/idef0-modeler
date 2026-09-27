// The IDEF0 model as value types — the same shape the web app keeps in
// src/model/model.js:
//
//   Model    { schema, id, title, author, project, purpose, viewpoint, status,
//              created, revised, glossary[], diagrams{}, rootDiagramId }
//   Diagram  { id, node, title, titleLocked, parentBoxId, cNumber, notes[], boxes[], arrows[] }
//   Box      { id, name, number, conceptId, x, y, w, h, childDiagramId, note, refs }
//   Arrow    { id, label, conceptId, from, to, bend, ldx, ldy, tunnelFrom, tunnelTo, note }
//   Endpoint { type:'box', boxId, side, pos } | { type:'boundary', side, pos }
//   Concept  { id, term, kind, definition, members? }
//
// A box, arrow, diagram and concept may also carry the optional per-element
// clocks `updatedAt` and `deletedAt` (ISO-8601 instants; `deletedAt` is a
// tombstone marking the element removed). Neither is ever invented: an
// element the file records none for keeps none, so it round-trips unchanged.
//
// A concept whose `members` lists other concepts is a bundle (FIPS 183
// §3.2.2.3): the bundle carries the general label, its members the specific
// ones. Boxes and arrows always bind to the specific concept; the bundle is
// looked up from it (`bundleOf`, `effectiveConceptId` in Concepts.swift).
//
// The model, a concept, a diagram, a box and an arrow also keep `extras`: the
// members of the file this app does not model, written back after the rest.
//
// A box's node number and the node number of its detail diagram are the same
// string (FIPS 183): box 3 of diagram A2 is node A23, and its child is A23.
// `conceptId` points into `glossary`, the concept registry; a child diagram's
// inherited boundary arrow keeps its parent's conceptId.
//
// Values, not objects: an edit is a new model, which is what makes snapshot
// undo trivial and lets the model cross threads freely.

public enum EndpointKind: String, Hashable, Sendable {
    case box, boundary
}

public struct Endpoint: Hashable, Sendable {
    public var kind: EndpointKind
    /// Set only when `kind == .box`.
    public var boxId: String?
    public var side: Side
    /// Position along the side, 0…1, left-to-right or top-to-bottom.
    public var pos: Double

    public init(kind: EndpointKind, boxId: String? = nil, side: Side, pos: Double) {
        self.kind = kind
        self.boxId = boxId
        self.side = side
        self.pos = pos
    }

    /// `boxEnd(boxId, side, pos)`.
    public static func box(_ boxId: String, _ side: Side, _ pos: Double = 0.5) -> Endpoint {
        Endpoint(kind: .box, boxId: boxId, side: side, pos: pos)
    }

    /// `boundaryEnd(side, pos)`.
    public static func boundary(_ side: Side, _ pos: Double = 0.5) -> Endpoint {
        Endpoint(kind: .boundary, boxId: nil, side: side, pos: pos)
    }

    public var isBox: Bool { kind == .box }
    public var isBoundary: Bool { kind == .boundary }

    /// True when this endpoint sits on the box with `id`.
    public func isOnBox(_ id: String) -> Bool { kind == .box && jsStrictEquals(boxId, id) }
}

public struct Box: Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var number: Int
    public var conceptId: String?
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double
    public var childDiagramId: String?
    public var note: String
    public var refs: String
    /// When this box last changed — an ISO-8601 instant, nil when the file
    /// records none. Never invented.
    public var updatedAt: String?
    /// When this box was removed: a tombstone, kept rather than dropped.
    public var deletedAt: String?
    /// Members of the box this app does not model (an IRI, a cost), kept
    /// in file order and written after the ones it does.
    public var extras: JSONObject

    public init(
        id: String, name: String, number: Int, conceptId: String? = nil,
        x: Double, y: Double, w: Double, h: Double,
        childDiagramId: String? = nil, note: String = "", refs: String = "",
        updatedAt: String? = nil, deletedAt: String? = nil, extras: JSONObject = JSONObject()
    ) {
        self.id = id; self.name = name; self.number = number; self.conceptId = conceptId
        self.x = x; self.y = y; self.w = w; self.h = h
        self.childDiagramId = childDiagramId; self.note = note; self.refs = refs
        self.updatedAt = updatedAt; self.deletedAt = deletedAt; self.extras = extras
    }

    public var rect: SheetRect { SheetRect(x: x, y: y, w: w, h: h) }
}

public struct Arrow: Identifiable, Hashable, Sendable {
    public var id: String
    public var label: String
    public var conceptId: String?
    public var from: Endpoint
    public var to: Endpoint
    /// Pinned position of the middle run, when the modeller has dragged it.
    public var bend: Double?
    /// Label offset from its default position.
    public var ldx: Double
    public var ldy: Double
    public var tunnelFrom: Bool
    public var tunnelTo: Bool
    public var note: String
    /// When this arrow last changed, and when it was removed — the same
    /// optional ISO-8601 clocks every element carries.
    public var updatedAt: String?
    public var deletedAt: String?
    /// Members of the arrow this app does not model, kept in file order. An
    /// endpoint's own unknown members are not kept, as in the web app.
    public var extras: JSONObject

    public init(
        id: String, label: String, conceptId: String? = nil, from: Endpoint, to: Endpoint,
        bend: Double? = nil, ldx: Double = 0, ldy: Double = 0,
        tunnelFrom: Bool = false, tunnelTo: Bool = false, note: String = "",
        updatedAt: String? = nil, deletedAt: String? = nil, extras: JSONObject = JSONObject()
    ) {
        self.id = id; self.label = label; self.conceptId = conceptId
        self.from = from; self.to = to; self.bend = bend; self.ldx = ldx; self.ldy = ldy
        self.tunnelFrom = tunnelFrom; self.tunnelTo = tunnelTo; self.note = note
        self.updatedAt = updatedAt; self.deletedAt = deletedAt; self.extras = extras
    }

    /// The endpoint named the way the web app names them: "from" or "to".
    public subscript(end: ArrowEnd) -> Endpoint {
        get { end == .from ? from : to }
        set { if end == .from { from = newValue } else { to = newValue } }
    }

    public func isTunnelled(_ end: ArrowEnd) -> Bool { end == .from ? tunnelFrom : tunnelTo }
}

public enum ArrowEnd: String, CaseIterable, Hashable, Sendable {
    case from, to
}

public struct Concept: Identifiable, Hashable, Sendable {
    public var id: String
    public var term: String
    /// Kept as written, so a kind this app does not know survives a round-trip.
    public var kind: String
    public var definition: String
    /// The concepts this one bundles (FIPS 183 §3.2.2.3), by id, in order —
    /// empty for a plain concept. Written to the file only when non-empty;
    /// the web app's `members`, absent when there are none.
    public var members: [String]
    /// When this entry last changed, and when it was removed — the same
    /// optional ISO-8601 clocks every element carries.
    public var updatedAt: String?
    public var deletedAt: String?
    /// Members of the glossary entry this app does not model, kept in file order.
    public var extras: JSONObject

    public init(id: String, term: String, kind: String, definition: String = "", members: [String] = [],
                updatedAt: String? = nil, deletedAt: String? = nil, extras: JSONObject = JSONObject()) {
        self.id = id; self.term = term; self.kind = kind; self.definition = definition; self.members = members
        self.updatedAt = updatedAt; self.deletedAt = deletedAt; self.extras = extras
    }

    public var knownKind: ConceptKind? { ConceptKind(rawValue: kind) }

    /// `isBundle(c)` — a concept that lists at least one member.
    public var isBundle: Bool { !members.isEmpty }
}

public struct Diagram: Identifiable, Hashable, Sendable {
    public var id: String
    public var node: String
    public var title: String
    /// Set once somebody titles the diagram themselves; until then it follows
    /// the name of the box it details.
    public var titleLocked: Bool
    public var parentBoxId: String?
    public var cNumber: String
    public var notes: [JSONValue]
    public var boxes: [Box]
    public var arrows: [Arrow]
    /// When this diagram last changed, and when it was removed — the same
    /// optional ISO-8601 clocks every element carries.
    public var updatedAt: String?
    public var deletedAt: String?
    /// Members of the diagram this app does not model, kept in file order.
    public var extras: JSONObject

    public init(
        id: String, node: String, title: String, titleLocked: Bool = false, parentBoxId: String? = nil,
        cNumber: String = "", notes: [JSONValue] = [], boxes: [Box] = [], arrows: [Arrow] = [],
        updatedAt: String? = nil, deletedAt: String? = nil, extras: JSONObject = JSONObject()
    ) {
        self.id = id; self.node = node; self.title = title; self.titleLocked = titleLocked
        self.parentBoxId = parentBoxId; self.cNumber = cNumber; self.notes = notes
        self.boxes = boxes; self.arrows = arrows
        self.updatedAt = updatedAt; self.deletedAt = deletedAt; self.extras = extras
    }
}

public struct IDEF0Model: Hashable, Sendable {
    public static let schema = "idef0-modeler/1"

    public var id: String
    public var title: String
    public var author: String
    public var project: String
    public var purpose: String
    public var viewpoint: String
    /// Kept as written; see `knownStatus`.
    public var status: String
    public var created: String
    public var revised: String
    public var glossary: [Concept]
    public var diagrams: OrderedMap<Diagram>
    public var rootDiagramId: String
    /// Top-level members this app does not model, kept in file order so a
    /// newer web app's additions survive being saved from the Mac.
    public var extras: JSONObject

    public init(
        id: String, title: String, author: String = "", project: String = "", purpose: String = "",
        viewpoint: String = "", status: String = ModelStatus.working.rawValue, created: String, revised: String,
        glossary: [Concept] = [], diagrams: OrderedMap<Diagram>, rootDiagramId: String, extras: JSONObject = JSONObject()
    ) {
        self.id = id; self.title = title; self.author = author; self.project = project
        self.purpose = purpose; self.viewpoint = viewpoint; self.status = status
        self.created = created; self.revised = revised; self.glossary = glossary
        self.diagrams = diagrams; self.rootDiagramId = rootDiagramId; self.extras = extras
    }

    public var knownStatus: ModelStatus? { ModelStatus(rawValue: status) }
}
