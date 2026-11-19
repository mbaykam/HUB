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

/// A dark, quiet backdrop with one slow wash of color across the whole screen,
/// like light through frosted glass: warm amber and dusky rose drifting above,
/// deep teal and slate blue below. Large soft blobs move on slow,
/// out-of-phase paths so it never looks like fixed corner glows. It quickens
/// and brightens a little while the user types or HUB works, and holds still
/// with Reduce Motion or when the app is in the background.
struct HubBackdrop: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.hubBackdropEnergy) private var energy
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Color(uiColor: HubWorkspacePalette.background)
            TimelineView(.animation(minimumInterval: 1.0 / 15, paused: reduceMotion || scenePhase != .active)) { context in
                HubAuroraWash(time: context.date.timeIntervalSinceReferenceDate, energy: energy, dark: scheme == .dark)
            }
            .animation(.easeInOut(duration: 1.6), value: energy)
            // A gentle darkening at the top and bottom keeps text and bars calm.
            LinearGradient(colors: [Color(uiColor: HubWorkspacePalette.background).opacity(scheme == .dark ? 0.55 : 0.35), .clear,
                                    .clear, Color(uiColor: HubWorkspacePalette.background).opacity(scheme == .dark ? 0.6 : 0.4)],
                           startPoint: .top, endPoint: .bottom)
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

/// Four large, very soft color fields drawn as radial gradients. Each spans
/// most of the screen, so together they read as one continuous wash.
struct HubAuroraWash: View {
    let time: Double
    let energy: Double
    let dark: Bool

    private struct Field {
        let hue: Double, saturation: Double, brightness: Double
        let x: Double, y: Double, size: Double
        let phase: Double, drift: Double
    }

    private static let fields: [Field] = [
        Field(hue: 0.06, saturation: 0.62, brightness: 0.85, x: 0.55, y: 0.22, size: 1.05, phase: 0.0, drift: 0.16),  // amber
        Field(hue: 0.97, saturation: 0.45, brightness: 0.70, x: 0.25, y: 0.38, size: 0.85, phase: 2.1, drift: 0.14),  // dusky rose
        Field(hue: 0.50, saturation: 0.55, brightness: 0.60, x: 0.20, y: 0.78, size: 1.10, phase: 4.0, drift: 0.15),  // deep teal
        Field(hue: 0.60, saturation: 0.45, brightness: 0.65, x: 0.80, y: 0.70, size: 0.95, phase: 5.3, drift: 0.13),  // slate blue
    ]

    var body: some View {
        Canvas { context, size in
            let speed = 0.045 + energy * 0.06
            let strength = (dark ? 0.34 : 0.22) + energy * 0.08
            let span = max(size.width, size.height)
            for field in Self.fields {
                let t = time * speed + field.phase
                // Slow Lissajous paths and a gentle breathing size.
                let center = CGPoint(x: (field.x + field.drift * sin(t)) * size.width,
                                     y: (field.y + field.drift * 0.8 * sin(t * 0.73 + 1.3)) * size.height)
                let radius = span * field.size * (0.85 + 0.12 * sin(t * 0.61 + field.phase)) / 2
                let color = Color(hue: field.hue, saturation: field.saturation, brightness: field.brightness)
                let rect = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
                context.fill(Path(ellipseIn: rect), with: .radialGradient(
                    Gradient(stops: [
                        .init(color: color.opacity(strength), location: 0),
                        .init(color: color.opacity(strength * 0.45), location: 0.45),
                        .init(color: color.opacity(0), location: 1),
                    ]),
                    center: center, startRadius: 0, endRadius: radius))
            }
        }
    }
}
