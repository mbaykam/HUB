import { randomBytes } from "node:crypto";
import { localSpeechSchema, type LocalSpeechConfig } from "../voice-profile-contract.ts";
import { parseVoiceIceServers, type VoiceIceServer } from "../voice-ice-contract.ts";
import { startVoiceSidecar, VoiceSidecarCleanupError, type VoiceSidecar, type VoiceSubprocess } from "./voice-sidecar.ts";

/** Owns prepared PWA weights, not a conversation. Every lease binds fresh
 * control credentials and a fresh Python call app. Closing a call retains
 * weights; closing this owner confirms whole-process termination. */
export function createPreparedVoiceRuntime(subprocess: VoiceSubprocess, config: {
  python: string; script: string; bridgeUrl: string; bridgeToken: string;
  sonioxKey?(): Promise<string | undefined>;
}, signal: AbortSignal, ports: { start?: typeof startVoiceSidecar } = {}) {
  let process: VoiceSidecar | undefined;
  let starting: Promise<VoiceSidecar> | undefined;
  let current: { callId: string; stop(): Promise<void>; settle(result: { exitCode: number | null; signal: string | null }): void } | undefined;
  let admitting = false, closed = false;
  let state: "cold" | "warming" | "ready" | "unavailable" = "cold";

  async function ensure(speech: LocalSpeechConfig): Promise<VoiceSidecar> {
    if (closed) throw new Error("Voice runtime is closed");
    signal.throwIfAborted();
    const normalized = localSpeechSchema.parse(speech);
    if (!process) {
      state = "warming";
      starting ??= (ports.start ?? startVoiceSidecar)(subprocess, { ...config, callId: "unbound-runtime", speech: normalized }, signal)
        .then(value => { process = value; void value.done.then(result => { current?.settle(result); current = undefined; process = undefined; state = "unavailable"; }, () => { current?.settle({ exitCode: null, signal: "runtime-exited" }); current = undefined; process = undefined; state = "unavailable"; }); return value; })
        .finally(() => { starting = undefined; });
      process = await starting;
    }
    return process;
  }

  return {
    status: () => state,
    async prepare(speech: LocalSpeechConfig) {
      if (current || admitting) return;
      state = "warming";
      try {
        const owned = await ensure(speech);
        const result = await owned.request("/prepare", "POST", { speech });
        if (result.status !== 200 || result.body.ok !== true) throw new Error("Voice models could not prepare");
        state = "ready";
      } catch (error) { state = "unavailable"; throw error; }
    },
    async open(callId: string, speech: LocalSpeechConfig, iceServers: VoiceIceServer[] = [], requestSignal: AbortSignal): Promise<VoiceSidecar> {
      if (current || admitting || closed) throw new Error("Voice runtime is busy");
      const normalized = localSpeechSchema.parse(speech), relay = parseVoiceIceServers(iceServers);
      admitting = true;
      const capability = { callId, token: randomBytes(32).toString("base64url") };
      let owned: VoiceSidecar | undefined;
      try {
        owned = await ensure(normalized);
        if (!owned.requestCall) throw new Error("Voice runtime does not support isolated calls");
        const sonioxKey = normalized.stt.engine === "soniox" ? await config.sonioxKey?.() : undefined;
        if (normalized.stt.engine === "soniox" && !sonioxKey) throw new Error("Connect Soniox in Settings → Speech before starting a call");
        const result = await owned.request("/admit", "POST", { callId, token: capability.token, speech: normalized,
          ...(sonioxKey ? { sonioxKey } : {}) }, requestSignal);
        if (result.status !== 200 || result.body.ok !== true) throw new Error("Voice runtime could not admit this call");
        if (relay.length) {
          const configured = await owned.requestCall(capability, "/ice", "POST", { iceServers: relay }, requestSignal);
          if (configured.status !== 200 || configured.body.ok !== true) throw new Error("Voice relay could not configure");
        }
        let settle!: (result: { exitCode: number | null; signal: string | null }) => void;
        const done = new Promise<{ exitCode: number | null; signal: string | null }>(resolve => { settle = resolve; });
        let stopping: Promise<void> | undefined;
        const call: VoiceSidecar = {
          done,
          request(path, method, body, callSignal) {
            if (current?.callId !== callId || stopping || !["/offer", "/status", "/interrupt", "/attention"].includes(path)) return Promise.reject(new Error("This voice call is closed"));
            return owned!.requestCall!(capability, path as "/offer" | "/status" | "/interrupt" | "/attention", method, body, callSignal);
          },
          stop() {
            return stopping ??= (async () => {
              try {
                const released = await owned!.request("/release", "POST", { callId });
                if (released.status !== 200 || released.body.ok !== true) throw new Error("Release rejected");
              } catch { closed = true; throw new VoiceSidecarCleanupError(); }
              if (current?.callId === callId) current = undefined;
              settle({ exitCode: 0, signal: null });
            })();
          },
        };
        current = { callId, stop: call.stop, settle };
        state = "ready";
        return call;
      } catch (error) {
        if (owned) {
          try {
            const released = await owned.request("/release", "POST", { callId });
            if (released.status !== 200 || released.body.ok !== true) throw new Error("Release rejected");
          } catch { closed = true; throw new VoiceSidecarCleanupError(); }
        }
        throw error;
      } finally { admitting = false; }
    },
    async close() {
      closed = true;
      await starting?.catch(() => {});
      const owned = process;
      try { await current?.stop(); }
      finally { await owned?.stop(); }
    },
  };
}
