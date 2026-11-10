import Foundation
import XCTest
import Darwin
@testable import HubNative

final class HubShareInboxTests: XCTestCase {
    private func root() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("hub-eval-share-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true); return url
    }
    func testAtomicInboxReopensAndExplicitBindingIsReplaySafe() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appendingPathComponent("inbox"), bytes = Data("isolated fixture".utf8)
        let inbox = try HubShareInbox(root: folder)
        let shared = try await inbox.save(bytes, name: "Türkçe note.txt")
        let reopened = try HubShareInbox(root: folder)
        let list = try await reopened.list(); XCTAssertEqual(list, [shared])
        let content = try await reopened.bytes(shared); XCTAssertEqual(content, bytes)
        let disk = try Data(contentsOf: folder.appendingPathComponent(shared.id.uuidString.lowercased() + ".share"))
        XCTAssertFalse(String(decoding: disk, as: UTF8.self).contains("origin")); XCTAssertFalse(String(decoding: disk, as: UTF8.self).contains("cookie"))
        let server = try HubServer(address: "https://hub.example.com"), privateStore = try HubAttachmentStore(root: root.appendingPathComponent("private"))
        let first = try await privateStore.stage(data: content, name: shared.name, server: server, sessionID: "chat", callID: "call", id: shared.id, requestID: shared.id)
        let retry = try await privateStore.stage(data: content, name: shared.name, server: server, sessionID: "chat", callID: "call", id: shared.id, requestID: shared.id)
        XCTAssertEqual(first, retry)
        do { _ = try await privateStore.stage(data: content, name: shared.name, server: server, sessionID: "other", callID: "call", id: shared.id, requestID: shared.id); XCTFail("Cannot silently retarget a transfer") } catch {}
        try await reopened.remove(shared)
        let remaining = try await reopened.list(); XCTAssertTrue(remaining.isEmpty)
        let retained = try await privateStore.bytes(first, server: server, sessionID: "chat", callID: "call"); XCTAssertEqual(retained, bytes)
    }
    func testTwoInstancesRespectTheSameCapacityAndLock() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let one = try HubShareInbox(root: root), two = try HubShareInbox(root: root)
        let descriptor = Darwin.open(root.appendingPathComponent(".lock").path, O_CREAT | O_RDWR, 0o600)
        XCTAssertGreaterThanOrEqual(descriptor, 0)
        XCTAssertEqual(flock(descriptor, LOCK_EX | LOCK_NB), 0)
        do { _ = try await two.save(Data([1]), name: "blocked.bin"); XCTFail("Cross-instance lock must prevent overlapping commit") } catch {}
        flock(descriptor, LOCK_UN); Darwin.close(descriptor)
        var last: HubSharedFile?
        for i in 0..<8 { last = try await (i % 2 == 0 ? one : two).save(Data([UInt8(i)]), name: "fixture.bin") }
        do { _ = try await two.save(Data([9]), name: "ninth.bin"); XCTFail("Shared capacity") } catch { guard case HubAttachmentError.full = error else { return XCTFail("Wrong error") } }
        try await one.remove(XCTUnwrap(last))
        _ = try await two.save(Data([9]), name: "replacement.bin")
        let list = try await one.list(); XCTAssertEqual(list.count, 8)
    }
    func testMalformedUntrustedCopiesAndSymlinksFailClosed() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let inbox = try HubShareInbox(root: root)
        do { _ = try await inbox.save(Data([1]), name: "../secret"); XCTFail("Traversal name") } catch {}
        do { _ = try await inbox.save(Data(), name: "empty.bin"); XCTFail("Empty data") } catch {}
        let saved = try await inbox.save(Data("original".utf8), name: "file.txt")
        let path = root.appendingPathComponent(saved.id.uuidString.lowercased() + ".share")
        try Data([255,255,255,255,0]).write(to: path)
        do { _ = try await inbox.bytes(saved); XCTFail("Corrupt size header") } catch {}
        try FileManager.default.removeItem(at: path)
        let source = root.appendingPathComponent("source.txt"); try Data("preserved".utf8).write(to: source)
        try FileManager.default.createSymbolicLink(at: path, withDestinationURL: source)
        do { _ = try await inbox.bytes(saved); XCTFail("Symlink escape") } catch {}
        XCTAssertEqual(try Data(contentsOf: source), Data("preserved".utf8))
    }
}
