import Foundation

/// SmallWebRTC's standard RTVI data-channel envelope; independent of any model.
public enum HubRTVI {
    public static func ready() throws -> Data {
        try JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "label": "rtvi-ai", "type": "client-ready", "data": ["version": "2.0.0", "about": ["library": "hub-ios", "library_version": "0.1.0"]]])
    }
    public static func event(_ data: Data) -> (type: String, text: String?, final: Bool, fatal: Bool?)? {
        guard data.count <= 262_144,
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              object["label"] as? String == "rtvi-ai", let type = object["type"] as? String else { return nil }
        let payload = object["data"] as? [String: Any]
        return (type, payload?["text"] as? String, payload?["final"] as? Bool ?? true, payload?["fatal"] as? Bool)
    }
}
