import SwiftUI
import HubNative

/// A living "second brain": a force-directed graph that keeps drifting, like
/// the Obsidian graph view. Each domain is a glowing hub with its notes
/// radiating out; links pull related notes together; chats that touch no note
/// float as dust around the edge.
final class HubBrainSimulation {
    struct Node {
        let id: String
        let title: String
        let tone: Color
        let radius: CGFloat
        let mass: Double
        let gravity: Double
        let kind: Kind
        let phase: Double
        let hub: Int?
    }

    enum Kind { case hub, note, chat }

    struct Link {
        let a: Int
        let b: Int
        let length: Double
        let strength: Double
        let visible: Bool
    }

    private(set) var nodes: [Node] = []
    private(set) var links: [Link] = []
    private(set) var neighbors: [[Int]] = []
    var x: [Double] = [], y: [Double] = [], vx: [Double] = [], vy: [Double] = []
    var pinned: Int?
    private var alpha = 1.0
    private var last: Date?
    private var clock = 0.0
    // The camera, eased toward fitting every node.
    private(set) var scale: CGFloat = 0
    private(set) var center = CGPoint.zero

    static let nodeLimit = 420

    init(graph: HubHomeKnowledge, layout: HubKnowledgeLayout.Layout) {
        let titles = Dictionary(graph.nodes.map { ($0.id, $0.title ?? "Untitled") }, uniquingKeysWith: { a, _ in a })
        let kinds = Dictionary(graph.nodes.map { ($0.id, $0.kind) }, uniquingKeysWith: { a, _ in a })
        let roots = layout.groups.filter { $0.parentID == nil && $0.id != HubKnowledgeLayout.archiveID }
        var rootOf: [String: HubKnowledgeLayout.Group] = [:]
        for root in roots { for member in root.members where rootOf[member] == nil { rootOf[member] = root } }

        var degree: [String: Int] = [:]
        for edge in graph.edges { degree[edge.source, default: 0] += 1; degree[edge.target, default: 0] += 1 }
        let notes = layout.points.filter { kinds[$0.id] != "conversation" }
        let chats = layout.points.filter { kinds[$0.id] == "conversation" }
            .sorted { (degree[$0.id] ?? 0) > (degree[$1.id] ?? 0) }
        let chosen = Array((notes + chats).prefix(Self.nodeLimit))

        // One hub per top domain that has notes on screen.
        var hubIndex: [String: Int] = [:]
        for root in roots where root.id != HubKnowledgeLayout.unassignedID && chosen.contains(where: { rootOf[$0.id]?.id == root.id }) {
            hubIndex[root.id] = nodes.count
            nodes.append(Node(id: "hub:" + root.id, title: root.title, tone: HubKnowledgeGraphView.tone(root.hue, id: root.id),
                              radius: 7.5, mass: 5, gravity: 0.018, kind: .hub, phase: Self.unit(root.id) * 6.28, hub: nil))
            x.append(root.planeX); y.append(root.planeY)
        }
        var index: [String: Int] = [:]
        for point in chosen {
            let chat = kinds[point.id] == "conversation"
            let root = rootOf[point.id]
            let tone = chat ? HubKnowledgeGraphView.tone(0, id: HubKnowledgeLayout.archiveID)
                : HubKnowledgeGraphView.tone(root?.hue ?? point.hue, id: root?.id ?? point.groupID)
            let weight = Double(min(8, degree[point.id] ?? 0))
            index[point.id] = nodes.count
            nodes.append(Node(id: point.id, title: titles[point.id] ?? "Untitled", tone: tone,
                              radius: chat ? 2.1 : 3.1 + CGFloat(weight) * 0.35, mass: chat ? 0.6 : 1 + weight * 0.15,
                              gravity: chat ? 0.006 : 0.012, kind: chat ? .chat : .note,
                              phase: Self.unit(point.id) * 6.28, hub: root.flatMap { hubIndex[$0.id] }))
            x.append(point.x + Self.unit(point.id + "x") * 4); y.append(point.y + Self.unit(point.id + "y") * 4)
        }
        var seen = Set<Int>()
        func link(_ a: Int, _ b: Int, length: Double, strength: Double, visible: Bool = true) {
            guard a != b, seen.insert(min(a, b) * 100_000 + max(a, b)).inserted else { return }
            links.append(Link(a: a, b: b, length: length, strength: strength, visible: visible))
        }
        for (offset, node) in nodes.enumerated() where node.kind == .note {
            if let hub = node.hub { link(offset, hub, length: 34 + Self.unit(node.id + "l") * 26, strength: 0.05) }
        }
        for edge in graph.edges {
            if let a = index[edge.source], let b = index[edge.target] { link(a, b, length: 42, strength: 0.06) }
        }
        var similar: [Int: Int] = [:]
        for item in (graph.similarities ?? []).sorted(by: { $0.score > $1.score }) where item.score >= 0.8 {
            guard let a = index[item.source], let b = index[item.target],
                  similar[a, default: 0] < 2, similar[b, default: 0] < 2 else { continue }
            similar[a, default: 0] += 1; similar[b, default: 0] += 1
            link(a, b, length: 70, strength: 0.012)
        }
        neighbors = Array(repeating: [], count: nodes.count)
        for item in links { neighbors[item.a].append(item.b); neighbors[item.b].append(item.a) }
        vx = Array(repeating: 0, count: nodes.count)
        vy = Array(repeating: 0, count: nodes.count)
    }

    /// Settles the layout quickly before it is first shown.
    func warmUp(_ steps: Int) {
        for _ in 0..<steps { tick() }
    }

    func advance(to date: Date, moving: Bool) {
        let elapsed = last.map { date.timeIntervalSince($0) } ?? 1 / 60
        last = date
        guard moving else { return }
        let steps = max(1, min(3, Int((elapsed * 60).rounded())))
        for _ in 0..<steps { tick() }
    }

    /// Wakes the graph after a drag, so neighbors follow and settle again.
    func reheat() { alpha = max(alpha, 0.5) }

    private func tick() {
        let count = nodes.count
        guard count > 0 else { return }
        clock += 1 / 60
        var fx = [Double](repeating: 0, count: count), fy = [Double](repeating: 0, count: count)
        // Repulsion between every pair close enough to matter.
        let cutoff = 300.0 * 300.0
        for i in 0..<count {
            let xi = x[i], yi = y[i], mi = nodes[i].mass
            for j in (i + 1)..<count {
                let dx = xi - x[j], dy = yi - y[j]
                let distance = dx * dx + dy * dy
                guard distance < cutoff else { continue }
                let d2 = max(distance, 36)
                let force = 260 * mi * nodes[j].mass / d2
                let d = d2.squareRoot()
                let px = dx / d * force, py = dy / d * force
                fx[i] += px; fy[i] += py
                fx[j] -= px; fy[j] -= py
            }
        }
        for item in links {
            let dx = x[item.b] - x[item.a], dy = y[item.b] - y[item.a]
            let d = max(1, (dx * dx + dy * dy).squareRoot())
            let force = (d - item.length) * item.strength
            let px = dx / d * force, py = dy / d * force
            let total = nodes[item.a].mass + nodes[item.b].mass
            fx[item.a] += px * nodes[item.b].mass / total * 2; fy[item.a] += py * nodes[item.b].mass / total * 2
            fx[item.b] -= px * nodes[item.a].mass / total * 2; fy[item.b] -= py * nodes[item.a].mass / total * 2
        }
        for i in 0..<count {
            if i == pinned { vx[i] = 0; vy[i] = 0; continue }
            let node = nodes[i]
            // A slow, individual drift keeps the graph alive after it settles.
            let driftX = sin(clock * 0.45 + node.phase) * 0.018
            let driftY = cos(clock * 0.37 + node.phase * 1.3) * 0.018
            vx[i] = (vx[i] + (fx[i] / node.mass - x[i] * node.gravity) * alpha + driftX) * 0.84
            vy[i] = (vy[i] + (fy[i] / node.mass - y[i] * node.gravity) * alpha + driftY) * 0.84
            let speed = (vx[i] * vx[i] + vy[i] * vy[i]).squareRoot()
            if speed > 9 { vx[i] *= 9 / speed; vy[i] *= 9 / speed }
            x[i] += vx[i]; y[i] += vy[i]
        }
        alpha = max(0.06, alpha * 0.985)
    }

    /// Eases the camera toward showing every node inside `size`.
    func fit(_ size: CGSize, padding: CGFloat, immediate: Bool) {
        guard !nodes.isEmpty, size.width > 0, size.height > 0 else { return }
        var minX = Double.infinity, maxX = -Double.infinity, minY = Double.infinity, maxY = -Double.infinity
        for i in nodes.indices {
            minX = min(minX, x[i]); maxX = max(maxX, x[i]); minY = min(minY, y[i]); maxY = max(maxY, y[i])
        }
        let target = min((size.width - padding * 2) / CGFloat(max(60, maxX - minX)),
                         (size.height - padding * 2) / CGFloat(max(60, maxY - minY)))
        let targetCenter = CGPoint(x: (minX + maxX) / 2, y: (minY + maxY) / 2)
        if immediate || scale == 0 {
            scale = target; center = targetCenter
        } else {
            scale += (target - scale) * 0.06
            center.x += (targetCenter.x - center.x) * 0.06
            center.y += (targetCenter.y - center.y) * 0.06
        }
    }

    func screen(_ i: Int, size: CGSize, zoom: CGFloat, pan: CGSize) -> CGPoint {
        let s = scale * zoom
        return CGPoint(x: size.width / 2 + pan.width + (CGFloat(x[i]) - center.x) * s,
                       y: size.height / 2 + pan.height + (CGFloat(y[i]) - center.y) * s)
    }

    func world(_ point: CGPoint, size: CGSize, zoom: CGFloat, pan: CGSize) -> (Double, Double) {
        let s = max(0.0001, scale * zoom)
        return (Double(center.x + (point.x - size.width / 2 - pan.width) / s),
                Double(center.y + (point.y - size.height / 2 - pan.height) / s))
    }

    func nearest(to point: CGPoint, size: CGSize, zoom: CGFloat, pan: CGSize, within limit: CGFloat) -> Int? {
        var best: Int?, bestDistance = limit
        for i in nodes.indices {
            let p = screen(i, size: size, zoom: zoom, pan: pan)
            let distance = hypot(p.x - point.x, p.y - point.y) - (nodes[i].kind == .hub ? 6 : 0)
            if distance < bestDistance { best = i; bestDistance = distance }
        }
        return best
    }

    static func unit(_ text: String) -> Double {
        var value: UInt64 = 1_469_598_103_934_665_603
        for byte in text.utf8 { value = (value ^ UInt64(byte)) &* 1_099_511_628_211 }
        return Double(value % 10_000) / 10_000
    }
}

@MainActor
private final class HubBrainHolder: ObservableObject {
    @Published var simulation: HubBrainSimulation?
    var signature: Int?
}

struct HubLivingBrainView: View {
    let graph: HubHomeKnowledge
    var height: CGFloat = 300
    /// Full screen: drag nodes, pan and pinch. On Home it only takes taps, so
    /// the page still scrolls.
    var interactive = false
    var scope = HubKnowledgeGraphView.Scope.all
    var active = true
    var openRecord: (String) -> Void
    var openDomain: ((String) -> Void)? = nil
    var openExplorer: (() -> Void)? = nil

    @StateObject private var holder = HubBrainHolder()
    @State private var selected: String?
    @State private var zoom: CGFloat = 1
    @State private var pan: CGSize = .zero
    @GestureState private var pinch: CGFloat = 1
    @State private var dragStart: CGSize?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottom) {
                if let simulation = holder.simulation {
                    gestures(TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !active || scenePhase != .active)) { context in
                        Canvas { canvas, size in
                            simulation.advance(to: context.date, moving: !reduceMotion || simulation.pinned != nil)
                            simulation.fit(size, padding: interactive ? 36 : 22, immediate: false)
                            draw(simulation, in: &canvas, size: size)
                        }
                    }
                    .contentShape(Rectangle()), simulation: simulation, size: geometry.size)
                    if let selected, let index = simulation.nodes.firstIndex(where: { $0.id == selected }) {
                        selectionChip(simulation.nodes[index])
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .task(id: signature) { await build() }
        }
        .frame(height: height)
        .clipped()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Knowledge brain graph")
        .accessibilityHint(interactive ? "Drag to move around, pinch to zoom. Tap a dot to see what it is."
                                       : "Tap a dot to see what it is, or tap the graph to explore Knowledge.")
    }

    private var signature: Int {
        var hasher = Hasher()
        hasher.combine(scope)
        hasher.combine(graph.nodes.count)
        hasher.combine(graph.edges.count)
        for node in graph.nodes.prefix(600) { hasher.combine(node.id) }
        for domain in graph.domains ?? [] { hasher.combine(domain.id); hasher.combine(domain.title); hasher.combine(domain.status) }
        for member in (graph.memberships ?? []).prefix(2_000) { hasher.combine(member.nodeId); hasher.combine(member.domainId) }
        return hasher.finalize()
    }

    private func build() async {
        let key = signature
        guard holder.signature != key else { return }
        let graph = graph
        let steps = reduceMotion ? 420 : 160
        let notes = scope != .archive, archive = scope != .notes
        let built = await Task.detached(priority: .userInitiated) { () -> HubBrainSimulation in
            let layout = HubKnowledgeLayout.project(graph, includesNotes: notes, includesArchive: archive, overview: false, aspect: 1)
            let simulation = HubBrainSimulation(graph: graph, layout: layout)
            simulation.warmUp(steps)
            return simulation
        }.value
        guard !Task.isCancelled else { return }
        holder.signature = key
        holder.simulation = built
        if let selected, !built.nodes.contains(where: { $0.id == selected }) { self.selected = nil }
    }

    private func draw(_ simulation: HubBrainSimulation, in canvas: inout GraphicsContext, size: CGSize) {
        let scale = zoom * pinch
        let points = simulation.nodes.indices.map { simulation.screen($0, size: size, zoom: scale, pan: pan) }
        let focus = selected.flatMap { id in simulation.nodes.firstIndex { $0.id == id } }
        let lit = Set(focus.map { [$0] + simulation.neighbors[$0] } ?? [])
        let dim = focus != nil

        // Links: domain spokes in their domain's color, the rest as a fine mesh.
        var mesh = Path(), highlighted = Path()
        var spokes: [Int: Path] = [:]
        for link in simulation.links where link.visible {
            let a = points[link.a], b = points[link.b]
            if let focus, link.a == focus || link.b == focus {
                highlighted.move(to: a); highlighted.addLine(to: b)
            } else if simulation.nodes[link.b].kind == .hub {
                spokes[link.b, default: Path()].move(to: a)
                spokes[link.b, default: Path()].addLine(to: b)
            } else {
                mesh.move(to: a); mesh.addLine(to: b)
            }
        }
        canvas.stroke(mesh, with: .color(HubWorkspacePalette.border.opacity(dim ? 0.06 : 0.14)), lineWidth: 0.6)
        for (hub, path) in spokes {
            canvas.stroke(path, with: .color(simulation.nodes[hub].tone.opacity(dim ? 0.08 : 0.28)), lineWidth: 0.7)
        }
        canvas.stroke(highlighted, with: .color(HubWorkspacePalette.border.opacity(0.7)), lineWidth: 1.1)

        let grow = min(1.6, max(0.75, sqrt(scale)))
        for (i, node) in simulation.nodes.enumerated() where node.kind != .hub {
            let p = points[i]
            guard p.x > -20, p.y > -20, p.x < size.width + 20, p.y < size.height + 20 else { continue }
            let r = node.radius * grow * (i == focus ? 1.8 : 1)
            let faded = dim && !lit.contains(i)
            let opacity = faded ? 0.18 : (node.kind == .chat ? 0.55 : 0.95)
            if node.kind == .note && !faded {
                canvas.fill(Path(ellipseIn: CGRect(x: p.x - r * 2.2, y: p.y - r * 2.2, width: r * 4.4, height: r * 4.4)),
                            with: .color(node.tone.opacity(0.10)))
            }
            canvas.fill(Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)), with: .color(node.tone.opacity(opacity)))
        }
        // Hubs glow on top, each named in its own color.
        var taken: [CGRect] = []
        for (i, node) in simulation.nodes.enumerated() where node.kind == .hub {
            let p = points[i]
            let r = node.radius * grow
            let faded = dim && !lit.contains(i)
            let halos: [(CGFloat, Double)] = [(3.6, 0.07), (2.2, 0.14)]
            for (spread, alpha) in halos {
                let g = r * spread
                canvas.fill(Path(ellipseIn: CGRect(x: p.x - g, y: p.y - g, width: g * 2, height: g * 2)),
                            with: .color(node.tone.opacity(faded ? alpha / 3 : alpha)))
            }
            canvas.fill(Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)), with: .color(node.tone.opacity(faded ? 0.35 : 1)))
            canvas.fill(Path(ellipseIn: CGRect(x: p.x - r * 0.4, y: p.y - r * 0.4, width: r * 0.8, height: r * 0.8)), with: .color(.white.opacity(faded ? 0.2 : 0.75)))
            var label = canvas.resolve(Text(node.title).font(.caption2.weight(.semibold)))
            label.shading = .color(node.tone.opacity(faded ? 0.35 : 1))
            let measured = label.measure(in: CGSize(width: 160, height: 30))
            let box = CGRect(x: p.x - measured.width / 2, y: p.y + r + 4, width: measured.width, height: measured.height)
            if taken.contains(where: { $0.intersects(box) }) { continue }
            taken.append(box)
            canvas.draw(label, in: box)
        }
        // Note names appear once there is room: zoomed in, or around the selection.
        if interactive && scale >= 1.6 || focus != nil {
            for (i, node) in simulation.nodes.enumerated() where node.kind == .note && (focus == nil || lit.contains(i)) {
                let p = points[i]
                guard CGRect(origin: .zero, size: size).contains(p) else { continue }
                let short = node.title.count > 26 ? String(node.title.prefix(25)) + "…" : node.title
                var label = canvas.resolve(Text(short).font(.caption2))
                label.shading = .color(.primary.opacity(i == focus ? 1 : 0.7))
                let measured = label.measure(in: CGSize(width: 170, height: 30))
                let box = CGRect(x: p.x - measured.width / 2, y: p.y + 6, width: measured.width, height: measured.height)
                if taken.contains(where: { $0.insetBy(dx: -2, dy: -1).intersects(box) }) { continue }
                taken.append(box)
                canvas.draw(label, in: box)
            }
        }
    }

    private func tap(at location: CGPoint, simulation: HubBrainSimulation, size: CGSize) {
        let scale = zoom * pinch
        guard let index = simulation.nearest(to: location, size: size, zoom: scale, pan: pan, within: 24) else {
            if selected != nil { withAnimation(.easeOut(duration: 0.2)) { selected = nil } }
            else { openExplorer?() }
            return
        }
        let node = simulation.nodes[index]
        if selected == node.id {
            open(node)
        } else {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { selected = node.id }
            UISelectionFeedbackGenerator().selectionChanged()
        }
    }

    private func open(_ node: HubBrainSimulation.Node) {
        if node.kind == .hub {
            let domain = String(node.id.dropFirst(4))
            if let openDomain { openDomain(domain) } else { openExplorer?() }
        } else {
            openRecord(node.id)
        }
    }

    private func drag(_ value: DragGesture.Value, simulation: HubBrainSimulation, size: CGSize) {
        let scale = zoom * pinch
        if dragStart == nil {
            dragStart = pan
            if let index = simulation.nearest(to: value.startLocation, size: size, zoom: scale, pan: pan, within: 26) {
                simulation.pinned = index
                simulation.reheat()
            }
        }
        if let index = simulation.pinned {
            let target = simulation.world(value.location, size: size, zoom: scale, pan: pan)
            simulation.x[index] = target.0
            simulation.y[index] = target.1
        } else if let start = dragStart {
            pan = CGSize(width: start.width + value.translation.width, height: start.height + value.translation.height)
        }
    }

    private func selectionChip(_ node: HubBrainSimulation.Node) -> some View {
        HStack(spacing: 10) {
            Circle().fill(node.tone).frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 1) {
                Text(node.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(node.kind == .hub ? "Domain" : node.kind == .chat ? "Chat" : "Note")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            Button { open(node) } label: {
                Text("Open").font(.subheadline.weight(.semibold)).padding(.horizontal, 4)
            }
            .hubGlassButton(prominent: true)
            .accessibilityIdentifier("hub.brain.open")
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .hubGlass(Capsule())
        .padding(10)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Selected: \(node.title)")
    }
}

extension HubLivingBrainView {
    /// Taps everywhere; drags and pinches only on the full-screen graph, so
    /// Home still scrolls over it.
    @ViewBuilder fileprivate func gestures<Content: View>(_ content: Content, simulation: HubBrainSimulation, size: CGSize) -> some View {
        if interactive {
            content
                .gesture(DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        if dragStart != nil || hypot(value.translation.width, value.translation.height) > 4 {
                            drag(value, simulation: simulation, size: size)
                        }
                    }
                    .onEnded { value in
                        if dragStart == nil { tap(at: value.location, simulation: simulation, size: size) }
                        simulation.pinned = nil
                        simulation.reheat()
                        dragStart = nil
                    })
                .simultaneousGesture(MagnificationGesture()
                    .updating($pinch) { value, state, _ in state = value }
                    .onEnded { zoom = min(5, max(0.4, zoom * $0)) })
        } else if #available(iOS 16.0, *) {
            content.gesture(SpatialTapGesture().onEnded { tap(at: $0.location, simulation: simulation, size: size) })
        } else {
            content.simultaneousGesture(DragGesture(minimumDistance: 0).onEnded { value in
                if hypot(value.translation.width, value.translation.height) <= 4 {
                    tap(at: value.location, simulation: simulation, size: size)
                }
            })
        }
    }
}
