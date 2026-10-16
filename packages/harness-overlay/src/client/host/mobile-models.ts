import { defineOverlayStyle } from "../shared/style-runtime.ts";
import { installMobileWidgetBack } from "./mobile-widget-back.ts";
import type { HubModelCatalog, HubCatalogModel } from "../../model-catalog-contract.ts";
import type {VoiceProfile} from "../../voice-profile-contract.ts";
import styles from "./mobile-models.css";
const installStyles = defineOverlayStyle("hub-mobile-models", styles);
export function installMobileModels(container: HTMLElement, root: Document, currentSession: () => string | undefined, options?: { choose?(model: HubCatalogModel, effort: string,parameters:{temperature?:number;maxTokens?:number}): Promise<void> | void; browseOnly?:boolean;initialRoute?:VoiceProfile["route"];beforeManageProviders?(): void }) {
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
  const connections=element("details");connections.append(element("summary","Provider connections"));
  const manage = button("Connections", () => {connections.open=!connections.open;connections.scrollIntoView?.({block:"nearest"});});
  toolbar.append(search, provider, sort, refresh, favorites, manage);
  const status = element("p"); status.setAttribute("role", "status");
  const explanation = element("p", options?.browseOnly?"Browse live capabilities and add available models here. Choose a character’s model and its options in Settings → Characters.":"Options follow the selected model and installed adapter. Refreshing the catalogue keeps your choices. OpenRouter uses API credits; Codex uses your existing subscription."); explanation.className = "hub-model-note";
  const scope = element("select"); scope.setAttribute("aria-label", "Apply model to");
  const current = element("option", "Current chat + default for new chats"); current.value = "select";
  const next = element("option", "New chats only"); next.value = "default"; scope.append(current, next);
  scope.hidden = !!options;
  const list = element("div"); list.className = "hub-model-list";
  dialog.append(header, toolbar, explanation,connections, scope, status, list); root.body.append(dialog);
  const removeBack = installMobileWidgetBack(dialog, header, () => dismiss());
  let catalog: HubModelCatalog | undefined, busy = false, ticket = 0, timer: number | undefined;
  const drafts=new Map<string,{effort:string;temperature:string;maxTokens:string;expanded:boolean}>();
  const draft=(m:HubCatalogModel)=>{const id=JSON.stringify([m.provider,m.id]);let d=drafts.get(id);if(!d){const saved=options?.initialRoute?.provider===m.provider&&options.initialRoute.model===m.id?options.initialRoute:undefined;d={effort:saved?.reasoningEffort??"",temperature:saved?.temperature===undefined?"":String(saved.temperature),maxTokens:saved?.maxTokens===undefined?"":String(saved.maxTokens),expanded:!!saved};drafts.set(id,d);}return d;};
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
    const effort = element("select"); effort.disabled=!!options?.browseOnly;effort.setAttribute("aria-label", `Reasoning for ${m.name}`);
    const base = element("option", "Provider default"); base.value = ""; effort.append(base);
    for (const e of m.efforts ?? []) { const option = element("option", e.name); option.value = e.id; effort.append(option); }
    const settings=element("details"),d=draft(m);settings.open=d.expanded;settings.append(element("summary","Model options & capabilities"));settings.addEventListener("toggle",()=>d.expanded=settings.open);
    const field=(label:string,input:HTMLElement)=>{const l=element("label");l.append(element("span",label),input);settings.append(l);};
    if(m.efforts?.length){if(d.effort&&!m.efforts.some(e=>e.id===d.effort)){const old=element("option",d.effort+" · unavailable");old.value=d.effort;old.disabled=true;effort.append(old);}effort.value=d.effort;effort.addEventListener("change",()=>d.effort=effort.value);field("Reasoning effort",effort);settings.append(element("small",`Levels reported by the installed adapter${m.defaultEffort?" · default: "+m.defaultEffort:""}.`));}
    else if(m.reasoning)settings.append(element("p","Reasoning is advertised, but selectable levels are not reported by this adapter. Provider default is used."));
    const maxTokens=element("input");maxTokens.type="number";maxTokens.disabled=!!options?.browseOnly;maxTokens.min="1";maxTokens.max=String(m.maxTokens??m.contextWindow??1000000);maxTokens.placeholder=m.defaults?.max_tokens?"Default: "+m.defaults.max_tokens:"Provider default";maxTokens.value=d.maxTokens;maxTokens.setAttribute("aria-label",`Output tokens for ${m.name}`);maxTokens.addEventListener("input",()=>d.maxTokens=maxTokens.value);field("Maximum output tokens",maxTokens);
    if(m.editableParameters?.includes("temperature")){const temp=element("input");temp.type="number";temp.disabled=!!options?.browseOnly;temp.min="0";temp.max="2";temp.step="0.1";temp.value=d.temperature;temp.placeholder=m.defaults?.temperature!=null?"Default: "+m.defaults.temperature:"Provider default";temp.setAttribute("aria-label",`Temperature for ${m.name}`);temp.addEventListener("input",()=>d.temperature=temp.value);field("Temperature",temp);}
    if(m.description)settings.append(element("p",m.description));
    settings.append(element("p",`Input: ${m.input.join(", ")} · Output limit: ${m.maxTokens?.toLocaleString()??"not disclosed"}`));
    if(m.supportedParameters){settings.append(element("small","Provider-advertised parameters: "+(m.supportedParameters.join(", ")||"none disclosed")));const others=m.supportedParameters.filter(p=>!m.editableParameters?.includes(p));if(others.length)settings.append(element("small","Provider capabilities without a per-character control in this adapter: "+others.join(", ")+". Tools and response structure are managed by the harness; these are not editable overrides."));}
    else settings.append(element("small","This provider does not publish a complete parameter schema. Only verified adapter controls are shown."));
    row.append(settings);
    const select = button(options?.browseOnly?m.enabled?"Available":"Add to available models":m.enabled ? "Use model" : m.provider === "openrouter" ? "Add & use model" : "Adapter update needed", () => void choose(m,d));
    const connected=catalog?.providers.some(p=>p.id===m.provider);if(!connected)select.textContent="Provider adapter unavailable";
    select.disabled = busy || !connected || (!m.enabled && m.provider !== "openrouter"); row.append(select);
    return row;
  }
  async function choose(m: HubCatalogModel, d:{effort:string;temperature:string;maxTokens:string}) {
    if (busy) return;
    const sessionId = currentSession();
    if (!options && scope.value === "select" && !sessionId) { status.textContent = "Open a chat first, or choose New chats only."; return; }
    const effort=d.effort,parameters={...(d.temperature!==""&&m.editableParameters?.includes("temperature")?{temperature:Number(d.temperature)}:{}),...(d.maxTokens!==""?{maxTokens:Number(d.maxTokens)}:{})};
    if(parameters.maxTokens!==undefined&&(!Number.isInteger(parameters.maxTokens)||parameters.maxTokens<1||parameters.maxTokens>(m.maxTokens??m.contextWindow??1000000))||parameters.temperature!==undefined&&(!Number.isFinite(parameters.temperature)||parameters.temperature<0||parameters.temperature>2)){status.textContent="Check output tokens and temperature. Leave a field empty to use its default.";return;}
    busy = true; render(); status.textContent = "Saving selection…";
    try { await request({ action: options ? "enable" : scope.value, provider: m.provider, model: m.id, ...(!options && scope.value === "select" ? { sessionId } : {}), ...(!options?.browseOnly&&effort ? { reasoningEffort: effort } : {}),...(!options?.browseOnly?parameters:{}) });
      if (options?.choose) { await options.choose(m, effort,parameters); dismiss(); return; }
      if(options?.browseOnly){m.enabled=true;status.textContent=`${m.name} is available. Choose it for a character in Settings → Characters.`;return;}
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
      connections.replaceChildren(element("summary","Provider connections"),...value.providers.map(p=>element("p",p.name+" · adapter available")),element("small","Adapter availability does not verify sign-in or remaining credits. Existing connections are preserved. A catalogue entry is not a new account connection. Configure new provider credentials on your HUB host; character settings never store keys."));
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
