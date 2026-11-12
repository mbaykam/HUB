import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";

const noticeName = /^(?:licen[cs]e|copying|notice|ofl)(?:[._-][a-z0-9._-]+)?$/i;

/** Collect actual top-level dependency notices inside a staged runtime, without importing packages. */
export async function collectInstalledUINotices(runtimeRoot) {
  const root = await realpath(runtimeRoot), seenPackages = new Set(), seenModules = new Set(), notices = [];
  async function contained(path) {
    const actual = await realpath(path), rel = relative(root, actual);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Notice path escapes staging: ${relative(root, path)}`);
    return actual;
  }
  async function optionalDirectory(path) {
    try { return (await stat(await contained(path))).isDirectory(); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }
  async function visitPackage(path) {
    path = await contained(path);
    if (seenPackages.has(path) || !(await stat(path)).isDirectory()) return;
    seenPackages.add(path);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!noticeName.test(entry.name)) continue;
      const file = await contained(join(path, entry.name)), info = await stat(file);
      if (!info.isFile()) continue;
      if (info.size > 8 * 1024 * 1024) throw new Error(`Oversized dependency notice: ${entry.name}`);
      const body = await readFile(file);
      if (body.includes(0)) throw new Error(`Binary dependency notice: ${entry.name}`);
      notices.push({ file: relative(root, file).split(sep).join("/"), text: body.toString("utf8"), bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") });
    }
    const nested = join(path, "node_modules");
    if (await optionalDirectory(nested)) await visitModules(nested);
  }
  async function visitModules(path) {
    path = await contained(path);
    if (seenModules.has(path)) return;
    seenModules.add(path);
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (entry.name === ".pnpm") {
        const store = await contained(join(path, entry.name));
        for (const item of await readdir(store)) {
          const nested = join(store, item, "node_modules");
          if (await optionalDirectory(nested)) await visitModules(nested);
        }
      } else if (entry.name.startsWith("@")) {
        const scope = await contained(join(path, entry.name));
        for (const item of await readdir(scope)) await visitPackage(join(scope, item));
      } else if (!entry.name.startsWith(".")) await visitPackage(join(path, entry.name));
    }
  }
  await visitModules(resolve(root, "node_modules"));
  return notices.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}
