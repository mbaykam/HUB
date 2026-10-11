export interface MemoryGraphNode { id: string; title: string; permalink: string }
export interface MemoryGraphEdge { source: string; target: string; label: string }
export interface MemoryGraphPage {
  nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; page: number; hasMore: boolean;
  partial: boolean; omittedRelations: number; hiddenNodes: number;
}
export const memoryNoteId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isSavedMemoryPath(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u001f\u007f:]/.test(value)) return false;
  const parts = value.replaceAll("\\", "/").split("/");
  // Native filenames preserve spaces/Unicode by default; they are NOT slugs.
  return parts.length >= 2 && parts[0].toLowerCase() === "memories" && /\.md$/i.test(parts.at(-1)!)
    && parts.every(part => part && part !== "." && part !== "..");
}
// Basic Memory canonicalizes the requested hub-memory type to hub_memory.
// Keep the original spelling readable for pre-normalization/external notes.
export function isSavedMemoryType(value: unknown): boolean { return value === "hub_memory" || value === "hub-memory"; }
export interface MemoryGraphNote { id: string; title: string; permalink: string; content: string; truncated: boolean; canForget?: boolean }
export interface MemorySearchPage { nodes: MemoryGraphNode[]; page: number; hasMore: boolean }
