import type { ConversationView } from "./conversation-history.ts";
import type { PresentationAgent } from "./presentation.ts";

export const SAVE_VOICE_CONVERSATION_TOOL = "hub_save_conversation";
export interface VoiceHistoryPort {
  view(sessionId: string, origin?: string): ConversationView;
  save(sessionId: string): Promise<ConversationView>;
}

/** Only the current voice coordinator can promote itself. This changes native
 * history visibility, never copies/deletes transcripts or changes child tasks. */
export function attachVoiceHistoryTool(agent: PresentationAgent, history: VoiceHistoryPort): () => void {
  let active = true;
  const off = agent.ctx.tools.register({
    name: SAVE_VOICE_CONVERSATION_TOOL,
    description: "Save this whole voice conversation to the user's normal chats/Recents, but ONLY when the user explicitly asks to save or keep this conversation as a chat. Do not use for remembering a fact, bookmarking a task, or routinely at call end. Original transcripts already live in Voice History. This cannot save another session. Confirm success only after the tool returns saved or already-saved.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: { type: "object", properties: { sessionId: { type: "string" }, saved: { type: "boolean", const: true }, status: { type: "string", enum: ["saved", "already-saved"] } }, required: ["sessionId", "saved", "status"], additionalProperties: false },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      if (!active || exec.agent?.id !== agent.id) throw new Error("Saving requires this active voice conversation");
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw new Error("Save conversation takes no arguments");
      const current = history.view(agent.id);
      if (current.saved) return { sessionId: agent.id, saved: true, status: "already-saved" };
      await history.save(agent.id);
      // A committed native write cannot be rolled back by interrupting speech.
      // Do not turn durable success into an apparent cancellation afterwards.
      return { sessionId: agent.id, saved: true, status: "saved" };
    },
  });
  return () => { if (active) { active = false; off(); } };
}
