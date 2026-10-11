import { randomUUID } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { speechModelInstallSchema, type SpeechModelInstall } from "../voice-profile-contract.ts";
import { voiceRuntimeEnvironment, VoiceSidecarCleanupError, type VoiceSubprocess } from "./voice-sidecar.ts";

type Phase = "starting" | "downloading" | "verifying" | "complete" | "failed";
export type SpeechDownload = SpeechModelInstall & { id: string; phase: Phase };

/** One bounded model-only download owned by the native subprocess service.
 * Closing the PWA does not cancel it. Host shutdown does, leaving upstream HF
 * cache locks/partial blobs to its established resumable-download handling. */
export function createSpeechModelDownloads(subprocess: VoiceSubprocess, python: string, script: string, signal: AbortSignal, changed: () => void) {
  if (!isAbsolute(python) || !isAbsolute(script)) throw new Error("Speech download paths must be absolute");
  let job: SpeechDownload | undefined, flight: Promise<void> | undefined, poisoned = false;
  const lifetime = new AbortController();
  const status = () => job ? { ...job } : null;
  async function run(current: SpeechDownload) {
    const deadline = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(30 * 60 * 1000)]);
    const executable = await subprocess.resolveExecutable(python, {}, deadline); deadline.throwIfAborted();
    const child = subprocess.spawn({ argv: [executable, "-u", script, current.engine, current.model], cwd: dirname(script),
      stdio: { stdin: "ignore", stdout: "pipe", stderr: { maxBytes: 4096 } }, graceMs: 1000, signal: deadline,
      env: { ...voiceRuntimeEnvironment(process.env), HF_HUB_OFFLINE: "0", HF_HUB_DISABLE_IMPLICIT_TOKEN: "1" },
    });
    let exited = false, complete = false; void child.done.then(() => { exited = true; }, () => {});
    let cancel!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { cancel = reject; });
    const abort = () => { child.terminate(); cancel(new Error("Speech download stopped")); };
    deadline.addEventListener("abort", abort, { once: true }); if (deadline.aborted) abort();
    try {
      await Promise.race([cancelled, (async () => {
        if (!child.stdout) throw new Error("Speech download has no output");
        let pending = "", size = 0, progress = 0;
        for await (const chunk of child.stdout) {
          size += Buffer.byteLength(chunk); if (size > 65536) throw new Error("Speech download exceeded output limit");
          pending += chunk.toString();
          for (;;) {
            const end = pending.indexOf("\n"); if (end < 0) break;
            const line = pending.slice(0, end); pending = pending.slice(end + 1);
            const value = JSON.parse(line);
            if (!value || Object.keys(value).length !== 1 || value.phase !== ["downloading", "verifying", "complete"][progress++]) throw new Error("Invalid download progress");
            if (value.phase === "complete") complete = true;
            // Complete means successful process exit AND verification, not just
            // a progress message. Preserve the working phase until both agree.
            current.phase = value.phase === "complete" ? "verifying" : value.phase;
          }
        }
        const result = await child.done;
        if (result.exitCode !== 0 || result.signal !== null || !complete || pending.trim()) throw new Error("Speech download failed");
        current.phase = "complete"; changed();
      })()]);
    } finally {
      deadline.removeEventListener("abort", abort);
      if (!exited) {
        child.terminate();
        let stopped = false; try { stopped = await child.waitForExit(AbortSignal.timeout(5000)); } catch { /* Fail closed below. */ }
        if (!stopped) throw new VoiceSidecarCleanupError();
      }
    }
  }
  return { status,
    start(value: unknown) {
      const selection = speechModelInstallSchema.parse(value);
      if (signal.aborted || lifetime.signal.aborted || poisoned) throw new Error("Downloads require host recovery");
      if (flight) {
        if (job?.engine === selection.engine && job.model === selection.model) return status();
        throw new Error("Another model is downloading");
      }
      job = { ...selection, id: randomUUID(), phase: "starting" }; const current = job;
      flight = run(current).catch(error => { current.phase = "failed"; if (error instanceof VoiceSidecarCleanupError) poisoned = true; })
        .finally(() => { flight = undefined; });
      return status();
    },
    async close() { lifetime.abort(); await flight; },
  };
}

export function createSpeechModelsHandler(downloads: ReturnType<typeof createSpeechModelDownloads>, reject: (request: IncomingMessage) => 401 | 403 | undefined) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store, private", "cross-origin-resource-policy": "same-origin", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(body)); };
    const rejection = reject(request);
    if (rejection || request.headers["sec-fetch-site"] === "cross-site") { send(rejection ?? 403, { error: "unauthorized" }); return; }
    if (request.method === "GET") { send(200, { download: downloads.status() }); return; }
    if (request.method !== "POST") { send(405, { error: "method-not-allowed" }); return; }
    if (request.headers["x-hub-speech-models"] !== "1") { send(403, { error: "unauthorized" }); return; }
    if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") { send(415, { error: "json-required" }); return; }
    let command;
    try {
      let body = ""; for await (const chunk of request) { body += chunk.toString(); if (Buffer.byteLength(body) > 2048) { send(413, { error: "request-too-large" }); return; } }
      command = speechModelInstallSchema.parse(JSON.parse(body));
    } catch { send(400, { error: "invalid-model" }); return; }
    try { send(202, { download: downloads.start(command) }); }
    catch { send(409, { error: "download-busy-or-unavailable" }); }
  };
}
