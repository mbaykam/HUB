import SwiftUI
import UIKit
import WebKit

/// An assistant reply, laid out for reading: Markdown in native text, plus two
/// things a chat needs to show rather than tell. Lines that are only images
/// become a swipeable photo strip, and a ```svg block becomes an inline diagram.
/// Equatable so SwiftUI skips re-parsing a message whose text did not change
/// while another reply streams in.
struct HubMarkdownText: View, Equatable {
    let source: String

    enum Segment {
        case markdown(String)
        case gallery([(alt: String, url: URL)])
        case diagram(String)
    }

    var body: some View {
        let segments = Self.segments(source)
        VStack(alignment: .leading, spacing: 14) {
            ForEach(segments.indices, id: \.self) { index in
                switch segments[index] {
                case .markdown(let text): HubMarkdownBlocks(source: text)
                case .gallery(let images): HubImageStrip(images: images)
                case .diagram(let svg): HubInlineDiagram(svg: svg)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private static let imageLine = try! NSRegularExpression(pattern: #"^\s*!\[([^\]]*)\]\((https://[^)\s]+)\)\s*$"#)

    static func segments(_ source: String) -> [Segment] {
        var result: [Segment] = []
        var text: [String] = [], images: [(alt: String, url: URL)] = [], svg: [String]? = nil
        func flushText() { if !text.joined().trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { result.append(.markdown(text.joined(separator: "\n"))) }; text = [] }
        func flushImages() { if !images.isEmpty { result.append(.gallery(images)); images = [] } }
        for line in source.components(separatedBy: "\n") {
            if var open = svg {
                if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    result.append(.diagram(open.joined(separator: "\n"))); svg = nil
                } else { open.append(line); svg = open }
                continue
            }
            let trimmed = line.trimmingCharacters(in: .whitespaces).lowercased()
            if trimmed == "```svg" || trimmed == "```diagram" {
                flushImages(); flushText(); svg = []; continue
            }
            let range = NSRange(line.startIndex..., in: line)
            if let match = imageLine.firstMatch(in: line, range: range),
               let altRange = Range(match.range(at: 1), in: line), let urlRange = Range(match.range(at: 2), in: line),
               let url = URL(string: String(line[urlRange])), url.host != nil {
                flushText(); images.append((String(line[altRange]), url)); continue
            }
            if !images.isEmpty && trimmed.isEmpty { continue }
            flushImages(); text.append(line)
        }
        if let open = svg { text.append("```svg"); text.append(contentsOf: open) }
        flushImages(); flushText()
        return result
    }
}

/// Uses Foundation's Markdown structure while keeping assistant content in native views.
struct HubMarkdownBlocks: View {
    let source: String

    private struct Block {
        let intent: PresentationIntent?
        var text: AttributedString
    }

    var body: some View {
        let blocks = Self.blocks(source)
        let sections = Self.sections(blocks)
        VStack(alignment: .leading, spacing: 12) {
            ForEach(sections.indices, id: \.self) { index in
                let section = sections[index]
                if let first = section.first {
                    if Self.tableID(first) != nil { table(section) }
                    else { block(first) }
                }
            }
        }
        .lineSpacing(3.5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    private static func blocks(_ text: String) -> [Block] {
        guard let parsed = try? AttributedString(markdown: text), !parsed.characters.isEmpty else {
            return [Block(intent: nil, text: AttributedString(text))]
        }
        var blocks: [Block] = []
        for run in parsed.runs {
            var part = AttributedString(parsed[run.range])
            if let url = run.link {
                if !["http", "https"].contains(url.scheme?.lowercased() ?? "") || url.host == nil || url.user != nil || url.password != nil {
                    part.link = nil
                } else {
                    // A bare URL reads as its site name, like a source chip.
                    let shown = String(part.characters)
                    if shown.hasPrefix("http"), let host = url.host {
                        part = AttributedString(host.replacingOccurrences(of: "www.", with: "") + " ↗")
                        part.link = url
                    }
                    part.foregroundColor = HubWorkspacePalette.accent
                }
            }
            let intent = run.presentationIntent
            part.presentationIntent = nil
            if blocks.last?.intent == intent, let index = blocks.indices.last {
                blocks[index].text.append(part)
            } else {
                blocks.append(Block(intent: intent, text: part))
            }
        }
        return blocks
    }

    private static func sections(_ blocks: [Block]) -> [[Block]] {
        var result: [[Block]] = []
        for block in blocks {
            if let table = tableID(block), let lastIndex = result.indices.last,
               let preceding = result[lastIndex].first, tableID(preceding) == table {
                result[lastIndex].append(block)
            } else {
                result.append([block])
            }
        }
        return result
    }

    private static func tableID(_ block: Block) -> Int? {
        block.intent?.components.first {
            if case .table = $0.kind { return true }
            return false
        }?.identity
    }

    @ViewBuilder private func block(_ block: Block) -> some View {
        let kinds = block.intent?.components.map(\.kind) ?? []
        if case .codeBlock(let language)? = kinds.first {
            code(block.text, language: language)
        } else if case .header(let level)? = kinds.first {
            Text(block.text).font(level <= 2 ? .title3.weight(.bold) : .headline)
                .padding(.top, 6)
                .accessibilityAddTraits(.isHeader)
        } else if case .thematicBreak? = kinds.first {
            Divider().padding(.vertical, 4)
        } else if kinds.contains(.blockQuote) {
            Text(block.text)
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Capsule().fill(HubWorkspacePalette.accent.opacity(0.7)).frame(width: 2.5) }
        } else if let index = kinds.firstIndex(where: { if case .listItem = $0 { return true }; return false }),
                  case .listItem(let ordinal) = kinds[index] {
            let list = kinds.dropFirst(index + 1).first
            let depth = kinds.filter { $0 == .orderedList || $0 == .unorderedList }.count
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(list == .orderedList ? "\(ordinal)." : "•")
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .frame(minWidth: list == .orderedList ? 20 : 10, alignment: .trailing)
                Text(block.text)
            }
            .padding(.leading, CGFloat(max(0, depth - 1)) * 18)
        } else {
            Text(block.text)
        }
    }

    /// A short one-off line (a formula, a command) sits in a quiet card and
    /// wraps; longer code keeps its lines and scrolls sideways.
    @ViewBuilder private func code(_ text: AttributedString, language: String?) -> some View {
        let plain = String(text.characters).trimmingCharacters(in: .newlines)
        let short = !plain.contains("\n") && plain.count <= 120
        ZStack(alignment: .topTrailing) {
            Group {
                if short {
                    Text(plain).font(.system(.callout, design: .monospaced)).fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.trailing, 30)
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        if let language, !language.isEmpty {
                            Text(language).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                        }
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(plain).font(.system(.footnote, design: .monospaced)).fixedSize(horizontal: true, vertical: false)
                        }
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            Button {
                UIPasteboard.general.string = plain
            } label: {
                Image(systemName: "doc.on.doc").font(.caption).foregroundStyle(.secondary).frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Copy code")
        }
        .background(HubWorkspacePalette.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(HubWorkspacePalette.border.opacity(0.08)))
    }

    /// A clean table: small header row, hairlines between rows, the first
    /// column in bold, columns sized to their content; wide tables scroll.
    private func table(_ cells: [Block]) -> some View {
        var rows: [[Block]] = []
        var current: Int?
        for cell in cells {
            let row = cell.intent?.components.first {
                switch $0.kind {
                case .tableHeaderRow, .tableRow: return true
                default: return false
                }
            }?.identity
            if current != row || rows.isEmpty { rows.append([]); current = row }
            if let index = rows.indices.last { rows[index].append(cell) }
        }
        let columns = rows.map(\.count).max() ?? 0
        let widths: [CGFloat] = (0..<columns).map { column in
            let longest = rows.compactMap { $0.indices.contains(column) ? $0[column].text.characters.count : nil }.max() ?? 8
            return min(220, max(90, CGFloat(longest) * 7.5))
        }
        return ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(rows.indices, id: \.self) { row in
                    HStack(alignment: .top, spacing: 0) {
                        ForEach(rows[row].indices, id: \.self) { index in
                            Group {
                                if row == 0 {
                                    Text(String(rows[row][index].text.characters).uppercased())
                                        .font(.caption2.weight(.semibold)).tracking(0.5).foregroundStyle(.secondary)
                                } else {
                                    Text(rows[row][index].text).font(.subheadline)
                                        .fontWeight(index == 0 ? .semibold : .regular)
                                }
                            }
                            .frame(width: index < widths.count ? widths[index] : 120, alignment: .leading)
                            .padding(.horizontal, 12)
                            .padding(.vertical, row == 0 ? 9 : 11)
                        }
                    }
                    .background(row == 0 ? HubWorkspacePalette.panel : Color.clear)
                    if row < rows.count - 1 { Divider().opacity(0.6) }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(HubWorkspacePalette.border.opacity(0.12)))
        }
    }
}

/// Photos the assistant found, in a strip you swipe through. Tapping one
/// opens its page in Safari.
struct HubImageStrip: View {
    let images: [(alt: String, url: URL)]
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(images.indices, id: \.self) { index in
                    let image = images[index]
                    VStack(alignment: .leading, spacing: 6) {
                        AsyncImage(url: image.url) { phase in
                            switch phase {
                            case .success(let picture): picture.resizable().scaledToFill()
                            case .failure: Image(systemName: "photo").font(.title2).foregroundStyle(.secondary)
                            default: ProgressView()
                            }
                        }
                        .frame(width: images.count == 1 ? 300 : 240, height: images.count == 1 ? 225 : 180)
                        .background(HubWorkspacePalette.panel)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .onTapGesture { openURL(image.url) }
                        if !image.alt.isEmpty {
                            Text(image.alt).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                .frame(width: images.count == 1 ? 300 : 240, alignment: .leading)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(image.alt.isEmpty ? "Photo" : image.alt)
                    .accessibilityAddTraits(.isImage)
                }
            }
        }
        .accessibilityIdentifier("hub.chat.imageStrip")
    }
}

/// A diagram the assistant drew as SVG, shown inline at its own proportions.
/// It is a picture only: scripts, links and outside resources are blocked.
struct HubInlineDiagram: View {
    let svg: String

    private var aspect: CGFloat {
        let pattern = try? NSRegularExpression(pattern: #"viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)"#)
        if let match = pattern?.firstMatch(in: svg, range: NSRange(svg.startIndex..., in: svg)),
           let w = Range(match.range(at: 1), in: svg).flatMap({ Double(svg[$0]) }),
           let h = Range(match.range(at: 2), in: svg).flatMap({ Double(svg[$0]) }), w > 0, h > 0 {
            return CGFloat(max(0.4, min(3, w / h)))
        }
        return 1.6
    }

    var body: some View {
        HubSVGView(svg: svg)
            .aspectRatio(aspect, contentMode: .fit)
            .frame(maxWidth: .infinity)
            .padding(12)
            .background(HubWorkspacePalette.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(HubWorkspacePalette.border.opacity(0.08)))
            .accessibilityLabel("Diagram")
            .accessibilityIdentifier("hub.chat.diagram")
    }
}

private struct HubSVGView: UIViewRepresentable {
    let svg: String

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.loaded != svg else { return }
        context.coordinator.loaded = svg
        let html = """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'">
        <style>html,body{margin:0;background:transparent;height:100%;color:#eceef3;font-family:-apple-system,system-ui}svg{width:100%;height:100%;display:block}</style>
        </head><body>\(svg)</body></html>
        """
        view.loadHTMLString(html, baseURL: nil)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var loaded: String? }
}
