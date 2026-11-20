import XCTest
@testable import HubNative

final class HubScheduleTests: XCTestCase {
    private let fixture = #"""
    {"revision":4,"heartbeat":{"enabled":true,"everyMinutes":60,"start":"08:00","end":"23:00","timezone":"Europe/Istanbul",
      "checklist":"Mail replies","nextAt":1763445600000,"last":{"at":1763442000000,"status":"completed","text":"Nothing needed your attention."}},
     "jobs":[
      {"id":"r1","name":"Test sharing","kind":"reminder","text":"Share your screen.","when":{"kind":"once","at":1763449200000},
       "enabled":true,"state":"active","status":"scheduled","nextAt":1763449200000},
      {"id":"t1","name":"News","kind":"task","text":"Three headlines.","when":{"kind":"daily","hour":8,"minute":30,"days":[1,2,3,4,5],"timezone":"Europe/Istanbul"},
       "enabled":false,"state":"paused","status":"paused"},
      {"id":"w1","name":"Watch","kind":"task","text":"Price.","when":{"kind":"other","summary":"When https://example.com changes"},
       "enabled":true,"state":"active","status":"scheduled"}]}
    """#

    func testDecodesTheScheduleView() throws {
        let schedule = try JSONDecoder().decode(HubSchedule.self, from: Data(fixture.utf8))
        XCTAssertTrue(schedule.heartbeat.enabled)
        XCTAssertEqual(schedule.heartbeat.everyMinutes, 60)
        XCTAssertEqual(schedule.jobs.map(\.id), ["r1", "t1", "w1"])
        XCTAssertTrue(schedule.jobs[0].isReminder)
        XCTAssertEqual(schedule.jobs[1].when.days, [1, 2, 3, 4, 5])
        XCTAssertEqual(schedule.jobs[2].when.summary, "When https://example.com changes")
    }

    func testDraftRoundTripsADailyJob() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Istanbul")!
        let schedule = try JSONDecoder().decode(HubSchedule.self, from: Data(fixture.utf8))
        let draft = HubScheduleDraft(schedule.jobs[1], calendar: calendar)
        XCTAssertEqual(draft.kind, .task)
        XCTAssertEqual(draft.repeats, .daily)
        XCTAssertEqual(draft.days, [1, 2, 3, 4, 5])
        let command = draft.command(calendar: calendar)
        XCTAssertEqual(command["action"] as? String, "save")
        let job = try XCTUnwrap(command["job"] as? [String: Any])
        XCTAssertEqual(job["id"] as? String, "t1")
        let when = try XCTUnwrap(job["when"] as? [String: Any])
        XCTAssertEqual(when["kind"] as? String, "daily")
        XCTAssertEqual(when["hour"] as? Int, 8)
        XCTAssertEqual(when["minute"] as? Int, 30)
        XCTAssertEqual(when["days"] as? [Int], [1, 2, 3, 4, 5])
        XCTAssertTrue(JSONSerialization.isValidJSONObject(command))
    }

    func testANewReminderNeedsANameAndText() {
        var draft = HubScheduleDraft()
        XCTAssertFalse(draft.isValid)
        draft.name = "Call mom"
        draft.text = "Call mom about the weekend."
        XCTAssertTrue(draft.isValid)
        let job = draft.command()["job"] as? [String: Any]
        XCTAssertNil(job?["id"])
        XCTAssertEqual((job?["when"] as? [String: Any])?["kind"] as? String, "once")
        draft.repeats = .daily
        draft.days = []
        XCTAssertFalse(draft.isValid)
    }
}
