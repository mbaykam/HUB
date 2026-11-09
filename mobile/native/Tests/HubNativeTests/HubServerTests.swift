import Foundation
import XCTest
@testable import HubNative

final class HubServerTests: XCTestCase {
    func testCanonicalOriginAndExactAuthority() throws {
        let server = try HubServer(address: "  https://HUB.example.com:443/  ")
        XCTAssertEqual(server.origin.absoluteString, "https://hub.example.com/")
        XCTAssertEqual(server.statusURL.path, "/api/hub/voice/status")
        XCTAssertTrue(server.contains(URL(string: "https://hub.example.com/chat")!))
        for value in ["http://hub.example.com/", "https://hub.example.com:444/", "https://hub.example.com.evil.test/", "https://user@hub.example.com/", "https://elsewhere.test/"] {
            XCTAssertFalse(server.contains(URL(string: value)!), value)
        }
    }

    func testNeverPersistAuthenticationLinksOrAmbiguousAddresses() {
        for value in ["http://localhost/", "file:///etc/passwd", "javascript:alert(1)", "https://hub.example.com/?token=secret", "https://hub.example.com/#secret", "https://user:secret@hub.example.com/", "https://hub.example.com/path", "https://hub.example.com/%2f", "https://hub.example.com:0/", "https://hub.example.com:65536/", "https://hub.example.com\\@evil.test/", "https://hub.example.com/\npath"] {
            XCTAssertThrowsError(try HubServer(address: value), value)
        }
    }

    func testCookieAudiencePathExpiryAndRedirectIsolation() throws {
        let server = try HubServer(address: "https://hub.example.com")
        func cookie(_ name: String, domain: String, path: String = "/", expires: Date? = nil) -> HTTPCookie {
            var properties: [HTTPCookiePropertyKey: Any] = [.name: name, .value: "fixture", .domain: domain, .path: path, .secure: "TRUE"]
            if let expires = expires { properties[.expires] = expires }
            return HTTPCookie(properties: properties)!
        }
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let candidates = [
            cookie("session", domain: "hub.example.com"),
            cookie("parent", domain: ".example.com"),
            cookie("wrong", domain: "other.example.com"),
            cookie("expired", domain: "hub.example.com", expires: now.addingTimeInterval(-1)),
            cookie("scoped", domain: "hub.example.com", path: "/api/hub/voice"),
            cookie("lookalikePath", domain: "hub.example.com", path: "/api/hub/vo"),
            cookie("lookalikeDomain", domain: ".ub.example.com")
        ]
        XCTAssertEqual(server.cookies(candidates, for: server.statusURL, now: now).map(\.name), ["session", "parent", "scoped"])
        XCTAssertTrue(server.cookies(candidates, for: URL(string: "https://login.example.com/")!, now: now).isEmpty)
        XCTAssertTrue(server.cookies(candidates, for: URL(string: "https://hub.example.com:444/")!, now: now).isEmpty)
    }
}
