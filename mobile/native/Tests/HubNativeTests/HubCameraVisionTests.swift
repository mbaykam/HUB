import XCTest
@testable import HubNative

final class HubCameraVisionTests: XCTestCase {
    func testSceneHeaderIsCompactBase64urlJSON() throws {
        let scene = HubVisionScene(marks: [
            .init(id: 1, label: "Router", text: "AX55", x: 0.51234, y: 0.3, width: 0.2, height: 0.1),
            .init(id: 2, label: String(repeating: "x", count: 90), text: nil, x: -1, y: 2, width: .nan, height: 0.1),
        ])
        let header = scene.headerValue
        XCTAssertFalse(header.contains("+") || header.contains("/") || header.contains("="))
        var base64 = header.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64 += "=" }
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(Data(base64Encoded: base64))) as? [String: Any])
        let marks = try XCTUnwrap(object["marks"] as? [[String: Any]])
        XCTAssertEqual(marks.count, 2)
        XCTAssertEqual(marks[0]["x"] as? Double, 0.512)
        XCTAssertEqual((marks[1]["label"] as? String)?.count, 40)
        XCTAssertEqual(marks[1]["x"] as? Double, 0)
        XCTAssertEqual(marks[1]["y"] as? Double, 1)
        XCTAssertEqual(marks[1]["width"] as? Double, 0)
    }

    func testStatusCarriesCameraOverlays() throws {
        let data = Data(#"""
        {"sharing":true,"hasFrame":true,"maxAgeMs":5000,"overlay":{"id":"o1","note":"Plug it here","sequence":7,"clear":true,
         "items":[{"mark":3,"style":"arrow","label":"WAN port"},{"x":0.4,"y":0.5,"style":"step","step":2},
                  {"x":0.9,"y":0.9,"width":0.3,"height":0.3,"style":"box"},{"x":0.2,"y":0.2,"style":"sparkle"}]}}
        """#.utf8)
        let status = try JSONDecoder().decode(HubScreenStatus.self, from: data)
        let overlay = try XCTUnwrap(status.overlay)
        XCTAssertEqual(overlay.sequence, 7)
        XCTAssertTrue(overlay.clear)
        XCTAssertEqual(overlay.items.count, 4)
        XCTAssertEqual(overlay.items[3].style, .circle, "An unknown style still draws as a ring")
        XCTAssertEqual(overlay.drawable.map(\.style), [.arrow, .step, .circle], "A box running off the frame is left out")
        XCTAssertNil(try JSONDecoder().decode(HubScreenStatus.self, from: Data(#"{"sharing":true,"hasFrame":true,"maxAgeMs":5000}"#.utf8)).overlay)
    }
}
