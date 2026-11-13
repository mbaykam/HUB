import SwiftUI
import HubNative

@MainActor
struct HubGoalEditorView: View {
    let api: HubConversationAPI
    let id: String?
    let saved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var data: HubGoalEditorData?
    @State private var draft: HubGoalEditorData.Draft?
    @State private var criteria = ""
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?
    @State private var attempt = 0

    var body: some View {
        NavigationView {
            Form {
                if let error { Text(error).font(.footnote).foregroundStyle(.secondary) }
                if loading || saving { ProgressView() }
                if let data, let draft { fields(draft, data: data) }
                if data == nil && !loading { Button("Retry") { attempt += 1 } }
            }
            .disabled(saving)
            .navigationTitle(id == nil ? "New goal" : "Edit goal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(saving)
                }
            }
        }
        .navigationViewStyle(.stack)
        .interactiveDismissDisabled(draft != nil || saving)
        .task(id: attempt) { await load() }
    }

    @ViewBuilder
    private func fields(_ current: HubGoalEditorData.Draft, data: HubGoalEditorData) -> some View {
        Section("Outcome") {
            TextField("Goal name", text: field(\.title, current))
            Text("Desired outcome").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: field(\.objective, current)).frame(minHeight: 95)
                .accessibilityLabel("Desired outcome")
            Text("What counts as done · one criterion per line").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $criteria).frame(minHeight: 90)
                .accessibilityLabel("Acceptance criteria")
            Toggle("Ask me to accept the final result", isOn: field(\.humanApproval, current))
        }
        Section("Character & approach") {
            Picker("Owner character", selection: field(\.characterID, current)) {
                if !data.characters.contains(where: { $0.id == current.characterID }) {
                    Text("Choose a character").tag(current.characterID)
                }
                ForEach(data.characters) { character in
                    Text(character.route == nil ? "\(character.name) · model needed" : character.name).tag(character.id)
                }
            }
            Picker("Approach", selection: field(\.approach, current)) {
                Text("Quick").tag("quick")
                Text("Balanced").tag("balanced")
                Text("Thorough").tag("thorough")
                Text("Custom").tag("custom")
            }
            Text("Goal-specific instructions").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: field(\.instructions, current)).frame(minHeight: 80)
                .accessibilityLabel("Goal-specific instructions")
        }
        if !data.isResearch {
            Section("Resources & allowance") {
                Toggle("Read relevant Knowledge", isOn: field(\.knowledge, current))
                Toggle("Search public websites", isOn: field(\.browser, current))
                TextField("Active work allowance in minutes", value: field(\.activeMinutes, current), format: .number.grouping(.never))
                    .keyboardType(.numberPad)
            }
        }
        Section {
            Button(id == nil ? "Save draft" : "Save changes") { Task { await save() } }
                .disabled(!canSave(current))
            if id == nil { Text("Start the saved draft from Tasks when you’re ready.").font(.footnote).foregroundStyle(.secondary) }
        }
    }

    private func field<Value>(_ key: WritableKeyPath<HubGoalEditorData.Draft, Value>, _ value: HubGoalEditorData.Draft) -> Binding<Value> {
        Binding(get: { draft?[keyPath: key] ?? value[keyPath: key] }, set: { draft?[keyPath: key] = $0 })
    }

    private var criteriaLines: [String] {
        criteria.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }

    private func canSave(_ current: HubGoalEditorData.Draft) -> Bool {
        !current.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !current.objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !current.characterID.isEmpty && (1...20).contains(criteriaLines.count) &&
            (1...10_080).contains(current.activeMinutes)
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let result = try await api.goalEditor(id: id)
            guard !Task.isCancelled else { return }
            data = result
            draft = result.draft
            criteria = result.draft.criteria.joined(separator: "\n")
            error = nil
        } catch {
            if !Task.isCancelled { self.error = "Could not load the goal settings." }
        }
    }

    private func save() async {
        guard !saving, let data, var draft, canSave(draft) else { return }
        draft.criteria = criteriaLines
        saving = true
        defer { saving = false }
        do {
            _ = try await api.saveGoal(draft, from: data)
            saved()
            dismiss()
        } catch {
            self.error = "Could not confirm the save. Your edits are still here. Check Tasks before trying again."
        }
    }
}
