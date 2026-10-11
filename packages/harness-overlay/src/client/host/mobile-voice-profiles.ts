import { defineOverlayStyle } from "../shared/style-runtime.ts";
import { installMobileWidgetBack } from "./mobile-widget-back.ts";
import { voiceProfileInputSchema, voiceProfilesStateSchema, speechDownloadStatusSchema, localSpeechCatalogSchema, type SpeechModelInstall, type VoiceProfile, type VoiceProfileInput, type VoiceProfilesState, type VoiceProfileCommand, type LocalSpeechCatalog } from "../../voice-profile-contract.ts";
import styles from "./mobile-voice-profiles.css";
const installStyles = defineOverlayStyle("hub-mobile-voice-profiles", styles);
type Active = { id: string; name: string; revision: number };
type Catalog = { providers: { id: string; name: string }[]; tools: { name: string; description: string }[]; speech: LocalSpeechCatalog };
type Model = { id: string; provider: string; name: string; efforts: { id: string; name: string }[] };

/** Saved personalities are settings, not chat copies or client permissions.
 * The host captures the selected revision at admission; edits affect next call.
 * Catalogs load on demand without importing the audio SDK or starting devices. */
export function createMobileVoiceProfiles(root: Document) {
  const view = root.defaultView!, lifetime = new AbortController();
  const removeStyles = installStyles(root);
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const result = root.createElement(tag); if (text !== undefined) result.textContent = text; return result;
  };
  const button = (text: string, run: () => void) => { const result = element("button", text); result.type = "button"; result.addEventListener("click", run); return result; };
  const launcher = button("Voice personality", () => void open()); launcher.setAttribute("data-voice-personality", "");
  launcher.setAttribute("aria-haspopup", "dialog");
  const dialog = element("dialog"); dialog.setAttribute("data-hub-voice-profiles", ""); dialog.setAttribute("aria-label", "Voice personalities");
  const heading = element("h2", "Voice personalities");
  const close = button("Done", () => dismiss());
  const header = element("header"); header.append(heading, close);
  const notice = element("p", "One shared memory. Your choice takes effect on the next voice call."); notice.setAttribute("data-profile-notice", "");
  const status = element("p"); status.setAttribute("role", "status");
  const content = element("div"); content.setAttribute("data-profile-content", "");
  dialog.append(header, notice, status, content); root.body.append(dialog);
  const removeBack = installMobileWidgetBack(dialog, header, () => dismiss());
  let state: VoiceProfilesState | undefined, active: Active | undefined, catalog: Catalog | undefined;
  let busy = false, dirty = false, editing = false, epoch = 0, reloadEpoch = 0;
  let downloadTimer: number | undefined;
  function stopPolling() { view.clearTimeout(downloadTimer); downloadTimer = undefined; }
  function say(text: string) { status.textContent = text; }
  function dismiss() { if (busy) return; if (dirty && !view.confirm("Discard unsaved personality changes?")) return; dirty = false; epoch++; stopPolling(); dialog.close(); }
  dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
  function label() {
    const selected = state?.profiles.find(profile => profile.id === state?.selectedId);
    launcher.textContent = active ? `${active.name} · Active` : selected ? `${selected.name} · Voice` : "Voice personality";
    notice.textContent = active ? `${active.name} stays active for this call. Saved changes apply to your next call. Memory stays shared.` : "One shared memory. Your choice takes effect on the next voice call.";
  }
  async function request(path: string, command?: VoiceProfileCommand) {
    const response = await view.fetch(`/api/hub/voice/${path}`, { method: command ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
      headers: command ? { "content-type": "application/json", "x-hub-voice-profiles": "1" } : undefined,
      body: command ? JSON.stringify(command) : undefined, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(25000)]),
    });
    if (!response.ok) {
      if (response.status === 409) throw new Error("Settings changed elsewhere. Your edits are still here. Go back and reload before trying again.");
      if ([401, 403].includes(response.status)) throw new Error("Sign in to HUB again to manage personalities.");
      throw new Error(command ? "Changes were not confirmed. Go back and reload before trying again." : "Voice settings could not load. Try again.");
    }
    return response.json();
  }
  function accept(value: any) {
    state = voiceProfilesStateSchema.parse({ revision: value.revision, selectedId: value.selectedId, profiles: value.profiles });
    if (value.active && typeof value.active.name === "string") active = value.active;
    else active = undefined;
    label();
  }
  async function reload() {
    const ticket = ++reloadEpoch;
    try {
      const response = await request("profiles");
      if (ticket !== reloadEpoch || lifetime.signal.aborted) return false;
      accept(response); if (dialog.open && !editing) list(); return true;
    } catch (error) { if (ticket === reloadEpoch && !lifetime.signal.aborted) say((error as Error).message); return false; }
  }
  async function mutate(command: VoiceProfileCommand) {
    if (busy) return;
    busy = true; content.inert = true; reloadEpoch++; dialog.setAttribute("data-saving", ""); say("Saving…");
    try { accept(await request("profiles", command)); dirty = false; editing = false; list(); say("Saved for your next voice call."); }
    catch (error) { if (!lifetime.signal.aborted) say((error as Error).message); }
    finally { busy = false; content.inert = false; dialog.removeAttribute("data-saving"); }
  }
  function list() {
    if (!state) return;
    epoch++; stopPolling(); editing = false; dirty = false; content.replaceChildren(); heading.textContent = "Voice personalities";
    const actions = element("div"); actions.setAttribute("data-profile-actions", "");
    actions.append(button("New personality", () => void edit()), button("Reload", () => { say("Loading…"); void reload().then(ok => { if (ok) say(""); }); })); content.append(actions);
    for (const profile of state.profiles) {
      const row = element("article"); row.setAttribute("data-profile-row", "");
      const selected = profile.id === state.selectedId; row.toggleAttribute("data-selected", selected);
      const choose = button("", () => void mutate({ type: "select", revision: state!.revision, id: profile.id })); choose.setAttribute("aria-pressed", String(selected));
      choose.setAttribute("aria-label", `Use ${profile.name}`);
      choose.append(element("strong", profile.name), element("span", `${selected ? "Selected · " : ""}${profile.route.model}`));
      const customize = button("Edit", () => void edit(profile)); customize.setAttribute("aria-label", `Edit ${profile.name}`);
      row.append(choose, customize); content.append(row);
    }
  }
  async function edit(profile?: VoiceProfile) {
    if (!state || busy) return;
    const ticket = ++epoch; editing = true; dirty = false; content.replaceChildren(); say("Loading available models and tools…");
    heading.textContent = profile ? "Edit personality" : "New personality";
    try {
      catalog ??= await request("catalog") as Catalog;
      if (ticket !== epoch || lifetime.signal.aborted || !dialog.open) return;
      const value: VoiceProfileInput = structuredClone(profile ?? { ...state.profiles.find(item => item.id === state!.selectedId)!, name: "", instructions: "" });
      const { id: _id, ...seed } = value as VoiceProfile;
      const form = element("form"); form.setAttribute("data-profile-form", "");
      form.addEventListener("input", () => { dirty = true; }); form.addEventListener("change", () => { dirty = true; });
      const field = (text: string, input: HTMLElement, parent: HTMLElement = form) => { const wrap = element("label"); input.setAttribute("aria-label", text); wrap.append(element("span", text), input); parent.append(wrap); };
      const name = element("input"); name.value = seed.name; name.required = true; name.maxLength = 60; name.autocomplete = "off"; field("Name", name);
      const instructions = element("textarea"); instructions.value = seed.instructions; instructions.maxLength = 12000; instructions.rows = 4; instructions.placeholder = "How should this personality speak and help you?"; field("Personality instructions", instructions);
      const section = (title: string, open = false) => { const details = element("details"); details.open = open; details.append(element("summary", title)); form.append(details); return details; };
      const brain = section("Conversation model", true), speech = section("Local speech"), tools = section("Tools & permissions");
      const option = (select: HTMLSelectElement, value: string, text: string, disabled = false) => { const node = element("option", text); node.value = value; node.disabled = disabled; select.append(node); };
      const provider = element("select"); provider.required = true;
      for (const item of catalog.providers) option(provider, item.id, item.name);
      if (!catalog.providers.some(item => item.id === seed.route.provider)) option(provider, seed.route.provider, `${seed.route.provider} · Unavailable`, true);
      provider.value = seed.route.provider; field("Connection", provider, brain);
      const model = element("select"); model.required = true; field("Language model", model, brain);
      const effort = element("select"); field("Reasoning", effort, brain);
      const modelStatus = element("p"); modelStatus.setAttribute("role", "status"); brain.append(modelStatus);
      let models: Model[] = [], loadingModels = false, modelEpoch = 0;
      function efforts(wanted = "") {
        effort.replaceChildren(); option(effort, "", "Provider default");
        const available = models.find(item => item.id === model.value)?.efforts ?? [];
        for (const item of available) option(effort, item.id, item.name);
        if (wanted && !available.some(item => item.id === wanted)) option(effort, wanted, `${wanted} · Unavailable`, true);
        effort.value = wanted; effort.disabled = !available.length && !wanted;
      }
      async function loadModels(wanted = "", wantedEffort = "") {
        const version = ++modelEpoch; loadingModels = true; model.disabled = true; model.replaceChildren(); option(model, "", "Loading models…"); modelStatus.textContent = "";
        try {
          const result = await request(`catalog?provider=${encodeURIComponent(provider.value)}`) as { models: Model[] };
          if (version !== modelEpoch || ticket !== epoch || lifetime.signal.aborted) return;
          models = result.models.filter(item => item.provider === provider.value);
          model.replaceChildren(); option(model, "", "Choose a model");
          for (const item of models) option(model, item.id, item.name);
          if (wanted && !models.some(item => item.id === wanted)) option(model, wanted, `${wanted} · Unavailable`, true);
          model.value = wanted; efforts(wantedEffort); model.disabled = false;
          if (wanted && !models.some(item => item.id === wanted)) modelStatus.textContent = "This saved model is unavailable. Choose a listed model; HUB will not substitute one.";
        } catch (error) { if (version === modelEpoch && ticket === epoch) modelStatus.textContent = (error as Error).message; }
        finally { if (version === modelEpoch) loadingModels = false; }
      }
      provider.addEventListener("change", () => void loadModels()); model.addEventListener("change", () => efforts());
      const stt = element("select"); field("Speech to text", stt, speech);
      const tts = element("select"); field("Text to speech", tts, speech);
      const voice = element("select"); field("Voice", voice, speech);
      const ttsKey = (item: { engine: string; model: string }) => `${item.engine}:${item.model}`;
      const localTts = () => catalog!.speech.tts.find(item => ttsKey(item) === tts.value);
      function renderVoices(wanted: string) {
        voice.replaceChildren();
        for (const item of localTts()?.voices ?? []) option(voice, item, localTts()?.engine === "piper" ? "LJ · American" : item.replace(/^[ab][fm]_/, "").replace(/^./, text => text.toUpperCase()) + (item.startsWith("b") ? " · British" : " · American"));
        if (!localTts()?.voices.some(item => item === wanted)) option(voice, wanted, wanted ? `${wanted} · Not installed` : "Choose a voice", !!wanted);
        voice.value = wanted;
      }
      function renderSpeech(sttValue = stt.value, ttsValue = tts.value, voiceValue = voice.value) {
        stt.replaceChildren(); tts.replaceChildren();
        for (const item of catalog!.speech.stt) option(stt, item.model, `Whisper ${item.model}${item.available ? " · Installed" : " · Not installed"}`, !item.available);
        for (const item of catalog!.speech.tts) option(tts, ttsKey(item), `${item.engine === "kokoro" ? "Kokoro 82M" : "Piper LJ Speech"}${item.available ? " · Installed" : " · Not installed"}`, !item.available);
        stt.value = sttValue; tts.value = ttsValue; renderVoices(voiceValue);
      }
      tts.addEventListener("change", () => renderVoices(""));
      renderSpeech(seed.speech.stt.model, ttsKey(seed.speech.tts), seed.speech.tts.voice);
      speech.append(element("p", "Speech is processed locally on your host PC. Changing these settings applies to your next call."));
      const downloadSection = element("details"); downloadSection.append(element("summary", "Manage model downloads")); speech.append(downloadSection);
      downloadSection.append(element("p", "Downloads use your host PC’s internet and storage, and continue if you close this screen. Piper uses a separately installed optional runtime (GPL-3.0-or-later)."));
      const downloadStatus = element("p"); downloadStatus.setAttribute("role", "status");
      const downloadList = element("div"); downloadList.setAttribute("data-speech-downloads", ""); downloadSection.append(downloadStatus, downloadList);
      let downloading = false, downloadRequest = false, completedId = "";
      const validEditor = () => ticket === epoch && dialog.open && !lifetime.signal.aborted;
      async function downloadApi(selection?: SpeechModelInstall) {
        const response = await view.fetch("/api/hub/voice/speech-models", { method: selection ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
          headers: selection ? { "content-type": "application/json", "x-hub-speech-models": "1" } : undefined,
          body: selection ? JSON.stringify(selection) : undefined, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(25000)]),
        });
        if (!response.ok) throw new Error(response.status === 409 ? "Another download may be running. Check its status before retrying." : "Model download status is unavailable. Check the host connection and try again.");
        return speechDownloadStatusSchema.parse(await response.json()).download;
      }
      function renderDownloads() {
        downloadList.replaceChildren();
        for (const item of [...catalog!.speech.stt, ...catalog!.speech.tts]) {
          if (item.available) continue;
          const row = element("div"); const title = item.engine === "whisper" ? `Whisper ${item.model}` : item.engine === "piper" ? "Piper LJ Speech" : "Kokoro 82M";
          row.append(element("p", `${title} — ${item.reason ?? "Not installed"}`));
          if (item.downloadable && item.engine !== "kokoro") {
            const selection = { engine: item.engine, model: item.model } as SpeechModelInstall;
            const install = button(`Download ${title}`, () => {
              if (downloading || downloadRequest || !view.confirm(`Download ${title} to your host PC? This uses internet data and disk space. Your current call and saved settings will not change.`)) return;
              void pollDownload(selection);
            }); install.disabled = downloading || downloadRequest; row.append(install);
          }
          downloadList.append(row);
        }
        if (!downloadList.childElementCount) downloadList.append(element("p", "All supported speech models are installed."));
        const check = button("Check downloads", () => void pollDownload()); check.disabled = downloadRequest; downloadList.append(check);
      }
      async function pollDownload(selection?: SpeechModelInstall) {
        if (!validEditor() || downloadRequest) return;
        stopPolling(); downloadRequest = true; renderDownloads();
        try {
          const job = await downloadApi(selection); if (!validEditor()) return;
          downloading = !!job && !["complete", "failed"].includes(job.phase);
          downloadStatus.textContent = !job ? "No download running." : job.phase === "complete" ? "Download verified. Select the model above when you’re ready." : job.phase === "failed" ? "Download failed. Check host storage and internet, then retry; current settings are unchanged." : `${job.phase === "starting" ? "Starting" : job.phase === "verifying" ? "Verifying" : "Downloading"} ${job.model} on your host PC…`;
          if (job?.phase === "complete" && completedId !== job.id) {
            const result = await request("catalog") as Catalog; if (!validEditor()) return;
            catalog!.speech = localSpeechCatalogSchema.parse(result.speech); completedId = job.id;
            renderSpeech(); // Retain every unsaved field and current model selection.
          }
          if (downloading) downloadTimer = view.setTimeout(() => void pollDownload(), 2000);
        } catch (error) { if (validEditor()) downloadStatus.textContent = (error as Error).message; }
        finally { downloadRequest = false; if (validEditor()) renderDownloads(); }
      }
      renderDownloads(); void pollDownload();
      const inherit = element("input"); inherit.type = "checkbox"; inherit.checked = seed.tools.mode === "inherit"; field("Use existing session permissions", inherit, tools);
      const toolList = element("div"); tools.append(toolList); const checkboxes = new Map<string, HTMLInputElement>();
      const availableTools = new Map(catalog.tools.map(item => [item.name, item.description]));
      if (seed.tools.mode === "allow") for (const key of seed.tools.names) if (!availableTools.has(key)) availableTools.set(key, "Not currently available on this host.");
      for (const [key, description] of availableTools) {
        const checkbox = element("input"); checkbox.type = "checkbox"; checkbox.setAttribute("aria-label", `Allow ${key}`); checkbox.checked = seed.tools.mode === "allow" && seed.tools.names.includes(key);
        checkboxes.set(key, checkbox); const wrap = element("label"); const copy = element("span"); copy.append(element("strong", key), element("small", description)); wrap.append(checkbox, copy); toolList.append(wrap);
      }
      const showTools = () => { toolList.hidden = inherit.checked; }; inherit.addEventListener("change", showTools); showTools();
      tools.append(element("p", "Turning a tool on never bypasses existing permissions. Delegation needs both hub_task and subagent; background tasks keep running when voice ends."));
      const footer = element("footer"); const back = button("Back", () => { if (!dirty || view.confirm("Discard unsaved personality changes?")) { list(); say(""); } });
      const save = element("button", "Save personality"); save.type = "submit"; footer.append(back, save); form.append(footer);
      if (profile) {
        const actions = element("div"); actions.setAttribute("data-profile-actions", "");
        actions.append(button("Duplicate", () => { if (dirty) { say("Save or discard your edits before duplicating."); return; } void mutate({ type: "duplicate", revision: state!.revision, id: profile.id, name: `${profile.name.slice(0, 54)} copy` }); }),
          button("Delete personality", () => { if (state!.profiles.length === 1) { say("Keep at least one personality."); return; } if (view.confirm(`Delete ${profile.name}? Chats and shared memory will be kept.`)) void mutate({ type: "delete", revision: state!.revision, id: profile.id }); })); form.append(actions);
      }
      form.addEventListener("submit", event => {
        event.preventDefault();
        if (busy || loadingModels || model.disabled) { say("Wait for the model list to load."); return; }
        if (!models.some(item => item.id === model.value) || !catalog!.providers.some(item => item.id === provider.value) ||
          (effort.value && !models.find(item => item.id === model.value)?.efforts.some(item => item.id === effort.value))) { say("Choose an available connection, model and reasoning setting."); return; }
        const selectedTts = localTts();
        if (!catalog!.speech.stt.some(item => item.model === stt.value && item.available) || !selectedTts?.available || !selectedTts.voices.some(item => item === voice.value)) { say("Choose installed speech models and a voice before saving."); return; }
        const parsed = voiceProfileInputSchema.safeParse({ name: name.value, instructions: instructions.value,
          route: { provider: provider.value, model: model.value, ...(effort.value ? { reasoningEffort: effort.value } : {}) },
          speech: { stt: { engine: "whisper", model: stt.value }, tts: { engine: selectedTts.engine, model: selectedTts.model, voice: voice.value } },
          tools: inherit.checked ? { mode: "inherit" } : { mode: "allow", names: [...checkboxes].filter(([, input]) => input.checked).map(([key]) => key) },
        });
        if (!parsed.success) { say("Check the name and settings before saving."); return; }
        void mutate(profile ? { type: "edit", revision: state!.revision, id: profile.id, profile: parsed.data } : { type: "create", revision: state!.revision, profile: parsed.data });
      });
      content.replaceChildren(form); say(""); void loadModels(seed.route.model, seed.route.reasoningEffort);
      heading.tabIndex = -1; heading.focus({ preventScroll: true });
    } catch (error) { if (ticket === epoch && !lifetime.signal.aborted) { say((error as Error).message); content.append(button("Back", () => list())); } }
  }
  async function open() { if (dialog.open) return; editing = false; dirty = false; catalog = undefined; dialog.showModal(); say("Loading…"); if (await reload()) say(""); }
  if (root.documentElement.hasAttribute("data-minke-mobile-web") && view.innerWidth <= 1024) void reload();
  return { button: launcher, dialog,
    setActive(value?: Active) { active = value; label(); },
    dispose() { lifetime.abort(); epoch++; stopPolling(); removeBack(); dialog.remove(); launcher.remove(); removeStyles(); },
  };
}
