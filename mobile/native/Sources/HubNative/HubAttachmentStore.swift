import Foundation
import CryptoKit

public struct HubAttachmentDraft: Codable, Equatable {
    public let id: UUID
    public let requestID: UUID
    public let origin: String
    public let sessionID: String
    public let callID: String
    public let name: String
    public let bytes: Int
    public let sha256: String
}

public enum HubAttachmentError: Error { case invalidFile, tooLarge, full, wrongConversation, invalidResponse, signInRequired, callEnded, unavailable }

/// Private, bounded outbox. IDs and immutable bytes survive response loss;
/// retries cannot substitute a different document or voice conversation.
public actor HubAttachmentStore {
    public static let maximumBytes = 25_000_000
    private let root: URL
    public init(root: URL) throws {
        self.root = root
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let attributes = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard attributes.isDirectory == true, attributes.isSymbolicLink != true else { throw HubAttachmentError.invalidFile }
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var directory = root; try directory.setResourceValues(values)
    }
    private func file(_ id: UUID, _ suffix: String) -> URL { root.appendingPathComponent(id.uuidString.lowercased() + suffix) }
    private func readRegular(_ url: URL, maximum: Int) throws -> Data {
        let attributes = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard attributes.isRegularFile == true, attributes.isSymbolicLink != true else { throw HubAttachmentError.invalidFile }
        guard (attributes.fileSize ?? Int.max) <= maximum else { throw HubAttachmentError.tooLarge }
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        var data = Data()
        while data.count <= maximum {
            let chunk = try handle.read(upToCount: min(65_536, maximum + 1 - data.count)) ?? Data()
            if chunk.isEmpty { break }; data.append(chunk)
        }
        guard !data.isEmpty, data.count <= maximum else { throw HubAttachmentError.tooLarge }
        return data
    }
    public func drafts(server: HubServer, sessionID: String? = nil, callID: String? = nil) throws -> [HubAttachmentDraft] {
        try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }.map { url in
                let value = try JSONDecoder().decode(HubAttachmentDraft.self, from: readRegular(url, maximum: 4096))
                guard file(value.id, ".json") == url, value.bytes > 0, value.bytes <= Self.maximumBytes,
                      HubVoiceAPI.validID(value.sessionID), HubVoiceAPI.validID(value.callID),
                      value.name.utf8.count <= 240 else { throw HubAttachmentError.invalidFile }
                return value
            }.filter { $0.origin == server.origin.absoluteString && (sessionID == nil || $0.sessionID == sessionID) && (callID == nil || $0.callID == callID) }
    }
    public func stage(source: URL, server: HubServer, sessionID: String, callID: String) throws -> HubAttachmentDraft {
        guard HubVoiceAPI.validID(sessionID), HubVoiceAPI.validID(callID) else { throw HubAttachmentError.wrongConversation }
        let existing = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        guard existing.filter({ $0.pathExtension == "bin" }).count < 8 else { throw HubAttachmentError.full }
        let name = source.lastPathComponent
        guard !name.isEmpty, name.utf8.count <= 240, !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw HubAttachmentError.invalidFile }
        let data = try readRegular(source, maximum: Self.maximumBytes)
        let draft = HubAttachmentDraft(id: UUID(), requestID: UUID(), origin: server.origin.absoluteString, sessionID: sessionID, callID: callID, name: name, bytes: data.count, sha256: Self.digest(data))
        var options: Data.WritingOptions = .atomic
        #if os(iOS)
        options.insert(.completeFileProtectionUntilFirstUserAuthentication)
        #endif
        let blob = file(draft.id, ".bin")
        try data.write(to: blob, options: options)
        do { try JSONEncoder().encode(draft).write(to: file(draft.id, ".json"), options: options) }
        catch { try? FileManager.default.removeItem(at: blob); throw error }
        return draft
    }
    public func bytes(_ draft: HubAttachmentDraft, server: HubServer, sessionID: String, callID: String) throws -> Data {
        guard draft.origin == server.origin.absoluteString, draft.sessionID == sessionID, draft.callID == callID else { throw HubAttachmentError.wrongConversation }
        let saved = try JSONDecoder().decode(HubAttachmentDraft.self, from: readRegular(file(draft.id, ".json"), maximum: 4096))
        guard saved == draft else { throw HubAttachmentError.invalidFile }
        let data = try readRegular(file(draft.id, ".bin"), maximum: Self.maximumBytes)
        guard data.count == draft.bytes, Self.digest(data) == draft.sha256 else { throw HubAttachmentError.invalidFile }
        return data
    }
    public func discard(_ draft: HubAttachmentDraft) throws {
        // Only opaque files owned by this outbox; never touch the selected source.
        for suffix in [".json", ".bin"] {
            let url = file(draft.id, suffix)
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        }
    }
    public static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}
