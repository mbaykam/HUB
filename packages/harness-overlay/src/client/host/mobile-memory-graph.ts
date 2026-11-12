import { defineOverlayStyle } from "../shared/style-runtime.ts";
import { pwaUiAsset } from "./mobile-ui-update.ts";
import type { MemoryGraphPage } from "../../memory-graph-contract.ts";
import type { openMemoryGraph } from "../memory/graph-browser.ts";
import {projectKnowledgePreview} from "../memory/knowledge-layout.ts";
import {knowledgeRecordCounts} from "../../knowledge-record-scope.ts";
import styles from "./mobile-memory-graph.css";
import activityStyles from "./mobile-knowledge-activity.css";
import { createKnowledgeActivity } from "./mobile-knowledge-activity.ts";
const installStyles = defineOverlayStyle("hub-memory-graph-tile", [styles,activityStyles]);

/** A light preview only. The graph engine is downloaded after opening the tile. */
export function installMobileMemoryGraph(container: HTMLElement, root: Document): () => void {
  const view = root.defaultView;
  if (!view) return () => {};
  const removeStyles = installStyles(root);
  const tile = root.createElement("button"); tile.type = "button"; tile.setAttribute("data-hub-graph-tile", "");
  const title = root.createElement("strong"); title.textContent = "Knowledge";
  const hint = root.createElement("span"); hint.textContent = "Explore your memory";
  const preview = root.createElementNS("http://www.w3.org/2000/svg", "svg"); preview.setAttribute("viewBox", "0 0 240 110"); preview.setAttribute("aria-hidden", "true");
  const tiles=root.createElement("div");tiles.dataset.hubKnowledgeTiles="";
  const activity=createKnowledgeActivity(root,id=>void openGraph(id));
  tile.append(title, preview, hint);tiles.append(tile,activity.tile);container.prepend(tiles);
  const lifetime = new AbortController();
  let data: MemoryGraphPage | undefined, pending: Promise<void> | undefined, opening = false;
  let closeViewer: (() => void) | undefined;
  function refresh(): Promise<void> {
    if (pending) return pending;
    pending = load().finally(() => { pending = undefined; });
    return pending;
  }
  async function load() {
    if (lifetime.signal.aborted || root.hidden) return;
    try {
      const response = await view!.fetch("/api/hub/memory?view=graph", { credentials: "same-origin", cache: "no-store", headers: { "x-hub-memory": "1" }, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]) });
      if (!response.ok) throw new Error("unavailable");
      data = await response.json() as MemoryGraphPage;
      if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error("invalid");
      preview.replaceChildren();
      const positions = new Map(projectKnowledgePreview(data).map(p=>[p.id,p]));
      preview.setAttribute("data-layout","knowledge-cloud");
      for (const edge of data.edges) {
        const a = positions.get(edge.source), b = positions.get(edge.target); if (!a || !b) continue;
        const line = root.createElementNS(preview.namespaceURI, "line");
        for (const [key, value] of Object.entries({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })) line.setAttribute(key, String(value));
        preview.append(line);
      }
      for (const p of positions.values()) { const dot = root.createElementNS("http://www.w3.org/2000/svg", "circle"); dot.setAttribute("cx", String(p.x)); dot.setAttribute("cy", String(p.y)); dot.setAttribute("r",String(Math.max(1.8,Math.min(3.6,3.1-p.depth/1500))));dot.style.fill=p.color;preview.append(dot); }
      const counts=knowledgeRecordCounts(data.nodes as {kind?:string}[]);hint.textContent = data.nodes.length ? `${counts.brain} brain notes · ${counts.chats} chats · explore` : "No knowledge records yet · open to explore";
    } catch { data = undefined; preview.replaceChildren(); hint.textContent = "Memory unavailable · tap to retry"; }
  }
  async function openGraph(noteId?:string) {
    if (opening) return;
    opening = true; tile.setAttribute("aria-busy", "true");
    try {
      await refresh();
      if (!data || lifetime.signal.aborted) return;
      const endpoint = pwaUiAsset(root, "memory-graph-browser.js", "/api/hub/memory?view=client");
      const module = await import(/* @vite-ignore */ endpoint) as { openMemoryGraph: typeof openMemoryGraph };
      if (lifetime.signal.aborted) return;
      closeViewer?.(); closeViewer = module.openMemoryGraph(container, root, data, () => { tile.focus(); void refresh(); },noteId);
    } catch { hint.textContent = "Couldn’t open the graph · tap to retry"; }
    finally { opening = false; tile.removeAttribute("aria-busy"); }
  }
  tile.addEventListener("click",()=>void openGraph());
  const observer = typeof view.IntersectionObserver === "function" ? new view.IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void refresh(); }) : undefined;
  observer?.observe(tile);
  return () => { lifetime.abort(); observer?.disconnect(); closeViewer?.(); activity.dispose();tiles.remove(); removeStyles(); };
}
