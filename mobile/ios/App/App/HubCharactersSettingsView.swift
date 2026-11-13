import SwiftUI
import HubNative

@MainActor
struct HubCharactersSettingsView: View {
    let api: HubConversationAPI
    @State private var settings: HubCharacterSettings?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        List {
            if let settings {
                if let warning = settings.warning { Text(warning).foregroundStyle(.secondary) }
                ForEach(settings.characters) { character in
                    NavigationLink(destination: HubCharacterEditor(api: api, settings: settings, existing: character) {
                        self.settings = $0
                    }) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(character.name).font(.headline)
                            if !character.description.isEmpty { Text(character.description).font(.subheadline) }
                            Text(role(character, in: settings)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                NavigationLink("Create character", destination: HubCharacterEditor(api: api, settings: settings, existing: nil) {
                    self.settings = $0
                })
            } else if failed {
                Button("Retry loading characters") { failed = false; attempt += 1 }
            } else {
                ProgressView("Loading characters…")
            }
        }
        .navigationTitle("Characters")
        .task(id: attempt) { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            let value = try await api.characterSettings()
            if !Task.isCancelled { settings = value; failed = false }
        } catch {
            if !Task.isCancelled { failed = true }
        }
    }

    private func role(_ character: HubCharacterSettings.Character, in settings: HubCharacterSettings) -> String {
        if character.id == settings.mainId && character.id == settings.voiceId { return "Main and voice assistant" }
        if character.id == settings.mainId { return "Main assistant · Writing and Telegram" }
        if character.id == settings.voiceId { return "Voice assistant" }
        return character.route == nil ? "Model not configured" : "Specialist"
    }
}

@MainActor
private struct HubCharacterEditor: View {
    let api: HubConversationAPI
    let didChange: (HubCharacterSettings) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var settings: HubCharacterSettings
    @State private var character: HubCharacterSettings.Character
    @State private var creating: Bool
    @State private var models: HubModelCatalog?
    @State private var tab = Tab.profile
    @State private var selectedModel = ""
    @State private var effort = ""
    @State private var maxTokens = ""
    @State private var temperature = ""
    @State private var delegatesTo = ""
    @State private var inheritsTools = true
    @State private var allowedTools: Set<String> = []
    @State private var busy = false
    @State private var confirmDelete = false
    @State private var notice: String?
    @State private var needsReload = false

    private enum Tab: String, CaseIterable {
        case profile = "Profile", model = "Model", voice = "Voice", capabilities = "Capabilities"
    }

    init(api: HubConversationAPI, settings: HubCharacterSettings, existing: HubCharacterSettings.Character?,
         didChange: @escaping (HubCharacterSettings) -> Void) {
        self.api = api
        self.didChange = didChange
        let value = existing ?? HubCharacterSettings.Character(delegateTo: settings.mainId)
        _settings = State(initialValue: settings)
        _character = State(initialValue: value)
        _creating = State(initialValue: existing == nil)
        _selectedModel = State(initialValue: Self.modelID(value.route))
        _effort = State(initialValue: value.route?.reasoningEffort ?? "")
        _maxTokens = State(initialValue: value.route?.maxTokens.map { String($0) } ?? "")
        _temperature = State(initialValue: value.route?.temperature.map { String($0) } ?? "")
        _delegatesTo = State(initialValue: value.delegateTo ?? "")
        _inheritsTools = State(initialValue: value.tools.mode == "inherit")
        _allowedTools = State(initialValue: Set(value.tools.names ?? []))
    }

    var body: some View {
        Form {
            if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
            Picker("Character settings", selection: $tab) {
                ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            switch tab {
            case .profile: profile
            case .model: model
            case .voice: speech
            case .capabilities: capabilities
            }
            if needsReload {
                Button("Reload saved character") { Task { await reload() } }
            }
        }
        .disabled(busy)
        .navigationTitle(creating ? "New character" : character.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { Task { await save() } }.disabled(busy || needsReload || character.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .task(id: tab) {
            if tab == .model, models == nil { models = try? await api.modelCatalog() }
        }
        .confirmationDialog("Delete this character?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete character", role: .destructive) { Task { await role(.delete) } }
        }
    }

    private var profile: some View {
        Section("Profile") {
            TextField("Name", text: $character.name)
            TextField("About this character", text: $character.description)
            Picker("Portrait", selection: $character.avatar) {
                ForEach(["hub", "voice", "devil", "mint", "rose", "amber"], id: \.self) {
                    Text($0 == "devil" ? "Horns" : $0.capitalized).tag($0)
                }
            }
            TextEditor(text: $character.instructions).frame(minHeight: 120).accessibilityLabel("Instructions")
            if !creating, character.id != settings.mainId {
                Button("Use as main assistant") { Task { await role(.main) } }.disabled(character.route == nil || needsReload)
            }
        }
    }

    private var model: some View {
        Section("Model") {
            if let models {
                Picker("Model", selection: $selectedModel) {
                    Text("No model").tag("")
                    if !selectedModel.isEmpty, !models.models.contains(where: { $0.id == selectedModel }) {
                        Text(selectedModel).tag(selectedModel)
                    }
                    ForEach(models.models.filter { $0.available != false || $0.id == selectedModel }) {
                        Text("\($0.name) · \($0.provider)").tag($0.id)
                    }
                }
                .onChange(of: selectedModel) { value in
                    let stored = value == Self.modelID(character.route) ? character.route : nil
                    effort = stored?.reasoningEffort ?? ""
                    maxTokens = stored?.maxTokens.map { String($0) } ?? ""
                    temperature = stored?.temperature.map { String($0) } ?? ""
                }
                if let selected = models.models.first(where: { $0.id == selectedModel }) {
                    Picker("Reasoning effort", selection: $effort) {
                        Text("Provider default").tag("")
                        if !effort.isEmpty, !(selected.efforts ?? []).contains(where: { $0.id == effort }) { Text(effort).tag(effort) }
                        ForEach(selected.efforts ?? []) { Text($0.name).tag($0.id) }
                    }
                    TextField("Maximum output tokens", text: $maxTokens).keyboardType(.numberPad)
                    if selected.editableParameters?.contains("temperature") == true || !temperature.isEmpty {
                        TextField("Temperature", text: $temperature).keyboardType(.decimalPad)
                    }
                }
            } else {
                Text(character.route?.model ?? "No model").foregroundStyle(.secondary)
                Button("Load models") { Task { models = try? await api.modelCatalog() } }
            }
        }
    }

    private var speech: some View {
        Section("Voice") {
            if let speech = character.speech {
                Text("Speech to text · \(speech.stt.engine)")
                Text("Text to speech · \(speech.tts.engine)")
                TextField("Voice", text: Binding(get: { character.speech?.tts.voice ?? "" }, set: {
                    character.speech?.tts.voice = $0
                }))
                if !creating, character.id != settings.voiceId {
                    Button("Use as voice assistant") { Task { await role(.voice) } }.disabled(character.route == nil || needsReload)
                }
            } else {
                Text("This character has no voice profile.").foregroundStyle(.secondary)
            }
        }
    }

    private var capabilities: some View {
        Section("Capabilities") {
            Picker("Delegate complex work to", selection: $delegatesTo) {
                Text("No default delegation target").tag("")
                ForEach(settings.characters.filter { $0.id != character.id }) { Text($0.name).tag($0.id) }
            }
            Toggle("Use existing permitted tools", isOn: $inheritsTools)
            if !inheritsTools {
                DisclosureGroup("Allowed tools") {
                    ForEach(Set(settings.tools?.map(\.name) ?? []).union(allowedTools).sorted(), id: \.self) { name in
                        Toggle(name, isOn: Binding(get: { allowedTools.contains(name) }, set: { enabled in
                            if enabled { allowedTools.insert(name) } else { allowedTools.remove(name) }
                        }))
                    }
                }
            }
            if !creating, character.id != settings.mainId, character.id != settings.voiceId {
                Button("Delete character", role: .destructive) { confirmDelete = true }.disabled(needsReload)
            }
        }
    }

    private static func modelID(_ route: HubCharacterSettings.Character.Route?) -> String {
        guard let route else { return "" }
        return route.provider + "/" + route.model
    }

    private func save() async {
        guard !busy, !needsReload else { return }
        var candidate = character
        candidate.name = candidate.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidate.name.isEmpty, candidate.name.utf16.count <= 60, candidate.description.utf16.count <= 240,
              candidate.instructions.utf16.count <= 12_000 else {
            notice = "Check the name, description and instruction lengths."
            return
        }
        if selectedModel.isEmpty {
            candidate.route = nil
        } else if let model = models?.models.first(where: { $0.id == selectedModel }) {
            let output = Int(maxTokens)
            let sampling = Double(temperature.replacingOccurrences(of: ",", with: "."))
            guard maxTokens.isEmpty || output.map({ $0 >= 1 && $0 <= model.outputLimit }) == true,
                  temperature.isEmpty || sampling.map({ (0...2).contains($0) }) == true else {
                notice = "Check maximum output tokens and temperature."
                return
            }
            candidate.route = HubCharacterSettings.Character.Route(provider: model.provider, model: model.modelID,
                reasoningEffort: effort.isEmpty ? nil : effort, temperature: sampling, maxTokens: output)
        }
        candidate.delegateTo = delegatesTo.isEmpty ? nil : delegatesTo
        candidate.tools = .init(mode: inheritsTools ? "inherit" : "allow", names: inheritsTools ? nil : allowedTools.sorted())
        busy = true
        defer { busy = false }
        do {
            let updated = try await api.saveCharacter(candidate, revision: settings.revision, creating: creating)
            didChange(updated)
            dismiss()
        } catch {
            needsReload = true
            notice = "Could not confirm the save. Reload to check the current character. Your edits are still here."
        }
    }

    private func role(_ action: HubCharacterRoleAction) async {
        guard !busy, !needsReload else { return }
        busy = true
        defer { busy = false }
        do {
            let updated = try await api.changeCharacterRole(action, id: character.id, revision: settings.revision)
            settings = updated
            didChange(updated)
            if action == .delete { dismiss() } else { notice = "Saved" }
        } catch {
            needsReload = true
            notice = "Could not confirm the change. Reload to check."
        }
    }

    private func reload() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let updated = try await api.characterSettings()
            settings = updated
            didChange(updated)
            if creating, updated.characters.contains(where: {
                $0.name.localizedCaseInsensitiveCompare(character.name.trimmingCharacters(in: .whitespacesAndNewlines)) == .orderedSame
            }) {
                notice = "A character with this name is saved. Go back to open it."
                return
            }
            needsReload = false
            notice = "Current settings loaded. Review your draft before saving."
        } catch {
            notice = "Could not reload the current settings."
        }
    }
}
