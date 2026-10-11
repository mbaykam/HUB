import type { HarnessClientContext } from "../core/context.ts";
import { VoiceHistoryClient, type VoiceHistoryRecord } from "./voice-history.ts";

/** Additive hook provided by the declared staged-runtime patch. It contributes
 * to the browser region only; it is not the native host archive operation. */
export interface NavigationVisibilityPort {
  registerNavigationHiddenSessions?(source: {
    getSnapshot(): readonly string[];
    subscribe(listener: () => void): () => void;
  }): () => void;
}

export function hiddenVoiceConversationIds(records: readonly VoiceHistoryRecord[], sessions: Readonly<Record<string, { readonly origin?: string } | undefined>>): readonly string[] {
  return records.filter(record => !record.saved && sessions[record.sessionId]?.origin !== "subagent").map(record => record.sessionId).sort();
}

export function installMobileConversationVisibility(ctx: Pick<HarnessClientContext, "sessions" | "connection">, navigation: NavigationVisibilityPort, root: Document = document, sharedHistory?: VoiceHistoryClient): () => void {
  const view = root.defaultView;
  if (!view || !navigation.registerNavigationHiddenSessions) return () => {};
  const history = sharedHistory ?? new VoiceHistoryClient((input, init) => view.fetch(input, init));
  const listeners = new Set<() => void>();
  let hidden: readonly string[] = [], knownIds = "", disposed = false;
  const mobile = () => root.documentElement.hasAttribute("data-minke-mobile-web") && view.innerWidth <= 1024;
  const source = { getSnapshot: () => hidden, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const remove = navigation.registerNavigationHiddenSessions(source);
  function publish() {
    if (disposed) return;
    const next = mobile() ? hiddenVoiceConversationIds(history.getSnapshot().records, ctx.sessions.list.getSnapshot().byId) : [];
    if (next.length === hidden.length && next.every((id, index) => id === hidden[index])) return;
    hidden = Object.freeze(next); listeners.forEach(listener => listener());
  }
  const refresh = () => { if (mobile() && !root.hidden) history.invalidate(); publish(); };
  const offHistory = history.subscribe(publish);
  const offSessions = ctx.sessions.list.subscribe(() => {
    const ids = Object.keys(ctx.sessions.list.getSnapshot().byId).sort().join("\n");
    if (ids !== knownIds) { knownIds = ids; refresh(); } else publish();
  });
  const offConnection = ctx.connection.state?.subscribe(() => { if (ctx.connection.state?.getSnapshot() === "connected") refresh(); });
  root.addEventListener("hub:voice-history-changed", refresh);
  root.addEventListener("minke:mobile-left-drawer-opening", refresh);
  root.addEventListener("visibilitychange", refresh);
  view.addEventListener("focus", refresh);
  view.addEventListener("resize", refresh);
  // Tracks mobile-root lifetime independently from viewport resize/HMR.
  const observer = new view.MutationObserver(refresh);
  observer.observe(root.documentElement, { attributes: true, attributeFilter: ["data-minke-mobile-web"] });
  const timer = view.setInterval(() => {
    if (root.querySelector('[data-minke-mobile-sidebar-open], [data-hub-voice-history][open]')) refresh();
  }, 30_000);
  refresh();
  return () => { disposed = true; if (!sharedHistory) history.dispose(); offHistory(); offSessions(); offConnection?.(); view.clearInterval(timer); observer.disconnect(); root.removeEventListener("hub:voice-history-changed", refresh); root.removeEventListener("minke:mobile-left-drawer-opening", refresh); root.removeEventListener("visibilitychange", refresh); view.removeEventListener("focus", refresh); view.removeEventListener("resize", refresh); remove(); listeners.clear(); };
}
