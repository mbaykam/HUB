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
