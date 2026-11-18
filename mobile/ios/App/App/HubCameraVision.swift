import SwiftUI
import UIKit
import ARKit
import SceneKit
import Vision
import HubNative

/// An overlay as drawn this display frame, in view points.
struct HubProjectedOverlay: Identifiable, Equatable {
    let id: String
    let style: HubCameraOverlay.Style
    let label: String?
    let step: Int?
    var point: CGPoint
    var rect: CGRect?
    var radius: CGFloat
    var visible: Bool
    /// Where the off-screen pointer sits, and the direction to the target.
    var edgePoint: CGPoint
    var edgeAngle: Double
}

/// A recognised thing as drawn this display frame, for "Show what HUB sees".
struct HubProjectedMark: Identifiable, Equatable {
    let id: Int
    let label: String
    let rect: CGRect
}

/// The live camera of a video call. Apple's AR tracking keeps every number
/// and overlay attached to the real place; Apple's on-device vision finds
/// text, panels, objects and the user's fingertip. About once a second a
/// marked snapshot goes to HUB, which shows the model only what it asks for.
@MainActor
final class HubCameraVision: NSObject, ObservableObject, ARSessionDelegate {
    @Published private(set) var overlays: [HubProjectedOverlay] = []
    @Published private(set) var marks: [HubProjectedMark] = []
    @Published private(set) var note: String?
    @Published private(set) var status = "Starting the camera…"
    @Published private(set) var hint: String?
    @Published private(set) var paused = false
    @Published var showMarks = false
    @Published var voice: HubVoiceCallSummary?

    let fixture: Bool
    private let context: HubVoiceAttachmentContext?
    private var live: HubLiveScreenSharing?
    private weak var view: ARSCNView?
    private var known: [Int: Known] = [:]
    private var pinned: [Pinned] = []
    private var poses: [UUID: Pose] = [:]
    private var sequences: [Int: Pose] = [:]
    private var applied: String?
    private var timer: Timer?
    private var link: CADisplayLink?
    private var detecting = false
    private var lastUpload = Date.distantPast
    private var shareID = UUID()
    private var fixtureItems: [HubProjectedOverlay] = []

    private struct Known {
        let id: Int
        let kind: Int
        var label: String
        var text: String?
        var world: simd_float3
        var size: CGSize
        var seen: Date
    }

    private struct Pinned {
        let id: String
        let item: HubCameraOverlay.Item
        var center: simd_float3
        var corners: [simd_float3]?
        var radius: Float
        let mark: Int?
    }

    /// The camera as it was for one uploaded frame, so a point the model chose
    /// on that frame becomes a ray in the room even after the phone moved.
    private struct Pose {
        let transform: simd_float4x4
        let intrinsics: simd_float3x3
        let resolution: CGSize
        let viewToImage: CGAffineTransform
    }

    struct Detection: Sendable {
        let box: CGRect
        let label: String
        let text: String?
        let kind: Int // 0 text, 1 panel, 2 object, 3 fingertip
    }

    init(context: HubVoiceAttachmentContext?, fixture: Bool = false) {
        self.context = context
        self.fixture = fixture
        super.init()
        guard let context, !fixture else {
            status = fixture ? "Camera preview" : "Start a voice call to share the camera."
            if fixture { note = "Plug the cable into the yellow WAN port" }
            return
        }
        let sharing = HubLiveScreenSharing(consent: { id, start in
            try await context.voiceAPI.screenConsent(callId: context.callID, shareID: id, start: start)
        }, upload: { [weak self] id, sequence, frame in
            let status = try await context.voiceAPI.cameraFrame(callId: context.callID, shareID: id, sequence: sequence, frame: frame)
            await self?.received(status, frame: frame.id, sequence: sequence)
        }, owned: context.stillOwned)
        sharing.changed = { [weak self] in self?.status = self?.live?.status ?? "" }
        live = sharing
    }

    // MARK: Lifecycle

    func attach(_ view: ARSCNView) {
        self.view = view
        view.session.delegate = self
        start()
    }

    func start() {
        guard !fixture else { return }
        guard ARWorldTrackingConfiguration.isSupported else {
            status = "The live camera needs an iPhone with motion tracking."
            return
        }
        guard let view else { return }
        let configuration = ARWorldTrackingConfiguration()
        configuration.planeDetection = [.horizontal, .vertical]
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) { configuration.frameSemantics.insert(.sceneDepth) }
        view.session.run(configuration, options: paused ? [] : [.resetTracking, .removeExistingAnchors])
        paused = false
        shareID = UUID()
        live?.beginAfterSystemConsent(shareID)
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        if link == nil {
            let link = CADisplayLink(target: self, selector: #selector(step))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
            link.add(to: .main, forMode: .common)
            self.link = link
        }
    }

    /// Stops sharing; the camera view stays for a moment while it closes.
    func stop() {
        timer?.invalidate(); timer = nil
        link?.invalidate(); link = nil
        live?.stop()
        view?.session.pause()
    }

    func togglePause() {
        if paused { start(); return }
        paused = true
        timer?.invalidate(); timer = nil
        live?.stop()
        view?.session.pause()
        status = "Camera paused. HUB no longer receives frames."
    }

    func clearOverlays() {
        pinned.removeAll()
        note = nil
        if fixture { fixtureItems = [] }
        overlays = []
    }

    // MARK: Seeing

    private func tick() {
        guard !detecting, !paused, let view, view.bounds.width > 0, let frame = view.session.currentFrame else { return }
        if case .notAvailable = frame.camera.trackingState { return }
        let size = view.bounds.size
        let orientation = view.window?.windowScene?.interfaceOrientation ?? .portrait
        let pose = Pose(transform: frame.camera.transform, intrinsics: frame.camera.intrinsics, resolution: frame.camera.imageResolution,
                        viewToImage: frame.displayTransform(for: orientation, viewportSize: size).inverted())
        // What the user sees, so the model's coordinates are screen coordinates.
        guard let image = view.snapshot().cgImage else { return }
        let capturedAt = Date()
        let upload = live?.active == true && capturedAt.timeIntervalSince(lastUpload) >= 1
        detecting = true
        Task.detached(priority: .userInitiated) { [weak self] in
            let found = HubCameraVision.detect(image)
            await self?.detected(found, pose: pose, image: image, size: size, upload: upload, capturedAt: capturedAt)
        }
    }

    private func detected(_ found: [Detection], pose: Pose, image: CGImage, size: CGSize, upload: Bool, capturedAt: Date) {
        detecting = false
        guard view != nil, !paused else { return }
        let now = Date()
        var claimed = Set<Int>()
        for detection in found {
            let rect = CGRect(x: detection.box.minX * size.width, y: detection.box.minY * size.height,
                              width: detection.box.width * size.width, height: detection.box.height * size.height)
            let center = CGPoint(x: rect.midX, y: rect.midY)
            let reach = rect.insetBy(dx: -max(14, rect.width * 0.3), dy: -max(14, rect.height * 0.3))
            let match = known.values
                .filter { !claimed.contains($0.id) && $0.kind == detection.kind }
                .compactMap { item in screenPoint(item.world).map { (item, $0) } }
                .filter { reach.contains($0.1) }
                .min { hypot($0.1.x - center.x, $0.1.y - center.y) < hypot($1.1.x - center.x, $1.1.y - center.y) }
            if let match {
                let item = match.0
                var updated = item
                if let world = worldPoint(at: center) { updated.world = simd_mix(item.world, world, simd_float3(repeating: 0.35)) }
                updated.size = rect.size; updated.seen = now; updated.label = detection.label
                if let text = detection.text { updated.text = text }
                known[item.id] = updated
                claimed.insert(item.id)
            } else if let world = worldPoint(at: center), let id = (1...99).first(where: { known[$0] == nil }) {
                known[id] = Known(id: id, kind: detection.kind, label: detection.label, text: detection.text, world: world, size: rect.size, seen: now)
                claimed.insert(id)
            }
        }
        // Forget what has been gone a while, unless an overlay is pinned to it.
        let held = Set(pinned.compactMap(\.mark))
        known = known.filter { now.timeIntervalSince($0.value.seen) < 8 || held.contains($0.key) }
        guard upload else { return }
        lastUpload = now
        let scene = visibleScene(size: size, now: now)
        let id = UUID()
        poses[id] = pose
        if poses.count > 12, let oldest = poses.keys.first { poses.removeValue(forKey: oldest) }
        Task.detached(priority: .utility) { [weak self] in
            guard let rendered = HubCameraVision.render(image, marks: scene.marks) else { return }
            let frame = HubScreenFrame(id: id, jpeg: rendered.jpeg, capturedAt: capturedAt, width: rendered.width, height: rendered.height, scene: scene)
            await self?.live?.offer(frame)
        }
    }

    /// The numbered things in view right now, as fractions of the screen.
    private func visibleScene(size: CGSize, now: Date) -> HubVisionScene {
        let bounds = CGRect(origin: .zero, size: size)
        let marks: [HubVisionScene.Mark] = known.values.sorted { $0.id < $1.id }.compactMap { item in
            guard now.timeIntervalSince(item.seen) < 2.5, let point = screenPoint(item.world), bounds.contains(point) else { return nil }
            let rect = CGRect(x: point.x - item.size.width / 2, y: point.y - item.size.height / 2, width: item.size.width, height: item.size.height)
                .intersection(bounds)
            guard !rect.isNull, rect.width > 2, rect.height > 2 else { return nil }
            return .init(id: item.id, label: item.label, text: item.text,
                         x: rect.minX / size.width, y: rect.minY / size.height, width: rect.width / size.width, height: rect.height / size.height)
        }
        return HubVisionScene(marks: Array(marks.prefix(20)))
    }

    private func received(_ status: HubScreenStatus, frame: UUID, sequence: Int) {
        if let pose = poses.removeValue(forKey: frame) {
            sequences[sequence] = pose
            if sequences.count > 30, let oldest = sequences.keys.min() { sequences.removeValue(forKey: oldest) }
        }
        guard let overlay = status.overlay, overlay.id != applied else { return }
        applied = overlay.id
        apply(overlay)
    }

    // MARK: Overlays

    private func apply(_ overlay: HubCameraOverlay) {
        if overlay.clear { pinned.removeAll() }
        note = overlay.note.isEmpty ? (overlay.drawable.isEmpty ? nil : note) : overlay.note
        if overlay.drawable.isEmpty && overlay.clear { note = nil }
        let pose = sequences[overlay.sequence]
        for (index, item) in overlay.drawable.enumerated() {
            if let pin = resolve(item, pose: pose, id: "\(overlay.id)-\(index)") { pinned.append(pin) }
        }
        pinned = Array(pinned.suffix(12))
        if !overlay.drawable.isEmpty { UIImpactFeedbackGenerator(style: .soft).impactOccurred() }
    }

    private func resolve(_ item: HubCameraOverlay.Item, pose: Pose?, id: String) -> Pinned? {
        guard let view else { return nil }
        let size = view.bounds.size
        if let mark = item.mark {
            guard let target = known[mark] else { return nil }
            let corners = cornersAround(target.world, width: target.size.width + 12, height: target.size.height + 12)
            let radius = worldRadius(at: target.world, points: max(target.size.width, target.size.height) / 2 + 10)
            return Pinned(id: id, item: item, center: target.world, corners: corners, radius: radius, mark: mark)
        }
        guard let x = item.x, let y = item.y else { return nil }
        let normalized = CGPoint(x: x, y: y)
        let center: simd_float3?
        if let pose { center = hit(pose, normalized) }
        else { center = worldPoint(at: CGPoint(x: x * size.width, y: y * size.height)) }
        guard let center else { return nil }
        var corners: [simd_float3]?
        if let width = item.width, let height = item.height {
            let points = [CGPoint(x: x, y: y), CGPoint(x: x + width, y: y), CGPoint(x: x + width, y: y + height), CGPoint(x: x, y: y + height)]
            if let pose {
                let found = points.compactMap { onPlane(pose, $0, through: center) }
                corners = found.count == 4 ? found : nil
            } else {
                corners = cornersAround(center, width: width * size.width, height: height * size.height)
            }
        }
        return Pinned(id: id, item: item, center: center, corners: corners, radius: worldRadius(at: center, points: 30), mark: nil)
    }

    /// A ray through a point of an earlier frame, from where the camera was then.
    private func ray(_ pose: Pose, _ normalized: CGPoint) -> (origin: simd_float3, direction: simd_float3) {
        let image = normalized.applying(pose.viewToImage)
        let px = Float(image.x * pose.resolution.width), py = Float(image.y * pose.resolution.height)
        let k = pose.intrinsics
        let local = simd_float4((px - k.columns.2.x) / k.columns.0.x, -(py - k.columns.2.y) / k.columns.1.y, -1, 0)
        let world = pose.transform * local
        return (pose.transform.position, simd_normalize(simd_float3(world.x, world.y, world.z)))
    }

    private func hit(_ pose: Pose, _ normalized: CGPoint) -> simd_float3? {
        guard let view else { return nil }
        let line = ray(pose, normalized)
        let query = ARRaycastQuery(origin: line.origin, direction: line.direction, allowing: .estimatedPlane, alignment: .any)
        if let result = view.session.raycast(query).first { return result.worldTransform.position }
        // No surface found: the depth of the nearest recognised thing, or arm's length.
        let depth = known.values.map { simd_length($0.world - line.origin) }.min() ?? 0.8
        return line.origin + line.direction * min(3, max(0.3, depth))
    }

    private func onPlane(_ pose: Pose, _ normalized: CGPoint, through center: simd_float3) -> simd_float3? {
        let line = ray(pose, normalized)
        let forward = -simd_float3(pose.transform.columns.2.x, pose.transform.columns.2.y, pose.transform.columns.2.z)
        let along = simd_dot(line.direction, forward)
        guard along > 0.01 else { return nil }
        return line.origin + line.direction * (simd_dot(center - line.origin, forward) / along)
    }

    private func worldPoint(at point: CGPoint) -> simd_float3? {
        guard let view else { return nil }
        if let query = view.raycastQuery(from: point, allowing: .estimatedPlane, alignment: .any),
           let result = view.session.raycast(query).first { return result.worldTransform.position }
        guard let camera = view.session.currentFrame?.camera.transform.position else { return nil }
        let near = simd_float3(view.unprojectPoint(SCNVector3(Float(point.x), Float(point.y), 0)))
        let far = simd_float3(view.unprojectPoint(SCNVector3(Float(point.x), Float(point.y), 1)))
        return camera + simd_normalize(far - near) * 0.8
    }

    private func screenPoint(_ world: simd_float3) -> CGPoint? {
        guard let view, let camera = view.session.currentFrame?.camera.transform else { return nil }
        let forward = -simd_float3(camera.columns.2.x, camera.columns.2.y, camera.columns.2.z)
        guard simd_dot(world - camera.position, forward) > 0.05 else { return nil }
        let projected = view.projectPoint(SCNVector3(world))
        return CGPoint(x: CGFloat(projected.x), y: CGFloat(projected.y))
    }

    private func cornersAround(_ world: simd_float3, width: CGFloat, height: CGFloat) -> [simd_float3]? {
        guard let view else { return nil }
        let center = view.projectPoint(SCNVector3(world))
        let offsets: [(CGFloat, CGFloat)] = [(-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)]
        return offsets.map { dx, dy in
            simd_float3(view.unprojectPoint(SCNVector3(center.x + Float(dx * width), center.y + Float(dy * height), center.z)))
        }
    }

    private func worldRadius(at world: simd_float3, points: CGFloat) -> Float {
        guard let view else { return 0.05 }
        let center = view.projectPoint(SCNVector3(world))
        let edge = simd_float3(view.unprojectPoint(SCNVector3(center.x + Float(points), center.y, center.z)))
        return max(0.01, simd_length(edge - world))
    }

    /// Projects every pinned overlay for this display frame.
    @objc private func step() {
        guard let view, view.bounds.width > 0, let camera = view.session.currentFrame?.camera.transform else { return }
        let size = view.bounds.size, bounds = CGRect(origin: .zero, size: size)
        let position = camera.position
        let forward = -simd_float3(camera.columns.2.x, camera.columns.2.y, camera.columns.2.z)
        let right = simd_float3(camera.columns.0.x, camera.columns.0.y, camera.columns.0.z)
        overlays = pinned.map { pin in
            let world = pin.mark.flatMap { known[$0]?.world } ?? pin.center
            let shift = world - pin.center
            let ahead = simd_dot(world - position, forward) > 0.05
            let projected = view.projectPoint(SCNVector3(world))
            let point = CGPoint(x: CGFloat(projected.x), y: CGFloat(projected.y))
            var rect: CGRect?
            if ahead, let corners = pin.corners {
                let points = corners.map { view.projectPoint(SCNVector3($0 + shift)) }
                let xs = points.map { CGFloat($0.x) }, ys = points.map { CGFloat($0.y) }
                if let minX = xs.min(), let maxX = xs.max(), let minY = ys.min(), let maxY = ys.max() {
                    rect = CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
                }
            }
            let edge = view.projectPoint(SCNVector3(world + right * pin.radius))
            let radius = min(140, max(18, abs(CGFloat(edge.x) - point.x)))
            let visible = ahead && bounds.insetBy(dx: -10, dy: -10).contains(point)
            let pointer = Self.edge(toward: point, ahead: ahead, in: size)
            return HubProjectedOverlay(id: pin.id, style: pin.item.style, label: pin.item.label, step: pin.item.step,
                                       point: point, rect: rect, radius: radius, visible: visible,
                                       edgePoint: pointer.point, edgeAngle: pointer.angle)
        }
        if showMarks {
            let now = Date()
            marks = known.values.sorted { $0.id < $1.id }.compactMap { item in
                guard now.timeIntervalSince(item.seen) < 2.5, let point = screenPoint(item.world), bounds.contains(point) else { return nil }
                return HubProjectedMark(id: item.id, label: item.label,
                                        rect: CGRect(x: point.x - item.size.width / 2, y: point.y - item.size.height / 2, width: item.size.width, height: item.size.height))
            }
        } else if !marks.isEmpty { marks = [] }
    }

    /// Where a pointer to an off-screen target sits on the screen's edge.
    static func edge(toward point: CGPoint, ahead: Bool, in size: CGSize) -> (point: CGPoint, angle: Double) {
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        var dx = point.x - center.x, dy = point.y - center.y
        if !ahead { dx = -dx; dy = -dy }
        if abs(dx) < 0.001 && abs(dy) < 0.001 { dy = 1 }
        let angle = atan2(Double(dy), Double(dx))
        let inset = CGSize(width: size.width / 2 - 44, height: size.height / 2 - 120)
        let scale = min(inset.width / max(0.001, abs(dx)), inset.height / max(0.001, abs(dy)))
        return (CGPoint(x: center.x + dx * scale, y: center.y + dy * scale), angle)
    }

    // MARK: ARSessionDelegate

    nonisolated func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        let text: String?
        switch camera.trackingState {
        case .normal: text = nil
        case .notAvailable: text = "Camera tracking is unavailable."
        case .limited(.initializing): text = "Move your phone slowly to get started."
        case .limited(.excessiveMotion): text = "Move a little slower."
        case .limited(.insufficientFeatures): text = "Point at something with more light or detail."
        case .limited(.relocalizing): text = "Finding your place again…"
        case .limited: text = "Move your phone slowly."
        }
        Task { @MainActor in self.hint = text }
    }

    nonisolated func sessionWasInterrupted(_ session: ARSession) {
        Task { @MainActor in self.hint = "The camera was interrupted." }
    }

    nonisolated func sessionInterruptionEnded(_ session: ARSession) {
        Task { @MainActor in self.hint = nil }
    }

    // MARK: On-device vision (off the main thread)

    nonisolated static func detect(_ full: CGImage) -> [Detection] {
        let image = scaled(full, longest: 960) ?? full
        let text = VNRecognizeTextRequest()
        text.recognitionLevel = .fast
        text.usesLanguageCorrection = false
        text.minimumTextHeight = 0.018
        let panels = VNDetectRectanglesRequest()
        panels.maximumObservations = 4
        panels.minimumConfidence = 0.75
        panels.minimumSize = 0.12
        let objects = VNGenerateObjectnessBasedSaliencyImageRequest()
        let hands = VNDetectHumanHandPoseRequest()
        hands.maximumHandCount = 1
        let handler = VNImageRequestHandler(cgImage: image, orientation: .up)
        try? handler.perform([text, panels, objects, hands])
        // Vision's boxes start at the bottom left; the screen's at the top left.
        func flip(_ box: CGRect) -> CGRect { CGRect(x: box.minX, y: 1 - box.maxY, width: box.width, height: box.height) }
        var found: [Detection] = []
        let lines = (text.results ?? []).sorted { $0.boundingBox.width * $0.boundingBox.height > $1.boundingBox.width * $1.boundingBox.height }
        for line in lines.prefix(8) {
            guard let words = line.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines), words.count >= 2 else { continue }
            found.append(Detection(box: flip(line.boundingBox), label: "Text", text: String(words.prefix(80)), kind: 0))
        }
        var regions: [(CGRect, Int)] = (panels.results ?? []).map { (flip($0.boundingBox), 1) }
        if let saliency = objects.results?.first {
            regions += (saliency.salientObjects ?? []).prefix(4).map { (flip($0.boundingBox), 2) }
        }
        for (box, kind) in regions {
            let classify = VNClassifyImageRequest()
            classify.regionOfInterest = CGRect(x: box.minX, y: 1 - box.maxY, width: box.width, height: box.height)
            try? VNImageRequestHandler(cgImage: image, orientation: .up).perform([classify])
            let name = classify.results?.first(where: { $0.confidence > 0.25 })?.identifier.replacingOccurrences(of: "_", with: " ")
            let label = name.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? (kind == 1 ? "Panel" : "Object")
            found.append(Detection(box: box, label: label, text: nil, kind: kind))
        }
        if let hand = hands.results?.first, let tip = try? hand.recognizedPoint(.indexTip), tip.confidence > 0.5 {
            let point = CGPoint(x: tip.location.x, y: 1 - tip.location.y)
            found.append(Detection(box: CGRect(x: point.x - 0.03, y: point.y - 0.02, width: 0.06, height: 0.04), label: "Fingertip", text: nil, kind: 3))
        }
        return found
    }

    nonisolated static func scaled(_ image: CGImage, longest: CGFloat) -> CGImage? {
        let width = CGFloat(image.width), height = CGFloat(image.height)
        let factor = min(1, longest / max(width, height))
        let size = CGSize(width: (width * factor).rounded(), height: (height * factor).rounded())
        guard let context = CGContext(data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(origin: .zero, size: size))
        return context.makeImage()
    }

    /// The frame HUB receives: what the user sees, with each recognised thing
    /// numbered and a faint 4x4 grid (columns A-D, rows 1-4) for everything else.
    nonisolated static func render(_ image: CGImage, marks: [HubVisionScene.Mark]) -> (jpeg: Data, width: Int, height: Int)? {
        let width = CGFloat(image.width), height = CGFloat(image.height)
        let factor = min(1, 1600 / max(width, height))
        let size = CGSize(width: (width * factor).rounded(), height: (height * factor).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let rendered = UIGraphicsImageRenderer(size: size, format: format).image { renderer in
            let context = renderer.cgContext
            UIImage(cgImage: image).draw(in: CGRect(origin: .zero, size: size))
            let unit = max(size.width, size.height) / 1600
            // The grid: faint quarter lines and edge labels.
            context.setStrokeColor(UIColor.white.withAlphaComponent(0.22).cgColor)
            context.setLineWidth(1.5 * unit)
            for index in 1...3 {
                let x = size.width * CGFloat(index) / 4, y = size.height * CGFloat(index) / 4
                context.move(to: CGPoint(x: x, y: 0)); context.addLine(to: CGPoint(x: x, y: size.height))
                context.move(to: CGPoint(x: 0, y: y)); context.addLine(to: CGPoint(x: size.width, y: y))
            }
            context.strokePath()
            let gridFont = UIFont.systemFont(ofSize: 22 * unit, weight: .bold)
            for (index, letter) in ["A", "B", "C", "D"].enumerated() {
                Self.tag(letter, at: CGPoint(x: size.width * (CGFloat(index) + 0.5) / 4, y: 22 * unit), font: gridFont, fill: UIColor.black.withAlphaComponent(0.55))
                Self.tag("\(index + 1)", at: CGPoint(x: 22 * unit, y: size.height * (CGFloat(index) + 0.5) / 4), font: gridFont, fill: UIColor.black.withAlphaComponent(0.55))
            }
            // Numbered marks: a thin outline and a bright badge.
            let badgeFont = UIFont.systemFont(ofSize: 26 * unit, weight: .heavy)
            for mark in marks {
                let box = CGRect(x: mark.x * size.width, y: mark.y * size.height, width: mark.width * size.width, height: mark.height * size.height)
                let outline = UIBezierPath(roundedRect: box, cornerRadius: 8 * unit)
                outline.lineWidth = 3 * unit
                UIColor.black.withAlphaComponent(0.5).setStroke(); outline.stroke()
                outline.lineWidth = 1.8 * unit
                UIColor(red: 1, green: 0.85, blue: 0.2, alpha: 1).setStroke(); outline.stroke()
                let anchor = CGPoint(x: min(size.width - 24 * unit, max(24 * unit, box.minX + 4 * unit)), y: min(size.height - 24 * unit, max(24 * unit, box.minY + 4 * unit)))
                Self.tag("\(mark.id)", at: anchor, font: badgeFont, fill: UIColor(red: 1, green: 0.85, blue: 0.2, alpha: 1), color: .black)
            }
        }
        guard let jpeg = rendered.jpegData(compressionQuality: 0.6) else { return nil }
        return (jpeg, Int(size.width), Int(size.height))
    }

    nonisolated private static func tag(_ text: String, at center: CGPoint, font: UIFont, fill: UIColor, color: UIColor = .white) {
        let label = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
        let measured = label.size()
        let side = max(measured.width + font.pointSize * 0.6, measured.height + font.pointSize * 0.2)
        let rect = CGRect(x: center.x - side / 2, y: center.y - (measured.height + font.pointSize * 0.2) / 2, width: side, height: measured.height + font.pointSize * 0.2)
        fill.setFill()
        UIBezierPath(roundedRect: rect, cornerRadius: rect.height / 2).fill()
        label.draw(at: CGPoint(x: rect.midX - measured.width / 2, y: rect.midY - measured.height / 2))
    }

    // MARK: Simulator preview

    /// Every overlay style laid out over a stand-in scene, so the design can
    /// be reviewed without a camera.
    func layoutFixture(size: CGSize) {
        guard fixture, fixtureItems.isEmpty, size.width > 0 else { return }
        func item(_ id: String, _ style: HubCameraOverlay.Style, _ x: CGFloat, _ y: CGFloat, label: String?, step: Int? = nil, rect: CGRect? = nil, radius: CGFloat = 34) -> HubProjectedOverlay {
            let point = CGPoint(x: x * size.width, y: y * size.height)
            return HubProjectedOverlay(id: id, style: style, label: label, step: step, point: point, rect: rect, radius: radius, visible: true,
                                       edgePoint: point, edgeAngle: 0)
        }
        let box = CGRect(x: size.width * 0.18, y: size.height * 0.24, width: size.width * 0.5, height: size.height * 0.14)
        let offscreen = Self.edge(toward: CGPoint(x: size.width * 1.4, y: size.height * 0.55), ahead: true, in: size)
        fixtureItems = [
            item("box", .box, box.midX / size.width, box.midY / size.height, label: "Router", rect: box),
            item("arrow", .arrow, 0.62, 0.36, label: "WAN port"),
            item("ring", .circle, 0.3, 0.52, label: "Power light", radius: 30),
            item("step1", .step, 0.36, 0.66, label: "Unplug", step: 1),
            item("step2", .step, 0.64, 0.7, label: "Wait 10 s", step: 2),
            item("label", .label, 0.5, 0.82, label: "Reset button"),
            HubProjectedOverlay(id: "away", style: .circle, label: "Modem", step: nil, point: CGPoint(x: size.width * 1.4, y: size.height * 0.55),
                                rect: nil, radius: 30, visible: false, edgePoint: offscreen.point, edgeAngle: offscreen.angle),
        ]
        overlays = fixtureItems
        marks = [HubProjectedMark(id: 1, label: "Router", rect: box), HubProjectedMark(id: 2, label: "Text", rect: CGRect(x: size.width * 0.22, y: size.height * 0.45, width: 120, height: 30))]
    }
}

private extension simd_float4x4 {
    var position: simd_float3 { simd_float3(columns.3.x, columns.3.y, columns.3.z) }
}
