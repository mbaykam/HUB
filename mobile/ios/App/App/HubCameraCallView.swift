import SwiftUI
import ARKit
import HubNative

/// The video call: the live camera with HUB's anchored overlays on top.
struct HubCameraCallView: View {
    @ObservedObject var vision: HubCameraVision
    let mute: () -> Void
    let endCall: () -> Void
    let close: () -> Void

    var body: some View {
        ZStack {
            Group {
                if vision.fixture { HubCameraFixtureScene() } else { HubARCameraView(vision: vision) }
            }
            .ignoresSafeArea()
            .accessibilityHidden(true)
            if vision.showMarks { HubSeenMarksLayer(marks: vision.marks).ignoresSafeArea() }
            HubCameraOverlayLayer(items: vision.overlays).ignoresSafeArea()
            if vision.fixture {
                GeometryReader { geometry in Color.clear.onAppear { vision.layoutFixture(size: geometry.size) } }
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
            }
            VStack(spacing: 10) {
                topBar
                if let note = vision.note { noteBanner(note) }
                Spacer()
                if let hint = vision.hint {
                    Label(hint, systemImage: "iphone.gen3.radiowaves.left.and.right")
                        .font(.footnote.weight(.medium))
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .hubGlass(Capsule())
                        .transition(.opacity)
                }
                controls
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .animation(.spring(response: 0.4, dampingFraction: 0.85), value: vision.note)
            .animation(.easeInOut(duration: 0.25), value: vision.hint)
        }
        .foregroundStyle(.white)
        .preferredColorScheme(.dark)
        .accessibilityIdentifier("hub.camera.call")
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Circle().fill(vision.paused ? Color.orange : Color.red).frame(width: 9, height: 9)
                    .shadow(color: (vision.paused ? Color.orange : Color.red).opacity(0.8), radius: 4)
                VStack(alignment: .leading, spacing: 1) {
                    Text(vision.paused ? "Camera paused" : "Video call").font(.subheadline.weight(.semibold))
                    Text(vision.voice.map { $0.muted ? "Muted" : $0.status } ?? vision.status)
                        .font(.caption2).foregroundStyle(.white.opacity(0.75)).lineLimit(1)
                }
            }
            .padding(.leading, 14).padding(.trailing, 16).padding(.vertical, 8)
            .hubGlass(Capsule())
            .accessibilityElement(children: .combine)
            Spacer(minLength: 8)
            Button(action: close) {
                Image(systemName: "chevron.down").font(.body.weight(.semibold))
                    .frame(width: 44, height: 44)
                    .hubGlassCircle()
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back to the chat")
            .accessibilityHint("Stops sharing the camera. The call continues.")
            .accessibilityIdentifier("hub.camera.close")
        }
        .padding(.top, 4)
    }

    private func noteBanner(_ note: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkles").font(.subheadline.weight(.semibold))
                .foregroundStyle(HubOverlayPalette.gradient(for: nil))
            Text(note).font(.subheadline.weight(.medium)).multilineTextAlignment(.leading).lineLimit(3)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .hubGlass(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .transition(.move(edge: .top).combined(with: .opacity))
        .accessibilityLabel("HUB says: \(note)")
    }

    private var controls: some View {
        HubGlassGroup(spacing: 14) {
            HStack(spacing: 12) {
                control(vision.voice?.muted == true ? "mic.slash.fill" : "mic.fill",
                        label: vision.voice?.muted == true ? "Unmute" : "Mute", action: mute)
                control(vision.showMarks ? "eye.fill" : "eye", label: vision.showMarks ? "Hide what HUB sees" : "Show what HUB sees") {
                    vision.showMarks.toggle()
                }
                control(vision.paused ? "video.fill" : "video.slash.fill", label: vision.paused ? "Resume camera" : "Pause camera") {
                    vision.togglePause()
                }
                control("eraser.fill", label: "Clear overlays") { withAnimation { vision.clearOverlays() } }
                Button(action: endCall) {
                    Image(systemName: "phone.down.fill").font(.title3.weight(.semibold))
                        .frame(width: 64, height: 54)
                        .hubGlass(Capsule(), interactive: true, tint: .red)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("End call")
            }
        }
        .padding(.bottom, 4)
    }

    private func control(_ icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.title3.weight(.medium))
                .frame(width: 54, height: 54)
                .hubGlassCircle()
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// Apple's AR camera view; tracking and rendering belong to ARKit.
struct HubARCameraView: UIViewRepresentable {
    let vision: HubCameraVision

    func makeUIView(context: Context) -> ARSCNView {
        let view = ARSCNView(frame: .zero)
        view.automaticallyUpdatesLighting = false
        view.rendersCameraGrain = false
        view.antialiasingMode = .none
        vision.attach(view)
        return view
    }

    func updateUIView(_ view: ARSCNView, context: Context) {}
}

// MARK: - Overlay design

enum HubOverlayPalette {
    static let cyan = Color(red: 0.33, green: 0.87, blue: 1.0)
    static let violet = Color(red: 0.64, green: 0.5, blue: 1.0)
    static let pink = Color(red: 1.0, green: 0.46, blue: 0.74)
    static let amber = Color(red: 1.0, green: 0.78, blue: 0.32)
    static let mint = Color(red: 0.4, green: 0.92, blue: 0.68)

    /// Steps take turns through the palette so a sequence reads at a glance.
    static func tint(for step: Int?) -> Color {
        guard let step else { return cyan }
        return [cyan, violet, pink, amber, mint][(step - 1) % 5]
    }

    static func gradient(for step: Int?) -> LinearGradient {
        let base = tint(for: step)
        let partner = step == nil ? violet : base.opacity(0.75)
        return LinearGradient(colors: [base, partner], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

struct HubCameraOverlayLayer: View {
    let items: [HubProjectedOverlay]

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .topLeading) {
                Color.clear
                ForEach(items) { item in
                    Group {
                        if item.visible { HubOverlayGlyph(item: item, size: geometry.size) }
                        else { HubOffscreenPointer(item: item) }
                    }
                    .transition(.scale(scale: 0.55).combined(with: .opacity))
                }
            }
            .animation(.spring(response: 0.45, dampingFraction: 0.68), value: items.map(\.id))
            .animation(.easeInOut(duration: 0.2), value: items.map(\.visible))
        }
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(items.isEmpty ? "" : "HUB is pointing at: " + items.compactMap { $0.label ?? $0.step.map { "step \($0)" } }.joined(separator: ", "))
    }
}

/// A short label in a glass tag with a colored dot.
struct HubOverlayTag: View {
    let text: String
    let tint: Color

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(tint).frame(width: 7, height: 7).shadow(color: tint, radius: 3)
            Text(text).font(.subheadline.weight(.semibold)).lineLimit(1)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 12).padding(.vertical, 7)
        .hubGlass(Capsule(), tint: tint.opacity(0.35))
        .shadow(color: .black.opacity(0.25), radius: 8, y: 3)
        .fixedSize()
    }
}

/// A soft ring that keeps expanding outward, so the eye finds the spot.
struct HubPulseRing: View {
    let tint: Color
    let radius: CGFloat
    @State private var expanded = false

    var body: some View {
        Circle()
            .stroke(tint, lineWidth: 2)
            .frame(width: radius * 2, height: radius * 2)
            .scaleEffect(expanded ? 1.7 : 1)
            .opacity(expanded ? 0 : 0.75)
            .onAppear {
                withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { expanded = true }
            }
    }
}

struct HubOverlayGlyph: View {
    let item: HubProjectedOverlay
    let size: CGSize

    private var tint: Color { HubOverlayPalette.tint(for: item.step) }

    var body: some View {
        switch item.style {
        case .circle: ring
        case .step: stepBadge
        case .arrow: HubOverlayArrow(item: item, size: size, tint: tint)
        case .box: if let rect = item.rect, rect.width > 12, rect.height > 12 { brackets(rect) } else { ring }
        case .label: pin
        }
    }

    private var ring: some View {
        let r = item.radius
        return ZStack {
            HubPulseRing(tint: tint, radius: r)
            Circle().fill(tint.opacity(0.12)).frame(width: r * 2, height: r * 2)
            Circle()
                .strokeBorder(AngularGradient(colors: [tint, .white, HubOverlayPalette.violet, tint], center: .center), lineWidth: 3)
                .frame(width: r * 2, height: r * 2)
                .shadow(color: tint.opacity(0.9), radius: 8)
            Circle().fill(.white).frame(width: 5, height: 5).shadow(color: tint, radius: 4)
        }
        .frame(width: r * 2, height: r * 2)
        .overlay(alignment: .top) {
            if let label = item.label { HubOverlayTag(text: label, tint: tint).offset(y: r * 2 + 12) }
        }
        .position(item.point)
    }

    private var stepBadge: some View {
        let onRight = item.point.x < size.width * 0.62
        return ZStack {
            HubPulseRing(tint: tint, radius: 20)
            Circle().fill(HubOverlayPalette.gradient(for: item.step)).frame(width: 40, height: 40)
                .overlay(Circle().strokeBorder(.white.opacity(0.85), lineWidth: 2))
                .shadow(color: tint.opacity(0.9), radius: 10)
            Text("\(item.step ?? 1)").font(.system(size: 19, weight: .heavy, design: .rounded)).foregroundStyle(.black.opacity(0.82))
        }
        .frame(width: 40, height: 40)
        .overlay(alignment: onRight ? .leading : .trailing) {
            if let label = item.label { HubOverlayTag(text: label, tint: tint).offset(x: onRight ? 50 : -50) }
        }
        .position(item.point)
    }

    private func brackets(_ rect: CGRect) -> some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(tint.opacity(0.08))
                .frame(width: rect.width, height: rect.height)
                .position(x: rect.midX, y: rect.midY)
            HubCornerBrackets(rect: rect)
                .stroke(HubOverlayPalette.gradient(for: item.step), style: StrokeStyle(lineWidth: 3.5, lineCap: .round, lineJoin: .round))
                .shadow(color: tint.opacity(0.85), radius: 8)
            if let label = item.label {
                HubOverlayTag(text: label, tint: tint)
                    .position(x: min(max(rect.minX + 60, 70), size.width - 70), y: max(rect.minY - 24, 70))
            }
        }
    }

    /// A dot with a short leader line up to its label.
    private var pin: some View {
        ZStack(alignment: .topLeading) {
            Path { path in
                path.move(to: item.point)
                path.addLine(to: CGPoint(x: item.point.x, y: item.point.y - 38))
            }
            .stroke(LinearGradient(colors: [tint, .white.opacity(0.9)], startPoint: .bottom, endPoint: .top), lineWidth: 1.6)
            Circle().fill(.white).frame(width: 10, height: 10)
                .overlay(Circle().strokeBorder(tint, lineWidth: 2.5))
                .shadow(color: tint, radius: 6)
                .position(item.point)
            if let label = item.label {
                HubOverlayTag(text: label, tint: tint).position(x: item.point.x, y: item.point.y - 56)
            }
        }
    }
}

/// Four viewfinder corners around a box.
struct HubCornerBrackets: Shape {
    let rect: CGRect

    func path(in _: CGRect) -> Path {
        let length = min(26, rect.width / 3, rect.height / 3)
        var path = Path()
        let corners: [(CGPoint, CGFloat, CGFloat)] = [
            (CGPoint(x: rect.minX, y: rect.minY), 1, 1), (CGPoint(x: rect.maxX, y: rect.minY), -1, 1),
            (CGPoint(x: rect.maxX, y: rect.maxY), -1, -1), (CGPoint(x: rect.minX, y: rect.maxY), 1, -1),
        ]
        for (corner, dx, dy) in corners {
            path.move(to: CGPoint(x: corner.x, y: corner.y + dy * length))
            path.addLine(to: corner)
            path.addLine(to: CGPoint(x: corner.x + dx * length, y: corner.y))
        }
        return path
    }
}

/// A curved arrow that swoops in from the roomier side, with light flowing
/// along it toward the target.
struct HubOverlayArrow: View {
    let item: HubProjectedOverlay
    let size: CGSize
    let tint: Color
    @State private var flow = false
    @State private var bob = false

    var body: some View {
        let target = item.point
        let fromLeft = target.x > size.width / 2
        let start = CGPoint(x: min(max(target.x + (fromLeft ? -120 : 120), 40), size.width - 40),
                            y: min(max(target.y - 140, 120), size.height - 160))
        let dx = target.x - start.x, dy = target.y - start.y, length = max(1, hypot(dx, dy))
        let end = CGPoint(x: target.x - dx / length * 16, y: target.y - dy / length * 16)
        let control = CGPoint(x: (start.x + end.x) / 2 + (fromLeft ? -1 : 1) * 40, y: min(start.y, end.y) - 10)
        return ZStack(alignment: .topLeading) {
            HubArrowShape(start: start, control: control, end: end)
                .stroke(Color.black.opacity(0.35), style: StrokeStyle(lineWidth: 7, lineCap: .round, lineJoin: .round))
            HubArrowShape(start: start, control: control, end: end)
                .stroke(HubOverlayPalette.gradient(for: item.step), style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
                .shadow(color: tint.opacity(0.9), radius: 8)
            HubArrowShape(start: start, control: control, end: end, headless: true)
                .stroke(.white.opacity(0.9), style: StrokeStyle(lineWidth: 2.2, lineCap: .round, dash: [1, 14], dashPhase: flow ? -30 : 0))
            HubPulseRing(tint: tint, radius: 14).position(target)
            Circle().fill(.white).frame(width: 8, height: 8).shadow(color: tint, radius: 5).position(target)
            if let label = item.label {
                HubOverlayTag(text: label, tint: tint).position(x: start.x, y: start.y - 24)
            }
        }
        .offset(x: bob ? dx / length * 5 : 0, y: bob ? dy / length * 5 : 0)
        .onAppear {
            withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { flow = true }
            withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { bob = true }
        }
    }
}

struct HubArrowShape: Shape {
    let start: CGPoint
    let control: CGPoint
    let end: CGPoint
    var headless = false

    func path(in _: CGRect) -> Path {
        var path = Path()
        path.move(to: start)
        path.addQuadCurve(to: end, control: control)
        guard !headless else { return path }
        let angle = atan2(end.y - control.y, end.x - control.x)
        for side: CGFloat in [-1, 1] {
            let wing = angle + .pi + side * 0.5
            path.move(to: end)
            path.addLine(to: CGPoint(x: end.x + cos(wing) * 16, y: end.y + sin(wing) * 16))
        }
        return path
    }
}

/// When the target is out of view: a glass chevron on the edge pointing at it.
struct HubOffscreenPointer: View {
    let item: HubProjectedOverlay

    var body: some View {
        let tint = HubOverlayPalette.tint(for: item.step)
        VStack(spacing: 4) {
            Image(systemName: "arrow.right")
                .font(.headline.weight(.bold))
                .foregroundStyle(tint)
                .rotationEffect(.radians(item.edgeAngle))
                .frame(width: 44, height: 44)
                .hubGlassCircle(interactive: false)
                .shadow(color: tint.opacity(0.6), radius: 6)
            if let text = item.label ?? item.step.map({ "Step \($0)" }) {
                Text(text).font(.caption2.weight(.semibold)).padding(.horizontal, 8).padding(.vertical, 3)
                    .hubGlass(Capsule()).fixedSize()
            }
        }
        .position(item.edgePoint)
    }
}

/// What the phone recognised, numbered as HUB sees it.
struct HubSeenMarksLayer: View {
    let marks: [HubProjectedMark]

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            ForEach(marks) { mark in
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(HubOverlayPalette.amber.opacity(0.85), lineWidth: 1.5)
                    .frame(width: mark.rect.width, height: mark.rect.height)
                    .overlay(alignment: .topLeading) {
                        Text("\(mark.id)").font(.caption2.weight(.heavy)).foregroundStyle(.black)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(HubOverlayPalette.amber))
                            .offset(x: -6, y: -9)
                    }
                    .position(x: mark.rect.midX, y: mark.rect.midY)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// A stand-in room for the simulator preview: a desk, a router and a lamp glow.
struct HubCameraFixtureScene: View {
    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            ZStack {
                LinearGradient(colors: [Color(red: 0.16, green: 0.14, blue: 0.13), Color(red: 0.07, green: 0.07, blue: 0.08)],
                               startPoint: .top, endPoint: .bottom)
                RadialGradient(colors: [Color(red: 1, green: 0.78, blue: 0.5).opacity(0.35), .clear], center: UnitPoint(x: 0.85, y: 0.1), startRadius: 0, endRadius: 360)
                Rectangle().fill(Color(red: 0.3, green: 0.22, blue: 0.16))
                    .frame(height: size.height * 0.5)
                    .position(x: size.width / 2, y: size.height * 0.78)
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(LinearGradient(colors: [Color(white: 0.92), Color(white: 0.75)], startPoint: .top, endPoint: .bottom))
                    .frame(width: size.width * 0.46, height: size.height * 0.11)
                    .position(x: size.width * 0.43, y: size.height * 0.31)
                    .shadow(color: .black.opacity(0.4), radius: 20, y: 12)
                HStack(spacing: 10) {
                    ForEach(0..<4) { _ in RoundedRectangle(cornerRadius: 3).fill(Color(white: 0.2)).frame(width: 18, height: 12) }
                    RoundedRectangle(cornerRadius: 3).fill(Color.yellow).frame(width: 18, height: 12)
                }
                .position(x: size.width * 0.5, y: size.height * 0.335)
            }
        }
    }
}
