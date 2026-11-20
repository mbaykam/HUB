import SwiftUI
import UIKit
import CryptoKit
import HubNative

/// A living "second brain" built the way Obsidian's graph view works: a force
/// simulation (repel, link springs, a pull toward each domain) stepped at a
/// fixed 60 Hz, drawn by a retained layer tree that only moves and never
/// repaints, so dragging a note stays smooth at the display's full rate.
/// Each domain is a glowing hub with its notes around it; links pull related
/// notes together; chats float near the notes they touched.
/// Built off the main thread, then only touched on it.
final class HubBrainSimulation: @unchecked Sendable {
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

    enum Kind { case hub, note, chat, project }

    /// The Knowledge id of a HUB chat's archive.
    static func conversationID(sessionID: String) -> String {
        let digest = SHA256.hash(data: Data(("hub:" + sessionID).utf8))
        return "conversation-" + digest.map { String(format: "%02x", $0) }.joined().prefix(32)
    }

    struct Link {
        let a: Int
        let b: Int
        let length: Double
        let strength: Double
        let visible: Bool
        /// A "similar topic" link from meaning, not a stated relationship: drawn fainter.
        var similar = false
    }

    private(set) var nodes: [Node] = []
    /// Each node's kind, read every frame without touching the Node structs.
    private(set) var kinds: [Kind] = []
    private(set) var links: [Link] = []
    private(set) var neighbors: [[Int]] = []
    private(set) var x: [Double] = [], y: [Double] = []
    private var vx: [Double] = [], vy: [Double] = []
    /// Positions one step back, so frames between two 60 Hz steps are drawn in between.
    private var px: [Double] = [], py: [Double] = []
    // Flat copies of the per-node and per-link numbers the step reads, so the
    // hot loops never touch the Node structs (strings and colors).
    private var mass: [Double] = [], gravity: [Double] = [], hubOf: [Int] = []
    private var fx: [Double] = [], fy: [Double] = []
    private var la: [Int] = [], lb: [Int] = [], length: [Double] = [], strength: [Double] = []
    private var shareA: [Double] = [], shareB: [Double] = []
    /// The node held under a finger, and where the finger is in graph units.
    private(set) var pinned: Int?
    private var pinX = 0.0, pinY = 0.0
    private var alpha = 1.0
    private var alphaTarget = 0.0
    private var accumulator = 0.0
    // The camera, eased toward fitting every node.
    private(set) var scale: CGFloat = 0
    private(set) var center = CGPoint.zero

    static let nodeLimit = 420
    private static let step = 1.0 / 60
    /// d3-force's cooling: about 300 steps (5 seconds) from hot to still.
    private static let alphaDecay = 0.0228
    private static let alphaMin = 0.002
    /// How warm the graph runs while a note is held, so its neighbours follow.
    private static let dragAlpha = 0.3
    private static let velocityKeep = 0.68

    init(graph: HubHomeKnowledge, layout: HubKnowledgeLayout.Layout, limit: Int = HubBrainSimulation.nodeLimit, projects: [HubProject] = []) {
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
        let chosen = Array((notes + chats).prefix(max(notes.count, limit)))

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
                              gravity: chat ? 0.014 : 0.012, kind: chat ? .chat : .note,
                              phase: Self.unit(point.id) * 6.28, hub: root.flatMap { hubIndex[$0.id] }))
            x.append(point.x + Self.unit(point.id + "x") * 4); y.append(point.y + Self.unit(point.id + "y") * 4)
        }
        var seen = Set<Int>()
        func link(_ a: Int, _ b: Int, length: Double, strength: Double, visible: Bool = true, similar: Bool = false) {
            guard a != b, seen.insert(min(a, b) * 100_000 + max(a, b)).inserted else { return }
            links.append(Link(a: a, b: b, length: length, strength: strength, visible: visible, similar: similar))
        }
        // Notes hang close to their domain; links across domains are long and loose,
        // so each domain stays a group.
        for (offset, node) in nodes.enumerated() where node.kind == .note {
            if let hub = node.hub { link(offset, hub, length: 26 + Self.unit(node.id + "l") * 16, strength: 0.09) }
        }
        for edge in graph.edges {
            guard let a = index[edge.source], let b = index[edge.target] else { continue }
            let same = nodes[a].hub != nil && nodes[a].hub == nodes[b].hub
            let chat = nodes[a].kind == .chat || nodes[b].kind == .chat
            link(a, b, length: same || chat ? 30 : 90, strength: same || chat ? 0.07 : 0.015)
        }
        // Projects: their own marker, tied to the chats grouped in them.
        for project in projects {
            let members = project.sessionIds.compactMap { index[Self.conversationID(sessionID: $0)] }
            guard !members.isEmpty else { continue }
            let at = nodes.count
            let cx = members.map { x[$0] }.reduce(0, +) / Double(members.count)
            let cy = members.map { y[$0] }.reduce(0, +) / Double(members.count)
            nodes.append(Node(id: "project:" + project.id, title: project.name, tone: HubWorkspacePalette.accent,
                              radius: 6.5, mass: 3, gravity: 0.016, kind: .project, phase: Self.unit(project.id) * 6.28, hub: nil))
            x.append(cx + 8); y.append(cy - 8)
            for member in members { link(at, member, length: 34, strength: 0.08) }
        }
        var similar: [Int: Int] = [:]
        for item in (graph.similarities ?? []).sorted(by: { $0.score > $1.score }) where item.score >= 0.62 {
            guard let a = index[item.source], let b = index[item.target],
                  similar[a, default: 0] < 3, similar[b, default: 0] < 3 else { continue }
            similar[a, default: 0] += 1; similar[b, default: 0] += 1
            link(a, b, length: 70, strength: 0.01, similar: true)
        }
        neighbors = Array(repeating: [], count: nodes.count)
        for item in links { neighbors[item.a].append(item.b); neighbors[item.b].append(item.a) }

        let count = nodes.count
        vx = Array(repeating: 0, count: count); vy = vx
        fx = vx; fy = vx
        px = x; py = y
        self.kinds = nodes.map(\.kind)
        mass = nodes.map(\.mass)
        gravity = nodes.map(\.gravity)
        hubOf = nodes.map { $0.hub ?? -1 }
        la = links.map(\.a); lb = links.map(\.b)
        length = links.map(\.length); strength = links.map(\.strength)
        // The lighter end of a link moves more: each end takes the other's share of the mass.
        shareA = links.map { 2 * nodes[$0.b].mass / (nodes[$0.a].mass + nodes[$0.b].mass) }
        shareB = links.map { 2 * nodes[$0.a].mass / (nodes[$0.a].mass + nodes[$0.b].mass) }
    }

    /// Settles the layout before it is first shown, then lets it cool from warm.
    func warmUp(_ steps: Int) {
        for _ in 0..<steps { tick() }
        px = x; py = y
        alpha = min(alpha, 0.12)
    }

    /// Runs the fixed 60 Hz steps that fit into `seconds`. Returns whether anything still moves.
    @discardableResult
    func advance(by seconds: Double) -> Bool {
        guard !settled else { accumulator = 0; return false }
        accumulator += min(max(seconds, 0), 0.1)
        var steps = 0
        while accumulator >= Self.step && steps < 4 {
            px = x; py = y
            tick()
            accumulator -= Self.step
            steps += 1
        }
        if steps == 4 { accumulator = 0 }
        return !settled
    }

    /// Nothing is moving: the view can stop redrawing.
    var settled: Bool { pinned == nil && alpha < Self.alphaMin }

    /// Where node `i` is right now, between the last two steps.
    func position(_ i: Int) -> (Double, Double) {
        if i == pinned { return (pinX, pinY) }
        let t = min(1, accumulator / Self.step)
        return (px[i] + (x[i] - px[i]) * t, py[i] + (y[i] - py[i]) * t)
    }

    /// Picks a note up: it follows the finger exactly while the graph warms so
    /// its neighbours are pulled along.
    func hold(_ i: Int, at point: (Double, Double)) {
        guard nodes.indices.contains(i) else { return }
        pinned = i
        move(to: point)
        alpha = max(alpha, Self.dragAlpha)
        alphaTarget = Self.dragAlpha
    }

    func move(to point: (Double, Double)) {
        guard let i = pinned, point.0.isFinite, point.1.isFinite else { return }
        pinX = min(1_500, max(-1_500, point.0)); pinY = min(1_500, max(-1_500, point.1))
        x[i] = pinX; y[i] = pinY; px[i] = pinX; py[i] = pinY
        vx[i] = 0; vy[i] = 0
    }

    /// Lets go: the note stays where it was dropped and everything cools to a stop.
    func release() {
        pinned = nil
        alphaTarget = 0
    }

    /// Warms a still graph a little, e.g. when it comes back on screen.
    func nudge() { alpha = max(alpha, 0.05) }

    private func tick() {
        let n = nodes.count
        guard n > 0 else { return }
        alpha += (alphaTarget - alpha) * Self.alphaDecay
        if pinned == nil && alphaTarget == 0 && alpha < Self.alphaMin {
            alpha = 0
            for i in 0..<n { vx[i] = 0; vy[i] = 0 }
            return
        }
        // Repulsion between every pair close enough to matter.
        x.withUnsafeBufferPointer { X in
            y.withUnsafeBufferPointer { Y in
                mass.withUnsafeBufferPointer { M in
                    fx.withUnsafeMutableBufferPointer { FX in
                        fy.withUnsafeMutableBufferPointer { FY in
                            for i in 0..<n { FX[i] = 0; FY[i] = 0 }
                            for i in 0..<n {
                                let xi = X[i], yi = Y[i], mi = M[i]
                                var ax = 0.0, ay = 0.0
                                var j = i + 1
                                while j < n {
                                    let dx = xi - X[j], dy = yi - Y[j]
                                    let d2 = dx * dx + dy * dy
                                    if d2 < 90_000 {
                                        let c = max(d2, 36)
                                        let f = 260 * mi * M[j] / (c * c.squareRoot())
                                        let ox = dx * f, oy = dy * f
                                        ax += ox; ay += oy
                                        FX[j] -= ox; FY[j] -= oy
                                    }
                                    j += 1
                                }
                                FX[i] += ax; FY[i] += ay
                            }
                        }
                    }
                }
            }
        }
        // Springs along the links.
        for k in 0..<la.count {
            let a = la[k], b = lb[k]
            let dx = x[b] - x[a], dy = y[b] - y[a]
            let d = max(1, (dx * dx + dy * dy).squareRoot())
            let f = (d - length[k]) * strength[k] / d
            let ox = dx * f, oy = dy * f
            fx[a] += ox * shareA[k]; fy[a] += oy * shareA[k]
            fx[b] -= ox * shareB[k]; fy[b] -= oy * shareB[k]
        }
        for i in 0..<n {
            if i == pinned { x[i] = pinX; y[i] = pinY; vx[i] = 0; vy[i] = 0; continue }
            // Notes are drawn toward their own domain, domains toward the middle.
            var gx = x[i] * gravity[i], gy = y[i] * gravity[i]
            let hub = hubOf[i]
            if hub >= 0 { gx = (x[i] - x[hub]) * 0.03 + x[i] * 0.003; gy = (y[i] - y[hub]) * 0.03 + y[i] * 0.003 }
            vx[i] = (vx[i] + (fx[i] / mass[i] - gx) * alpha) * Self.velocityKeep
            vy[i] = (vy[i] + (fy[i] / mass[i] - gy) * alpha) * Self.velocityKeep
            // A capped step: nothing ever flies off.
            let speed = (vx[i] * vx[i] + vy[i] * vy[i]).squareRoot()
            if speed > 6 { vx[i] *= 6 / speed; vy[i] *= 6 / speed }
            x[i] += vx[i]; y[i] += vy[i]
            // Never lose a dot: a broken value goes back near its domain.
            if !x[i].isFinite || !y[i].isFinite {
                let home = hub >= 0 ? (x[hub], y[hub]) : (0, 0)
                x[i] = (home.0.isFinite ? home.0 : 0) + Self.unit(nodes[i].id + "rx") * 20 - 10
                y[i] = (home.1.isFinite ? home.1 : 0) + Self.unit(nodes[i].id + "ry") * 20 - 10
                vx[i] = 0; vy[i] = 0; px[i] = x[i]; py[i] = y[i]
            }
            x[i] = min(1_500, max(-1_500, x[i])); y[i] = min(1_500, max(-1_500, y[i]))
        }
    }

    /// Eases the camera toward showing every node inside `size`. Returns whether it is still moving.
    @discardableResult
    func fit(_ size: CGSize, padding: CGFloat, immediate: Bool) -> Bool {
        guard !nodes.isEmpty, size.width > 0, size.height > 0 else { return false }
        // Frame the bulk of the graph: a few far-off dots must not shrink everything else to a speck.
        let xs = x.filter(\.isFinite).sorted(), ys = y.filter(\.isFinite).sorted()
        guard !xs.isEmpty, !ys.isEmpty else { return false }
        let cut = xs.count > 40 ? xs.count / 40 : 0
        let minX = xs[cut], maxX = xs[xs.count - 1 - cut], minY = ys[cut], maxY = ys[ys.count - 1 - cut]
        let raw = min((size.width - padding * 2) / CGFloat(max(60, maxX - minX)),
                      (size.height - padding * 2) / CGFloat(max(60, maxY - minY)))
        let target = min(4, max(0.35, raw.isFinite ? raw : 1))
        let targetCenter = CGPoint(x: (minX + maxX) / 2, y: (minY + maxY) / 2)
        if immediate || scale == 0 {
            scale = target; center = targetCenter
            return false
        }
        scale += (target - scale) * 0.08
        center.x += (targetCenter.x - center.x) * 0.08
        center.y += (targetCenter.y - center.y) * 0.08
        return abs(target - scale) > 0.002 || hypot(targetCenter.x - center.x, targetCenter.y - center.y) > 0.3
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
    /// Drag notes around and pinch to zoom. Off: the graph only takes taps.
    var interactive = false
    var scope = HubKnowledgeGraphView.Scope.all
    var active = true
    /// How many dots at most; chats that touch no note are dropped first.
    var nodeLimit = 220
    /// HUB projects, drawn as their own markers next to their chats.
    var projects: [HubProject] = []
    /// One-finger panning of empty space; off on Home, where the page scrolls
    /// instead and the graph must not wander off screen.
    var allowsPan = true
    var openRecord: (String) -> Void
    var openProject: ((String) -> Void)? = nil
    var openDomain: ((String) -> Void)? = nil
    var openExplorer: (() -> Void)? = nil

    @StateObject private var holder = HubBrainHolder()
    @State private var selected: String?
    @State private var refit = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .bottom) {
            if let simulation = holder.simulation {
                HubBrainSurface(simulation: simulation, interactive: interactive, allowsPan: allowsPan,
                                // Not scenePhase: in this UIKit-hosted app it never reads .active.
                                // The display link stops by itself in the background.
                                running: active, padding: interactive ? 36 : 22,
                                selectedID: selected, refit: refit, tap: tap)
                if let selected, let node = simulation.nodes.first(where: { $0.id == selected }) {
                    selectionChip(node)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: signature) { await build() }
        // Coming back to Home reframes the graph.
        .onChange(of: active) { visible in if visible { refit += 1 } }
        .frame(height: height)
        .clipped()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Knowledge brain graph")
        .accessibilityHint(interactive ? "Drag a dot to move it, pinch to zoom. Tap a dot to see what it is."
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
        for project in projects { hasher.combine(project.id); hasher.combine(project.name); hasher.combine(project.sessionIds) }
        return hasher.finalize()
    }

    private func build() async {
        let key = signature
        guard holder.signature != key else { return }
        let graph = graph
        let steps = reduceMotion ? 420 : 220
        let notes = scope != .archive, archive = scope != .notes
        let limit = nodeLimit, projects = archive ? projects : []
        let built = await Task.detached(priority: .userInitiated) { () -> HubBrainSimulation in
            let layout = HubKnowledgeLayout.project(graph, includesNotes: notes, includesArchive: archive, overview: false, aspect: 1)
            let simulation = HubBrainSimulation(graph: graph, layout: layout, limit: limit, projects: projects)
            simulation.warmUp(steps)
            return simulation
        }.value
        guard !Task.isCancelled else { return }
        holder.signature = key
        holder.simulation = built
        if let selected, !built.nodes.contains(where: { $0.id == selected }) { self.selected = nil }
    }

    /// A tap on a dot selects it (its links light up); a second tap opens it.
    /// A tap on empty space clears the selection, or opens Knowledge.
    private func tap(_ id: String?) {
        guard let id, let node = holder.simulation?.nodes.first(where: { $0.id == id }) else {
            if selected != nil { withAnimation(.easeOut(duration: 0.2)) { selected = nil } }
            else { openExplorer?() }
            return
        }
        if selected == id {
            open(node)
        } else {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { selected = id }
            UISelectionFeedbackGenerator().selectionChanged()
        }
    }

    private func open(_ node: HubBrainSimulation.Node) {
        if node.kind == .hub {
            let domain = String(node.id.dropFirst(4))
            if let openDomain { openDomain(domain) } else { openExplorer?() }
        } else if node.kind == .project {
            openProject?(String(node.id.dropFirst(8)))
        } else {
            openRecord(node.id)
        }
    }

    private func selectionChip(_ node: HubBrainSimulation.Node) -> some View {
        HStack(spacing: 10) {
            Circle().fill(node.tone).frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 1) {
                Text(node.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(node.kind == .hub ? "Domain" : node.kind == .chat ? "Chat" : node.kind == .project ? "Project" : "Note")
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

/// Hosts the layer-drawn graph and its touch handling.
private struct HubBrainSurface: UIViewRepresentable {
    let simulation: HubBrainSimulation
    let interactive: Bool
    let allowsPan: Bool
    let running: Bool
    let padding: CGFloat
    let selectedID: String?
    let refit: Int
    let tap: (String?) -> Void

    func makeUIView(context: Context) -> HubBrainLayerView { HubBrainLayerView() }

    func updateUIView(_ view: HubBrainLayerView, context: Context) {
        view.tap = tap
        view.padding = padding
        view.configure(simulation: simulation, interactive: interactive, allowsPan: allowsPan)
        view.selectedID = selectedID
        view.refit(token: refit)
        view.running = running
    }
}

/// The graph's drawing and touches. Every dot, glow and label is its own layer,
/// made once; each frame only moves them and redraws the thin link paths, so
/// Core Animation composites the picture on the GPU instead of the CPU
/// repainting it. A note under the finger is picked up at once and the page
/// behind does not scroll; anywhere else the page scrolls as usual.
final class HubBrainLayerView: UIView, UIGestureRecognizerDelegate {
    var tap: ((String?) -> Void)?
    var padding: CGFloat = 22
    var running = false { didSet { if running != oldValue { running ? wake() : sleep() } } }
    var selectedID: String? {
        didSet {
            guard selectedID != oldValue else { return }
            focus = selectedID.flatMap { id in simulation?.nodes.firstIndex { $0.id == id } }
            lit = Set(focus.map { [$0] + (simulation?.neighbors[$0] ?? []) } ?? [])
            labelOrder = []
            wake()
        }
    }
    /// Names in the order they claim space: the selected dot, domains, projects, the rest.
    private var labelOrder: [Int] = []

    private var simulation: HubBrainSimulation?
    private var interactive = false
    private var allowsPan = true
    private var refitToken: Int?
    // Camera: the simulation frames the graph; zoom and pan are the user's on top.
    private var zoom: CGFloat = 1
    private var pan = CGPoint.zero
    private var userMoved = false
    private var glide = CGPoint.zero
    private var pinchStartZoom: CGFloat = 1
    private var panStart = CGPoint.zero
    private var heldMoved = false
    private var touchStart = CGPoint.zero
    private var focus: Int?
    private var lit = Set<Int>()

    private var displayLink: CADisplayLink?
    private var lastFrame: CFTimeInterval?
    private var awakeUntil: CFTimeInterval = 0

    private let linkLayer = CALayer()
    private let nodeLayer = CALayer()
    private let labelLayer = CALayer()
    private let mesh = CAShapeLayer()
    private let similar = CAShapeLayer()
    private let highlight = CAShapeLayer()
    private var spokes: [Int: CAShapeLayer] = [:]
    private var dots: [CALayer] = []
    private var labels: [CALayer?] = []
    private var labelShown: [Float] = []
    private var dotShown: [Float] = []
    private var lastGrow: CGFloat = 0
    private var points: [CGPoint] = []

    private lazy var hold: UILongPressGestureRecognizer = {
        let recognizer = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
        recognizer.minimumPressDuration = 0
        recognizer.allowableMovement = .greatestFiniteMagnitude
        recognizer.delegate = self
        return recognizer
    }()
    private lazy var panner: UIPanGestureRecognizer = {
        let recognizer = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
        recognizer.maximumNumberOfTouches = 1
        recognizer.delegate = self
        return recognizer
    }()
    private lazy var pinch: UIPinchGestureRecognizer = {
        let recognizer = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:)))
        recognizer.delegate = self
        return recognizer
    }()
    private lazy var tapper: UITapGestureRecognizer = {
        let recognizer = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        recognizer.delegate = self
        return recognizer
    }()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isMultipleTouchEnabled = true
        for layer in [linkLayer, nodeLayer, labelLayer] { self.layer.addSublayer(layer) }
        for path in [mesh, similar, highlight] {
            path.fillColor = nil
            path.lineCap = .round
            linkLayer.addSublayer(path)
        }
        mesh.lineWidth = 0.6
        similar.lineWidth = 0.6
        similar.lineDashPattern = [2.5, 3]
        highlight.lineWidth = 1.1
        addGestureRecognizer(tapper)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(simulation: HubBrainSimulation, interactive: Bool, allowsPan: Bool) {
        if self.interactive != interactive || self.allowsPan != allowsPan || gestureRecognizers?.contains(hold) != true && interactive {
            self.interactive = interactive
            self.allowsPan = allowsPan
            for recognizer in [hold, panner, pinch] { removeGestureRecognizer(recognizer) }
            if interactive {
                // Inside the scrolling Home page a dot is picked up after a short
                // touch, so a quick swipe that starts on one still scrolls the page.
                hold.minimumPressDuration = allowsPan ? 0 : 0.09
                addGestureRecognizer(hold)
                addGestureRecognizer(pinch)
                if allowsPan { addGestureRecognizer(panner) }
            }
        }
        guard simulation !== self.simulation else { return }
        self.simulation = simulation
        focus = selectedID.flatMap { id in simulation.nodes.firstIndex { $0.id == id } }
        lit = Set(focus.map { [$0] + simulation.neighbors[$0] } ?? [])
        buildLayers()
        drawStill()
        wake()
    }

    /// Places every layer once, so the graph shows even before (or without) animation.
    private func drawStill() {
        guard let simulation, bounds.width > 0, bounds.height > 0 else { return }
        if !userMoved { simulation.fit(bounds.size, padding: padding, immediate: simulation.scale == 0) }
        _ = render(simulation)
    }

    func refit(token: Int) {
        guard token != refitToken else { return }
        let first = refitToken == nil
        refitToken = token
        guard !first else { return }
        zoom = 1; pan = .zero; glide = .zero; userMoved = false
        simulation?.nudge()
        wake()
    }

    deinit { displayLink?.invalidate() }

    override func layoutSubviews() {
        super.layoutSubviews()
        for layer in [linkLayer, nodeLayer, labelLayer] { layer.frame = bounds }
        for path in [mesh, similar, highlight] { path.frame = bounds }
        for spoke in spokes.values { spoke.frame = bounds }
        drawStill()
        wake()
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        if traitCollection.hasDifferentColorAppearance(comparedTo: previousTraitCollection) { buildLayers(); wake() }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { sleep() } else { wake() }
    }

    // MARK: Frames

    private func wake(for seconds: CFTimeInterval = 1.5) {
        guard running, window != nil, simulation != nil else { return }
        awakeUntil = max(awakeUntil, CACurrentMediaTime() + seconds)
        if displayLink == nil {
            let link = CADisplayLink(target: HubBrainFrameTarget(self), selector: #selector(HubBrainFrameTarget.tick(_:)))
            if #available(iOS 15.0, *) {
                link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 120)
            }
            link.add(to: .main, forMode: .common)
            displayLink = link
        }
        lastFrame = nil
        displayLink?.isPaused = false
    }

    private func sleep() {
        displayLink?.isPaused = true
        lastFrame = nil
    }

    fileprivate func onFrame(_ link: CADisplayLink) {
        guard let simulation, bounds.width > 0 else { return }
        let now = link.timestamp
        let elapsed = lastFrame.map { now - $0 } ?? 1.0 / 60
        lastFrame = now
        let moving = simulation.advance(by: elapsed)
        var gliding = false
        if glide != .zero {
            pan.x += glide.x * CGFloat(elapsed); pan.y += glide.y * CGFloat(elapsed)
            let keep = CGFloat(pow(0.04, elapsed))
            glide.x *= keep; glide.y *= keep
            if hypot(glide.x, glide.y) < 8 { glide = .zero } else { gliding = true }
        }
        var framing = false
        if !userMoved { framing = simulation.fit(bounds.size, padding: padding, immediate: false) }
        let fading = render(simulation)
        if !moving && !gliding && !framing && !fading && now > awakeUntil {
            sleep()
        }
    }

    // MARK: Layers

    private func buildLayers() {
        for layer in dots { layer.removeFromSuperlayer() }
        for layer in labels { layer?.removeFromSuperlayer() }
        for layer in spokes.values { layer.removeFromSuperlayer() }
        dots = []; labels = []; spokes = [:]; lastGrow = 0; labelOrder = []
        guard let simulation else { return }
        let border = UIColor(HubWorkspacePalette.border).resolvedColor(with: traitCollection)
        mesh.strokeColor = border.cgColor
        similar.strokeColor = border.cgColor
        highlight.strokeColor = border.withAlphaComponent(0.7).cgColor
        for (i, node) in simulation.nodes.enumerated() where node.kind == .hub {
            let spoke = CAShapeLayer()
            spoke.fillColor = nil
            spoke.lineWidth = 0.7
            spoke.lineCap = .round
            spoke.strokeColor = UIColor(node.tone).resolvedColor(with: traitCollection).cgColor
            spoke.frame = bounds
            linkLayer.insertSublayer(spoke, below: highlight)
            spokes[i] = spoke
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        // Draw order: chats, notes, then projects and domains on top.
        let order: [HubBrainSimulation.Kind] = [.chat, .note, .project, .hub]
        dots = simulation.nodes.map { _ in CALayer() }
        for kind in order {
            for (i, node) in simulation.nodes.enumerated() where node.kind == kind {
                let tone = UIColor(node.tone).resolvedColor(with: traitCollection)
                let dot = dots[i]
                dot.bounds = .zero
                switch node.kind {
                case .chat:
                    dot.addSublayer(Self.circle(node.radius, tone.withAlphaComponent(0.55)))
                case .note:
                    dot.addSublayer(Self.circle(node.radius * 2.2, tone.withAlphaComponent(0.10)))
                    dot.addSublayer(Self.circle(node.radius, tone.withAlphaComponent(0.95)))
                case .hub:
                    dot.addSublayer(Self.circle(node.radius * 3.6, tone.withAlphaComponent(0.07)))
                    dot.addSublayer(Self.circle(node.radius * 2.2, tone.withAlphaComponent(0.14)))
                    dot.addSublayer(Self.circle(node.radius, tone))
                    dot.addSublayer(Self.circle(node.radius * 0.4, UIColor.white.withAlphaComponent(0.75)))
                case .project:
                    let ring = CAShapeLayer()
                    let side = node.radius * 3.8
                    ring.path = UIBezierPath(roundedRect: CGRect(x: -side / 2, y: -side / 2, width: side, height: side),
                                             cornerRadius: node.radius * 1.1).cgPath
                    ring.fillColor = nil
                    ring.strokeColor = tone.withAlphaComponent(0.6).cgColor
                    ring.lineWidth = 1.2
                    dot.addSublayer(ring)
                    let square = CALayer()
                    square.bounds = CGRect(x: 0, y: 0, width: node.radius * 2, height: node.radius * 2)
                    square.cornerRadius = node.radius * 0.5
                    square.backgroundColor = tone.cgColor
                    square.position = .zero
                    dot.addSublayer(square)
                }
                nodeLayer.addSublayer(dot)
            }
        }
        labels = Array(repeating: nil, count: simulation.nodes.count)
        labelShown = Array(repeating: 0, count: simulation.nodes.count)
        dotShown = Array(repeating: 1, count: simulation.nodes.count)
        points = Array(repeating: .zero, count: simulation.nodes.count)
        CATransaction.commit()
    }

    private static func circle(_ radius: CGFloat, _ color: UIColor) -> CALayer {
        let layer = CALayer()
        layer.bounds = CGRect(x: 0, y: 0, width: radius * 2, height: radius * 2)
        layer.cornerRadius = radius
        layer.backgroundColor = color.cgColor
        layer.position = .zero
        return layer
    }

    /// A node's name, drawn once into an image the first time it is needed.
    private func label(_ i: Int, _ node: HubBrainSimulation.Node) -> CALayer? {
        if let made = labels[i] { return made }
        guard node.kind != .chat else { return nil }
        let text = NSMutableAttributedString()
        let caption = UIFont.preferredFont(forTextStyle: .caption2)
        switch node.kind {
        case .hub:
            text.append(NSAttributedString(string: node.title, attributes: [
                .font: UIFont.systemFont(ofSize: caption.pointSize, weight: .semibold),
                .foregroundColor: UIColor(node.tone).resolvedColor(with: traitCollection)]))
        case .project:
            let font = UIFont.systemFont(ofSize: UIFont.preferredFont(forTextStyle: .caption1).pointSize, weight: .bold)
            if let folder = UIImage(systemName: "folder.fill", withConfiguration: UIImage.SymbolConfiguration(font: caption))?
                .withTintColor(UIColor.label.resolvedColor(with: traitCollection), renderingMode: .alwaysOriginal) {
                let attachment = NSTextAttachment()
                attachment.image = folder
                attachment.bounds = CGRect(x: 0, y: -1, width: folder.size.width, height: folder.size.height)
                text.append(NSAttributedString(attachment: attachment))
            }
            text.append(NSAttributedString(string: " " + node.title, attributes: [
                .font: font, .foregroundColor: UIColor.label.resolvedColor(with: traitCollection)]))
        default:
            let short = node.title.count > 26 ? String(node.title.prefix(25)) + "…" : node.title
            text.append(NSAttributedString(string: short, attributes: [
                .font: caption, .foregroundColor: UIColor.label.resolvedColor(with: traitCollection).withAlphaComponent(0.78)]))
        }
        let measured = text.boundingRect(with: CGSize(width: 190, height: 40), options: [.usesLineFragmentOrigin], context: nil).size
        let size = CGSize(width: ceil(measured.width), height: ceil(measured.height))
        guard size.width > 0, size.height > 0 else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = window?.screen.scale ?? UIScreen.main.scale
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in text.draw(at: .zero) }
        let layer = CALayer()
        layer.contents = image.cgImage
        layer.contentsScale = format.scale
        layer.bounds = CGRect(origin: .zero, size: size)
        layer.opacity = 0
        labelLayer.addSublayer(layer)
        labels[i] = layer
        return layer
    }

    /// Moves every layer to this frame's positions. Returns whether a fade is still running.
    private func render(_ simulation: HubBrainSimulation) -> Bool {
        let nodes = simulation.nodes
        let kinds = simulation.kinds
        guard dots.count == nodes.count else { return false }
        let size = bounds.size
        let scale = (simulation.scale > 0 ? simulation.scale : 1) * zoom
        for i in nodes.indices {
            let p = simulation.position(i)
            points[i] = CGPoint(x: size.width / 2 + pan.x + (CGFloat(p.0) - simulation.center.x) * scale,
                                y: size.height / 2 + pan.y + (CGFloat(p.1) - simulation.center.y) * scale)
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }

        let dim = focus != nil
        // Links: domain spokes in their domain's colour, the rest as a fine mesh.
        let meshPath = CGMutablePath(), similarPath = CGMutablePath(), highlightPath = CGMutablePath()
        var spokePaths: [Int: CGMutablePath] = [:]
        for link in simulation.links where link.visible {
            let a = points[link.a], b = points[link.b]
            if let focus, link.a == focus || link.b == focus {
                highlightPath.move(to: a); highlightPath.addLine(to: b)
            } else if link.similar {
                similarPath.move(to: a); similarPath.addLine(to: b)
            } else if kinds[link.b] == .hub {
                let path = spokePaths[link.b] ?? CGMutablePath()
                path.move(to: a); path.addLine(to: b)
                spokePaths[link.b] = path
            } else {
                meshPath.move(to: a); meshPath.addLine(to: b)
            }
        }
        mesh.path = meshPath
        mesh.opacity = dim ? 0.06 : 0.14
        similar.path = similarPath
        similar.opacity = dim ? 0.03 : 0.08
        highlight.path = highlightPath
        for (hub, spoke) in spokes {
            spoke.path = spokePaths[hub]
            spoke.opacity = dim ? 0.08 : 0.28
        }

        // Few dots: draw them larger and name every note.
        let few = nodes.count <= 40
        let grow = min(1.6, max(0.75, sqrt(zoom))) * (few ? 1.5 : 1)
        let regrow = abs(grow - lastGrow) > 0.004
        if regrow { lastGrow = grow }
        let view = bounds.insetBy(dx: -40, dy: -40)
        var fading = false
        for i in nodes.indices {
            let dot = dots[i]
            let p = points[i]
            let visible = view.contains(p)
            if dot.isHidden == visible { dot.isHidden = !visible }
            guard visible else { continue }
            dot.position = p
            let bigger: CGFloat = i == focus ? 1.8 : 1
            if regrow || i == focus || dot.affineTransform().a != grow * bigger {
                dot.setAffineTransform(CGAffineTransform(scaleX: grow * bigger, y: grow * bigger))
            }
            let target: Float = dim && !lit.contains(i) ? (kinds[i] == .hub ? 0.35 : 0.2) : 1
            if dotShown[i] != target {
                dotShown[i] += (target - dotShown[i]) * 0.25
                if abs(dotShown[i] - target) < 0.02 { dotShown[i] = target } else { fading = true }
                dot.opacity = dotShown[i]
            }
        }

        // Names: domains and projects always; notes fade in as you zoom, like
        // Obsidian's text fade, and around the selected dot. No two overlap.
        let noteNames: Float = few ? 1 : (interactive ? Float(min(1, max(0, (zoom - 1.35) / 0.5))) : 0)
        var taken: [CGRect] = []
        if labelOrder.count != nodes.count {
            labelOrder = nodes.indices.sorted { rank(kinds[$0], $0) < rank(kinds[$1], $1) }
        }
        for i in labelOrder {
            guard kinds[i] != .chat else { continue }
            var target: Float
            switch kinds[i] {
            case .hub, .project: target = dim && !lit.contains(i) ? 0.35 : 1
            default: target = focus == nil ? noteNames : (lit.contains(i) ? (i == focus ? 1 : 0.85) : 0)
            }
            if !bounds.contains(points[i]) { target = 0 }
            var shown = labelShown[i]
            if target == 0 && shown == 0 { continue }
            let node = nodes[i]
            guard let layer = label(i, node) else { continue }
            let below = node.radius * lastGrow * (node.kind == .project ? 1.9 : 1) * (i == focus ? 1.8 : 1) + 4
            let box = CGRect(x: points[i].x - layer.bounds.width / 2, y: points[i].y + below,
                             width: layer.bounds.width, height: layer.bounds.height)
            if target > 0 {
                if taken.contains(where: { $0.insetBy(dx: -2, dy: -1).intersects(box) }) { target = 0 } else { taken.append(box) }
            }
            if shown != target {
                shown += (target - shown) * 0.22
                if abs(shown - target) < 0.02 { shown = target } else { fading = true }
                labelShown[i] = shown
            }
            layer.position = CGPoint(x: box.midX, y: box.midY)
            layer.opacity = shown
        }
        return fading
    }

    /// Who gets a name first when names would overlap.
    private func rank(_ kind: HubBrainSimulation.Kind, _ i: Int) -> Int {
        if i == focus { return 0 }
        switch kind {
        case .hub: return 1
        case .project: return 2
        default: return lit.contains(i) ? 3 : 4
        }
    }

    // MARK: Touches

    /// The dot under `point`, if any; small dots get a generous finger-sized target.
    private func node(at point: CGPoint, within limit: CGFloat) -> Int? {
        guard let simulation, points.count == simulation.nodes.count else { return nil }
        var best: Int?, bestDistance = limit
        let kinds = simulation.kinds
        for i in kinds.indices where !dots[i].isHidden {
            let distance = hypot(points[i].x - point.x, points[i].y - point.y) - (kinds[i] == .hub ? 6 : 0)
            if distance < bestDistance { best = i; bestDistance = distance }
        }
        return best
    }

    private func world(_ point: CGPoint) -> (Double, Double) {
        guard let simulation else { return (0, 0) }
        let s = max(0.0001, (simulation.scale > 0 ? simulation.scale : 1) * zoom)
        return (Double(simulation.center.x + (point.x - bounds.width / 2 - pan.x) / s),
                Double(simulation.center.y + (point.y - bounds.height / 2 - pan.y) / s))
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        // Only where a gesture starts: a second finger must not move the held dot.
        if (gestureRecognizer === hold || gestureRecognizer === panner), gestureRecognizer.state == .possible,
           hold.state == .possible || hold.state == .failed {
            touchStart = touch.location(in: self)
        }
        return true
    }

    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === hold {
            // Only a touch that lands on a dot picks it up; elsewhere the page scrolls.
            return node(at: touchStart, within: allowsPan ? 26 : 22) != nil
        }
        if gestureRecognizer === panner {
            return node(at: touchStart, within: 26) == nil
        }
        // While a dot is held, the page behind must not scroll.
        if gestureRecognizer is UIPanGestureRecognizer, hold.state == .began || hold.state == .changed {
            return false
        }
        return super.gestureRecognizerShouldBegin(gestureRecognizer)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        // Pinch and pan together; a held note and a pinch together.
        (gestureRecognizer === pinch && (other === panner || other === hold)) ||
            (other === pinch && (gestureRecognizer === panner || gestureRecognizer === hold))
    }

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        let hit = node(at: recognizer.location(in: self), within: 24)
        tap?(hit.flatMap { simulation?.nodes[$0].id })
    }

    @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
        guard let simulation else { return }
        let location = recognizer.location(in: self)
        switch recognizer.state {
        case .began:
            guard let index = node(at: touchStart, within: allowsPan ? 26 : 22) else { return }
            heldMoved = false
            glide = .zero
            simulation.hold(index, at: simulation.position(index))
            wake()
        case .changed:
            guard simulation.pinned != nil else { return }
            if !heldMoved, hypot(location.x - touchStart.x, location.y - touchStart.y) > 6 {
                heldMoved = true
                userMoved = true
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
            if heldMoved {
                // The dot keeps the same offset from the finger it had when picked up.
                let start = world(touchStart), now = world(location)
                let origin = simulation.position(simulation.pinned!)
                simulation.move(to: (origin.0 + now.0 - start.0, origin.1 + now.1 - start.1))
                touchStart = location
            }
            wake()
        case .ended, .cancelled, .failed:
            let index = simulation.pinned
            simulation.release()
            wake(for: 6)
            // Held without moving: a tap on that dot.
            if recognizer.state == .ended, !heldMoved, let index { tap?(simulation.nodes[index].id) }
            heldMoved = false
        default:
            break
        }
    }

    @objc private func panned(_ recognizer: UIPanGestureRecognizer) {
        switch recognizer.state {
        case .began:
            panStart = pan
            glide = .zero
            userMoved = true
            wake()
        case .changed:
            let move = recognizer.translation(in: self)
            pan = CGPoint(x: panStart.x + move.x, y: panStart.y + move.y)
            wake()
        case .ended:
            // Flicks keep gliding and slow down, like scrolling.
            let velocity = recognizer.velocity(in: self)
            glide = hypot(velocity.x, velocity.y) > 120 ? velocity : .zero
            wake()
        default:
            break
        }
    }

    @objc private func pinched(_ recognizer: UIPinchGestureRecognizer) {
        switch recognizer.state {
        case .began:
            pinchStartZoom = zoom
            glide = .zero
            userMoved = true
        case .changed:
            let next = min(5, max(0.4, pinchStartZoom * recognizer.scale))
            if allowsPan, recognizer.numberOfTouches >= 2 {
                // Zoom around the fingers: the point under them stays put.
                let anchor = recognizer.location(in: self)
                let ratio = next / zoom
                let fromCenter = CGPoint(x: anchor.x - bounds.width / 2 - pan.x, y: anchor.y - bounds.height / 2 - pan.y)
                pan.x -= fromCenter.x * (ratio - 1)
                pan.y -= fromCenter.y * (ratio - 1)
                panStart = pan
                if panner.state == .changed { panner.setTranslation(.zero, in: self) }
            }
            zoom = next
            wake()
        default:
            wake()
        }
    }
}

/// Keeps the display link from holding the view alive.
private final class HubBrainFrameTarget: NSObject {
    weak var view: HubBrainLayerView?
    init(_ view: HubBrainLayerView) { self.view = view }
    @objc func tick(_ link: CADisplayLink) {
        guard let view else { link.invalidate(); return }
        view.onFrame(link)
    }
}
