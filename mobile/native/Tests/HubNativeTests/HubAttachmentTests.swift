import Foundation
import XCTest
@testable import HubNative

private final class AttachmentFixture: URLProtocol {
    static var requests: [URLRequest] = []
    static var reply = ""
    static var code = 200
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.code, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.reply.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
final class HubAttachmentTests: XCTestCase {
    func testInterruptedPreparationIsVisibleAndExplicitRemovalRestoresBoundedCapacity() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("original.txt"), original = Data("preserved fixture".utf8)
        try original.write(to: source)
        let folder = root.appendingPathComponent("outbox"), server = try HubServer(address: "https://hub.example.com")
        let first = try HubAttachmentStore(root: folder)
        var values: [HubAttachmentDraft] = []
        for _ in 0..<8 { values.append(try await first.stage(source: source, server: server, sessionID: "chat", callID: "call")) }
        let lost = try XCTUnwrap(values.first)
        // Simulate process loss after payload write but before its manifest.
        try FileManager.default.removeItem(at: folder.appendingPathComponent(lost.id.uuidString.lowercased() + ".json"))
        let reopened = try HubAttachmentStore(root: folder)
        let visible = try await reopened.drafts(server: server)
        XCTAssertEqual(visible.count, 7)
        do { _ = try await reopened.stage(source: source, server: server, sessionID: "chat", callID: "call"); XCTFail("No automatic deletion or capacity bypass") }
        catch { guard case HubAttachmentError.full = error else { return XCTFail("Wrong capacity error") } }
        let incomplete = try await reopened.incompleteCopies()
        XCTAssertEqual(incomplete, [lost.id])
        do { try await reopened.discardIncompleteCopy(values[1].id); XCTFail("Cannot remove a complete draft through orphan cleanup") } catch {}
        try await reopened.discardIncompleteCopy(lost.id)
        _ = try await reopened.stage(source: source, server: server, sessionID: "chat", callID: "call")
        let restored = try await reopened.drafts(server: server)
        XCTAssertEqual(restored.count, 8)
        XCTAssertEqual(try Data(contentsOf: source), original)
    }
    private func root() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("hub-eval-attachments-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true); return url
    }
    func testRestartPreservesExactBytesReceiptAndConversation() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("Türkçe sample.txt"), bytes = Data("Isolated fixture".utf8)
        try bytes.write(to: source)
        let server = try HubServer(address: "https://hub.example.com"), folder = root.appendingPathComponent("outbox")
        let store = try HubAttachmentStore(root: folder)
        let draft = try await store.stage(source: source, server: server, sessionID: "conversation-1", callID: "call-1")
        let restored = try HubAttachmentStore(root: folder)
        let list = try await restored.drafts(server: server, sessionID: "conversation-1", callID: "call-1")
        XCTAssertEqual(list, [draft])
        let content = try await restored.bytes(draft, server: server, sessionID: "conversation-1", callID: "call-1")
        XCTAssertEqual(content, bytes)
        do { _ = try await restored.bytes(draft, server: server, sessionID: "other-chat", callID: "call-1"); XCTFail("Wrong owner") } catch {}
        do { _ = try await restored.bytes(draft, server: try HubServer(address: "https://other.test"), sessionID: "conversation-1", callID: "call-1"); XCTFail("Wrong origin") } catch {}
        try await restored.discard(draft)
        XCTAssertEqual(try Data(contentsOf: source), bytes, "Removing a draft never changes selected original")
    }
    func testOutboxRejectsEmptySymlinkOversizeAndModifiedPayload() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let server = try HubServer(address: "https://hub.test"), store = try HubAttachmentStore(root: root.appendingPathComponent("outbox"))
        let source = root.appendingPathComponent("fixture.txt"); try Data().write(to: source)
        do { _ = try await store.stage(source: source, server: server, sessionID: "chat", callID: "call"); XCTFail("Empty file") } catch {}
        try Data("original".utf8).write(to: source)
        let link = root.appendingPathComponent("link.txt"); try FileManager.default.createSymbolicLink(at: link, withDestinationURL: source)
        do { _ = try await store.stage(source: link, server: server, sessionID: "chat", callID: "call"); XCTFail("Symbolic link") } catch {}
        let draft = try await store.stage(source: source, server: server, sessionID: "chat", callID: "call")
        try Data("modified".utf8).write(to: root.appendingPathComponent("outbox/" + draft.id.uuidString.lowercased() + ".bin"))
        do { _ = try await store.bytes(draft, server: server, sessionID: "chat", callID: "call"); XCTFail("Changed bytes") } catch {}
        let large = root.appendingPathComponent("large.bin"); FileManager.default.createFile(atPath: large.path, contents: nil)
        let handle = try FileHandle(forWritingTo: large); try handle.truncate(atOffset: UInt64(HubAttachmentStore.maximumBytes + 1)); try handle.close()
        do { _ = try await store.stage(source: large, server: server, sessionID: "chat", callID: "call"); XCTFail("Oversize file") } catch {}
    }
    func testNativeUploadAndLostVoiceReceiptRetryKeepStableIdentifiers() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("Türkçe file.txt"), data = Data("fixture".utf8); try data.write(to: source)
        let server = try HubServer(address: "https://hub.example.com"), store = try HubAttachmentStore(root: root.appendingPathComponent("outbox"))
        let draft = try await store.stage(source: source, server: server, sessionID: "chat", callID: "call")
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [AttachmentFixture.self]
        let cookie = HTTPCookie(properties: [.name:"session",.value:"fixture",.domain:"hub.example.com",.path:"/"])!
        let uploader = HubAttachmentAPI(server: server, configuration: config) { [cookie] }
        AttachmentFixture.requests = []; AttachmentFixture.code = 200
        AttachmentFixture.reply = "{\"id\":\"\(draft.id.uuidString)\",\"name\":\"fixture\",\"bytes\":7}"
        try await uploader.upload(draft, bytes: data); try await uploader.upload(draft, bytes: data)
        XCTAssertEqual(AttachmentFixture.requests.map { $0.value(forHTTPHeaderField: "x-hub-upload-id") }, Array(repeating: draft.id.uuidString.lowercased(), count: 2))
        let request = try XCTUnwrap(AttachmentFixture.requests.first)
        XCTAssertEqual(request.url?.absoluteString, "https://hub.example.com/api/hub/uploads")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "session=fixture")
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-hub-file-name")?.removingPercentEncoding, draft.name)
        AttachmentFixture.reply = #"{"accepted":true}"#
        let voice = HubVoiceAPI(server: server, configuration: config) { [cookie] }; defer { voice.invalidate() }
        try await voice.share(callId: "call", uploadID: draft.id, requestID: draft.requestID)
        let shared = try XCTUnwrap(AttachmentFixture.requests.last)
        XCTAssertEqual(shared.url?.path, "/api/hub/voice/share")
        XCTAssertEqual(shared.value(forHTTPHeaderField: "x-hub-voice-share"), "1")
        let count = AttachmentFixture.requests.count
        do { try await uploader.upload(draft, bytes: Data("changed".utf8)); XCTFail("Changed upload") } catch {}
        XCTAssertEqual(AttachmentFixture.requests.count, count)
        AttachmentFixture.code = 401
        do { try await uploader.upload(draft, bytes: data); XCTFail("Auth failure") } catch { guard case HubAttachmentError.signInRequired = error else { return XCTFail("Wrong auth error") } }
    }
}
