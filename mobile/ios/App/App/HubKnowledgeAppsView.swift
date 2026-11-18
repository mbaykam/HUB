import SwiftUI
import HubNative

/// Every web app Knowledge has saved (any HTML file, from any note), as a
/// launcher. New ones appear here as soon as Knowledge AI saves them.
enum HubKnowledgeApps {
    static func apps(in assets: [HubKnowledgeAsset]) -> [HubKnowledgeAsset] {
        assets.filter { HubKnowledgeFilePreview.isHTML(name: $0.name, mediaType: $0.mediaType) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /// "snake_game (0531b1c5).html" reads as "Snake game".
    static func title(_ asset: HubKnowledgeAsset) -> String {
        var name = (asset.name as NSString).deletingPathExtension
        name = name.replacingOccurrences(of: #"\s*\([0-9a-f]{6,64}\)$"#, with: "", options: .regularExpression)
        name = name.replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        guard let first = name.first else { return asset.name }
        return first.uppercased() + name.dropFirst()
    }

    static func icon(_ asset: HubKnowledgeAsset) -> String {
        let name = asset.name.lowercased()
        let table: [(String, String)] = [("snake", "gamecontroller.fill"), ("game", "gamecontroller.fill"), ("tetris", "gamecontroller.fill"),
                                         ("calc", "function"), ("chart", "chart.bar.fill"), ("graph", "chart.xyaxis.line"),
                                         ("timer", "timer"), ("clock", "clock.fill"), ("todo", "checklist"), ("note", "note.text"),
                                         ("map", "map.fill"), ("music", "music.note"), ("draw", "paintbrush.pointed.fill"),
                                         ("quiz", "questionmark.circle.fill"), ("weather", "cloud.sun.fill")]
        return table.first { name.contains($0.0) }?.1 ?? "app.fill"
    }

    static func tint(_ asset: HubKnowledgeAsset) -> Color {
        Color(hue: HubBrainSimulation.unit(asset.id), saturation: 0.55, brightness: 0.9)
    }
}

/// A rounded, softly lit app icon.
struct HubKnowledgeAppIcon: View {
    let asset: HubKnowledgeAsset
    var size: CGFloat = 52

    var body: some View {
        let tint = HubKnowledgeApps.tint(asset)
        RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(LinearGradient(colors: [tint, tint.opacity(0.55)], startPoint: .topLeading, endPoint: .bottomTrailing))
            .overlay(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .strokeBorder(Color.white.opacity(0.25), lineWidth: 0.7))
            .overlay(Image(systemName: HubKnowledgeApps.icon(asset))
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundStyle(.white))
            .frame(width: size, height: size)
            .shadow(color: tint.opacity(0.35), radius: 8, y: 3)
            .accessibilityHidden(true)
    }
}

/// Runs a saved app full screen.
struct HubKnowledgeAppRunner: View {
    let file: HubOpenedKnowledgeFile
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            HubKnowledgeFilePreview(name: file.asset.name, mediaType: file.asset.mediaType, data: file.data)
                .navigationTitle(HubKnowledgeApps.title(file.asset))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                    ToolbarItem(placement: .primaryAction) {
                        HubShareFileButton(bytes: file.data, name: file.asset.name, label: "Share or save file")
                    }
                }
                .hubBackdrop()
        }
        .navigationViewStyle(.stack)
    }
}

@MainActor
struct HubKnowledgeAppsView: View {
    let api: HubConversationAPI
    @Environment(\.dismiss) private var dismiss
    @State private var apps: [HubKnowledgeAsset]?
    @State private var failed = false
    @State private var opening: String?
    @State private var openFailed = false
    @State private var running: HubOpenedKnowledgeFile?

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Web apps HUB has built and saved to Knowledge. Each one runs here, sealed off from your account.")
                        .font(.footnote).foregroundStyle(.secondary)
                    if openFailed { Text("Could not open that app. Try again.").font(.footnote).foregroundStyle(.orange) }
                    if let apps {
                        if apps.isEmpty {
                            VStack(spacing: 10) {
                                Image(systemName: "square.grid.2x2").font(.largeTitle).foregroundStyle(.secondary)
                                Text("No apps yet").font(.headline)
                                Text("Ask HUB to build something, like a game or a calculator. When Knowledge saves it, it shows up here.")
                                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 40)
                        } else {
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 14, alignment: .top)], spacing: 18) {
                                ForEach(apps) { app in tile(app) }
                            }
                        }
                    } else if failed {
                        Button("Retry loading apps") { Task { await load() } }.hubGlassButton()
                    } else {
                        ProgressView("Loading apps…").frame(maxWidth: .infinity).padding(.vertical, 40)
                    }
                }
                .padding(18)
            }
            .hubBackdrop()
            .navigationTitle("Apps")
            .navigationBarTitleDisplayMode(.large)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
        .navigationViewStyle(.stack)
        .task { await load() }
        .fullScreenCover(item: $running) { HubKnowledgeAppRunner(file: $0) }
    }

    private func tile(_ app: HubKnowledgeAsset) -> some View {
        Button { Task { await run(app) } } label: {
            VStack(spacing: 8) {
                ZStack {
                    HubKnowledgeAppIcon(asset: app, size: 64)
                    if opening == app.id { ProgressView().tint(.white) }
                }
                Text(HubKnowledgeApps.title(app)).font(.caption.weight(.medium)).lineLimit(2).multilineTextAlignment(.center)
                Text(ByteCountFormatter.string(fromByteCount: Int64(app.bytes), countStyle: .file))
                    .font(.caption2).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .disabled(opening != nil)
        .accessibilityLabel("Run \(HubKnowledgeApps.title(app))")
        .accessibilityIdentifier("hub.knowledge.app.\(app.id)")
    }

    private func load() async {
        failed = false
        do { apps = HubKnowledgeApps.apps(in: try await api.knowledgeAssets()) }
        catch { if !Task.isCancelled { failed = true } }
    }

    private func run(_ app: HubKnowledgeAsset) async {
        guard opening == nil else { return }
        opening = app.id
        openFailed = false
        defer { opening = nil }
        do { running = HubOpenedKnowledgeFile(asset: app, data: try await api.knowledgeAssetBytes(app)) }
        catch { openFailed = true }
    }
}
