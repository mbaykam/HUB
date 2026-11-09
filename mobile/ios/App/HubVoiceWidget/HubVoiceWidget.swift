import WidgetKit
import SwiftUI
import ActivityKit

struct HubVoiceWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: HubVoiceActivityAttributes.self) { context in
            HStack(spacing: 14) {
                Image(systemName: context.state.muted ? "mic.slash" : "waveform").font(.title2)
                VStack(alignment: .leading, spacing: 4) {
                    Text("HUB voice").font(.headline)
                    Text(context.state.muted ? "Microphone muted" : context.state.phase).font(.subheadline)
                }
                Spacer()
            }
            .padding(18)
            .activityBackgroundTint(Color(.secondarySystemBackground))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Label("HUB", systemImage: "waveform") }
                DynamicIslandExpandedRegion(.trailing) { Text(context.state.muted ? "Muted" : context.state.phase).lineLimit(1) }
            } compactLeading: { Image(systemName: "waveform") }
              compactTrailing: { Image(systemName: context.state.muted ? "mic.slash" : "mic") }
              minimal: { Image(systemName: "waveform") }
        }
    }
}

@main
struct HubVoiceWidgetBundle: WidgetBundle {
    var body: some Widget { HubVoiceWidget() }
}
