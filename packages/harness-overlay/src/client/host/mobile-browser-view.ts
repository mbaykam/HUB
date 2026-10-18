import { defineOverlayStyle } from "../shared/style-runtime.ts";
import styles from "./mobile-browser-view.css";
import { installMobileWidgetBack } from "./mobile-widget-back.ts";
const installStyles = defineOverlayStyle("hub-mobile-browser-view", styles);
import { BROWSER_VIEW_ROUTE, parseBrowserViewResult, type BrowserViewQuery, type BrowserViewTab, type BrowserViewFrame } from "../../browser-view-contract.ts";

/** Home-only preview, with a modal viewer that does not own or interrupt audio.
 * The authenticated parent-process owner ledger authorizes tabs. Recents is
 * only a source of display labels: it deliberately omits voice coordinators. */
export function createMobileBrowserView(root: Document) {
  const view = root.defaultView!;
  const panel = root.createElement("section"); panel.setAttribute("data-hub-browser-view", ""); panel.hidden = true;
  const heading = root.createElement("h2"); heading.textContent = "Browser";
  const picker = root.createElement("select"); picker.setAttribute("aria-label", "Task browser to watch");
  const expand = root.createElement("button"); expand.type = "button"; expand.setAttribute("aria-label", "Expand task browser");
  const image = root.createElement("img"); image.alt = "Live task browser preview"; image.hidden = true;
  const caption = root.createElement("span"); caption.textContent = "Watch the assistant’s browser";
  expand.append(image, caption);
  const status = root.createElement("p"); status.setAttribute("role", "status");
  panel.append(heading, picker, expand, status);
  const dialog = root.createElement("dialog"); dialog.setAttribute("data-hub-browser-dialog", ""); dialog.setAttribute("aria-label", "Task browser viewer");
  const toolbar = root.createElement("header");
  const title = root.createElement("strong"); title.textContent = "Browser";
  const close = root.createElement("button"); close.type = "button"; close.textContent = "Close";
  const zoom = root.createElement("button"); zoom.type = "button"; zoom.textContent = "Zoom in"; zoom.setAttribute("aria-pressed", "false");
  const fullImage = root.createElement("img"); fullImage.alt = "Live task browser";
  const viewport = root.createElement("figure"); viewport.append(fullImage);
  const fullStatus = root.createElement("p"); fullStatus.setAttribute("role", "status");
  const address = root.createElement("p"); address.setAttribute("data-browser-address", "");
  toolbar.append(title, zoom, close); dialog.append(toolbar, address, fullStatus, viewport);
  const removeStyles = installStyles(root);
  root.body.append(dialog);
  const removeBack = installMobileWidgetBack(dialog, toolbar, () => dialog.close());
  let labels = new Map<string, string>(), tabs: BrowserViewTab[] = [], selected = "", visible = false, disposed = false, busy = false;
  let voiceSession: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, request: AbortController | undefined;
  let epoch = 0, listedAt = 0;
  function clearFrame() { image.hidden = true; fullImage.hidden = true; image.removeAttribute("src"); fullImage.removeAttribute("src"); }
  function message(text: string) { if (status.textContent !== text) status.textContent = text; if (fullStatus.textContent !== text) fullStatus.textContent = text; }
  function display() {
    // An active voice call is not evidence that a browser task exists.
    // Keep Home clear until a tab has actually been observed.
    panel.hidden = !visible || !tabs.length;
    expand.disabled = !tabs.length;
    expand.hidden = !tabs.length;
    picker.hidden = tabs.length < 2;
  }
  function ownerLabel(tab: BrowserViewTab) { return labels.get(tab.ownerSessionId) ?? (tab.ownerSessionId === voiceSession ? "Voice conversation" : "Background task"); }
  function schedule(delay = 0) { clearTimeout(timer); if (!disposed && !root.hidden && (visible || dialog.open)) timer = setTimeout(() => void refresh(), delay); }
  async function query(input: BrowserViewQuery, signal: AbortSignal) {
    const reply = await view.fetch(BROWSER_VIEW_ROUTE, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json", "x-hub-browser-view": "1" }, body: JSON.stringify(input), signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
    if (!reply.ok) throw new Error("unavailable");
    return parseBrowserViewResult(input, await reply.json());
  }
  async function refresh() {
    if (busy || disposed || root.hidden || (!visible && !dialog.open)) return;
    busy = true; request = new AbortController(); const version = epoch;
    try {
      if (Date.now() - listedAt > 2500) {
        const result = await query({ type: "list" }, request.signal) as BrowserViewTab[];
        if (version !== epoch) return;
        const priorTab = tabs.find(tab => tab.sessionId === selected);
        tabs = result; listedAt = Date.now();
        const prior = selected;
        if (!tabs.some(tab => tab.sessionId === selected)) selected = tabs[0]?.sessionId ?? "";
        if (prior !== selected || priorTab?.url !== tabs.find(tab => tab.sessionId === selected)?.url) clearFrame();
        const options = tabs.map(tab => { const option = root.createElement("option"); option.value = tab.sessionId; option.textContent = `${ownerLabel(tab)} · ${tab.title}`; return option; });
        const signature = options.map(option => `${option.value}\n${option.textContent}`).join("\n");
        if (picker.dataset.signature !== signature) { picker.replaceChildren(...options); picker.dataset.signature = signature; }
        picker.value = selected; picker.hidden = tabs.length < 2;
      }
      const tab = tabs.find(tab => tab.sessionId === selected);
      display();
      if (!tab) { clearFrame(); title.textContent = "Browser"; address.textContent = ""; message("No task browser is open."); return; }
      title.textContent = tab.title; address.textContent = tab.url;
      caption.textContent = `${ownerLabel(tab)} · Expand browser`;
      if (tab.status !== "ready") { clearFrame(); message(`Browser ${tab.status}. Waiting for a current view…`); return; }
      const frame = await query({ type: "frame", sessionId: tab.sessionId, ownerSessionId: tab.ownerSessionId }, request.signal) as BrowserViewFrame;
      if (version !== epoch || selected !== frame.tab.sessionId) return;
      const source = `data:image/jpeg;base64,${frame.data}`;
      image.src = source; image.hidden = false;
      if (dialog.open) { fullImage.src = source; fullImage.hidden = false; }
      message(`${frame.tab.owner === "human" ? "Under desktop control" : "Watching assistant"} · Live view · Read-only`);
    } catch {
      if (version === epoch && !disposed) { clearFrame(); message("Browser view unavailable. Reconnecting…"); listedAt = 0; display(); }
    } finally { busy = false; request = undefined; schedule(tabs.length ? 1000 : 4000); }
  }
  function invalidate() { epoch++; request?.abort(); listedAt = 0; clearFrame(); schedule(); }
  picker.addEventListener("change", () => { selected = picker.value; invalidate(); });
  expand.addEventListener("click", () => { dialog.showModal(); fullImage.hidden = image.hidden; if (image.getAttribute("src")) fullImage.src = image.src; close.focus(); schedule(); });
  close.addEventListener("click", () => dialog.close());
  zoom.addEventListener("click", () => { const enlarged = dialog.toggleAttribute("data-zoom"); zoom.textContent = enlarged ? "Fit" : "Zoom in"; zoom.setAttribute("aria-pressed", String(enlarged)); });
  dialog.addEventListener("close", () => { fullImage.removeAttribute("src"); schedule(); });
  const visibility = () => { invalidate(); if (root.hidden) message("Browser view paused while HUB is hidden."); };
  root.addEventListener("visibilitychange", visibility);
  return {
    panel, dialog,
    update(home: boolean, sessions: ReadonlyMap<string, string>, activeVoiceSession?: string) {
      labels = new Map(sessions); voiceSession = activeVoiceSession;
      const change = visible !== home; visible = home;
      display();
      if (change) { if (!home && !dialog.open) invalidate(); else schedule(); }
    },
    dispose() { disposed = true; epoch++; request?.abort(); clearTimeout(timer); root.removeEventListener("visibilitychange", visibility); removeBack(); dialog.close(); panel.remove(); dialog.remove(); removeStyles(); },
  };
}
