import UIKit
import AVFAudio
@preconcurrency import WebRTC
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
    private let server: HubServer
    private let deviceState: HubDeviceState
    private let resume: HubVoiceCheckpoint?
    private let pendingAdmission: HubVoiceAdmission?
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

    init(api: HubVoiceAPI, server: HubServer, deviceState: HubDeviceState, resume: HubVoiceCheckpoint? = nil, pendingAdmission: HubVoiceAdmission? = nil) {
        self.api = api; self.server = server; self.deviceState = deviceState; self.resume = resume
        self.pendingAdmission = pendingAdmission
        super.init()
    }
    deinit { observers.forEach(NotificationCenter.default.removeObserver) }
    private func update(_ value: String) { status = value; changed?() }

    func start() {
        guard !isActive, starting == nil, lease == nil else { return }
        ending = false; isActive = true; transcript = ""; muted = false
        update("Connecting…")
        starting = Task {
            defer { starting = nil }
            do {
                let state = try await api.status()
                guard !ending else { return }
                guard state.enabled else { throw HubVoiceAPIError.serviceUnavailable }
                let recovery = resume?.recovery(status: state)
                if let pendingAdmission {
                    update("Recovering interrupted startup…")
                    do {
                        let owned = try await api.recover(pendingAdmission)
                        lease = owned
                        try deviceState.rememberVoice(HubVoiceCheckpoint(server: server, lease: owned, peerID: nil))
                        try deviceState.clearAdmission()
                    } catch {
                        if error as? HubVoiceAPIError == .admissionExpired || error as? HubVoiceAPIError == .callUnavailable {
                            try deviceState.clearAdmission()
                            isActive = false
                            update("The previous startup ended. Close this screen to start or resume a conversation.")
                            return
                        }
                        throw error
                    }
                }
                if pendingAdmission == nil && (recovery == .anotherCall || (resume == nil && state.busy)) { throw HubVoiceAPIError.busy }
                if recovery == .missingPeer, let resume {
                    lease = resume.lease
                    update("The interrupted call needs cleanup. Tap End, then resume the conversation.")
                    return
                }
                update("Allow microphone access to start")
                let permitted = await withCheckedContinuation { continuation in
                    AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
                }
                guard !ending else { return }
                guard permitted else { update("Microphone access is off. Enable it in iPhone Settings."); await finish(); return }
                update("Connecting audio…")
                // Don't cancel this admission on End: recover the owned lease,
                // then close it even if the user ended during server startup.
                let admitted: HubVoiceLease
                var recoveredPeer: String?
                if pendingAdmission != nil, let recovered = lease { admitted = recovered }
                else if let resume {
                    switch resume.recovery(status: state) {
                    case .anotherCall: throw HubVoiceAPIError.busy
                    case .missingPeer:
                        lease = resume.lease
                        update("The interrupted call needs cleanup. Tap End, then resume the conversation.")
                        return
                    case .rejoinOwnedCall: admitted = resume.lease; recoveredPeer = resume.peerID
                    case .resumeEndedConversation: admitted = try await admitTracked(sessionID: resume.lease.sessionId)
                    }
                } else {
                    guard !state.busy else { throw HubVoiceAPIError.busy }
                    admitted = try await admitTracked()
                }
                lease = admitted
                try deviceState.rememberVoice(HubVoiceCheckpoint(server: server, lease: admitted, peerID: recoveredPeer))
                guard !ending else { return }
                try configureAudio()
                try await connect(admitted, restart: false, recoveredPeer: recoveredPeer)
                installAudioObservers()
            } catch {
                guard !ending else { return }
                update(error as? HubVoiceAPIError == .busy ? "Another voice conversation is active. End it before starting here." : "Voice could not connect. End and try again after checking HUB.")
                await finish()
            }
        }
    }

    private func admitTracked(sessionID: String? = nil) async throws -> HubVoiceLease {
        // Refresh the clock AFTER a potentially long microphone permission prompt.
        let current = try await api.status()
        guard !ending else { throw CancellationError() }
        guard current.enabled, !current.busy else { throw HubVoiceAPIError.busy }
        let receipt = HubVoiceAdmission(server: server, requestedAt: current.serverTime, sessionID: sessionID)
        try deviceState.rememberAdmission(receipt)
        let admitted = try await api.recover(receipt)
        lease = admitted
        try deviceState.rememberVoice(HubVoiceCheckpoint(server: server, lease: admitted, peerID: nil))
        try deviceState.clearAdmission()
        return admitted
    }

    private func configureAudio() throws {
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .defaultToSpeaker])
        try audio.setActive(true)
        ownsAudio = true
    }

    private func connect(_ admitted: HubVoiceLease, restart: Bool, recoveredPeer: String? = nil) async throws {
        readyTimeout?.cancel()
        let next: RTCPeerConnection
        if restart {
            // Closing the existing peer first would tell Pipecat to cancel its
            // worker. Renegotiate ICE on this same owned connection instead.
            guard let existing = peer, peerID != nil else { throw HubVoiceAPIError.callUnavailable }
            next = existing
        } else {
            ready = false
            let config = RTCConfiguration()
            config.sdpSemantics = .unifiedPlan
            config.iceServers = (admitted.iceServers ?? []).map { RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential) }
            let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: ["DtlsSrtpKeyAgreement": "true"])
            guard let created = factory.peerConnection(with: config, constraints: constraints, delegate: self) else { throw HubVoiceAPIError.serviceUnavailable }
            next = created; peer = created
            let source = factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
            let track = factory.audioTrack(with: source, trackId: "hub-microphone")
            track.isEnabled = !muted; input = track
            next.add(track, streamIds: ["hub-native"])
            channel = next.dataChannel(forLabel: "rtvi-events", configuration: RTCDataChannelConfiguration())
            channel?.delegate = self
        }
        var offerConstraints = ["OfferToReceiveAudio": "true"]
        if restart { offerConstraints["IceRestart"] = "true" }
        let offer: RTCSessionDescription = try await withCheckedThrowingContinuation { continuation in
            next.offer(for: RTCMediaConstraints(mandatoryConstraints: offerConstraints, optionalConstraints: nil)) { value, error in
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
        if restart, let peerID { payload["pc_id"] = peerID }
        if let recoveredPeer { payload["pc_id"] = recoveredPeer; payload["restart_pc"] = true }
        let answer = try await api.offer(callId: admitted.callId, payload: payload)
        guard !ending, peer === next,
              let object = try JSONSerialization.jsonObject(with: answer) as? [String: Any],
              object["type"] as? String == "answer", let sdp = object["sdp"] as? String else { throw HubVoiceAPIError.invalidResponse }
        peerID = object["pc_id"] as? String
        try deviceState.rememberVoice(HubVoiceCheckpoint(server: server, lease: admitted, peerID: peerID))
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
        if status == "Ending…" {
            update((try? deviceState.admission()) != nil ? "Audio stopped. Reopen Voice to recover the interrupted startup." : "Conversation ended")
        } else { changed?() }
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
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let options = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            Task { @MainActor [weak self] in self?.handleInterruption(raw: raw, options: options) }
        })
    }
    private func handleInterruption(raw: UInt?, options: UInt) {
        guard let raw, let type = AVAudioSession.InterruptionType(rawValue: raw), isActive, !ending else { return }
        if type == .began { input?.isEnabled = false; update("Audio interrupted") }
        else {
            if AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume) {
                do { try configureAudio(); input?.isEnabled = !muted; update("Listening") }
                catch { update("Audio paused. Choose Reconnect to continue.") }
            } else { update("Audio paused. Choose Reconnect to continue.") }
        }
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
            else if self.ready && (newState == .connected || newState == .completed) { self.update("Listening") }
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
            case "error":
                self.update(event.fatal == false
                    ? "Part of the reply had a problem. You can keep talking; check HUB before repeating a task."
                    : "Voice service interrupted. End or reconnect; check HUB before repeating a task.")
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
