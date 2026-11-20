import SwiftUI
import HubNative

@MainActor
struct HubCharactersSettingsView: View {
    let api: HubConversationAPI
    @State private var settings: HubCharacterSettings?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        HubList {
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

/// One assistant, three models: the normal chat model, a fast one for voice
/// and an unrestricted one a chat switches to when unlocked. Each opens the
/// model settings behind it; the personality is the Chat model's.
@MainActor
struct HubModelSlotsView: View {
    let api: HubConversationAPI
    @State private var settings: HubCharacterSettings?
    @State private var failed = false
    @State private var attempt = 0
    @State private var notice: String?
    @State private var speedOpen = false

    var body: some View {
        HubList {
            if let settings {
                if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
                Section {
                    slot("Chat", icon: "text.bubble", note: "Text chats, Telegram and helpers. Its instructions are HUB's personality.", id: settings.mainId, in: settings)
                    slot("Voice", icon: "waveform", note: "Voice calls. Pick a fast model.", id: settings.voiceId, in: settings)
                    if let id = settings.unrestrictedId {
                        slot("Unrestricted", icon: "lock.open", note: "Used only in a chat you unlock, or when you tap Retry unrestricted.", id: id, in: settings)
                    }
                } footer: {
                    Text("It is the same assistant with one memory in every mode; only the model that answers changes.")
                }
                Section("Unrestricted model") {
                    let options = settings.characters.filter { $0.route != nil && $0.id != settings.mainId }
                    if options.isEmpty {
                        Text("Add a model first, then choose it here.").foregroundStyle(.secondary)
                    }
                    ForEach(options) { option in
                        Button {
                            Task { await makeUnrestricted(option, settings: settings) }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(option.name)
                                    Text(Self.model(option)).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if option.id == settings.unrestrictedId { Image(systemName: "checkmark").foregroundStyle(HubWorkspacePalette.accent) }
                            }
                        }
                        .foregroundStyle(.primary)
                    }
                    NavigationLink("Add a model", destination: HubCharacterEditor(api: api, settings: settings, existing: nil) {
                        self.settings = $0
                    })
                }
            } else if failed {
                Button("Retry loading models") { failed = false; attempt += 1 }
            } else {
                ProgressView("Loading models…")
            }
        }
        .navigationTitle("Models")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { speedOpen = true } label: { Image(systemName: "speedometer") }
                    .accessibilityLabel("Model speed")
            }
        }
        .sheet(isPresented: $speedOpen) { HubModelSpeedView() }
        .task(id: attempt) { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder
    private func slot(_ title: String, icon: String, note: String, id: String, in settings: HubCharacterSettings) -> some View {
        if let character = settings.characters.first(where: { $0.id == id }) {
            NavigationLink(destination: HubCharacterEditor(api: api, settings: settings, existing: character) { self.settings = $0 }) {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(.headline)
                        Text(Self.model(character)).font(.subheadline)
                        Text(note).font(.caption).foregroundStyle(.secondary)
                    }
                } icon: { Image(systemName: icon) }
            }
            .accessibilityIdentifier("hub.settings.models.\(title.lowercased())")
        }
    }

    static func model(_ character: HubCharacterSettings.Character) -> String {
        guard let route = character.route else { return "No model chosen" }
        return route.model
    }

    private func load() async {
        do {
            let value = try await api.characterSettings()
            if !Task.isCancelled { settings = value; failed = false }
        } catch {
            if !Task.isCancelled { failed = true }
        }
    }

    private func makeUnrestricted(_ option: HubCharacterSettings.Character, settings: HubCharacterSettings) async {
        do {
            self.settings = try await api.changeCharacterRole(.unrestricted, id: option.id, revision: settings.revision)
            notice = nil
        } catch {
            notice = "Could not change the unrestricted model. Reload and try again."
        }
    }
}

/// Shows the complete request HUB last sent to a model for one character.
/// Reading it makes no model call.
@MainActor
private struct HubCharacterRequestView: View {
    let api: HubConversationAPI
    let characterID: String
    @State private var request: HubCharacterRequest?
    @State private var preview = ""
    @State private var truncated = false
    @State private var file: Data?
    @State private var loading = false
    @State private var failed = false
    @State private var attempt = 0

    private static let previewLimit = 20_000

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if failed {
                    Text("Couldn’t load the request. Refresh to retry.").foregroundStyle(.secondary)
                } else if let request {
                    if let record = request.record, record.json != nil {
                        Text("Actual request · \(Date(timeIntervalSince1970: record.at / 1000).formatted(date: .abbreviated, time: .shortened))")
                            .font(.subheadline.weight(.semibold))
                        Text(record.sessionId).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        if truncated {
                            Text("Showing the beginning. Share the file to read the complete request.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        Text(preview)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                            .background(HubWorkspacePalette.panel, in: RoundedRectangle(cornerRadius: 12))
                    } else {
                        Text(request.record?.unavailable ?? "No request captured for this character yet. Send this character a message, then refresh. Unsaved character edits are not applied to past requests.")
                            .foregroundStyle(.secondary)
                    }
                    Text(request.boundary + " " + request.retention).font(.footnote).foregroundStyle(.secondary)
                } else {
                    ProgressView("Loading the last model request…")
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .hubBackdrop()
        .navigationTitle("Last model request")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                if let file {
                    HubShareFileButton(bytes: file, name: "hub-model-request.json", label: "Share full request")
                }
                Button { attempt += 1 } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Refresh")
                    .disabled(loading)
            }
        }
        .task(id: attempt) { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let value = try await api.characterRequest(id: characterID)
            guard !Task.isCancelled else { return }
            let json = value.record?.json ?? ""
            let beginning = String(json.prefix(Self.previewLimit))
            preview = beginning
            truncated = beginning.utf8.count < json.utf8.count
            file = json.isEmpty ? nil : Data(json.utf8)
            request = value
            failed = false
        } catch {
            if !Task.isCancelled { failed = true }
        }
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
        HubForm {
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
            if !creating {
                Section {
                    NavigationLink("Last model request",
                                   destination: HubCharacterRequestView(api: api, characterID: character.id))
                } footer: {
                    Text("See exactly what HUB last sent to the model for this character.")
                }
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
            HubLabeledField(title: "Name") { TextField("Name", text: $character.name) }
            HubLabeledField(title: "About this character") {
                TextField("About this character", text: $character.description)
            }
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
                NavigationLink {
                    HubCatalogModelPicker(catalog: models, selection: $selectedModel)
                } label: {
                    let current = models.models.first { $0.id == selectedModel }
                    HStack {
                        Text("Model")
                        Spacer(minLength: 8)
                        VStack(alignment: .trailing, spacing: 1) {
                            Text(current?.name ?? (selectedModel.isEmpty ? "No model" : selectedModel)).lineLimit(1)
                            if let current {
                                Text(models.providers.first { $0.id == current.provider }?.name ?? current.provider)
                                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        .foregroundStyle(.secondary)
                    }
                }
                .accessibilityIdentifier("hub.character.model")
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

/// Choosing one model out of hundreds: grouped by provider, folded until
/// needed, searchable, with filters and the facts that decide a choice.
@MainActor
struct HubCatalogModelPicker: View {
    let catalog: HubModelCatalog
    @Binding var selection: String
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var filter = Filter.all
    @State private var open: Set<String> = []

    enum Filter: String, CaseIterable, Identifiable {
        case all = "All", favorites = "Favorites", reasoning = "Reasoning", images = "Sees images", longContext = "Long context"
        var id: Self { self }
        func includes(_ model: HubModelCatalog.Model) -> Bool {
            switch self {
            case .all: return true
            case .favorites: return model.favorite == true
            case .reasoning: return model.reasoning
            case .images: return model.input.contains("image")
            case .longContext: return (model.contextWindow ?? 0) >= 200_000
            }
        }
    }

    private struct Group: Identifiable { let id: String; let name: String; let models: [HubModelCatalog.Model] }

    private var groups: [Group] {
        let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let usable = catalog.models.filter { ($0.available != false || $0.id == selection) && filter.includes($0) &&
            (search.isEmpty || "\($0.name) \($0.modelID) \($0.provider) \($0.description ?? "")".localizedCaseInsensitiveContains(search)) }
        let names = Dictionary(catalog.providers.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        let order = catalog.providers.map(\.id)
        return Dictionary(grouping: usable, by: \.provider)
            .map { Group(id: $0.key, name: names[$0.key] ?? $0.key,
                         models: $0.value.sorted { ($0.favorite == true ? 0 : 1, $0.name) < ($1.favorite == true ? 0 : 1, $1.name) }) }
            .sorted { (order.firstIndex(of: $0.id) ?? .max, $0.name) < (order.firstIndex(of: $1.id) ?? .max, $1.name) }
    }

    var body: some View {
        let groups = groups
        let searching = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || filter != .all
        List {
            if let current = catalog.models.first(where: { $0.id == selection }) {
                Section("Selected") { row(current, showProvider: true) }
            }
            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Filter.allCases) { option in
                            Button { filter = option } label: {
                                Text(option.rawValue)
                                    .font(.caption.weight(filter == option ? .semibold : .regular))
                                    .padding(.horizontal, 12).frame(minHeight: 32)
                                    .background(filter == option ? HubWorkspacePalette.accent.opacity(0.2) : HubWorkspacePalette.border.opacity(0.06), in: Capsule())
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(filter == option ? .isSelected : [])
                        }
                    }
                }
                .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
            }
            if groups.isEmpty { Text("No matching models").foregroundStyle(.secondary) }
            ForEach(groups) { group in
                let expanded = searching || groups.count == 1 || open.contains(group.id)
                Section {
                    if expanded { ForEach(group.models) { row($0, showProvider: false) } }
                } header: {
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            if open.contains(group.id) { open.remove(group.id) } else { open.insert(group.id) }
                        }
                    } label: {
                        HStack {
                            Text(group.name)
                            Text("\(group.models.count)").foregroundStyle(.secondary)
                            Spacer()
                            if !searching && groups.count > 1 {
                                Image(systemName: "chevron.down").rotationEffect(.degrees(expanded ? 0 : -90))
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(searching || groups.count == 1)
                    .accessibilityLabel("\(group.name), \(group.models.count) models")
                    .accessibilityHint(expanded ? "Hides these models" : "Shows these models")
                }
            }
            Section {
                Button("No model") { selection = ""; dismiss() }.foregroundStyle(.secondary)
            }
        }
        .searchable(text: $query, prompt: "Find a model")
        .navigationTitle("Model")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if let current = catalog.models.first(where: { $0.id == selection }) { open.insert(current.provider) }
        }
    }

    private func row(_ model: HubModelCatalog.Model, showProvider: Bool) -> some View {
        let chosen = model.id == selection
        return Button { selection = model.id; dismiss() } label: {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        Text(model.name).font(.body.weight(chosen ? .semibold : .regular)).lineLimit(1)
                        if model.favorite == true { Image(systemName: "heart.fill").font(.caption2).foregroundStyle(.pink).accessibilityLabel("Favorite") }
                    }
                    if let description = model.description, !description.isEmpty {
                        Text(description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    HStack(spacing: 5) {
                        if showProvider { badge(catalog.providers.first { $0.id == model.provider }?.name ?? model.provider) }
                        if let window = model.contextWindow { badge(HubChatModels.tokens(window) + " context") }
                        if model.reasoning { badge("Reasoning") }
                        if model.input.contains("image") { badge("Images") }
                        if let price = model.pricing { badge(price.input == 0 ? "free" : String(format: "$%.2f in", price.input), tint: .secondary) }
                    }
                }
                Spacer(minLength: 4)
                if chosen {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(HubWorkspacePalette.accent).accessibilityLabel("Selected")
                }
            }
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("hub.model.\(model.id)")
    }

    private func badge(_ text: String, tint: Color = HubWorkspacePalette.accent) -> some View {
        Text(text).font(.caption2.weight(.medium)).foregroundStyle(tint)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(tint.opacity(0.12), in: Capsule()).lineLimit(1)
    }
}
