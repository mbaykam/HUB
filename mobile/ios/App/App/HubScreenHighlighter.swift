import UIKit
import UserNotifications
import HubNative

/// Shows what an assistant marked on the shared screen. iOS does not let an
/// app draw over other apps, so the marked screenshot arrives as a
/// notification that appears over whatever the user is looking at.
@MainActor
final class HubScreenHighlighter {
    static let shared = HubScreenHighlighter()
    private var shown: [String] = []

    func show(_ mark: HubScreenHighlight, on jpeg: Data) async {
        guard !shown.contains(mark.id), let frame = UIImage(data: jpeg) else { return }
        shown.append(mark.id)
        if shown.count > 20 { shown.removeFirst() }
        let image = Self.draw(mark, on: frame)
        let content = UNMutableNotificationContent()
        content.title = "HUB is pointing at your screen"
        content.body = mark.note.isEmpty
            ? (mark.drawable.compactMap(\.label).joined(separator: " · ").nilIfEmpty ?? "Look at the marked area.")
            : mark.note
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        if let data = image.jpegData(compressionQuality: 0.85) {
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("hub-highlights", isDirectory: true)
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent("\(UUID().uuidString).jpg")
            if (try? data.write(to: file, options: .atomic)) != nil,
               let attachment = try? UNNotificationAttachment(identifier: "highlight", url: file, options: nil) {
                content.attachments = [attachment]
            }
        }
        let request = UNNotificationRequest(identifier: "hub.highlight.\(mark.id)", content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }

    /// Dims the frame and outlines each region in the HUB accent with its label.
    static func draw(_ mark: HubScreenHighlight, on frame: UIImage) -> UIImage {
        let size = frame.size
        return UIGraphicsImageRenderer(size: size).image { context in
            frame.draw(in: CGRect(origin: .zero, size: size))
            let boxes = mark.drawable.map {
                CGRect(x: $0.x * size.width, y: $0.y * size.height, width: $0.width * size.width, height: $0.height * size.height)
            }
            let dim = UIBezierPath(rect: CGRect(origin: .zero, size: size))
            for box in boxes { dim.append(UIBezierPath(roundedRect: box.insetBy(dx: -6, dy: -6), cornerRadius: 12)) }
            dim.usesEvenOddFillRule = true
            UIColor.black.withAlphaComponent(0.45).setFill()
            dim.fill()
            let accent = UIColor(red: 0.75, green: 0.80, blue: 1, alpha: 1)
            let line = max(3, size.width / 180)
            for (index, box) in boxes.enumerated() {
                let outline = UIBezierPath(roundedRect: box.insetBy(dx: -6, dy: -6), cornerRadius: 12)
                outline.lineWidth = line
                accent.setStroke()
                outline.stroke()
                guard let label = mark.drawable[index].label, !label.isEmpty else { continue }
                let font = UIFont.systemFont(ofSize: max(22, size.width / 28), weight: .semibold)
                let text = NSAttributedString(string: label, attributes: [.font: font, .foregroundColor: UIColor(red: 0.08, green: 0.1, blue: 0.2, alpha: 1)])
                let textSize = text.size()
                var tag = CGRect(x: box.minX - 6, y: box.minY - textSize.height - 18, width: textSize.width + 20, height: textSize.height + 10)
                if tag.minY < 0 { tag.origin.y = box.maxY + 10 }
                tag.origin.x = min(max(0, tag.origin.x), size.width - tag.width)
                accent.setFill()
                UIBezierPath(roundedRect: tag, cornerRadius: tag.height / 2).fill()
                text.draw(at: CGPoint(x: tag.minX + 10, y: tag.minY + 5))
            }
            _ = context
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
