// The Mac app in the web app's palette (S03): the palette's tokens reach the
// sheet as the web's adapter maps them, and the canvas paints in them —
// desk, sheet and box — following the palette as it changes.

import AppKit
import Testing
@testable import IDEF0Core
@testable import IDEF0Modeler
@testable import IDEF0Render

@Suite("Theme")
struct ThemeTests {
    @Test("Each palette's sheet theme is the web adapter's token mapping, hex for hex with ui-kit/css/tokens.css")
    func sheetThemeMatchesTokens() {
        // --sheet: sunken · --sheet-ink: text · --box: panel-2 · --ink-soft: text-2 · accent
        let expected: [SCRace: (sheet: String, ink: String, box: String, soft: String, faint: String, accent: String)] = [
            .steel: ("#04080d", "#d6e6f0", "#111c27", "#8ea6b6", "#56707f", "#3fb6ff"),
            .crystal: ("#030713", "#dfe9ff", "#0f1a33", "#94a6c8", "#5a6c90", "#35e0ff"),
            .chitin: ("#070309", "#f0e0f2", "#1e1024", "#b596ba", "#7a5d80", "#c05bff"),
        ]
        for race in SCRace.allCases {
            let t = race.palette.sheetTheme
            let e = expected[race]!
            #expect(t.sheet.hexString == e.sheet, "\(race): sheet")
            #expect(t.ink.hexString == e.ink, "\(race): ink")
            #expect(t.box.hexString == e.box, "\(race): box")
            #expect(t.frameLabel.hexString == e.soft && t.muted.hexString == e.soft, "\(race): --ink-soft")
            #expect(t.placeholder.hexString == e.faint, "\(race): placeholder")
            #expect(t.icom.hexString == e.accent && t.accent.hexString == e.accent, "\(race): accent")
            // None of them is a colour the core paints with, so the remap
            // replaces every one on screen.
            for c in [t.sheet, t.ink, t.box, t.frameLabel, t.muted, t.placeholder, t.icom, t.accent] {
                #expect(![RGBA.white, .ink, .frameLabel, .muted, .placeholder, .icom, .accent].contains(c))
            }
        }
    }

    @Test("The status colours the chrome uses for errors and warnings are the kit's")
    func statusColours() {
        #expect(SCPalette.rgba(SCStatus.danger).hexString == "#ff4d5e")
        #expect(SCPalette.rgba(SCStatus.warning).hexString == "#ffb020")
    }
}

@MainActor
@Suite("Themed canvas", .serialized)
struct ThemedCanvasTests {
    /// The canvas drawn offscreen, read back as bytes at a view point. The
    /// rep is in the display's own space, so a colour comes back within a
    /// step or two of the sRGB value it was painted with (`near`).
    func pixel(_ canvas: SheetCanvasView, at p: CGPoint) throws -> [UInt8] {
        let rep = try #require(canvas.bitmapImageRepForCachingDisplay(in: canvas.bounds))
        canvas.cacheDisplay(in: canvas.bounds, to: rep)
        // The rep is at the backing scale; sample in its own pixels.
        let sx = Double(rep.pixelsWide) / Double(canvas.bounds.width)
        let sy = Double(rep.pixelsHigh) / Double(canvas.bounds.height)
        let c = try #require(rep.colorAt(x: Int(Double(p.x) * sx), y: Int(Double(p.y) * sy)))
        return [c.redComponent, c.greenComponent, c.blueComponent].map { UInt8(($0 * 255).rounded()) }
    }

    func near(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        zip(a, b).allSatisfy { abs(Int($0) - Int($1)) <= 3 }
    }

    func bytes(_ c: RGBA) -> [UInt8] { [c.r, c.g, c.b].map { UInt8(($0 * 255).rounded()) } }

    @Test("The canvas paints the desk, the sheet and a box in the palette, and follows a change of palette")
    func canvasPaintsThePalette() throws {
        let h = CanvasHarness(model: decomposedSample(), diagramNode: "A0")
        let canvas = h.canvas
        #expect(canvas.race == .steel)
        let box = h.diagram.boxes[1]
        // A desk point outside the sheet, a sheet point outside the frame,
        // and a box interior clear of its name and number.
        let desk = CGPoint(x: 2, y: 2)
        let sheet = canvas.viewPoint(Point(x: 4, y: 4))
        let inside = canvas.viewPoint(Point(x: box.x + 6, y: box.y + 6))
        #expect(canvas.viewPoint(Point(x: 0, y: 0)).x > 10, "the fitted sheet leaves desk around it")

        for race in SCRace.allCases {
            canvas.race = race
            let t = race.palette.sheetTheme
            let deskPx = try pixel(canvas, at: desk)
            let sheetPx = try pixel(canvas, at: sheet)
            let boxPx = try pixel(canvas, at: inside)
            #expect(near(deskPx, bytes(SCPalette.rgba(race.palette.bg))), "\(race): desk \(deskPx)")
            #expect(near(sheetPx, bytes(t.sheet)), "\(race): sheet \(sheetPx)")
            #expect(near(boxPx, bytes(t.box)), "\(race): box \(boxPx)")
            // Nothing on screen is the export's white.
            #expect(!near(sheetPx, [255, 255, 255]) && !near(boxPx, [255, 255, 255]))
        }
    }

    @Test("The inline field is styled in the palette: the palette's text on the sunken surface, an accent border")
    func inlineFieldInPalette() throws {
        let h = CanvasHarness(model: decomposedSample(), diagramNode: "A0")
        h.canvas.race = .chitin
        let box = h.diagram.boxes[0]
        h.canvas.beginTextEdit(.boxName(box.id))
        let field = try #require(h.canvas.textField)
        let colors = h.canvas.colors
        #expect(field.textColor == colors.text)
        #expect(field.backgroundColor == colors.sunken)
        #expect(field.layer?.borderWidth == 2)
        #expect(field.layer?.borderColor.map { NSColor(cgColor: $0) == colors.accent } == true)
        // A change of palette restyles the field that is open.
        h.canvas.race = .steel
        #expect(field.textColor == h.canvas.colors.text)
        #expect(field.backgroundColor == h.canvas.colors.sunken)
        h.canvas.commitTextEdit()
    }
}
