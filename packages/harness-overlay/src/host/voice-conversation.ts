/** Voice is a view onto an ordinary DSH session, not a second conversation log
 * or task scheduler. Only explicitly correlated human turns may produce audio.
 */
import { randomUUID } from "node:crypto";
export interface VoiceEvent {
  type: "text" | "tool-start" | "tool-end" | "end";
  utterance: number;
  text?: string;
  callId?: string;
  name?: string;
  status?: string;
}
interface SessionEvent { type: string; data: unknown }
export interface VoiceConversationPorts {
  sessionId: string;
  running(): boolean;
  /** Native sessionController.prompt: user source and request id stay durable. */
  prompt(request: { sessionId: string; requestId: string; mode: "queue"; content: { type: "text"; text: string }[] }): Promise<unknown>;
  /** Subscribe to this exact native session only. */
  subscribe(listener: (event: SessionEvent) => void): () => void;
  /** Retract this RPC from the inbox or cancel its own claimed turn only. */
  cancel(requestId: string): void;
  whenIdle(): Promise<void>;
}
export class VoiceConversationError extends Error {
  readonly code: "closed" | "busy" | "invalid-utterance" | "already-admitted" | "prompt-failed";
  constructor(code: VoiceConversationError["code"]) {
    super(code);
    this.code = code;
  }
}
interface ActiveTurn {
  utterance: number;
  requestId: string;
  nativeTurn?: number;
  sink: (event: VoiceEvent) => void;
  settled: () => void;
  text: string;
  input: string;
  tasks: Map<string, string>;
}

/** One foreground voice connection. Monotonic utterance ids reject retries
 * without retaining an ever-growing audio/transcript or deduplication cache.
 * Consumers must not auto-retry a rejected or uncertain admission with a new id.
 */
export function createVoiceConversation(ports: VoiceConversationPorts) {
  // Each attachment has a fresh namespace: restarting voice on the SAME native
  // chat must not reuse a previous connection's durable prompt receipt IDs.
  const connectionId = randomUUID();
  let closed = false;
  let closing: Promise<void> | undefined;
  let lastUtterance = 0;
  let active: ActiveTurn | undefined;
  let openTurn: number | undefined;
  let stopping: Promise<void> | undefined;
  let admission: Promise<unknown> | undefined;
  let notice: { turn: number; text: string } | undefined;
  let openTurnHasUser = false;
  let noticeId = 0;
  const notices: { id: number; text: string }[] = [];
  const shares = new Map<string, { text: string; result: Promise<unknown> }>();
  function publicSpeech(text: string) {
    // Some providers put a thinking delimiter in an ordinary text block.
    const clean = text.includes("</think>") ? text.split("</think>").at(-1)! : text;
    return clean.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, "").trim().slice(0, 12000);
  }
  function deliver(current: ActiveTurn, event: VoiceEvent) {
    // Audio/network observers must never throw into the native session writer.
    try { current.sink(event); } catch { /* Transport shutdown owns interruption. */ }
  }
  function finish(status: string) {
    const current = active;
    if (!current) return;
    active = undefined;
    try { deliver(current, { type: "end", utterance: current.utterance, status }); }
    finally { current.settled(); }
  }
  const off = ports.subscribe(event => {
    const data = event.data as Record<string, any> | null;
    if (!data) return;
    if (event.type === "turn/start") { openTurn = data.turn; notice = undefined; openTurnHasUser = false; }
    if (event.type === "user/message" && data.source?.kind === "user") {
      openTurnHasUser = true;
      notice = !closed && shares.has(data.source.rpcId) && openTurn !== undefined ? { turn: openTurn, text: "" } : undefined;
    }
    if (!closed && !openTurnHasUser && event.type === "user/message" && data.source?.kind === "subagent-settled" && openTurn !== undefined) {
      notice = { turn: openTurn, text: "" };
    }
    if (notice && data.turn === notice.turn) {
      if (event.type === "assistant/message") {
        const text = (data.message?.content ?? []).filter((item: any) => item?.type === "text" && typeof item.text === "string").map((item: any) => item.text).join("\n");
        const speech = publicSpeech(text);
        if (speech) notice.text = (notice.text + "\n" + speech).trim().slice(0, 12000);
      } else if (event.type === "turn/end") {
        if (notice.text) { notices.push({ id: ++noticeId, text: notice.text }); while (notices.length > 16) notices.shift(); }
        notice = undefined;
      }
    }
    const current = active;
    if (!current) return;
    if (event.type === "user/message" && data.source?.kind === "user" && data.source.rpcId === current.requestId) {
      current.nativeTurn = openTurn;
    }
    if (current.nativeTurn === undefined || data.turn !== current.nativeTurn) return;
    const emit = (value: Omit<VoiceEvent, "utterance">) => deliver(current, { ...value, utterance: current.utterance });
    if (event.type === "assistant/chunk" && data.chunk?.type === "text-delta" && typeof data.chunk.text === "string") {
      current.text = (current.text + data.chunk.text).slice(-12000);
      emit({ type: "text", text: data.chunk.text });
    } else if (event.type === "tool/call" && typeof data.callId === "string" && typeof data.name === "string") {
      current.tasks.set(data.callId, data.name);
      emit({ type: "tool-start", callId: data.callId, name: data.name });
    } else if (event.type === "tool/result") {
      const result = data.message?.content?.[0];
      if (result?.type === "tool-result" && typeof result.toolCallId === "string") {
        emit({ type: "tool-end", callId: result.toolCallId, status: result.isError ? "error" : "completed" });
        if (!result.isError && ["hub_task", "hub_delegate"].includes(current.tasks.get(result.toolCallId) ?? "") && !publicSpeech(current.text)) {
          const turkish = /[çğıöşüÇĞİÖŞÜ]|\b(?:ne kadar|fiyat|bak|ara|bana|görev|dolar)\b/i.test(current.input);
          const text = turkish ? "HUB’a devrettim. Sonuç hazır olunca haber vereceğim." : "I've asked HUB to check. I'll let you know when the result is ready.";
          current.text = text; emit({ type: "text", text });
        }
      }
    } else if (event.type === "turn/end") {
      const reason = data.reason?.kind;
      finish(["completed", "aborted", "blocked", "error", "max-tokens", "interrupted"].includes(reason) ? reason : "error");
    }
  });
  function stopActive(status: string) {
    if (!active) return stopping ?? Promise.resolve();
    const requestId = active.requestId;
    // Drop the audio sink before cancelling: the native loop can synchronously
    // finalize a partial assistant message while unwinding the interrupted turn.
    finish(status);
    const pending = (async () => {
      // An interrupt may arrive while native admission is still awaiting its
      // checks. Let that admission settle before cancelling its queued work.
      try { await admission; } catch { /* Failed/uncertain admission also settles. */ }
      ports.cancel(requestId);
      await ports.whenIdle();
    })();
    stopping = pending;
    void pending.finally(() => { if (stopping === pending) stopping = undefined; }).catch(() => {});
    return pending;
  }
  return {
    sessionId: ports.sessionId,
    async share(requestId: string, text: string) {
      if (closed) throw new VoiceConversationError("closed");
      if (!/^[0-9a-f-]{36}$/i.test(requestId) || !text.trim() || Buffer.byteLength(text, "utf8") > 100_000) throw new VoiceConversationError("invalid-utterance");
      const id = `hub-voice-share:${ports.sessionId}:${connectionId}:${requestId}`;
      const prior = shares.get(id);
      if (prior) { if (prior.text !== text) throw new VoiceConversationError("already-admitted"); return prior.result; }
      if (shares.size >= 256) throw new VoiceConversationError("busy");
      // Register correlation before native admission can synchronously emit.
      const result = Promise.resolve().then(() => {
        if (closed) throw new VoiceConversationError("closed");
        return ports.prompt({ sessionId: ports.sessionId, requestId: id, mode: "queue", content: [{ type: "text", text }] });
      });
      shares.set(id, { text, result });
      return result;
    },
    notifications(after: number) {
      if (closed || active || stopping || ports.running()) return { events: [] };
      return { events: notices.filter(event => event.id > after).slice(0, 4).map(event => ({ ...event })) };
    },
    async speak(utterance: number, text: string, sink: (event: VoiceEvent) => void): Promise<void> {
      if (closed) throw new VoiceConversationError("closed");
      if (!Number.isSafeInteger(utterance) || utterance < 1 || typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > 16_000) {
        throw new VoiceConversationError("invalid-utterance");
      }
      if (utterance <= lastUtterance) throw new VoiceConversationError("already-admitted");
      // A child-completion notification may own the native loop between spoken
      // turns. Use its existing queue, retaining one foreground utterance and
      // exact RPC correlation rather than dropping the next human command.
      if (active || stopping) throw new VoiceConversationError("busy");
      lastUtterance = utterance;
      let resolve!: () => void;
      const settled = new Promise<void>(done => { resolve = done; });
      const requestId = `hub-voice:${ports.sessionId}:${connectionId}:${utterance}`;
      active = { utterance, requestId, sink, settled: resolve, text: "", input: text, tasks: new Map() };
      try {
        admission = ports.prompt({ sessionId: ports.sessionId, requestId, mode: "queue", content: [{ type: "text", text: text.trim() }] });
        await admission;
      } catch {
        // Admission may have partially succeeded. Do not reuse its id or claim
        // completion, and never automatically resubmit the spoken command.
        if (active?.utterance === utterance) await stopActive("error");
        throw new VoiceConversationError("prompt-failed");
      }
      await ports.whenIdle();
      // Rejection or failure before user/message has no correlated native turn.
      if (active?.utterance === utterance) finish("error");
      await settled;
    },
    async interrupt(utterance: number): Promise<void> {
      // A delayed interrupt for an older utterance must not stop a newer one.
      if (active?.utterance === utterance) await stopActive("aborted");
      else if (utterance === lastUtterance && stopping) await stopping;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      notices.length = 0; notice = undefined;
      off();
      closing = (async () => {
        await Promise.allSettled([...shares.values()].map(item => item.result));
        for (const id of shares.keys()) ports.cancel(id);
        await stopActive("aborted");
        // A native notification can own the loop without a foreground voice
        // utterance. Do not detach call-time policy until that work is idle.
        await ports.whenIdle();
      })();
      // Preserve a failed shutdown verdict on retries: never imply that an
      // uncertain native turn stopped merely because admission is now closed.
      return closing;
    },
  };
}
