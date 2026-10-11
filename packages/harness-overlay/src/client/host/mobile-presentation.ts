import { parsePresentationSummary, type PresentationSummary } from "../../presentation-contract.ts";
import { defineOverlayStyle } from "../shared/style-runtime.ts";
import styles from "./mobile-presentation.css";
const installStyles = defineOverlayStyle("hub-mobile-presentation", styles);

/** Only the active PWA voice lease can deliver a visual. This shell owns no
 * microphone, model, task or transcript and exposes no postMessage tool bridge. */
export function createMobilePresentation(root: Document) {
  const view = root.defaultView!;
  const removeStyles = installStyles(root);
  const button = root.createElement("button"); button.type = "button"; button.hidden = true; button.setAttribute("data-hub-open-visual", "");
  const dialog = root.createElement("dialog"); dialog.setAttribute("data-hub-visual-dialog", ""); dialog.setAttribute("aria-label", "Visual explanation");
  const toolbar = root.createElement("header");
  const title = root.createElement("strong"); title.textContent = "Visual explanation";
  const close = root.createElement("button"); close.type = "button"; close.textContent = "Close";
  const status = root.createElement("p"); status.setAttribute("role", "status");
  const stage = root.createElement("div"); stage.setAttribute("data-visual-stage", "");
  toolbar.append(title, close); dialog.append(toolbar, status, stage); root.body.append(dialog);
  let callId: string | undefined, latest: PresentationSummary | undefined, showing: string | undefined;
  let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false, opening = false, disposed = false, epoch = 0;
  const seen = new Set<string>();
  function schedule(delay = 1500) { clearTimeout(timer); if (!disposed && callId && !root.hidden) timer = setTimeout(() => void refresh(), delay); }
  async function request(action: string, owner: string, signal: AbortSignal, id?: string) {
    const response = await view.fetch(`/api/hub/voice/${action}`, { credentials: "same-origin", cache: "no-store", headers: { "x-hub-voice-call": owner, ...(id ? { "x-hub-presentation": id } : {}) }, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
    if (!response.ok) throw new Error("Presentation unavailable");
    return await response.json();
  }
  async function open() {
    if (!callId || !latest || opening || disposed) return;
    const owner = callId, item = latest, version = epoch;
    opening = true; seen.add(item.id); if (seen.size > 128) seen.delete(seen.values().next().value!);
    title.textContent = item.title; status.textContent = "Opening visual…"; status.hidden = false;
    if (!dialog.open) dialog.showModal(); close.focus(); stage.replaceChildren();
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
      stage.replaceChildren(frame); showing = item.id; status.textContent = "Voice continues while you explore.";
    } catch { if (!disposed && version === epoch && dialog.open) status.textContent = "This visual couldn’t open. Close it and try Open visual again."; }
    finally { opening = false; root.removeEventListener("hub:presentation-stop", stop); }
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
        button.textContent = `${showing && showing !== latest.id ? "New visual" : "Open visual"} · ${latest.title}`;
        if (!seen.has(latest.id) && !dialog.open && !root.querySelector("dialog[open]")) void open();
      }
    } catch { /* A presentation outage must not interrupt voice or its input. */ }
    finally { busy = false; controller = undefined; schedule(); }
  }
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { root.dispatchEvent(new Event("hub:presentation-stop")); stage.replaceChildren(); showing = undefined; });
  button.addEventListener("click", () => void open());
  const visibility = () => { if (root.hidden) { clearTimeout(timer); controller?.abort(); } else schedule(0); };
  root.addEventListener("visibilitychange", visibility);
  return {
    button, dialog,
    setCall(next: string | undefined) {
      if (next === callId) return;
      epoch++; controller?.abort(); clearTimeout(timer); root.dispatchEvent(new Event("hub:presentation-stop"));
      callId = next; latest = undefined; showing = undefined; seen.clear(); button.hidden = true;
      if (dialog.open) dialog.close(); stage.replaceChildren(); schedule(0);
    },
    dispose() { disposed = true; epoch++; callId = undefined; controller?.abort(); clearTimeout(timer); root.dispatchEvent(new Event("hub:presentation-stop")); root.removeEventListener("visibilitychange", visibility); dialog.close(); dialog.remove(); button.remove(); removeStyles(); },
  };
}
