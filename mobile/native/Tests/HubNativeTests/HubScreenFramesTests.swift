import Foundation
import XCTest
import ImageIO
import CoreGraphics
@testable import HubNative

final class HubScreenFramesTests: XCTestCase {
    private func jpeg(width: Int = 2, height: Int = 2) throws -> Data {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        let image = try XCTUnwrap(context.makeImage()), bytes = NSMutableData()
        let output = try XCTUnwrap(CGImageDestinationCreateWithData(bytes, "public.jpeg" as CFString, 1, nil))
        CGImageDestinationAddImage(output, image, nil); XCTAssertTrue(CGImageDestinationFinalize(output))
        return bytes as Data
    }
    private func owner(_ call: String = "call", host: String = "https://hub.test") throws -> HubScreenOwner {
        try HubScreenOwner(server: HubServer(address: host), sessionID: "chat", callID: call)
    }
    func testFramesExpireAndNeverCrossCallsOrServers() async throws {
        var time = Date(timeIntervalSince1970: 1_700_000_000)
        let gate = HubScreenFrames(now: { time }), owner = try owner()
        let generation = await gate.beginAfterSystemConsent(owner: owner)
        try await gate.accept(jpeg: jpeg(), generation: generation, capturedAt: time)
        let frame = try await gate.snapshot(generation: generation, owner: owner)
        XCTAssertEqual(frame.width, 2)
        do { _ = try await gate.snapshot(generation: generation, owner: self.owner("other")); XCTFail("Wrong call") } catch {}
        do { _ = try await gate.snapshot(generation: generation, owner: self.owner(host: "https://other.test")); XCTFail("Wrong origin") } catch {}
        time.addTimeInterval(6)
        do { try await gate.accept(jpeg: jpeg(), generation: generation, capturedAt: frame.capturedAt); XCTFail("Delayed old image must not be refreshed by arrival") } catch {}
        do { try await gate.accept(jpeg: jpeg(), generation: generation, capturedAt: time.addingTimeInterval(1)); XCTFail("Future capture timestamp") } catch {}
        do { _ = try await gate.snapshot(generation: generation, owner: owner); XCTFail("Stale frame") } catch {}
    }
    func testStopPauseAndNewConsentRejectLateCaptureCallbacks() async throws {
        let gate = HubScreenFrames(), owner = try owner(), image = try jpeg()
        let first = await gate.beginAfterSystemConsent(owner: owner)
        try await gate.accept(jpeg: image, generation: first, capturedAt: Date())
        await gate.pause(generation: first)
        do { try await gate.accept(jpeg: image, generation: first, capturedAt: Date()); XCTFail("Paused capture") } catch {}
        await gate.resumeAfterSystemConsent(generation: first)
        do { _ = try await gate.snapshot(generation: first, owner: owner); XCTFail("Resume must wait for a fresh frame") } catch {}
        let second = await gate.beginAfterSystemConsent(owner: owner)
        do { try await gate.accept(jpeg: image, generation: first, capturedAt: Date()); XCTFail("Late old callback") } catch {}
        await gate.stop(generation: first) // Must not stop newer consent.
        try await gate.accept(jpeg: image, generation: second, capturedAt: Date())
        await gate.stop(generation: second)
        do { _ = try await gate.snapshot(generation: second, owner: owner); XCTFail("Stopped capture") } catch {}
    }
    func testInvalidOversizeAndExcessiveDimensionsAreRejected() async throws {
        let gate = HubScreenFrames(), owner = try owner()
        let generation = await gate.beginAfterSystemConsent(owner: owner)
        for image in [Data("not a picture".utf8), Data(repeating: 0, count: HubScreenFrames.maximumBytes + 1), try jpeg(width: 1921, height: 1)] {
            do { try await gate.accept(jpeg: image, generation: generation, capturedAt: Date()); XCTFail("Invalid or excessive frame") } catch {}
        }
        do { _ = try await gate.snapshot(generation: generation, owner: owner); XCTFail("Rejected images never become a frame") } catch {}
    }
}
