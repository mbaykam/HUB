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
        if let milestones = current.milestones { plan(milestones) }
        if !data.isResearch {
            Section("Resources") {
                Toggle("Read relevant Knowledge", isOn: field(\.knowledge, current))
                Toggle("Search public websites", isOn: field(\.browser, current))
                Toggle("Allow approved Knowledge outputs", isOn: optional(\.knowledgeOutput, default: false))
                listField("Read folders", key: \.folders)
                listField("Input files", key: \.files)
                listField("Write folders", key: \.writeFolders)
                listField("Additional tools", key: \.tools)
            }
            Section("Work allowance") {
                TextField("Active work allowance in minutes", value: field(\.activeMinutes, current), format: .number.grouping(.never))
                    .keyboardType(.numberPad)
                integerField("Total rounds", key: \.maxRounds, fallback: 40)
                integerField("Daily rounds", key: \.dailyRounds, fallback: 40)
                integerField("Steps per round", key: \.maxSteps, fallback: 8)
                integerField("Output tokens per step", key: \.maxOutputTokens, fallback: 4_096)
                amountField("Daily API budget ($)", key: \.dailyBudget, fallback: 1)
                amountField("Total API budget ($)", key: \.totalBudget, fallback: 5)
                amountField("Input cost per million tokens ($)", key: \.inputPrice, fallback: 0.1)
                amountField("Output cost per million tokens ($)", key: \.outputPrice, fallback: 0.5)
                Toggle("Set a deadline", isOn: Binding(
                    get: { draft?.deadline != nil },
                    set: { draft?.deadline = $0 ? Date().addingTimeInterval(86_400) : nil }))
                if let deadline = current.deadline {
                    DatePicker("Deadline", selection: optional(\.deadline, default: deadline))
                }
                Picker("After HUB restarts", selection: optional(\.recovery, default: "read-only")) {
                    Text("Recover read-only work").tag("read-only")
                    Text("Wait for me").tag("ask")
                }
            }
            workingHours(current)
            if let schedule = current.schedule { scheduleFields(schedule) }
            collaborators(data, current: current)
        }
        if data.canNotifyTelegram {
            Section("Results") {
                Picker("Notify me in", selection: optional(\.notification, default: "pwa")) {
                    Text("HUB activity").tag("pwa")
                    Text("Originating Telegram chat").tag("telegram")
                }
            }
        }
        Section {
            Button(id == nil ? "Save draft" : "Save changes") { Task { await save() } }
                .disabled(!canSave(current))
            if id == nil { Text("Start the saved draft from Tasks when you’re ready.").font(.footnote).foregroundStyle(.secondary) }
        }
    }

    private func scheduleFields(_ current: HubGoalEditorData.Schedule) -> some View {
        Section("Start & recurrence") {
            HubScheduleTriggerFields(trigger: scheduleField(\.trigger, current: current), allowsManual: true)
            if current.trigger.kind != .manual {
                Picker("On recurring starts", selection: scheduleField(\.recurrence, current: current)) {
                    Text("Continue the same goal").tag(HubGoalEditorData.Schedule.Recurrence.continue)
                    Text("Produce a separate result").tag(HubGoalEditorData.Schedule.Recurrence.fresh)
                }
                Picker("If HUB missed a start", selection: scheduleField(\.missed, current: current)) {
                    Text("Catch up once").tag(HubGoalEditorData.Schedule.Missed.catchUp)
                    Text("Skip").tag(HubGoalEditorData.Schedule.Missed.skip)
                }
            }
        }
    }

    private func scheduleField<Value>(_ key: WritableKeyPath<HubGoalEditorData.Schedule, Value>,
                                      current: HubGoalEditorData.Schedule) -> Binding<Value> {
        Binding(get: { draft?.schedule?[keyPath: key] ?? current[keyPath: key] }, set: { draft?.schedule?[keyPath: key] = $0 })
    }

    private func workingHours(_ current: HubGoalEditorData.Draft) -> some View {
        Section("Working hours") {
            Toggle("Restrict working hours", isOn: Binding(
                get: { draft?.workingHours != nil },
                set: { enabled in
                    if enabled {
                        if draft?.workingHours == nil { draft?.workingHours = .init() }
                    } else { draft?.workingHours = nil }
                }))
            if let hours = current.workingHours {
                DatePicker("Start", selection: workClock(\.start), displayedComponents: .hourAndMinute)
                DatePicker("End", selection: workClock(\.end), displayedComponents: .hourAndMinute)
                TextField("Time zone", text: Binding(get: { draft?.workingHours?.timezone ?? hours.timezone },
                    set: { draft?.workingHours?.timezone = $0.trimmingCharacters(in: .whitespacesAndNewlines) }))
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                DisclosureGroup("Weekdays · \(hours.days.count) selected") {
                    let weekdays = Calendar.current.weekdaySymbols
                    ForEach(weekdays.indices, id: \.self) { day in
                        Toggle(weekdays[day], isOn: Binding(get: { draft?.workingHours?.days.contains(day) == true }, set: { selected in
                            var values = Set(draft?.workingHours?.days ?? [])
                            if selected { values.insert(day) } else { values.remove(day) }
                            draft?.workingHours?.days = values.sorted()
                        }))
                    }
                }
                if !hours.isValid {
                    Text("Choose weekdays, different start and end times, and a time zone such as Europe/Istanbul.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .environment(\.timeZone, TimeZone(secondsFromGMT: 0)!)
    }

    private func workClock(_ key: WritableKeyPath<HubGoalEditorData.WorkingHours, Int>) -> Binding<Date> {
        Binding(get: {
            Date(timeIntervalSince1970: Double(draft?.workingHours?[keyPath: key] ?? 0) * 60)
        }, set: { date in
            let minutes = Int(date.timeIntervalSince1970 / 60)
            draft?.workingHours?[keyPath: key] = (minutes % 1_440 + 1_440) % 1_440
        })
    }

    private func plan(_ milestones: [HubGoalEditorData.Milestone]) -> some View {
        Section("Milestones") {
            if milestones.isEmpty { Text("No milestones yet.").foregroundStyle(.secondary) }
            ForEach(milestones) { milestone in
                DisclosureGroup(milestone.title.isEmpty ? "New milestone" : milestone.title) {
                    TextField("Milestone title", text: milestoneField(\.title, for: milestone))
                    Picker("Progress", selection: milestoneField(\.status, for: milestone)) {
                        ForEach(HubGoalEditorData.Milestone.Status.allCases, id: \.self) { status in
                            Text(status.rawValue.capitalized).tag(status)
                        }
                    }
                    let others = milestones.filter { $0.id != milestone.id }
                    if !others.isEmpty {
                        DisclosureGroup("Depends on") {
                            ForEach(others) { other in
                                let dependencies = milestoneField(\.dependsOn, for: milestone)
                                Toggle(other.title.isEmpty ? "Untitled milestone" : other.title, isOn: Binding(
                                    get: { dependencies.wrappedValue.contains(other.id) },
                                    set: { selected in
                                        var ids = dependencies.wrappedValue.filter { $0 != other.id }
                                        if selected { ids.append(other.id) }
                                        dependencies.wrappedValue = ids
                                    }))
                                    .disabled(!milestone.dependsOn.contains(other.id) &&
                                              dependencyReaches(milestone.id, from: other.id, in: milestones))
                            }
                        }
                    }
                    if !milestone.evidence.isEmpty {
                        Text("\(milestone.evidence.count) evidence references").font(.footnote).foregroundStyle(.secondary)
                    }
                    Button("Remove milestone", role: .destructive) {
                        var next = milestones.filter { $0.id != milestone.id }
                        for index in next.indices { next[index].dependsOn.removeAll { $0 == milestone.id } }
                        draft?.milestones = next
                    }
                }
            }
            Button {
                draft?.milestones?.append(HubGoalEditorData.Milestone())
            } label: {
                Label("Add milestone", systemImage: "plus")
            }
            .disabled(milestones.count >= 80)
        }
    }

    private func dependencyReaches(_ target: String, from start: String, in milestones: [HubGoalEditorData.Milestone]) -> Bool {
        var targets = [start]
        var visited: Set<String> = []
        while let next = targets.popLast() {
            if next == target { return true }
            if visited.insert(next).inserted, let milestone = milestones.first(where: { $0.id == next }) {
                targets.append(contentsOf: milestone.dependsOn)
            }
        }
        return false
    }

    private func milestoneField<Value>(_ key: WritableKeyPath<HubGoalEditorData.Milestone, Value>,
                                       for original: HubGoalEditorData.Milestone) -> Binding<Value> {
        Binding(get: {
            draft?.milestones?.first(where: { $0.id == original.id })?[keyPath: key] ?? original[keyPath: key]
        }, set: { value in
            guard let index = draft?.milestones?.firstIndex(where: { $0.id == original.id }) else { return }
            draft?.milestones?[index][keyPath: key] = value
        })
    }

    private func collaborators(_ data: HubGoalEditorData, current: HubGoalEditorData.Draft) -> some View {
        let characters = data.characters.filter { $0.route != nil }
        return Section("Collaboration") {
            Picker("Independent verifier", selection: optional(\.verifierID, default: "")) {
                Text("None").tag("")
                if let verifier = current.verifierID, !verifier.isEmpty, !characters.contains(where: { $0.id == verifier }) {
                    Text("Unavailable character").tag(verifier)
                }
                ForEach(characters) { Text($0.name).tag($0.id) }
            }
            DisclosureGroup("Helpers") {
                ForEach(characters) { character in
                    Toggle(character.name, isOn: characterRole(character.id, key: \.helpers))
                }
            }
            DisclosureGroup("Model fallbacks") {
                ForEach(characters) { character in
                    Toggle(character.name, isOn: characterRole(character.id, key: \.fallbacks))
                }
            }
        }
    }

    private func characterRole(_ id: String, key: WritableKeyPath<HubGoalEditorData.Draft, [String]?>) -> Binding<Bool> {
        Binding(get: { draft?[keyPath: key]?.contains(id) ?? false }, set: { on in
            var list = draft?[keyPath: key] ?? []
            if on && !list.contains(id) && list.count < 5 { list.append(id) }
            if !on { list.removeAll { $0 == id } }
            draft?[keyPath: key] = list
        })
    }

    private func listField(_ title: String, key: WritableKeyPath<HubGoalEditorData.Draft, [String]?>) -> some View {
        GoalPathListField(title: title, entries: optional(key, default: []))
    }

    private func integerField(_ title: String, key: WritableKeyPath<HubGoalEditorData.Draft, Int?>, fallback: Int) -> some View {
        TextField(title, value: optional(key, default: fallback), format: .number.grouping(.never))
            .keyboardType(.numberPad)
    }

    private func amountField(_ title: String, key: WritableKeyPath<HubGoalEditorData.Draft, Double?>, fallback: Double) -> some View {
        TextField(title, value: optional(key, default: fallback), format: .number)
            .keyboardType(.decimalPad)
    }

    private func optional<Value>(_ key: WritableKeyPath<HubGoalEditorData.Draft, Value?>, default value: Value) -> Binding<Value> {
        Binding(get: { draft?[keyPath: key] ?? value }, set: { draft?[keyPath: key] = $0 })
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
            (1...10_080).contains(current.activeMinutes) &&
            (current.workingHours?.isValid ?? true) &&
            (current.milestones?.allSatisfy { !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? true)
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

private struct GoalPathListField: View {
    let title: String
    @Binding var entries: [String]
    @State private var text = ""

    var body: some View {
        DisclosureGroup(title) {
            Text("One entry per line").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $text)
                .accessibilityLabel(title)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .frame(minHeight: 76)
                .onAppear { text = entries.joined(separator: "\n") }
                .onChange(of: text) { value in
                    entries = value.components(separatedBy: .newlines)
                        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
                }
        }
    }
}
