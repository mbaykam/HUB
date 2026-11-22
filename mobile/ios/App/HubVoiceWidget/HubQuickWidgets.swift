import WidgetKit
import SwiftUI
import AppIntents

// Home Screen and Lock Screen widgets, plus Control Center / Lock Screen
// controls, that open HUB straight into a new note, the notes, a voice chat
// or a new chat.

struct HubQuickEntry: TimelineEntry { let date: Date }

struct HubQuickProvider: TimelineProvider {
    func placeholder(in context: Context) -> HubQuickEntry { HubQuickEntry(date: .now) }
    func getSnapshot(in context: Context, completion: @escaping (HubQuickEntry) -> Void) { completion(HubQuickEntry(date: .now)) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<HubQuickEntry>) -> Void) {
        completion(Timeline(entries: [HubQuickEntry(date: .now)], policy: .never))
    }
}

private let hubAccent = Color(red: 0.39, green: 0.47, blue: 1.0)

/// One action: a circle on the Lock Screen, a tile on the Home Screen.
struct HubActionWidgetView: View {
    let action: HubQuickAction
    @Environment(\.widgetFamily) private var family

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular:
                ZStack {
                    AccessoryWidgetBackground()
                    Image(systemName: action.symbol).font(.title2.weight(.semibold))
                }
                .accessibilityLabel(action.title)
            case .accessoryRectangular:
                Label(action.title, systemImage: action.symbol).font(.headline)
            default:
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: action.symbol).font(.system(size: 30, weight: .semibold)).foregroundStyle(hubAccent)
                    Spacer()
                    Text(action.title).font(.headline)
                    Text("HUB").font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            }
        }
        .widgetURL(action.url)
        .containerBackground(for: .widget) { Color(uiColor: .systemBackground) }
    }
}

struct HubNewNoteWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HubNewNoteWidget", provider: HubQuickProvider()) { _ in HubActionWidgetView(action: .newNote) }
            .configurationDisplayName("New Note")
            .description("Start a note in HUB with one tap.")
            .supportedFamilies([.accessoryCircular, .accessoryRectangular, .systemSmall])
    }
}

struct HubNotesWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HubNotesWidget", provider: HubQuickProvider()) { _ in HubActionWidgetView(action: .notes) }
            .configurationDisplayName("Notes")
            .description("Open your HUB notes.")
            .supportedFamilies([.accessoryCircular, .accessoryRectangular, .systemSmall])
    }
}

struct HubVoiceChatWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HubVoiceChatWidget", provider: HubQuickProvider()) { _ in HubActionWidgetView(action: .voice) }
            .configurationDisplayName("Voice Chat")
            .description("Talk to HUB.")
            .supportedFamilies([.accessoryCircular, .accessoryRectangular, .systemSmall])
    }
}

struct HubNewChatWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HubNewChatWidget", provider: HubQuickProvider()) { _ in HubActionWidgetView(action: .newChat) }
            .configurationDisplayName("New Chat")
            .description("Write to HUB.")
            .supportedFamilies([.accessoryCircular, .accessoryRectangular, .systemSmall])
    }
}

/// All four actions on one Home Screen widget.
struct HubQuickActionsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HubQuickActions", provider: HubQuickProvider()) { _ in
            VStack(alignment: .leading, spacing: 10) {
                Text("HUB").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                HStack(spacing: 10) {
                    ForEach(HubQuickAction.allCases, id: \.self) { action in
                        Link(destination: action.url) {
                            VStack(spacing: 6) {
                                Image(systemName: action.symbol).font(.title3.weight(.semibold)).foregroundStyle(hubAccent)
                                    .frame(maxWidth: .infinity, minHeight: 44)
                                    .background(hubAccent.opacity(0.14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                                Text(action.title).font(.caption2).lineLimit(1).minimumScaleFactor(0.8)
                            }
                        }
                    }
                }
            }
            .containerBackground(for: .widget) { Color(uiColor: .systemBackground) }
        }
        .configurationDisplayName("HUB Shortcuts")
        .description("New note, notes, voice chat and new chat.")
        .supportedFamilies([.systemMedium])
    }
}

// MARK: - Controls (Control Center, Lock Screen buttons, Action button)

struct HubNewNoteControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "HubNewNoteControl") {
            ControlWidgetButton(action: HubNewNoteIntent()) { Label("New Note", systemImage: "square.and.pencil") }
        }
        .displayName("New Note")
        .description("Open a new HUB note.")
    }
}

struct HubNotesControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "HubNotesControl") {
            ControlWidgetButton(action: HubOpenNotesIntent()) { Label("Notes", systemImage: "note.text") }
        }
        .displayName("HUB Notes")
        .description("Open your HUB notes.")
    }
}

struct HubVoiceChatControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "HubVoiceChatControl") {
            ControlWidgetButton(action: HubVoiceChatIntent()) { Label("Voice Chat", systemImage: "waveform") }
        }
        .displayName("HUB Voice Chat")
        .description("Start talking to HUB.")
    }
}

struct HubNewChatControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "HubNewChatControl") {
            ControlWidgetButton(action: HubNewChatIntent()) { Label("New Chat", systemImage: "bubble.left.and.text.bubble.right") }
        }
        .displayName("HUB New Chat")
        .description("Open HUB ready to write.")
    }
}

struct HubQuickWidgetBundle: WidgetBundle {
    var body: some Widget {
        HubNewNoteWidget()
        HubNotesWidget()
        HubVoiceChatWidget()
        HubNewChatWidget()
        HubQuickActionsWidget()
        HubNewNoteControl()
        HubNotesControl()
        HubVoiceChatControl()
        HubNewChatControl()
    }
}
