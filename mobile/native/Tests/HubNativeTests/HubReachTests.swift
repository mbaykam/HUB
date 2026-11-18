import XCTest
@testable import HubNative

final class HubReachTests: XCTestCase {
    func testPushStatusCarriesPreferencesAndOlderHubsStillDecode() throws {
        let data = Data(#"""
        {"version":1,"configured":true,"devices":1,"pending":0,"preferences":{"kinds":{"reply":true,"brief":false},
         "quiet":{"enabled":true,"start":"22:30","end":"07:30"},"timeZone":"Europe/Istanbul","briefTime":"08:00","reminderMinutes":15}}
        """#.utf8)
        let status = try JSONDecoder().decode(HubPushStatus.self, from: data)
        let prefs = try XCTUnwrap(status.preferences)
        XCTAssertFalse(prefs.allows("brief"))
        XCTAssertTrue(prefs.allows("approval"), "Kinds a HUB does not list default to on")
        XCTAssertTrue(prefs.quiet.enabled)
        let old = try JSONDecoder().decode(HubPushStatus.self, from: Data(#"{"version":1,"configured":true,"devices":1,"pending":0}"#.utf8))
        XCTAssertNil(old.preferences)
    }

    func testClockTimesRoundTripThroughDates() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let date = HubPushPreferences.date("07:05", calendar: calendar)
        XCTAssertEqual(HubPushPreferences.clock(date, calendar: calendar), "07:05")
    }

    func testNotificationNoteReadsIdsForButtons() throws {
        let note = try XCTUnwrap(HubPushNote(["kind": "approval", "status": "attention", "goalId": "g1", "approvalId": "a1", "revision": 3]))
        XCTAssertEqual(note.goalID, "g1")
        XCTAssertEqual(note.approvalID, "a1")
        XCTAssertEqual(note.revision, 3)
        XCTAssertNil(HubPushNote(["kind": "<script>"]))
        XCTAssertNil(HubPushNote(nil))
    }

    func testAppsSnapshotDecodes() throws {
        let data = Data(#"""
        {"apps":[{"id":"8d2c1f2e-1a2b-4c3d-9e8f-001122334455","title":"Tip calculator","description":"","icon":"🧮","color":"#54DEFF",
          "createdAt":1,"updatedAt":2,"bytes":1200,"url":"/apps/run/8d2c1f2e-1a2b-4c3d-9e8f-001122334455",
          "shares":[{"slug":"bright-otter","url":"https://bright-otter.here.now/","createdAt":1,"expiresAt":86400001,"anonymous":true}]}],
         "sharing":{"accountKey":false},"result":{"note":"Without a here.now account key this link lasts 24 hours."}}
        """#.utf8)
        let snapshot = try JSONDecoder().decode(HubAppsSnapshot.self, from: data)
        XCTAssertEqual(snapshot.apps.first?.shares.first?.anonymous, true)
        XCTAssertEqual(snapshot.result?.note?.hasPrefix("Without"), true)
        XCTAssertFalse(snapshot.sharing.accountKey)
    }
}
