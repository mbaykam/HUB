/** Read-only projection of Basic Memory's graph, not a second index or vault. */
export interface MemoryGraphPorts {
  call(tool: "build_context" | "read_note" | "search_notes", args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
import type { MemoryGraphNode, MemoryGraphEdge } from "../memory-graph-contract.ts";
import { memoryNoteId, isSavedMemoryPath, isSavedMemoryType } from "../memory-graph-contract.ts";
export const memoryEntityId = memoryNoteId;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid memory graph response");
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}
function visibleNote(note: Record<string, unknown>): boolean {
  // Conversation evidence and retention policy stay tucked away. Check both
  // physical and logical paths: a human can change a note's permalink.
  return [note.file_path, note.permalink].every(value => {
    if (typeof value !== "string" || !value) return false;
    const path = value.replace(/^memory:\/\//i, "").replaceAll("\\", "/").toLowerCase();
    return !path.startsWith("/") && !path.includes(":") && !path.split("/").includes("..")
      && !/^(control|sessions)(\/|$)/.test(path);
  });
}

export function projectMemoryGraph(value: unknown, page: number) {
  const graph = object(value);
  if (!Array.isArray(graph.results) || graph.results.length > 50) throw new Error("Invalid memory graph page");
  const nodes = new Map<string, MemoryGraphNode>();
  const relations: Record<string, unknown>[] = [];
  let hiddenNodes = 0;
  let capped = false;
  for (const item of graph.results) {
    const result = object(item);
    if (!Array.isArray(result.related_results) || result.related_results.length > 100) throw new Error("Invalid memory neighborhood");
    for (const raw of [result.primary_result, ...result.related_results]) {
      const entry = object(raw);
      if (entry.type === "entity") {
        if (typeof entry.external_id !== "string" || !memoryEntityId.test(entry.external_id)) throw new Error("Missing exact memory identity");
        if (!visibleNote(entry)) { hiddenNodes++; continue; }
        if (!nodes.has(entry.external_id) && nodes.size >= 150) { capped = true; continue; }
        nodes.set(entry.external_id, { id: entry.external_id, title: text(entry.title, 240), permalink: text(entry.permalink, 2048) });
      } else if (entry.type === "relation") relations.push(entry);
    }
  }
  const edges = new Map<string, MemoryGraphEdge>();
  let omittedRelations = 0;
  for (const relation of relations) {
    const source = text(relation.from_entity_external_id, 36);
    const target = text(relation.to_entity_external_id, 36);
    // Never guess by title or infer a link from two neighboring search results.
    if (!nodes.has(source) || !nodes.has(target)) { omittedRelations++; continue; }
    const label = text(relation.relation_type, 120);
    edges.set(JSON.stringify([source, target, label]), { source, target, label });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], page, hasMore: graph.has_more === true,
    partial: graph.has_more === true || omittedRelations > 0 || capped, omittedRelations, hiddenNodes };
}

export function createMemoryGraph(ports: MemoryGraphPorts) {
  return {
    async search(query: string, page: number, signal: AbortSignal) {
      if (typeof query !== "string" || !query.trim() || query.length > 200 || /[\u0000-\u001f\u007f]/.test(query) || !Number.isSafeInteger(page) || page < 1 || page > 10_000) throw new Error("Invalid memory search");
      // Literal words, not arbitrary FTS operators. The established Basic Memory
      // index searches note titles AND bodies; nothing is indexed in the PWA.
      const literal = query.trim().split(/\s+/u).map(term => `"${term.replaceAll('"', '""')}"`).join(" AND ");
      const result = object(await ports.call("search_notes", { query: literal, search_type: "text", entity_types: ["entity"],
        page, page_size: 50, search_all_projects: false, output_format: "json" }, signal));
      if (result.error || !Array.isArray(result.results) || result.results.length > 50 || result.current_page !== page || typeof result.has_more !== "boolean") throw new Error("Invalid memory search response");
      const nodes = new Map<string, MemoryGraphNode>();
      for (const raw of result.results) {
        const entry = object(raw);
        if (entry.type !== "entity" || !visibleNote(entry)) continue;
        if (typeof entry.external_id !== "string" || !memoryEntityId.test(entry.external_id)) throw new Error("Missing exact memory identity");
        nodes.set(entry.external_id, { id: entry.external_id, title: text(entry.title, 240), permalink: text(entry.permalink, 2048) });
      }
      // Keep upstream pagination even when a whole page was hidden. Do not
      // reveal excerpts, internal policy/evidence titles, or their total count.
      return { nodes: [...nodes.values()], page, hasMore: result.has_more };
    },
    async page(page: number, signal: AbortSignal) {
      if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) throw new Error("Invalid graph page");
      // null deliberately disables Basic Memory's default seven-day cutoff.
      // Pagination stays in its established index; old notes remain reachable.
      return projectMemoryGraph(await ports.call("build_context", {
        url: "memory://*", depth: 1, timeframe: null, page, page_size: 50, max_related: 100, output_format: "json",
      }, signal), page);
    },
    async note(id: string, signal: AbortSignal) {
      if (!memoryEntityId.test(id)) throw new Error("Invalid memory identity");
      const result = object(await ports.call("read_note", { identifier: id, output_format: "json", include_frontmatter: false }, signal));
      if (result.error || !visibleNote(result) || typeof result.content !== "string") throw new Error("Note unavailable");
      return { id, title: text(result.title, 240), permalink: text(result.permalink, 2048),
        content: result.content.slice(0, 128_000), truncated: result.content.length > 128_000,
        canForget: isSavedMemoryPath(result.file_path) && isSavedMemoryType(object(result.frontmatter ?? {}).type) };
    },
  };
}
