/** A display area, never a canonical domain or a domain-slot consumer. */
export const KNOWLEDGE_CHAT_ARCHIVE_ID = "hub:chat-archive";
export const KNOWLEDGE_CHAT_ARCHIVE_COLOR = "hsl(194 54% 70%)";
export type KnowledgeRecordScope = "all" | "brain" | "archive";
export function isArchivedConversation(record: {kind?: string}) {
  return record.kind === "conversation";
}
export function matchesKnowledgeScope(record: {kind?: string}, scope: KnowledgeRecordScope = "all") {
  return scope === "all" || isArchivedConversation(record) === (scope === "archive");
}
export function knowledgeRecordCounts(nodes: readonly {kind?: string}[]) {
  const chats = nodes.filter(isArchivedConversation).length;
  return {brain: nodes.length - chats, chats};
}
