// The web app's HUD look, on the Mac (S03).
//
// The web app is themed end to end by the shared ui-kit: dark chrome in the
// palette the user picked, a dark sheet whose boxes sit a step lighter, light
// ink, the accent on ICOM codes and the selection, Orbitron for headings and
// buttons, Exo 2 for reading text and Share Tech Mono for codes. This file
// is the Mac side of that: the palette (`SCPalette`, generated from the same
// tokens as the web's CSS — never edited here, only extended) turned into the
// few things SwiftUI and the canvas need, and the handful of styles the
// chrome is built from. Nothing here reaches the drawing core, an export or
// the CLI: the sheet is themed by `SheetTheme`, a colour remap applied on
// screen alone.

import AppKit
import IDEF0Core
import IDEF0Render
import SwiftUI

// MARK: - Palette → colours

extension SCPalette {
    /// A SwiftUI colour as the core's RGBA — the palette's `Color(red:green:blue:)`
    /// values are sRGB, so this is the same hex the web's tokens.css carries.
    static func rgba(_ color: Color) -> RGBA {
        guard let c = NSColor(color).usingColorSpace(.sRGB) else { return .ink }
        return RGBA(Double(c.redComponent), Double(c.greenComponent), Double(c.blueComponent), Double(c.alphaComponent))
    }

    /// The on-screen sheet in this palette — the web's `ui-kit/adapters/idef0.css`
    /// mapping, token for token: `--sheet` is the sunken surface, `--sheet-ink`
    /// the text colour, `--box` the second panel, `--ink-soft` (frame captions,
    /// node numbers, port stubs and labels) the secondary text, ICOM codes and
    /// the selection the accent. The "(unnamed)" placeholder, which the web
    /// paints in an unthemed grey, takes the tertiary text here.
    var sheetTheme: SheetTheme {
        SheetTheme(sheet: Self.rgba(sunken), ink: Self.rgba(text), box: Self.rgba(panel2),
                   frameLabel: Self.rgba(text2), muted: Self.rgba(text2), placeholder: Self.rgba(text3),
                   icom: Self.rgba(accent), accent: Self.rgba(accent))
    }

    /// The web's `--accent-soft`: the accent at 16 %, behind a hovered row.
    var accentSoft: Color { accent.opacity(0.16) }
    /// A selected row or the armed tool — the kit's `.on` state, accent at 25 %.
    var accentOn: Color { accent.opacity(0.25) }
}

/// The colours the canvas paints its chrome with — the desk around the
/// sheet, the handles, the ghost lines, the floating field — as AppKit
/// colours, read once per palette.
struct CanvasColors {
    let desk: NSColor
    let accent: NSColor
    let sheet: NSColor
    let text: NSColor
    let text3: NSColor
    let sunken: NSColor
    let line: NSColor
    let sheetTheme: SheetTheme

    init(_ palette: SCPalette) {
        desk = NSColor(palette.bg)
        accent = NSColor(palette.accent)
        sheet = NSColor(palette.sunken)
        text = NSColor(palette.text)
        text3 = NSColor(palette.text3)
        sunken = NSColor(palette.sunken)
        line = NSColor(palette.lineStrong)
        sheetTheme = palette.sheetTheme
    }
}

// MARK: - Environment

/// The palette every view reads — set once at the window's root from the
/// user's choice in Settings (`ui-kit.race`), so changing it there rethemes
/// every open window at once.
struct PaletteKey: EnvironmentKey {
    static let defaultValue = SCPalette.steel
}

extension EnvironmentValues {
    var palette: SCPalette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}

// MARK: - Type

/// The kit's type scale, as the web uses it: display (Orbitron) uppercase and
/// tracked for headings, tabs and buttons; ui (Exo 2) for everything read;
/// mono (Share Tech Mono) for node numbers, codes and counts. The faces are
/// bundled with the app (see build-app.sh); where they are not registered —
/// `swift test` — `Font.custom` falls back to the system face.
enum HUDType {
    static let body = SCFont.ui(13)
    static let small = SCFont.ui(12)
    static let caption = SCFont.ui(11)
    static let mono = SCFont.mono(12)
    static let monoSmall = SCFont.mono(11)
    /// `.panel-tabs .tab` and `.btn` under the kit: 10.5–11 px display, tracked.
    static let button = SCFont.display(10.5, weight: .semibold)
    static let tab = SCFont.display(10.5, weight: .semibold)
    /// `h3.sect` / `.sc-label`: 11 px display, tracked wider.
    static let sectionTitle = SCFont.display(10, weight: .semibold)
    static let brand = SCFont.display(12, weight: .bold)
}

// MARK: - Shapes and styles

/// The kit's chamfer: a rectangle with its top-left and bottom-right corners
/// cut (`.sc-button`, `.btn` under the adapter) — clipped, never rounded.
struct Chamfer: Shape {
    var cut: CGFloat = 5

    func path(in r: CGRect) -> Path {
        let c = min(cut, r.width / 2, r.height / 2)
        var p = Path()
        p.move(to: CGPoint(x: r.minX + c, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - c))
        p.addLine(to: CGPoint(x: r.maxX - c, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX, y: r.minY + c))
        p.closeSubpath()
        return p
    }
}

/// The web's `.btn` as the adapter styles it: display face, uppercase,
/// tracked, a chamfered panel with a strong hairline; `on` is the armed tool
/// (`.btn.on`: accent at 25 % and an accent edge); a press fills with the
/// accent; disabled fades to 40 %.
struct HUDButtonStyle: ButtonStyle {
    var on = false
    var danger = false
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let edge = danger ? SCStatus.danger.opacity(0.7) : (on ? palette.accent : palette.lineStrong)
        let fill = configuration.isPressed ? palette.accent.opacity(0.22) : (on ? palette.accentOn : palette.panel2)
        configuration.label
            .font(HUDType.button)
            .tracking(1.1)
            .textCase(.uppercase)
            .lineLimit(1)
            .foregroundStyle(danger ? SCStatus.danger : (on ? Color.white : palette.text))
            .padding(.horizontal, 9)
            .frame(height: 24)
            .background(fill, in: Chamfer())
            .overlay(Chamfer().stroke(edge, lineWidth: 1))
            .opacity(isEnabled ? 1 : 0.4)
            .contentShape(Chamfer())
    }
}

extension ButtonStyle where Self == HUDButtonStyle {
    static var hud: HUDButtonStyle { HUDButtonStyle() }
    static func hud(on: Bool) -> HUDButtonStyle { HUDButtonStyle(on: on) }
}

/// A panel's tab strip — the web's `.panel-tabs`: flat, the active tab in
/// the accent with a 2 px accent rule beneath it, the rest secondary.
struct HUDTabs<Tab: Hashable>: View {
    let tabs: [(Tab, String)]
    @Binding var selection: Tab
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 0) {
            ForEach(tabs, id: \.0) { tab, title in
                let active = tab == selection
                Button { selection = tab } label: {
                    Text(title)
                        .font(HUDType.tab)
                        .tracking(1.4)
                        .textCase(.uppercase)
                        .lineLimit(1)
                        .foregroundStyle(active ? palette.accent : palette.text2)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .overlay(alignment: .bottom) {
                            Rectangle().fill(active ? palette.accent : .clear).frame(height: 2)
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .background(palette.panel)
        .overlay(alignment: .bottom) { Hairline() }
    }
}

/// A 1 px rule in the palette's line colour.
struct Hairline: View {
    var strong = false
    @Environment(\.palette) private var palette
    var body: some View { Rectangle().fill(strong ? palette.lineStrong : palette.line).frame(height: 1) }
}

/// A form section's heading — the web's `h3.sect`: small display caps,
/// tracked, tertiary, ruled beneath.
struct SectionTitle: View {
    let title: String
    @Environment(\.palette) private var palette

    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title)
            .font(HUDType.sectionTitle)
            .tracking(1.5)
            .textCase(.uppercase)
            .foregroundStyle(palette.text3)
    }
}

/// A note beneath a section — `.field` help text: small ui face, secondary.
struct SectionNote: View {
    let text: String
    var tone: Tone = .plain
    @Environment(\.palette) private var palette

    enum Tone { case plain, warning }

    init(_ text: String, tone: Tone = .plain) { self.text = text; self.tone = tone }

    var body: some View {
        Text(text)
            .font(HUDType.caption)
            .foregroundStyle(tone == .warning ? SCStatus.warning : palette.text2)
    }
}

extension View {
    /// A list or form drawn on the panel, not on the system's grouped or
    /// sidebar material: the web's `#left`/`#right` panels are one flat colour.
    func onPanel(_ palette: SCPalette) -> some View {
        scrollContentBackground(.hidden).background(palette.panel)
    }

    /// A list row that is the current one — the web's selected rows: accent at
    /// 25 % with an accent rule down the left edge.
    func hudRow(current: Bool, _ palette: SCPalette) -> some View {
        listRowBackground(
            ZStack(alignment: .leading) {
                (current ? palette.accentOn : Color.clear)
                if current { Rectangle().fill(palette.accent).frame(width: 3) }
            }
        )
    }
}
