import SwiftUI
import WebKit
import HubNative

@MainActor
struct HubConversationAppsView: View {
    let api: HubConversationAPI
    let sessionID: String
    @Environment(\.dismiss) private var dismiss
    @State private var artifacts: [HubConversationApp]?
    @State private var selected: HubConversationApp?
    @State private var document: HubConversationAppDocument?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                if selected != nil {
                    Button { selected = nil; document = nil; failed = false } label: {
                        Label("Apps", systemImage: "chevron.left")
                    }
                }
                Text(selected?.name ?? "Conversation apps").font(.headline).lineLimit(1)
                Spacer()
                Button("Done") { dismiss() }
            }
            .padding(.horizontal, 16)
            if let document {
                HubContainedDocumentView(document: document.document)
            } else if failed {
                Button("Retry") { failed = false; attempt += 1 }
                Spacer()
            } else if selected != nil || artifacts == nil {
                ProgressView("Loading apps…").frame(maxHeight: .infinity)
            } else if let artifacts {
                if artifacts.isEmpty {
                    Text("No saved apps in this conversation.").foregroundStyle(.secondary)
                    Spacer()
                } else {
                    List(artifacts) { item in
                        Button {
                            selected = item
                            failed = false
                        } label: {
                            Label(item.name, systemImage: "doc.richtext").frame(minHeight: 44)
                        }
                    }
                    .listStyle(.plain)
                }
            }
        }
        .padding(.top, 12)
        .background(Color(uiColor: HubHomeView.backgroundColor).ignoresSafeArea())
        .task(id: LoadRequest(appID: selected?.id, attempt: attempt)) {
            do {
                if let selected {
                    let value = try await api.chatAppDocument(sessionID: sessionID, id: selected.id)
                    if !Task.isCancelled { document = value }
                } else if artifacts == nil {
                    let value = try await api.chatArtifacts(sessionID: sessionID)
                    if !Task.isCancelled { artifacts = value.artifacts ?? [] }
                }
            } catch {
                if !Task.isCancelled { failed = true }
            }
        }
    }

    private struct LoadRequest: Equatable {
        let appID: String?
        let attempt: Int
    }
}

/// HTML deliverables get a throwaway WebKit document with no HUB origin,
/// persistent storage, credentials, permissions or native message handlers.
@MainActor
struct HubContainedDocumentView: UIViewRepresentable {
    let document: String

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController = WKUserContentController()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.isOpaque = false
        let csp = """
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; media-src data: blob:; font-src data:; object-src 'none'; frame-src about:; connect-src 'none'; form-action 'none'; base-uri 'none'">
            """
        let prefix = "<!doctype html><html><head>"
        let html = prefix + csp + document.dropFirst(prefix.count)
        view.loadHTMLString(html, baseURL: nil)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let target = action.targetFrame, let url = action.request.url,
                  ["about:blank", "about:srcdoc"].contains(url.absoluteString),
                  action.navigationType == .other else {
                decisionHandler(.cancel)
                return
            }
            if target.isMainFrame && action.sourceFrame.isMainFrame == false {
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        }

        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(.deny)
        }
    }
}
