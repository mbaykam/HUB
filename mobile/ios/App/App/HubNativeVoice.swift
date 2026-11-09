import UIKit
import AVFAudio
import WebRTC
import HubNative

/// Audio-only SmallWebRTC/RTVI client. Signaling stays in HubVoiceAPI, so session
/// cookies cannot escape through an SDK's redirect-following shared URLSession.
/// No provider key or extra speech service is introduced on the phone.
@MainActor
final class HubNativeVoice: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
    var changed: (() -> Void)?
    private(set) var status = "Ready"
    private(set) var transcript = ""
    private(set) var isActive = false
    private(set) var muted = false
    private let api: HubVoiceAPI
    private static let sharedFactory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory()
    }()
    private let factory = HubNativeVoice.sharedFactory
    private var peer: RTCPeerConnection?
    private var channel: RTCDataChannel?
    private var input: RTCAudioTrack?
    private var lease: HubVoiceLease?
    private var peerID: String?
    private var starting: Task<Void, Never>?
    private var ending = false
    private var observers: [NSObjectProtocol] = []
    private var readyTimeout: Task<Void, Never>?
    private var ready = false
    private var ownsAudio = false

    init(api: HubVoiceAPI) { self.api = api; super.init() }
    deinit { observers.forEach(NotificationCenter.default.removeObserver) }
    private func update(_ value: String) { status = value; changed?() }

    func start() {
        guard !isActive, starting == nil, lease == nil else { return }
        ending = false; isActive = true; transcript = ""; muted = false
        update("Allow microphone access to start")
        starting = Task {
            defer { starting = nil }
            let permitted = await withCheckedContinuation { continuation in
                AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
            }
            guard !ending else { return }
            guard permitted else { isActive = false; update("Microphone access is off. Enable it in iPhone Settings."); return }
            do {
                update("Connecting…")
                let state = try await api.status()
                guard !ending else { return }
                guard state.enabled, !state.busy else { throw HubVoiceAPIError.busy }
                // Don't cancel this admission on End: recover the owned lease,
                // then close it even if the user ended during server startup.
                let admitted = try await api.open(serverTime: state.serverTime)
                lease = admitted
                guard !ending else { return }
                try configureAudio()
                try await connect(admitted, restart: false)
                installAudioObservers()
            } catch {
                guard !ending else { return }
                update(error as? HubVoiceAPIError == .busy ? "Another voice conversation is active. End it before starting here." : "Voice could not connect. End and try again after checking HUB.")
                await finish()
            }
        }
    }

    private func configureAudio() throws {
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
        try audio.setActive(true)
        ownsAudio = true
    }

    private func connect(_ admitted: HubVoiceLease, restart: Bool) async throws {
        readyTimeout?.cancel(); ready = false
        channel?.close(); peer?.close(); input = nil
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.iceServers = (admitted.iceServers ?? []).map { RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential) }
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: ["DtlsSrtpKeyAgreement": "true"])
        guard let next = factory.peerConnection(with: config, constraints: constraints, delegate: self) else { throw HubVoiceAPIError.serviceUnavailable }
        peer = next
        let source = factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        let track = factory.audioTrack(with: source, trackId: "hub-microphone")
        track.isEnabled = !muted
        input = track
        next.add(track, streamIds: ["hub-native"])
        channel = next.dataChannel(forLabel: "rtvi-events", configuration: RTCDataChannelConfiguration())
        channel?.delegate = self
        let offer: RTCSessionDescription = try await withCheckedThrowingContinuation { continuation in
            next.offer(for: RTCMediaConstraints(mandatoryConstraints: ["OfferToReceiveAudio": "true"], optionalConstraints: nil)) { value, error in
                if let value { continuation.resume(returning: value) } else { continuation.resume(throwing: error ?? HubVoiceAPIError.invalidResponse) }
            }
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            next.setLocalDescription(offer) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        // Gather a complete offer, avoiding candidate PATCH races during startup.
        let deadline = Date().addingTimeInterval(12)
        while next.iceGatheringState != .complete {
            guard !ending, peer === next else { throw CancellationError() }
            guard Date() < deadline else { throw URLError(.timedOut) }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        guard !ending, let description = next.localDescription else { throw CancellationError() }
        var payload: [String: Any] = ["sdp": description.sdp, "type": "offer"]
        if restart, let peerID { payload["pc_id"] = peerID; payload["restart_pc"] = true }
        let answer = try await api.offer(callId: admitted.callId, payload: payload)
        guard !ending, peer === next,
              let object = try JSONSerialization.jsonObject(with: answer) as? [String: Any],
              object["type"] as? String == "answer", let sdp = object["sdp"] as? String else { throw HubVoiceAPIError.invalidResponse }
        peerID = object["pc_id"] as? String
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            next.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        if !ready { update("Connecting audio…") }
        readyTimeout = Task { [weak self, weak next] in
            do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
            guard let self, let next, self.peer === next, !self.ready, !self.ending else { return }
            self.update("Voice did not become ready. Choose Reconnect or End.")
        }
    }

    func end() {
        guard isActive, !ending else { return }
        ending = true; input?.isEnabled = false; channel?.close(); peer?.close()
        update("Ending…")
        let pending = starting
        Task { await pending?.value; await finish() }
    }
    private func finish() async {
        readyTimeout?.cancel()
        input?.isEnabled = false; channel?.close(); peer?.close()
        channel = nil; peer = nil; input = nil; peerID = nil
        observers.forEach(NotificationCenter.default.removeObserver); observers.removeAll()
        if let owned = lease {
            do { try await api.close(callId: owned.callId); lease = nil }
            catch {
                if error as? HubVoiceAPIError == .callUnavailable { lease = nil }
                else { update("Audio stopped. Tap End to retry server cleanup before starting again.") }
            }
        }
        if ownsAudio {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            ownsAudio = false
        }
        isActive = lease != nil
        ending = false
        if status == "Ending…" { update("Conversation ended") } else { changed?() }
    }
    func toggleMute() { muted.toggle(); input?.isEnabled = !muted; changed?() }
    func interrupt() {
        guard let lease, !ending else { return }
        Task { do { try await api.interrupt(callId: lease.callId) } catch { update("Could not interrupt. Check the connection.") } }
    }
    func reconnect() {
        guard let lease, isActive, !ending, starting == nil else { return }
        update("Reconnecting audio…")
        starting = Task {
            defer { starting = nil }
            do { try configureAudio(); try await connect(lease, restart: true) }
            catch { if !ending { update("Reconnect failed. End the conversation or try again.") } }
        }
    }

    private func installAudioObservers() {
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw), self.isActive, !self.ending else { return }
            if type == .began { self.input?.isEnabled = false; self.update("Audio interrupted") }
            else {
                let options = AVAudioSession.InterruptionOptions(rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
                if options.contains(.shouldResume) {
                    do { try self.configureAudio(); self.input?.isEnabled = !self.muted; self.update("Listening") }
                    catch { self.update("Audio paused. Choose Reconnect to continue.") }
                } else { self.update("Audio paused. Choose Reconnect to continue.") }
            }
        })
    }

    // WebRTC delegates arrive on its own queues. UI and call ownership stay main-thread.
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.peer === peerConnection, !self.ending else { return }
            if newState == .failed || newState == .disconnected { self.update("Audio disconnected. Choose Reconnect to resume this conversation.") }
        }
    }
    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.channel === dataChannel, !self.ending else { return }
            if dataChannel.readyState == .open, let data = try? HubRTVI.ready() {
                if !dataChannel.sendData(RTCDataBuffer(data: data, isBinary: true)) { self.update("Could not finish connecting. Choose Reconnect.") }
            }
        }
    }
    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard let event = HubRTVI.event(buffer.data) else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.channel === dataChannel, !self.ending else { return }
            switch event.type {
            case "bot-ready": self.ready = true; self.readyTimeout?.cancel(); self.update("Listening")
            case "bot-stopped-speaking": self.update("Listening")
            case "bot-started-speaking": self.update("Speaking")
            case "bot-llm-started": self.update("Thinking…")
            case "user-transcription", "bot-tts-text":
                if let text = event.text, event.final {
                    self.transcript += "\(event.type == "user-transcription" ? "You" : "Assistant"): \(text)\n\n"
                    self.transcript = String(self.transcript.suffix(24_000)); self.changed?()
                }
            default: break
            }
        }
    }
}
