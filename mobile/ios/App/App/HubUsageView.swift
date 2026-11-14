import SwiftUI
import UIKit
import HubNative

@MainActor
struct HubUsageView: View {
    let api: HubConversationAPI
    @Environment(\.dismiss) private var dismiss
    @State private var usage: HubUsageSnapshot?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Usage limits").font(.headline).accessibilityAddTraits(.isHeader)
                Spacer()
                Button("Done") { dismiss() }
            }
            if let usage {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        provider("Codex", usage.codex) {
                            ForEach(usage.codex.rateLimits ?? []) { limit in
                                Text(limit.name ?? limit.id).font(.subheadline.bold())
                                ForEach(Array(limit.windows.enumerated()), id: \.offset) { item in
                                    let window = item.element
                                    let remaining = max(0, min(100, window.remainingPercent))
                                    ProgressView(value: remaining, total: 100) {
                                        Text(windowLabel(window.windowSeconds))
                                    } currentValueLabel: {
                                        Text("\(remaining, specifier: "%.0f")% remaining")
                                    }
                                }
                            }
                            if let credits = usage.codex.credits {
                                row("Credits", credits.unlimited ? "Unlimited" : (credits.balance ?? "Unavailable"))
                            }
                            if let limit = usage.codex.individualLimit {
                                ProgressView(value: max(0, min(100, limit.remainingPercent)), total: 100) {
                                    Text("Individual limit")
                                } currentValueLabel: {
                                    Text("\(limit.remaining) of \(limit.limit) left")
                                }
                            }
                        }
                        provider("OpenRouter", usage.openRouter) {
                            money("Daily", usage.openRouter.usageDaily)
                            money("Weekly", usage.openRouter.usageWeekly)
                            money("Monthly", usage.openRouter.usageMonthly)
                            money("API key usage", usage.openRouter.usage)
                            if let limit = usage.openRouter.limit {
                                money("Limit", limit.amount)
                                money("Remaining", limit.remaining)
                                if let reset = limit.reset { row("Reset", reset.capitalized) }
                            }
                            account(usage.openRouter.account)
                            if usage.openRouter.isFreeTier == true { Text("Free tier").foregroundStyle(.secondary) }
                        }
                        provider("Unlid", usage.unlid) {
                            money("Balance", usage.unlid.balance)
                            money("Held", usage.unlid.held)
                            money("Available", usage.unlid.available)
                            money("Monthly", usage.unlid.usageMonthly)
                            account(usage.unlid.account)
                        }
                        provider("Soniox", usage.soniox) {
                            speech("Today", usage.soniox.today)
                            speech("Last 7 days", usage.soniox.last7Days)
                            speech("Month", usage.soniox.month)
                            ForEach(usage.soniox.models ?? []) { model in speech(model.id, model.month) }
                        }
                    }
                }
                Button("Refresh") { attempt += 1 }
            } else if failed {
                Button("Retry loading usage") { failed = false; attempt += 1 }
            } else {
                ProgressView("Loading usage…")
            }
        }
        .task(id: attempt) {
            do {
                let value = try await api.usage()
                if !Task.isCancelled { usage = value }
            } catch {
                if !Task.isCancelled { usage = nil; failed = true }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .foregroundStyle(.primary)
        .background(Color(uiColor: HubHomeView.backgroundColor).ignoresSafeArea())
    }

    private func provider<Content: View>(_ title: String, _ provider: HubUsageSnapshot.Provider, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            if provider.state == "ready" { content() }
            else { Text(provider.message ?? provider.state.replacingOccurrences(of: "-", with: " ").capitalized).foregroundStyle(.secondary) }
            if let warning = provider.warning { Text(warning).font(.footnote).foregroundStyle(.secondary) }
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack { Text(label); Spacer(); Text(value).monospacedDigit() }
    }

    private func windowLabel(_ seconds: Double) -> String {
        if seconds == 604_800 { return "Weekly limit" }
        let hours = seconds / 3_600
        if hours < 48, hours.rounded() == hours { return String(format: "%g-hour limit", hours) }
        let days = seconds / 86_400
        if days.rounded() == days { return String(format: "%g-day limit", days) }
        return "Usage window"
    }

    @ViewBuilder private func money(_ label: String, _ value: Double?) -> some View {
        if let value { row(label, value.formatted(.currency(code: "USD").precision(.fractionLength(2...6)))) }
    }

    @ViewBuilder private func account(_ account: HubUsageSnapshot.Provider.Account?) -> some View {
        if let account {
            money("Account credits", account.totalCredits)
            money("Account usage", account.totalUsage)
        }
    }

    @ViewBuilder private func speech(_ label: String, _ period: HubUsageSnapshot.Provider.SpeechPeriod?) -> some View {
        if let period {
            money(label, period.costUsd)
            Text("\(period.requests) requests · \(period.inputAudioMs / 1000, specifier: "%.1f")s input · \(period.outputAudioMs / 1000, specifier: "%.1f")s output")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}
