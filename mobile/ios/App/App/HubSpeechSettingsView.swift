import AVFAudio
import SwiftUI
import HubNative

@MainActor
struct HubSpeechSettingsView: View {
    let api: HubConversationAPI
    private typealias Engine = HubCharacterSettings.Character.Speech.Engine
    private typealias Attention = HubCharacterSettings.Character.Speech.Attention
    @State private var settings: HubSpeechSettings?
    @State private var catalog: HubSpeechCatalog?
    @State private var download: HubSpeechDownload?
    @State private var soniox: Bool?
    @State private var sonioxKey = ""
    @State private var sttID = ""
    @State private var ttsID = ""
    @State private var recognition = "auto"
    @State private var spoken = "auto"
    @State private var quality = 6
    @State private var voice = ""
    @State private var idle = 180
    @State private var wake = "Vera"
    @State private var context = 60
    @State private var notice: String?
    @State private var loading = true
    @State private var busy = false
    @State private var player: AVAudioPlayer?

    var body: some View {
        Form {
            if loading || busy { ProgressView() }
            if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
            if let catalog, settings != nil {
                recognitionSection(catalog)
                voiceSection(catalog)
                backgroundSection
                installs(catalog)
                sonioxSection
            } else if !loading {
                Button("Retry") { Task { await load() } }
            }
        }
        .disabled(busy)
        .navigationTitle("Speech")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { Task { await save() } }
                    .disabled(loading || busy || settings == nil || catalog == nil)
            }
        }
        .task { await load() }
        .task(id: download?.phase) {
            guard let phase = download?.phase, ["starting", "downloading", "verifying"].contains(phase) else { return }
            do {
                try await Task.sleep(nanoseconds: 3_000_000_000)
                while !Task.isCancelled {
                    let current = try await api.speechDownload()
                    guard !Task.isCancelled else { return }
                    download = current
                    if current?.phase != phase {
                        if current?.phase == "complete" { catalog = try await api.speechCatalog() }
                        return
                    }
                    try await Task.sleep(nanoseconds: 3_000_000_000)
                }
            } catch {
                if !Task.isCancelled { notice = "Could not check the download. Refresh to retry." }
            }
        }
        .onDisappear {
            player?.stop()
            sonioxKey = ""
        }
    }

    private func recognitionSection(_ catalog: HubSpeechCatalog) -> some View {
        Section("Recognition") {
            Picker("Model", selection: $sttID) {
                if !catalog.stt.contains(where: { $0.id == sttID }) { Text(sttID).tag(sttID) }
                ForEach(catalog.stt) { option in
                    Text(option.available ? option.id : "\(option.id) · setup needed").tag(option.id)
                        .disabled(!option.available)
                }
            }
            .onChange(of: sttID) { if $0.hasSuffix(".en") { recognition = "en" } }
            Picker("Recognition language", selection: $recognition) {
                Text("Automatic").tag("auto")
                Text("English + Türkçe").tag("en-tr")
                Text("English").tag("en")
                Text("Türkçe").tag("tr")
            }
            .disabled(sttID.hasSuffix(".en"))
        }
    }

    private func voiceSection(_ catalog: HubSpeechCatalog) -> some View {
        Section("Spoken voice") {
            Picker("Engine", selection: $ttsID) {
                if !catalog.tts.contains(where: { $0.id == ttsID }) { Text(ttsID).tag(ttsID) }
                ForEach(catalog.tts) { option in
                    Text(option.available ? option.id : "\(option.id) · install first").tag(option.id)
                }
            }
            .onChange(of: ttsID) { id in
                let voices = catalog.tts.first { $0.id == id }?.voices ?? []
                if !voices.contains(voice) { voice = voices.contains("F5") ? "F5" : (voices.first ?? "") }
            }
            if let selected = catalog.tts.first(where: { $0.id == ttsID }) {
                Picker("Default voice", selection: $voice) {
                    if !(selected.voices ?? []).contains(voice) { Text(voice).tag(voice) }
                    ForEach(selected.voices ?? [], id: \.self) { Text($0).tag($0) }
                }
                if ["supertonic", "bilingual"].contains(selected.engine) {
                    Picker("Spoken language", selection: $spoken) {
                        Text("Automatic").tag("auto")
                        Text("English").tag("en")
                        Text("Türkçe").tag("tr")
                    }
                }
                if selected.engine == "supertonic" {
                    Picker("Voice quality", selection: $quality) {
                        ForEach(4...8, id: \.self) { Text("\($0) steps").tag($0) }
                    }
                }
                if selected.available {
                    if selected.engine != "piper" || !selected.model.hasPrefix("tr_") {
                        Button("Listen in English") { Task { await preview("en") } }
                    }
                    if ["supertonic", "bilingual"].contains(selected.engine) || selected.model.hasPrefix("tr_") {
                        Button("Türkçe dinle") { Task { await preview("tr") } }
                    }
                }
            }
        }
    }

    private var backgroundSection: some View {
        Section("Background listening") {
            Picker("Switch to background", selection: $idle) {
                Text("Manually").tag(0)
                ForEach([60, 120, 180, 300, 600], id: \.self) { Text("After \($0 / 60) min").tag($0) }
            }
            TextField("Wake phrases, separated by commas", text: $wake)
            Picker("Recent context", selection: $context) {
                Text("Off").tag(0)
                ForEach([30, 60, 120], id: \.self) { Text("Last \($0) seconds").tag($0) }
            }
            .disabled(sttID.hasPrefix("soniox:"))
            Text("Changes apply to the next call.").font(.footnote).foregroundStyle(.secondary)
        }
    }

    private func installs(_ catalog: HubSpeechCatalog) -> some View {
        Section("Speech models") {
            if let download { Text("\(download.model) · \(download.phase)") }
            ForEach((catalog.stt + catalog.tts).filter { !$0.available && $0.downloadable == true }) { option in
                Button("Install \(option.model)") { Task { await install(option) } }
                    .disabled(download.map { ["starting", "downloading", "verifying"].contains($0.phase) } ?? false)
            }
            Button("Refresh models") { Task { await refreshModels() } }
        }
    }

    private var sonioxSection: some View {
        Section("Soniox") {
            if let soniox { Text(soniox ? "API key saved on HUB" : "Connection needs an API key") }
            SecureField("Soniox API key", text: $sonioxKey).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Save API key") {
                let value = sonioxKey.trimmingCharacters(in: .whitespacesAndNewlines)
                sonioxKey = ""
                Task { await saveKey(value) }
            }
            .disabled(sonioxKey.trimmingCharacters(in: .whitespacesAndNewlines).utf8.count < 16)
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            async let settings = api.speechSettings()
            async let catalog = api.speechCatalog()
            let (saved, choices) = try await (settings, catalog)
            guard !Task.isCancelled else { return }
            self.catalog = choices
            self.settings = saved
            sttID = saved.speech.stt.id
            ttsID = saved.speech.tts.id
            recognition = saved.speech.stt.language ?? (sttID.hasSuffix(".en") ? "en" : "auto")
            spoken = saved.speech.tts.language ?? "auto"
            quality = saved.speech.tts.steps ?? 6
            voice = saved.speech.tts.voice ?? ""
            idle = saved.speech.attention?.idleSeconds ?? 180
            wake = saved.speech.attention?.wakePhrases.joined(separator: ", ") ?? "Vera"
            context = saved.speech.attention?.contextSeconds ?? 60
            download = try? await api.speechDownload()
            soniox = try? await api.sonioxConnection()
            notice = nil
        } catch {
            if !Task.isCancelled { notice = "Could not load speech settings." }
        }
    }

    private func synthesis() -> Engine? {
        guard let option = catalog?.tts.first(where: { $0.id == ttsID && $0.available }),
              option.voices?.contains(voice) == true else { return nil }
        let isBilingual = option.engine == "bilingual"
        let isSupertonic = option.engine == "supertonic"
        return Engine(engine: option.engine, model: option.model, voice: voice,
                      language: isBilingual || isSupertonic ? spoken : nil, steps: isSupertonic ? quality : nil,
                      turkishVoice: isBilingual ? "tr_TR-dfki-medium" : nil)
    }

    private func save() async {
        guard !busy, var settings, let tts = synthesis(),
              let stt = catalog?.stt.first(where: { $0.id == sttID && $0.available }) else {
            notice = "Choose installed recognition and voice models."
            return
        }
        let phrases = wake.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let valid = (1...3).contains(phrases.count) && phrases.allSatisfy {
            (1...40).contains($0.utf16.count) && $0.split(separator: " ").count <= 4 &&
                $0.range(of: #"^\p{L}[\p{L} '’-]*$"#, options: .regularExpression) != nil
        }
        guard valid else { notice = "Enter one to three wake phrases, up to four words each."; return }
        settings.speech.stt = Engine(engine: stt.engine, model: stt.model, language: sttID.hasSuffix(".en") ? "en" : recognition)
        settings.speech.tts = tts
        settings.speech.attention = Attention(idleSeconds: idle, wakePhrases: phrases, contextSeconds: context)
        busy = true
        defer { busy = false }
        do {
            self.settings = try await api.saveSpeechSettings(settings)
            notice = "Saved for the next call."
        } catch {
            notice = "Could not confirm the save. Reopen Speech to check the current settings."
        }
    }

    private func preview(_ language: String) async {
        guard !busy, let tts = synthesis() else { return }
        busy = true
        defer { busy = false }
        do {
            let bytes = try await api.speechPreview(tts, language: language)
            guard !Task.isCancelled else { return }
            let sample = try AVAudioPlayer(data: bytes)
            player?.stop()
            player = sample
            notice = sample.play() ? nil : "Could not play this sample."
        } catch { notice = "Could not load this voice sample." }
    }

    private func install(_ option: HubSpeechCatalog.Option) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { download = try await api.speechDownload(option); notice = nil }
        catch { notice = "Could not confirm the install. Refresh to check its status." }
    }

    private func refreshModels() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            catalog = try await api.speechCatalog()
            download = try await api.speechDownload()
            notice = nil
        } catch { notice = "Could not refresh speech models." }
    }

    private func saveKey(_ key: String) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            soniox = try await api.sonioxConnection(key: key)
            catalog = try await api.speechCatalog()
            notice = "Soniox connection settings updated."
        } catch { notice = "Could not confirm the connection update." }
    }
}
