// The on-screen sheet theme (S03): a colour remap applied at draw time and
// nowhere else. Exports pass no theme and must paint exactly as they always
// have; the editor passes one and must paint no FIPS white or black at all.

import CoreGraphics
import Foundation
import ImageIO
import Testing
@testable import IDEF0Core
@testable import IDEF0Render

@Suite("Sheet theme")
struct SheetThemeTests {
    /// A theme whose every colour is unlike any the core uses, so a colour
    /// that slipped through unmapped is told apart from one that was mapped.
    static let hud = SheetTheme(
        sheet: RGBA(hex: 0x04080D), ink: RGBA(hex: 0xD6E6F0), box: RGBA(hex: 0x111C27),
        frameLabel: RGBA(hex: 0x8EA6B6), muted: RGBA(hex: 0x7A8C9A), placeholder: RGBA(hex: 0x56707F),
        icom: RGBA(hex: 0x3FB6FF), accent: RGBA(hex: 0x3FB6FF)
    )

    static let coreColours: [RGBA] = [.white, .ink, .frameLabel, .muted, .placeholder, .icom, .accent]

    /// Every colour an op paints with.
    static func colours(_ op: DrawOp) -> [RGBA] {
        switch op {
        case .rect(_, let fill, let stroke, _), .path(_, let fill, let stroke, _), .circle(_, _, let fill, let stroke, _):
            return [fill, stroke?.color].compactMap { $0 }
        case .line(_, _, let stroke, _):
            return [stroke.color]
        case .text(_, _, let style, _):
            return [style.color]
        }
    }

    /// The op with its colours struck out, so two ops can be compared on
    /// everything but their paint.
    static func unpainted(_ op: DrawOp) -> DrawOp {
        let blank = RGBA(0, 0, 0, 0)
        func s(_ st: StrokeStyle?) -> StrokeStyle? { st.map { StrokeStyle(color: blank, width: $0.width, dash: $0.dash, roundJoins: $0.roundJoins) } }
        switch op {
        case .rect(let r, let fill, let stroke, let role): return .rect(r, fill: fill.map { _ in blank }, stroke: s(stroke), role: role)
        case .line(let a, let b, let stroke, let role): return .line(from: a, to: b, stroke: s(stroke)!, role: role)
        case .path(let c, let fill, let stroke, let role): return .path(c, fill: fill.map { _ in blank }, stroke: s(stroke), role: role)
        case .circle(let c, let r, let fill, let stroke, let role): return .circle(center: c, radius: r, fill: fill.map { _ in blank }, stroke: s(stroke), role: role)
        case .text(let t, let at, var style, let role): style.color = blank; return .text(t, at: at, style: style, role: role)
        }
    }

    /// A diagram with a selection, ports, an unnamed box and a decomposed
    /// box: every colour the core paints with appears in its display list.
    static func everyColourOps() throws -> (IDEF0Model, String, [DrawOp]) {
        var m = try sampleModel()
        let a0 = try #require(m.diagrams.values.first { $0.node == "A0" })
        let plan = try #require(a0.boxes.first { $0.name == "Plan Production" })
        let decomposed = m.decomposeBox(diagramId: a0.id, boxId: plan.id, count: 3)
        let childId = try #require(decomposed)
        var child = try #require(m.diagrams[childId])
        child.boxes[0].name = ""
        m.diagrams[childId] = child
        let ops = SheetDrawing.build(m, diagramId: childId, options: DrawingOptions(selectedBoxId: child.boxes[1].id))
        let used = Set(ops.flatMap(colours))
        for c in coreColours {
            #expect(used.contains(c), "the fixture must paint with \(c.hexString) for the remap to be exercised")
        }
        return (m, childId, ops)
    }

    @Test("A themed display list paints with no colour of the core's — every one is mapped, by value, and the box fill by role")
    func everyColourIsMapped() throws {
        let (_, _, ops) = try Self.everyColourOps()
        let themed = Self.hud.apply(ops)
        #expect(themed.count == ops.count)
        let used = Set(themed.flatMap(Self.colours))
        for c in Self.coreColours {
            #expect(!used.contains(c), "\(c.hexString) survived the remap")
        }
        // The geometry, text and roles are untouched.
        #expect(themed.map(Self.unpainted) == ops.map(Self.unpainted))

        for (before, after) in zip(ops, themed) {
            switch (before, after) {
            case (.rect(_, let fill, _, let role), .rect(_, let themedFill, _, _)):
                // The box's fill takes `box`; every other white takes `sheet`.
                if case .box = role, fill == .white {
                    #expect(themedFill == Self.hud.box)
                } else if fill == .white {
                    #expect(themedFill == Self.hud.sheet)
                } else if fill == .ink {
                    #expect(themedFill == Self.hud.ink, "a status mark that is on, or the current box in the context thumb")
                }
            case (.text(_, _, let style, _), .text(_, _, let themedStyle, _)):
                switch style.color {
                case .ink: #expect(themedStyle.color == Self.hud.ink)
                case .frameLabel: #expect(themedStyle.color == Self.hud.frameLabel)
                case .muted: #expect(themedStyle.color == Self.hud.muted)
                case .placeholder: #expect(themedStyle.color == Self.hud.placeholder)
                case .icom: #expect(themedStyle.color == Self.hud.icom)
                case .accent: #expect(themedStyle.color == Self.hud.accent)
                default: Issue.record("unexpected text colour \(style.color.hexString)")
                }
            case (.circle(_, _, let fill, let stroke, _), .circle(_, _, let themedFill, let themedStroke, _)):
                // A port's open ring: the sheet inside, ink round it.
                #expect(fill == .white && themedFill == Self.hud.sheet)
                #expect(stroke?.color == .ink && themedStroke?.color == Self.hud.ink)
            default:
                break
            }
        }
        // The selection takes the accent; a port's ICOM code the icom colour.
        let selected = themed.compactMap { op -> RGBA? in
            if case .rect(_, _, let stroke, let role) = op, case .box = role, stroke?.width == 2.6 { return stroke?.color }
            return nil
        }
        #expect(selected == [Self.hud.accent])
        let codes = themed.compactMap { op -> RGBA? in
            if case .text(let s, _, let style, let role) = op, case .port = role, s == "I1" { return style.color }
            return nil
        }
        #expect(codes == [Self.hud.icom])
    }

    @Test("The plain theme is the identity, and a colour the core does not use passes through")
    func plainIsIdentity() throws {
        let (_, _, ops) = try Self.everyColourOps()
        #expect(SheetTheme.plain.apply(ops) == ops)
        let odd = RGBA(hex: 0x123456)
        #expect(Self.hud.map(odd) == odd)
    }

    /// The pixel of a rendered sheet at a sheet point, as premultiplied RGBA bytes.
    static func pixel(_ image: CGImage, _ x: Double, _ y: Double, scale: Double) -> [UInt8] {
        let w = image.width, h = image.height
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = CGContext(data: &bytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        let px = Int(x * scale), py = Int(y * scale)
        let i = (py * w + px) * 4
        return Array(bytes[i..<i + 3])
    }

    static func bytes(_ c: RGBA) -> [UInt8] { [c.r, c.g, c.b].map { UInt8(($0 * 255).rounded()) } }

    /// Draw the ops as `SheetExport.image` does, with or without a theme.
    static func render(_ ops: [DrawOp], theme: SheetTheme?, scale: Double = 2) throws -> CGImage {
        let w = Int(Sheet.size.w * scale), h = Int(Sheet.size.h * scale)
        let ctx = try #require(CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                         space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                         bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        ctx.interpolationQuality = .high
        ctx.setShouldAntialias(true)
        SheetRenderer.withSheetSpace(ctx, height: CGFloat(h), scale: CGFloat(scale)) {
            SheetRenderer.draw(ops, in: ctx, theme: theme)
        }
        return try #require(ctx.makeImage())
    }

    @Test("Themed, the sheet background and a box interior are the theme's colours; unthemed, both are white and the bytes are the export's")
    func themedPixels() throws {
        let (m, childId, ops) = try Self.everyColourOps()
        let child = try #require(m.diagrams[childId])
        let box = child.boxes[2]
        // A point of the sheet outside the frame, and one inside a box's
        // fill clear of its name and number.
        let sheetPoint = (x: 4.0, y: 4.0)
        let boxPoint = (x: box.x + 6, y: box.y + 6)

        let plain = try Self.render(ops, theme: nil)
        #expect(Self.pixel(plain, sheetPoint.x, sheetPoint.y, scale: 2) == [255, 255, 255])
        #expect(Self.pixel(plain, boxPoint.x, boxPoint.y, scale: 2) == [255, 255, 255])

        let themed = try Self.render(ops, theme: Self.hud)
        #expect(Self.pixel(themed, sheetPoint.x, sheetPoint.y, scale: 2) == Self.bytes(Self.hud.sheet))
        #expect(Self.pixel(themed, boxPoint.x, boxPoint.y, scale: 2) == Self.bytes(Self.hud.box))

        // The export path never sees a theme: its bytes are the unthemed
        // drawing's, byte for byte.
        let exported = try SheetExport.png(m, diagramId: childId, scale: 2, options: DrawingOptions(selectedBoxId: child.boxes[1].id))
        let data = NSMutableData()
        let dest = try #require(CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(dest, plain, nil)
        #expect(CGImageDestinationFinalize(dest))
        #expect(exported == data as Data)
    }

    @Test("A label's halo is painted in the theme's sheet colour, not white, so the label reads over a dark sheet")
    func haloTakesTheSheetColour() throws {
        // A label with a wide halo over an ink-filled sheet, so the halo is
        // the only thing that can show at the probe: 3 units below the
        // baseline under the middle of "HHHH" — inside the 12-unit halo's
        // 6-unit reach, where no glyph of a cap-height letter sits.
        let at = Point(x: 300, y: 300)
        let ops: [DrawOp] = [
            .rect(SheetRect(x: 0, y: 0, w: Sheet.size.w, h: Sheet.size.h), fill: .ink, stroke: nil, role: .sheet),
            .text("HHHH", at: at, style: TextStyle(size: 10.5, color: .ink, halo: 12), role: .arrowLabel("x")),
        ]
        let probe = (x: at.x + 10, y: at.y + 3)
        let away = (x: at.x - 40, y: at.y - 40)
        let plain = try Self.render(ops, theme: nil, scale: 4)
        #expect(Self.pixel(plain, probe.x, probe.y, scale: 4) == [255, 255, 255], "unthemed, the halo is white")
        // Unthemed colours are made in CoreGraphics' generic RGB, as every
        // export always has, so the ink lands a few steps off its sRGB hex.
        #expect(Self.pixel(plain, away.x, away.y, scale: 4).allSatisfy { $0 < 40 }, "the ink background")
        let themed = try Self.render(ops, theme: Self.hud, scale: 4)
        #expect(Self.pixel(themed, probe.x, probe.y, scale: 4) == Self.bytes(Self.hud.sheet), "themed, the halo is the sheet's colour")
        #expect(Self.pixel(themed, away.x, away.y, scale: 4) == Self.bytes(Self.hud.ink))
    }
}
