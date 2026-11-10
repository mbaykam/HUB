import Foundation
import Darwin

public struct HubSharedFile: Codable, Equatable {
    public let version: Int
    public let id: UUID
    public let name: String
    public let bytes: Int
    public let sha256: String
}

/// Unbound user-selected copies only: no origin, session, cookies or model keys.
/// Single-file atomic commits and an OS lock work across app/extension processes.
public actor HubShareInbox {
    public static let group = "group.com.mbaykam.hub"
    public static let maximumBytes = 10_000_000
    private let root: URL
    public static func appGroupInbox() throws -> HubShareInbox {
        guard let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { throw HubAttachmentError.unavailable }
        return try HubShareInbox(root: base.appendingPathComponent("SharedFiles", isDirectory: true))
    }
    public init(root: URL) throws {
        self.root = root
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let attributes = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard attributes.isDirectory == true, attributes.isSymbolicLink != true else { throw HubAttachmentError.invalidFile }
        var directory = root, values = URLResourceValues(); values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
    }
    private func locked<T>(_ action: () throws -> T) throws -> T {
        let descriptor = Darwin.open(root.appendingPathComponent(".lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw HubAttachmentError.unavailable }
        defer { Darwin.close(descriptor) }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { throw HubAttachmentError.unavailable }
        defer { flock(descriptor, LOCK_UN) }
        return try action()
    }
    private func file(_ id: UUID) -> URL { root.appendingPathComponent(id.uuidString.lowercased() + ".share") }
    public static func readSelectedFile(_ url: URL) throws -> Data {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else { throw HubAttachmentError.invalidFile }
        guard (values.fileSize ?? Int.max) <= maximumBytes else { throw HubAttachmentError.tooLarge }
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        var bytes = Data()
        while bytes.count <= maximumBytes {
            let part = try handle.read(upToCount: min(65_536, maximumBytes + 1 - bytes.count)) ?? Data()
            if part.isEmpty { break }; bytes.append(part)
        }
        guard !bytes.isEmpty, bytes.count <= maximumBytes else { throw HubAttachmentError.tooLarge }
        return bytes
    }
    private func decode(_ url: URL) throws -> (HubSharedFile, Data) {
        let info = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard info.isRegularFile == true, info.isSymbolicLink != true,
              (info.fileSize ?? Int.max) <= Self.maximumBytes + 4100 else { throw HubAttachmentError.invalidFile }
        let value = try Data(contentsOf: url)
        guard value.count >= 5, value.count <= Self.maximumBytes + 4100 else { throw HubAttachmentError.invalidFile }
        let count = value.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
        guard count > 0, count <= 4096, count + 4 < value.count else { throw HubAttachmentError.invalidFile }
        let item = try JSONDecoder().decode(HubSharedFile.self, from: value.subdata(in: 4..<(count + 4)))
        let bytes = value.subdata(in: (count + 4)..<value.count)
        guard item.version == 1, url.lastPathComponent == item.id.uuidString.lowercased() + ".share",
              Self.validName(item.name), item.bytes == bytes.count, bytes.count <= Self.maximumBytes,
              item.sha256 == HubAttachmentStore.digest(bytes) else { throw HubAttachmentError.invalidFile }
        return (item, bytes)
    }
    private static func validName(_ name: String) -> Bool {
        !name.isEmpty && name.utf8.count <= 240 && !name.contains("/") && !name.contains("\\") && !name.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }
    private func entries() throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).filter { $0.pathExtension == "share" }
    }
    public func list() throws -> [HubSharedFile] { try locked { try entries().map { try decode($0).0 } } }
    public func save(_ bytes: Data, name: String) throws -> HubSharedFile {
        try locked {
            guard !bytes.isEmpty, bytes.count <= Self.maximumBytes else { throw HubAttachmentError.tooLarge }
            guard Self.validName(name) else { throw HubAttachmentError.invalidFile }
            guard try entries().count < 8 else { throw HubAttachmentError.full }
            let item = HubSharedFile(version: 1, id: UUID(), name: name, bytes: bytes.count, sha256: HubAttachmentStore.digest(bytes))
            let header = try JSONEncoder().encode(item)
            var length = UInt32(header.count).bigEndian
            var data = withUnsafeBytes(of: &length) { Data($0) }; data.append(header); data.append(bytes)
            var options: Data.WritingOptions = .atomic
            #if os(iOS)
            options.insert(.completeFileProtectionUntilFirstUserAuthentication)
            #endif
            try data.write(to: file(item.id), options: options)
            return item
        }
    }
    public func bytes(_ item: HubSharedFile) throws -> Data {
        try locked { let (saved, bytes) = try decode(file(item.id)); guard saved == item else { throw HubAttachmentError.invalidFile }; return bytes }
    }
    public func remove(_ item: HubSharedFile) throws {
        try locked { let (saved, _) = try decode(file(item.id)); guard saved == item else { throw HubAttachmentError.invalidFile }; try FileManager.default.removeItem(at: file(item.id)) }
    }
}
