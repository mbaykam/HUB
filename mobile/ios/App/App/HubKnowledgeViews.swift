import SwiftUI
import UIKit
import HubNative

@MainActor
struct HubKnowledgeGraphView: View {
    let graph: HubHomeKnowledge
    let height: CGFloat
    var scope = Scope.all
    var overview = false
    let select: (String) -> Void
    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @GestureState private var pinch: CGFloat = 1
    @GestureState private var drag: CGSize = .zero
    @State private var layout: HubKnowledgeLayout.Layout?

    enum Scope: String, CaseIterable, Identifiable {
        case all = "All knowledge"
        case notes = "Brain notes"
        case archive = "Chat archive"

        var id: Self { self }

        func includes(_ node: HubHomeKnowledge.Node) -> Bool {
            self == .all || (node.kind == "conversation") == (self == .archive)
        }
    }

    var body: some View {
        GeometryReader { geometry in
            Group {
                if let layout {
                    canvas(layout, size: geometry.size)
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .task(id: LayoutRequest(graph: graph, size: geometry.size, scope: scope)) {
                let graph = graph
                let aspect = Double(geometry.size.width / max(1, geometry.size.height))
                let notes = scope != .archive
                let archive = scope != .notes
                let overview = overview
                let result = await Task.detached(priority: .userInitiated) {
                    HubKnowledgeLayout.project(graph, includesNotes: notes, includesArchive: archive,
                                               overview: overview, aspect: aspect)
                }.value
                if !Task.isCancelled { layout = result }
            }
        }
        .frame(height: height)
    }

    private func canvas(_ layout: HubKnowledgeLayout.Layout, size: CGSize) -> some View {
        let byID = Dictionary(graph.nodes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let zoom = min(4, max(0.5, scale * pinch))
        let translation = CGSize(width: offset.width + drag.width, height: offset.height + drag.height)
        let points = positions(layout.points, zoom: zoom, offset: translation, size: size)
        return ZStack(alignment: .bottomTrailing) {
            Canvas { context, _ in
                var lines = Path()
                for edge in graph.edges {
                    guard let a = points[edge.source], let b = points[edge.target] else { continue }
                    lines.move(to: a)
                    lines.addLine(to: b)
                }
                context.stroke(lines, with: .color(Color(red: 0.64, green: 0.71, blue: 0.81).opacity(0.28)), lineWidth: 1)
                for item in layout.points {
                    guard let point = points[item.id] else { continue }
                    let radius: CGFloat = item.groupID == HubKnowledgeLayout.archiveID ? 2.5 : 4.7
                    let dot = CGRect(x: point.x - radius, y: point.y - radius, width: 2 * radius, height: 2 * radius)
                    context.fill(Path(ellipseIn: dot), with: .color(color(item.hue, id: item.groupID)))
                }
                for group in layout.groups where group.parentID == nil || zoom >= 1.6 {
                    if overview, group.id == HubKnowledgeLayout.unassignedID { continue }
                    let members = group.members.compactMap { points[$0] }
                    guard let top = members.map(\.y).min() else { continue }
                    let x = members.reduce(0) { $0 + $1.x } / CGFloat(members.count)
                    var label = context.resolve(Text(group.title).font(.caption.weight(.medium)))
                    label.shading = .color(color(group.hue, id: group.id))
                    context.draw(label, at: CGPoint(x: x, y: top - 19))
                }
                if !overview, zoom >= 2.2 {
                    for item in layout.points {
                        guard let point = points[item.id], let title = byID[item.id]?.title,
                              CGRect(origin: .zero, size: size).contains(point) else { continue }
                        context.draw(Text(String(title.prefix(36))).font(.caption2), at: CGPoint(x: point.x, y: point.y + 11))
                    }
                }
            }
            .contentShape(Rectangle())
            .gesture(DragGesture().updating($drag) { value, state, _ in state = value.translation }
                .onEnded { value in
                    offset = CGSize(width: offset.width + value.translation.width, height: offset.height + value.translation.height)
                })
            .simultaneousGesture(MagnificationGesture().updating($pinch) { value, state, _ in state = value }
                .onEnded { scale = min(4, max(0.5, scale * $0)) })
            ForEach(layout.points.filter { $0.groupID != HubKnowledgeLayout.archiveID || zoom > 1.8 }, id: \.id) { item in
                if let point = points[item.id], CGRect(origin: .zero, size: size).contains(point) {
                    Button { select(item.id) } label: {
                        Color.clear.frame(width: 20, height: 20).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .position(point)
                    .accessibilityLabel(byID[item.id]?.title ?? "Knowledge record")
                }
            }
            HStack(spacing: 2) {
                Button { scale = max(0.5, scale / 1.25) } label: { Image(systemName: "minus").frame(width: 44, height: 44) }
                    .accessibilityLabel("Zoom out")
                Button("Fit") { scale = 1; offset = .zero }.frame(minWidth: 44, minHeight: 44)
                Button { scale = min(4, scale * 1.25) } label: { Image(systemName: "plus").frame(width: 44, height: 44) }
                    .accessibilityLabel("Zoom in")
            }
            .buttonStyle(.plain)
            .font(.caption)
            .background(.black.opacity(0.22), in: RoundedRectangle(cornerRadius: 12))
            .padding(4)
        }
        .clipped()
        .accessibilityLabel("Knowledge graph")
    }

    private struct LayoutRequest: Equatable {
        let graph: HubHomeKnowledge
        let size: CGSize
        let scope: Scope
    }

    private func positions(_ items: [HubKnowledgeLayout.Point], zoom: CGFloat, offset: CGSize, size: CGSize) -> [String: CGPoint] {
        let x = items.map(\.x), y = items.map(\.y)
        guard let minX = x.min(), let maxX = x.max(), let minY = y.min(), let maxY = y.max() else { return [:] }
        let width = max(1, size.width - 40), height = max(1, size.height - 70)
        let inset: CGFloat = overview ? 54 : 65
        let fit = min(width / (CGFloat(maxX - minX) + inset), height / (CGFloat(maxY - minY) + inset)) * zoom
        let centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2
        return Dictionary(uniqueKeysWithValues: items.map { item in
            let x = size.width / 2 + CGFloat(item.x - centerX) * fit + offset.width
            let y = size.height / 2 - 8 + CGFloat(item.y - centerY) * fit + offset.height
            return (item.id, CGPoint(x: x, y: y))
        })
    }

    private func color(_ hue: Double, id: String) -> Color {
        if id == HubKnowledgeLayout.archiveID { return Color(red: 0.54, green: 0.76, blue: 0.84) }
        if id == HubKnowledgeLayout.unassignedID && !overview { return Color(red: 0.62, green: 0.65, blue: 0.7) }
        let saturation = id == HubKnowledgeLayout.unassignedID ? 0.35 : 0.53
        let light = id == HubKnowledgeLayout.unassignedID ? 0.68 : 0.72
        let brightness = light + saturation * min(light, 1 - light)
        return Color(hue: hue, saturation: 2 * (1 - light / brightness), brightness: brightness)
    }
}

@MainActor
struct HubKnowledgeActivityView: View {
    let api: HubConversationAPI
    @Environment(\.dismiss) private var dismiss
    @State private var entries: [HubKnowledgeActivity.Entry] = []
    @State private var page: HubKnowledgeActivity?
    @State private var failed = false
    @State private var loading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Knowledge AI Activity").font(.headline)
                Spacer()
                Button("Done") { dismiss() }
            }
            if let page {
                Text(page.enabled ? page.state.capitalized : "Disabled").foregroundStyle(.secondary)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if entries.isEmpty { Text(page.historyNotice).foregroundStyle(.secondary) }
                        ForEach(entries) { entry in
                            VStack(alignment: .leading, spacing: 5) {
                                Text((entry.outcome ?? entry.status).replacingOccurrences(of: "-", with: " ").capitalized).font(.headline)
                                Text(Date(timeIntervalSince1970: entry.updatedAt / 1000).formatted()).font(.caption).foregroundStyle(.secondary)
                                if let reason = entry.reason { Text(reason) }
                                if let error = entry.error { Text(error.message).foregroundStyle(.red) }
                                if let retryAt = entry.retryAt { Text("Retry: \(Date(timeIntervalSince1970: retryAt / 1000).formatted())") }
                                ForEach(Array(entry.changes.enumerated()), id: \.offset) { change in
                                    Text("\(change.element.action.capitalized) · \(change.element.title)")
                                }
                                ForEach(Array(entry.warnings.enumerated()), id: \.offset) { warning in
                                    Text(warning.element).font(.footnote).foregroundStyle(.secondary)
                                }
                                Divider()
                            }
                        }
                        if let next = page.nextOffset {
                            Button("Load more") { Task { await load(next) } }.disabled(loading)
                        }
                    }
                }
            }
            if loading { ProgressView("Loading activity…") }
            if failed { Button("Retry") { Task { await load(0) } } }
        }
        .task { await load(0) }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .foregroundStyle(.white)
        .background(Color(uiColor: HubHomeView.backgroundColor).ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    private func load(_ offset: Int) async {
        guard !loading else { return }
        loading = true
        failed = false
        defer { loading = false }
        do {
            let result = try await api.knowledgeActivity(offset: offset)
            guard !Task.isCancelled else { return }
            if offset == 0 { entries = [] }
            var seen = Set(entries.map(\.id))
            entries += result.entries.filter { seen.insert($0.id).inserted }
            page = result
        } catch {
            if !Task.isCancelled { failed = true }
        }
    }
}
