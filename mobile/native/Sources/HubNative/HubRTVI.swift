import Foundation

/// SmallWebRTC's standard RTVI data-channel envelope; independent of any model.
public enum HubRTVI {
    /// A final, echo-filtered user transcript may explicitly end this phone's
    /// owned call. Never infer this from assistant speech or quoted examples.
    public static func requestsEnd(_ text: String) -> Bool {
        let value = text.lowercased(with: Locale(identifier: "tr_TR")).trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.count < 140, !value.contains("\""), !value.contains("“"), !value.contains("”"), value.range(of: #"\b(?:sakın|asla|hayır|örnek|mesela|eğer)\b"#, options: .regularExpression) == nil else { return false }
        let command = #"^(?:[\p{L}]{2,20}[, ]+)?(?:lütfen\s+)?(?:(?:sesli\s+)?(?:konuşmayı|görüşmeyi|sohbeti|aramayı)|sesi)\s+(?:kapat|bitir|sonlandır)(?:\s+lütfen)?[.!]?$|^(?:(?:please|can you|could you)\s+)?(?:end|stop|close)\s+(?:(?:the|this|our)\s+)?(?:voice\s+)?(?:call|conversation|chat)(?:\s+please)?[.!?]?$"#
        return value.range(of: command, options: .regularExpression) != nil
    }
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
