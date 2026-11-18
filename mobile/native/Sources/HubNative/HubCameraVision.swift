import Foundation

/// Things the phone recognised on a camera frame, numbered as drawn on it.
/// Coordinates are fractions of the frame, top-left origin.
public struct HubVisionScene: Equatable, Sendable {
    public struct Mark: Codable, Equatable, Sendable {
        public let id: Int
        public let label: String?
        public let text: String?
        public let x: Double
        public let y: Double
        public let width: Double
        public let height: Double

        public init(id: Int, label: String?, text: String?, x: Double, y: Double, width: Double, height: Double) {
            self.id = id; self.label = label; self.text = text
            self.x = x; self.y = y; self.width = width; self.height = height
        }
    }

    public var marks: [Mark]

    public init(marks: [Mark]) { self.marks = marks }

    /// Base64url JSON for the `x-hub-screen-scene` header, trimmed to stay
    /// well inside header limits: at most 20 marks and short strings.
    public var headerValue: String {
        let trimmed = marks.prefix(20).map { mark in
            Mark(id: mark.id, label: mark.label.map { String($0.prefix(40)) }, text: mark.text.map { String($0.prefix(80)) },
                 x: Self.clamp(mark.x), y: Self.clamp(mark.y), width: Self.clamp(mark.width), height: Self.clamp(mark.height))
        }
        struct Payload: Encodable { let marks: [Mark] }
        let data = (try? JSONEncoder().encode(Payload(marks: trimmed))) ?? Data("{\"marks\":[]}".utf8)
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func clamp(_ value: Double) -> Double {
        guard value.isFinite else { return 0 }
        return (min(1, max(0, value)) * 1000).rounded() / 1000
    }
}

/// Overlays an assistant pinned into the live camera view. A point or box is
/// a fraction of the frame with `sequence`; a mark follows the recognised thing.
public struct HubCameraOverlay: Decodable, Equatable, Sendable {
    public enum Style: String, Decodable, Sendable { case arrow, circle, box, label, step }

    public struct Item: Decodable, Equatable, Sendable {
        public let mark: Int?
        public let x: Double?
        public let y: Double?
        public let width: Double?
        public let height: Double?
        public let style: Style
        public let label: String?
        public let step: Int?

        public init(mark: Int? = nil, x: Double? = nil, y: Double? = nil, width: Double? = nil, height: Double? = nil,
                    style: Style, label: String? = nil, step: Int? = nil) {
            self.mark = mark; self.x = x; self.y = y; self.width = width; self.height = height
            self.style = style; self.label = label; self.step = step
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            mark = try container.decodeIfPresent(Int.self, forKey: .mark)
            x = try container.decodeIfPresent(Double.self, forKey: .x)
            y = try container.decodeIfPresent(Double.self, forKey: .y)
            width = try container.decodeIfPresent(Double.self, forKey: .width)
            height = try container.decodeIfPresent(Double.self, forKey: .height)
            // An unknown future style still shows, as a ring.
            style = (try? container.decode(Style.self, forKey: .style)) ?? .circle
            label = try container.decodeIfPresent(String.self, forKey: .label)
            step = try container.decodeIfPresent(Int.self, forKey: .step)
        }

        private enum CodingKeys: String, CodingKey { case mark, x, y, width, height, style, label, step }

        /// A mark, or a point inside the frame; anything else is not drawn.
        public var isDrawable: Bool {
            if let mark { return (1...99).contains(mark) }
            guard let x, let y, (0...1).contains(x), (0...1).contains(y) else { return false }
            if width == nil && height == nil { return true }
            guard let width, let height else { return false }
            return width > 0 && height > 0 && x + width <= 1.0001 && y + height <= 1.0001
        }
    }

    public let id: String
    public let items: [Item]
    public let note: String
    public let sequence: Int
    public let clear: Bool

    public var drawable: [Item] { Array(items.prefix(8).filter(\.isDrawable)) }
}
