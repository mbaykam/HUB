#if canImport(ScreenCaptureKit)
import UIKit
import ScreenCaptureKit
import CoreImage
import ImageIO
import HubNative

/// Native-only adapter. Its caller supplies an owned voice context; only Apple's
/// picker grants capture. It neither uploads frames nor adds audio inputs.
@available(iOS 27.0, *)
@MainActor final class HubScreenCaptureSession: NSObject, SCContentSharingPickerObserver, SCStreamOutput, SCStreamDelegate {
    private let context: HubVoiceAttachmentContext
    private let owner: HubScreenOwner
    private let frames = HubScreenFrames()
    private var stream: SCStream?
    private var generation: UUID?
    private var observing = false
    private var lockObserver: NSObjectProtocol?
    private let queue = DispatchQueue(label: "hub.screen.video", qos: .userInitiated)
    private(set) var status = "Screen sharing is off."
    var changed: (() -> Void)?
    init(context: HubVoiceAttachmentContext) throws {
        self.context = context
        owner = try HubScreenOwner(server: context.server, sessionID: context.sessionID, callID: context.callID)
        super.init()
        lockObserver = NotificationCenter.default.addObserver(forName: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.stop() }
        }
    }
    deinit { if let lockObserver { NotificationCenter.default.removeObserver(lockObserver) } }
    private func update(_ value: String) { status = value; changed?() }
    func presentSystemPicker() {
        guard context.stillOwned(), UIApplication.shared.isProtectedDataAvailable else { update("Unlock this iPhone and connect voice first."); return }
        let picker = SCContentSharingPicker.shared
        if !observing { picker.add(self); observing = true }
        picker.isActive = true
        update("Choose what to share in the system picker. Nothing is sent to HUB automatically.")
        picker.present()
    }
    func stop() {
        let old = stream; stream = nil
        if let generation { Task { await frames.stop(generation: generation) } }
        generation = nil
        if observing { SCContentSharingPicker.shared.remove(self); SCContentSharingPicker.shared.isActive = false; observing = false }
        if let old { Task { try? await old.stopCapture() } }
        update("Screen sharing stopped. Your voice conversation can continue.")
    }
    func snapshotForExplicitReview() async throws -> HubScreenFrame {
        guard context.stillOwned(), let generation, stream != nil else { stop(); throw HubAttachmentError.callEnded }
        return try await frames.snapshot(generation: generation, owner: owner)
    }
    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        Task { @MainActor in if self.stream == nil { self.stop() } }
    }
    nonisolated func contentSharingPickerStartDidFailWithError(_ error: Error) {
        Task { @MainActor in self.stop(); self.update("Screen sharing could not start. Retry the system picker.") }
    }
    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        Task { @MainActor in
            guard self.context.stillOwned() else { self.stop(); return }
            let old = self.stream; self.stream = nil
            if let generation = self.generation { await self.frames.stop(generation: generation) }
            self.generation = nil
            if let old { try? await old.stopCapture() }
            do {
                let config = SCStreamConfiguration()
                config.width = 1440; config.height = 1440; config.scalesToFit = true; config.preservesAspectRatio = true
                config.minimumFrameInterval = CMTime(value: 2, timescale: 1); config.queueDepth = 3
                config.capturesAudio = false; config.captureMicrophone = false
                let active = SCStream(filter: filter, configuration: config, delegate: self)
                try active.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.queue)
                self.generation = await self.frames.beginAfterSystemConsent(owner: self.owner)
                self.stream = active
                try await active.startCapture()
                guard self.stream === active, self.context.stillOwned() else { self.stop(); return }
                self.update("Screen capture is active. Frames stay on this iPhone until explicitly shared.")
            } catch { self.stop(); self.update("Capture could not start. Voice was not stopped; retry sharing.") }
        }
    }
    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor in if self.stream === stream { self.stop() } }
    }
    nonisolated func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferIsValid(buffer), let pixels = CMSampleBufferGetImageBuffer(buffer) else { return }
        // Preserve capture age across queueing/conversion instead of assigning
        // a new timestamp when a delayed callback finally reaches the frame gate.
        let elapsed = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), CMSampleBufferGetPresentationTimeStamp(buffer)))
        guard elapsed.isFinite, elapsed >= 0, elapsed <= HubScreenFrames.maximumAge else { return }
        let capturedAt = Date().addingTimeInterval(-elapsed)
        let image = CIImage(cvPixelBuffer: pixels)
        let scale = min(1, 1440 / max(image.extent.width, image.extent.height))
        let sized = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let color = CGColorSpaceCreateDeviceRGB()
        guard let jpeg = CIContext().jpegRepresentation(of: sized, colorSpace: color, options: [.lossyCompressionQuality: 0.8]) else { return }
        Task { @MainActor in
            guard self.stream === stream, let generation = self.generation else { return }
            guard self.context.stillOwned() else { self.stop(); return }
            do { try await self.frames.accept(jpeg: jpeg, generation: generation, capturedAt: capturedAt); self.changed?() }
            catch { await self.frames.pause(generation: generation); self.update("Waiting for a valid fresh frame. Restart sharing if needed.") }
        }
    }
}
#endif
