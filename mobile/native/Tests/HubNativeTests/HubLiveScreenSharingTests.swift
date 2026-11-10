import Foundation
import XCTest
@testable import HubNative

@MainActor final class HubLiveScreenSharingTests: XCTestCase {
    private func wait(_ condition: () -> Bool) async {
        for _ in 0..<1000 { if condition() { return }; await Task.yield() }
        XCTFail("Fixture operation did not settle")
    }
    private func frame(_ at: Date) -> HubScreenFrame {
        // Coordinator fixture only. ImageIO admission and real JPEG decoding
        // are covered by HubScreenFramesTests and the host decoder tests.
        HubScreenFrame(id: UUID(), jpeg: Data([1,2,3]), capturedAt: at, width: 1, height: 1)
    }
    func testNoQueueAndStopRejectsLateUploadCompletion() async {
        var starts = 0, stops = 0, uploads = 0
        var finish: CheckedContinuation<Void, Never>?
        let sharing = HubLiveScreenSharing(consent: { _, start in if start { starts += 1 } else { stops += 1 } }, upload: { _, _, _ in uploads += 1; await withCheckedContinuation { finish = $0 } }, owned: { true })
        sharing.offer(frame(Date())); XCTAssertEqual(uploads, 0)
        let id = UUID(); sharing.beginAfterSystemConsent(id)
        await wait { starts == 1 }; await Task.yield()
        sharing.offer(frame(Date())); await wait { uploads == 1 }
        for _ in 0..<20 { sharing.offer(frame(Date())) }; XCTAssertEqual(uploads, 1)
        sharing.stop(); XCTAssertFalse(sharing.active); await wait { stops == 1 }
        finish?.resume(); await Task.yield()
        sharing.beginAfterSystemConsent(id); await Task.yield()
        XCTAssertFalse(sharing.active); XCTAssertEqual(starts, 1); XCTAssertEqual(uploads, 1)
    }
    func testLostConsentReplyReusesReceiptAndOwnerLossStops() async {
        var receipts: [UUID] = [], stops: [UUID] = [], owned = true
        let id = UUID()
        let sharing = HubLiveScreenSharing(consent: { receipt, start in
            if start { receipts.append(receipt); if receipts.count == 1 { throw URLError(.networkConnectionLost) } }
            else { stops.append(receipt) }
        }, upload: { _, _, _ in XCTFail("No frame was offered") }, owned: { owned })
        sharing.beginAfterSystemConsent(id); await wait { receipts.count == 2 }; await Task.yield()
        XCTAssertEqual(receipts, [id,id]); owned = false; sharing.offer(frame(Date()))
        XCTAssertFalse(sharing.active); await wait { stops == [id] }
    }
    func testRepeatedFailuresStopWithoutAutomaticConsentRestart() async {
        var now = Date(), attempts = 0, starts = 0, stops = 0
        let sharing = HubLiveScreenSharing(consent: { _, start in if start { starts += 1 } else { stops += 1 } }, upload: { _, _, _ in attempts += 1; throw URLError(.notConnectedToInternet) }, owned: { true }, now: { now })
        sharing.beginAfterSystemConsent(UUID()); await wait { starts == 1 }; await Task.yield()
        for n in 1...3 {
            now.addTimeInterval(2); sharing.offer(frame(now)); await wait { attempts == n }; await Task.yield()
        }
        await wait { !sharing.active }; await wait { stops == 1 }
        sharing.offer(frame(now)); XCTAssertEqual(starts, 1); XCTAssertEqual(attempts, 3)
    }
    func testStaleFramesAreDroppedBeforeAnyNetworkUpload() async {
        let now = Date(); var starts = 0, uploads = 0
        let sharing = HubLiveScreenSharing(consent: { _, start in if start { starts += 1 } }, upload: { _, _, _ in uploads += 1 }, owned: { true }, now: { now })
        sharing.beginAfterSystemConsent(UUID()); await wait { starts == 1 }; await Task.yield()
        sharing.offer(frame(now.addingTimeInterval(-5))); sharing.offer(frame(now.addingTimeInterval(1)))
        XCTAssertEqual(uploads, 0); sharing.stop()
    }
}
