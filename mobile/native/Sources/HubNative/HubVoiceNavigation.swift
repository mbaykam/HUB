import Foundation

/// A read-only navigation request for a native confirmation, never an audio
/// command or a web-to-native API. UIKit must obtain its own explicit gesture.
public enum HubVoiceNavigation {
    public static func requestsConfirmation(url: URL, source: URL?, server: HubServer, sourceIsMainFrame: Bool, targetIsMainFrame: Bool, isLink: Bool) -> Bool {
        guard sourceIsMainFrame, targetIsMainFrame, isLink, let source,
              server.contains(source), source.path == "/", server.contains(url), url.path == "/", url.fragment == nil,
              let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              query.count == 1, query[0].name == "hubNative", query[0].value == "voice" else { return false }
        return true
    }
}
