import Foundation

/// Deterministic spatial layout shared in behavior with the HUB web graph.
/// Coordinates and display groups do not change saved Knowledge memberships.
public enum HubKnowledgeLayout {
    public struct Point: Sendable {
        public let id: String
        public let groupID: String
        public let x: Double
        public let y: Double
        public let hue: Double
        public let spatialX: Double
        public let spatialY: Double
        public let spatialZ: Double
    }

    public struct Group: Sendable {
        public let id: String
        public let title: String
        public let parentID: String?
        public let members: [String]
        public let hue: Double
        public let spatialX: Double
        public let spatialY: Double
        public let spatialZ: Double
        public let radius: Double
    }

    public struct Layout: Sendable {
        public let points: [Point]
        public let groups: [Group]
    }

    public static let archiveID = "hub:chat-archive"
    public static let unassignedID = "unassigned"

    private struct Vector {
        var x = 0.0
        var y = 0.0
        var z = 0.0

        static func + (lhs: Self, rhs: Self) -> Self {
            Vector(x: lhs.x + rhs.x, y: lhs.y + rhs.y, z: lhs.z + rhs.z)
        }

        static func - (lhs: Self, rhs: Self) -> Self {
            Vector(x: lhs.x - rhs.x, y: lhs.y - rhs.y, z: lhs.z - rhs.z)
        }

        var distance: Double { sqrt(x * x + y * y + z * z) }
        var projectedX: Double { x * 0.94 - z * 0.3 }
        var projectedY: Double { y * 0.94 + z * 0.12 }
    }

    private struct Cloud {
        let id: String
        let title: String
        let parentID: String?
        let level: Int
        let hue: Double
        let radius: Double
        let center: Vector
        var members: [String] = []
    }

    public static func project(_ graph: HubHomeKnowledge, includesNotes: Bool, includesArchive: Bool,
                               overview: Bool, aspect: Double) -> Layout {
        let nodes = graph.nodes.filter { $0.kind == "conversation" ? includesArchive : includesNotes }.sorted { less($0.id, $1.id) }
        let brain = nodes.filter { $0.kind != "conversation" }
        let known = Set(brain.map(\.id))
        let domains = (graph.domains ?? []).filter { $0.status != "merged" }
        let byDomain = Dictionary(domains.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var ancestors: [String: [String]] = [:]
        for domain in domains {
            var path: [String] = []
            var next: HubHomeKnowledge.Domain? = domain
            while let current = next, path.count < 5, !path.contains(current.id) {
                path.append(current.id)
                next = current.parentId.flatMap { byDomain[$0] }
            }
            ancestors[domain.id] = path
        }
        var memberships: [String: Set<String>] = [:]
        for member in graph.memberships ?? [] where known.contains(member.nodeId) && byDomain[member.domainId] != nil {
            memberships[member.nodeId, default: []].insert(member.domainId)
        }
        var labels: [String: String] = [:]
        for node in nodes { labels[node.id] = node.kind == "conversation" ? archiveID : unassignedID }
        if domains.isEmpty {
            assignRelatedGroups(brain, known: known, graph: graph, labels: &labels)
        } else {
            for node in brain {
                let candidates = (memberships[node.id] ?? []).sorted { left, right in
                    let lhsDepth = ancestors[left]?.count ?? 0
                    let rhsDepth = ancestors[right]?.count ?? 0
                    if lhsDepth != rhsDepth { return lhsDepth > rhsDepth }
                    let leftHash = hash(node.id + left), rightHash = hash(node.id + right)
                    return leftHash == rightHash ? less(left, right) : leftHash > rightHash
                }
                labels[node.id] = candidates.first ?? unassignedID
            }
        }
        var suggestions: [String: String] = [:]
        for suggestion in graph.communityCandidates?.groups ?? [] {
            let id = "suggested:" + suggestion.id
            suggestions[id] = suggestion.label
            for member in suggestion.memberIds where labels[member] == unassignedID { labels[member] = id }
        }
        var clouds = makeDomainClouds(domains, ancestors: ancestors)
        let domainIDs = Set(clouds.map(\.id))
        let legacy = Set(labels.values.filter { !domainIDs.contains($0) && $0 != archiveID }).sorted()
        for id in legacy {
            let central = brain.first { labels[$0.id] == id }
            let title = id == unassignedID ? "Unassigned" : (suggestions[id].map { "Suggested · " + $0 } ?? central?.title ?? "Related records")
            let center = !domains.isEmpty || legacy.count > 1 ? vector(id + ":anchor", radius: id == unassignedID ? 0 : 260) : Vector()
            clouds.append(Cloud(id: id, title: title, parentID: nil, level: 0, hue: hue(id), radius: 112, center: center))
        }
        if labels.values.contains(archiveID) {
            var center = clouds.isEmpty ? Vector() : vector(archiveID + ":anchor", radius: 380)
            for attempt in 0..<128 {
                let overlaps = clouds.contains {
                    let delta = center - $0.center
                    return delta.distance < $0.radius + 175 || hypot(delta.projectedX, delta.projectedY) < $0.radius + 175
                }
                guard overlaps else { break }
                center = vector(archiveID + ":anchor:" + String(attempt), radius: Double(380 + attempt * 12))
            }
            clouds.append(Cloud(id: archiveID, title: "Chat archive", parentID: nil, level: 0, hue: 194 / 360.0, radius: 112, center: center))
        }
        let cloudIndices = Dictionary(clouds.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { first, _ in first })
        var world: [(id: String, cloud: String, position: Vector, hue: Double)] = []
        for node in nodes {
            guard let id = labels[node.id], let index = cloudIndices[id] else { continue }
            let cloud = clouds[index]
            let offset = vector(node.id, radius: cbrt(unit(node.id + ":radius")) * cloud.radius * 0.88)
            let tint = id == unassignedID && overview ? hue(node.id, suffix: ":record-tint") : cloud.hue
            world.append((node.id, id, cloud.center + offset, tint))
            clouds[index].members.append(node.id)
        }
        for index in clouds.indices.sorted(by: { clouds[$0].level > clouds[$1].level }) {
            if let parent = clouds[index].parentID, let parentIndex = cloudIndices[parent], parentIndex != index {
                let members = clouds[index].members
                clouds[parentIndex].members.append(contentsOf: members)
            }
        }
        let roots = clouds.filter { $0.parentID == nil && !$0.members.isEmpty }
        let orderedRoots = roots.sorted {
            if $0.id == archiveID { return false }
            if $1.id == archiveID { return true }
            return less($0.id, $1.id)
        }
        let columns = roots.count < 2 ? 1 : max(2, min(roots.count, Int(sqrt(Double(roots.count) * max(0.45, min(2, aspect))).rounded())))
        let centers = Dictionary(uniqueKeysWithValues: orderedRoots.enumerated().map {
            ($0.element.id, Vector(x: Double(($0.offset % columns) * 350), y: Double(($0.offset / columns) * 310)))
        })
        let visible = overview ? previewIDs(roots) : Set(nodes.map(\.id))
        let points = world.compactMap { value -> Point? in
            guard visible.contains(value.id) else { return nil }
            if overview {
                return Point(id: value.id, groupID: value.cloud, x: value.position.projectedX, y: value.position.projectedY,
                             hue: value.hue, spatialX: value.position.x, spatialY: value.position.y, spatialZ: value.position.z)
            }
            var root = value.cloud
            for _ in 0..<5 {
                guard let index = cloudIndices[root], let parent = clouds[index].parentID else { break }
                root = parent
            }
            guard let rootIndex = cloudIndices[root], let center = centers[root] else { return nil }
            let relative = value.position - clouds[rootIndex].center
            return Point(id: value.id, groupID: value.cloud, x: center.x + relative.projectedX,
                         y: center.y + relative.projectedY, hue: value.hue,
                         spatialX: value.position.x, spatialY: value.position.y, spatialZ: value.position.z)
        }
        let groups = (overview ? roots : clouds).filter { !$0.members.isEmpty }.map {
            Group(id: $0.id, title: $0.title, parentID: $0.parentID, members: $0.members, hue: $0.hue,
                  spatialX: $0.center.x, spatialY: $0.center.y, spatialZ: $0.center.z, radius: $0.radius)
        }
        return Layout(points: points, groups: groups)
    }

    private static func previewIDs(_ roots: [Cloud]) -> Set<String> {
        var selected: Set<String> = []
        let longest = roots.map { $0.members.count }.max() ?? 0
        for index in 0..<longest {
            for group in roots where group.members.indices.contains(index) {
                selected.insert(group.members[index])
                if selected.count == 128 { return selected }
            }
        }
        return selected
    }

    private static func assignRelatedGroups(_ brain: [HubHomeKnowledge.Node], known: Set<String>,
                                            graph: HubHomeKnowledge, labels: inout [String: String]) {
        var weights: [String: [String: Double]] = [:]
        func connect(_ a: String, _ b: String, _ weight: Double) {
            guard a != b, known.contains(a), known.contains(b) else { return }
            weights[a, default: [:]][b] = max(weight, weights[a]?[b] ?? 0)
            weights[b, default: [:]][a] = max(weight, weights[b]?[a] ?? 0)
        }
        for edge in graph.edges { connect(edge.source, edge.target, 2.4) }
        for edge in graph.similarities ?? [] where edge.score >= 0.56 { connect(edge.source, edge.target, edge.score) }
        for node in brain where weights[node.id]?.isEmpty == false { labels[node.id] = node.id }
        for _ in 0..<6 {
            for node in brain {
                var counts: [String: Double] = [:]
                for (neighbor, weight) in (weights[node.id] ?? [:]).sorted(by: { less($0.key, $1.key) }) {
                    if let label = labels[neighbor] { counts[label, default: 0] += weight }
                }
                let best = counts.sorted { $0.value == $1.value ? less($0.key, $1.key) : $0.value > $1.value }.first
                if let best { labels[node.id] = best.key }
            }
        }
    }

    private static func makeDomainClouds(_ domains: [HubHomeKnowledge.Domain], ancestors: [String: [String]]) -> [Cloud] {
        func byAge(_ lhs: HubHomeKnowledge.Domain, _ rhs: HubHomeKnowledge.Domain) -> Bool {
            let left = lhs.createdAt ?? 0
            let right = rhs.createdAt ?? 0
            return left == right ? less(lhs.id, rhs.id) : left < right
        }
        var clouds: [Cloud] = []
        for root in domains.filter({ $0.parentId == nil }).sorted(by: byAge) {
            var center = vector(root.id + ":anchor", radius: 230 + unit(root.id) * 100)
            for attempt in 0..<64 {
                guard clouds.contains(where: { (center - $0.center).distance < 245 }) else { break }
                center = vector(root.id + ":anchor:" + String(attempt), radius: Double(260 + attempt * 9))
            }
            clouds.append(Cloud(id: root.id, title: root.title, parentID: nil, level: 0,
                                hue: hue(root.id), radius: 112, center: center))
        }
        let children = domains.filter { $0.parentId != nil }.sorted {
            let left = ancestors[$0.id]?.count ?? 0
            let right = ancestors[$1.id]?.count ?? 0
            return left == right ? byAge($0, $1) : left < right
        }
        for child in children {
            guard let parent = clouds.first(where: { $0.id == child.parentId }) else { continue }
            let siblings = clouds.filter { $0.parentID == parent.id }
            var offset = vector(child.id + ":anchor", radius: parent.radius * 0.62)
            for attempt in 0..<48 {
                guard siblings.contains(where: { (parent.center + offset - $0.center).distance < parent.radius * 0.66 }) else { break }
                offset = vector(child.id + ":anchor:" + String(attempt), radius: parent.radius * 0.62)
            }
            let root = ancestors[child.id]?.last ?? child.id
            clouds.append(Cloud(id: child.id, title: child.title, parentID: parent.id, level: parent.level + 1,
                                hue: hue(root), radius: parent.radius * 0.32, center: parent.center + offset))
        }
        return clouds
    }

    private static func less(_ left: String, _ right: String) -> Bool {
        left.compare(right, locale: Locale(identifier: "en_US")) == .orderedAscending
    }

    static func hash(_ value: String) -> UInt32 {
        var h: UInt32 = 2_166_136_261
        for scalar in value.unicodeScalars {
            let code = scalar.value <= 0xffff ? scalar.value : 0xd800 + ((scalar.value - 0x10000) >> 10)
            h = (h ^ code) &* 16_777_619
        }
        h = (h ^ (h >> 16)) &* 0x85ebca6b
        h = (h ^ (h >> 13)) &* 0xc2b2ae35
        return h ^ (h >> 16)
    }

    private static func unit(_ value: String) -> Double { Double(hash(value)) / Double(UInt32.max) }
    private static func hue(_ id: String, suffix: String = ":color") -> Double { (unit(id + suffix) * 360).rounded() / 360 }

    private static func vector(_ id: String, radius: Double) -> Vector {
        let z = unit(id + ":z") * 2 - 1
        let angle = unit(id + ":a") * .pi * 2
        let radial = sqrt(max(0, 1 - z * z))
        return Vector(x: cos(angle) * radial * radius, y: sin(angle) * radial * radius, z: z * radius)
    }
}
