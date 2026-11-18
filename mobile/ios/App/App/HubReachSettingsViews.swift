import SwiftUI
import UIKit
import HubNative

/// What reaches this iPhone and when: kinds, timing, quiet hours and a test.
@MainActor
struct HubNotificationPreferencesView: View {
    @State private var preferences: HubPushPreferences?
    @State private var saved: HubPushPreferences?
    @State private var message: String?
    @State private var failed = false
    @State private var saving = false
    @State private var testing = false
    @State private var isOn = HubNotifications.shared.isOn
    private let manager = HubNotifications.shared

    private static let kinds: [(key: String, title: LocalizedStringKey, detail: LocalizedStringKey, icon: String)] = [
        ("approval", "Approvals", "Approve or deny right from the lock screen.", "checkmark.seal"),
        ("assistant", "Messages from HUB", "When an assistant needs you or has news.", "bubble.left.and.text.bubble.right"),
        ("reply", "Finished replies", "When a reply that took a while is ready. Answer from the notification.", "arrowshape.turn.up.left"),
        ("task", "Background tasks", "Results from work HUB did on its own.", "gearshape.2"),
        ("reminder", "Agenda reminders", "Before events in your agenda.", "bell.badge"),
        ("brief", "Morning brief", "Your day at a glance, once each morning.", "sun.horizon"),
        ("goal", "Goals", "When a goal finishes or needs you.", "target"),
        ("automation", "Automations", "When a scheduled automation finishes or fails.", "clock.arrow.2.circlepath"),
    ]

    var body: some View {
        HubForm {
            Section {
                HStack(spacing: 12) {
                    Image(systemName: isOn ? "bell.fill" : "bell.slash")
                        .font(.title3).foregroundStyle(isOn ? HubWorkspacePalette.accent : HubWorkspacePalette.muted)
                        .frame(width: 32)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(isOn ? "Notifications are on" : "Notifications are off").font(.headline)
                        Text(manager.status).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
                if !isOn {
                    Button("Turn on notifications") { manager.turnOn(); refreshSoon() }
                        .accessibilityIdentifier("hub.notifications.on")
                }
                Button {
                    Task { await test() }
                } label: {
                    HStack { Text("Send a test notification"); Spacer(); if testing { ProgressView() } }
                }
                .disabled(!isOn || testing)
            }
            if let binding = Binding($preferences) {
                Section {
                    ForEach(Self.kinds, id: \.key) { kind in
                        Toggle(isOn: Binding(get: { binding.wrappedValue.allows(kind.key) },
                                             set: { binding.wrappedValue.kinds[kind.key] = $0 })) {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(kind.title)
                                    Text(kind.detail).font(.caption).foregroundStyle(.secondary)
                                }
                            } icon: { Image(systemName: kind.icon) }
                        }
                    }
                } header: { Text("What reaches you") }
                Section {
                    Picker("Remind me before events", selection: binding.reminderMinutes) {
                        Text("Off").tag(0)
                        ForEach([5, 10, 15, 30, 60], id: \.self) { Text("\($0) min").tag($0) }
                    }
                    DatePicker("Morning brief at", selection: Binding(get: { HubPushPreferences.date(binding.wrappedValue.briefTime) },
                                                                      set: { binding.wrappedValue.briefTime = HubPushPreferences.clock($0) }),
                               displayedComponents: .hourAndMinute)
                        .disabled(!binding.wrappedValue.allows("brief"))
                } header: { Text("Timing") }
                Section {
                    Toggle("Quiet hours", isOn: binding.quiet.enabled)
                    if binding.wrappedValue.quiet.enabled {
                        DatePicker("From", selection: Binding(get: { HubPushPreferences.date(binding.wrappedValue.quiet.start) },
                                                              set: { binding.wrappedValue.quiet.start = HubPushPreferences.clock($0) }),
                                   displayedComponents: .hourAndMinute)
                        DatePicker("Until", selection: Binding(get: { HubPushPreferences.date(binding.wrappedValue.quiet.end) },
                                                               set: { binding.wrappedValue.quiet.end = HubPushPreferences.clock($0) }),
                                   displayedComponents: .hourAndMinute)
                    }
                } footer: {
                    Text("During quiet hours only approvals and imminent reminders come through. Everything else waits until they end; nothing is lost.")
                }
            } else if failed {
                Section { Button("Retry loading preferences") { Task { await load() } } }
            } else if isOn {
                Section { ProgressView("Loading preferences…") }
            }
            if let message {
                Section { Text(message).font(.footnote).foregroundStyle(.secondary) }
            }
            Section {
                Button("iPhone notification settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
            } footer: {
                Text("Banners, sounds and lock-screen previews are set by iOS for HUB.")
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: preferences) { value in
            guard let value, value != saved else { return }
            Task { await save(value) }
        }
    }

    private func refreshSoon() {
        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            isOn = manager.isOn
            if isOn && preferences == nil { await load() }
        }
    }

    private func load() async {
        isOn = manager.isOn
        failed = false
        do { let value = try await manager.preferences(); saved = value; preferences = value }
        catch { failed = true; message = HubNotifications.describe(error) }
    }

    private func save(_ value: HubPushPreferences) async {
        saving = true
        defer { saving = false }
        do { saved = try await manager.save(value); message = "Saved." }
        catch { message = "Could not save. Check your connection and change it again." }
    }

    private func test() async {
        testing = true
        defer { testing = false }
        do { try await manager.sendTest(); message = "Sent. It should arrive in a few seconds." }
        catch { message = HubNotifications.describe(error) }
    }
}

/// Chats hidden from the lists, with a way to bring each one back.
@MainActor
struct HubArchivedChatsView: View {
    let api: HubConversationAPI
    @State private var chats: [HubConversationChoice]?
    @State private var failed = false
    @State private var restoring: String?
    @State private var restored: [String] = []
    @State private var message: String?

    var body: some View {
        HubList {
            if let chats {
                if chats.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("No archived chats").font(.headline)
                        Text("Archive a chat from its long-press menu in the chat list. It shows up here, and you can bring it back any time.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                }
                ForEach(chats, id: \.sessionId) { chat in
                    HStack(spacing: 12) {
                        Image(systemName: "archivebox").foregroundStyle(HubWorkspacePalette.muted)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(chat.title).lineLimit(2)
                            if chat.updatedAt > 0 {
                                Text(Date(timeIntervalSince1970: chat.updatedAt / 1000), style: .date).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 8)
                        if restoring == chat.sessionId {
                            ProgressView()
                        } else {
                            Button("Restore") { Task { await restore(chat) } }
                                .font(.subheadline.weight(.semibold))
                                .buttonStyle(.borderless)
                                .disabled(restoring != nil)
                                .accessibilityLabel("Restore \(chat.title)")
                        }
                    }
                    .frame(minHeight: 44)
                }
            } else if failed {
                Button("Retry") { Task { await load() } }
            } else {
                ProgressView("Loading archived chats…")
            }
            if let message {
                Text(message).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Archived chats")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        failed = false
        do {
            let ids = try await api.archivedSessionIDs()
            let titles = ids.isEmpty ? [:] : ((try? await api.workspaceChatTitles()) ?? [:])
            chats = ids.reversed().map { titles[$0] ?? HubConversationChoice(sessionId: $0, title: "Untitled conversation", updatedAt: 0) }
        } catch { failed = true }
    }

    private func restore(_ chat: HubConversationChoice) async {
        restoring = chat.sessionId
        defer { restoring = nil }
        do {
            _ = try await api.unarchive(chat.sessionId)
            withAnimation { chats?.removeAll { $0.sessionId == chat.sessionId } }
            message = "\(chat.title) is back in your chats."
        } catch {
            message = "Could not restore it. Your HUB may need the latest update."
        }
    }
}
