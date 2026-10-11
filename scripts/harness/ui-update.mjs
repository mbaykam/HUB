#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { changeUiRelease, parseUiHost, parseUiRelease, readUiFile, readUiPointer, UI_FILES, UI_MAX_PACKAGE_BYTES, uiHash } from "../../packages/harness-overlay/src/host/ui-release-store.ts";

const [command, ...args] = process.argv.slice(2);
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith("--") || !args[i + 1] || options.has(args[i])) throw new Error("Expected unique --option value pairs");
  options.set(args[i], args[i + 1]);
}
const allowed = ["--lib", "--out", "--label", "--host-manifest", "--host-compatibility", "--store", "--package", "--sha256"];
if ([...options.keys()].some(key => !allowed.includes(key))) throw new Error("Unknown UI update option");
const required = name => { const value = options.get(name); if (!value) throw new Error(`Missing ${name}`); return value; };
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
if (command === "pack") {
  const lib = resolve(options.get("--lib") ?? join(repo, "packages/harness-overlay/lib"));
  const { compatibility } = parseUiHost(await readUiFile(join(lib, "ui-host.json"), 1024));
  const files = {};
  for (const name of UI_FILES) {
    const bytes = await readFile(join(lib, name));
    files[name] = { sha256: uiHash(bytes), data: bytes.toString("base64") };
  }
  const text = JSON.stringify({ schema: 1, compatibility, label: required("--label"), files });
  const release = parseUiRelease(text, compatibility);
  const compressed = gzipSync(text, { level: 9 });
  await writeFile(resolve(required("--out")), compressed, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ label: release.release.label, sha256: uiHash(compressed), release: release.id, bytes: compressed.length, compatibility }));
} else if (["activate", "rollback", "builtin", "status"].includes(command)) {
  // Use installed metadata OR the identity verified through the actual host's
  // authenticated status route. Never substitute the candidate's identity.
  if (options.has("--host-manifest") && options.has("--host-compatibility")) throw new Error("Choose one host identity source");
  const { compatibility } = parseUiHost(options.has("--host-compatibility")
    ? JSON.stringify({ schema: 1, compatibility: required("--host-compatibility") })
    : await readUiFile(resolve(required("--host-manifest")), 1024));
  const directory = join(resolve(options.get("--store") ?? join(homedir(), ".dsh", "hub-ui-updates")), compatibility);
  let input = command;
  if (command === "activate") {
    const bytes = await readFile(resolve(required("--package")));
    if (bytes.length > UI_MAX_PACKAGE_BYTES || uiHash(bytes) !== required("--sha256")) throw new Error("Package checksum does not match the explicitly approved build");
    const text = gunzipSync(bytes, { maxOutputLength: UI_MAX_PACKAGE_BYTES }).toString("utf8");
    input = { text, sha256: uiHash(text) };
  }
  const result = command === "status" ? await readUiPointer(directory) : await changeUiRelease(directory, compatibility, input);
  console.log(JSON.stringify({ compatibility, ...result, note: "Existing tabs are unchanged. Refresh the PWA when ready; no host restart is needed." }));
} else {
  console.log("UI-only updates (Node 24):\n  pack --label NAME --out FILE\n  activate --host-manifest INSTALLED_UI_HOST_JSON --package FILE --sha256 SHA256\n  status|rollback|builtin --host-manifest INSTALLED_UI_HOST_JSON\nAlternatively use --host-compatibility SHA verified from the live authenticated host status.\nOptional: --store DIRECTORY (isolated tests), --lib DIRECTORY (pack only).\nOnly activate locally built, reviewed packages. Checksums are not publisher signatures.");
  process.exitCode = command ? 1 : 0;
}
