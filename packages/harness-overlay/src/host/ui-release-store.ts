import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Deliberately not an archive extractor or plugin installer. No host code,
// credentials, source maps, paths, executable hooks, or dependencies allowed.
export const UI_FILES = ["pwa-client.js", "memory-graph-browser.js", "voice-browser.js", "memory-graph-browser.js.LEGAL.txt", "memory-graph-third-party-licenses.txt"] as const;
export type UiFile = typeof UI_FILES[number];
export const UI_MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
export const UI_HASH = /^[a-f0-9]{64}$/;
export interface UiRelease {
  schema: 1;
  compatibility: string;
  label: string;
  files: Record<UiFile, { sha256: string; data: string }>;
}
export interface UiPointer { schema: 1; active: string | null; previous: string | null }
export function uiHash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function keys(value: object, expected: readonly string[]): boolean { return Object.keys(value).sort().join("|") === [...expected].sort().join("|"); }
export function parseUiRelease(text: string, compatibility: string): { release: UiRelease; id: string; assets: Map<UiFile, Buffer> } {
  if (Buffer.byteLength(text) > UI_MAX_PACKAGE_BYTES || !UI_HASH.test(compatibility)) throw new Error("Invalid UI package size or host compatibility");
  const value = JSON.parse(text) as UiRelease;
  if (!value || !keys(value, ["schema", "compatibility", "label", "files"]) || value.schema !== 1 || value.compatibility !== compatibility ||
      typeof value.label !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(value.label) || !value.files || !keys(value.files, UI_FILES)) throw new Error("UI update requires a matching host and a complete UI-only package");
  const assets = new Map<UiFile, Buffer>();
  for (const name of UI_FILES) {
    const file = value.files[name];
    if (!file || !keys(file, ["sha256", "data"]) || typeof file.data !== "string" || !UI_HASH.test(file.sha256)) throw new Error("Invalid UI asset");
    const bytes = Buffer.from(file.data, "base64");
    if (!bytes.length || bytes.length > 16 * 1024 * 1024 || bytes.toString("base64") !== file.data || uiHash(bytes) !== file.sha256) throw new Error("UI asset checksum mismatch");
    assets.set(name, bytes);
  }
  if (!assets.get("pwa-client.js")!.toString("utf8").startsWith("window.__HUB_UI_FACTORY__ = ")) throw new Error("Invalid PWA factory wrapper");
  return { release: value, id: uiHash(text), assets };
}
export function parseUiPointer(text: string): UiPointer {
  const value = JSON.parse(text) as UiPointer;
  if (!value || !keys(value, ["schema", "active", "previous"]) || value.schema !== 1 ||
      ![value.active, value.previous].every(id => id === null || typeof id === "string" && UI_HASH.test(id))) throw new Error("Invalid UI activation pointer");
  return value;
}
export async function readUiFile(path: string, max = UI_MAX_PACKAGE_BYTES): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error("Invalid UI file");
  return readFile(path, "utf8");
}
export async function readUiPointer(directory: string): Promise<UiPointer> {
  try { return parseUiPointer(await readUiFile(join(directory, "active.json"), 1024)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema: 1, active: null, previous: null }; throw error; }
}
export async function readUiRelease(directory: string, id: string, compatibility: string) {
  if (!UI_HASH.test(id)) throw new Error("Invalid UI release id");
  const parsed = parseUiRelease(await readUiFile(join(directory, `${id}.json`)), compatibility);
  if (parsed.id !== id) throw new Error("UI release identity mismatch");
  return parsed;
}
async function atomicPointer(directory: string, value: UiPointer): Promise<void> {
  const temporary = join(directory, `pointer-${randomUUID()}.tmp`);
  try { await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await rename(temporary, join(directory, "active.json")); }
  finally { await rm(temporary, { force: true }); }
}
/** Local, same-user administration only. Web clients cannot invoke this. */
export async function changeUiRelease(directory: string, compatibility: string, input: { text: string; sha256: string } | "rollback" | "builtin"): Promise<UiPointer> {
  if (!UI_HASH.test(compatibility)) throw new Error("Invalid host compatibility");
  const parsed = typeof input === "object" ? parseUiRelease(input.text, compatibility) : undefined;
  if (typeof input === "object" && (!UI_HASH.test(input.sha256) || parsed!.id !== input.sha256)) throw new Error("Package checksum does not match the explicitly approved build");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "activation.lock");
  await mkdir(lock); // Fail closed on concurrent/stale activation; never steal a lock.
  try {
    let current: UiPointer, recovery = false;
    try { current = await readUiPointer(directory); }
    catch (error) {
      if (input !== "builtin") throw error;
      // Explicit recovery also works when the pointer itself is corrupt.
      current = { schema: 1, active: null, previous: null }; recovery = true;
    }
    let active: string | null;
    if (parsed) {
      active = parsed.id;
      const target = join(directory, `${active}.json`);
      try { await readUiRelease(directory, active, compatibility); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const temporary = join(directory, `release-${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, (input as { text: string }).text, { flag: "wx", mode: 0o600 });
          await rename(temporary, target);
        } finally { await rm(temporary, { force: true }); }
      }
      // Never switch the pointer until the complete on-disk release verifies.
      await readUiRelease(directory, active, compatibility);
    } else active = input === "builtin" ? null : current.previous;
    if (active !== null) await readUiRelease(directory, active, compatibility);
    if (active === current.active && !recovery) return current;
    const next: UiPointer = { schema: 1, active, previous: current.active };
    await atomicPointer(directory, next);
    return next;
  } finally { await rmdir(lock); }
}

export function parseUiHost(text: string): { schema: 1; compatibility: string } {
  const value = JSON.parse(text);
  if (!value || value.schema !== 1 || typeof value.compatibility !== "string" || !UI_HASH.test(value.compatibility)) throw new Error("UI update bootstrap is missing or incompatible; install the host update first");
  return { schema: 1, compatibility: value.compatibility };
}
