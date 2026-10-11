import { defineOverlayStyle } from "../shared/style-runtime.ts";
import styles from "./mobile-voice-history.css";
const installStyles = defineOverlayStyle("hub-mobile-voice-history", styles);
import type { HarnessClientContext } from "../core/context.ts";
import { VoiceHistoryClient } from "./voice-history.ts";

export type VoiceHistorySessions = Pick<HarnessClientContext["sessions"], "list" | "open">;

/** Tucked-away access to the original native transcripts, not another chat DB. */
export function installMobileVoiceHistory(container: HTMLElement, root: Document, sessions: VoiceHistorySessions, closePanel: () => void, sharedHistory?: VoiceHistoryClient): () => void {
  const view = root.defaultView;
  if (!view) return () => {};
  const client = sharedHistory ?? new VoiceHistoryClient((input, init) => view.fetch(input, init));
  const panel = root.createElement("details"); panel.setAttribute("data-hub-voice-history", "");
  const summary = root.createElement("summary"); summary.textContent = "Voice history";
  const explanation = root.createElement("p"); explanation.textContent = "Your voice transcripts live here. Save a conversation when you want to keep it with your chats.";
  const status = root.createElement("p"); status.setAttribute("role", "status");
  const refresh = root.createElement("button"); refresh.type = "button"; refresh.textContent = "Refresh";
  const list = root.createElement("div");
  const more = root.createElement("button"); more.type = "button"; more.textContent = "Show more"; more.hidden = true;
  panel.append(summary, explanation, refresh, status, list, more);
  const removeStyles = installStyles(root);
  container.append(panel);
  let limit = 12, key = "", notice = "", disposed = false;
  const saving = new Set<string>();
  // Touch browsers can consume the compatibility click after a drawer opens.
  // Activate a stationary history tap on release, as the Recents drawer does.
  // Do not turn scrolling/cancelled touches into navigation or replay a click.
  let touch: { id: number; x: number; y: number; button: HTMLButtonElement } | undefined;
  let suppressed: { button: HTMLButtonElement; until: number } | undefined;
  const historyButton = (target: EventTarget | null) => target instanceof view.Element
    ? target.closest<HTMLButtonElement>("[data-voice-history-open]") : null;
  panel.addEventListener("pointerdown", event => {
    touch = undefined; suppressed = undefined;
    const button = historyButton(event.target);
    if (event.isPrimary && event.pointerType === "touch" && event.button === 0 && button && !button.disabled)
      touch = { id: event.pointerId, x: event.clientX, y: event.clientY, button };
  });
  panel.addEventListener("pointermove", event => {
    if (touch?.id === event.pointerId && Math.max(Math.abs(event.clientX - touch.x), Math.abs(event.clientY - touch.y)) >= 9) touch = undefined;
  });
  panel.addEventListener("pointercancel", () => { touch = undefined; });
  panel.addEventListener("pointerup", event => {
    const held = touch; touch = undefined;
    if (!held || held.id !== event.pointerId || !held.button.isConnected || held.button.disabled || historyButton(event.target) !== held.button || Math.max(Math.abs(event.clientX - held.x), Math.abs(event.clientY - held.y)) >= 9) return;
    event.preventDefault();
    held.button.click();
    suppressed = { button: held.button, until: view.performance.now() + 450 };
  });
  panel.addEventListener("click", event => {
    if (event.detail > 0 && suppressed?.button === historyButton(event.target) && view.performance.now() <= suppressed.until) {
      event.preventDefault(); event.stopImmediatePropagation(); suppressed = undefined;
    }
  }, true);
  function render() {
    if (disposed || !panel.open) return;
    const history = client.getSnapshot(), native = sessions.list.getSnapshot();
    const nextKey = JSON.stringify([history, history.records.map(row => native.byId[row.sessionId]), limit, [...saving], notice]);
    if (nextKey === key) return; key = nextKey;
    refresh.disabled = history.phase === "loading";
    status.textContent = notice || (history.phase === "loading" ? "Loading voice history…" : history.phase === "error" ? "Couldn’t refresh voice history. Any entries below may be out of date." : history.records.length ? `${history.records.length} voice conversation${history.records.length === 1 ? "" : "s"}` : "No voice conversations yet.");
    list.replaceChildren();
    for (const record of history.records.slice(0, limit)) {
      const session = native.byId[record.sessionId];
      const row = root.createElement("article"); row.setAttribute("data-voice-history-id", record.sessionId);
      const open = root.createElement("button"); open.type = "button"; open.setAttribute("data-voice-history-open", "");
      const title = root.createElement("strong"); title.textContent = session?.title || session?.displayTitle || "Voice conversation";
      const meta = root.createElement("small"); meta.textContent = `${new Date(record.createdAt).toLocaleString()}${record.saved ? " · Saved to chats" : ""}`;
      open.append(title, meta); open.disabled = session === undefined;
      if (!session) meta.textContent += " · Not currently listed";
      open.addEventListener("click", () => { sessions.open(record.sessionId); closePanel(); });
      const save = root.createElement("button"); save.type = "button"; save.textContent = record.saved ? "Saved" : saving.has(record.sessionId) ? "Saving…" : "Save";
      save.disabled = record.saved || saving.has(record.sessionId); save.setAttribute("aria-label", `Save ${title.textContent} to chats`);
      save.addEventListener("click", async () => {
        notice = ""; saving.add(record.sessionId); render();
        try { await client.save(record.sessionId); root.dispatchEvent(new view!.CustomEvent("hub:voice-history-changed")); }
        catch { notice = "Save wasn’t confirmed. Refresh to check before trying again."; }
        finally { saving.delete(record.sessionId); render(); }
      });
      row.append(open, save); list.append(row);
    }
    more.hidden = history.records.length <= limit;
  }
  const refreshVisible = () => { if (panel.open && !root.hidden) { notice = ""; void client.refresh(); } };
  const unsubscribe = client.subscribe(render), unsubscribeSessions = sessions.list.subscribe(render);
  panel.addEventListener("toggle", () => { if (panel.open) { key = ""; render(); refreshVisible(); } });
  refresh.addEventListener("click", refreshVisible);
  more.addEventListener("click", () => { limit += 12; render(); });
  root.addEventListener("hub:voice-history-changed", refreshVisible);
  view.addEventListener("focus", refreshVisible);
  return () => { disposed = true; if (!sharedHistory) client.dispose(); unsubscribe(); unsubscribeSessions(); root.removeEventListener("hub:voice-history-changed", refreshVisible); view.removeEventListener("focus", refreshVisible); panel.remove(); removeStyles(); };
}
