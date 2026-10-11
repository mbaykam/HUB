import { PipecatClient } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
import { parseVoiceIceServers } from "../../voice-ice-contract.ts";
import type { LocalSpeechConfig } from "../../voice-profile-contract.ts";

export type VoiceState = "idle" | "microphone" | "starting" | "connecting" | "listening" | "thinking" | "speaking" | "ending" | "error";
export interface VoiceClientOptions {
  /** Persistent element owned by the PWA shell, not the current Home/chat view. */
  audio: HTMLAudioElement;
  onState(state: VoiceState): void;
  onSession(sessionId: string): void;
  onCall?(callId: string | undefined): void;
  onProfile?(profile: { id: string; name: string; revision: number; speech?: LocalSpeechConfig } | undefined): void;
  onTranscript(role: "user" | "assistant", text: string, final: boolean): void;
  onActivity(event: unknown): void;
  onAudioBlocked(): void;
  onError(message: string): void;
  onNotice?(message: string): void;
}

/** Separate browser ESM entry: never imported by the startup CJS client bundle.
 * Uses official Pipecat signaling/RTVI, no custom audio or task protocol.
 * Construction and module evaluation do not request a microphone. start() must
 * be called from the user's explicit Voice gesture.
 */
export function createVoiceClient(options: VoiceClientOptions) {
  let client: PipecatClient | undefined;
  let call: { callId: string; sessionId: string } | undefined;
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let cancelled = false;
  const localTracks = new Set<MediaStreamTrack>();
  const state = (value: VoiceState) => { if (!cancelled || value === "ending" || value === "idle") options.onState(value); };
  async function request(action: string, body?: unknown) {
    const response = await fetch(`/api/hub/voice/${action}`, {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error("Sign in to HUB again to use voice.");
      if (response.status === 409) throw new Error("Another voice call is active. End it before starting a new one.");
      throw new Error("Voice could not connect. Please try again.");
    }
    return await response.json();
  }
  async function play() {
    try { await options.audio.play(); }
    catch { if (!cancelled) options.onAudioBlocked(); }
  }
  async function release() {
    const current = client; client = undefined;
    const owned = call; call = undefined;
    options.onCall?.(undefined);
    options.onProfile?.(undefined);
    // Release physical input immediately, including cancellation during startup.
    for (const track of localTracks) track.stop();
    localTracks.clear();
    options.audio.pause(); options.audio.srcObject = null;
    const results = await Promise.allSettled([
      current?.disconnect(),
      owned ? request("close", { callId: owned.callId }) : undefined,
    ]);
    if (results.some(result => result.status === "rejected")) options.onError("Audio stopped. HUB could not confirm server cleanup; it will expire the call automatically.");
  }
  function stop(): Promise<void> {
    if (stopping) return stopping;
    cancelled = true; state("ending");
    for (const track of localTracks) track.stop();
    options.audio.pause();
    // Abort the SDK's pending connect/bot-ready wait before awaiting startup.
    // Device permission initialization is allowed to settle, then its tracks
    // are stopped; browser permission prompts themselves cannot be aborted.
    if (call && client) void client.disconnect().catch(() => {});
    // Never abandon a pending admission: recover its owned ID and close it.
    const pending = starting;
    stopping = (async () => {
      await pending?.catch(() => {});
      await release(); state("idle");
    })().finally(() => { stopping = undefined; });
    return stopping;
  }
  function start(sessionId?: string): Promise<void> {
    if (starting || client || stopping) return Promise.reject(new Error("A voice connection is already active."));
    if (!window.isSecureContext) return Promise.reject(new Error("Voice needs a secure HTTPS connection."));
    cancelled = false;
    const transport = new SmallWebRTCTransport();
    const next = new PipecatClient({ transport, enableMic: true, enableCam: false, enableScreenShare: false,
      callbacks: {
        onTrackStarted(track, participant) {
          if (participant?.local) { localTracks.add(track); if (cancelled) track.stop();
            else if(track.kind==="audio")void track.applyConstraints({echoCancellation:true,noiseSuppression:true,autoGainControl:true}).catch(()=>{});
            return; }
          if (track.kind === "audio" && !cancelled) { options.audio.srcObject = new MediaStream([track]); void play(); }
        },
        onBotReady: () => state("listening"),
        onUserStartedSpeaking: () => state("listening"),
        onBotLlmStarted: () => state("thinking"),
        onBotStartedSpeaking: () => state("speaking"),
        onBotStoppedSpeaking: () => state("listening"),
        onUserTranscript: data => { if (!cancelled) options.onTranscript("user", data.text, data.final); },
        onBotTtsText: data => { if (!cancelled) options.onTranscript("assistant", data.text, true); },
        onServerMessage: data => { if (!cancelled && data?.type === "hub-voice-activity") options.onActivity(data.event); },
        onDisconnected: () => { if (!cancelled) void stop(); },
        onError: message => {
          if (cancelled) return;
          // Stock RTVI distinguishes a recoverable turn/service warning from
          // a fatal connection error. A silent TTS segment must not hang up an
          // otherwise healthy hands-free call or replay a tool-bearing turn.
          if (message.data && typeof message.data === "object" && "fatal" in message.data && message.data.fatal === false) {
            (options.onNotice ?? options.onError)("Part of that voice turn had a problem. You can keep talking; check the conversation before repeating a task.");
          } else {
            options.onError("The voice connection was interrupted."); void stop();
          }
        },
      },
    });
    client = next;
    starting = (async () => {
      try {
        state("microphone");
        await next.initDevices();
        if (cancelled) return;
        state("starting");
        const status = await request("status");
        if (cancelled) return;
        if (!Number.isSafeInteger(status.serverTime)) throw new Error("HUB returned an invalid voice status.");
        const admission = { requestId: crypto.randomUUID(), requestedAt: status.serverTime, ...(sessionId ? { sessionId } : {}) };
        let opened;
        try { opened = await request("open", admission); }
        catch {
          // Recover a lost response using exactly the same receipt; no second
          // conversation, microphone or native subprocess may be admitted.
          opened = await request("open", admission);
        }
        if (typeof opened.callId !== "string" || typeof opened.sessionId !== "string") throw new Error("HUB returned an invalid voice connection.");
        call = { callId: opened.callId, sessionId: opened.sessionId };
        if (cancelled) return;
        options.onSession(call.sessionId); state("connecting");
        options.onCall?.(call.callId);
        if (opened.profile && typeof opened.profile.id === "string" && typeof opened.profile.name === "string" && Number.isSafeInteger(opened.profile.revision)) options.onProfile?.(opened.profile);
        const iceServers = parseVoiceIceServers(opened.iceServers ?? []);
        await next.connect({ iceConfig: { iceServers }, webrtcRequestParams: {
          endpoint: "/api/hub/voice/offer", headers: new Headers({ "x-hub-voice-call": call.callId }),
        } });
        if (!cancelled) state("listening");
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof DOMException && error.name === "NotAllowedError"
            ? "Microphone access is blocked. Allow it in your browser settings, then try again."
            : error instanceof Error ? error.message : "Voice could not start.";
          options.onError(message); state("error");
        }
        await release();
        throw error;
      }
    })().finally(() => { starting = undefined; });
    return starting;
  }
  return {
    start, stop, play,
    async interrupt() {
      if (!client?.connected || cancelled || !call) throw new Error("Voice is not connected yet.");
      await request("interrupt", { callId: call.callId });
    },
    mute(muted: boolean) { client?.enableMic(!muted); },
    async sendText(text: string) {
      if (!client?.connected || cancelled) throw new Error("Voice is not connected yet.");
      if (!text.trim() || text.length > 12_000) throw new Error("Enter a message of up to 12,000 characters.");
      // Official RTVI sends typed input into the SAME context/LLM pipeline,
      // interrupting current speech just like a spoken barge-in.
      await client.sendText(text, { run_immediately: true, audio_response: true });
    },
  };
}
