import cytoscape from "cytoscape";
import type { MemoryGraphPage, MemoryGraphNote, MemorySearchPage, MemoryGraphNode } from "../../memory-graph-contract.ts";
import { defineOverlayStyle } from "../shared/style-runtime.ts";
import styles from "./graph-browser.css";
import { installMobileWidgetBack } from "../host/mobile-widget-back.ts";
import { openKnowledgeWorkspace } from "./knowledge-workspace.ts";
import type { KnowledgeGraph } from "../../knowledge-contract.ts";
const installStyles = defineOverlayStyle("hub-memory-graph-viewer", styles);

/** Trusted product renderer; note text/data never become executable code. */
export function openMemoryGraph(container: HTMLElement, root: Document, initial: MemoryGraphPage, onClose: () => void, initialNoteId?:string): () => void {
  const removeStyles = installStyles(root);
  if ((initial as Partial<KnowledgeGraph>).secondBrain) {
    const close = openKnowledgeWorkspace(container, root, initial as KnowledgeGraph, () => { removeStyles(); onClose(); },initialNoteId);
    return close;
  }
  const lifetime = new AbortController();
  const dialog = root.createElement("dialog"); dialog.setAttribute("data-hub-graph-dialog", ""); dialog.setAttribute("aria-label", "Knowledge graph");
  const header = root.createElement("header"); const title = root.createElement("h2"); title.textContent = "Knowledge";
  function button(label: string, action: () => void) { const b = root.createElement("button"); b.type = "button"; b.textContent = label; b.addEventListener("click", action); return b; }
  const close = button("Close", () => dialog.close()); header.append(title, close);
  const status = root.createElement("p"); status.setAttribute("role", "status");
  const canvas = root.createElement("div"); canvas.setAttribute("data-graph-canvas", ""); canvas.setAttribute("aria-label", "Drag to pan, pinch to zoom. Notes are also listed below.");
  const toolbar = root.createElement("nav"); toolbar.setAttribute("aria-label", "Graph controls");
  const searchForm = root.createElement("form"); searchForm.setAttribute("data-graph-search", "");
  const search = root.createElement("input"); search.type = "search"; search.maxLength = 200; search.placeholder = "Search all notes…"; search.setAttribute("aria-label", "Search all notes");
  const submit = button("Search", () => {}); submit.type = "submit";
  searchForm.append(search, submit);
  const list = root.createElement("div"); list.setAttribute("data-graph-notes", "");
  const article = root.createElement("article"); article.hidden = true; article.setAttribute("data-graph-note", "");
  const noteTitle = root.createElement("h3"), noteBody = root.createElement("pre");
  const memoryActions = root.createElement("div"); memoryActions.setAttribute("data-graph-memory-actions", "");
  const noteButtons = new Map<string, HTMLButtonElement>(); let activeNote: string | undefined;
  const back = button("‹ Graph", () => { noteRequest?.abort(); article.hidden = true; canvas.hidden = searching; list.hidden = false; toolbar.hidden = false; searchForm.hidden = false; cy.resize(); (noteButtons.get(activeNote ?? "") ?? search).focus(); });
  article.append(back, noteTitle, noteBody, memoryActions);
  dialog.append(header, status, searchForm, toolbar, canvas, list, article); root.body.append(dialog); dialog.showModal();
  const cy = cytoscape({ container: canvas, elements: [], minZoom: 0.25, maxZoom: 4, pixelRatio: Math.min(root.defaultView!.devicePixelRatio || 1, 2),
    style: [
      { selector: "node", style: { label: "data(label)", "background-color": "#91d0c2", width: 23, height: 23, color: "#e4e8f2", "font-size": 12, "min-zoomed-font-size": 10, "text-valign": "bottom", "text-margin-y": 9, "text-wrap": "ellipsis", "text-max-width": "110px", "border-color": "#cbf7e6", "border-width": 1 } },
      { selector: "edge", style: { width: 1.5, "line-color": "#65758e", "target-arrow-color": "#65758e", "target-arrow-shape": "triangle", "curve-style": "bezier" } },
      { selector: ":selected", style: { "background-color": "#c8b4ef", "line-color": "#c8b4ef" } },
    ],
  });
  let page = initial, busy = false, noteRequest: AbortController | undefined, listRequest: AbortController | undefined;
  let searching = false, searched = "", searchPage: MemorySearchPage = { nodes: [], page: 1, hasMore: false };
  const previous = button("Previous", () => { void (searching ? find(searched, searchPage.page - 1) : load(page.page - 1)); });
  const next = button("Next", () => { void (searching ? find(searched, searchPage.page + 1) : load(page.page + 1)); });
  const refresh = button("Refresh", () => { void (searching ? find(searched, searchPage.page) : load(page.page)); });
  const fit = button("Fit", () => cy.fit(undefined, 40));
  const reset = button("Back to graph", () => {
    listRequest?.abort(); listRequest = undefined; busy = false; searching = false; search.value = "";
    render(page); cy.resize(); search.focus();
  });
  toolbar.append(fit, reset, previous, next, refresh);
  function controls() {
    const current = searching ? searchPage : page;
    canvas.hidden = searching; fit.hidden = searching; reset.hidden = !searching;
    previous.disabled = busy || current.page <= 1; next.disabled = busy || !current.hasMore; refresh.disabled = busy;
    back.textContent = searching ? "‹ Results" : "‹ Graph";
  }
  async function request<T>(query: string, signal: AbortSignal): Promise<T> {
    const response = await root.defaultView!.fetch(`/api/hub/memory?${query}`, { credentials: "same-origin", cache: "no-store", headers: { "x-hub-memory": "1" }, signal: AbortSignal.any([lifetime.signal, signal, AbortSignal.timeout(30_000)]) });
    if (!response.ok) throw new Error("Memory unavailable");
    return response.json();
  }
  function renderList(nodes: MemoryGraphNode[]) {
    list.replaceChildren(); noteButtons.clear();
    for (const node of nodes) {
      const row = button(node.title, () => { void openNote(node.id); }); noteButtons.set(node.id, row); list.append(row);
    }
  }
  function render(data: MemoryGraphPage) {
    page = data;
    // Search hides the canvas. Restore its real dimensions BEFORE layout;
    // laying out a hidden container packs disconnected notes into a thin row.
    controls(); cy.resize(); cy.elements().remove();
    cy.add([...data.nodes.map(node => ({ data: { id: node.id, label: node.title } })), ...data.edges.map((edge, i) => ({ data: { id: `edge-${i}`, source: edge.source, target: edge.target, label: edge.label } }))]);
    // Built-in grid gives isolated notes a usable 2D placement. Force layouts
    // alone pack many disconnected components into a tiny strip. For linked
    // neighborhoods, use that placement to seed the standard CoSE layout.
    cy.layout({ name: "grid", animate: false, fit: true, padding: 35, avoidOverlap: true, nodeDimensionsIncludeLabels: true }).run();
    if (data.edges.length >= data.nodes.length / 2 && data.nodes.length > 2) {
      cy.layout({ name: "cose", animate: false, randomize: false, fit: true, padding: 35, numIter: 400, nodeDimensionsIncludeLabels: true }).run();
    }
    status.textContent = `${data.nodes.length} ${data.nodes.length === 1 ? "note" : "notes"} · ${data.edges.length} ${data.edges.length === 1 ? "connection" : "connections"} · page ${data.page}${data.partial ? " · partial neighborhood" : ""}. Zoom for labels, or open a note below. Conversation evidence stays hidden.`;
    if (!data.nodes.length) status.textContent = `No knowledge notes on page ${data.page}.${data.hasMore ? " Try the next page." : " Notes and their real links will appear here as your knowledge base grows."}`;
    renderList(data.nodes);
  }
  async function load(number: number) {
    if (busy || number < 1) return; busy = true; listRequest?.abort(); const current = listRequest = new AbortController(); controls();
    status.textContent = "Loading memory…"; cy.elements().remove(); list.replaceChildren();
    try { const result = await request<MemoryGraphPage>(`view=graph&page=${number}`, current.signal); if (!lifetime.signal.aborted && !current.signal.aborted) render(result); }
    catch { if (!lifetime.signal.aborted && !current.signal.aborted) status.textContent = "Couldn’t load memory. Refresh to retry."; }
    finally { if (listRequest === current && !lifetime.signal.aborted) { busy = false; controls(); } }
  }
  async function find(query: string, number: number) {
    if (!query.trim()) { reset.click(); return; }
    if (number < 1) return;
    listRequest?.abort(); const current = listRequest = new AbortController();
    searching = true; searched = query.trim(); busy = true;
    searchPage = { nodes: [], page: number, hasMore: false }; controls(); renderList([]);
    status.textContent = "Searching all knowledge notes…";
    try {
      const result = await request<MemorySearchPage>(`view=search&q=${encodeURIComponent(searched)}&page=${number}`, current.signal);
      if (lifetime.signal.aborted || current.signal.aborted) return;
      searchPage = result; renderList(result.nodes);
      status.textContent = result.nodes.length
        ? `${result.nodes.length} matching ${result.nodes.length === 1 ? "note" : "notes"} · page ${result.page}. Searches titles and content across your vault.`
        : `No visible matches on page ${result.page}.${result.hasMore ? " Try the next page." : " Try fewer or different words."}`;
    } catch { if (!lifetime.signal.aborted && !current.signal.aborted) status.textContent = "Couldn’t search memory. Search again to retry."; }
    finally { if (listRequest === current && !lifetime.signal.aborted) { busy = false; controls(); } }
  }
  async function openNote(id: string) {
    activeNote = id;
    noteRequest?.abort(); noteRequest = new AbortController(); const current = noteRequest;
    article.hidden = false; canvas.hidden = list.hidden = toolbar.hidden = searchForm.hidden = true;
    noteTitle.textContent = "Loading note…"; noteBody.textContent = ""; memoryActions.replaceChildren(); back.focus();
    try {
      const note = await request<MemoryGraphNote>(`view=note&id=${encodeURIComponent(id)}`, current.signal);
      if (current.signal.aborted || lifetime.signal.aborted) return;
      noteTitle.textContent = note.title; noteBody.textContent = note.content + (note.truncated ? "\n\n[Long note: preview truncated]" : "");
      if (note.canForget === true && !note.truncated) renderMemoryActions(note, current);
    } catch { if (!current.signal.aborted && !lifetime.signal.aborted) noteTitle.textContent = "Couldn’t open this note. It may have changed or been removed."; }
  }
  function renderMemoryActions(note: MemoryGraphNote, current: AbortController) {
    const passages = note.content.split("\n").filter(line => line.trim() && !line.startsWith("#") && line.length <= 4000 && note.content.split(line).length === 2).slice(0, 128);
    if (!passages.length) return;
    const label = root.createElement("label"); label.textContent = "Forget a saved passage";
    const select = root.createElement("select"); select.setAttribute("aria-label", "Saved passage to forget");
    const placeholder = root.createElement("option"); placeholder.value = ""; placeholder.textContent = "Choose a passage…"; select.append(placeholder);
    passages.forEach((passage, index) => { const option = root.createElement("option"); option.value = String(index); option.textContent = passage; select.append(option); });
    const hint = root.createElement("p"); hint.textContent = "Removes only the selected saved passage. Original chats stay intact; older conversation evidence will not recreate it automatically."; hint.setAttribute("role", "status");
    let confirmed = false, saving = false;
    const forget = button("Forget", () => { void remove(); }); forget.disabled = true;
    select.addEventListener("change", () => { confirmed = false; forget.textContent = "Forget"; forget.disabled = select.value === "" || saving; });
    label.append(select); memoryActions.append(label, hint, forget);
    async function remove() {
      if (saving || select.value === "" || current.signal.aborted) return;
      if (!confirmed) { confirmed = true; forget.textContent = "Confirm forget"; return; }
      saving = true; select.disabled = forget.disabled = true;
      try {
        const response = await root.defaultView!.fetch("/api/hub/memory", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "forget", noteId: note.id, passage: passages[Number(select.value)] }), signal: AbortSignal.any([lifetime.signal, current.signal, AbortSignal.timeout(30_000)]) });
        if (!response.ok) throw new Error("forget failed");
        if (!current.signal.aborted && !lifetime.signal.aborted) {
          await openNote(note.id);
          if (!lifetime.signal.aborted && activeNote === note.id) status.textContent = "Passage forgotten. Original chats are unchanged.";
        }
      } catch {
        if (!current.signal.aborted && !lifetime.signal.aborted) { hint.textContent = "Couldn’t confirm forgetting. Reopen the note to check its current contents before retrying."; select.disabled = false; forget.disabled = false; }
      } finally { saving = false; }
    }
  }
  cy.on("tap", "node", event => { void openNote(event.target.id()); });
  cy.on("tap", "edge", event => { status.textContent = event.target.data("label"); });
  searchForm.addEventListener("submit", event => { event.preventDefault(); void find(search.value, 1); });
  search.addEventListener("input", () => { if (!search.value && searching) reset.click(); });
  const resize = new ResizeObserver(() => cy.resize()); resize.observe(canvas);
  render(initial);
  let disposed = false;
  const removeSwipe = installMobileWidgetBack(dialog, header, () => { if (!article.hidden) back.click(); else if (searching) reset.click(); else dialog.close(); });
  function dispose() { if (disposed) return; disposed = true; removeSwipe(); lifetime.abort(); noteRequest?.abort(); listRequest?.abort(); resize.disconnect(); cy.destroy(); dialog.remove(); removeStyles(); onClose(); }
  dialog.addEventListener("close", dispose);
  dialog.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const targets = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')]
      .filter(element => element.getClientRects().length > 0 && !element.closest('[hidden], [inert]'));
    const first = targets[0], last = targets.at(-1);
    if (!first || !last) { event.preventDefault(); close.focus(); return; }
    if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  return dispose;
}
