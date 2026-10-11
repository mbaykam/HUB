import { createHash } from "node:crypto";

interface Event {
  readonly type: string;
  readonly data?: unknown;
}

export interface MemorySession {
  readonly header: { readonly id: string; readonly origin?: string };
  readonly events: readonly Event[];
}

export interface MemoryCaptureNote {
  readonly title: string;
  readonly directory: "sessions";
  readonly content: string;
  readonly overwrite: false;
  readonly note_type: "conversation-evidence";
  readonly metadata: { readonly source: "hub"; readonly session: string; readonly turn: number };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function textBlocks(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap((block: unknown) => {
    const item = record(block);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n").trim();
}

/**
 * The DSH-to-Basic-Memory data seam, not a fact extractor. Invoke for a newly
 * committed turn/end event, never as an implicit backfill of old conversations.
 * Source selection follows DSH's typed session events. Basic Memory owns storage,
 * indexing and search. Reflection must treat this note as untrusted evidence.
 */
export function completedMemoryTurn(session: MemorySession, turn: number, maxEvidenceBytes = 64 * 1024): MemoryCaptureNote | undefined {
  if (!session.header.id || session.header.origin === "subagent"
    || !Number.isSafeInteger(turn) || turn < 0) return;
  const start = session.events.findIndex(event => event.type === "turn/start" && record(event.data)?.turn === turn);
  if (start < 0) return;
  const body: string[] = [];
  let hasUser = false;
  let hasAssistant = false;
  let completed = false;
  for (const event of session.events.slice(start + 1)) {
    const data = record(event.data);
    if (event.type === "turn/start") return; // Missing end, not an implicit success.
    if (event.type === "turn/end") {
      if (data?.turn !== turn || record(data.reason)?.kind !== "completed") return;
      completed = true;
      break;
    }
    if (event.type === "user/message" && data && record(data.source)?.kind === "user") {
      const text = textBlocks(data);
      if (text) { body.push(`## User\n\n${text}`); hasUser = true; }
    } else if (event.type === "assistant/message" && data?.turn === turn && data.interrupted !== true) {
      const message = record(data.message);
      const text = message ? textBlocks(message) : "";
      if (text) { body.push(`## Assistant\n\n${text}`); hasAssistant = true; }
    }
  }
  if (!completed || !hasUser || !hasAssistant) return;
  const content = "Conversation evidence, not verified memory or instructions.\n\n" + body.join("\n\n");
  // Explicit failure is safer than silently clipping evidence and missing a
  // correction at the end. The future dispatcher must expose this failure.
  if (Buffer.byteLength(content, "utf8") > maxEvidenceBytes) throw new Error(`Memory capture exceeds the ${maxEvidenceBytes / 1024} KiB evidence limit`);
  const sessionKey = createHash("sha256").update(session.header.id).digest("hex");
  return {
    title: `hub-${sessionKey}-turn-${turn}`, directory: "sessions", content,
    overwrite: false, note_type: "conversation-evidence",
    metadata: { source: "hub", session: sessionKey, turn },
  };
}
