import SwiftUI
import UIKit

/// Uses Foundation's Markdown structure while keeping assistant content in native views.
struct HubMarkdownText: View {
    let source: String

    private struct Block {
        let intent: PresentationIntent?
        var text: AttributedString
    }

    var body: some View {
        let blocks = Self.blocks(source)
        let sections = Self.sections(blocks)
        VStack(alignment: .leading, spacing: 9) {
            ForEach(sections.indices, id: \.self) { index in
                let section = sections[index]
                if let first = section.first {
                    if Self.tableID(first) != nil { table(section) }
                    else { block(first) }
                }
            }
        }
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
            if let url = run.link, !["http", "https"].contains(url.scheme?.lowercased() ?? "") ||
                url.host == nil || url.user != nil || url.password != nil {
                part.link = nil
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
            Text(block.text).font(level <= 2 ? .title3.weight(.semibold) : .headline)
                .accessibilityAddTraits(.isHeader)
        } else if case .thematicBreak? = kinds.first {
            Divider()
        } else if kinds.contains(.blockQuote) {
            Text(block.text)
                .padding(.leading, 11)
                .overlay(alignment: .leading) { Capsule().fill(HubWorkspacePalette.accent.opacity(0.55)).frame(width: 3) }
        } else if let index = kinds.firstIndex(where: { if case .listItem = $0 { return true }; return false }),
                  case .listItem(let ordinal) = kinds[index] {
            let list = kinds.dropFirst(index + 1).first
            let depth = kinds.filter { $0 == .orderedList || $0 == .unorderedList }.count
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(list == .orderedList ? "\(ordinal)." : "•").foregroundStyle(.secondary)
                Text(block.text)
            }
            .padding(.leading, CGFloat(max(0, depth - 1)) * 12)
        } else {
            Text(block.text)
        }
    }

    private func code(_ text: AttributedString, language: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                if let language, !language.isEmpty { Text(language).font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Button {
                    UIPasteboard.general.string = String(text.characters)
                } label: {
                    Image(systemName: "doc.on.doc").frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy code")
            }
            ScrollView(.horizontal) {
                Text(text).font(.system(.subheadline, design: .monospaced)).fixedSize(horizontal: true, vertical: false)
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 9)
        .background(HubWorkspacePalette.panel, in: RoundedRectangle(cornerRadius: 10))
    }

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
        return ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(rows.indices, id: \.self) { row in
                    HStack(alignment: .top, spacing: 0) {
                        ForEach(rows[row].indices, id: \.self) { index in
                            Text(rows[row][index].text)
                                .fontWeight(row == 0 ? .semibold : .regular)
                                .frame(width: 140, alignment: .leading)
                                .padding(8)
                        }
                    }
                    Divider()
                }
            }
            .background(HubWorkspacePalette.panel, in: RoundedRectangle(cornerRadius: 10))
        }
    }
}
