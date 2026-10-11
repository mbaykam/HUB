import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { open } from "node:fs/promises";
import { localSpeechSchema, type LocalSpeechCatalog, type LocalSpeechConfig } from "../voice-profile-contract.ts";
import { voiceRuntimeEnvironment, type VoiceSubprocess } from "./voice-sidecar.ts";

/** Bilingual and standalone engines share the same fixed, persistent recordings. */
export function speechSampleName(tts: LocalSpeechConfig["tts"], language: string) {
  const voice = tts.engine === "bilingual" && language === "tr" ? tts.turkishVoice : tts.voice;
  if (!voice || !/^[a-zA-Z0-9_-]{1,80}$/.test(voice)) throw new Error("Invalid sample voice");
  return `v1-${language}-${voice}.wav`;
}
export function createSpeechPreviewHandler(ports: {
  subprocess: VoiceSubprocess; python: string; script: string; signal: AbortSignal;
  reject(request: IncomingMessage): 401 | 403 | undefined;
  catalog(): Promise<LocalSpeechCatalog>; sampleDir?: string;
}) {
  const directory = ports.sampleDir ?? join(homedir(), ".dsh", "hub-voice-samples");
  async function sample(name: string) {
    const file = await open(join(directory, name), "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 44 || stat.size > 2_000_000) throw new Error("Invalid sample size");
      const wav = await file.readFile();
      if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("Invalid sample format");
      return wav;
    } finally { await file.close(); }
  }
  let preparing: Promise<void> | undefined;
  async function prepare() {
    if (preparing || ports.signal.aborted) return preparing;
    preparing = (async () => {
      const catalog = await ports.catalog();
      const names = new Set(catalog.tts.filter(t => t.available && t.engine !== "bilingual").flatMap(t => t.voices.flatMap(voice =>
        (t.engine === "supertonic" ? ["en", "tr"] : [voice.startsWith("tr_") ? "tr" : "en"]).map(language => speechSampleName({ engine: t.engine, model: t.model, voice } as LocalSpeechConfig["tts"], language)))));
      if ((await Promise.all([...names].map(n => sample(n).then(() => true, () => false)))).every(Boolean)) return;
      const signal = AbortSignal.any([ports.signal, AbortSignal.timeout(300000)]);
      const executable = await ports.subprocess.resolveExecutable(ports.python, {}, signal);
      const child = ports.subprocess.spawn({ argv: [executable, "-u", ports.script, "--prepare-all", directory], cwd: dirname(ports.script),
        env: voiceRuntimeEnvironment(process.env), stdio: { stdin: "ignore", stdout: "pipe", stderr: { maxBytes: 4096 } }, graceMs: 1000, signal });
      try {
        if (child.stdout) for await (const _chunk of child.stdout) { /* finite fixed catalog, no user content */ }
        if ((await child.done).exitCode !== 0) throw new Error("Sample preparation failed");
      } finally { child.terminate(); if (!await child.waitForExit(AbortSignal.timeout(5000))) throw new Error("Sample cleanup uncertain"); }
    })().finally(() => { preparing = undefined; });
    return preparing;
  }
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, error: string) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ error })); };
    const rejection = ports.reject(request);
    if (rejection || request.headers["sec-fetch-site"] === "cross-site") { send(rejection ?? 403, "unauthorized"); return; }
    if (request.method !== "POST") { send(405, "method-not-allowed"); return; }
    if (request.headers["x-hub-speech-preview"] !== "1" || request.headers["content-type"]?.split(";")[0] !== "application/json") { send(403, "preview-marker-required"); return; }
    try {
      let text = ""; for await (const chunk of request) { text += chunk.toString(); if (Buffer.byteLength(text) > 2048) { send(413, "request-too-large"); return; } }
      const input = JSON.parse(text);
      if (Object.keys(input).sort().join(",") !== "language,tts" || !["en", "tr"].includes(input.language)) { send(400, "invalid-preview"); return; }
      const parsed = localSpeechSchema.shape.tts.safeParse(input.tts);
      if (!parsed.success) { send(400, "invalid-preview"); return; }
      const tts = parsed.data, catalog = await ports.catalog();
      if (!catalog.tts.some(item => item.engine === tts.engine && item.model === tts.model && item.available && item.voices.some(voice => voice === tts.voice))) { send(409, "voice-not-installed"); return; }
      if (tts.engine === "kokoro" && input.language !== "en" || tts.engine === "piper" && input.language !== (tts.voice.startsWith("tr_") ? "tr" : "en")) { send(400, "voice-language-unavailable"); return; }
      if (tts.engine === "bilingual" && input.language === "tr" && !catalog.tts.some(item => item.engine === "piper" && item.model === tts.turkishVoice && item.available)) { send(409, "voice-not-installed"); return; }
      // Listen only reads recordings. Missing samples are prepared while idle.
      const wav = await sample(speechSampleName(tts, input.language));
      response.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length, "cache-control": "private, no-store", "x-content-type-options": "nosniff" }); response.end(wav);
    } catch { send(503, "sample-not-ready"); }
  };
  return Object.assign(handler, { prepare });
}
