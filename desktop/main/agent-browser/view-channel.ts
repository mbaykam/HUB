import { BROWSER_VIEW_CHANNEL, browserViewId, parseBrowserViewQuery, parseBrowserViewResult, type BrowserViewTab, type BrowserViewFrame } from "@minke/harness-overlay/browser-view-contract.ts";
import type { AgentBrowserProcessChild } from "./process-channel.ts";

export interface BrowserViewHandler {
  listOwnedBrowsers(owners: ReadonlySet<string>): BrowserViewTab[];
  captureOwnedBrowser(ownerSessionId: string, sessionId: string): Promise<BrowserViewFrame>;
}

/** Child-local owner ledger gates every view. The PWA never receives global
 * desktop projections, debugger IDs, partitions, cookies or a mutation port. */
export function bindBrowserViewChannel(child: AgentBrowserProcessChild, handler: BrowserViewHandler, owners: () => ReadonlySet<string>): () => void {
  let disposed = false;
  const pending = new Set<string>();
  const send = (value: unknown) => {
    if (disposed || !child.connected) return;
    try { child.send?.(value, () => {}); } catch { /* Parent/child shutdown. */ }
  };
  const receive = (value: unknown) => {
    if (disposed || !value || typeof value !== "object" || Reflect.get(value, "channel") !== BROWSER_VIEW_CHANNEL || Reflect.get(value, "type") !== "request") return;
    let requestId: string;
    try { requestId = browserViewId(Reflect.get(value, "requestId")); } catch { return; }
    if (pending.has(requestId)) return;
    if (pending.size >= 2) { send({ channel: BROWSER_VIEW_CHANNEL, type: "response", requestId, error: "busy" }); return; }
    pending.add(requestId);
    void (async () => {
      try {
        const query = parseBrowserViewQuery(Reflect.get(value, "query"));
        const allowed = owners();
        if (query.type === "frame" && !allowed.has(query.ownerSessionId)) throw new Error("not-found");
        const result = query.type === "list" ? handler.listOwnedBrowsers(allowed) : await handler.captureOwnedBrowser(query.ownerSessionId, query.sessionId);
        if (query.type === "frame" && !owners().has(query.ownerSessionId)) throw new Error("not-found");
        send({ channel: BROWSER_VIEW_CHANNEL, type: "response", requestId, result: parseBrowserViewResult(query, result) });
      } catch {
        // No native errors, filesystem paths or foreign browser metadata leave
        // the parent. A closed/reassigned/loading tab is simply unavailable.
        send({ channel: BROWSER_VIEW_CHANNEL, type: "response", requestId, error: "unavailable" });
      } finally { pending.delete(requestId); }
    })();
  };
  child.on("message", receive);
  return () => { disposed = true; child.off("message", receive); pending.clear(); };
}
