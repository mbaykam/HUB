import SwiftUI
import HubNative

/// Compact chat card; its content comes from the helper's own recorded events.
struct HubHelperTransparencyCard: View {
    let api: HubConversationAPI
    let helper: HubHomeWork.Helper
    let open: () -> Void
    @State private var work: HubHelperTransparency?
    @State private var stale = false

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Image(systemName: work?.running == true ? "gearshape.2" : "person.crop.square")
                    Text(helper.title).font(.subheadline.weight(.semibold))
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption)
                }
                Text(work?.statusLabel ?? fallbackStatus).font(.caption.weight(.semibold))
                if let operation = work?.currentOperation { Text(operation).font(.caption).lineLimit(2) }
                if let blocker = work?.blocker { Text(blocker).font(.caption).foregroundStyle(.orange).lineLimit(2) }
                if let update = work?.result ?? work?.findings { Text(update).font(.caption).lineLimit(2) }
                if let chosen = work?.routing { Text("Preset: \(chosen.preset)").font(.caption2).foregroundStyle(.secondary) }
                if let route = work?.actualRoute {
                    Text("\(route.provider) / \(route.model) · \(HubHelperTransparency.billingLabel(route.billingBasis))")
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                } else if let chosen = work?.routing {
                    Text("Selected \(chosen.preset): \(chosen.provider) / \(chosen.model) · awaiting model evidence")
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                }
                if stale { Text("Update unavailable · open to retry").font(.caption2).foregroundStyle(.orange) }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .task(id: helper.id) {
            while !Task.isCancelled {
                do { work = try await api.helperTransparency(sessionID: helper.id); stale = false }
                catch { stale = true }
                guard work?.running ?? (helper.state == .running) else { return }
                do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
            }
        }
    }
    private var fallbackStatus: String {
        switch helper.state {
        case .running: return "Working · loading details"
        case .done: return "Completed"
        case .failed: return "Failed"
        case .stopped: return "Stopped"
        }
    }
}

struct HubHelperTransparencyView: View {
    let api: HubConversationAPI
    let helper: HubHomeWork.Helper
    @State private var work: HubHelperTransparency?
    @State private var error: String?
    @State private var stopping = false
    @State private var stopRequested = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let error {
                    Text(error).font(.footnote).foregroundStyle(.orange)
                    Button("Retry loading") { Task { await load() } }.frame(minHeight: 44)
                }
                if let work {
                    HStack { Text(work.statusLabel).font(.headline); if work.running { ProgressView() } }
                    if stopRequested && work.running { Text("Stop requested — waiting for confirmation.").font(.footnote).foregroundStyle(.secondary) }
                    section("Task", work.brief.isEmpty ? helper.title : work.brief)
                    if let operation = work.currentOperation { section("Current operation", operation) }
                    if let blocker = work.blocker { section("Blocker / failure", blocker) }
                    if work.outcome == "stopped" { Text("Stopped. No automatic retry was scheduled by this helper view.").font(.footnote).foregroundStyle(.secondary) }
                    if work.outcome == "failed" { Text("This helper failed. Ask in chat before retrying; a retry may repeat work.").font(.footnote).foregroundStyle(.secondary) }
                    if let routing = work.routing {
                        section("Selected route", "\(routing.preset) · \(routing.provider) / \(routing.model)\n\(HubHelperTransparency.billingLabel(routing.billingBasis))")
                        section("Why this route", routing.reason)
                    } else { section("Selected route", "Not recorded by this host.") }
                    if let route = work.actualRoute {
                        section("Observed model", "\(route.provider) / \(route.model)\n\(HubHelperTransparency.billingLabel(route.billingBasis)) · \(route.evidence == "response" ? "recorded response" : "recorded request")")
                    } else { section("Observed model", "No model request or response recorded yet. A selected preset is not proof of execution.") }
                    if let changes = work.routeChanges, !changes.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Observed route changes").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            ForEach(Array(changes.enumerated()), id: \.offset) { _, route in
                                Text("\(route.provider) / \(route.model) · \(HubHelperTransparency.billingLabel(route.billingBasis))").font(.footnote)
                            }
                            Text("A change was recorded; its cause is not inferred.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if let result = work.result { section("Result", result) }
                    else if let findings = work.findings { section("Latest findings", findings) }
                    Text("Work log").font(.headline)
                    Text("Recorded tools, public updates and errors — not private reasoning or a percentage estimate.").font(.caption).foregroundStyle(.secondary)
                    if work.entries.isEmpty { Text("No operations recorded yet.").foregroundStyle(.secondary) }
                    ForEach(Array(work.entries.enumerated()), id: \.offset) { _, entry in
                        logEntry(entry)
                    }
                } else if error == nil { ProgressView("Loading helper…") }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(16)
        }
        .navigationTitle(helper.title).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if work?.running ?? (helper.state == .running) {
                ToolbarItem(placement: .primaryAction) {
                    Button(stopping ? "Stopping…" : stopRequested ? "Stop requested" : "Stop") {
                        Task { await stop() }
                    }.disabled(stopping || stopRequested)
                }
            }
        }
        .task(id: helper.id) {
            while !Task.isCancelled {
                await load()
                guard work?.running ?? (helper.state == .running) else { return }
                do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
            }
        }
    }
    private func section(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(value).font(.footnote).textSelection(.enabled)
        }
    }
    @ViewBuilder private func logEntry(_ entry: HubHelperTransparency.Entry) -> some View {
        if entry.kind == "text", let text = entry.text {
            HubMarkdownText(source: text)
        } else {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: entry.failed == true ? "xmark.circle" : entry.status == "running" ? "gearshape" : entry.kind == "event" ? "clock" : "checkmark.circle")
                    .foregroundStyle(entry.failed == true ? Color.orange : Color.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.title ?? "Operation").font(.footnote.weight(.semibold))
                    if let status = entry.status { Text(status.capitalized).font(.caption2).foregroundStyle(.secondary) }
                    if let detail = entry.detail { Text(detail).font(.caption.monospaced()).textSelection(.enabled) }
                    if let result = entry.result { Text(result).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(10)
            .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
        }
    }
    @MainActor private func load() async {
        do { work = try await api.helperTransparency(sessionID: helper.id); error = nil }
        catch { self.error = "Could not refresh this helper. Displayed details may be out of date." }
    }
    @MainActor private func stop() async {
        stopping = true
        do { try await api.cancelChat(sessionID: helper.id); stopRequested = true; error = nil; await load() }
        catch { error = "Could not stop this helper. It may still be running. Try again." }
        stopping = false
    }
}

struct HubHelperRoutingPolicySection: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Subscription-first helpers").font(.subheadline.weight(.semibold))
            Text("Auto uses compatible configured subscription slots. Explicit selections are honored; Unrestricted is never automatic.")
            Text("Metered API and unknown-billing helpers are disabled until a bounded runner is configured. Approval alone is not a spending budget. No paid fallback is used.")
        }
        .font(.footnote).foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading).padding(12)
        .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 14))
    }
}
