import ImageIO
import SwiftUI
import UIKit
import HubNative

@MainActor
struct HubBrowserPreviewView: View {
    let api: HubConversationAPI
    let conversations: [HubConversationChoice]
    let visible: Bool
    @Environment(\.scenePhase) private var scenePhase
    @State private var tabs: [HubBrowserTab] = []
    @State private var selection: String?
    @State private var image: UIImage?
    @State private var failure = false
    @State private var expanded = false
    @State private var zoomed = false

    private var tab: HubBrowserTab? { tabs.first { $0.id == selection } ?? tabs.first }
    private var polling: Bool { scenePhase == .active && (visible || expanded) }

    var body: some View {
        Group {
            if visible, let tab {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Browser").font(.headline)
                    if tabs.count > 1 {
                        Menu {
                            ForEach(tabs) { choice in
                                Button(tabLabel(choice)) {
                                    if choice.id != tab.id {
                                        image = nil
                                        failure = false
                                        selection = choice.id
                                    }
                                }
                            }
                        } label: {
                            Label(tabLabel(tab), systemImage: "chevron.up.chevron.down")
                                .font(.footnote).lineLimit(1).frame(minHeight: 44)
                        }
                        .accessibilityLabel("Task browser to watch")
                    }
                    Button {
                        zoomed = false
                        expanded = true
                    } label: {
                        VStack(alignment: .leading, spacing: 0) {
                            if let image {
                                GeometryReader { geometry in
                                    Image(uiImage: image).resizable().scaledToFill()
                                        .frame(width: geometry.size.width, height: 176, alignment: .top)
                                        .clipped()
                                }
                                .frame(height: 176)
                                .accessibilityHidden(true)
                            }
                            Label(tabLabel(tab), systemImage: "arrow.up.left.and.arrow.down.right")
                                .font(.footnote).lineLimit(1).padding(12)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        }
                        .background(Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 14))
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Expand task browser")
                    Text(status(tab)).font(.caption).foregroundStyle(.secondary)
                }
                .padding(14)
                .background(Color.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 18))
                .overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(Color.white.opacity(0.10)) }
            }
        }
        .sheet(isPresented: $expanded) { viewer }
        .task(id: Polling(active: polling, selection: selection)) {
            if polling { await refresh() }
            else { image = nil }
        }
    }

    private var viewer: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(tab?.title ?? "Browser").font(.headline).lineLimit(1)
                Spacer()
                if image != nil { Button(zoomed ? "Fit" : "Zoom in") { zoomed.toggle() }.frame(minHeight: 44) }
                Button("Close") { expanded = false }.frame(minHeight: 44)
            }
            if let tab {
                Text(tab.url).lineLimit(2).font(.caption).textSelection(.enabled)
                Text(status(tab)).font(.caption).foregroundStyle(.secondary)
            } else {
                Text(failure ? "Browser view unavailable. Reconnecting…" : "No task browser is open.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let image {
                GeometryReader { geometry in
                    ScrollView(zoomed ? [.horizontal, .vertical] : .vertical) {
                        Image(uiImage: image).resizable().scaledToFit()
                            .frame(width: geometry.size.width * (zoomed ? 2 : 1))
                            .accessibilityLabel("Live task browser")
                    }
                }
            } else {
                Spacer()
            }
        }
        .padding(16)
        .background(Color(uiColor: HubHomeView.backgroundColor).ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    private struct Polling: Equatable {
        let active: Bool
        let selection: String?
    }

    private func tabLabel(_ tab: HubBrowserTab) -> String {
        let conversation = conversations.first { $0.sessionId == tab.ownerSessionId }
        return "\(conversation?.title ?? "Background task") · \(tab.title.isEmpty ? "Browser" : tab.title)"
    }

    private func status(_ tab: HubBrowserTab) -> String {
        if failure { return "Browser view unavailable. Reconnecting…" }
        if tab.status != "ready" { return "Waiting for a current browser view…" }
        if image == nil { return "Loading browser preview…" }
        return tab.owner == .human ? "Under desktop control · Read-only" : "Watching assistant · Read-only"
    }

    private func refresh() async {
        var listedAt = Date.distantPast
        while !Task.isCancelled {
            do {
                if Date().timeIntervalSince(listedAt) >= 3 {
                    let current = try await api.browserTabs()
                    guard !Task.isCancelled else { return }
                    let previous = tab
                    tabs = current
                    if tab?.id != previous?.id || tab?.url != previous?.url { image = nil }
                    listedAt = Date()
                }
                if let tab, tab.status == "ready" {
                    let frame = try await api.browserFrame(for: tab)
                    guard !Task.isCancelled else { return }
                    guard let source = CGImageSourceCreateWithData(frame.jpeg as CFData, nil),
                          let info = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                          info[kCGImagePropertyPixelWidth] as? Int == frame.width,
                          info[kCGImagePropertyPixelHeight] as? Int == frame.height,
                          let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                        throw HubAttachmentError.invalidResponse
                    }
                    if frame.tab.url == tab.url { image = UIImage(cgImage: decoded) }
                    else {
                        image = nil
                        listedAt = .distantPast
                    }
                } else {
                    image = nil
                }
                failure = false
            } catch {
                guard !Task.isCancelled else { return }
                image = nil
                failure = true
                listedAt = .distantPast
            }
            do {
                try await Task.sleep(nanoseconds: tab != nil && !failure ? 1_500_000_000 : 4_000_000_000)
            } catch { return }
        }
    }
}
