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
    assert.match(text, /Synthetic KaTeX code notice/);
    assert.match(text, /Synthetic original nested font notice/);
    assert.match(text, /Copyright: Synthetic copyright/);
    assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1 - 26 February 2007/);
    assert.match(text, /https:\/\/openfontlicense.org\/documents\/OFL.txt/);
    const installed = await collectInstalledUINotices(runtimeRoot);
    assert.equal(installed.length, 1);
    assert.equal(installed[0].file, "node_modules/frontend/NOTICE.frontend-dependencies.txt");
    assert.equal(installed[0].text, text);
    await writeFile(join(staged, "Synthetic-hashed.ttf"), "changed font");
    await assert.rejects(retainFrontendNotices(options), /no pinned source match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
