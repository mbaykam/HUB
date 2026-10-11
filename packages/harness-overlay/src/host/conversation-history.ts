import { z } from "zod";

const voiceRecordSchema = z.object({ saved: z.boolean(), createdAt: z.number().int().nonnegative() }).strict();
export type VoiceHistoryRecord = z.infer<typeof voiceRecordSchema>;
export interface ConversationView { kind: "chat" | "voice" | "task"; saved: boolean }
export interface HistorySession {
  id: string;
  header: { id: string; origin?: string; parentSession?: string };
  inheritedEventCount: number;
  snapshotEvents(): readonly { type: string }[];
}

// Native domain-storage vocabulary. Only presentation metadata, never another
// copy of transcripts. The pinned core cannot mark appended custom events
// ignorable, so those events are not safe to persist and reload in this build.
export const conversationHistoryDomain = {
  name: "hub_conversations", version: 1,
  tables: { voice: { valueSchema: voiceRecordSchema } },
};
interface VoiceTable {
  get(id: string): VoiceHistoryRecord | undefined;
  entries(): IterableIterator<[string, VoiceHistoryRecord]>;
  readonly size: number;
  put(id: string, value: VoiceHistoryRecord): Promise<void>;
  update(id: string, transform: (current: VoiceHistoryRecord) => VoiceHistoryRecord): Promise<VoiceHistoryRecord>;
}
interface HistoryDomain { table(name: "voice"): VoiceTable; close(): Promise<void> }
export interface ConversationStorage { open(spec: typeof conversationHistoryDomain): Promise<HistoryDomain> }

export async function openConversationHistory(storage: ConversationStorage) {
  const domain = await storage.open(conversationHistoryDomain);
  const table = domain.table("voice");
  return {
    view(sessionId: string, origin?: string): ConversationView {
      // Children/forks have their own identity: never inherit hidden status.
      if (origin === "subagent") return { kind: "task", saved: true };
      const record = table.get(sessionId);
      return record ? { kind: "voice", saved: record.saved } : { kind: "chat", saved: true };
    },
    snapshot(): { sessionId: string; saved: boolean; createdAt: number }[] {
      return [...table.entries()].map(([sessionId, value]) => ({ sessionId, ...value }));
    },
    async markVoiceOrigin(session: HistorySession): Promise<void> {
      if (session.header.origin === "subagent" || session.inheritedEventCount !== 0 || session.snapshotEvents().some(event => event.type === "user/message")) throw new Error("Only a new empty coordinator may enter Voice History");
      if (table.get(session.id)) return;
      if (table.size >= 20_000) throw new Error("Voice History metadata is full");
      // Native writes resolve only after durability. No ready call/audio first.
      await table.put(session.id, { saved: false, createdAt: Date.now() });
    },
    async save(sessionId: string): Promise<ConversationView> {
      // Only IDs admitted as empty voice coordinators exist in this table.
      // Promotion must not activate a cold agent or disturb running work.
      if (!table.get(sessionId)) throw new Error("This is not an archived voice conversation");
      if (!table.get(sessionId)!.saved) await table.update(sessionId, value => ({ ...value, saved: true }));
      return { kind: "voice", saved: true };
    },
    close: () => domain.close(),
  };
}
