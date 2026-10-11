export interface VoiceTranscriptLine { role: "user" | "assistant"; text: string; final: boolean }
/** Derive an ephemeral bounded view from native history, including streamed
 * assistant deltas. Provider/tool arguments and internal reasoning stay out. */
export function voiceTranscript(events: readonly any[]): VoiceTranscriptLine[] {
  const lines: VoiceTranscriptLine[] = []; let pending: VoiceTranscriptLine | undefined;
  const text = (content: any) => Array.isArray(content) ? content.filter(item => item?.type === "text" && typeof item.text === "string").map(item => item.text).join("\n").slice(-12000) : "";
  for (const event of events.slice(-2000)) {
    if (event.type === "user/message" && event.data?.source?.kind === "user") {
      pending = undefined; const value = text(event.data.content); if (value.trim()) lines.push({ role: "user", text: value, final: true });
    } else if (event.type === "assistant/chunk" && event.data?.chunk?.type === "text-delta" && typeof event.data.chunk.text === "string") {
      if (!pending) { pending = { role: "assistant", text: "", final: false }; lines.push(pending); }
      pending.text = (pending.text + event.data.chunk.text).slice(-12000);
    } else if (event.type === "assistant/message") {
      const value = text(event.data?.message?.content);
      if (value.trim()) { if (pending) { pending.text = value; pending.final = true; } else lines.push({ role: "assistant", text: value, final: true }); }
      pending = undefined;
    } else if (event.type === "turn/end") { if (pending) pending.final = true; pending = undefined; }
  }
  const bounded = lines.filter(line => line.text.trim()).slice(-60);
  while (bounded.length > 1 && bounded.reduce((sum, line) => sum + line.text.length, 0) > 32000) bounded.shift();
  return bounded;
}
