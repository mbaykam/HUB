import AVFAudio
import SwiftUI
import HubNative

@MainActor
struct HubSpeechSettingsView: View {
    let api: HubConversationAPI
    var downloadsOnly = false
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
    @State private var previewTask: Task<Void, Never>?

    var body: some View {
        HubForm {
            if loading || busy { ProgressView() }
            if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
            if downloadsOnly, let catalog {
                installs(catalog)
            } else if let catalog, settings != nil {
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
        .navigationTitle(downloadsOnly ? "Speech downloads" : "Speech")
        .toolbar {
            if !downloadsOnly {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(loading || busy || settings == nil || catalog == nil)
                }
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
            previewTask?.cancel()
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
        Section {
            if let selected = catalog.tts.first(where: { $0.id == ttsID }) {
                NavigationLink {
                    HubVoicePickerView(engine: selected.engine, voices: selected.voices ?? [], selection: voice,
                                       canPreview: selected.available, bilingual: ["supertonic", "bilingual"].contains(selected.engine)) { language, choice in
                        await preview(language, voice: choice)
                    } choose: { choice in
                        voice = choice
                        await save()
                    }
                } label: {
                    HStack {
                        Text("Voice")
                        Spacer()
                        Text(HubVoicePickerView.name(voice, engine: selected.engine).title).foregroundStyle(.secondary)
                    }
                }
                .accessibilityIdentifier("hub.speech.voice")
            }
            Picker("Engine", selection: $ttsID) {
                if !catalog.tts.contains(where: { $0.id == ttsID }) { Text(ttsID).tag(ttsID) }
                ForEach(catalog.tts) { option in
                    Text(Self.engineName(option) + (option.available ? "" : " · install first")).tag(option.id)
                }
            }
            .onChange(of: ttsID) { id in
                let voices = catalog.tts.first { $0.id == id }?.voices ?? []
                if !voices.contains(voice) { voice = voices.contains("F5") ? "F5" : (voices.first ?? "") }
            }
            if let selected = catalog.tts.first(where: { $0.id == ttsID }) {
                if ["supertonic", "bilingual"].contains(selected.engine) {
                    Picker("Spoken language", selection: $spoken) {
                        Text("Follow the conversation").tag("auto")
                        Text("English").tag("en")
                        Text("Türkçe").tag("tr")
                    }
                }
                if selected.engine == "supertonic" {
                    Picker("Quality", selection: $quality) {
                        Text("Fastest").tag(4)
                        Text("Balanced").tag(6)
                        Text("Clearest").tag(8)
                        if ![4, 6, 8].contains(quality) { Text("\(quality) steps").tag(quality) }
                    }
                }
            }
        } header: {
            Text("Spoken voice")
        } footer: {
            Text("Every call uses this voice. Higher quality sounds clearer but starts talking a little later.")
        }
    }

    static func engineName(_ option: HubSpeechCatalog.Option) -> String {
        switch option.engine {
        case "supertonic": return "Supertonic · English and Turkish"
        case "kokoro": return "Kokoro · English"
        case "bilingual": return "Kokoro + Piper · English and Turkish"
        case "piper": return "Piper · " + option.model
        default: return option.id
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
            if downloadsOnly {
                async let choices = api.speechCatalog()
                async let status = api.speechDownload()
                catalog = try await choices
                download = try await status
                return
            }
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

    private func synthesis(voice: String? = nil) -> Engine? {
        let voice = voice ?? self.voice
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
                $0.range(of: #"^\p{L}[\p{L} '-]*$"#, options: .regularExpression) != nil
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

    private func preview(_ language: String, voice choice: String? = nil) async {
        guard !busy, let tts = synthesis(voice: choice ?? voice) else { return }
        busy = true
        defer { busy = false }
        do {
            let bytes = try await api.speechPreview(tts, language: language)
            guard !Task.isCancelled else { return }
            let sample = try AVAudioPlayer(data: bytes)
            player?.stop()
            player = sample
            notice = sample.play() ? nil : "Could not play this sample."
        } catch {
            if !Task.isCancelled { notice = "Could not load this voice sample." }
        }
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
            notice = soniox == true ? "Soniox connection settings updated." : "HUB did not confirm the new API key."
        } catch { notice = "Could not confirm the connection update." }
    }
}

/// Choose the voice HUB speaks with: plain names, tap to hear it, the chosen
/// one is saved at once.
@MainActor
struct HubVoicePickerView: View {
    let engine: String
    let voices: [String]
    @State var selection: String
    let canPreview: Bool
    let bilingual: Bool
    let preview: (String, String) async -> Void
    let choose: (String) async -> Void
    @State private var language = "en"
    @State private var playing: String?

    var body: some View {
        HubList {
            if bilingual {
                Picker("Sample language", selection: $language) {
                    Text("English").tag("en")
                    Text("Türkçe").tag("tr")
                }
                .pickerStyle(.segmented)
            }
            ForEach(Self.groups(voices, engine: engine), id: \.title) { group in
                Section(group.title) {
                    ForEach(group.voices, id: \.self) { voice in
                        let name = Self.name(voice, engine: engine)
                        Button {
                            selection = voice
                            Task {
                                playing = voice
                                if canPreview { await preview(language, voice) }
                                playing = nil
                                await choose(voice)
                            }
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: playing == voice ? "speaker.wave.2.fill" : "play.circle")
                                    .foregroundStyle(HubWorkspacePalette.accent)
                                    .frame(width: 28)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(name.title)
                                    if !name.detail.isEmpty { Text(name.detail).font(.caption).foregroundStyle(.secondary) }
                                }
                                Spacer()
                                if voice == selection { Image(systemName: "checkmark").foregroundStyle(HubWorkspacePalette.accent) }
                            }
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("hub.voice.\(voice)")
                    }
                }
            }
        }
        .navigationTitle("Voice")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// A readable name for an engine's voice id.
    static func name(_ voice: String, engine: String) -> (title: String, detail: String) {
        if engine == "supertonic", let kind = voice.first, let number = Int(voice.dropFirst()) {
            return (kind == "M" ? "Male voice \(number)" : "Female voice \(number)", "")
        }
        let parts = voice.split(separator: "_", maxSplits: 1).map(String.init)
        if parts.count == 2, parts[0].count == 2 {
            let accents: [Character: String] = ["a": "American", "b": "British", "j": "Japanese", "z": "Chinese", "e": "Spanish", "f": "French", "h": "Hindi", "i": "Italian", "p": "Portuguese"]
            let accent = accents[parts[0].first!] ?? ""
            let gender = parts[0].last == "m" ? "male" : "female"
            return (parts[1].replacingOccurrences(of: "_", with: " ").capitalized, "\(accent) \(gender)".trimmingCharacters(in: .whitespaces))
        }
        if voice.hasPrefix("tr_") { return (voice.split(separator: "-").dropFirst().first.map { String($0).capitalized } ?? voice, "Turkish") }
        return (voice, "")
    }

    static func groups(_ voices: [String], engine: String) -> [(title: String, voices: [String])] {
        let female = voices.filter { name($0, engine: engine).title.hasPrefix("Female") || name($0, engine: engine).detail.hasSuffix("female") }
        let male = voices.filter { name($0, engine: engine).title.hasPrefix("Male") || name($0, engine: engine).detail.hasSuffix(" male") || name($0, engine: engine).detail == "male" }
        let other = voices.filter { !female.contains($0) && !male.contains($0) }
        return [("Female", female), ("Male", male), ("Other", other)].filter { !$0.voices.isEmpty }
    }
}