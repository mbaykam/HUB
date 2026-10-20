import {useEffect, useRef} from "react";
import {defineOverlayStyle} from "../shared/style-runtime.ts";
import styles from "./instructions.css";

const installStyles = defineOverlayStyle("hub-instructions", styles);
type Section = "shared" | "user" | "characters" | "curator";
interface Source {id: string; name: string; path: string; content: string; hash?: string; editable: boolean}
interface Character {name: string; role: string; route: {provider: string; model: string; reasoningEffort?: string} | null; instructions: Source}
interface InstructionData {shared: Source[]; characters: Character[]; lastRequest?: {provider?: string; model?: string; system: string; workspace?: string[]}}
interface Curator {provider: string; model: string; reasoningEffort: string; path: string; instructions: string; hash: string; builtIn: string}
interface Draft {content: string; original: string; hash?: string}
let editorSequence = 0;

/** Edit the existing stores; examples are hints, never saved defaults. */
export function installInstructionEditor(container: HTMLElement, root: Document, currentSession: () => string | undefined) {
  const view = root.defaultView!, lifetime = new AbortController(), offStyle = installStyles(root);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = root.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text: string) => {const node = el("button", text); node.type = "button"; return node;};
  container.setAttribute("data-hub-instructions", "");
  const navigation = el("nav");
  navigation.className = "instruction-sections";
  navigation.setAttribute("aria-label", "Talimat bölümleri");
  const sectionButtons = new Map<Section, HTMLButtonElement>();
  for (const [id, title, description] of [
    ["shared", "Ortak davranış", "Tüm sohbet karakterleri"],
    ["user", "Benim hakkımda", "Tercihlerin ve alışkanlıkların"],
    ["characters", "Karakterler", "Her karakterin kendi tarzı"],
    ["curator", "Knowledge AI", "Notların nasıl düzenlenecek?"],
  ] as const) {
    const item = button("");
    item.setAttribute("data-instruction-section", id);
    item.append(el("strong", title), el("small", description));
    item.addEventListener("click", () => {section = id; choose();});
    sectionButtons.set(id, item);
    navigation.append(item);
  }

  const panel = el("section");
  panel.className = "instruction-editor";
  const heading = el("h3"), description = el("p"), label = el("label"), hint = el("p"), editor = el("textarea"), timing = el("p");
  description.className = "instruction-description";
  hint.className = timing.className = "instruction-hint";
  const editorId = "hub-instruction-editor-" + ++editorSequence;
  editor.id = editorId;
  editor.rows = 8;
  label.htmlFor = editorId;
  hint.id = editorId + "-hint";
  editor.setAttribute("aria-describedby", hint.id);
  const characterPicker = el("div"), characterLabel = el("label", "Hangi karakter?"), selector = el("select");
  characterPicker.className = "instruction-character-picker";
  selector.id = editorId + "-character";
  characterLabel.htmlFor = selector.id;
  selector.addEventListener("change", () => {characterId = selector.value; choose();});
  characterPicker.append(characterLabel, selector);
  const save = button("Kaydet"), undo = button("Değişikliği geri al"), refresh = button("Yenile"), status = el("p"), otherDrafts = el("p");
  save.setAttribute("data-instruction-save", "");
  save.className = "instruction-save";
  status.className = "instruction-status";
  status.setAttribute("role", "status");
  otherDrafts.className = "instruction-hint";
  const actions = el("div");
  actions.className = "instruction-actions";
  actions.append(save, refresh, undo);
  panel.append(heading, description, characterPicker, label, hint, editor, timing, actions, status, otherDrafts);

  const advanced = el("details"), path = el("code"), matrix = el("div"), matrixDetails = el("details"), native = el("details"), nativeText = el("pre");
  const builtIn = el("details"), builtText = el("pre"), last = el("details"), lastText = el("pre"), memory = el("details"), memoryText = el("pre");
  advanced.className = "instruction-advanced";
  advanced.append(el("summary", "Gelişmiş: dosyalar ve modele gönderilen talimatlar"), el("p", "Bu bölüm teknik ayrıntıları gösterir. Yukarıdaki alanı kullanmak için bunları düzenlemen gerekmez."), el("small", "Seçili alanın kayıt yeri"), path);
  matrixDetails.append(el("summary", "Hangi karakter hangi modeli ve talimatları kullanıyor?"), matrix);
  native.append(el("summary", "AGENTS.md · çalışma alanı kuralları (salt okunur)"), el("p", "Araç ve çalışma alanı kurallarıdır. Tüm sohbet ve Knowledge AI modelleri kullanabilir; projeler ek kurallar sağlayabilir. Bu dosyayı kendi dosya editöründen düzenleyebilirsin."), nativeText);
  builtIn.append(el("summary", "Knowledge AI’ın sabit not işleme kuralları"), builtText);
  last.append(el("summary", "Bu sohbette son gönderilen talimatlar"), lastText);
  memory.setAttribute("data-instruction-memory", "");
  memory.append(el("summary", "memory.md · Knowledge navigation (automatic)"), el("p", "A small map of domains, source retrieval and skills. HUB updates it automatically before model requests and while idle. Edit your Knowledge domains or saved skills to change this index."), memoryText);
  advanced.append(matrixDetails, memory, native, builtIn, last);
  container.append(el("h2", "AI talimatları"), el("p", "Neyi değiştirmek istediğini seç. Her bölüm, yazdıklarının hangi asistanı etkilediğini açıklar."), navigation, panel, advanced);

  let section: Section = "shared", sources: Source[] = [], characters: Character[] = [], selected: Source | undefined, characterId = "", curator: Curator | undefined;
  let loading = false, saving = false;
  const drafts = new Map<string, Draft>();
  async function request<T>(url: string, marker: string, command?: unknown): Promise<T> {
    const response = await view.fetch(url, {
      method: command ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
      headers: {[marker]: "1", ...(command ? {"content-type": "application/json"} : {})},
      body: command ? JSON.stringify(command) : undefined,
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(20000)]),
    });
    const value = await response.json();
    if (!response.ok) {
      if (response.status === 409 && /changed|reload|conflict/i.test(value.detail ?? "")) {
        throw new Error("Bu talimat başka bir yerde değişmiş. Yazdıkların korunuyor. Güncel metni görmek için Yenile, ardından Değişikliği geri al seçeneğini kullan.");
      }
      throw new Error(value.detail ?? "Talimatlar yüklenemedi. Tekrar deneyebilirsin.");
    }
    return value;
  }
  function sourceId() {
    return section === "characters" ? characterId : section === "shared" ? "SOUL.md" : section === "user" ? "USER.md" : "curator";
  }
  function updateControls() {
    const busy = loading || saving;
    for (const [id, item] of sectionButtons) {
      const available = id === "characters" ? characters.length > 0 : sources.some(source => source.id === (id === "shared" ? "SOUL.md" : id === "user" ? "USER.md" : "curator"));
      item.disabled = busy || !available;
      item.setAttribute("aria-pressed", String(id === section));
      item.classList.toggle("is-selected", id === section);
    }
    selector.disabled = busy;
    editor.disabled = busy || !selected;
    const draft = selected && drafts.get(selected.id);
    save.disabled = busy || !selected?.editable || !draft;
    undo.hidden = !draft;
    undo.disabled = busy;
    refresh.disabled = busy;
    const other = drafts.size - (draft ? 1 : 0);
    otherDrafts.hidden = other === 0;
    otherDrafts.textContent = other ? "Diğer bölümlerde " + other + " kaydedilmemiş taslağın var. Bölümler arasında geçerken korunur; bu ekranı kapatırsan kaybolur." : "";
  }
  function choose() {
    selected = sources.find(source => source.id === sourceId());
    characterPicker.hidden = section !== "characters";
    builtIn.hidden = !curator;
    if (!selected) {editor.value = ""; updateControls(); return;}
    const character = characters.find(item => item.instructions.id === selected!.id);
    const copy = section === "shared" ? {
      title: "Ortak davranış kuralları", description: "Ana asistanın, konuşma asistanının ve diğer karakterlerin nasıl yanıt vermesini istediğini yaz. Karakterlerin kendi talimatları bunlara eklenir.",
      label: "Asistanlar nasıl davranmalı?", hint: "İsteğe bağlı. Boş bırakırsan ek bir ortak kural uygulanmaz.",
      example: "Örnek: Kısa ve açık cevap ver. Ben hangi dilde konuşuyorsam o dilde devam et.",
    } : section === "user" ? {
      title: "Benim hakkımda", description: "Asistanların bilmesini istediğin tercihlerini ve bilgilerini yaz. Tüm sohbet karakterleri bunları kullanır. Sohbetlerden otomatik hatırlanan bilgiler Knowledge’da tutulur.",
      label: "Asistanların senin hakkında bilmesini istediklerin", hint: "İsteğe bağlı. Burası, kendin eklemek istediğin kalıcı bilgiler için.",
      example: "Örnek: Türkçe ve İngilizce konuşuyorum. Teknik konularda somut örnekleri seviyorum.",
    } : section === "curator" ? {
      title: "Knowledge AI’ın not düzenleme kuralları", description: "Sohbetlerden not çıkaran AI’ın nasıl yazacağını belirle. Bu alan sohbet karakterlerini etkilemez. Otomatik işleme ve model seçimi Knowledge AI menüsünde yapılır.",
      label: "Notlar nasıl yazılmalı?", hint: "İsteğe bağlı. Boş bırakırsan sabit not işleme kuralları kullanılır.",
      example: "Örnek: Notun dilini içeriğe göre koru. Tekrarlanan bilgileri birleştir. Bağlantı kurmak için boş notlar oluşturma.",
    } : {
      title: (character?.name ?? selected.name) + " için özel talimatlar", description: "Bu kurallar yalnız seçtiğin karakterin davranışını belirler. Modelini değiştirsen de korunur; ortak davranış kuralları da uygulanır.",
      label: (character?.name ?? selected.name) + " nasıl davranmalı?", hint: "İsteğe bağlı. Boş bırakırsan bu karaktere ek bir davranış talimatı verilmez.",
      example: "Örnek: Konuları sade dille anlat. Gerektiğinde açıklayıcı sorular sor.",
    };
    heading.textContent = copy.title;
    description.textContent = copy.description;
    label.textContent = copy.label;
    hint.textContent = copy.hint;
    editor.placeholder = copy.example;
    editor.value = drafts.get(selected.id)?.content ?? selected.content;
    editor.readOnly = !selected.editable;
    path.textContent = selected.path;
    timing.textContent = section === "characters" ? "Kaydettikten sonra yeni yanıtlarda kullanılır. Açık bir sesli seans varsa karakter değişikliğini uygulamak için yeniden başlat." : section === "curator" ? "Bir sonraki not işleme görevinde kullanılır." : "Kaydettikten sonra bir sonraki yanıtta kullanılır.";
    status.textContent = drafts.has(selected.id) ? "Kaydedilmemiş değişiklikler. Bölüm değiştirsen de bu ekranda korunur." : "";
    updateControls();
  }
  editor.addEventListener("input", () => {
    if (!selected?.editable) return;
    const original = drafts.get(selected.id) ?? {original: selected.content, hash: selected.hash, content: selected.content};
    if (editor.value === original.original) drafts.delete(selected.id);
    else drafts.set(selected.id, {...original, content: editor.value});
    status.textContent = drafts.has(selected.id) ? "Kaydedilmemiş değişiklikler." : "";
    updateControls();
  });
  undo.addEventListener("click", () => {if (selected) drafts.delete(selected.id); choose();});

  async function load() {
    loading = true;
    updateControls();
    status.textContent = "Talimatlar yükleniyor…";
    try {
      const session = currentSession();
      const data = await request<InstructionData>("/api/hub/instructions" + (session ? "?sessionId=" + encodeURIComponent(session) : ""), "x-hub-instructions");
      try {curator = await request<Curator>("/api/hub/memory?view=instructions", "x-hub-memory");} catch {curator = undefined;}
      if (lifetime.signal.aborted) return false;
      characters = data.characters;
      sources = [...data.shared, ...characters.map(item => item.instructions), ...(curator ? [{id: "curator", name: "Knowledge AI", path: curator.path + " → instructions", content: curator.instructions, hash: curator.hash, editable: true}] : [])];
      selector.replaceChildren();
      for (const item of characters) {const option = el("option", item.name); option.value = item.instructions.id; selector.append(option);}
      if (!characters.some(item => item.instructions.id === characterId)) characterId = characters[0]?.instructions.id ?? "";
      selector.value = characterId;
      matrix.replaceChildren();
      for (const character of characters) {
        const card = el("article"), role = character.role === "Main" ? "Ana asistan" : character.role === "Voice" ? "Sesli asistan" : "Uzman";
        card.append(el("strong", character.name + " · " + role), el("p", character.route ? character.route.provider + " / " + character.route.model + (character.route.reasoningEffort ? " · " + character.route.reasoningEffort : "") : "Model seçilmedi"), el("small", "Ortak: SOUL.md, USER.md ve AGENTS.md · memory.md: Knowledge erişimi olan karakterler · Özel: " + character.name + " talimatları"));
        matrix.append(card);
      }
      if (curator) {
        const card = el("article");
        card.append(el("strong", "Knowledge AI · Curator"), el("p", curator.provider + " / " + curator.model + " · " + curator.reasoningEffort), el("small", "AGENTS.md + sabit not işleme kuralları + kendi talimatları. SOUL.md, USER.md ve sohbet kişiliklerini kullanmaz."));
        matrix.append(card);
      }
      const nativeSource = sources.find(source => source.id === "native-agents");
      const memorySource = sources.find(source => source.id === "memory.md");
      memory.hidden = !memorySource;
      memoryText.textContent = memorySource ? memorySource.path + "\n\n" + memorySource.content : "";
      native.hidden = !nativeSource;
      nativeText.textContent = nativeSource ? nativeSource.path + "\n\n" + (nativeSource.content || "Bu dosyada ek kural yok.") : "";
      builtText.textContent = curator?.builtIn ?? "";
      last.hidden = !data.lastRequest?.system;
      lastText.textContent = data.lastRequest ? (data.lastRequest.provider ?? "") + " / " + (data.lastRequest.model ?? "") + "\n\n" + data.lastRequest.system + "\n\n" + (data.lastRequest.workspace?.join("\n\n") ?? "") : "";
      if (!sources.some(source => source.id === sourceId())) section = "shared";
      choose();
      if (!curator) status.textContent = "Knowledge AI talimatları şu anda yüklenemedi. Diğer bölümleri kullanabilir, Yenile ile tekrar deneyebilirsin.";
      return true;
    } catch (error) {
      if (!lifetime.signal.aborted) status.textContent = (error as Error).message;
      return false;
    } finally {loading = false; updateControls();}
  }
  save.addEventListener("click", async () => {
    const target = selected, draft = target && drafts.get(target.id);
    if (!target?.editable || !draft || loading || saving) return;
    saving = true;
    updateControls();
    status.textContent = "Kaydediliyor…";
    try {
      if (target.id === "curator") await request("/api/hub/memory", "x-hub-memory", {action: "instructions", hash: draft.hash, instructions: draft.content});
      else await request("/api/hub/instructions", "x-hub-instructions", {id: target.id, hash: draft.hash, content: draft.content});
      drafts.delete(target.id);
      const loaded = await load();
      status.textContent = loaded ? "Talimatlar kaydedildi." : "Kaydedildi; güncel metin yüklenemedi. Yenile ile tekrar deneyebilirsin.";
    } catch (error) {
      if (!lifetime.signal.aborted) status.textContent = (error as Error).message;
    } finally {saving = false; updateControls();}
  });
  refresh.addEventListener("click", () => void load());
  void load();
  return () => {lifetime.abort(); offStyle(); container.replaceChildren();};
}

export function InstructionSettings({currentSession}: {currentSession: () => string | undefined}) {
  const ref = useRef<HTMLDivElement>(null), current = useRef(currentSession);
  current.current = currentSession;
  useEffect(() => {if (ref.current) return installInstructionEditor(ref.current, ref.current.ownerDocument, () => current.current());}, []);
  return <div ref={ref}/>;
}
