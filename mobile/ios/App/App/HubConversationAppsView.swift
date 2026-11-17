import SwiftUI
import WebKit
import HubNative
import UniformTypeIdentifiers

@MainActor
struct HubConversationAppsView: View {
    let api: HubConversationAPI
    let sessionID: String
    @Environment(\.dismiss) private var dismiss
    @State private var artifacts: [HubConversationApp]?
    @State private var files: [HubConversationFile]?
    @State private var selectedFile: HubConversationFile?
    @State private var fileBytes: Data?
    @State private var fileError = false
    @State private var loadingFiles = true
    @State private var exporting = false
    @State private var exportError = false
    @State private var selected: HubConversationApp?
    @State private var document: HubConversationAppDocument?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                if selected != nil || selectedFile != nil {
                    Button { clearSelection() } label: {
                        Label("Outputs", systemImage: "chevron.left")
                    }
                }
                Text(selected?.name ?? selectedFile?.name ?? "Conversation outputs").font(.headline).lineLimit(1)
                Spacer()
                Button("Done") { dismiss() }
            }
            .padding(.horizontal, 16)
            if let selectedFile {
                fileDetail(selectedFile)
            } else if let document {
                HubContainedDocumentView(document: document.document)
            } else if failed {
                Button("Retry") { failed = false; attempt += 1 }
                Spacer()
            } else if selected != nil || artifacts == nil {
                ProgressView("Loading outputs…").frame(maxHeight: .infinity)
            } else if let artifacts {
                List {
                    if !artifacts.isEmpty {
                        Section("Interactive apps") {
                            ForEach(artifacts) { item in
                                Button {
                                    selected = item
                                    failed = false
                                } label: {
                                    Label(item.name, systemImage: "doc.richtext").frame(minHeight: 44)
                                }
                            }
                        }
                    }
                    Section("Files") {
                        if let files {
                            if files.isEmpty { Text("No saved outputs in this conversation.").foregroundStyle(.secondary) }
                            ForEach(files) { file in
                                Button { selectedFile = file } label: {
                                    Label(file.name, systemImage: "doc").frame(minHeight: 44)
                                }
                                .accessibilityIdentifier("hub.chat.output.\(file.id)")
                            }
                        } else if fileError {
                            Button("Retry files") { attempt += 1 }
                        } else if loadingFiles {
                            ProgressView("Loading files…")
                        } else {
                            Text("File downloads require an updated HUB host.").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                .listStyle(.plain)
            }
        }
        .padding(.top, 12)
        .background(Color(uiColor: HubHomeView.backgroundColor).ignoresSafeArea())
        .task(id: LoadRequest(appID: selected?.id, fileID: selectedFile?.id, attempt: attempt)) {
            if let selectedFile {
                fileError = false
                do {
                    let value = try await api.conversationFileBytes(sessionID: sessionID, file: selectedFile)
                    if !Task.isCancelled { fileBytes = value }
                } catch {
                    if !Task.isCancelled { fileError = true }
                }
                return
            }
            do {
                if let selected {
                    let value = try await api.chatAppDocument(sessionID: sessionID, id: selected.id)
                    if !Task.isCancelled { document = value }
                } else {
                    if artifacts == nil {
                        let value = try await api.chatArtifacts(sessionID: sessionID)
                        if !Task.isCancelled { artifacts = value.artifacts ?? [] }
                    }
                    if files == nil && !Task.isCancelled {
                        loadingFiles = true
                        defer { loadingFiles = false }
                        do {
                            let value = try await api.conversationFiles(sessionID: sessionID)
                            if !Task.isCancelled { files = value; fileError = false }
                        } catch {
                            if !Task.isCancelled { fileError = true }
                        }
                    }
                }
            } catch {
                if !Task.isCancelled { failed = true }
            }
        }
        .fileExporter(isPresented: $exporting, document: fileBytes.map { HubFileDocument(bytes: $0) },
                      contentType: selectedFile.flatMap { UTType(filenameExtension: ($0.name as NSString).pathExtension) } ?? .data,
                      defaultFilename: selectedFile?.name) { result in
            if case .failure = result { exportError = true }
        }
    }

    private func clearSelection() {
        selected = nil
        document = nil
        selectedFile = nil
        fileBytes = nil
        failed = false
        fileError = false
        exportError = false
    }

    @ViewBuilder private func fileDetail(_ file: HubConversationFile) -> some View {
        if let fileBytes {
            HStack {
                Button("Save to Files") { exportError = false; exporting = true }
                Spacer()
                HubShareFileButton(bytes: fileBytes, name: file.name, label: "Share output")
            }.padding(.horizontal, 16)
            if exportError { Text("Could not save this output.").font(.footnote) }
            if fileBytes.count <= 400_000, let preview = String(data: fileBytes, encoding: .utf8) {
                ScrollView { Text(preview).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(16) }
            } else {
                Text("Save or share this file to open it in another app.").foregroundStyle(.secondary).padding()
                Spacer()
            }
        } else if fileError {
            Button("Reload output list") { clearSelection(); artifacts = nil; files = nil; attempt += 1 }
            Spacer()
        } else {
            ProgressView("Loading file…").frame(maxHeight: .infinity)
        }
    }

    private struct LoadRequest: Equatable {
        let appID: String?
        let fileID: String?
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

    /// Any saved HTML file in the shape this view expects: a document that
    /// starts with the standard head, so the content policy goes first, and
    /// a phone-width viewport when the file has none.
    static func normalized(_ raw: String) -> String {
        let prefix = "<!doctype html><html><head>"
        let viewport = raw.range(of: "name=\"viewport\"", options: .caseInsensitive) == nil
            ? "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" : ""
        if let head = raw.range(of: "<head[^>]*>", options: [.regularExpression, .caseInsensitive]) {
            return prefix + viewport + raw[head.upperBound...]
        }
        return prefix + "<meta charset=\"utf-8\">" + viewport + "</head><body>" + raw + "</body></html>"
    }

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
