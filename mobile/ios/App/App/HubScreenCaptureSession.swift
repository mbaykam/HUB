#if canImport(ScreenCaptureKit)
import UIKit
import ScreenCaptureKit
import CoreImage
import ImageIO
import HubNative

// CIContext is reusable. A nonblocking lock also bounds work if a delegate is
// ever delivered concurrently; most frames are dropped before JPEG conversion.
private final class HubScreenJPEGEncoder: @unchecked Sendable {
    private let lock = NSLock()
    private let context = CIContext()
    private var last = Date.distantPast
    func encode(_ pixels: CVPixelBuffer) -> Data? {
        guard lock.try() else { return nil }; defer { lock.unlock() }
        guard Date().timeIntervalSince(last) >= 2 else { return nil }; last = Date()
        let image = CIImage(cvPixelBuffer: pixels)
        guard image.extent.width > 0, image.extent.height > 0 else { return nil }
        let scale = min(1, 1440 / max(image.extent.width, image.extent.height))
        let sized = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let quality = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        return context.jpegRepresentation(of: sized, colorSpace: CGColorSpaceCreateDeviceRGB(), options: [quality: 0.8])
    }
}

/// Native-only adapter. Its caller supplies an owned voice context; only Apple's
/// picker grants capture. It neither uploads frames nor adds audio inputs.
@available(iOS 27.0, *)
@MainActor final class HubScreenCaptureSession: NSObject, SCContentSharingPickerObserver, SCStreamOutput, SCStreamDelegate {
    private let context: HubVoiceAttachmentContext
    private let owner: HubScreenOwner
    private let frames = HubScreenFrames()
    private var stream: SCStream?
    private var generation: UUID?
    private var pickerEpoch = UUID()
    private var observing = false
    private var lockObserver: NSObjectProtocol?
    private let queue = DispatchQueue(label: "hub.screen.video", qos: .userInitiated)
    private nonisolated let encoder = HubScreenJPEGEncoder()
    private(set) var status = "Screen sharing is off."
    var changed: (() -> Void)?
    var frameReady: ((HubScreenFrame) -> Void)?
    var consentID: UUID? { stream != nil ? generation : nil }
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
        var configuration = SCContentSharingPickerConfiguration()
        configuration.showsMicrophoneControl = false; configuration.showsCameraControl = false
        picker.defaultConfiguration = configuration
        if !observing { picker.add(self); observing = true }
        picker.isActive = true
        update("Choose what to share in the system picker. Nothing is sent to HUB automatically.")
        picker.present()
    }
    func stop() {
        pickerEpoch = UUID()
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
            let epoch = UUID(); self.pickerEpoch = epoch
            let old = self.stream; self.stream = nil
            if let generation = self.generation { await self.frames.stop(generation: generation) }
            guard self.pickerEpoch == epoch else { return }
            self.generation = nil
            if let old { try? await old.stopCapture() }
            guard self.pickerEpoch == epoch, self.context.stillOwned() else { return }
            do {
                let config = SCStreamConfiguration()
                // iOS owns stream pacing/geometry. macOS-only configuration
                // properties must not be used here; bound work in our encoder.
                config.capturesAudio = false
                let active = SCStream(filter: filter, configuration: config, delegate: self)
                try active.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.queue)
                let generation = await self.frames.beginAfterSystemConsent(owner: self.owner)
                guard self.pickerEpoch == epoch else { await self.frames.stop(generation: generation); return }
                self.generation = generation
                self.stream = active
                try await active.startCapture()
                guard self.pickerEpoch == epoch else { try? await active.stopCapture(); return }
                guard self.stream === active, self.context.stillOwned() else { self.stop(); return }
                self.update("Screen capture is active. Frames stay on this iPhone until explicitly shared.")
            } catch { guard self.pickerEpoch == epoch else { return }; self.stop(); self.update("Capture could not start. Voice was not stopped; retry sharing.") }
        }
    }
    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor in if self.stream === stream { self.stop() } }
    }
    nonisolated func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferIsValid(buffer), let pixels = CMSampleBufferGetImageBuffer(buffer) else { return }
        // Preserve capture age across queueing/conversion instead of assigning
        // a new timestamp when a delayed callback finally reaches the frame gate.
        guard let clock = stream.synchronizationClock else { return }
        let hostClock = CMClockGetHostTimeClock()
        let timestamp = CMSyncConvertTime(CMSampleBufferGetPresentationTimeStamp(buffer), from: clock, to: hostClock)
        let elapsed = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(hostClock), timestamp))
        guard elapsed.isFinite, elapsed >= 0, elapsed <= HubScreenFrames.maximumAge else { return }
        let capturedAt = Date().addingTimeInterval(-elapsed)
        guard let jpeg = encoder.encode(pixels) else { return }
        Task { @MainActor in
            guard self.stream === stream, let generation = self.generation else { return }
            guard self.context.stillOwned() else { self.stop(); return }
            do {
                try await self.frames.accept(jpeg: jpeg, generation: generation, capturedAt: capturedAt)
                let frame = try await self.frames.snapshot(generation: generation, owner: self.owner)
                guard self.stream === stream, self.generation == generation, self.context.stillOwned() else { return }
                self.frameReady?(frame); self.changed?()
            }
            catch { await self.frames.pause(generation: generation); if self.generation == generation { self.update("Waiting for a valid fresh frame. Restart sharing if needed.") } }
        }
    }
}
#endif
