import SwiftUI
import HubNative

@MainActor
struct HubRoutineEditorView: View {
    let api: HubConversationAPI
    let id: String?
    let goals: [HubWorkspaceTask]
    let saved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var data: HubRoutineEditorData?
    @State private var draft: HubRoutineEditorData.Draft?
    @State private var tools = ""
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?
    @State private var attempt = 0

    private let weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    private let events = ["host.started", "task.completed", "task.failed", "knowledge.archived"]

    var body: some View {
        NavigationView {
            Form {
                if let error { Text(error).font(.footnote).foregroundStyle(.secondary) }
                if loading || saving { ProgressView() }
                if let data, let draft {
                    purpose(draft, data: data)
                    schedule(draft.trigger)
                    limits(draft)
                    Button(id == nil ? "Save and schedule" : "Save routine") { Task { await save() } }
                        .disabled(!canSave(draft, data: data))
                } else if !loading {
                    Button("Retry") { attempt += 1 }
                }
            }
            .disabled(saving)
            .navigationTitle(id == nil ? "New routine" : "Edit routine")
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

    private func purpose(_ current: HubRoutineEditorData.Draft, data: HubRoutineEditorData) -> some View {
        Section("Routine") {
            TextField("Name", text: field(\.title, current))
            Text("What should the routine do?").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: field(\.prompt, current)).frame(minHeight: 100)
                .accessibilityLabel("Routine instructions")
            Picker("Character", selection: field(\.characterId, current)) {
                if current.characterId.isEmpty { Text("Choose a character").tag("") }
                ForEach(data.characters) { character in
                    Text(character.route == nil ? "\(character.name) · model needed" : character.name)
                        .tag(character.id).disabled(character.route == nil)
                }
            }
            Picker("Linked goal", selection: optionalField(\.goalId, current.goalId)) {
                Text("Independent routine").tag("")
                let eligible = goals.filter { $0.state == "active" || $0.id == current.goalId }
                if let goalID = current.goalId, !eligible.contains(where: { $0.id == goalID }) {
                    Text("Previously linked goal").tag(goalID)
                }
                ForEach(eligible) { Text($0.title).tag($0.id) }
            }
        }
    }

    private func schedule(_ current: HubRoutineEditorData.Trigger) -> some View {
        Section("Schedule") {
            Picker("Trigger", selection: Binding(get: { current.kind }, set: selectTrigger)) {
                Text("Once").tag(HubRoutineEditorData.Trigger.Kind.once)
                Text("At an interval").tag(HubRoutineEditorData.Trigger.Kind.interval)
                Text("On selected weekdays").tag(HubRoutineEditorData.Trigger.Kind.calendar)
                Text("Watch a public source").tag(HubRoutineEditorData.Trigger.Kind.watch)
                Text("When a HUB event occurs").tag(HubRoutineEditorData.Trigger.Kind.event)
            }
            switch current.kind {
            case .once:
                DatePicker("Run at", selection: Binding(
                    get: { Date(timeIntervalSince1970: Double(draft?.trigger.at ?? 0) / 1_000) },
                    set: { draft?.trigger.at = Int64($0.timeIntervalSince1970 * 1_000) }))
            case .interval:
                intervalField
            case .calendar:
                Stepper("Hour · \(current.hour ?? 9)", value: trigger(\.hour, default: 9), in: 0...23)
                Stepper("Minute · \(current.minute ?? 0)", value: trigger(\.minute, default: 0), in: 0...59)
                TextField("Time zone", text: trigger(\.timezone, default: TimeZone.current.identifier))
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                ForEach(weekdays.indices, id: \.self) { day in
                    Toggle(weekdays[day], isOn: Binding(get: { draft?.trigger.days?.contains(day) == true }, set: { on in
                        var values = Set(draft?.trigger.days ?? [])
                        if on { values.insert(day) } else { values.remove(day) }
                        draft?.trigger.days = values.sorted()
                    }))
                }
            case .watch:
                TextField("Public HTTPS URL", text: trigger(\.url, default: ""))
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                intervalField
                Picker("Condition", selection: trigger(\.rule, default: "changed")) {
                    Text("Content changes").tag("changed")
                    Text("Contains text").tag("contains")
                    Text("No longer contains text").tag("not-contains")
                    Text("Value above").tag("above")
                    Text("Value below").tag("below")
                }
                if (current.rule ?? "changed") != "changed" { TextField("Comparison value", text: trigger(\.value, default: "")) }
                TextField("Optional JSON field", text: trigger(\.jsonPath, default: ""))
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                Toggle("Run if the first check meets the condition", isOn: trigger(\.fireOnFirst, default: false))
            case .event:
                Picker("Event", selection: trigger(\.event, default: "task.completed")) {
                    if let event = current.event, !events.contains(event) { Text(event).tag(event) }
                    ForEach(events, id: \.self) { Text($0).tag($0) }
                }
                Picker("Condition", selection: trigger(\.operatorName, default: "")) {
                    Text("Every occurrence").tag("")
                    Text("Field equals").tag("equals")
                    Text("Field contains").tag("contains")
                    Text("Value above").tag("above")
                    Text("Value below").tag("below")
                }
                if let operation = current.operatorName, !operation.isEmpty {
                    TextField("Event field", text: trigger(\.path, default: ""))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Comparison value", text: trigger(\.value, default: ""))
                }
            }
        }
    }

    private var intervalField: some View {
        TextField("Interval in minutes", value: Binding(
            get: { Double(draft?.trigger.seconds ?? 3_600) / 60 },
            set: { minutes in
                guard minutes.isFinite, (0...525_600).contains(minutes) else { return }
                draft?.trigger.seconds = Int((minutes * 60).rounded())
            }), format: .number.grouping(.never)).keyboardType(.decimalPad)
    }

    private func limits(_ current: HubRoutineEditorData.Draft) -> some View {
        Section("Limits, tools & notifications") {
            Picker("If HUB missed a run", selection: field(\.missed, current)) {
                Text("Catch up once").tag("catch-up")
                Text("Skip").tag("skip")
            }
            Stepper("Daily run limit · \(current.dailyMaxRuns)", value: field(\.dailyMaxRuns, current), in: 1...48)
            Stepper("Steps per run · \(current.maxSteps)", value: field(\.maxSteps, current), in: 1...6)
            TextField("Output token limit", value: field(\.maxOutputTokens, current), format: .number.grouping(.never)).keyboardType(.numberPad)
            TextField("Daily estimated cost limit ($)", value: field(\.dailyBudget, current), format: .number).keyboardType(.decimalPad)
            TextField("Input estimate per million tokens ($)", value: field(\.inputPrice, current), format: .number).keyboardType(.decimalPad)
            TextField("Output estimate per million tokens ($)", value: field(\.outputPrice, current), format: .number).keyboardType(.decimalPad)
            TextField("Allowed tools, separated by commas", text: $tools)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Toggle("Allow the listed tools to make external changes", isOn: field(\.allowWrites, current))
            Picker("Results", selection: field(\.notification, current)) {
                Text("HUB activity").tag("pwa")
                if current.sourceSessionId != nil { Text("Originating Telegram chat").tag("telegram") }
            }
        }
    }

    private func field<Value>(_ key: WritableKeyPath<HubRoutineEditorData.Draft, Value>, _ value: HubRoutineEditorData.Draft) -> Binding<Value> {
        Binding(get: { draft?[keyPath: key] ?? value[keyPath: key] }, set: { draft?[keyPath: key] = $0 })
    }

    private func optionalField(_ key: WritableKeyPath<HubRoutineEditorData.Draft, String?>, _ value: String?) -> Binding<String> {
        Binding(get: { draft?[keyPath: key] ?? value ?? "" }, set: { draft?[keyPath: key] = $0.isEmpty ? nil : $0 })
    }

    private func trigger<Value>(_ key: WritableKeyPath<HubRoutineEditorData.Trigger, Value?>, default value: Value) -> Binding<Value> {
        Binding(get: { draft?.trigger[keyPath: key] ?? value }, set: { draft?.trigger[keyPath: key] = $0 })
    }

    private func selectTrigger(_ kind: HubRoutineEditorData.Trigger.Kind) {
        var next = HubRoutineEditorData.Trigger(kind: kind)
        switch kind {
        case .once: next.at = Int64(Date().addingTimeInterval(3_600).timeIntervalSince1970 * 1_000)
        case .interval: next.seconds = 3_600
        case .calendar:
            next.hour = 9
            next.minute = 0
            next.days = [1, 2, 3, 4, 5]
            next.timezone = TimeZone.current.identifier
        case .watch:
            next.seconds = 3_600
            next.rule = "changed"
        case .event: next.event = "task.completed"
        }
        draft?.trigger = next
    }

    private func canSave(_ value: HubRoutineEditorData.Draft, data: HubRoutineEditorData) -> Bool {
        !value.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !value.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            data.characters.contains(where: { $0.id == value.characterId && $0.route != nil })
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let result = try await api.routineEditor(id: id)
            guard !Task.isCancelled else { return }
            data = result
            draft = result.draft
            tools = result.draft.tools.joined(separator: ", ")
            error = nil
        } catch {
            if !Task.isCancelled { self.error = "Could not load this routine. Pause it first if it’s currently running." }
        }
    }

    private func save() async {
        guard !saving, let data, var draft, canSave(draft, data: data) else { return }
        draft.tools = tools.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        if draft.trigger.operatorName == "" { draft.trigger.operatorName = nil }
        if draft.trigger.jsonPath == "" { draft.trigger.jsonPath = nil }
        if draft.trigger.path == "" { draft.trigger.path = nil }
        saving = true
        defer { saving = false }
        do {
            try await api.saveRoutine(draft, from: data)
            saved()
            dismiss()
        } catch {
            self.error = "Could not confirm the save. Your edits are still here. Check the schedule, limits and current routine before trying again."
        }
    }
}
