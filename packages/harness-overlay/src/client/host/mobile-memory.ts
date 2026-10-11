import { defineOverlayStyle } from "../shared/style-runtime.ts";
import styles from "./mobile-memory.css";
import { installKnowledgeControls } from "./mobile-knowledge.ts";
const installStyles = defineOverlayStyle("hub-mobile-memory", styles);
/** Compact memory controls; note content is always rendered as text, never HTML. */
export function installMobileMemory(container: HTMLElement, root: Document): () => void {
  const view = root.defaultView;
  if (!view) return () => {};
  const panel = root.createElement("details");
  panel.setAttribute("data-hub-memory", "");
  const heading = root.createElement("summary");
  heading.textContent = "Knowledge AI";
  const status = root.createElement("p");
  status.setAttribute("role", "status");
  const notes = root.createElement("div");
  const explanation = root.createElement("p");
  explanation.textContent = "Saved automatically across chats. Forget removes the saved passage; your original chats stay intact.";
  const refresh = root.createElement("button");
  refresh.type = "button"; refresh.textContent = "Refresh";
  panel.append(heading, status, explanation, refresh, notes);
  const removeStyles = installStyles(root);
  container.append(panel);
  const lifetime = new AbortController();
  let busy = false;
  let removeKnowledge: (() => void) | undefined;
  async function load(): Promise<void> {
    if (busy || lifetime.signal.aborted) return;
    busy = true;
    refresh.disabled = true;
    try {
      const response = await view!.fetch("/api/hub/memory", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]) });
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      if (data.secondBrain) {
        if (!removeKnowledge) {
          status.remove(); explanation.remove(); refresh.remove();
          removeKnowledge = installKnowledgeControls(notes, root, data);
        }
        return;
      }
      if (!data.enabled || typeof data.content !== "string") throw new Error("unavailable");
      const healthy = data.status === "ready" || data.status === "reflecting";
      status.textContent = data.status === "reflecting" ? "On · updating memory…" : healthy ? "On · automatic memory is active" : "On · a memory operation needs attention";
      notes.replaceChildren();
      for (const passage of data.content.split("\n").filter((line: string) => line.trim() && !line.startsWith("#"))) {
        const row = root.createElement("article");
        const text = root.createElement("p"); text.textContent = passage;
        const forget = root.createElement("button"); forget.type = "button"; forget.textContent = "Forget";
        let confirmed = false;
        forget.addEventListener("click", async () => {
          if (!confirmed) { confirmed = true; forget.textContent = "Confirm forget"; return; }
          if (busy) return;
          busy = true; forget.disabled = true; refresh.disabled = true;
          try {
            const result = await view!.fetch("/api/hub/memory", { method: "POST", credentials: "same-origin", signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
              headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "forget", passage }) });
            if (!result.ok) throw new Error("forget failed");
            status.textContent = "Forgotten. Original chats are unchanged.";
            row.remove();
          } catch { status.textContent = "Couldn’t forget this passage. Refresh and try again."; forget.disabled = false; }
          finally { busy = false; refresh.disabled = false; }
        });
        row.append(text, forget); notes.append(row);
      }
    } catch { if (!lifetime.signal.aborted) status.textContent = "Memory is not available on this host yet."; }
    finally { busy = false; refresh.disabled = false; }
  }
  panel.addEventListener("toggle", () => { if (panel.open) void load(); });
  refresh.addEventListener("click", () => { void load(); });
  return () => { lifetime.abort(); removeKnowledge?.(); panel.remove(); removeStyles(); };
}
