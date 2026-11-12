import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, sep, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { collectInstalledUINotices } from "../../mobile/scripts/installed-ui-notices.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const oflPath = fileURLToPath(new URL("../../resources/licenses/SIL-OFL-1.1.txt", import.meta.url));
async function inside(root, path) {
  const base = await realpath(root), actual = await realpath(path), rel = relative(base, actual);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Frontend notice input escapes build root");
  return actual;
}

/** Read original copyright/license records from a TrueType name table. */
export function fontNoticeRecords(bytes) {
  if (bytes.length < 12) throw new Error("Truncated TrueType font");
  const tables = bytes.readUInt16BE(4);
  for (let index = 0; index < tables; index++) {
    const table = 12 + index * 16;
    if (table + 16 > bytes.length) throw new Error("Truncated font table directory");
    if (bytes.toString("ascii", table, table + 4) !== "name") continue;
    const offset = bytes.readUInt32BE(table + 8), size = bytes.readUInt32BE(table + 12);
    if (offset + size > bytes.length || size < 6) throw new Error("Truncated font name table");
    const count = bytes.readUInt16BE(offset + 2), storage = bytes.readUInt16BE(offset + 4), records = new Set();
    for (let row = 0; row < count; row++) {
      const at = offset + 6 + row * 12;
      if (at + 12 > offset + size) throw new Error("Truncated font name record");
      const platform = bytes.readUInt16BE(at), id = bytes.readUInt16BE(at + 6);
      if (![0, 13, 14].includes(id)) continue;
      const length = bytes.readUInt16BE(at + 8), start = offset + storage + bytes.readUInt16BE(at + 10);
      if (start + length > offset + size) throw new Error("Truncated font notice string");
      const text = platform === 0 || platform === 3
        ? Buffer.from(bytes.subarray(start, start + length)).swap16().toString("utf16le")
        : bytes.toString("latin1", start, start + length);
      records.add(`${id === 0 ? "Copyright" : id === 13 ? "License" : "License URL"}: ${text}`);
    }
    return [...records].sort();
  }
  return [];
}

/** Retain actual pinned dependency notices and verify the staged frontend font provenance. */
export async function retainFrontendNotices({ harnessRoot, runtimeRoot, frontendPackageName }) {
  const notices = await collectInstalledUINotices(harnessRoot);
  const katexRoots = notices.filter(item => item.file.endsWith("node_modules/katex/LICENSE")).map(item => resolve(harnessRoot, dirname(item.file)));
  if (!katexRoots.length) throw new Error("Pinned KaTeX font license is missing");
  const fontHashes = new Set(), records = [];
  for (const root of katexRoots) {
    const fonts = await inside(harnessRoot, join(root, "dist/fonts"));
    for (const name of (await readdir(fonts)).sort()) {
      const path = await inside(harnessRoot, join(fonts, name));
      if (!(await stat(path)).isFile()) continue;
      if (/^(?:license|copying|notice|ofl|copyright)(?:[._-].*)?$/i.test(name)) {
        records.push(`${relative(harnessRoot, path).split(sep).join("/")}\n${await readFile(path, "utf8")}`);
      } else if (/\.(ttf|woff2?)$/i.test(name)) {
        const bytes = await readFile(path);
        fontHashes.add(sha256(bytes));
        if (name.endsWith(".ttf")) records.push(`${name}\n${fontNoticeRecords(Buffer.from(bytes)).join("\n")}`);
      }
    }
  }
  const frontend = await inside(runtimeRoot, join(runtimeRoot, "node_modules", frontendPackageName));
  const stagedFonts = await inside(runtimeRoot, join(frontend, "dist/assets/fonts"));
  let verified = 0;
  for (const name of await readdir(stagedFonts)) {
    if (!/\.(ttf|woff2?)$/i.test(name)) continue;
    const path = await inside(runtimeRoot, join(stagedFonts, name));
    if (!fontHashes.has(sha256(await readFile(path)))) throw new Error(`Staged font has no pinned source match: ${name}`);
    verified++;
  }
  if (!verified) throw new Error("Staged frontend contains no verifiable fonts");
  const ofl = await readFile(oflPath, "utf8");
  if (sha256(ofl) !== "1d361a8f8e8ce6e68457dcd93fb56e162e6baa3bbb7e7573a290d44399f6b57e") throw new Error("Wrong pinned SIL font license");
  const text = ["Actual pinned build dependency notices; includes dependencies outside the browser payload.", ...notices.map(item => `${item.file}\nSHA-256: ${item.sha256}\n${item.text}`), "Original pinned font copyright/license name records", ...records, "Official SIL Open Font License 1.1\nSource: https://openfontlicense.org/documents/OFL.txt\nThe example copyright header below is from SIL; actual font ownership and reserved names are preserved above.\n" + ofl].join("\n\n----------------------------------------\n\n") + "\n";
  const output = join(frontend, "NOTICE.frontend-dependencies.txt");
  try { await inside(runtimeRoot, output); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await writeFile(output, text);
  return { output, notices: notices.length, verifiedFonts: verified, bytes: Buffer.byteLength(text), sha256: sha256(text) };
}
