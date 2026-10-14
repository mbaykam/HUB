import { defineOverlayStyle } from "../shared/style-runtime.ts";
import { installMobileMemory } from "./mobile-memory.ts";
import { installMobileTelegram } from "./mobile-telegram.ts";
import { installMobileUsageMeter } from "./mobile-usage-meter.ts";
import { installMobileVoiceHistory, type VoiceHistorySessions } from "./mobile-voice-history.ts";
import type { VoiceHistoryClient } from "./voice-history.ts";
import styles from "./hub-settings-controls.css";

const installStyles = defineOverlayStyle("hub-settings-controls", styles);

/** Reuse the existing controls and their host APIs inside native Settings. */
export function installHubSettingsControls(
  container: HTMLElement,
  root: Document,
  sessions: VoiceHistorySessions,
  history: VoiceHistoryClient,
): () => void {
  const view = root.defaultView;
  if (!view) return () => {};
  const removeStyles = installStyles(root);
  container.setAttribute("data-hub-settings-controls", "");
  const heading = root.createElement("h3");
  heading.textContent = "Assistants & integrations";
  const intro = root.createElement("p");
  intro.textContent = "Manage your characters, saved knowledge and Telegram connection.";
  const connections = root.createElement("div");
  connections.setAttribute("data-hub-settings-connections", "");
  const characters = root.createElement("button");
  characters.type = "button";
  characters.setAttribute("data-hub-characters-launcher", "");
  characters.textContent = "Characters";
  characters.addEventListener("click", () => {
    view.dispatchEvent(new view.Event("hub:characters-open"));
  });
  connections.append(characters);
  const knowledge = root.createElement("div");
  const usage = root.createElement("div");
  const voiceHistory = root.createElement("div");
  container.append(heading, intro, connections, knowledge, usage, voiceHistory);
  const removeTelegram = installMobileTelegram(connections, root);
  const removeKnowledge = installMobileMemory(knowledge, root);
  const removeUsage = installMobileUsageMeter(usage, root);
  const removeVoiceHistory = installMobileVoiceHistory(voiceHistory, root, sessions, () => {
    // Opening a transcript must dismiss the Settings modal above the chat.
    const dialog = root.querySelector<HTMLElement>('[data-slot="sidebar.settings"] [role="dialog"]');
    const close = dialog?.querySelector<HTMLButtonElement>("[data-hub-settings-native-close]")
      ?? dialog?.querySelector<HTMLButtonElement>(":scope > nav + * > :first-child > button");
    close?.click();
    root.querySelector<HTMLButtonElement>("[data-minke-mobile-right-drawer-close]")?.click();
  }, history);
  return () => {
    removeVoiceHistory(); removeUsage(); removeKnowledge(); removeTelegram();
    container.replaceChildren();
    container.removeAttribute("data-hub-settings-controls");
    removeStyles();
  };
}
