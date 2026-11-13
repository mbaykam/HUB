import SwiftUI
import HubNative

@MainActor
struct HubWorkspaceDirectoryView: View {
    let api: HubConversationAPI
    let onCreated: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var listing: HubWorkspaceDirectory?
    @State private var path: String?
    @State private var attempt = 0
    @State private var showHidden = false
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?

    private struct Request: Equatable {
        let path: String?
        let attempt: Int
    }

    var body: some View {
        NavigationView {
            List {
                if let error { Text(error).font(.footnote).foregroundStyle(.secondary) }
                if loading || saving { ProgressView() }
                if let listing {
                    Section("HUB folder") {
                        Text(listing.path).font(.footnote).textSelection(.enabled)
                        if let parent = listing.crumbs.dropLast().last {
                            Button { browse(parent.path) } label: {
                                Label("Up to \(parent.name)", systemImage: "arrow.up")
                            }
                            .disabled(loading || saving)
                        }
                        Button("Use this folder") { Task { await create(listing.path) } }
                            .disabled(loading || saving || error != nil)
                        Toggle("Show hidden folders", isOn: $showHidden)
                    }
                    Section("Folders") {
                        let entries = listing.entries.filter { showHidden || !$0.hidden }
                        if entries.isEmpty { Text("No folders").foregroundStyle(.secondary) }
                        ForEach(entries) { folder in
                            Button { browse(folder.path) } label: {
                                Label(folder.name, systemImage: "folder")
                                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            }
                            .disabled(loading || saving)
                        }
                        if listing.truncated { Text("HUB limited the number of folders in this directory.").font(.footnote) }
                    }
                }
                if error != nil && !loading && !saving {
                    Button("Retry loading folder") { attempt += 1 }
                }
            }
            .navigationTitle("New workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(saving)
                }
            }
        }
        .navigationViewStyle(.stack)
        .interactiveDismissDisabled(saving)
        .task(id: Request(path: path, attempt: attempt)) { await load() }
    }

    private func browse(_ folder: String) {
        loading = true
        path = folder
        attempt += 1
    }

    private func load() async {
        loading = true
        error = nil
        do {
            let value = try await api.workspaceDirectory(path)
            guard !Task.isCancelled else { return }
            listing = value
            loading = false
        } catch {
            guard !Task.isCancelled else { return }
            loading = false
            self.error = "HUB could not open this folder."
        }
    }

    private func create(_ folder: String) async {
        guard !saving else { return }
        saving = true
        defer { saving = false }
        do {
            _ = try await api.createWorkspace(path: folder)
            onCreated()
            dismiss()
        } catch {
            self.error = "Could not confirm the workspace. Reload the folder to try again."
        }
    }
}
