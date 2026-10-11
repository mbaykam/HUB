import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { speechSampleName } from "@minke/harness-overlay/host/speech-preview.ts";
import { createSpeechPreviewHandler } from "@minke/harness-overlay/host/speech-preview.ts";

test("audition reads durable fixed recordings without spawning inference; rejects untrusted requests", async () => {
  let spawns = 0, terminated = 0;
  const wav = Buffer.alloc(48); wav.write("RIFF"); wav.write("WAVE", 8);
  const tts = { engine: "kokoro", model: "82m", voice: "am_echo" };
  const sampleDir = await mkdtemp(join(tmpdir(), "hub-speech-samples-"));
  await writeFile(join(sampleDir,"v1-en-am_echo.wav"),wav);
  const handler = createSpeechPreviewHandler({ sampleDir, python: "C:/fixed/python.exe", script: "C:/fixed/speech_preview.py", signal: new AbortController().signal,
    reject: request => request.headers.cookie !== "fixture" ? 401 : undefined,
    async catalog() { return { stt: [], tts: [{ ...tts, available: true, voices: ["am_echo"], reason: null }] }; },
    subprocess: { async resolveExecutable(python) { return python; }, spawn(spec) {
      spawns++; assert.equal(spec.argv[2], "C:/fixed/speech_preview.py");
      const selection = JSON.parse(Buffer.from(spec.argv[3], "base64url").toString());
      assert.deepEqual(selection, { tts, language: "en" }); assert.equal(spec.env.HF_HUB_OFFLINE, "1");
      assert.equal(spec.env.OPENAI_API_KEY, undefined);
      return { stdout: Readable.from([wav]), done: Promise.resolve({ exitCode: 0, signal: null }), terminate() { terminated++; }, async waitForExit() { return true; } };
    } } });
  const server = createServer((request, response) => void handler(request, response)); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/preview`;
  const request = (body = { tts, language: "en" }, headers = {}) => fetch(url, { method: "POST", headers: { cookie: "fixture", "content-type": "application/json", "x-hub-speech-preview": "1", ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await request(undefined, { cookie: "" })).status, 401);
    assert.equal((await request(undefined, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await request(undefined, { "x-hub-speech-preview": "" })).status, 403);
    assert.equal((await request({ tts, language: "en", text: "arbitrary text" })).status, 400);
    assert.equal((await request({ tts, language: "tr" })).status, 400);
    assert.equal((await request({ tts: { ...tts, voice: "am_unknown" }, language: "en" })).status, 409);
    const response = await request(); assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "audio/wav"); assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav);
    assert.equal((await request()).status, 200); await handler.prepare();assert.equal(spawns, 0); assert.equal(terminated, 0);
    await rm(join(sampleDir,"v1-en-am_echo.wav"));assert.equal((await request()).status,503);assert.equal(spawns,0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(sampleDir,{recursive:true,force:true}); }
});
test("bilingual samples share persistent English and Turkish recordings",()=>{
 const bilingual={engine:"bilingual",model:"kokoro-piper",voice:"am_echo",turkishVoice:"tr_TR-dfki-medium",language:"auto"};
 assert.equal(speechSampleName(bilingual,"en"),speechSampleName({engine:"kokoro",model:"82m",voice:"am_echo"},"en"));
 assert.equal(speechSampleName(bilingual,"tr"),speechSampleName({...bilingual,voice:"af_heart"},"tr"));
 assert.throws(()=>speechSampleName({engine:"kokoro",model:"82m",voice:"../../private"},"en"));
});

test("multilingual speaker auditions use prepared audio in both languages without inference", async () => {
  const sampleDir = await mkdtemp(join(tmpdir(), "hub-speech-samples-"));
  const wav = Buffer.alloc(48); wav.write("RIFF"); wav.write("WAVE", 8);
  const tts = { engine: "supertonic", model: "supertonic-3", voice: "F5", language: "auto", steps: 6 };
  for (const language of ["en", "tr"]) await writeFile(join(sampleDir, speechSampleName(tts, language)), wav);
  const handler = createSpeechPreviewHandler({ sampleDir, python: "C:/fixed/python.exe", script: "C:/fixed/speech_preview.py", signal: new AbortController().signal,
    reject: () => undefined, catalog: async () => ({ stt: [], tts: [{ engine: tts.engine, model: tts.model, available: true, voices: [tts.voice], reason: null }] }),
    subprocess: { resolveExecutable() { throw new Error("An audition must not resolve a process"); }, spawn() { throw new Error("An audition must not run inference"); } },
  });
  const server = createServer((request, response) => void handler(request, response)); server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    await handler.prepare();
    for (const language of ["tr", "en", "tr"]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/preview`, { method: "POST", headers: { "content-type": "application/json", "x-hub-speech-preview": "1" }, body: JSON.stringify({ tts, language }) });
      assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(sampleDir,{recursive:true,force:true}); }
});
