import Foundation

/// Fixed navigation from an explicit main-page user tap into native voice.
/// No payload, subframe, redirect or programmatic navigation may request it.
public enum HubVoiceNavigation {
    public static func requestsVoice(url: URL, source: URL?, server: HubServer, sourceIsMainFrame: Bool, targetIsMainFrame: Bool, isLink: Bool) -> Bool {
        requestsPanel("voice", url: url, source: source, server: server, sourceIsMainFrame: sourceIsMainFrame, targetIsMainFrame: targetIsMainFrame, isLink: isLink)
    }
    public static func requestsOptions(url: URL, source: URL?, server: HubServer, sourceIsMainFrame: Bool, targetIsMainFrame: Bool, isLink: Bool) -> Bool {
        requestsPanel("options", url: url, source: source, server: server, sourceIsMainFrame: sourceIsMainFrame, targetIsMainFrame: targetIsMainFrame, isLink: isLink)
    }
    private static func requestsPanel(_ panel: String, url: URL, source: URL?, server: HubServer, sourceIsMainFrame: Bool, targetIsMainFrame: Bool, isLink: Bool) -> Bool {
        guard sourceIsMainFrame, targetIsMainFrame, isLink, let source,
              server.contains(source), source.path == "/", server.contains(url), url.path == "/", url.fragment == nil,
              let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              query.count == 1, query[0].name == "hubNative", query[0].value == panel else { return false }
        return true
    }
}
