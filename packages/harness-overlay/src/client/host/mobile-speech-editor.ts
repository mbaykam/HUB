import { localSpeechCatalogSchema, localSpeechSchema, speechDownloadStatusSchema, defaultVoiceAttention, type LocalSpeechConfig, type LocalSpeechCatalog } from "../../voice-profile-contract.ts";

/** Global engine editor or character voice-only picker, with cached auditions. */
export function createSpeechEditor(root: Document, seed: LocalSpeechConfig | null, options:{voiceOnly?:boolean;global?:boolean}={}) {
  const view = root.defaultView!, lifetime = new AbortController();
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const n = root.createElement(tag); if (text) n.textContent = text; return n; };
  const button = (text: string, run: () => void) => { const n = el("button", text); n.type = "button"; n.addEventListener("click", run); return n; };
  const panel = el(options.voiceOnly?"section":"details"); panel.setAttribute("data-hub-speech-editor", "");
  if(panel instanceof view.HTMLDetailsElement){panel.open=!!seed;panel.append(el("summary","Speech & languages"));}
  const status = el("p"); status.setAttribute("role", "status");
  const field = (text: string, input: HTMLElement) => { const label = el("label"); label.append(el("span", text), input); panel.append(label); input.setAttribute("aria-label", text); };
  const enabled = el("input"); enabled.type = "checkbox"; enabled.checked = !!seed; field("Enable speech", enabled);
  const stt = el("select"); field("Speech recognition model", stt);
  const language = el("select"); for (const [id, text] of [["auto", "Automatic · all model languages"], ["en-tr", "English + Türkçe only"], ["en", "English"], ["tr", "Türkçe"]]) { const n = el("option", text); n.value = id!; language.append(n); }
  language.value = seed?.stt.language ?? (seed?.stt.model.endsWith(".en") ? "en" : "auto"); field("Recognition language", language);
  const engine = el("select"); field("Speech engine", engine);
  const outputLanguage = language.cloneNode(true) as HTMLSelectElement;outputLanguage.querySelector('option[value="en-tr"]')?.remove();outputLanguage.querySelector('option[value="auto"]')!.textContent="Automatic · follow English / Türkçe"; outputLanguage.value = seed?.tts.engine === "bilingual" || seed?.tts.engine === "supertonic" ? seed.tts.language ?? "auto" : "auto"; field("Spoken language", outputLanguage);
  const quality = el("select"); for (const [id, text] of [["4", "Fast · 4 steps"], ["6", "Balanced · 6 steps"], ["8", "Detailed · 8 steps"]]) { const n = el("option", text); n.value = id!; quality.append(n); }
  quality.value = String(seed?.tts.engine === "supertonic" ? seed.tts.steps ?? 6 : 6); field("Voice quality", quality);
  const voiceHeading = el("h4", "Choose a voice · listen first"); panel.append(voiceHeading);
  const voices = el("div"); voices.className = "hub-speech-voices"; panel.append(voices);
  const voiceRows = new Map<string, { row: HTMLElement; choose: HTMLButtonElement; listen: HTMLButtonElement; turkish?: HTMLButtonElement }>();
  let voicesKey = "";
  const voiceNotice = el("p", "Install this voice engine’s models below before using it.");
  const turkish = button("▶ Türkçe · DFKI voice", () => void audition("tr")); panel.append(turkish);
  const voiceMapping = el("p"); voiceMapping.setAttribute("data-speech-voice-mapping", ""); panel.append(voiceMapping);
  let audio = el("audio"); audio.controls = true; audio.hidden = true; audio.setAttribute("playsinline", ""); panel.append(audio, status);
  panel.append(el("p", "Local engines run on your PC. Soniox sends foreground audio to its speech service; Background uses a local wake word model and closes the paid stream. Changes apply to the next call."));
  const models = el("details"); models.append(el("summary", "Install speech models")); const downloads = el("div"); models.append(downloads); panel.append(models);
  let catalog: LocalSpeechCatalog | undefined, selectedVoice = seed?.tts.voice ?? "F5", poll: number | undefined, samplePoll: number | undefined;
  const samples = new Map<string, { url: string; audio: HTMLAudioElement }>(), flights = new Map<string, Promise<void>>();
  const advanced = el("details"); advanced.append(el("summary", "Speech models & engines"), stt.parentElement!, engine.parentElement!, quality.parentElement!, models); panel.append(advanced);
  const attentionSeed=seed?.attention??defaultVoiceAttention;
  const idle=el("select"),phrases=el("input"),recent=el("select");phrases.type="text";phrases.value=attentionSeed.wakePhrases.join(", ");
  for(const [value,label] of [[0,"Only when I press Background"],[60,"After 1 minute"],[120,"After 2 minutes"],[180,"After 3 minutes"],[300,"After 5 minutes"],[600,"After 10 minutes"]]){const option=el("option",String(label));option.value=String(value);idle.append(option);}idle.value=String(attentionSeed.idleSeconds);
  for(const [value,label] of [[0,"Off · ignore background speech"],[30,"Last 30 seconds"],[60,"Last minute"],[120,"Last 2 minutes"]]){const option=el("option",String(label));option.value=String(value);recent.append(option);}recent.value=String(attentionSeed.contextSeconds);
  const listening=el("details");listening.append(el("summary","Background listening"));
  for(const [title,input] of [["Wait for my call",idle],["Wake phrases (up to 3, separated by commas)",phrases],["Recent background context",recent]] as const){const label=el("label");label.append(el("span",title),input);input.setAttribute("aria-label",title);listening.append(label);}
  listening.append(el("p","In Background, recognition stays local and sends no model requests. Say a wake phrase at the start of a sentence, or press Resume. Optional recent context stays briefly in memory before wake; at most 1,024 characters are sent once on wake as labeled background context, not as your message or a personal memory. This mode keeps an open call; it does not override your phone’s background microphone restrictions."));
  if(options.global)panel.append(listening);
  let connectionPanel:HTMLDetailsElement|undefined;
  if(options.global){
    const connection=el("details"),connectionStatus=el("p"),secret=el("input");
    connectionPanel=connection;
    connection.append(el("summary","Soniox connection"));connectionStatus.setAttribute("role","status");
    secret.type="password";secret.autocomplete="new-password";secret.maxLength=512;secret.setAttribute("aria-label","Soniox API key");secret.placeholder="Paste your Soniox API key";
    const consoleLink=el("a","Open Soniox Console");consoleLink.href="https://console.soniox.com/";consoleLink.target="_blank";consoleLink.rel="noopener noreferrer";
    const saveKey=button("Save API key",()=>void connectSoniox());
    connection.append(connectionStatus,secret,saveKey,consoleLink,el("p","Uses your Soniox balance. The key is stored in HUB’s credential store and is never included in character prompts. Background closes the paid stream; Mute only disables your microphone."));
    panel.insertBefore(connection,advanced);
    async function connectionRequest(apiKey?:string){const response=await view.fetch("/api/hub/voice/soniox",{method:apiKey?"POST":"GET",credentials:"same-origin",cache:"no-store",headers:{"x-hub-speech-settings":"1",...(apiKey?{"content-type":"application/json"}:{})},body:apiKey?JSON.stringify({apiKey}):undefined,signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(15000)])});if(!response.ok)throw Error("Could not save the Soniox connection. Check the key and try again.");return response.json() as Promise<{configured:boolean}>;}
    let connectionRevision=0;
    async function connectSoniox(){const value=secret.value.trim();if(value.length<16){connectionStatus.textContent="Enter your Soniox API key first.";return;}connectionRevision++;saveKey.disabled=true;try{await connectionRequest(value);secret.value="";connectionStatus.textContent="Key saved; connection not yet tested. Choose Soniox below and save speech settings for your next call.";await load();updateBackground();}catch(e){if(!lifetime.signal.aborted)connectionStatus.textContent=(e as Error).message;}finally{saveKey.disabled=false;}}
    void connectionRequest().then(value=>{if(!lifetime.signal.aborted&&!connectionRevision){connection.open=!value.configured;connectionStatus.textContent=value.configured?"API key saved. Usage is charged to Soniox when a foreground call starts.":"Add an API key to enable Soniox. Local speech remains available.";}}).catch(()=>{if(!lifetime.signal.aborted&&!connectionRevision)connectionStatus.textContent="Connection settings could not load. Reopen Speech to retry.";});
    lifetime.signal.addEventListener("abort",()=>{secret.value="";},{once:true});
  }
  if(options.voiceOnly){enabled.checked=true;enabled.parentElement!.remove();language.parentElement!.remove();outputLanguage.parentElement!.remove();advanced.remove();panel.append(el("p","Speech engines and language detection are shared. Change them in Settings → Speech. This character only chooses a voice."));}
  if(options.global){enabled.checked=true;enabled.parentElement!.remove();advanced.open=true;panel.insertBefore(advanced,voiceHeading);if(connectionPanel)panel.insertBefore(connectionPanel,advanced);const defaultVoice=el("details");defaultVoice.append(el("summary","Default voice"),voiceHeading,voices,turkish,voiceMapping);panel.insertBefore(defaultVoice,audio);}
  const key = (item: { engine: string; model: string }) => `${item.engine}:${item.model}`;
  let initialStt = seed ? key(seed.stt) : "nemotron:3.5-560ms", initialTts = seed ? key(seed.tts) : "supertonic:supertonic-3";
  function ttsValue(voice = selectedVoice): LocalSpeechConfig["tts"] {
    const item = catalog?.tts.find(item => key(item) === engine.value);
    if (!item) throw new Error("Speech models are still loading.");
    if (item.engine === "supertonic") return localSpeechSchema.shape.tts.parse({ engine: "supertonic", model: "supertonic-3", voice, language: outputLanguage.value, steps: Number(quality.value) });
    if (item.engine === "piper") return { engine: "piper", model: item.model, voice: item.model };
    if (item.engine === "bilingual") return { engine: "bilingual", model: "kokoro-piper", voice, turkishVoice: "tr_TR-dfki-medium", language: outputLanguage.value as "auto" };
    return { engine: "kokoro", model: "82m", voice };
  }
  function voiceLabel(id: string) { return /^[FM][1-5]$/.test(id) ? `${id[0] === "F" ? "Female" : "Male"} ${id[1]} · multilingual` : id.startsWith("tr_") ? "DFKI · Turkish" : id.startsWith("en_") ? "LJ · American English" : `${id.slice(3).replace(/^./, c => c.toUpperCase())} · ${id[0] === "b" ? "British" : "American"} · ${id[1] === "f" ? "female" : "male"}`; }
  const sampleKey = (lang: string, voice: string) => `${lang}:${lang === "tr" && engine.value.startsWith("bilingual") ? "tr_TR-dfki-medium" : voice}`;
  function preload(lang: "en" | "tr", voice: string) {
    const id=sampleKey(lang,voice);if(samples.has(id)||flights.has(id))return flights.get(id)??Promise.resolve();
    const selection={tts:ttsValue(voice),language:lang};
    const flight=(async()=>{
      const response=await view.fetch("/api/hub/voice/preview",{method:"POST",credentials:"same-origin",cache:"no-store",headers:{"content-type":"application/json","x-hub-speech-preview":"1"},body:JSON.stringify(selection),signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(15000)])});
      if(!response.ok)return;
      const blob=await response.blob();if(lifetime.signal.aborted)return;
      const url=view.URL.createObjectURL(blob),player=el("audio");player.preload="auto";player.src=url;player.controls=true;player.setAttribute("playsinline","");player.load();
      samples.set(id,{url,audio:player});
    })().catch(()=>{}).finally(()=>{flights.delete(id);});
    flights.set(id,flight);return flight;
  }
  async function warmSamples(){
    const engineKey=engine.value;
    const item=catalog?.tts.find(item=>key(item)===engineKey);if(!item?.available)return;
    const queue=item.voices.map(voice=>({voice,lang:voice.startsWith("tr_")?"tr" as const:"en" as const}));
    if(item.engine==="supertonic")queue.push(...item.voices.map(voice=>({voice,lang:"tr" as const})));
    if(item.engine==="bilingual")queue.unshift({voice:selectedVoice,lang:"tr"});
    await Promise.all(Array.from({length:4},async()=>{while(queue.length&&!lifetime.signal.aborted&&engine.value===engineKey){const next=queue.shift()!;await preload(next.lang,next.voice);if(!lifetime.signal.aborted)renderVoices();}}));
    if(!lifetime.signal.aborted&&engine.value===engineKey){view.clearTimeout(samplePoll);samplePoll=view.setTimeout(()=>void warmSamples(),10000);}
  }
  function renderVoices() {
    const bilingual = engine.value === "bilingual:kokoro-piper";
    const multilingual = engine.value === "supertonic:supertonic-3";
    voiceHeading.textContent = bilingual ? "English voice · listen first" : "Choose a voice · listen first";
    turkish.hidden = !bilingual;
    voiceMapping.textContent = multilingual ? `${voiceLabel(selectedVoice)} · the same speaker in English and Türkçe.` : bilingual ? `English: ${voiceLabel(selectedVoice)}. Türkçe: DFKI. These are separate voices; the English voice cannot speak Turkish with this engine.` : "";
    voiceMapping.hidden = !bilingual && !multilingual;
    const item = catalog?.tts.find(item => key(item) === engine.value);
    const nextKey = JSON.stringify([engine.value, item?.voices]);
    if (nextKey !== voicesKey) { voicesKey = nextKey; voiceRows.clear(); voices.replaceChildren(); }
    outputLanguage.disabled = !bilingual && !multilingual;
    quality.parentElement!.hidden = !multilingual;
    turkish.hidden = item?.engine !== "bilingual"; turkish.disabled = !item?.available || !samples.has(sampleKey("tr",selectedVoice));
    for (const id of item?.voices ?? []) {
      let controls = voiceRows.get(id);
      if (!controls) {
        const row = el("article");
        const choose = button(voiceLabel(id), () => { selectedVoice = id; renderVoices(); panel.dispatchEvent(new view.Event("change", { bubbles: true })); });
        const listen = button("Loading…", () => void audition(id.startsWith("tr_") ? "tr" : "en", id));
        const trListen = multilingual ? button("Loading…", () => void audition("tr", id)) : undefined;
        row.append(choose, listen); if (trListen) row.append(trListen); voices.append(row);
        controls = { row, choose, listen, turkish: trListen }; voiceRows.set(id, controls);
      }
      const { row, choose, listen, turkish: trListen } = controls;
      row.toggleAttribute("data-selected", id === selectedVoice); choose.setAttribute("aria-pressed", String(id === selectedVoice));
      const ready=samples.has(sampleKey(id.startsWith("tr_")?"tr":"en",id));
      listen.textContent = ready ? multilingual ? "▶ English" : "▶ Listen" : "Loading…"; listen.setAttribute("aria-label", `Listen to ${voiceLabel(id)}${multilingual ? " in English" : ""}`); listen.disabled = !item?.available || !ready;
      if(trListen){const trReady=samples.has(sampleKey("tr",id));trListen.textContent=trReady?"▶ Türkçe":"Loading…";trListen.setAttribute("aria-label",`Listen to ${voiceLabel(id)} in Turkish`);trListen.disabled=!item?.available||!trReady;}
    }
    voiceNotice.hidden = !!item?.available; if (voiceNotice.parentElement !== voices) voices.append(voiceNotice);
  }
  function audition(lang: "en" | "tr", voice = selectedVoice) {
    const ready=samples.get(sampleKey(lang,voice));if(!ready)return;
    audio.pause();if(audio!==ready.audio)audio.replaceWith(ready.audio);audio=ready.audio;audio.currentTime=0;audio.hidden=false;
    // Play in the tap handler, with no request or synthesis; preserves iPhone activation.
    void audio.play().then(()=>{status.textContent=`${voiceLabel(lang === "tr" && engine.value.startsWith("bilingual") ? "tr_TR-dfki-medium" : voice)} sample`;}).catch(()=>{status.textContent="Tap the audio play button to listen.";});
  }
  function renderCatalog() {
    if (!catalog) return; const wantedStt = stt.value || initialStt, wantedTts = engine.value || initialTts;
    stt.replaceChildren(); engine.replaceChildren();
    for (const item of catalog.stt) { const n = el("option", `${item.engine === "soniox" ? "Soniox · multilingual cloud + local wake" : item.engine === "nemotron" ? "Nemotron 3.5 · live English / Türkçe" : `Whisper ${item.model} · ${item.model.endsWith(".en") ? "English only" : "multilingual"}`}${item.available ? "" : item.engine==="soniox"?" · setup needed":" · install first"}`); n.value = key(item); n.disabled = !item.available; stt.append(n); }
    for (const item of catalog.tts) { const n = el("option", `${item.engine === "supertonic" ? "Supertonic 3 · same voice in English / Türkçe" : item.engine === "bilingual" ? "Automatic · Kokoro English + Piper Türkçe" : item.engine === "kokoro" ? "Kokoro · English" : `Piper · ${item.model.startsWith("tr_") ? "Türkçe" : "English"}`}${item.available ? "" : " · install first"}`); n.value = key(item); engine.append(n); }
    stt.value = wantedStt; engine.value = wantedTts; renderVoices(); void warmSamples(); downloads.replaceChildren();
    for (const item of [...catalog.stt, ...catalog.tts]) {
      if (item.available || !item.downloadable || !["whisper", "piper", "supertonic", "nemotron", "soniox"].includes(item.engine)) continue;
      const install = button(item.engine==="soniox"?"Install local wake listener":`Install ${item.model}`, () => void download({ engine: item.engine, model: item.model })); downloads.append(install);
    }
    if (!downloads.childElementCount) downloads.append(el("p", "All supported downloadable models are installed."));
  }
  async function load() {
    const response = await view.fetch("/api/hub/voice/catalog", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(25000)]) });
    if (!response.ok) throw new Error("Speech catalog could not load.");
    catalog = localSpeechCatalogSchema.parse((await response.json()).speech); if (!lifetime.signal.aborted) renderCatalog();
  }
  async function download(selection?: { engine: string; model: string }) {
    try {
      const response = await view.fetch("/api/hub/voice/speech-models", { method: selection ? "POST" : "GET", credentials: "same-origin", cache: "no-store", headers: selection ? { "content-type": "application/json", "x-hub-speech-models": "1" } : undefined, body: selection ? JSON.stringify(selection) : undefined, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(25000)]) });
      if (!response.ok) throw new Error("Another model may be downloading. Check again shortly.");
      const job = speechDownloadStatusSchema.parse(await response.json()).download;
      if (lifetime.signal.aborted) return;
      status.textContent = !job ? "No download running." : `${job.model} · ${job.phase}`;
      if (job?.phase === "complete") await load();
      else if (job && job.phase !== "failed") poll = view.setTimeout(() => void download(), 3000);
    } catch (error) { if (!lifetime.signal.aborted) status.textContent = (error as Error).message; }
  }
  engine.addEventListener("change", () => { const item = catalog?.tts.find(item => key(item) === engine.value); if (!item?.voices.some(id => id === selectedVoice)) selectedVoice = item?.engine === "supertonic" ? "F5" : item?.voices[0] ?? ""; audio.pause(); renderVoices(); void warmSamples(); });
  const updateBackground=()=>{const cloud=stt.value.startsWith("soniox:");recent.disabled=cloud;listening.lastElementChild!.textContent=cloud?"Background closes Soniox and listens locally only for your wake phrase. Nearby conversations are not transcribed in this mode. Resume also returns to Soniox. The call stays connected; phone microphone restrictions still apply.":"In Background, recognition stays local and sends no model requests. Optional recent context stays briefly in memory and is sent once on wake as labeled background context. The call stays connected; phone microphone restrictions still apply.";};
  stt.addEventListener("change",updateBackground);
  status.textContent = "Loading local speech models…";
  void load().then(() => { updateBackground();status.textContent = "Listen to a sample before choosing a voice."; }).catch(error => { if (!lifetime.signal.aborted) status.textContent = error.message; });
  return { panel, value(): LocalSpeechConfig | null {
    if(options.voiceOnly&&!catalog)return seed;
    if (!enabled.checked) return null;
    const selectedStt = catalog?.stt.find(item => key(item) === stt.value);
    if (!selectedStt) throw new Error("Choose an installed recognition model.");
    if(options.global&&!localSpeechSchema.shape.attention.safeParse({idleSeconds:Number(idle.value),wakePhrases:phrases.value.split(",").map(s=>s.trim()).filter(Boolean),contextSeconds:Number(recent.value)}).success)throw Error("Enter one to three wake phrases using letters, with at most four words each.");
    const value = localSpeechSchema.parse({ stt: { engine: selectedStt.engine, model: selectedStt.model, language: language.value }, tts: ttsValue(),...(options.global?{attention:{idleSeconds:Number(idle.value),wakePhrases:phrases.value.split(",").map(s=>s.trim()).filter(Boolean),contextSeconds:Number(recent.value)}}:seed?.attention?{attention:seed.attention}:{}) });
    if (value.stt.model.endsWith(".en") && language.value !== "en") throw new Error("Choose a multilingual Whisper model for automatic or Turkish recognition.");
    if (!catalog?.stt.some(item => key(item) === key(value.stt) && item.available) || !catalog.tts.some(item => key(item) === key(value.tts) && item.available)) throw new Error("Install the selected speech models before saving.");
    return value;
  }, dispose() { lifetime.abort(); view.clearTimeout(poll); view.clearTimeout(samplePoll); audio.pause();audio.removeAttribute("src");for(const sample of samples.values()){sample.audio.pause();sample.audio.removeAttribute("src");view.URL.revokeObjectURL(sample.url);}samples.clear(); } };
}
