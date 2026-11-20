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

/// A plain, modern dark backdrop: one solid color behind every screen, no
/// glows or moving color. Cards and glass controls sit on it.
struct HubBackdrop: View {
    var body: some View {
        Color(uiColor: HubWorkspacePalette.background)
            .ignoresSafeArea()
            .accessibilityHidden(true)
    }
}