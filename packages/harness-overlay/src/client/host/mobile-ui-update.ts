interface UiVersion { id: string; label: string; compatibility: string }
function version(root: Document): UiVersion | undefined {
  return (root.defaultView as (Window & { __HUB_UI_RELEASE__?: UiVersion }) | null)?.__HUB_UI_RELEASE__;
}
export function pwaUiAsset(root: Document, file: "memory-graph-browser.js" | "voice-browser.js", fallback: string): string {
  const id = version(root)?.id;
  return id && /^[a-f0-9]{64}$/.test(id) ? `/api/hub/ui/asset?release=${id}&file=${file}` : fallback;
}
/** Manual refresh only: never reload a talking assistant or unsent draft. */
export function installMobileUiUpdate(container: HTMLElement, root: Document): () => void {
  const view = root.defaultView;
  if (!view) return () => {};
  const row = root.createElement("div"); row.setAttribute("data-hub-ui-update", "");
  const text = root.createElement("p"), button = root.createElement("button"); button.type = "button"; button.textContent = "Check UI update";
  text.textContent = `PWA UI · ${version(root)?.label ?? "Built-in"}`;
  row.append(text, button); container.append(row);
  const lifetime = new AbortController(); let available = false;
  button.addEventListener("click", async () => {
    if (available) {
      if (view.confirm("Reload HUB to apply the UI update? Finish your voice call and send or copy any draft first.")) view.location.reload();
      return;
    }
    button.disabled = true;
    try {
      const response = await view.fetch("/api/hub/ui/status", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]) });
      if (!response.ok) throw new Error("unavailable");
      const next = await response.json() as UiVersion & { fallback?: boolean };
      if (typeof next.id !== "string" || typeof next.label !== "string") throw new Error("invalid");
      available = next.id !== (version(root)?.id ?? "builtin");
      text.textContent = next.fallback ? "Update unavailable · using built-in UI" : available ? `UI update ready · ${next.label}` : `PWA UI · ${next.label} · up to date`;
      button.textContent = available ? "Reload to apply" : "Check again";
    } catch { if (!lifetime.signal.aborted) text.textContent = "Couldn’t check for UI updates. Try again."; }
    finally { button.disabled = false; }
  });
  return () => { lifetime.abort(); row.remove(); };
}
