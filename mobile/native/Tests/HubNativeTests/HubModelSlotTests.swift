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
}
