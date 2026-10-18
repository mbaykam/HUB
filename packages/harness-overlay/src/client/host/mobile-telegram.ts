import { defineOverlayStyle } from "../shared/style-runtime.ts";
import { installMobileWidgetBack } from "./mobile-widget-back.ts";
import styles from "./mobile-models.css";
const installStyles = defineOverlayStyle("hub-mobile-telegram", styles);
export function installMobileTelegram(container: HTMLElement, root: Document) {
  const view = root.defaultView!, lifetime = new AbortController(), removeStyles = installStyles(root);
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const el = root.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
  const button = (text: string, run: () => void) => { const el = element("button", text); el.type = "button"; el.addEventListener("click", run); return el; };
  const launcher = button("Telegram", () => { dialog.showModal(); void update(); }); launcher.setAttribute("data-hub-models-launcher", ""); container.append(launcher);
  const dialog = element("dialog"); dialog.setAttribute("data-hub-models", ""); dialog.setAttribute("aria-label", "Telegram connection");
  const header = element("header"); header.append(element("h2", "Telegram"), button("Done", () => dismiss()));
  const intro = element("p", "Use your Telegram bot to chat with HUB. Conversations, models and memory stay on your HUB host.");
  const token = element("input"); token.type = "password"; token.placeholder = "BotFather bot token"; token.autocomplete = "off"; token.setAttribute("aria-label", "Telegram bot token"); token.style.width = "100%";
  token.autocapitalize = "none"; token.spellcheck = false; token.maxLength = 150;
  const status = element("p"); status.setAttribute("role", "status");
  const pair = element("div"), controls = element("div"); controls.className = "hub-model-toolbar";
  const connect = button("Connect bot", () => void update({ action: "connect", token: token.value.trim() }));
  const refresh = button("Check connection", () => void update());
  const reconnect = button("Reconnect", () => void update({ action: "reconnect" })),setup=element("details"),setupTitle=element("summary","Connect or change bot");setup.append(setupTitle,token,connect);controls.append(refresh,reconnect);
  dialog.append(header, intro, status, controls, pair,setup); root.body.append(dialog);
  const removeBack = installMobileWidgetBack(dialog, header, () => dismiss());
  let busy = false, timer: number | undefined;
  function dismiss() { view.clearTimeout(timer); token.value = ""; dialog.close(); }
  async function update(command?: unknown) {
    if (busy || lifetime.signal.aborted) return;
    busy = true; connect.disabled=true;controls.querySelectorAll("button").forEach(b => b.disabled = true); view.clearTimeout(timer);
    try {
      const response = await view.fetch("/api/hub/telegram", { method: command ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
        headers: { "x-hub-telegram": "1", ...(command ? { "content-type": "application/json" } : {}) }, body: command ? JSON.stringify(command) : undefined,
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(50_000)]) });
      if (!response.ok) throw new Error("Telegram connection unavailable. Check the connection before repeating an action.");
      const value = await response.json();
      status.textContent = `${value.accountLabel ? value.accountLabel + " · " : ""}${value.state}`;
      if(command&&(command as any).action==="connect")token.value="";
      if(!command&&["unconfigured","disconnected","disabled"].includes(value.state))setup.open=true;
      pair.replaceChildren();
      if (value.state === "pairing") {
        pair.append(element("p", "Open your bot in Telegram and send /start. Approve only the request whose code matches your Telegram message."));
        if (value.request) {
          pair.append(element("p", `${value.request.senderLabel} · Pairing code: ${value.request.code}`));
          pair.append(button("Approve this account", () => void update({ action: "approve", requestId: value.request.requestId })));
        }
      }
      if (dialog.open && value.state === "pairing") timer = view.setTimeout(() => void update(), 3000);
    } catch (error) { if (!lifetime.signal.aborted) status.textContent = (error as Error).message; }
    finally { busy = false; controls.querySelectorAll("button").forEach(b => b.disabled = false);connect.disabled=false; }
  }
  dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
  return () => { lifetime.abort(); dismiss(); removeBack(); dialog.remove(); launcher.remove(); removeStyles(); };
}
