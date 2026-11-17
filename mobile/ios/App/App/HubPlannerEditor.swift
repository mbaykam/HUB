import SwiftUI
import HubNative

@MainActor
struct HubPlannerEditor: View {
    let item: HubHomePlanner.Item?
    let save: (HubPlannerDraft) async -> Bool
    let remove: (HubHomePlanner.Item) async -> Bool
    let openSource: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var draft: HubPlannerDraft
    @State private var selectedDate: Date
    @State private var start: Date
    @State private var end: Date
    @State private var hasDate: Bool
    @State private var timed: Bool
    @State private var hasEnd: Bool
    @State private var busy = false
    @State private var error: String?
    @State private var confirmRemove = false

    init(item: HubHomePlanner.Item?, kind: HubPlannerDraft.Kind, day: Date, horizon: HubHomePlanner.Horizon,
         save: @escaping (HubPlannerDraft) async -> Bool, remove: @escaping (HubHomePlanner.Item) async -> Bool,
         openSource: @escaping (String) -> Void) {
        self.item = item
        self.save = save
        self.remove = remove
        self.openSource = openSource
        let draft = HubPlannerDraft(item: item, kind: kind, horizon: horizon)
        let initialStart = draft.start ?? Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: day) ?? day
        _draft = State(initialValue: draft)
        _selectedDate = State(initialValue: draft.date ?? day)
        _start = State(initialValue: initialStart)
        _end = State(initialValue: draft.end ?? initialStart.addingTimeInterval(3_600))
        _hasDate = State(initialValue: draft.date != nil)
        _timed = State(initialValue: draft.start != nil)
        _hasEnd = State(initialValue: draft.end != nil)
    }

    var body: some View {
        NavigationView {
            Form {
                if let error { Text(error).foregroundStyle(.secondary) }
                TextField("Title", text: $draft.title)
                if draft.kind == .todo {
                    Picker("Planning horizon", selection: $draft.horizon) {
                        Text("Soon").tag(HubHomePlanner.Horizon.near)
                        Text("Later").tag(HubHomePlanner.Horizon.later)
                    }
                    Toggle("Due date", isOn: $hasDate)
                    if hasDate { DatePicker("Date", selection: $selectedDate, displayedComponents: .date) }
                } else {
                    Toggle("At a specific time", isOn: $timed)
                    if timed {
                        DatePicker("Starts", selection: $start)
                        Toggle("Add end time", isOn: $hasEnd)
                        if hasEnd { DatePicker("Ends", selection: $end) }
                    } else {
                        DatePicker("Date", selection: $selectedDate, displayedComponents: .date)
                    }
                }
                DisclosureGroup("More options") {
                    Picker("Type", selection: $draft.kind) {
                        Text("To-do").tag(HubPlannerDraft.Kind.todo)
                        Text("Calendar event").tag(HubPlannerDraft.Kind.event)
                    }
                    TextEditor(text: $draft.details).frame(minHeight: 76).accessibilityLabel("Details")
                    if draft.kind == .event, timed {
                        TextField("Time zone", text: $draft.timeZone)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                    if let source = item?.sourceSessionId {
                        Button("Source chat") { openSource(source) }
                    }
                    if item != nil {
                        Button("Remove item", role: .destructive) { confirmRemove = true }
                    }
                }
            }
            .environment(\.timeZone, TimeZone(identifier: draft.timeZone) ?? .current)
            .disabled(busy)
            .navigationTitle(item == nil ? (draft.kind == .event ? "New event" : "New to-do") : "Edit item")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await submit() } }.disabled(busy || draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .navigationViewStyle(.stack)
        .interactiveDismissDisabled(busy)
        .confirmationDialog("Remove this planner item?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { Task { await discard() } }
        }
    }

    private func submit() async {
        guard !busy else { return }
        var value = draft
        let useTime = draft.kind == .event && timed
        value.date = !useTime && (draft.kind == .event || hasDate) ? selectedDate : nil
        value.start = useTime ? start : nil
        value.end = useTime && hasEnd ? end : nil
        guard TimeZone(identifier: value.timeZone) != nil else { error = "Choose a valid time zone."; return }
        if useTime && hasEnd && end <= start { error = "End time must follow the start."; return }
        guard value.title.utf16.count <= 180, value.details.utf16.count <= 4_000 else {
            error = "Check the length of the title and details."
            return
        }
        busy = true
        defer { busy = false }
        if await save(value) { dismiss() }
        else { error = "Could not confirm the save. Your draft is still here." }
    }

    private func discard() async {
        guard !busy, let item else { return }
        busy = true
        defer { busy = false }
        if await remove(item) { dismiss() }
        else { error = "Could not confirm removal. Reopen the item to check its current state." }
    }
}
