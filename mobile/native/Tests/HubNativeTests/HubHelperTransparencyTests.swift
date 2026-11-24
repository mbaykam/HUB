import Foundation
import XCTest
@testable import HubNative

final class HubHelperTransparencyTests: XCTestCase {
    func testOldHostPayloadRemainsReadable() throws {
        let data = Data(#"{"sessionId":"child","title":"Helper","brief":"Read a file","running":false,"outcome":"done","entries":[]}"#.utf8)
        let work = try JSONDecoder().decode(HubHelperTransparency.self, from: data)
        XCTAssertEqual(work.statusLabel, "Completed")
        XCTAssertNil(work.actualRoute)
        XCTAssertNil(work.routing)
        XCTAssertEqual(HubHelperTransparency.billingLabel(nil), "Billing unknown")
    }

    func testChosenAndObservedModelsRemainDistinct() throws {
        let data = Data(#"{"sessionId":"child","title":"Helper","brief":"Inspect code","running":true,"outcome":"waiting","currentOperation":"Waiting to retry model request","blocker":"Rate limited","routing":{"preset":"auto","provider":"claude-code","model":"opus","billingBasis":"subscription","reason":"Configured subscription route"},"actualRoute":{"provider":"openai-codex","model":"gpt-5","billingBasis":"subscription","evidence":"response"},"routeChanges":[{"provider":"openai-codex","model":"gpt-5","billingBasis":"subscription","at":10}],"entries":[{"kind":"event","title":"Waiting to retry model request","at":10}]}"#.utf8)
        let work = try JSONDecoder().decode(HubHelperTransparency.self, from: data)
        XCTAssertEqual(work.statusLabel, "Waiting")
        XCTAssertEqual(work.routing?.model, "opus")
        XCTAssertEqual(work.actualRoute?.model, "gpt-5")
        XCTAssertEqual(work.blocker, "Rate limited")
        XCTAssertEqual(work.routeChanges?.count, 1)
        XCTAssertEqual(HubHelperTransparency.billingLabel("api"), "Metered API")
    }
}
