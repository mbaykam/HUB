import { defineOverlayStyle } from "../shared/style-runtime.ts";
import { installMobileWidgetBack } from "./mobile-widget-back.ts";
import type { HubModelCatalog, HubCatalogModel } from "../../model-catalog-contract.ts";
import styles from "./mobile-models.css";
const installStyles = defineOverlayStyle("hub-mobile-models", styles);
export function installMobileModels(container: HTMLElement, root: Document, currentSession: () => string | undefined, options?: { choose(model: HubCatalogModel, effort: string): Promise<void> | void; beforeManageProviders?(): void }) {
  const view = root.defaultView!;
  const lifetime = new AbortController(), removeStyles = installStyles(root);
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const el = root.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
  const button = (text: string, run: () => void) => { const el = element("button", text); el.type = "button"; el.addEventListener("click", run); return el; };
  const launcher = button("Models & providers", () => void open()); launcher.setAttribute("data-hub-models-launcher", "");
  launcher.setAttribute("aria-haspopup", "dialog"); container.append(launcher);
  const dialog = element("dialog"); dialog.setAttribute("data-hub-models", ""); dialog.setAttribute("aria-label", "Models and providers");
  const header = element("header"), close = button("Done", () => dismiss()); header.append(element("h2", "Models & providers"), close);
  const toolbar = element("div"); toolbar.className = "hub-model-toolbar";
  const search = element("input"); search.type = "search"; search.placeholder = "Search models"; search.setAttribute("aria-label", "Search models");
  const provider = element("select"); provider.setAttribute("aria-label", "Provider");
  const sort = element("select"); sort.setAttribute("aria-label", "Sort models");
  for (const [value, text] of [["name", "Name"], ["newest", "Newest"], ["price", "Lowest price"]]) { const option = element("option", text); option.value = value!; sort.append(option); }
  const refresh = button("Refresh catalogue", () => void load(true));
  let onlyFavorites = false;
  const favorites = button("Favorites", () => { onlyFavorites = !onlyFavorites; favorites.setAttribute("aria-pressed", String(onlyFavorites)); render(); }); favorites.setAttribute("aria-pressed", "false");
  const manage = button("Add / manage providers", () => {
    dismiss();
    options?.beforeManageProviders?.();
    root.querySelector<HTMLButtonElement>('[data-slot="sidebar.settings"] button[aria-haspopup="dialog"]')?.click();
    view.setTimeout(() => {
      const tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-slot="sidebar.settings"] [role="dialog"] nav button')];
      tabs.find(b => /models|模型/i.test(b.textContent ?? ""))?.click();
    }, 150);
  });
  toolbar.append(search, provider, sort, refresh, favorites, manage);
  const status = element("p"); status.setAttribute("role", "status");
  const explanation = element("p", "OpenRouter uses API credits. Codex uses your existing subscription. Refreshing the catalogue does not change your selected model."); explanation.className = "hub-model-note";
  const scope = element("select"); scope.setAttribute("aria-label", "Apply model to");
  const current = element("option", "Current chat + default for new chats"); current.value = "select";
  const next = element("option", "New chats only"); next.value = "default"; scope.append(current, next);
  scope.hidden = !!options;
  const list = element("div"); list.className = "hub-model-list";
  dialog.append(header, toolbar, explanation, scope, status, list); root.body.append(dialog);
  const removeBack = installMobileWidgetBack(dialog, header, () => dismiss());
  let catalog: HubModelCatalog | undefined, busy = false, ticket = 0, timer: number | undefined;
  function dismiss() { ticket++; view.clearTimeout(timer); dialog.close(); }
  async function request(command?: unknown) {
    const response = await view.fetch("/api/hub/models", { method: command ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
      headers: { "x-hub-models": "1", ...(command ? { "content-type": "application/json" } : {}) }, body: command ? JSON.stringify(command) : undefined,
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(40_000)]) });
    if (!response.ok) throw new Error(response.status === 409 ? "This model could not be selected. Your previous choice is preserved; check the provider connection and try again." : "Models are unavailable. Check the HUB connection and retry.");
    return response.json();
  }
  function render() {
    if (!catalog) return;
    const query = search.value.trim().toLowerCase(), filter = provider.value;
    const models = catalog.models.filter(m => (!onlyFavorites || m.favorite) && (!filter || m.provider === filter) && `${m.name} ${m.id}`.toLowerCase().includes(query));
    models.sort(sort.value === "newest" ? (a,b) => (b.created ?? 0) - (a.created ?? 0) : sort.value === "price" ? (a,b) => (a.pricing?.input ?? Infinity) - (b.pricing?.input ?? Infinity) : (a,b) => a.name.localeCompare(b.name));
    list.replaceChildren();
    const meta = element("p", `${models.length} models${models.length > 100 ? " · refine search to see more" : ""}`); list.append(meta);
    for (const model of models.slice(0, 100)) list.append(card(model));
    if (!models.length) list.append(element("p", "No matching models."));
  }
  function card(m: HubCatalogModel) {
    const row = element("article"); row.setAttribute("data-model-id", m.id);
    row.append(element("h3", m.name), element("p", `${m.provider} · ${m.id}`));
    row.append(button(m.favorite ? "★ Saved" : "☆ Favorite", () => void favorite(m)));
    const facts = [m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : "", m.tools ? "Tools" : "", m.input.includes("image") ? "Images" : "", m.reasoning ? "Reasoning" : ""].filter(Boolean);
    row.append(element("p", facts.join(" · ")));
    if (m.pricing) row.append(element("p", `$${m.pricing.input.toFixed(3)} input / $${m.pricing.output.toFixed(3)} output per 1M tokens`));
    const effort = element("select"); effort.setAttribute("aria-label", `Reasoning for ${m.name}`);
    const base = element("option", "Provider default"); base.value = ""; effort.append(base);
    for (const e of m.efforts ?? []) { const option = element("option", e.name); option.value = e.id; effort.append(option); }
    if (m.efforts?.length) row.append(effort);
    const select = button(m.enabled ? "Use model" : m.provider === "openrouter" ? "Add & use model" : "Adapter update needed", () => void choose(m, effort.value));
    select.disabled = busy || (!m.enabled && m.provider !== "openrouter"); row.append(select);
    return row;
  }
  async function choose(m: HubCatalogModel, effort: string) {
    if (busy) return;
    const sessionId = currentSession();
    if (!options && scope.value === "select" && !sessionId) { status.textContent = "Open a chat first, or choose New chats only."; return; }
    busy = true; render(); status.textContent = "Saving selection…";
    try { await request({ action: options ? "enable" : scope.value, provider: m.provider, model: m.id, ...(!options && scope.value === "select" ? { sessionId } : {}), ...(effort ? { reasoningEffort: effort } : {}) });
      if (options) { await options.choose(m, effort); dismiss(); return; }
      status.textContent = `${m.name} selected. Existing work keeps its current model.`;
    } catch (error) { status.textContent = (error as Error).message; }
    finally { busy = false; render(); }
  }
  async function favorite(m: HubCatalogModel) {
    if (busy) return; busy = true;
    try { catalog = await request({ action: "favorite", provider: m.provider, model: m.id, selected: !m.favorite }); }
    catch (error) { status.textContent = (error as Error).message; }
    finally { busy = false; render(); }
  }
  async function load(force = false) {
    if (busy) return;
    const own = ++ticket; busy = true; refresh.disabled = true;
    if (!catalog) status.textContent = "Loading models…";
    try {
      const value = await request(force ? { action: "refresh" } : undefined) as HubModelCatalog;
      if (own !== ticket || !dialog.open) return;
      if (!Array.isArray(value.models) || !Array.isArray(value.providers)) throw new Error("Invalid catalogue response.");
      catalog = value;
      const selected = provider.value; provider.replaceChildren(element("option", "All providers")); provider.firstElementChild!.setAttribute("value", "");
      const ids = new Map(value.providers.map(p => [p.id, p.name]));
      for (const m of value.models) if (!ids.has(m.provider)) ids.set(m.provider, m.provider);
      for (const [id, name] of ids) { const option = element("option", name); option.value = id; provider.append(option); }
      provider.value = selected;
      status.textContent = value.warning ?? (value.refreshedAt ? `Catalogue updated ${new Date(value.refreshedAt).toLocaleString()}${value.stale ? " · refreshing…" : ""}` : "Installed models shown. Fetching the live catalogue…");
      render();
      view.clearTimeout(timer); if (value.stale) timer = view.setTimeout(() => void load(), 3000);
    } catch (error) { if (own === ticket) status.textContent = (error as Error).message; }
    finally { busy = false; refresh.disabled = false; render(); }
  }
  async function open() { dialog.showModal(); current.disabled = !currentSession(); if (current.disabled) scope.value = "default"; await load(); }
  search.addEventListener("input", render); provider.addEventListener("change", render); sort.addEventListener("change", render);
  dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
  return () => { lifetime.abort(); dismiss(); removeBack(); dialog.remove(); launcher.remove(); removeStyles(); };
}
