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
    @State private var running: HubAppRun?

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
        .fullScreenCover(item: $running) { HubAppRunner(run: $0) }
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
        do { running = try await api.runnableKnowledgeApp(app) }
        catch { openFailed = true }
    }
}


// MARK: - Apps page

/// An app opened from the Apps page, running in the sealed web view.
struct HubAppRun: Identifiable {
    let id = UUID()
    let title: String
    let html: String
    /// Already wrapped by HUB in its sealed frame (Knowledge apps).
    var contained = false
}

extension HubConversationAPI {
    /// A Knowledge app ready to run, in HUB's sealed frame.
    func runnableKnowledgeApp(_ asset: HubKnowledgeAsset) async throws -> HubAppRun {
        HubAppRun(title: HubKnowledgeApps.title(asset), html: try await knowledgeAppDocument(asset), contained: true)
    }
}

struct HubAppRunner: View {
    let run: HubAppRun
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            HubContainedDocumentView(document: run.contained ? run.html : HubContainedDocumentView.normalized(run.html))
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle(run.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
        .navigationViewStyle(.stack)
    }
}

/// A rounded app icon in the app's own color.
struct HubAppTile: View {
    let app: HubApp
    var size: CGFloat = 64

    var body: some View {
        let tint = Color(hex: app.color) ?? HubWorkspacePalette.accent
        RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(LinearGradient(colors: [tint, tint.opacity(0.6)], startPoint: .topLeading, endPoint: .bottomTrailing))
            .overlay(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous).strokeBorder(Color.white.opacity(0.25), lineWidth: 0.7))
            .overlay(Text(app.icon).font(.system(size: size * 0.44, weight: .heavy, design: .rounded)).foregroundStyle(.white))
            .frame(width: size, height: size)
            .shadow(color: tint.opacity(0.35), radius: 8, y: 3)
            .overlay(alignment: .topTrailing) {
                if !app.shares.isEmpty {
                    Image(systemName: "link").font(.system(size: 10, weight: .bold)).foregroundStyle(.black)
                        .frame(width: 20, height: 20).background(Circle().fill(HubOverlayPalette.mint))
                        .overlay(Circle().strokeBorder(Color.black.opacity(0.3), lineWidth: 1))
                        .offset(x: 6, y: -6)
                        .accessibilityLabel("Shared")
                }
            }
            .accessibilityHidden(app.shares.isEmpty)
    }
}

extension Color {
    /// "#54DEFF" as a color.
    init?(hex: String) {
        guard hex.count == 7, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
    }
}

private struct HubShareLinkSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

/// The Apps page: every app HUB made, plus web files saved in Knowledge.
@MainActor
struct HubAppsView: View {
    let api: HubConversationAPI
    var webPage: URL?
    var pushed = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var snapshot: HubAppsSnapshot?
    @State private var knowledge: [HubKnowledgeAsset] = []
    @State private var failed = false
    @State private var busy: String?
    @State private var notice: String?
    @State private var running: HubAppRun?
    @State private var sharing: URL?
    @State private var renaming: HubApp?
    @State private var removing: HubApp?
    @State private var title = ""
    @State private var keyOpen = false
    @State private var key = ""

    private let columns = [GridItem(.adaptive(minimum: 84), spacing: 14, alignment: .top)]
    private static let durations: [(hours: Int, label: LocalizedStringKey)] = [(1, "1 hour"), (24, "1 day"), (168, "1 week"), (720, "30 days")]

    var body: some View {
        HubNavigation(pushed: pushed) {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if let notice {
                        Label(notice, systemImage: "info.circle").font(.footnote)
                            .padding(.horizontal, 14).padding(.vertical, 10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .hubGlass(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .transition(.opacity)
                    }
                    if let snapshot {
                        if snapshot.apps.isEmpty && knowledge.isEmpty {
                            VStack(spacing: 10) {
                                Image(systemName: "square.grid.2x2").font(.largeTitle).foregroundStyle(.secondary)
                                Text("No apps yet").font(.headline)
                                Text("Ask HUB to build something — a tracker, a calculator, a game. It appears here, ready to open or share.")
                                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                            }
                            .frame(maxWidth: .infinity).padding(.vertical, 48)
                        }
                        if !snapshot.apps.isEmpty {
                            section("Your apps") {
                                ForEach(snapshot.apps) { app in appTile(app) }
                            }
                        }
                        if !knowledge.isEmpty {
                            section("From Knowledge") {
                                ForEach(knowledge) { asset in knowledgeTile(asset) }
                            }
                        }
                        Text(snapshot.sharing.accountKey
                             ? "Shared links use your here.now account and last as long as you choose."
                             : "Shared links use here.now and last up to 24 hours. Add your here.now key for longer links.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else if failed {
                        Button("Retry loading apps") { Task { await load() } }.hubGlassButton()
                    } else {
                        ProgressView("Loading apps…").frame(maxWidth: .infinity).padding(.vertical, 48)
                    }
                }
                .padding(18)
                .animation(.easeInOut(duration: 0.2), value: notice)
            }
            .hubBackdrop()
            .refreshable { await load() }
            .navigationTitle("Apps")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { if !pushed { Button("Done") { dismiss() } } }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        if let webPage { Button { openURL(webPage) } label: { Label("Open in browser", systemImage: "safari") } }
                        Button { key = ""; keyOpen = true } label: { Label("here.now account key", systemImage: "key") }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .accessibilityLabel("Apps options")
                }
            }
        }
        .task { await load() }
        .fullScreenCover(item: $running) { HubAppRunner(run: $0) }
        .sheet(item: Binding(get: { sharing.map { IdentifiedURL(url: $0) } }, set: { sharing = $0?.url })) { HubShareLinkSheet(url: $0.url) }
        .alert("Rename app", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }), presenting: renaming) { app in
            TextField("Name", text: $title)
            Button("Rename") { Task { await change(app, .rename(title)) } }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Remove app?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { app in
            Button("Remove", role: .destructive) { Task { await change(app, .remove) } }
            Button("Cancel", role: .cancel) {}
        } message: { app in Text("\(app.title) will be removed from your Apps page.") }
        .alert("here.now account key", isPresented: $keyOpen) {
            SecureField("API key", text: $key)
            Button("Save") { Task { await change(nil, .accountKey(key.trimmingCharacters(in: .whitespacesAndNewlines))) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("With your key, shared links last as long as you choose and can be taken down early. The key stays on your HUB. Leave it empty to remove it.") }
    }

    private struct IdentifiedURL: Identifiable { let url: URL; var id: String { url.absoluteString } }

    private func section<Content: View>(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.headline)
            LazyVGrid(columns: columns, spacing: 20, content: content)
        }
    }

    private func appTile(_ app: HubApp) -> some View {
        Button { Task { await run(app) } } label: {
            VStack(spacing: 8) {
                ZStack {
                    HubAppTile(app: app)
                    if busy == app.id { ProgressView().tint(.white) }
                }
                Text(app.title).font(.caption.weight(.medium)).lineLimit(2).multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .disabled(busy != nil)
        .contextMenu {
            Button { Task { await run(app) } } label: { Label("Open", systemImage: "play.fill") }
            Menu {
                ForEach(Self.durations, id: \.hours) { duration in
                    Button(duration.label) { Task { await share(app, hours: duration.hours) } }
                }
            } label: { Label("Share link", systemImage: "square.and.arrow.up") }
            if let link = app.shares.last, let url = URL(string: link.url) {
                Button { UIPasteboard.general.url = url; notice = "Link copied." } label: { Label("Copy link", systemImage: "link") }
                Button(role: .destructive) { Task { await change(app, .unshare) } } label: { Label("Stop sharing", systemImage: "link.badge.plus") }
            }
            Button { title = app.title; renaming = app } label: { Label("Rename", systemImage: "pencil") }
            Button(role: .destructive) { removing = app } label: { Label("Remove", systemImage: "trash") }
        }
        .accessibilityLabel("Open \(app.title)")
        .accessibilityHint("Touch and hold to share, rename or remove.")
        .accessibilityIdentifier("hub.apps.app.\(app.id)")
    }

    private func knowledgeTile(_ asset: HubKnowledgeAsset) -> some View {
        Button { Task { await runFile(asset) } } label: {
            VStack(spacing: 8) {
                ZStack {
                    HubKnowledgeAppIcon(asset: asset, size: 64)
                    if busy == asset.id { ProgressView().tint(.white) }
                }
                Text(HubKnowledgeApps.title(asset)).font(.caption.weight(.medium)).lineLimit(2).multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .disabled(busy != nil)
        .accessibilityLabel("Open \(HubKnowledgeApps.title(asset))")
    }

    private func load() async {
        failed = false
        do {
            async let apps = api.apps()
            async let files = api.knowledgeAssets()
            snapshot = try await apps
            knowledge = HubKnowledgeApps.apps(in: (try? await files) ?? [])
        } catch { if snapshot == nil { failed = true } }
    }

    private func run(_ app: HubApp) async {
        guard busy == nil else { return }
        busy = app.id
        defer { busy = nil }
        do { running = HubAppRun(title: app.title, html: try await api.appHTML(app)) }
        catch { notice = "Could not open \(app.title). Try again." }
    }

    private func runFile(_ asset: HubKnowledgeAsset) async {
        guard busy == nil else { return }
        busy = asset.id
        defer { busy = nil }
        do { running = try await api.runnableKnowledgeApp(asset) }
        catch { notice = "Could not open \(HubKnowledgeApps.title(asset)). Check that HUB is online and try again." }
    }

    private func share(_ app: HubApp, hours: Int) async {
        busy = app.id
        defer { busy = nil }
        do {
            let value = try await api.change(app, .share(hours: hours))
            snapshot = value
            if let link = value.apps.first(where: { $0.id == app.id })?.shares.last, let url = URL(string: link.url) {
                UIPasteboard.general.url = url
                notice = value.result?.note ?? "Link copied. Anyone with it can open \(app.title) until it expires."
                sharing = url
            }
        } catch { notice = "Could not share \(app.title). Check that HUB is online and try again." }
    }

    private func change(_ app: HubApp?, _ action: HubConversationAPI.AppAction) async {
        busy = app?.id ?? "settings"
        defer { busy = nil }
        do {
            let value = try await api.change(app, action)
            snapshot = value
            switch action {
            case .unshare: notice = value.result?.note ?? "Sharing stopped."
            case .remove: notice = "Removed."
            case .accountKey: notice = value.sharing.accountKey ? "Key saved. Links can now last longer." : "Key removed."
            default: notice = nil
            }
        } catch { notice = "That didn't work. Try again." }
    }
}