import XCTest
@testable import HubNative

final class HubPageRecoveryTests: XCTestCase {
    func testVisiblePageCancelsDeadlineAndLateBackgroundCallbacks() {
        var recovery = HubPageRecovery()
        let old = recovery.begin(), current = recovery.begin()
        XCTAssertFalse(recovery.visible(old))
        XCTAssertFalse(recovery.expired(old))
        XCTAssertTrue(recovery.visible(current))
        XCTAssertFalse(recovery.expired(current))
    }
    func testBlankOrUnresponsivePageGetsOneRecoveryAndCancelInvalidatesIt() {
        var recovery = HubPageRecovery()
        let blank = recovery.begin()
        XCTAssertTrue(recovery.expired(blank))
        XCTAssertFalse(recovery.expired(blank))
        let suspended = recovery.begin()
        recovery.cancel()
        XCTAssertFalse(recovery.expired(suspended))
        XCTAssertFalse(recovery.visible(suspended))
    }
    func testOnlyMainFrameHTTPFailuresReplaceThePage() {
        XCTAssertFalse(HubPageRecovery.failedHTTP(status: 200, mainFrame: true))
        XCTAssertFalse(HubPageRecovery.failedHTTP(status: 503, mainFrame: false))
        XCTAssertTrue(HubPageRecovery.failedHTTP(status: 401, mainFrame: true))
        XCTAssertTrue(HubPageRecovery.failedHTTP(status: 502, mainFrame: true))
    }
}
