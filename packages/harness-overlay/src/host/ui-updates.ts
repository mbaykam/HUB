import type { IncomingMessage, ServerResponse } from "node:http";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseUiHost, parseUiPointer, parseUiRelease, UI_FILES, UI_HASH, UI_MAX_PACKAGE_BYTES, type UiFile } from "./ui-release-store.ts";
import type { PwaWebServer } from "./pwa.ts";

interface Options { root?: string; host?: string }
type Snapshot = ReturnType<typeof parseUiRelease>;
/** All injection is on the HTTP PWA seat. Electron's file/IPC client keeps
 * its bundled factory. No vendor patch, plugin reload, or host restart. */
export function installUiUpdates(web: PwaWebServer, reject: (request: IncomingMessage) => 401 | 403 | undefined, options: Options = {}): () => void {
  const { compatibility } = parseUiHost(options.host ?? readFileSync(new URL("./ui-host.json", import.meta.url), "utf8"));
  const directory = resolve(options.root ?? process.env.HUB_UI_UPDATE_ROOT ?? resolve(homedir(), ".dsh", "hub-ui-updates"), compatibility);
  let cachedPointer = "", snapshot: Snapshot | undefined, fault = false;
  function boundedRead(path: string, limit: number): string {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error("Invalid UI update file");
    return readFileSync(path, "utf8");
  }
  function read(id: string): Snapshot {
    if (!UI_HASH.test(id)) throw new Error("Invalid release");
    const result = parseUiRelease(boundedRead(resolve(directory, `${id}.json`), UI_MAX_PACKAGE_BYTES), compatibility);
    if (result.id !== id) throw new Error("Invalid release identity");
    return result;
  }
  function current(): Snapshot | undefined {
    let pointerRead = false;
    try {
      const pointer = boundedRead(resolve(directory, "active.json"), 1024);
      pointerRead = true;
      if (pointer !== cachedPointer) {
        const { active } = parseUiPointer(pointer);
        const next = active ? read(active) : undefined;
        snapshot = next; cachedPointer = pointer;
      }
      fault = false;
    } catch (error) {
      // A broken persisted override must not make the application unbootable.
      snapshot = undefined; cachedPointer = "";
      fault = pointerRead || (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
    return snapshot;
  }
  function send(response: ServerResponse, status: number, body: string | Buffer, type = "application/json; charset=utf-8") {
    response.writeHead(status, { "content-type": type, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" });
    response.end(body);
  }
  const off = [web.tapIndex(html => {
    const selected = current();
    const info = selected ? { id: selected.id, label: selected.release.label, compatibility } : { id: "builtin", label: "Built-in", compatibility };
    const source = selected ? `<script src="/api/hub/ui/asset?release=${selected.id}&amp;file=pwa-client.js" integrity="sha256-${Buffer.from(selected.release.files["pwa-client.js"].sha256, "hex").toString("base64")}"></script>` : "";
    // Blocking classic script precedes Harness's deferred module graph. If it
    // fails to download/parse, keep both the factory and lazy assets built-in.
    const script = `${source}<script>window.__HUB_UI_RELEASE__ = window.__HUB_UI_FACTORY__ ? ${JSON.stringify(info)} : ${JSON.stringify({ id: "builtin", label: "Built-in", compatibility })};</script>`;
    return html.replace(/<head\b[^>]*>/iu, `$&${script}`);
  }), web.register({ kind: "exact", path: "/api/hub/ui/status", handler(request, response) {
    const denied = reject(request);
    if (denied || request.headers["sec-fetch-site"] === "cross-site") { send(response, denied ?? 403, '{"error":"unauthorized"}'); return; }
    if (request.method !== "GET") { send(response, 405, '{"error":"read-only"}'); return; }
    const selected = current();
    send(response, 200, JSON.stringify({ schema: 1, compatibility, id: selected?.id ?? "builtin", label: selected?.release.label ?? "Built-in", fallback: fault }));
  } }), web.register({ kind: "exact", path: "/api/hub/ui/asset", handler(request, response) {
    const denied = reject(request);
    if (denied || request.headers["sec-fetch-site"] === "cross-site") { send(response, denied ?? 403, '{"error":"unauthorized"}'); return; }
    if (request.method !== "GET") { send(response, 405, '{"error":"read-only"}'); return; }
    try {
      const query = new URL(request.url ?? "", "http://127.0.0.1").searchParams;
      const id = query.get("release") ?? "", file = query.get("file") as UiFile;
      if (!UI_HASH.test(id) || !UI_FILES.includes(file)) { send(response, 400, '{"error":"invalid-asset"}'); return; }
      // Retained releases are intentional: an already-open tab must never mix
      // its factory with a newly activated graph or voice client.
      const selected = snapshot?.id === id ? snapshot : read(id);
      send(response, 200, selected.assets.get(file)!, file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/plain; charset=utf-8");
    } catch { send(response, 404, '{"error":"release-unavailable"}'); }
  } })];
  return () => off.reverse().forEach(dispose => dispose());
}
