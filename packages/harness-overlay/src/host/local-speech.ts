import { dirname, isAbsolute } from "node:path";
import { localSpeechCatalogSchema, type LocalSpeechCatalog, type LocalSpeechConfig } from "../voice-profile-contract.ts";
import { voiceRuntimeEnvironment, VoiceSidecarCleanupError, type VoiceSubprocess } from "./voice-sidecar.ts";

/** Read installed cache metadata using the same Python runtime and scrubbed
 * environment as a real call. Never download, load inference models or start a
 * microphone. The executable/script are host-owned, not HTTP parameters. */
export async function readLocalSpeechCatalog(subprocess: VoiceSubprocess, python: string, script: string, signal: AbortSignal): Promise<LocalSpeechCatalog> {
  if (!isAbsolute(python) || !isAbsolute(script)) throw new Error("Speech runtime paths must be absolute");
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  const executable = await subprocess.resolveExecutable(python, {}, deadline);
  deadline.throwIfAborted();
  const child = subprocess.spawn({ argv: [executable, "-u", script], cwd: dirname(script), signal: deadline, graceMs: 1000,
    stdio: { stdin: "ignore", stdout: "pipe", stderr: { maxBytes: 4096 } }, env: voiceRuntimeEnvironment(process.env),
  });
  let exited = false;
  void child.done.then(() => { exited = true; }, () => {});
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => { child.terminate(); reject(new Error("Local speech scan was interrupted")); };
    deadline.addEventListener("abort", abort, { once: true });
    if (deadline.aborted) abort();
  });
  try {
    return await Promise.race([cancelled, (async () => {
      if (!child.stdout) throw new Error("Local speech scan has no output");
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of child.stdout) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 32768) throw new Error("Local speech scan exceeded its limit");
        chunks.push(bytes);
      }
      const result = await child.done;
      if (result.exitCode !== 0 || result.signal !== null) throw new Error("Local speech scan failed");
      return localSpeechCatalogSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    })()]);
  } finally {
    if (abort) deadline.removeEventListener("abort", abort);
    if (!exited) {
      child.terminate();
      let stopped = false;
      try { stopped = await child.waitForExit(AbortSignal.timeout(5000)); } catch { /* Uncertain cleanup remains fail-closed. */ }
      if (!stopped) throw new VoiceSidecarCleanupError();
    }
  }
}

export function validateLocalSpeech(catalog: LocalSpeechCatalog, speech: LocalSpeechConfig): void {
  if (!catalog.stt.some(model => model.engine === speech.stt.engine && model.model === speech.stt.model && model.available)) throw new Error("The selected speech-to-text model is not installed on the host PC");
  if (!catalog.tts.some(model => model.engine === speech.tts.engine && model.model === speech.tts.model && model.available && model.voices.some(voice => voice === speech.tts.voice))) throw new Error("The selected text-to-speech model or voice is not installed on the host PC");
}
