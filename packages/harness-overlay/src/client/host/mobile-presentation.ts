import { parsePresentationSummary, type PresentationSummary } from "../../presentation-contract.ts";
import { defineOverlayStyle } from "../shared/style-runtime.ts";
import styles from "./mobile-presentation.css";
import type { HarnessClientContext } from "../core/context.ts";
const installStyles = defineOverlayStyle("hub-mobile-presentation", styles);

/** The selected conversation or active voice lease can deliver a visual. This shell owns no
 * microphone, model, task or transcript and exposes no postMessage tool bridge. */
export function createMobilePresentation(root: Document) {
  const view = root.defaultView!;
  const removeStyles = installStyles(root);
  const button = root.createElement("button"); button.type = "button"; button.hidden = true; button.setAttribute("data-hub-open-visual", "");
  const dialog = root.createElement("dialog"); dialog.setAttribute("data-hub-visual-dialog", ""); dialog.setAttribute("aria-label", "Visual explanation");
  const toolbar = root.createElement("header");
  const title = root.createElement("strong"); title.textContent = "Visual explanation";
  const close = root.createElement("button"); close.type = "button"; close.textContent = "Close";
  const follow = root.createElement("button"); follow.type = "button"; follow.textContent = "Live updates"; follow.setAttribute("aria-pressed", "true");
  const update = root.createElement("button"); update.type = "button"; update.textContent = "Show latest"; update.hidden = true;
  const status = root.createElement("p"); status.setAttribute("role", "status");
  const stage = root.createElement("div"); stage.setAttribute("data-visual-stage", "");
  toolbar.append(title, follow, update, close); dialog.append(toolbar, status, stage); root.body.append(dialog);
  let callId: string | undefined, latest: PresentationSummary | undefined, showing: string | undefined;
  let sessionId: string | undefined, selectedCall: string | undefined, following = true;
  let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false, opening = false, disposed = false, epoch = 0;
  const seen = new Set<string>();
  function schedule(delay = 1500) { clearTimeout(timer); if (!disposed && callId && !root.hidden) timer = setTimeout(() => void refresh(), delay); }
  async function request(action: string, owner: string, signal: AbortSignal, id?: string) {
    const voice = owner.startsWith("voice:");
    const response = await view.fetch(`/api/hub/${voice ? "voice/" : ""}${action}`, { credentials: "same-origin", cache: "no-store", headers: { [voice ? "x-hub-voice-call" : "x-hub-session"]: owner.slice(owner.indexOf(":") + 1), ...(id ? { "x-hub-presentation": id } : {}) }, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
    if (!response.ok) throw new Error("Presentation unavailable");
    return await response.json();
  }
  async function open() {
    if (!callId || !latest || opening || disposed) return;
    const owner = callId, item = latest, version = epoch;
    opening = true; seen.add(item.id); if (seen.size > 128) seen.delete(seen.values().next().value!);
    title.textContent = item.title; status.textContent = "Opening visual…"; status.hidden = false;
    if (!dialog.open) { dialog.showModal(); close.focus(); } stage.replaceChildren();
    const pending = new AbortController();
    // Separate controller so polling cannot cancel the document load. Ending
    // the call invalidates its epoch and aborts this request through the event.
    const stop = () => pending.abort(); root.addEventListener("hub:presentation-stop", stop);
    try {
      const result = await request("presentation-document", owner, pending.signal, item.id);
      if (disposed || version !== epoch || !dialog.open || callId !== owner) return;
      if (typeof result.document !== "string" || result.document.length > 3_000_000) throw new Error("Invalid visual document");
      const frame = root.createElement("iframe"); frame.title = item.title;
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'");
      frame.referrerPolicy = "no-referrer";
      frame.srcdoc = result.document;
      stage.replaceChildren(frame); showing = item.id; update.hidden = true; status.textContent = selectedCall ? "Voice continues while you explore." : "Interactive controls run locally. Your conversation stays open.";
    } catch { if (!disposed && version === epoch && dialog.open) status.textContent = "This visual couldn’t open. Close it and try Open visual again."; }
    finally { if (version === epoch) opening = false; root.removeEventListener("hub:presentation-stop", stop); }
  }
  async function refresh() {
    if (!callId || busy || disposed || root.hidden) return;
    busy = true; controller = new AbortController(); const owner = callId, version = epoch;
    try {
      const result = await request("presentation", owner, controller.signal);
      if (disposed || epoch !== version || owner !== callId) return;
      latest = result.presentation === null ? undefined : parsePresentationSummary(result.presentation);
      button.hidden = !latest;
      if (latest) {
        const label = showing && showing !== latest.id ? "New visual" : "Open visual";
        button.textContent = label === "New visual" ? label : "Visual";
        button.setAttribute("aria-label", `${label} · ${latest.title}`); button.title = latest.title;
        update.hidden = !dialog.open || showing === latest.id;
        if (dialog.open && showing !== latest.id && following && !opening) void open();
        if (!seen.has(latest.id) && !dialog.open && !root.querySelector("dialog[open]")) void open();
      }
    } catch { /* A presentation outage must not interrupt voice or its input. */ }
    finally { busy = false; controller = undefined; schedule(); }
  }
  close.addEventListener("click", () => dialog.close());
  follow.addEventListener("click", () => { following = !following; follow.setAttribute("aria-pressed", String(following)); if (following && latest?.id !== showing) void open(); });
  update.addEventListener("click", () => void open());
  dialog.addEventListener("close", () => { root.dispatchEvent(new Event("hub:presentation-stop")); stage.replaceChildren(); showing = undefined; });
  button.addEventListener("click", () => void open());
  const visibility = () => { if (root.hidden) { clearTimeout(timer); controller?.abort(); } else schedule(0); };
  root.addEventListener("visibilitychange", visibility);
  function selectOwner() {
      const next = selectedCall ? "voice:" + selectedCall : sessionId ? "session:" + sessionId : undefined;
      if (next === callId) return;
      epoch++; controller?.abort(); clearTimeout(timer); root.dispatchEvent(new Event("hub:presentation-stop"));
      callId = next; latest = undefined; showing = undefined; opening = false; button.hidden = true; update.hidden = true;
      if (dialog.open) dialog.close(); stage.replaceChildren(); schedule(0);
  }
  return {
    button, dialog,
    setCall(next: string | undefined) { selectedCall = next; selectOwner(); },
    setSession(next: string | undefined) { sessionId = next; selectOwner(); },
    dispose() { disposed = true; epoch++; callId = undefined; controller?.abort(); clearTimeout(timer); root.dispatchEvent(new Event("hub:presentation-stop")); root.removeEventListener("visibilitychange", visibility); dialog.close(); dialog.remove(); button.remove(); removeStyles(); },
  };
}

/** One canvas survives responsive layout and Home/chat navigation. */
export function installConversationPresentation(ctx: HarnessClientContext, root: Document = document) {
  const canvas = createMobilePresentation(root);
  canvas.button.setAttribute("data-hub-chat-visual", "");
  const view = root.defaultView!;
  let voiceCall: string | undefined, frame: number | undefined;
  function place() {
    frame = undefined;
    const target = ctx.sessions.list.getSnapshot().current
      ? root.querySelector('[data-slot="conversation.session.header.utilities"]')
      : voiceCall ? root.querySelector('[data-hub-voice-hub]') : null;
    if (target && canvas.button.parentElement !== target) target.append(canvas.button);
    else if (!target) canvas.button.remove();
  }
  const schedule = () => { if (frame === undefined) frame = view.requestAnimationFrame(place); };
  const observer = new view.MutationObserver(schedule);
  observer.observe(root.body, { childList: true, subtree: true });
  const selected = () => { canvas.setSession(ctx.sessions.list.getSnapshot().current); schedule(); };
  const off = ctx.sessions.list.subscribe(selected); selected();
  const call = (event: Event) => { voiceCall = (event as CustomEvent<{ callId?: string }>).detail?.callId; canvas.setCall(voiceCall); schedule(); };
  root.addEventListener("hub:presentation-call", call);
  return () => { off(); observer.disconnect(); if (frame !== undefined) view.cancelAnimationFrame(frame); root.removeEventListener("hub:presentation-call", call); canvas.dispose(); };
}
