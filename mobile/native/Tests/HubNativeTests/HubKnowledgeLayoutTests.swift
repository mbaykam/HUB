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
        let expected: [(String, String, Double, Double)] = [
            ("chat-1", HubKnowledgeLayout.archiveID, 352.6138676445115, -42.26601201671411),
            ("note-a", "child", -45.59659541852051, 38.87499917689874),
            ("note-b", "root", 52.926098191879355, -72.88637053271022),
        ]
        XCTAssertEqual(layout.points.map(\.id), expected.map { $0.0 })
        for (point, value) in zip(layout.points, expected) {
            XCTAssertEqual(point.groupID, value.1)
            XCTAssertEqual(point.x, value.2, accuracy: 0.000_001)
            XCTAssertEqual(point.y, value.3, accuracy: 0.000_001)
        }
        XCTAssertEqual(layout.groups.first(where: { $0.id == "root" })?.members.sorted(), ["note-a", "note-b"])
        let preview = HubKnowledgeLayout.project(graph, includesNotes: true, includesArchive: false, overview: true, aspect: 0.8)
        XCTAssertEqual(preview.points.map(\.id), ["note-a", "note-b"])
        let point = try XCTUnwrap(preview.points.first)
        XCTAssertEqual(point.x, -17.863525301785813, accuracy: 0.000_001)
        XCTAssertEqual(point.y, 231.78380832598347, accuracy: 0.000_001)
    }
}
