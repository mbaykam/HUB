import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fontNoticeRecords, retainFrontendNotices } from "../scripts/harness/frontend-notices.mjs";
import { collectInstalledUINotices } from "../mobile/scripts/installed-ui-notices.mjs";

function font() {
  const text = Buffer.from("Synthetic copyright and reserved font name", "utf16le").swap16();
  const bytes = Buffer.alloc(46 + text.length);
  bytes.writeUInt16BE(1, 4); bytes.write("name", 12); bytes.writeUInt32BE(28, 20); bytes.writeUInt32BE(18 + text.length, 24);
  bytes.writeUInt16BE(1, 30); bytes.writeUInt16BE(18, 32);
  bytes.writeUInt16BE(3, 34); bytes.writeUInt16BE(1, 36); bytes.writeUInt16BE(0x409, 38);
  bytes.writeUInt16BE(0, 40); bytes.writeUInt16BE(text.length, 42);
  text.copy(bytes, 46);
  return bytes;
}

test("font metadata preserves actual copyright strings without changing input bytes", () => {
  const bytes = font(), original = Buffer.from(bytes);
  assert.deepEqual(fontNoticeRecords(bytes), ["Copyright: Synthetic copyright and reserved font name"]);
  assert.deepEqual(bytes, original);
  assert.throws(() => fontNoticeRecords(bytes.subarray(0, 20)), /Truncated/);
});

test("stage notice retention verifies original font bytes and includes official OFL plus actual metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-frontend-notices-"));
  try {
    const harnessRoot = join(root, "source"), runtimeRoot = join(root, "runtime");
    const fonts = join(harnessRoot, "node_modules/katex/dist/fonts");
    const staged = join(runtimeRoot, "node_modules/frontend/dist/assets/fonts");
    await mkdir(fonts, { recursive: true }); await mkdir(staged, { recursive: true });
    await writeFile(join(harnessRoot, "node_modules/katex/LICENSE"), "Synthetic KaTeX code notice");
    await writeFile(join(fonts, "Synthetic.ttf"), font());
    await writeFile(join(fonts, "OFL.txt"), "Synthetic original nested font notice");
    await writeFile(join(staged, "Synthetic-hashed.ttf"), font());
    const options = { harnessRoot, runtimeRoot, frontendPackageName: "frontend" };
    const first = await retainFrontendNotices(options), second = await retainFrontendNotices(options);
    assert.equal(first.sha256, second.sha256);
    assert.equal(first.verifiedFonts, 1);
    const text = await readFile(first.output, "utf8");
    // Inspect the generated notice artifact as records, including the complete
    // original notice/license bodies, rather than matching implementation text.
    const sections = text.trimEnd().split("\n\n----------------------------------------\n\n");
    const codeNotice = sections.find(section => section.startsWith("node_modules/katex/LICENSE\n"));
    assert.equal(codeNotice.split("\n").slice(2).join("\n"), "Synthetic KaTeX code notice");
    assert.equal(sections.find(section => section.startsWith("node_modules/katex/dist/fonts/OFL.txt\n")),
      "node_modules/katex/dist/fonts/OFL.txt\nSynthetic original nested font notice");
    assert.equal(sections.find(section => section.startsWith("Synthetic.ttf\n")),
      "Synthetic.ttf\nCopyright: Synthetic copyright and reserved font name");
    const officialLicense = await readFile(new URL("../resources/licenses/SIL-OFL-1.1.txt", import.meta.url), "utf8");
    assert.equal(sections.at(-1), [
      "Official SIL Open Font License 1.1",
      "Source: https://openfontlicense.org/documents/OFL.txt",
      "The example copyright header below is from SIL; actual font ownership and reserved names are preserved above.",
      officialLicense,
    ].join("\n").trimEnd());
    const installed = await collectInstalledUINotices(runtimeRoot);
    assert.equal(installed.length, 1);
    assert.equal(installed[0].file, "node_modules/frontend/NOTICE.frontend-dependencies.txt");
    assert.equal(installed[0].text, text);
    await writeFile(join(staged, "Synthetic-hashed.ttf"), "changed font");
    await assert.rejects(retainFrontendNotices(options), /no pinned source match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
