import Foundation
import XCTest
@testable import HubNative

final class HubKnowledgeLayoutTests: XCTestCase {
    func testCoordinatesAndMembershipMatchWebFixture() throws {
        let graph = try JSONDecoder().decode(HubHomeKnowledge.self, from: Data(#"""
        {
          "nodes":[{"id":"note-a","title":"Note A","kind":"note"},{"id":"note-b","title":"Note B","kind":"note"},
                   {"id":"chat-1","title":"Chat","kind":"conversation"}],
          "edges":[{"source":"chat-1","target":"note-a"}],
          "domains":[{"id":"root","title":"Root","status":"active"},
                     {"id":"child","title":"Child","status":"active","parentId":"root"}],
          "memberships":[{"nodeId":"note-a","domainId":"root"},{"nodeId":"note-a","domainId":"child"},
                         {"nodeId":"note-b","domainId":"root"}]
        }
        """#.utf8))
        let layout = HubKnowledgeLayout.project(graph, includesNotes: true, includesArchive: true, overview: false, aspect: 0.8)
        XCTAssertEqual(layout.points.map(\.id), ["chat-1", "note-a", "note-b"])
        XCTAssertEqual(layout.points.map(\.groupID), [HubKnowledgeLayout.archiveID, "child", "root"])
        XCTAssertEqual(layout.groups.first(where: { $0.id == "root" })?.members.sorted(), ["note-a", "note-b"])
        // Every record sits inside its top domain's disc, and the discs never overlap.
        let root = try XCTUnwrap(layout.groups.first { $0.id == "root" })
        let archive = try XCTUnwrap(layout.groups.first { $0.id == HubKnowledgeLayout.archiveID })
        for point in layout.points {
            let disc = point.groupID == HubKnowledgeLayout.archiveID ? archive : root
            XCTAssertLessThanOrEqual(hypot(point.x - disc.planeX, point.y - disc.planeY), disc.planeRadius)
        }
        XCTAssertGreaterThan(hypot(root.planeX - archive.planeX, root.planeY - archive.planeY), root.planeRadius + archive.planeRadius)
        // Same input, same picture.
        let again = HubKnowledgeLayout.project(graph, includesNotes: true, includesArchive: true, overview: false, aspect: 0.8)
        XCTAssertEqual(again.points.map(\.x), layout.points.map(\.x))
        // A subdomain shares its domain's color.
        XCTAssertEqual(layout.points[1].hue, layout.points[2].hue)
        let preview = HubKnowledgeLayout.project(graph, includesNotes: true, includesArchive: false, overview: true, aspect: 0.8)
        XCTAssertEqual(preview.points.map(\.id), ["note-a", "note-b"])
    }

    func testPackedDiscsNeverOverlap() {
        let radii: [Double] = [60, 45, 45, 30, 30, 20, 20, 12, 12, 12]
        let centers = HubKnowledgeLayout.pack(radii, gap: 10, aspect: 1.4)
        for i in radii.indices {
            for j in radii.indices where j > i {
                let distance = hypot(centers[i].x - centers[j].x, centers[i].y - centers[j].y)
                XCTAssertGreaterThanOrEqual(distance, radii[i] + radii[j] + 10 - 0.001)
            }
        }
    }

    func testSummaryCountsNotesPerTopDomain() throws {
        let graph = try JSONDecoder().decode(HubHomeKnowledge.self, from: Data(#"""
        {
          "nodes":[{"id":"a","title":"A","kind":"note"},{"id":"b","title":"B","kind":"note"},
                   {"id":"c","title":"C","kind":"note"},{"id":"chat","title":"Chat","kind":"conversation"}],
          "edges":[],
          "domains":[{"id":"root","title":"Root","status":"active","createdAt":1},
                     {"id":"child","title":"Child","status":"active","parentId":"root","createdAt":2},
                     {"id":"other","title":"Other","status":"active","createdAt":3}],
          "memberships":[{"nodeId":"a","domainId":"child"},{"nodeId":"a","domainId":"root"},{"nodeId":"b","domainId":"root"}]
        }
        """#.utf8))
        let summary = HubKnowledgeLayout.summary(graph)
        XCTAssertEqual(summary.map(\.id), ["root", HubKnowledgeLayout.unassignedID])
        XCTAssertEqual(summary.map(\.count), [2, 1])
        XCTAssertEqual(summary.first?.hue, HubKnowledgeLayout.palette[0])
    }
}
