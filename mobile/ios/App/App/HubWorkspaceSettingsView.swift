import SwiftUI
import HubNative

@MainActor
struct HubWorkspaceSettingsView: View {
    let api: HubConversationAPI?
    let iPhoneSettings: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            List {
                if let api {
                    NavigationLink(destination: HubCharactersSettingsView(api: api)) {
                        Label("Characters", systemImage: "person.2")
                    }
                    NavigationLink(destination: HubModelsView(api: api)) {
                        Label("Models & providers", systemImage: "cpu")
                    }
                    NavigationLink(destination: HubInstructionsView(api: api)) {
                        Label("Instructions", systemImage: "doc.text")
                    }
                    NavigationLink(destination: HubKnowledgeSettingsView(api: api)) {
                        Label("Knowledge AI", systemImage: "circle.hexagongrid")
                    }
                    NavigationLink(destination: HubTelegramSettingsView(api: api)) {
                        Label("Telegram", systemImage: "paperplane")
                    }
                    NavigationLink(destination: HubUsageView(api: api)) {
                        Label("Usage limits", systemImage: "chart.bar.xaxis")
                    }
                } else {
                    Text("Connect to HUB to view its settings.").foregroundStyle(.secondary)
                }
                Button {
                    iPhoneSettings()
                } label: { Label("iPhone settings", systemImage: "iphone") }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
        }
        .navigationViewStyle(.stack)
        .preferredColorScheme(.dark)
    }
}

@MainActor
private struct HubTelegramSettingsView: View {
    let api: HubConversationAPI
    @State private var status: HubTelegramStatus?
    @State private var token = ""
    @State private var busy = false
    @State private var failed = false
    @State private var confirmApproval = false

    var body: some View {
        Form {
            if busy { ProgressView("Checking Telegram…") }
            if failed { Text("Could not confirm the operation. Refresh Telegram status to check.").foregroundStyle(.secondary) }
            if let status {
                Section("Connection") {
                    Text(status.state.replacingOccurrences(of: "-", with: " ").capitalized)
                    if let label = status.accountLabel { Text(label) }
                    if let issue = status.issue { Text(issue).font(.footnote).foregroundStyle(.secondary) }
                    Button("Reconnect") { Task { await update { try await api.reconnectTelegram() } } }
                }
                if let pairing = status.request {
                    Section("Pairing request") {
                        Text(pairing.senderLabel)
                        Text(pairing.code).font(.body.monospaced()).textSelection(.enabled)
                        if let expires = pairing.expiresAt {
                            Text(Date(timeIntervalSince1970: expires / 1000).formatted()).font(.caption)
                        }
                        Button("Approve pairing") { confirmApproval = true }
                    }
                }
            }
            Section("Bot setup") {
                SecureField("Bot token", text: $token)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Connect bot") {
                    let submitted = token.trimmingCharacters(in: .whitespacesAndNewlines)
                    token = ""
                    Task { await update { try await api.connectTelegram(token: submitted) } }
                }
                .disabled(token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Button("Refresh") { Task { await update { try await api.telegramStatus() } } }
        }
        .disabled(busy)
        .navigationTitle("Telegram")
        .task { await update { try await api.telegramStatus() } }
        .confirmationDialog("Approve this Telegram account?", isPresented: $confirmApproval,
                            titleVisibility: .visible, presenting: status?.request) { pairing in
            Button("Approve pairing") { Task { await update { try await api.approveTelegram(requestID: pairing.requestId) } } }
        } message: { pairing in
            Text(pairing.senderLabel)
        }
    }

    private func update(_ operation: () async throws -> HubTelegramStatus) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { status = try await operation(); failed = false }
        catch { if !Task.isCancelled { failed = true } }
    }
}

@MainActor
private struct HubKnowledgeSettingsView: View {
    let api: HubConversationAPI
    @State private var status: HubKnowledgeStatus?
    @State private var draft: HubKnowledgeSettings?
    @State private var models: HubModelCatalog?
    @State private var error: String?
    @State private var busy = false
    @State private var showModels = false

    var body: some View {
        Form {
            if let error { Text(error).foregroundStyle(.secondary) }
            if busy { ProgressView("Updating Knowledge AI…") }
            if let status, let draft {
                form(status, draft: draft)
            } else if !busy {
                Button("Retry") { Task { await load() } }
            }
        }
        .disabled(busy)
        .navigationTitle("Knowledge AI")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if let draft, let status {
                    Button("Save") { Task { await save(draft) } }.disabled(busy || draft == status.settings)
                }
            }
        }
        .task { await load() }
        .sheet(isPresented: $showModels) { modelPicker }
    }

    private func form(_ status: HubKnowledgeStatus, draft: HubKnowledgeSettings) -> some View {
        Group {
            Section("General") {
                Toggle("Process knowledge", isOn: setting(\.enabled, fallback: draft.enabled))
                Button {
                    showModels = true
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Choose model")
                        Text("\(draft.provider) · \(draft.model)").font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let model = models?.models.first(where: { $0.provider == draft.provider && $0.modelID == draft.model }),
                   let efforts = model.efforts, !efforts.isEmpty {
                    Picker("Reasoning effort", selection: setting(\.reasoningEffort, fallback: draft.reasoningEffort)) {
                        Text("Provider default").tag("")
                        if !draft.reasoningEffort.isEmpty, !efforts.contains(where: { $0.id == draft.reasoningEffort }) {
                            Text(draft.reasoningEffort).tag(draft.reasoningEffort)
                        }
                        ForEach(efforts) { Text($0.name).tag($0.id) }
                    }
                }
                Picker("When to run", selection: setting(\.mode, fallback: draft.mode)) {
                    Text("Automatically").tag("automatic")
                    Text("Review proposals first").tag("review")
                    Text("Only when started manually").tag("manual")
                }
                Picker("Wait after a chat", selection: setting(\.idleSeconds, fallback: draft.idleSeconds)) {
                    Text("1 minute").tag(60)
                    Text("5 minutes").tag(300)
                    Text("15 minutes").tag(900)
                    Text("1 hour").tag(3600)
                    if ![60, 300, 900, 3600].contains(draft.idleSeconds) {
                        Text("\(draft.idleSeconds) seconds").tag(draft.idleSeconds)
                    }
                }
                Toggle("Extract lasting notes", isOn: flag(\.extractMemories))
            }
            Section("Sources") {
                choices([("pwa", "HUB chats"), ("telegram", "Telegram"), ("voice", "Voice"),
                         ("workers", "Delegated work"), ("imports", "Imports")], key: \.channels)
                DisclosureGroup("What to remember") {
                    choices([("preferences", "Personal preferences"), ("decisions", "Decisions"),
                             ("projects", "Projects"), ("learning", "Learning"), ("summaries", "Summaries")], key: \.categories)
                }
                Picker("Assistant explanations", selection: setting(\.assistantEvidence, fallback: draft.assistantEvidence)) {
                    Text("Confirmed information").tag("confirmed-only")
                    Text("Include useful explanations").tag("useful-explanations")
                }
            }
            Section("Links and reflections") {
                Picker("Detail", selection: setting(\.detail, fallback: draft.detail)) {
                    Text("Concise").tag("concise")
                    Text("Balanced").tag("balanced")
                    Text("Detailed").tag("detailed")
                }
                Picker("Language", selection: setting(\.language, fallback: draft.language)) {
                    Text("Conversation language").tag("auto")
                    Text("Türkçe").tag("tr")
                    Text("English").tag("en")
                }
                Picker("New links", selection: setting(\.linking, fallback: draft.linking)) {
                    Text("Link related records").tag("inline")
                    Text("Off").tag("off")
                }
                Stepper("Maximum links · \(draft.maxLinks)", value: setting(\.maxLinks, fallback: draft.maxLinks), in: 1...12)
                Toggle("Save sourced reflections", isOn: flag(\.reflections))
                Toggle("Suggest profile edits", isOn: flag(\.profileSuggestions))
                TextEditor(text: setting(\.instructions, fallback: draft.instructions))
                    .frame(minHeight: 86).accessibilityLabel("Knowledge instructions")
            }
            Section("Usage and limits") {
                Text(status.status.replacingOccurrences(of: "-", with: " ").capitalized)
                Text("\(status.counts["queued"] ?? 0) queued · \(status.counts["working"] ?? 0) working · \(status.counts["failed"] ?? 0) failed")
                Text("Today $\(status.todayEstimatedCost, specifier: "%.4f") · Month $\(status.monthEstimatedCost ?? 0, specifier: "%.4f")")
                number("Daily budget (USD)", key: \.dailyBudget, fallback: draft.dailyBudget)
                number("Monthly budget (USD)", key: \.monthlyBudget, fallback: draft.monthlyBudget)
                number("Input price per 1M tokens", key: \.inputPrice, fallback: draft.inputPrice)
                number("Output price per 1M tokens", key: \.outputPrice, fallback: draft.outputPrice)
                NavigationLink("Knowledge AI Activity", destination: HubKnowledgeActivityView(api: api))
            }
        }
    }

    private var modelPicker: some View {
        NavigationView {
            List {
                if let models {
                    ForEach(models.models.filter { $0.available != false }) { model in
                        Button {
                            draft?.provider = model.provider
                            draft?.model = model.modelID
                            draft?.reasoningEffort = model.defaultEffort ?? ""
                            if let pricing = model.pricing {
                                draft?.inputPrice = max(0.001, pricing.input)
                                draft?.outputPrice = max(0.001, pricing.output)
                            }
                            showModels = false
                        } label: {
                            VStack(alignment: .leading) {
                                Text(model.name).font(.headline)
                                Text(model.provider).font(.caption)
                            }
                        }
                    }
                } else {
                    ProgressView("Loading models…")
                    Button("Retry") { Task { models = try? await api.modelCatalog() } }
                }
            }
            .navigationTitle("Knowledge AI model")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { showModels = false } } }
            .task { if models == nil { models = try? await api.modelCatalog() } }
        }
        .navigationViewStyle(.stack)
    }

    private func setting<Value>(_ key: WritableKeyPath<HubKnowledgeSettings, Value>, fallback: Value) -> Binding<Value> {
        Binding(get: { draft?[keyPath: key] ?? fallback }, set: { draft?[keyPath: key] = $0 })
    }

    private func flag(_ key: WritableKeyPath<HubKnowledgeSettings, Bool?>) -> Binding<Bool> {
        Binding(get: { draft?[keyPath: key] ?? false }, set: { draft?[keyPath: key] = $0 })
    }

    private func choices(_ options: [(String, String)], key: WritableKeyPath<HubKnowledgeSettings, [String]>) -> some View {
        ForEach(options.indices, id: \.self) { index in
            let option = options[index]
            Toggle(option.1, isOn: Binding(get: { draft?[keyPath: key].contains(option.0) ?? false }, set: { enabled in
                guard var value = draft?[keyPath: key] else { return }
                value.removeAll { $0 == option.0 }
                if enabled { value.append(option.0) }
                draft?[keyPath: key] = value
            }))
        }
    }

    private func number(_ label: String, key: WritableKeyPath<HubKnowledgeSettings, Double>, fallback: Double) -> some View {
        TextField(label, value: setting(key, fallback: fallback), format: .number).keyboardType(.decimalPad)
    }

    private func load() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let value = try await api.knowledgeStatus()
            if !Task.isCancelled { status = value; draft = value.settings; error = nil }
        } catch {
            if !Task.isCancelled { self.error = "Could not load Knowledge AI settings." }
        }
    }

    private func save(_ value: HubKnowledgeSettings) async {
        guard !busy else { return }
        guard value.instructions.utf16.count <= 4_000,
              !value.channels.isEmpty, !value.categories.isEmpty,
              [value.dailyBudget, value.monthlyBudget, value.inputPrice, value.outputPrice].allSatisfy({ $0.isFinite && $0 > 0 && $0 <= 100 }) else {
            error = "Check the instruction length, sources, categories and budget values."
            return
        }
        busy = true
        defer { busy = false }
        do {
            let saved = try await api.saveKnowledgeSettings(value)
            status = saved
            draft = saved.settings
            error = nil
        } catch {
            self.error = "Could not confirm the save. Your settings draft is retained."
        }
    }
}

@MainActor
private struct HubModelsView: View {
    let api: HubConversationAPI
    @State private var catalog: HubModelCatalog?
    @State private var query = ""
    @State private var provider = ""
    @State private var favorites = false
    @State private var busy = false
    @State private var error: String?
    @State private var enabledModels: Set<String> = []
    @State private var sort = Sort.name

    private enum Sort: String, CaseIterable { case name = "Name", recent = "Newest", price = "Lowest price" }

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.secondary) }
            if busy { ProgressView("Updating models…") }
            if let catalog {
                Section {
                    Picker("Provider", selection: $provider) {
                        Text("All providers").tag("")
                        ForEach(catalog.providers) { Text($0.name).tag($0.id) }
                    }
                    Picker("Sort", selection: $sort) {
                        ForEach(Sort.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    Toggle("Favorites", isOn: $favorites)
                    Button("Refresh catalogue") { Task { await load(refresh: true) } }
                }
                .disabled(busy)
                if let warning = catalog.warning { Text(warning).foregroundStyle(.secondary) }
                if catalog.stale { Text("Showing the saved catalogue while HUB refreshes.").font(.footnote) }
                let filtered = models(catalog)
                if filtered.isEmpty { Text("No matching models").foregroundStyle(.secondary) }
                Section {
                    ForEach(filtered.prefix(100)) { model in
                        modelRow(model)
                    }
                    if filtered.count > 100 { Text("Refine search to see more models.").foregroundStyle(.secondary) }
                } header: { Text("\(filtered.count) models") }
                Section("Provider adapters") {
                    ForEach(catalog.providers) { Text($0.name) }
                }
            } else if !busy {
                Button("Retry") { Task { await load() } }
            }
        }
        .navigationTitle("Models & providers")
        .searchable(text: $query, prompt: "Search models")
        .task { await load() }
        .refreshable { await load() }
    }

    private func models(_ catalog: HubModelCatalog) -> [HubModelCatalog.Model] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return catalog.models.filter {
            (!favorites || $0.favorite == true) && (provider.isEmpty || $0.provider == provider) &&
                (text.isEmpty || "\($0.name) \($0.modelID)".localizedCaseInsensitiveContains(text))
        }.sorted {
            switch sort {
            case .name: return $0.name.localizedStandardCompare($1.name) == .orderedAscending
            case .recent: return ($0.created ?? 0) > ($1.created ?? 0)
            case .price: return ($0.pricing?.input ?? .infinity) < ($1.pricing?.input ?? .infinity)
            }
        }
    }

    private func modelRow(_ model: HubModelCatalog.Model) -> some View {
        DisclosureGroup {
            if let description = model.description { Text(description).font(.footnote) }
            Text("Input · \(model.input.joined(separator: ", "))").font(.footnote)
            if let maxTokens = model.maxTokens { Text("Output limit · \(maxTokens)").font(.footnote) }
            if let efforts = model.efforts, !efforts.isEmpty {
                Text("Reasoning · \(efforts.map(\.name).joined(separator: ", "))").font(.footnote)
            }
            if let supported = model.supportedParameters, !supported.isEmpty {
                Text("Parameters · \(supported.joined(separator: ", "))").font(.footnote)
            }
            if !model.enabled && !enabledModels.contains(model.id) {
                Button("Enable model") { Task { await enable(model) } }
                    .buttonStyle(.borderless).disabled(busy || model.available == false)
            } else {
                Text("Available for characters").font(.footnote).foregroundStyle(.secondary)
            }
        } label: {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.name).font(.headline)
                    Text("\(model.provider) · \(model.modelID)").font(.caption).foregroundStyle(.secondary)
                    Text(capabilities(model)).font(.caption).foregroundStyle(.secondary)
                    if let price = model.pricing {
                        Text("$\(price.input, specifier: "%.3f") input / $\(price.output, specifier: "%.3f") output per 1M tokens")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Button { Task { await favorite(model) } } label: {
                    Image(systemName: model.favorite == true ? "star.fill" : "star")
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(model.favorite == true ? "Remove favorite" : "Favorite")
                .disabled(busy)
            }
        }
    }

    private func capabilities(_ model: HubModelCatalog.Model) -> String {
        var facts: [String] = []
        if let context = model.contextWindow { facts.append("\(context / 1000)k context") }
        facts.append(model.tools ? "Tools" : "Chat only")
        if model.input.contains("image") { facts.append("Images") }
        if model.reasoning { facts.append("Reasoning") }
        if model.available == false { facts.append("Temporarily paused") }
        return facts.joined(separator: " · ")
    }

    private func load(refresh: Bool = false) async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do { catalog = try await api.modelCatalog(refresh: refresh) }
        catch { if !Task.isCancelled { self.error = "Could not load the model catalogue." } }
    }

    private func favorite(_ model: HubModelCatalog.Model) async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do { catalog = try await api.setModelFavorite(model, selected: model.favorite != true) }
        catch { self.error = "Could not confirm the favorite. Refresh the catalogue to check." }
    }

    private func enable(_ model: HubModelCatalog.Model) async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await api.enableCatalogModel(model)
            enabledModels.insert(model.id)
        } catch {
            self.error = "Could not confirm model availability. Refresh the catalogue to check."
        }
    }
}

@MainActor
struct HubInstructionsView: View {
    let api: HubConversationAPI
    var sessionID: String? = nil
    @State private var catalog: HubInstructionCatalog?
    @State private var error: String?
    @State private var attempt = 0

    var body: some View {
        List {
            if let catalog {
                Section("Shared files") {
                    ForEach(catalog.shared) { row($0) }
                }
                Section("Character instructions") {
                    ForEach(catalog.characters) { row($0.instructions) }
                }
                if let request = catalog.lastRequest {
                    Section("Last request") {
                        DisclosureGroup("System prompt") { Text(request.system).textSelection(.enabled) }
                        ForEach(request.workspace.indices, id: \.self) { index in
                            DisclosureGroup("Workspace instructions \(index + 1)") {
                                Text(request.workspace[index]).textSelection(.enabled)
                            }
                        }
                    }
                }
            } else if let error {
                Text(error)
                Button("Retry") { attempt += 1 }
            } else {
                ProgressView("Loading instructions…")
            }
        }
        .navigationTitle("Instructions")
        .task(id: attempt) {
            error = nil
            do { catalog = try await api.instructions(sessionID: sessionID) }
            catch { if !Task.isCancelled { self.error = "Could not load instructions." } }
        }
    }

    private func row(_ file: HubInstructionCatalog.File) -> some View {
        NavigationLink(destination: HubInstructionEditor(file: file, api: api, didSave: { catalog = $0 })) {
            VStack(alignment: .leading, spacing: 4) {
                Text(file.name)
                Text(file.scope).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

@MainActor
private struct HubInstructionEditor: View {
    let api: HubConversationAPI
    let didSave: (HubInstructionCatalog) -> Void
    @State private var file: HubInstructionCatalog.File
    @State private var draft: String
    @State private var busy = false
    @State private var notice: String?

    init(file: HubInstructionCatalog.File, api: HubConversationAPI, didSave: @escaping (HubInstructionCatalog) -> Void) {
        self.api = api
        self.didSave = didSave
        _file = State(initialValue: file)
        _draft = State(initialValue: file.content)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
            if file.editable {
                TextEditor(text: $draft).font(.body.monospaced()).disabled(busy)
            } else {
                ScrollView { Text(file.content).font(.body.monospaced()).textSelection(.enabled) }
            }
        }
        .padding(12)
        .navigationTitle(file.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if file.editable {
                    Button("Save") { Task { await save() } }.disabled(busy || draft == file.content)
                }
            }
        }
    }

    private func save() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let updated = try await api.saveInstruction(file, content: draft)
            if let replacement = (updated.shared + updated.characters.map(\.instructions)).first(where: { $0.id == file.id }) {
                file = replacement
                draft = replacement.content
            }
            didSave(updated)
            notice = "Saved"
        } catch {
            self.notice = "Could not confirm the save. The draft is retained. Check the saved instructions before trying again."
        }
    }
}
