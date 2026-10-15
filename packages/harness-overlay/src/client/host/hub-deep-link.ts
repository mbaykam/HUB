import type { HarnessClientContext } from "../core/context.ts";
/** Resolve only a session returned by the authenticated native session list. */
export function installHubDeepLink(ctx: Pick<HarnessClientContext, "sessions">, root: Document = document) {
  const view = root.defaultView!;
  const url = new URL(view.location.href), id = url.searchParams.get("hubSession"), panel = url.searchParams.get("hubPanel");
  const automation=!!id&&/^hub-(?:automation|goal)-[a-f0-9-]{36}-[a-f0-9-]{36}$/.test(id);
  if (!id || !automation&&!/^minke-im-(telegram|discord)-[a-f0-9]{32}$/.test(id)) return () => {};
  if(automation)void ctx.sessions.refresh?.();
  let complete = false, opened = false, timer: number | undefined;
  const until = Date.now() + 20_000;
  function reconcile() {
    if (complete) return;
    const snapshot = ctx.sessions.list.getSnapshot();
    if (!opened && snapshot.byId[id!]) { opened = true; ctx.sessions.open(id!); }
    if (opened && (panel !== "models" || root.querySelector('[data-hub-models-launcher]'))) {
      if (panel === "models") root.querySelector<HTMLButtonElement>('[data-hub-models-launcher]')?.click();
      complete = true; url.searchParams.delete("hubSession"); url.searchParams.delete("hubPanel"); view.history.replaceState(view.history.state, "", url.href); return;
    }
    if (Date.now() >= until) {
      complete = true;
      const notice = root.createElement("div"); notice.setAttribute("role", "status"); notice.textContent = automation?"This task session is unavailable. Refresh HUB and try again.":"This HUB conversation is not available yet. Send a message to the bot, then reopen the link.";
      notice.style.cssText = "position:fixed;bottom:16px;left:16px;right:16px;padding:16px;border-radius:14px;background:#202536;color:white;z-index:9999";
      const close = root.createElement("button"); close.type = "button"; close.textContent = "Dismiss"; close.addEventListener("click", () => notice.remove()); notice.append(close); root.body.append(notice); return;
    }
    view.clearTimeout(timer); timer = view.setTimeout(reconcile, 500);
  }
  const unsubscribe = ctx.sessions.list.subscribe(reconcile); reconcile();
  return () => { complete = true; view.clearTimeout(timer); unsubscribe(); };
}
