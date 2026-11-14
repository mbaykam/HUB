import SwiftUI
import UIKit
import HubNative

@MainActor
struct HubKnowledgeBackupsView: View {
    let api: HubConversationAPI
    @Environment(\.dismiss) private var dismiss
    @State private var copies: [HubKnowledgeBackups.Copy] = []
    @State private var page: HubKnowledgeBackups?
    @State private var busy = false
    @State private var notice: String?
    @State private var restored: HubKnowledgeRestoredCopy?
    @State private var restoreCandidate: HubKnowledgeBackups.Copy?

    var body: some View {
        NavigationView {
            List {
                Section {
                    Button("Create verified backup") { Task { await createBackup() } }
                    Button("Refresh backups") { Task { await refresh() } }
                    if busy { ProgressView("Checking backup data on HUB…") }
                    if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
                } footer: {
                    Text("Copies are saved on the HUB computer. Keep each backup folder with its snapshot.json.")
                }
                if let restored {
                    Section("Restored copy") {
                        Text("The restored copy is separate and its background work is paused.").font(.footnote)
                        path(restored.vault)
                        if restored.root != restored.vault { path(restored.root) }
                    }
                }
                if page != nil || !copies.isEmpty {
                    Section("Saved copies · \(page?.total ?? copies.count)") {
                        if let page { DisclosureGroup("Storage on HUB") { path(page.storage) } }
                        if let count = page?.incompleteCopies, count > 0 {
                            Text("\(count) incomplete or unreadable copies are retained on HUB.").font(.footnote)
                        }
                        if copies.isEmpty { Text("No verified backups").foregroundStyle(.secondary) }
                        ForEach(copies) { copy in backupRow(copy) }
                        if let next = page?.nextOffset {
                            Button("Older backups") { Task { await refresh(offset: next) } }
                        }
                    }
                }
            }
            .disabled(busy)
            .navigationTitle("Knowledge backups")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(busy) }
            }
        }
        .navigationViewStyle(.stack)
        .interactiveDismissDisabled(busy)
        .task { await refresh() }
        .confirmationDialog("Restore a separate copy?", isPresented: Binding(
            get: { restoreCandidate != nil }, set: { if !$0 { restoreCandidate = nil } }),
            presenting: restoreCandidate) { copy in
                Button("Restore separate copy") { Task { await restore(copy) } }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("HUB will verify this backup and write a separate folder on the computer. Restored background work starts paused.")
            }
    }

    private func path(_ value: String) -> some View {
        Text(value).font(.caption.monospaced()).textSelection(.enabled)
    }

    private func backupRow(_ copy: HubKnowledgeBackups.Copy) -> some View {
        DisclosureGroup {
            path(copy.path)
            Button("Verify integrity") { Task { await verify(copy) } }
            Button("Restore as a separate copy") { restoreCandidate = copy }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(Date(timeIntervalSince1970: copy.at / 1_000).formatted(date: .abbreviated, time: .shortened))
                Text("\(copy.records) records · \(ByteCountFormatter.string(fromByteCount: copy.bytes, countStyle: .file))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func refresh(offset: Int = 0) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            try await load(offset: offset)
            notice = nil
        } catch {
            if !Task.isCancelled { notice = "Could not load backups from HUB." }
        }
    }

    private func load(offset: Int = 0) async throws {
        let result = try await api.knowledgeBackups(offset: offset)
        try Task.checkCancellation()
        let existing: Set<UUID> = offset == 0 ? [] : Set(copies.map(\.id))
        copies = (offset == 0 ? [] : copies) + result.items.filter { !existing.contains($0.id) }
        page = result
    }

    private func createBackup() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let copy = try await api.createKnowledgeBackup()
            do {
                try await load()
            } catch {
                page = nil
                copies.removeAll { $0.id == copy.id }
                copies.insert(copy, at: 0)
            }
            notice = "Verified backup saved with \(copy.records) records."
        } catch {
            notice = "Could not confirm the backup. Refresh the list before creating another copy."
        }
    }

    private func verify(_ copy: HubKnowledgeBackups.Copy) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let files = try await api.verifyKnowledgeBackup(copy.id)
            notice = "Verified \(files) files against their saved hashes."
        } catch {
            notice = "Could not verify the saved copy."
        }
    }

    private func restore(_ copy: HubKnowledgeBackups.Copy) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            restored = try await api.restoreKnowledgeBackupCopy(copy.id)
            notice = "Verified separate copy restored."
        } catch {
            notice = "Could not confirm the restore. Check the folders on HUB before trying again."
        }
    }
}

@MainActor
struct HubKnowledgeGraphView: View {
    let graph: HubHomeKnowledge
    let height: CGFloat
    var scope = Scope.all
    var overview = false
    var showsControls = true
    var spatial = false
    let select: (String) -> Void
    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @GestureState private var pinch: CGFloat = 1
    @GestureState private var drag: CGSize = .zero
    @State private var layout: HubKnowledgeLayout.Layout?
    @State private var yaw = 0.2
    @State private var pitch = 0.12
    @State private var selectedID: String?

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
                    if spatial { spatialCanvas(layout, size: geometry.size) }
                    else { canvas(layout, size: geometry.size) }
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

    private func spatialCanvas(_ layout: HubKnowledgeLayout.Layout, size: CGSize) -> some View {
        let zoom = min(12, max(0.3, scale * pinch))
        let cameraYaw = yaw + Double(drag.width) * 0.008
        let cameraPitch = min(1.3, max(-1.3, pitch + Double(drag.height) * 0.008))
        let roots = layout.groups.filter { $0.parentID == nil }
        let radius = roots.reduce(135.0) { maximum, group in
            max(maximum, sqrt(group.spatialX * group.spatialX + group.spatialY * group.spatialY +
                              group.spatialZ * group.spatialZ) + group.radius)
        }
        let camera = max(900, radius * 3.5)
        let factor = min(size.width, size.height) / CGFloat(radius * 2.5) * zoom
        let cosineYaw = cos(cameraYaw), sineYaw = sin(cameraYaw)
        let cosinePitch = cos(cameraPitch), sinePitch = sin(cameraPitch)
        func project(_ x: Double, _ y: Double, _ z: Double) -> SpatialProjection {
            let horizontal = x * cosineYaw - z * sineYaw
            let rotatedZ = x * sineYaw + z * cosineYaw
            let vertical = y * cosinePitch - rotatedZ * sinePitch
            let depth = y * sinePitch + rotatedZ * cosinePitch
            let perspective = camera + depth > camera * 0.12 ? CGFloat(camera / (camera + depth)) : 0
            return SpatialProjection(point: CGPoint(x: size.width / 2 + CGFloat(horizontal) * factor * perspective,
                                                      y: size.height / 2 + CGFloat(vertical) * factor * perspective),
                                     depth: depth, perspective: perspective)
        }
        let ids = spatialSample(roots)
        let projected = layout.points.filter { ids.contains($0.id) }.map { item in
            SpatialNode(item: item, projection: project(item.spatialX, item.spatialY, item.spatialZ))
        }.filter { $0.projection.perspective > 0 }.sorted { $0.projection.depth > $1.projection.depth }
        let points = Dictionary(projected.map { ($0.item.id, $0.projection.point) }, uniquingKeysWith: { first, _ in first })
        let selected = graph.nodes.first { $0.id == selectedID }

        return ZStack(alignment: .bottomTrailing) {
            Canvas { context, _ in
                var lines = Path()
                var highlighted = Path()
                for edge in graph.edges {
                    guard let from = points[edge.source], let to = points[edge.target] else { continue }
                    if edge.source == selectedID || edge.target == selectedID {
                        highlighted.move(to: from)
                        highlighted.addLine(to: to)
                    } else {
                        lines.move(to: from)
                        lines.addLine(to: to)
                    }
                }
                for group in layout.groups where group.parentID == nil || zoom >= 1.6 {
                    let center = project(group.spatialX, group.spatialY, group.spatialZ)
                    let r = CGFloat(group.radius) * factor * center.perspective
                    guard r > 3 else { continue }
                    let ring = Path(ellipseIn: CGRect(x: center.point.x - r, y: center.point.y - r, width: r * 2, height: r * 2))
                    let tone = color(group.hue, id: group.id)
                    context.fill(ring, with: .color(tone.opacity(0.06)))
                    context.stroke(ring, with: .color(tone.opacity(0.22)), style: StrokeStyle(lineWidth: 1,
                        dash: group.id == HubKnowledgeLayout.archiveID ? [5, 4] : []))
                    var label = context.resolve(Text(group.title).font(.caption.weight(.medium)))
                    label.shading = .color(tone)
                    context.draw(label, at: CGPoint(x: center.point.x, y: center.point.y - r - 11))
                }
                context.stroke(lines, with: .color(Color.white.opacity(0.16)), lineWidth: 1)
                context.stroke(highlighted, with: .color(Color.white.opacity(0.52)), lineWidth: 1.5)
                for node in projected {
                    let point = node.projection.point
                    let r: CGFloat = (node.item.id == selectedID ? 7 : 4) * sqrt(zoom) * node.projection.perspective
                    let dot = CGRect(x: point.x - r, y: point.y - r, width: r * 2, height: r * 2)
                    context.fill(Path(ellipseIn: dot), with: .color(color(node.item.hue, id: node.item.groupID)))
                }
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .local)
                .updating($drag) { value, state, _ in state = value.translation }
                .onEnded { value in
                    let displacement = value.translation
                    if hypot(displacement.width, displacement.height) < 7 {
                        selectedID = projected.reversed().first {
                            hypot($0.projection.point.x - value.location.x, $0.projection.point.y - value.location.y) <= 18
                        }?.item.id
                    } else {
                        yaw += Double(displacement.width) * 0.008
                        pitch = min(1.3, max(-1.3, pitch + Double(displacement.height) * 0.008))
                    }
                })
            .simultaneousGesture(MagnificationGesture().updating($pinch) { value, state, _ in state = value }
                .onEnded { scale = min(12, max(0.3, scale * $0)) })
            HStack(spacing: 4) {
                if let selected {
                    Button { select(selected.id) } label: {
                        Text(selected.title ?? "Open record").lineLimit(1).frame(minHeight: 44)
                    }
                    .accessibilityLabel("Open selected record")
                }
                Spacer(minLength: 4)
                Button { scale = max(0.3, scale / 1.25) } label: { Image(systemName: "minus").frame(width: 44, height: 44) }
                    .accessibilityLabel("Zoom out")
                Button("Fit") { scale = 1; yaw = 0.2; pitch = 0.12 }.frame(minWidth: 44, minHeight: 44)
                Button { scale = min(12, scale * 1.25) } label: { Image(systemName: "plus").frame(width: 44, height: 44) }
                    .accessibilityLabel("Zoom in")
            }
            .font(.caption).buttonStyle(.plain).padding(.horizontal, 6)
            .background(Color.black.opacity(0.22), in: RoundedRectangle(cornerRadius: 12))
            .padding(4)
        }
        .clipped()
        .accessibilityLabel("3D Knowledge graph")
        .accessibilityHint("Drag to rotate. Use the record list to browse all notes.")
    }

    private func spatialSample(_ roots: [HubKnowledgeLayout.Group]) -> Set<String> {
        var ids: Set<String> = []
        if let selectedID { ids.insert(selectedID) }
        let length = roots.map { $0.members.count }.max() ?? 0
        for index in 0..<length {
            for root in roots where root.members.indices.contains(index) {
                ids.insert(root.members[index])
                if ids.count >= 500 { return ids }
            }
        }
        return ids
    }

    private struct SpatialProjection {
        let point: CGPoint
        let depth: Double
        let perspective: CGFloat
    }

    private struct SpatialNode {
        let item: HubKnowledgeLayout.Point
        let projection: SpatialProjection
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
            if showsControls { HStack(spacing: 2) {
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
