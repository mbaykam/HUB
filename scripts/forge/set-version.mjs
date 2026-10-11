import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCT_MANIFESTS = Object.freeze([
  "package.json", "packages/harness-overlay/package.json",
  "packages/im-discord/package.json", "packages/im-gateway/package.json",
  "packages/im-telegram/package.json", "packages/im-weixin/package.json",
  "packages/model-runtime/package.json", "packages/remote-access/package.json",
]);
const root = fileURLToPath(new URL("../..", import.meta.url));

export async function setProductVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version ?? "")) {
    throw new Error("Supply a release version, for example 0.4.26");
  }
  const candidates = await Promise.all(PRODUCT_MANIFESTS.map(async name => {
    const path = resolve(root, name), text = await readFile(path, "utf8");
    const previous = JSON.parse(text).version;
    return { path, name, previous, text: text.replace(/("version"\s*:\s*")[^"]+("\s*[,}])/u, `$1${version}$2`) };
  }));
  for (const item of candidates) {
    if (JSON.parse(item.text).version !== version) throw new Error(`Missing version field: ${item.name}`);
  }
  for (const item of candidates) if (item.previous !== version) await writeFile(item.path, item.text);
  return { version, updated: candidates.filter(item => item.previous !== version).map(item => item.name) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await setProductVersion(process.argv[2])));
}
