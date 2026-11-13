import SwiftUI
import UIKit
import HubNative

@MainActor
struct HubKnowledgeGraphView: View {
    let graph: HubHomeKnowledge
    let height: CGFloat
    var scope = Scope.all
    let select: (String) -> Void
    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @GestureState private var pinch: CGFloat = 1
    @GestureState private var drag: CGSize = .zero

    enum Scope: String, CaseIterable, Identifiable {
        case all = "All knowledge"
        case notes = "Brain notes"
        case archive = "Chat archive"

        var id: Self { self }

        func includes(_ node: HubHomeKnowledge.Node) -> Bool {
            self == .all || (node.kind == "conversation") == (self == .archive)
        }
    }

    private struct Group {
        let title: String
        let color: Color
        let center: CGPoint
        let nodes: [HubHomeKnowledge.Node]
    }

    var body: some View {
        GeometryReader { geometry in
            let groups = layout(in: geometry.size)
            let zoom = min(5, max(0.75, scale * pinch))
            let translation = CGSize(width: offset.width + drag.width, height: offset.height + drag.height)
            let points = positions(groups, zoom: zoom, offset: translation, size: geometry.size)
            ZStack(alignment: .bottomTrailing) {
                Canvas { context, _ in
                    var lines = Path()
                    for edge in graph.edges {
                        guard let a = points[edge.source], let b = points[edge.target] else { continue }
                        lines.move(to: a)
                        lines.addLine(to: b)
                    }
                    context.stroke(lines, with: .color(.white.opacity(0.18)), lineWidth: 0.75)
                    for group in groups {
                        for node in group.nodes {
                            guard let point = points[node.id] else { continue }
                            let radius: CGFloat = node.kind == "conversation" ? 2.4 : 4
                            let dot = CGRect(x: point.x - radius, y: point.y - radius, width: 2 * radius, height: 2 * radius)
                            context.fill(Path(ellipseIn: dot), with: .color(group.color))
                        }
                        let center = project(group.center, zoom: zoom, offset: translation, size: geometry.size)
                        var label = context.resolve(Text(group.title).font(.caption.weight(.medium)))
                        label.shading = .color(group.color)
                        context.draw(label, at: CGPoint(x: center.x, y: center.y - 43 * zoom))
                    }
                }
                .contentShape(Rectangle())
                .gesture(DragGesture().updating($drag) { value, state, _ in state = value.translation }
                    .onEnded { value in
                        offset = CGSize(width: offset.width + value.translation.width, height: offset.height + value.translation.height)
                    })
                .simultaneousGesture(MagnificationGesture().updating($pinch) { value, state, _ in state = value }
                    .onEnded { scale = min(5, max(0.75, scale * $0)) })
                ForEach(groups.flatMap { $0.nodes }.filter { $0.kind != "conversation" || zoom > 1.8 }, id: \.id) { node in
                    if let point = points[node.id], CGRect(origin: .zero, size: geometry.size).contains(point) {
                        Button { select(node.id) } label: {
                            Color.clear.frame(width: 20, height: 20).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .position(point)
                        .accessibilityLabel(node.title ?? "Knowledge record")
                    }
                }
                HStack(spacing: 2) {
                    Button { scale = max(0.75, scale / 1.3) } label: { Image(systemName: "minus").frame(width: 44, height: 44) }
                        .accessibilityLabel("Zoom out")
                    Button("Fit") { scale = 1; offset = .zero }.frame(minWidth: 44, minHeight: 44)
                    Button { scale = min(5, scale * 1.3) } label: { Image(systemName: "plus").frame(width: 44, height: 44) }
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
        .frame(height: height)
    }

    private func layout(in size: CGSize) -> [Group] {
        let domains = (graph.domains ?? []).filter { $0.status != "merged" }
        let domainMap = Dictionary(domains.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let memberships = Dictionary(grouping: graph.memberships ?? [], by: \.nodeId)
        let visibleNodes = graph.nodes.filter(scope.includes)
        let groups = Dictionary(grouping: visibleNodes.sorted { $0.id < $1.id }) { node in
            if node.kind == "conversation" { return "chat-archive" }
            let ids = (memberships[node.id] ?? []).map(\.domainId).filter { domainMap[$0] != nil }.sorted()
            guard var id = ids.first else { return "unassigned" }
            for _ in 0..<5 {
                guard let parent = domainMap[id]?.parentId, domainMap[parent] != nil, parent != id else { break }
                id = parent
            }
            return id
        }
        let keys = groups.keys.sorted {
            if $0 == "chat-archive" { return false }
            if $1 == "chat-archive" { return true }
            return $0 < $1
        }
        let columns = max(1, min(keys.count, size.width > 540 ? 3 : 2))
        let rows = max(1, (keys.count + columns - 1) / columns)
        let palette: [Color] = [.mint, .purple, .yellow, .pink, .green, .indigo]
        return keys.enumerated().map { index, key in
            let nodes = groups[key] ?? []
            let center = CGPoint(x: size.width * (CGFloat(index % columns) + 0.5) / CGFloat(columns),
                                 y: 43 + max(1, size.height - 85) * (CGFloat(index / columns) + 0.5) / CGFloat(rows))
            let title = key == "chat-archive" ? "Chat archive" : (domainMap[key]?.title ?? "Unassigned")
            let color = key == "chat-archive" ? Color.cyan : (key == "unassigned" ? .gray : palette[index % palette.count])
            return Group(title: title, color: color, center: center, nodes: nodes)
        }
    }

    private func positions(_ groups: [Group], zoom: CGFloat, offset: CGSize, size: CGSize) -> [String: CGPoint] {
        let radius = min(size.width * 0.17, max(18, size.height / CGFloat(max(4, groups.count * 2))))
        var points: [String: CGPoint] = [:]
        for group in groups {
            for (index, node) in group.nodes.enumerated() {
                let angle = CGFloat(index) * 2.399963
                let distance = group.nodes.count == 1 ? 0 : radius * sqrt(CGFloat(index + 1) / CGFloat(group.nodes.count))
                let point = CGPoint(x: group.center.x + cos(angle) * distance, y: group.center.y + sin(angle) * distance * 0.66)
                points[node.id] = project(point, zoom: zoom, offset: offset, size: size)
            }
        }
        return points
    }

    private func project(_ point: CGPoint, zoom: CGFloat, offset: CGSize, size: CGSize) -> CGPoint {
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        return CGPoint(x: center.x + (point.x - center.x) * zoom + offset.width,
                       y: center.y + (point.y - center.y) * zoom + offset.height)
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
