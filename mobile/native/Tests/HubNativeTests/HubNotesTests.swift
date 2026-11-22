import XCTest
@testable import HubNative

final class HubNotesTests: XCTestCase {
    func testMarkdownLinesRoundTrip() {
        let markdown = """
        # Market
        - [ ] süt
        - [x] ekmek
          - [ ] tam buğday
        * madde
        - tire
        1. bir
        2. iki
        > alıntı
        ## Bölüm
        ![Fotoğraf](attachments/\(String(repeating: "a", count: 64)).jpg)
        | Ürün | Fiyat |
        | --- | --- |
        | Noodle | 40 |
        ```
        kod
        ```
        düz metin
        """
        let lines = HubNoteMarkdown.parse(markdown)
        XCTAssertEqual(lines[0].kind, .title)
        XCTAssertEqual(lines[1].kind, .checklist); XCTAssertFalse(lines[1].checked)
        XCTAssertTrue(lines[2].checked)
        XCTAssertEqual(lines[3].indent, 1)
        XCTAssertEqual(lines[4].kind, .bullet)
        XCTAssertEqual(lines[5].kind, .dashed)
        XCTAssertEqual(lines[6].kind, .numbered)
        XCTAssertEqual(lines[8].kind, .quote)
        XCTAssertEqual(lines[9].kind, .heading)
        XCTAssertNotNil(lines[10].object)
        XCTAssertEqual(HubNoteMarkdown.tableRows(lines[11].object!), [["Ürün", "Fiyat"], ["Noodle", "40"]])
        XCTAssertEqual(lines[12].kind, .monospaced)
        XCTAssertEqual(HubNoteMarkdown.render(lines), markdown)
    }

    func testNumbersFollowTheirList() {
        let lines = [HubNoteLine(kind: .numbered, text: "a"), HubNoteLine(kind: .numbered, text: "b"), HubNoteLine(text: "ara"), HubNoteLine(kind: .numbered, text: "c")]
        XCTAssertEqual(HubNoteMarkdown.render(lines), "1. a\n2. b\nara\n1. c")
    }

    func testTitleSnippetAndTables() {
        XCTAssertEqual(HubNoteMarkdown.title("\n\n- [ ] **Annemi** ara\nsonra"), "Annemi ara")
        XCTAssertEqual(HubNoteMarkdown.title(""), "New Note")
        XCTAssertEqual(HubNoteMarkdown.snippet("Başlık\nikinci satır\n- [ ] üç"), "ikinci satır üç")
        let table = HubNoteMarkdown.table([["A", "B|C"], ["1"]])
        XCTAssertEqual(HubNoteMarkdown.tableRows(table), [["A", "B|C"], ["1", ""]])
        XCTAssertEqual(HubNoteMarkdown.image("![drawing](attachments/x.png \"drawing:attachments/y.drawing\")")?.title, "drawing:attachments/y.drawing")
    }

    func testInlineStyles() {
        let runs = HubNoteInline.parse("a **kalın** ve *eğik* ~~çizik~~ 2*3")
        XCTAssertEqual(runs.map(\.text).joined(), "a kalın ve eğik çizik 2*3")
        XCTAssertEqual(runs.first { $0.text == "kalın" }?.style, .bold)
        XCTAssertEqual(runs.first { $0.text == "eğik" }?.style, .italic)
        XCTAssertEqual(HubNoteInline.render([(text: "a ", style: []), (text: "kalın ", style: .bold), (text: "son", style: [])]), "a **kalın** son")
    }

    func testOfflineWritesShowAtOnceAndWaitForSync() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let library = HubNotesLibrary(directory: directory)
        let id = UUID().uuidString.lowercased()
        await library.write(id: id, folder: "", body: "Market\n- [ ] süt\n- [x] ekmek", pinned: true)
        let index = await library.index()
        XCTAssertEqual(index.notes.first?.title, "Market")
        XCTAssertEqual(index.notes.first?.checklist, HubNoteChecklist(done: 1, total: 2))
        let pending = await library.pendingCount()
        XCTAssertEqual(pending, 1)
        // A second library on the same folder sees the same unsent note (it was saved to disk).
        let reopened = HubNotesLibrary(directory: directory)
        let note = await reopened.cachedNote(id)
        XCTAssertEqual(note?.body, "Market\n- [ ] süt\n- [x] ekmek")
        await reopened.delete(id: id)
        let after = await reopened.index()
        XCTAssertTrue(after.notes.isEmpty)
        let left = await reopened.pendingCount()
        XCTAssertEqual(left, 0, "a note never synced is simply dropped when deleted")
    }
}
