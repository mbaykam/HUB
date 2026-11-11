import XCTest
@testable import HubNative

final class HubVoiceEndCommandTests: XCTestCase {
    func testExplicitUserRequests() {
        for text in ["Sesi kapat", "Vera, konuşmayı bitir.", "Lütfen sesli görüşmeyi sonlandır", "End the call", "Can you end this conversation?", "Please stop voice chat."] {
            XCTAssertTrue(HubRTVI.requestsEnd(text), text)
        }
    }
    func testDoesNotCloseForDiscussionNegationOrUnrelatedSpeech() {
        for text in ["Don't end the call", "Sakın sesi kapat", "Asla sesi kapat", "Konuşmayı kapatma", "Sesi kapat dediğimde ne oluyor?", "Vera sesi kapatamıyor", "Mute", "Stop the music", "She said end the call", "\"Sesi kapat\"", "I want to talk about how to end the call"] {
            XCTAssertFalse(HubRTVI.requestsEnd(text), text)
        }
    }
}
