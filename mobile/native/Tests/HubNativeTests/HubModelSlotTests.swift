import XCTest
@testable import HubNative

final class HubModelSlotTests: XCTestCase {
    func testPickerKnowsWhenTheChatIsUnlocked() throws {
        let json = #"{"revision":3,"currentId":"b","selectedId":"b","pending":false,"canSelect":true,"mainId":"a","voiceId":"v","unrestrictedId":"b","characters":[]}"#
        let picker = try JSONDecoder().decode(HubChatCharacterPicker.self, from: Data(json.utf8))
        XCTAssertTrue(picker.unlocked)
        XCTAssertEqual(picker.mainId, "a")
    }

    func testOlderHostsWithoutSlotsStillDecode() throws {
        let json = #"{"revision":1,"selectedId":"a","pending":false,"canSelect":true,"characters":[]}"#
        let picker = try JSONDecoder().decode(HubChatCharacterPicker.self, from: Data(json.utf8))
        XCTAssertNil(picker.unrestrictedId)
        XCTAssertFalse(picker.unlocked)
    }

    func testRefusalsAreRecognisedInEnglishAndTurkish() {
        XCTAssertTrue(HubChatCharacterPicker.looksLikeRefusal("I'm sorry, but I can't help with that request."))
        XCTAssertTrue(HubChatCharacterPicker.looksLikeRefusal("Maalesef bu konuda yardımcı olamam."))
        XCTAssertFalse(HubChatCharacterPicker.looksLikeRefusal("Here are three noodle stand layouts to compare."))
    }
    func testAChatListsOnlyItsOwnHelpersNewestFirst() throws {
        let json = #"{"byId":{"h1":{"title":"Compare cookers","running":false,"completed":true,"failed":false,"stopped":false,"origin":"subagent","updatedAt":10,"parentId":"chat-a"},"h2":{"title":"Find permits","running":true,"completed":false,"failed":false,"stopped":false,"origin":"subagent","updatedAt":20,"parentId":"chat-a"},"h3":{"title":"Other","running":true,"completed":false,"failed":false,"stopped":false,"origin":"subagent","updatedAt":30,"parentId":"chat-b"},"chat-a":{"running":false,"completed":false,"failed":false,"stopped":false,"updatedAt":5}},"at":40}"#
        let work = try JSONDecoder().decode(HubHomeWork.self, from: Data(json.utf8))
        let helpers = work.helpers(of: "chat-a")
        XCTAssertEqual(helpers.map(\.id), ["h2", "h1"])
        XCTAssertEqual(helpers.map(\.state), [.running, .done])
    }

    func testHelperWorkDecodes() throws {
        let json = #"{"sessionId":"h1","title":"Compare cookers","brief":"Compare three cookers","running":false,"outcome":"done","entries":[{"kind":"step","title":"web_search","detail":"pasta cooker","failed":true,"at":1},{"kind":"text","text":"Pick the 4-basket one.","at":2}]}"#
        let work = try JSONDecoder().decode(HubHelperWork.self, from: Data(json.utf8))
        XCTAssertEqual(work.entries.count, 2)
        XCTAssertEqual(work.entries.first?.failed, true)
    }
}