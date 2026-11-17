import AVFoundation
import SwiftUI
import UIKit
import HubNative

/// Streams the microphone to the recognition socket as 16 kHz mono PCM.
/// Audio and socket callbacks arrive off the main thread, so everything is
/// reported through one ordered event stream.
final class HubDictationStream: @unchecked Sendable {
    enum Event { case message(Data), failed }

    let events: AsyncStream<Event>
    private let continuation: AsyncStream<Event>.Continuation
    private let engine = AVAudioEngine()
    private let session: URLSession
    private let socket: URLSessionWebSocketTask
    private let configuration: String
    private let lock = NSLock()
    private var target: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var capturing = false
    private var closed = false

    init(session info: HubDictationSession) {
        var made: AsyncStream<Event>.Continuation?
        events = AsyncStream<Event>(bufferingPolicy: .unbounded) { made = $0 }
        continuation = made!
        configuration = info.configuration
        let settings = URLSessionConfiguration.ephemeral
        settings.timeoutIntervalForRequest = 15
        session = URLSession(configuration: settings)
        socket = session.webSocketTask(with: info.url)
        socket.maximumMessageSize = 262_144
    }

    func start() throws {
        do {
            try begin()
        } catch {
            close()
            throw error
        }
    }

    private func begin() throws {
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.record, mode: .default, options: [])
        try audio.setActive(true, options: [])
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0,
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: HubDictationSession.sampleRate,
                                         channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: format, to: target) else {
            try? audio.setActive(false, options: .notifyOthersOnDeactivation)
            throw HubAttachmentError.unavailable
        }
        self.target = target
        self.converter = converter
        socket.resume()
        socket.send(.string(configuration)) { [weak self] error in
            if error != nil { self?.fail() }
        }
        listen()
        lock.lock()
        capturing = true
        lock.unlock()
        input.installTap(onBus: 0, bufferSize: 4_096, format: format) { [weak self] buffer, _ in
            self?.send(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    /// Stops the microphone and asks the service to confirm the last words.
    func endAudio() {
        stopCapture()
        socket.send(.string("")) { [weak self] error in
            if error != nil { self?.fail() }
        }
    }

    func close() {
        lock.lock()
        let alreadyClosed = closed
        closed = true
        lock.unlock()
        guard !alreadyClosed else { return }
        stopCapture()
        socket.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
        continuation.finish()
    }

    private func stopCapture() {
        lock.lock()
        let wasCapturing = capturing
        capturing = false
        lock.unlock()
        guard wasCapturing else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func isOpen(requireCapture: Bool) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return !closed && (capturing || !requireCapture)
    }

    private func fail() {
        if isOpen(requireCapture: false) { continuation.yield(.failed) }
    }

    private func listen() {
        socket.receive { [weak self] result in
            guard let self, self.isOpen(requireCapture: false) else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text): self.continuation.yield(.message(Data(text.utf8)))
                case .data(let data): self.continuation.yield(.message(data))
                @unknown default: break
                }
                self.listen()
            case .failure:
                self.fail()
            }
        }
    }

    private func send(_ buffer: AVAudioPCMBuffer) {
        guard isOpen(requireCapture: true), let converter, let target, buffer.frameLength > 0 else { return }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        let input = OneBuffer(buffer)
        var failure: NSError?
        let status = converter.convert(to: output, error: &failure) { _, state in
            guard let next = input.take() else {
                state.pointee = .noDataNow
                return nil
            }
            state.pointee = .haveData
            return next
        }
        guard status != .error, failure == nil, output.frameLength > 0, let samples = output.int16ChannelData else { return }
        let data = Data(bytes: samples[0], count: Int(output.frameLength) * MemoryLayout<Int16>.size)
        socket.send(.data(data)) { [weak self] error in
            if error != nil { self?.fail() }
        }
    }
}

/// Hands one captured buffer to the sample-rate converter exactly once.
private final class OneBuffer: @unchecked Sendable {
    private var buffer: AVAudioPCMBuffer?

    init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }

    func take() -> AVAudioPCMBuffer? {
        defer { buffer = nil }
        return buffer
    }
}

/// Voice typing: speak, and the words appear in the composer. It uses the
/// Soniox connection saved on HUB and never starts a voice conversation.
@MainActor
final class HubDictation: ObservableObject {
    enum Phase: Equatable { case idle, starting, listening, finishing }

    @Published private(set) var phase = Phase.idle
    /// Text recognized in the current take, including words not yet confirmed.
    @Published private(set) var text = ""
    @Published private(set) var notice: String?

    private var stream: HubDictationStream?
    private var transcript = HubDictationTranscript()
    private var take = 0
    private var reader: Task<Void, Never>?
    private var limit: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []

    init() {
        // The microphone must never keep listening after HUB leaves the screen
        // or after a phone call or Siri takes the audio away.
        for name in [UIApplication.didEnterBackgroundNotification, AVAudioSession.interruptionNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.cancel() }
            })
        }
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    var isActive: Bool { phase != .idle }

    func toggle(api: HubConversationAPI?) {
        switch phase {
        case .idle: start(api: api)
        case .starting: stop(keeping: nil)
        case .listening: finish()
        case .finishing: break
        }
    }

    /// Ends the take at once, keeping what has been recognized so far.
    func cancel() {
        if phase != .idle { stop(keeping: nil) }
    }

    private func start(api: HubConversationAPI?) {
        guard let api else {
            notice = "Connect to HUB to type with your voice."
            return
        }
        take += 1
        let current = take
        phase = .starting
        notice = nil
        transcript = HubDictationTranscript()
        text = ""
        Task {
            guard await HubDictation.microphoneAllowed() else {
                if take == current { stop(keeping: "Allow microphone access for HUB in iPhone Settings to type with your voice.") }
                return
            }
            do {
                let session = try await api.dictationSession()
                guard take == current, phase == .starting else { return }
                let stream = HubDictationStream(session: session)
                try stream.start()
                self.stream = stream
                phase = .listening
                reader = Task { [weak self] in
                    for await event in stream.events {
                        guard let self, self.take == current else { return }
                        self.handle(event)
                    }
                }
                limit = Task { [weak self] in
                    try? await Task.sleep(nanoseconds: 300_000_000_000)
                    if !Task.isCancelled, let self, self.take == current { self.finish() }
                }
            } catch {
                guard take == current else { return }
                var message = "Voice typing could not start. Check your connection and try again."
                let reason = error as? HubAttachmentError
                if reason == .signInRequired {
                    message = "Sign in to HUB again to type with your voice."
                } else if reason == .unavailable {
                    let connected = try? await api.sonioxConnection()
                    message = connected == false
                        ? "Connect Soniox in Settings → Speech to type with your voice."
                        : "Soniox did not start voice typing. Check your Soniox balance, and that HUB is up to date."
                }
                if take == current { stop(keeping: message) }
            }
        }
    }

    private func handle(_ event: HubDictationStream.Event) {
        switch event {
        case .message(let data):
            do {
                try transcript.receive(data)
                text = transcript.text
                if transcript.finished { stop(keeping: nil) }
            } catch {
                stop(keeping: "Soniox stopped voice typing. Your text so far is kept.")
            }
        case .failed:
            stop(keeping: phase == .finishing ? nil : "Voice typing lost its connection. Your text so far is kept.")
        }
    }

    private func finish() {
        guard phase == .listening, let stream else { return }
        phase = .finishing
        limit?.cancel()
        stream.endAudio()
        let current = take
        limit = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if !Task.isCancelled, let self, self.take == current, self.phase == .finishing { self.stop(keeping: nil) }
        }
    }

    private func stop(keeping message: String?) {
        take += 1
        limit?.cancel()
        limit = nil
        reader?.cancel()
        reader = nil
        stream?.close()
        stream = nil
        phase = .idle
        notice = message
    }

    private static func microphoneAllowed() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
        }
    }
}

/// The composer's text field. On iOS 16 and later it grows to five lines, so
/// a dictated or long message stays readable. Return still sends.
struct HubComposerField: View {
    @Binding var text: String
    let focus: FocusState<Bool>.Binding
    let identifier: String
    let submit: () -> Void
    @State private var previous = ""
    @State private var lastSubmit = Date.distantPast

    var body: some View {
        let prompt = Text("Chat…").foregroundColor(HubWorkspacePalette.accent.opacity(0.75))
        Group {
            if #available(iOS 16.0, *) {
                TextField("Chat…", text: $text, prompt: prompt, axis: .vertical).lineLimit(1...5)
            } else {
                TextField("Chat…", text: $text, prompt: prompt)
            }
        }
        .focused(focus)
        .accessibilityIdentifier(identifier)
        .frame(minHeight: 44)
        .onSubmit(submitOnce)
        .onChange(of: text) { value in
            // A growing field can insert a line break for Return instead of
            // submitting. Treat that one keystroke as Send, like before.
            if value == previous + "\n" {
                text = previous
                submitOnce()
            } else {
                previous = value
            }
        }
        .onAppear { previous = text }
    }

    private func submitOnce() {
        guard Date().timeIntervalSince(lastSubmit) > 0.4 else { return }
        lastSubmit = Date()
        submit()
    }
}

/// The composer's voice-typing button.
struct HubDictationButton: View {
    @ObservedObject var dictation: HubDictation
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle().fill(Color.red.opacity(dictation.phase == .listening ? 0.18 : 0))
                if dictation.phase == .starting || dictation.phase == .finishing {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: dictation.phase == .listening ? "mic.fill" : "mic")
                        .foregroundColor(dictation.phase == .listening ? .red : nil)
                }
            }
            .frame(width: 44, height: 44)
        }
        .accessibilityLabel(dictation.isActive ? "Stop voice typing" : "Type with your voice")
        .accessibilityIdentifier(identifier)
    }
}
