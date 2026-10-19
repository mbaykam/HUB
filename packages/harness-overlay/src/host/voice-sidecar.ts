import { randomBytes } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import type { Readable } from "node:stream";
import { parseVoiceIceServers, type VoiceIceServer } from "../voice-ice-contract.ts";
import { localSpeechSchema, type LocalSpeechConfig } from "../voice-profile-contract.ts";

interface ProcessHandle {
  stdout?: Readable;
  done: Promise<{ exitCode: number | null; signal: string | null }>;
  terminate(): void;
  waitForExit(signal?: AbortSignal): Promise<boolean>;
}
export interface VoiceSubprocess {
  resolveExecutable(command: string, options: Record<string, never>, signal: AbortSignal): Promise<string>;
  spawn(spec: {
    argv: readonly string[]; cwd: string;
    stdio: { stdin: "ignore"; stdout: "pipe"; stderr: { maxBytes: number } };
    graceMs: number; signal: AbortSignal; env: Record<string, string | undefined>;
  }): ProcessHandle;
}
export type VoiceProcessRoute = "/offer" | "/status" | "/interrupt" | "/attention" | "/prepare" | "/admit" | "/release";
export interface VoiceCallCapability { callId: string; token: string }
export interface VoiceSidecar {
  done: ProcessHandle["done"];
  request(path: VoiceProcessRoute, method: "GET" | "POST" | "PATCH", body?: unknown, signal?: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }>;
  requestCall?(capability: VoiceCallCapability, path: "/offer" | "/status" | "/interrupt" | "/attention" | "/ice", method: "GET" | "POST" | "PATCH", body?: unknown, signal?: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }>;
  stop(): Promise<void>;
}
export class VoiceSidecarCleanupError extends Error {
  constructor() { super("Voice process cleanup could not be confirmed"); }
}
export function voiceRuntimeEnvironment(ambient: NodeJS.ProcessEnv): Record<string, string | undefined> {
  // Native subprocess also scrubs credentials. Tombstone every nonessential
  // ambient entry so plugin paths, Python injection and setup hooks stay out.
  const env = Object.fromEntries(Object.entries(ambient).map(([key, value]) => [key,
    /^(SystemRoot|WINDIR|PATH|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|HOME)$/i.test(key) ? value : undefined]));
  return { ...env, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1",
    HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" };
}
export function voiceSidecarEnvironment(ambient: NodeJS.ProcessEnv, capability: {
  bridgeUrl: string; bridgeToken: string; callId: string; controlToken: string; speech?: LocalSpeechConfig;
}): Record<string, string | undefined> {
  return { ...voiceRuntimeEnvironment(ambient),
    ...(capability.speech ? { HUB_VOICE_SPEECH: JSON.stringify(localSpeechSchema.parse(capability.speech)) } : {}),
    HUB_VOICE_BRIDGE_URL: capability.bridgeUrl, HUB_VOICE_BRIDGE_TOKEN: capability.bridgeToken,
    HUB_VOICE_CALL_ID: capability.callId, HUB_VOICE_CONTROL_TOKEN: capability.controlToken };
}

/** Native DSH owns process spawning, secret scrub and whole-tree termination.
 * This adapter owns only voice readiness and bounded loopback JSON protocol.
 */
export async function startVoiceSidecar(subprocess: VoiceSubprocess, config: {
  python: string; script: string; bridgeUrl: string; bridgeToken: string; callId: string;
  speech?: LocalSpeechConfig;
  iceServers?: VoiceIceServer[];
  telegramAccount?: string;
}, signal: AbortSignal, ports: { fetch?: typeof fetch; environment?: NodeJS.ProcessEnv; startupMs?: number } = {}): Promise<VoiceSidecar> {
  if (!isAbsolute(config.python) || !isAbsolute(config.script)) throw new Error("Voice runtime paths must be absolute");
  signal.throwIfAborted();
  const iceServers = config.iceServers === undefined ? undefined : parseVoiceIceServers(config.iceServers);
  const controlToken = randomBytes(32).toString("base64url");
  const executable = await subprocess.resolveExecutable(config.python, {}, signal);
  const child = subprocess.spawn({ argv: [executable, "-u", config.script], cwd: dirname(config.script),
    stdio: { stdin: "ignore", stdout: "pipe", stderr: { maxBytes: 16_384 } }, graceMs: 1000, signal,
    env: { ...voiceSidecarEnvironment(ports.environment ?? process.env, { ...config, controlToken }),
      ...(config.telegramAccount ? { HUB_TELEGRAM_CALL_ACCOUNT: config.telegramAccount } : {}) },
  });
  const fetcher = ports.fetch ?? fetch;
  let url = "";
  let exited = false;
  void child.done.then(() => { exited = true; }, () => { exited = true; });
  async function send(path: VoiceProcessRoute | "/close" | "/ice" | "/call/offer" | "/call/status" | "/call/interrupt" | "/call/attention" | "/call/ice", method: "GET" | "POST" | "PATCH", body?: unknown, requestSignal?: AbortSignal, capability?: VoiceCallCapability) {
    if (exited) throw new Error("Voice process has exited");
    const response = await fetcher(url + path, { method, redirect: "error",
      headers: { authorization: `Bearer ${capability?.token ?? controlToken}`, ...(capability ? { "x-hub-runtime-call": capability.callId } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([signal, ...(requestSignal ? [requestSignal] : []), AbortSignal.timeout(["/offer", "/call/offer", "/prepare", "/admit"].includes(path) ? 60_000 : 5000)]),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Voice process returned no response");
    const parts: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 150_000) throw new Error("Voice response exceeded its limit");
        parts.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const value: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid voice response");
    return { status: response.status, body: value as Record<string, unknown> };
  }
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let pending = "";
      let received = 0;
      let ready = false;
      const timer = setTimeout(() => fail(), ports.startupMs ?? 30_000);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", fail); };
      const fail = () => { if (!ready) { ready = true; cleanup(); reject(new Error("Voice process failed to become ready")); } };
      signal.addEventListener("abort", fail, { once: true });
      void child.done.then(fail, fail);
      if (!child.stdout) { fail(); return; }
      // Keep draining after readiness without retaining/logging child output.
      child.stdout.on("data", (chunk: Buffer) => {
        if (ready) return;
        received += chunk.length;
        if (received > 16_384) { fail(); return; }
        pending += chunk.toString("utf8");
        const end = pending.indexOf("\n");
        if (end === -1) return;
        try {
          const value = JSON.parse(pending.slice(0, end));
          if (value.type !== "hub-voice-ready" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65_535) { fail(); return; }
          ready = true; cleanup(); resolve(value.port);
        } catch { fail(); }
      });
      child.stdout.on("error", fail);
      if (signal.aborted) fail();
    });
    url = `http://127.0.0.1:${port}`;
    const health = await send("/status", "GET");
    if (health.status !== 200 || health.body.status !== "waiting") throw new Error("Voice process readiness check failed");
    if (iceServers !== undefined) {
      const configured = await send("/ice", "POST", { iceServers });
      if (configured.status !== 200 || configured.body.ok !== true) throw new Error("Voice ICE setup failed");
    }
  } catch {
    child.terminate();
    let stopped = false;
    try { stopped = await child.waitForExit(AbortSignal.timeout(5000)); } catch { /* Fail closed below. */ }
    if (!stopped) throw new VoiceSidecarCleanupError();
    throw new Error("Voice runtime could not start");
  }
  let stopping: Promise<void> | undefined;
  return {
    done: child.done,
    request: (path, method, body, requestSignal) => send(path, method, body, requestSignal),
    requestCall(capability, path, method, body, requestSignal) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(capability.token) || !/^[A-Za-z0-9._-]{1,200}$/.test(capability.callId)) return Promise.reject(new Error("Invalid voice call capability"));
      return send(`/call${path}`, method, body, requestSignal, capability);
    },
    stop() {
      return stopping ??= (async () => {
        try { if (!exited) await send("/close", "POST", undefined, AbortSignal.timeout(3000)); }
        catch { /* Tree termination is the native fallback after graceful close. */ }
        child.terminate();
        if (!await child.waitForExit(AbortSignal.timeout(5000))) throw new Error("Voice process did not exit");
      })();
    },
  };
}
