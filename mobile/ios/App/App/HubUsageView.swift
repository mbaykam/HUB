import SwiftUI
import UIKit
import HubNative

@MainActor
struct HubUsageView: View {
    let api: HubConversationAPI
    /// Pushed inside Settings, where the navigation bar already shows the title and Back.
    var embedded = false
    @Environment(\.dismiss) private var dismiss
    @State private var usage: HubUsageSnapshot?
    @State private var failed = false
    @State private var refreshing = false
    @State private var attempt = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !embedded {
                HStack {
                    Text("Usage limits").font(.headline).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button("Done") { dismiss() }
                }
            }
            if let usage {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        provider("Codex", usage.codex) {
                            if (usage.codex.rateLimits ?? []).isEmpty && usage.codex.credits == nil && usage.codex.individualLimit == nil {
                                Text("Codex did not report usage limits.").foregroundStyle(.secondary)
                            }
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
                                row("Credits", credits.unlimited ? "Unlimited" : (credits.balance ?? "Available"))
                            }
                            if let limit = usage.codex.individualLimit {
                                ProgressView(value: max(0, min(100, limit.remainingPercent)), total: 100) {
                                    Text("Monthly spend")
                                } currentValueLabel: {
                                    Text("\(usdString(limit.remaining)) left of \(usdString(limit.limit))")
                                }
                            }
                        }
                        provider("OpenRouter", usage.openRouter) {
                            money("Daily", usage.openRouter.usageDaily)
                            money("Weekly", usage.openRouter.usageWeekly)
                            money("Monthly", usage.openRouter.usageMonthly)
                            money("API key usage", usage.openRouter.usage)
                            if let limit = usage.openRouter.limit {
                                creditProgress("Key spending limit", available: limit.remaining, total: limit.amount)
                                if let reset = limit.reset { row("Reset", reset.capitalized) }
                            } else {
                                Text("No spending cap on this key.").foregroundStyle(.secondary)
                            }
                            if let account = usage.openRouter.account {
                                creditProgress("Account credits", available: max(0, account.totalCredits - account.totalUsage), total: account.totalCredits)
                            }
                            if usage.openRouter.isFreeTier == true { Text("Free tier").foregroundStyle(.secondary) }
                        }
                        provider("Unlid", usage.unlid) {
                            money("Balance", usage.unlid.balance)
                            money("Held", usage.unlid.held)
                            money("Available", usage.unlid.available)
                            money("Monthly", usage.unlid.usageMonthly)
                            if let account = usage.unlid.account {
                                if let available = usage.unlid.available, account.totalCredits > 0 {
                                    creditProgress("Available credit", available: available, total: account.totalCredits)
                                }
                                money("Lifetime spend", account.totalUsage)
                                money("Total credits", account.totalCredits)
                            }
                            Text("Totals include usage outside HUB.").font(.footnote).foregroundStyle(.secondary)
                        }
                        provider("Soniox", usage.soniox) {
                            speech("Today", usage.soniox.today)
                            speech("Last 7 days", usage.soniox.last7Days)
                            speech("Month", usage.soniox.month)
                            if let models = usage.soniox.models, !models.isEmpty {
                                DisclosureGroup("By model · this month") {
                                    ForEach(models) { model in speech(model.id, model.month) }
                                }
                            } else {
                                Text("No completed Soniox usage is reported for this month.").foregroundStyle(.secondary)
                            }
                            Text("Project totals use UTC and include other apps. Active sessions appear when they finish.")
                                .font(.footnote).foregroundStyle(.secondary)
                            if let billing = URL(string: "https://console.soniox.com/") {
                                Link("Open Soniox billing", destination: billing)
                            }
                        }
                    }
                }
                if failed {
                    Text("Refresh failed. Showing the last successful reading.").font(.footnote).foregroundStyle(.secondary)
                }
                HStack {
                    Button("Refresh") { attempt += 1 }.disabled(refreshing)
                    Spacer()
                    if refreshing { ProgressView().controlSize(.small) }
                    else if let updated = readingDate(usage.updatedAt) {
                        Text("Updated \(updated.formatted(date: .omitted, time: .shortened))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            } else if failed {
                Button("Retry loading usage") { failed = false; attempt += 1 }
            } else {
                ProgressView("Loading usage…")
            }
        }
        .task(id: attempt) {
            refreshing = true
            defer { if !Task.isCancelled { refreshing = false } }
            do {
                let value = try await api.usage()
                if !Task.isCancelled { usage = value; failed = false }
            } catch {
                if !Task.isCancelled { failed = true }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .foregroundStyle(.primary)
        .navigationTitle("Usage limits")
        .navigationBarTitleDisplayMode(.inline)
        .hubBackdrop()
    }

    private func provider<Content: View>(_ title: String, _ provider: HubUsageSnapshot.Provider, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            if provider.state == "ready" { content() }
            else { Text(provider.message ?? provider.state.replacingOccurrences(of: "-", with: " ").capitalized).foregroundStyle(.secondary) }
            if let warning = provider.warning { Text(warning).font(.footnote).foregroundStyle(.secondary) }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HubWorkspacePalette.panel, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(HubWorkspacePalette.border.opacity(0.08)))
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

    private func readingDate(_ timestamp: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions.insert(.withFractionalSeconds)
        if let date = formatter.date(from: timestamp) { return date }
        formatter.formatOptions.remove(.withFractionalSeconds)
        return formatter.date(from: timestamp)
    }

    @ViewBuilder private func money(_ label: String, _ value: Double?) -> some View {
        if let value { row(label, usd(value)) }
    }

    private func creditProgress(_ label: String, available: Double, total: Double) -> some View {
        let fraction = total > 0 ? min(1, max(0, available / total)) : 0
        return ProgressView(value: fraction) {
            Text(label)
        } currentValueLabel: {
            Text("\(usd(available)) left of \(usd(total))")
        }
    }

    private func usd(_ value: Double) -> String {
        value.formatted(.currency(code: "USD").precision(.fractionLength(2...6)))
    }

    private func usdString(_ value: String) -> String {
        Double(value).map(usd) ?? value
    }

    @ViewBuilder private func speech(_ label: String, _ period: HubUsageSnapshot.Provider.SpeechPeriod?) -> some View {
        if let period {
            money(label, period.costUsd)
            Text("\(period.requests) requests · \(period.inputAudioMs / 1000, specifier: "%.1f")s input · \(period.outputAudioMs / 1000, specifier: "%.1f")s output")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}
