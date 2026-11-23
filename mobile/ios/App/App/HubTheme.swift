import SwiftUI
import UIKit

/// HUB's look, following Apple's Liquid Glass guidance: content sits on a deep,
/// softly lit backdrop in plain cards, and only the floating controls above it
/// (top buttons, composer, side panels, call bar) are glass. On iOS 26 and
/// later these use the system Liquid Glass; earlier systems get a material.
enum HubTheme {
    static let cardRadius: CGFloat = 26
    static let controlRadius: CGFloat = 22
}

extension View {
    /// Liquid Glass in `shape`, or a translucent material before iOS 26.
    @ViewBuilder func hubGlass<S: Shape>(_ shape: S, interactive: Bool = false, tint: Color? = nil) -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(Self.hubGlassValue(interactive: interactive, tint: tint), in: shape)
        } else {
            self.background {
                ZStack {
                    shape.fill(.ultraThinMaterial)
                    if let tint { shape.fill(tint.opacity(0.22)) }
                }
            }
            .overlay(shape.stroke(LinearGradient(colors: [HubWorkspacePalette.border.opacity(0.22), HubWorkspacePalette.border.opacity(0.05)],
                                                 startPoint: .top, endPoint: .bottom), lineWidth: 0.6))
        }
    }

    @available(iOS 26.0, *)
    private static func hubGlassValue(interactive: Bool, tint: Color?) -> Glass {
        var glass = Glass.regular
        if let tint { glass = glass.tint(tint.opacity(0.55)) }
        if interactive { glass = glass.interactive() }
        return glass
    }

    /// A round glass control, like the system's toolbar buttons.
    func hubGlassCircle(interactive: Bool = true) -> some View {
        hubGlass(Circle(), interactive: interactive)
    }

    /// The system glass button styles, or a material capsule before iOS 26.
    @ViewBuilder func hubGlassButton(prominent: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            if prominent { buttonStyle(.glassProminent) } else { buttonStyle(.glass) }
        } else {
            buttonStyle(HubFallbackGlassButtonStyle(prominent: prominent))
        }
    }

    /// A content card: an opaque-enough surface for reading, a hairline edge
    /// lit from above, and a little of the backdrop's color showing through.
    func hubCard(cornerRadius: CGFloat = HubTheme.cardRadius, padding: CGFloat = 16) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        return self
            .padding(padding)
            .background(shape.fill(HubWorkspacePalette.card))
            .overlay(shape.strokeBorder(LinearGradient(colors: [HubWorkspacePalette.border.opacity(0.14), HubWorkspacePalette.border.opacity(0.03)],
                                                       startPoint: .top, endPoint: .bottom), lineWidth: 0.7))
    }

    /// A see-through card for Home: frosted glass over the knowledge graph,
    /// tinted just enough to read on, with the same lit hairline edge.
    func hubGlassCard(cornerRadius: CGFloat = HubTheme.cardRadius, padding: CGFloat = 16) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        return self
            .padding(padding)
            .background(shape.fill(HubWorkspacePalette.card.opacity(0.34)))
            .background(shape.fill(.ultraThinMaterial))
            .overlay(shape.strokeBorder(LinearGradient(colors: [HubWorkspacePalette.border.opacity(0.22), HubWorkspacePalette.border.opacity(0.05)],
                                                       startPoint: .top, endPoint: .bottom), lineWidth: 0.8))
    }

    /// Strikes through finished items (iOS 16+; earlier systems just dim them).
    @ViewBuilder func hubStrikethrough(_ active: Bool) -> some View {
        if #available(iOS 16.0, *) { strikethrough(active) } else { opacity(active ? 0.6 : 1) }
    }

    /// Ends a long modifier chain's nested type here. SwiftUI resolves such a
    /// type in one deep recursion on the main thread, which has only 1 MB on an
    /// iPhone; very long chains overflow it at launch.
    func erased() -> AnyView { AnyView(self) }

    /// The deep backdrop every HUB screen sits on.
    func hubBackdrop() -> some View {
        background(HubBackdrop().ignoresSafeArea())
    }
}

/// Groups glass shapes so they blend and morph together (iOS 26+).
struct HubGlassGroup<Content: View>: View {
    var spacing: CGFloat = 12
    @ViewBuilder var content: () -> Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { content() }
        } else {
            content()
        }
    }
}

struct HubFallbackGlassButtonStyle: ButtonStyle {
    var prominent = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(prominent ? HubWorkspacePalette.onAccent : Color.primary)
            .padding(.horizontal, 16)
            .frame(minHeight: 44)
            .background {
                if prominent { Capsule().fill(HubWorkspacePalette.accent) }
                else { Capsule().fill(.ultraThinMaterial) }
            }
            .overlay(Capsule().stroke(HubWorkspacePalette.border.opacity(prominent ? 0 : 0.14), lineWidth: 0.6))
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

/// How lively the backdrop is: 0 at rest, 1 while the user types or HUB is
/// working. Screens set it; the backdrop eases between the two.
private struct HubBackdropEnergyKey: EnvironmentKey { static let defaultValue: Double = 0 }
/// A screen shown over Home (a chat) reports its energy up to Home's backdrop.
struct HubBackdropEnergyPreference: PreferenceKey {
    static let defaultValue: Double = 0
    static func reduce(value: inout Double, nextValue: () -> Double) { value = max(value, nextValue()) }
}

extension EnvironmentValues {
    var hubBackdropEnergy: Double {
        get { self[HubBackdropEnergyKey.self] }
        set { self[HubBackdropEnergyKey.self] = newValue }
    }
}

/// The backdrop behind every screen: one solid color (plain or tinted with
/// the accent), or with a soft accent glow, as chosen on the Theme page.
struct HubBackdrop: View {
    @ObservedObject private var theme = HubThemeStore.shared

    var body: some View {
        ZStack {
            Color(uiColor: HubWorkspacePalette.background)
            if theme.choice.background == .glow {
                let accent = Color(uiColor: HubWorkspacePalette.accentUIColor)
                RadialGradient(colors: [accent.opacity(0.10 + theme.choice.strength * 0.26), .clear], center: .topLeading, startRadius: 20, endRadius: 560)
                RadialGradient(colors: [accent.opacity(0.06 + theme.choice.strength * 0.18), .clear], center: .bottomTrailing, startRadius: 20, endRadius: 500)
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

// MARK: - The user's theme

/// Everything the Theme page sets, kept on the phone.
struct HubThemeChoice: Codable, Hashable {
    enum Accent: String, Codable, CaseIterable { case indigo, blue, teal, green, orange, pink, purple, red, graphite, custom }
    enum Background: String, Codable, CaseIterable { case plain, tinted, glow }
    enum ChatTone: String, Codable, CaseIterable { case soft, app, paper }
    enum Bubble: String, Codable, CaseIterable { case accent, neutral }
    enum FontStyle: String, Codable, CaseIterable { case standard, rounded, serif }

    var accent: Accent = .indigo
    var customAccent: UInt32 = 0x3D4FD6
    var background: Background = .plain
    var strength: Double = 0.5
    var chatTone: ChatTone = .soft
    var bubble: Bubble = .accent
    var font: FontStyle = .standard

    init() {}
    init(from decoder: Decoder) throws {
        let v = try decoder.container(keyedBy: CodingKeys.self)
        accent = (try? v.decode(Accent.self, forKey: .accent)) ?? .indigo
        customAccent = (try? v.decode(UInt32.self, forKey: .customAccent)) ?? 0x3D4FD6
        background = (try? v.decode(Background.self, forKey: .background)) ?? .plain
        strength = min(1, max(0, (try? v.decode(Double.self, forKey: .strength)) ?? 0.5))
        chatTone = (try? v.decode(ChatTone.self, forKey: .chatTone)) ?? .soft
        bubble = (try? v.decode(Bubble.self, forKey: .bubble)) ?? .accent
        font = (try? v.decode(FontStyle.self, forKey: .font)) ?? .standard
    }

    /// Light and dark shades of each accent.
    static func shades(_ accent: Accent, custom: UInt32) -> (light: UInt32, dark: UInt32) {
        switch accent {
        case .indigo: return (0x3D4FD6, 0xA3B1FF)
        case .blue: return (0x0A6CFF, 0x6AAEFF)
        case .teal: return (0x0E8A8A, 0x5ED6CC)
        case .green: return (0x2E8B57, 0x6EDBA4)
        case .orange: return (0xD9730D, 0xFFB05C)
        case .pink: return (0xD6336C, 0xFF94B8)
        case .purple: return (0x7B3FE4, 0xC09CFF)
        case .red: return (0xD64545, 0xFF8585)
        case .graphite: return (0x4A5568, 0xB4BECC)
        case .custom: return (custom, custom)
        }
    }
}

/// The current theme for colors resolved anywhere (also by dynamic UIColors).
enum HubThemeSettings {
    private static let key = "hub.theme.choice"
    private(set) static var current: HubThemeChoice = {
        guard let data = UserDefaults.standard.data(forKey: key), let value = try? JSONDecoder().decode(HubThemeChoice.self, from: data) else { return HubThemeChoice() }
        return value
    }()

    static func set(_ value: HubThemeChoice) {
        current = value
        if let data = try? JSONEncoder().encode(value) { UserDefaults.standard.set(data, forKey: key) }
    }

    static func rgb(_ hex: UInt32, alpha: CGFloat = 1) -> UIColor {
        UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }

    static func accent(dark: Bool) -> UIColor {
        let shades = HubThemeChoice.shades(current.accent, custom: current.customAccent)
        return rgb(dark ? shades.dark : shades.light)
    }

    /// Black or white, whichever reads better on the accent.
    static func onAccent(dark: Bool) -> UIColor {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        accent(dark: dark).getRed(&r, green: &g, blue: &b, alpha: &a)
        return 0.299 * r + 0.587 * g + 0.114 * b > 0.6 ? UIColor(white: 0.05, alpha: 1) : .white
    }

    /// The app background: plain, or tinted with the accent by the chosen strength.
    static func background(dark: Bool, base: UInt32) -> UIColor {
        let plain = rgb(base)
        guard current.background == .tinted else { return plain }
        return blend(plain, accent(dark: dark), amount: (dark ? 0.06 : 0.05) + current.strength * (dark ? 0.16 : 0.12))
    }

    static func blend(_ a: UIColor, _ b: UIColor, amount: CGFloat) -> UIColor {
        var ar: CGFloat = 0, ag: CGFloat = 0, ab: CGFloat = 0, aa: CGFloat = 0, br: CGFloat = 0, bg: CGFloat = 0, bb: CGFloat = 0, ba: CGFloat = 0
        a.getRed(&ar, green: &ag, blue: &ab, alpha: &aa); b.getRed(&br, green: &bg, blue: &bb, alpha: &ba)
        return UIColor(red: ar + (br - ar) * amount, green: ag + (bg - ag) * amount, blue: ab + (bb - ab) * amount, alpha: aa)
    }

    /// A fresh tint so UIKit windows pick up a changed accent.
    static func windowTint() -> UIColor { UIColor { traits in accent(dark: traits.userInterfaceStyle == .dark) } }
}

/// Publishes theme changes so screens redraw at once.
@MainActor
final class HubThemeStore: ObservableObject {
    static let shared = HubThemeStore()
    @Published private(set) var choice = HubThemeSettings.current

    func update(_ change: (inout HubThemeChoice) -> Void) {
        var value = choice
        change(&value)
        guard value != choice else { return }
        HubThemeSettings.set(value)
        choice = value
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
            for window in scene.windows { window.tintColor = HubThemeSettings.windowTint() }
        }
    }

    func reset() { update { $0 = HubThemeChoice() } }
}

extension View {
    /// The chosen font style for the whole app (iOS 16.1+).
    @ViewBuilder func hubThemeFont(_ style: HubThemeChoice.FontStyle) -> some View {
        if #available(iOS 16.1, *) {
            fontDesign(style == .rounded ? .rounded : style == .serif ? .serif : .default)
        } else { self }
    }
}


// MARK: - Pages

/// Every page in HUB opens the same way: it slides in from the right with a
/// back button and an edge swipe back (iOS 16 and later). A page shown as a
/// sheet elsewhere still gets its own navigation bar.
struct HubNavigation<Content: View>: View {
    var pushed = false
    @ViewBuilder var content: () -> Content

    var body: some View {
        if pushed {
            content()
        } else if #available(iOS 16.0, *) {
            NavigationStack { content() }
        } else {
            NavigationView { content() }.navigationViewStyle(.stack)
        }
    }
}

/// The navigation stack under Home and every chat; its own bar stays hidden.
struct HubNavigationRoot<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        if #available(iOS 16.0, *) {
            NavigationStack { content().toolbar(.hidden, for: .navigationBar) }
        } else {
            content()
        }
    }
}

private struct HubItemPage<Item: Identifiable, Page: View>: ViewModifier {
    @Binding var item: Item?
    let page: (Item, Bool) -> Page
    /// Kept while the page slides away after `item` is cleared.
    @State private var shown: Item?

    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 16.0, *) {
            content
                .navigationDestination(isPresented: Binding(get: { item != nil }, set: { if !$0 { item = nil } })) {
                    if let value = item ?? shown { page(value, true) }
                }
                .onAppear { if item != nil { shown = item } }
                .onChange(of: item?.id) { _ in if let item { shown = item } }
        } else {
            content.sheet(item: $item) { page($0, false) }
        }
    }
}

extension View {
    /// Opens `page` as a page that slides in from the right. `pushed` tells the
    /// page whether it is inside the navigation stack (so it needs no bar or
    /// Done button of its own).
    @ViewBuilder
    func hubPage<Page: View>(isPresented: Binding<Bool>, @ViewBuilder page: @escaping (_ pushed: Bool) -> Page) -> some View {
        if #available(iOS 16.0, *) {
            navigationDestination(isPresented: isPresented) { page(true) }
        } else {
            sheet(isPresented: isPresented) { page(false) }
        }
    }

    func hubPage<Item: Identifiable, Page: View>(item: Binding<Item?>, @ViewBuilder page: @escaping (_ item: Item, _ pushed: Bool) -> Page) -> some View {
        modifier(HubItemPage(item: item, page: page))
    }
}