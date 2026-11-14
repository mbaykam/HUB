import SwiftUI
import UIKit
import HubNative

@MainActor
struct HubResearchView: View {
    let sessionID: String
    let api: HubConversationAPI
    let didStart: (String) -> Void
    let openChat: (HubConversationChoice) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var draft: HubResearchDraft
    @State private var requestID = UUID()
    @State private var catalog: HubResearchCatalog?
    @State private var job: HubResearchJob?
    @State private var showJobs: Bool
    @State private var busy = false
    @State private var error: String?
    @State private var confirmStop = false

    init(sessionID: String, api: HubConversationAPI, question: String, showJobs: Bool,
         didStart: @escaping (String) -> Void, openChat: @escaping (HubConversationChoice) -> Void) {
        self.sessionID = sessionID
        self.api = api
        self.didStart = didStart
        self.openChat = openChat
        _draft = State(initialValue: HubResearchDraft(question: question))
        _showJobs = State(initialValue: showJobs)
    }

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let error { Text(error).foregroundStyle(.secondary) }
                    if busy { ProgressView().accessibilityLabel("Updating research") }
                    if let job {
                        jobDetail(job)
                    } else if let catalog {
                        if showJobs { jobList(catalog) } else { form(catalog) }
                    } else if !busy {
                        Button("Retry") { Task { await loadCatalog() } }
                    }
                }
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
                .disabled(busy)
            }
            .background(Color(uiColor: HubHomeView.backgroundColor).ignoresSafeArea())
            .navigationTitle(job != nil ? "Research progress" : (showJobs ? "Research tasks" : "Research"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(busy) }
            }
        }
        .navigationViewStyle(.stack)
        .interactiveDismissDisabled(busy)
        .task { await loadCatalog() }
        .onChange(of: draft) { _ in requestID = UUID() }
        .confirmationDialog("Stop research?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("Stop research", role: .destructive) { Task { await change(.stop) } }
        }
    }

    private func form(_ catalog: HubResearchCatalog) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("What would you like to find out?").font(.headline)
            TextEditor(text: $draft.question)
                .frame(minHeight: 100)
                .accessibilityLabel("Research question")
            Picker("Depth", selection: $draft.depth) {
                ForEach(HubResearchDraft.Depth.allCases, id: \.self) { depth in
                    Text(depth.rawValue.capitalized).tag(depth)
                }
            }
            Picker("Researcher", selection: $draft.characterID) {
                let automatic = catalog.characters.first { $0.id == catalog.automaticId }?.name
                Text(automatic.map { "Auto · \($0)" } ?? "Auto").tag("auto")
                ForEach(catalog.characters.filter { $0.model != nil }) { researcher in
                    Text(researcher.name).tag(researcher.id)
                }
            }
            Picker("Sources", selection: $draft.sources) {
                Text("Public web").tag(HubResearchDraft.Sources.web)
                Text("Public web + my Knowledge").tag(HubResearchDraft.Sources.webAndKnowledge)
            }
            Picker("Freshness", selection: $draft.freshness) {
                Text("Current when relevant").tag(HubResearchDraft.Freshness.current)
                Text("Prefer the past year").tag(HubResearchDraft.Freshness.year)
                Text("Any time").tag(HubResearchDraft.Freshness.any)
            }
            if let limit = catalog.limits[draft.depth.rawValue] {
                Text("Up to \(limit.minutes) active minutes, \(limit.reads) source reads and \(limit.rounds) rounds.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Text("Research uses the selected character’s model and continues while HUB is online. Provider charges may apply.")
                .font(.footnote).foregroundStyle(.secondary)
            Button("Start research") { Task { await start() } }
                .buttonStyle(.borderedProminent)
                .disabled(draft.question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.question.utf16.count > 12_000)
            Button("Research tasks") { showJobs = true; Task { await loadCatalog() } }
        }
    }

    private func jobList(_ catalog: HubResearchCatalog) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Button("New research") { showJobs = false }
            if catalog.jobs.isEmpty { Text("No research tasks yet.").foregroundStyle(.secondary) }
            ForEach(catalog.jobs) { item in
                Button { Task { await loadJob(item.id) } } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.title).font(.headline)
                        Text(label(item.status)).font(.caption).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Divider()
            }
            Button("Refresh") { Task { await loadCatalog() } }
        }
    }

    private func jobDetail(_ job: HubResearchJob) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Button("All research") {
                self.job = nil
                showJobs = true
                Task { await loadCatalog() }
            }
            Text(job.title).font(.title3.bold())
            Text(label(job.status)).foregroundStyle(.secondary)
            if let reason = job.reason { Text(reason) }
            Text("\(job.rounds) rounds").font(.footnote)
            if let checkpoint = job.checkpoint { Text(checkpoint).textSelection(.enabled) }
            if let ledger = job.ledger { evidence(ledger) }
            if let session = job.sessionId {
                Button("Open work session") {
                    dismiss()
                    openChat(HubConversationChoice(sessionId: session, title: job.title, updatedAt: 0))
                }
            }
            HStack {
                if job.state == "active" {
                    Button("Pause") { Task { await change(.pause) } }
                } else if job.state == "paused" {
                    Button("Resume") { Task { await change(.resume) } }
                }
                if job.status == "waiting-credit" {
                    Button("Credits restored") { Task { await change(.resumeCredit) } }
                }
                if ["active", "paused", "draft"].contains(job.state) {
                    Button("Stop", role: .destructive) { confirmStop = true }
                }
            }
            Button("Refresh") { Task { await loadJob(job.id) } }
        }
    }

    private func evidence(_ ledger: HubResearchJob.Ledger) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let report = ledger.report {
                Text("Report").font(.headline)
                ForEach(report.claims.indices, id: \.self) { index in
                    let claim = report.claims[index]
                    Text(claim.uncertain == true ? "Uncertain · \(claim.text)" : claim.text).textSelection(.enabled)
                    ForEach(claim.citations.indices, id: \.self) { citation in
                        let id = claim.citations[citation].sourceId
                        if let source = ledger.observations.first(where: { $0.id == id }) { sourceLink(source) }
                    }
                }
                if !report.limitations.isEmpty { passages("Limits and gaps", report.limitations) }
                if !report.conflicts.isEmpty { passages("Conflicting evidence", report.conflicts) }
                Button("Copy report") { UIPasteboard.general.string = report.markdown }
            }
            DisclosureGroup("Sources and recorded passages") {
                ForEach(ledger.observations) { source in
                    DisclosureGroup(source.title) {
                        sourceLink(source)
                        Text(source.text).textSelection(.enabled)
                    }
                }
            }
            if !ledger.failures.isEmpty { passages("Source access issues", ledger.failures.map(\.message)) }
        }
    }

    private func passages(_ title: String, _ values: [String]) -> some View {
        DisclosureGroup(title) {
            ForEach(values.indices, id: \.self) { Text(values[$0]).textSelection(.enabled) }
        }
    }

    @ViewBuilder private func sourceLink(_ source: HubResearchJob.Ledger.Observation) -> some View {
        if let text = source.url, let url = URL(string: text), let scheme = url.scheme,
           ["https", "http"].contains(scheme), url.host != nil, url.user == nil, url.password == nil {
            Link(source.title, destination: url)
        } else {
            Text(source.title)
        }
    }

    private func label(_ status: String) -> String {
        status.replacingOccurrences(of: "-", with: " ").capitalized
    }

    private func loadCatalog() async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do { catalog = try await api.researchCatalog(sessionID: sessionID) }
        catch { if !Task.isCancelled { self.error = "Could not load research tasks." } }
    }

    private func loadJob(_ id: String) async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do { job = try await api.researchJob(sessionID: sessionID, id: id) }
        catch { if !Task.isCancelled { self.error = "Could not load research details." } }
    }

    private func start() async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let accepted = try await api.startResearch(sessionID: sessionID, draft: draft, requestID: requestID)
            job = accepted
            didStart(draft.question)
            requestID = UUID()
            draft.question = ""
        } catch {
            self.error = "Could not confirm the start. The question is retained. Retry to check this request."
        }
    }

    private func change(_ action: HubResearchAction) async {
        guard !busy, let job else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            self.job = try await api.changeResearch(sessionID: sessionID, job: job, action: action)
        } catch {
            self.error = "Could not confirm the change. Refresh the task before trying again."
        }
    }
}
