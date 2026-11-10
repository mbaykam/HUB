import Foundation

/// Uploading retains an original on HUB, but does not ask a model to process it.
/// The caller must separately confirm the owned voice share with a stable receipt.
public final class HubAttachmentAPI {
    private let server: HubServer
    private let cookies: () async -> [HTTPCookie]
    private let session: URLSession
    private struct Receipt: Decodable { let id: UUID; let name: String; let bytes: Int }
    public init(server: HubServer, configuration: URLSessionConfiguration = .ephemeral, cookies: @escaping () async -> [HTTPCookie]) {
        self.server = server; self.cookies = cookies
        let config = configuration.copy() as! URLSessionConfiguration
        config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCache = nil
        config.timeoutIntervalForRequest = 60; config.timeoutIntervalForResource = 120
        session = URLSession(configuration: config, delegate: HubNoRedirects(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    public func upload(_ draft: HubAttachmentDraft, bytes: Data) async throws {
        guard draft.origin == server.origin.absoluteString, HubVoiceAPI.validID(draft.sessionID),
              draft.bytes == bytes.count, bytes.count > 0, bytes.count <= HubAttachmentStore.maximumBytes,
              draft.sha256 == HubAttachmentStore.digest(bytes), !draft.name.isEmpty,
              draft.name.utf8.count <= 240 else { throw HubAttachmentError.invalidFile }
        let url = server.origin.appendingPathComponent("api/hub/uploads")
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = "POST"
        request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: server.cookies(await cookies(), for: url))
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(String(server.origin.absoluteString.dropLast()), forHTTPHeaderField: "Origin")
        request.setValue("1", forHTTPHeaderField: "x-hub-upload")
        request.setValue(draft.id.uuidString.lowercased(), forHTTPHeaderField: "x-hub-upload-id")
        request.setValue(draft.sessionID, forHTTPHeaderField: "x-hub-session")
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        request.setValue(draft.name.addingPercentEncoding(withAllowedCharacters: allowed), forHTTPHeaderField: "x-hub-file-name")
        try Task.checkCancellation()
        let (data, response) = try await session.upload(for: request, from: bytes)
        guard let response = response as? HTTPURLResponse else { throw HubAttachmentError.invalidResponse }
        switch response.statusCode {
        case 200: break
        case 300...399, 401, 403: throw HubAttachmentError.signInRequired
        case 404, 410: throw HubAttachmentError.callEnded
        case 413: throw HubAttachmentError.tooLarge
        default: throw HubAttachmentError.unavailable
        }
        guard response.mimeType == "application/json", data.count <= 262_144 else { throw HubAttachmentError.invalidResponse }
        let receipt = try JSONDecoder().decode(Receipt.self, from: data)
        guard receipt.id == draft.id, receipt.bytes == draft.bytes else { throw HubAttachmentError.invalidResponse }
    }
}
