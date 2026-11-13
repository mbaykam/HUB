import XCTest
@testable import HubNative

final class HubHomeStateTests: XCTestCase {
    func testOnlyCurrentConnectionCanPublish() {
        var home = HubHomeState()
        let old = home.begin(hasServer: true)
        let current = home.begin(hasServer: true)
        XCTAssertFalse(home.resolve(.signInRequired, attempt: old))
        XCTAssertEqual(home.connection, .connecting)
        XCTAssertTrue(home.resolve(.connected, attempt: current))
        XCTAssertFalse(home.resolve(.unavailable, attempt: current))
        XCTAssertEqual(home.connection, .connected)
    }

    func testSigningOutInvalidatesInFlightConnection() {
        var home = HubHomeState()
        let old = home.begin(hasServer: true)
        _ = home.begin(hasServer: false)
        XCTAssertFalse(home.isCurrent(old))
        XCTAssertFalse(home.resolve(.connected, attempt: old))
        XCTAssertEqual(home.connection, .needsSetup)
    }
}
