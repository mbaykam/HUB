// Real browser -> stock RTVI -> Python pipeline -> native DSH -> local TTS.
// Caller supplies an isolated native context; the model may be synthetic or an
// explicitly authorized provider. Input speech always comes from a test fixture.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createVoiceBridgeServer } from "../../packages/harness-overlay/src/host/voice-bridge-server.ts";
import { openNativeVoiceSession } from "../../packages/harness-overlay/src/host/voice-session.ts";
import { startVoiceSidecar } from "../../packages/harness-overlay/src/host/voice-sidecar.ts";
import { createVoiceWeb } from "../../packages/harness-overlay/src/host/voice-web.ts";
import { PresentationRuntime } from "../../packages/harness-overlay/src/host/presentation.ts";
import { interactivePresentation } from "./presentation-fixtures.mjs";
import { build } from "esbuild";
import { BrowserViewClient, createBrowserViewHandler } from "../../packages/harness-overlay/src/host/browser-view.ts";

export async function verifyBrowserNative({ ctx, voiceContext, voiceRoute, sessionId, root, python, playwright, requests, queuePresentation, liveModel = false, browserTask }) {
  const { default: SubprocessLocal } = await import("@deepseek-ai/dsh-subprocess-local");
  await ctx.plugin(SubprocessLocal);
  const presentations = new PresentationRuntime();
  const renderer = await readFile(resolve(root, "packages/harness-overlay/lib/presentation-renderer.js"), "utf8");
  const presentationShell = (await build({ stdin: { contents: "export {createMobilePresentation} from './packages/harness-overlay/src/client/host/mobile-presentation.ts'", resolveDir: root, loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser", loader: { ".css": "text" } })).outputFiles[0].text;
  const browserShell = browserTask ? (await build({ stdin: { contents: "export {createMobileBrowserView} from './packages/harness-overlay/src/client/host/mobile-browser-view.ts'", resolveDir: root, loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser", loader: { ".css": "text" } })).outputFiles[0].text : undefined;
  const browserClient = browserTask ? new BrowserViewClient() : undefined;
  const browserHandler = browserClient ? createBrowserViewHandler(browserClient, () => undefined) : undefined;
  const bridgeDiagnostics = [];
  const bridge = await createVoiceBridgeServer(async id => {
    const native = await openNativeVoiceSession(voiceContext, voiceRoute, { sessionId: id, presentations });
    return { ...native, async speak(utterance, text, sink) {
      bridgeDiagnostics.push({ type: "admit", utterance });
      try { await native.speak(utterance, text, event => { if (event.type === "end") bridgeDiagnostics.push({ type: "end", utterance, status: event.status }); sink(event); }); }
      catch (error) { bridgeDiagnostics.push({ type: "reject", utterance, code: error.code ?? "unknown" }); throw error; }
    } };
  });
  const web = createVoiceWeb({ reject: () => undefined,
    presentations: { summary: id => presentations.summary(id), async document(id, visualId) { return presentations.document(id, visualId, renderer); } },
    async open(signal, selected) {
      assert.equal(selected, sessionId);
      const call = await bridge.open(selected);
      try {
        const sidecar = await startVoiceSidecar(ctx.subprocess, { python, script: resolve(root, "packages/harness-overlay/voice/server.py"), bridgeUrl: bridge.url, bridgeToken: bridge.token, callId: call.callId }, signal);
        return { ...call, sidecar };
      } catch (error) { await bridge.closeCall(call.callId); throw error; }
    },
    async close(call) { await call.sidecar.stop(); await bridge.closeCall(call.callId); },
  });
  const asset = await readFile(resolve(root, "packages/harness-overlay/lib/voice-browser.js"));
  const fixture = await promisify(execFile)(python, [resolve(root, "scripts/voice/synthetic_speech.py")], { windowsHide: true, timeout: 60_000, maxBuffer: 2_000_000 });
  const speech = Buffer.from(fixture.stdout.trim(), "base64");
  assert.equal(speech.subarray(0, 4).toString(), "RIFF");
  const server = createServer((request, response) => {
    if (request.url === "/") { response.writeHead(200, { "content-type": "text/html" }); response.end('<!doctype html><title>Synthetic HUB integration</title><audio autoplay></audio><button id="start">Voice</button>'); return; }
    if (request.url === "/api/hub/voice/client.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(asset); return; }
    if (request.url === "/speech.wav") { response.writeHead(200, { "content-type": "audio/wav" }); response.end(speech); return; }
    if (request.url === "/presentation-shell.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(presentationShell); return; }
    if (request.url === "/browser-shell.js" && browserShell) { response.writeHead(200, { "content-type": "text/javascript" }); response.end(browserShell); return; }
    if (request.url === "/api/hub/browser-view" && browserHandler) { void browserHandler(request, response).catch(() => response.destroy()); return; }
    void web.handler(request, response).catch(() => response.destroy());
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const { chromium } = createRequire(import.meta.url)(playwright);
  let browser, page;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
    page = await browser.newPage();
    if (browserTask) await page.setViewportSize({ width: 390, height: 844 });
    const pageErrors = []; page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async sessionId => {
      const NativePeer = globalThis.RTCPeerConnection;
      globalThis.peers = [];
      globalThis.protocolErrors = [];
      const observe = channel => channel.addEventListener('message', event => {
        try { const value = JSON.parse(event.data); if (/error/.test(value.type)) globalThis.protocolErrors.push({ type: value.type, fatal: value.data?.fatal, message: String(value.data?.error ?? value.data?.message ?? '').replace(/https?:\/\/\S+|Bearer\s+\S+/gi, '[redacted]').slice(0, 300) }); } catch {}
      });
      globalThis.RTCPeerConnection = class extends NativePeer {
        constructor(...args) { super(...args); globalThis.peers.push(this); this.addEventListener('datachannel', event => observe(event.channel)); }
        createDataChannel(...args) { const channel = super.createDataChannel(...args); observe(channel); return channel; }
      };
      const { createVoiceClient } = await import("/api/hub/voice/client.js");
      const { createMobilePresentation } = await import("/presentation-shell.js");
      globalThis.presentations = createMobilePresentation(document); document.body.append(globalThis.presentations.button);
      globalThis.states = []; globalThis.errors = []; globalThis.notices = []; globalThis.spoken = []; globalThis.transcribed = [];
      globalThis.voice = createVoiceClient({ audio: document.querySelector("audio"),
        onState: state => globalThis.states.push(state),
        onSession: id => { globalThis.selected = id; },
        onCall: id => globalThis.presentations.setCall(id),
        onTranscript: (role, text) => { if (role === "assistant") globalThis.spoken.push(text); else globalThis.transcribed.push(text); },
        onActivity() {}, onAudioBlocked: () => globalThis.errors.push("Audio blocked"),
        onError: message => globalThis.errors.push(message),
        onNotice: message => globalThis.notices.push(message),
      });
      document.querySelector("#start").onclick = () => { globalThis.voice.start(sessionId).catch(error => globalThis.errors.push(error.message)); };
    }, sessionId);
    if (browserTask) await page.evaluate(async () => {
      const { createMobileBrowserView } = await import('/browser-shell.js');
      globalThis.browserViewer = createMobileBrowserView(document); document.body.append(globalThis.browserViewer.panel);
    });
    await page.click("#start");
    await page.waitForFunction(() => globalThis.states.includes("listening") || globalThis.errors.length, null, { timeout: 90_000 });
    assert.deepEqual(await page.evaluate(() => globalThis.errors), []);
    assert.equal(await page.evaluate(() => globalThis.selected), sessionId);
    // Install a decoded-audio analyser before the reply, then discard greeting
    // activity. Only samples observed after the native reply's TTS event count.
    await page.evaluate(async liveModel => {
      const context = new AudioContext(); await context.resume();
      const source = context.createMediaStreamSource(document.querySelector("audio").srcObject);
      const analyser = context.createAnalyser(); source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      globalThis.replyAudible = false; globalThis.expectedReply = liveModel ? "lantern" : "hello from the native session";
      const timer = setInterval(() => {
        if (globalThis.spoken.join(" ").toLowerCase().includes(globalThis.expectedReply)) {
          analyser.getFloatTimeDomainData(samples);
          if (samples.some(value => Math.abs(value) > 0.0001)) {
            globalThis.replyAudible = true;
            if (document.querySelector('[data-hub-visual-dialog][open] iframe')) globalThis.audibleWithVisual = true;
            if (document.querySelector('[data-hub-browser-dialog][open] img')) globalThis.audibleWithBrowser = true;
          }
        }
      }, 20);
      globalThis.releaseProbe = async () => { clearInterval(timer); source.disconnect(); await context.close(); };
      await globalThis.voice.sendText(liveModel ? "Our synthetic project is Lantern. Say its name in one short sentence, without tools." : "In this shared voice conversation, remember my synthetic project Lantern.");
    }, liveModel);
    await page.waitForFunction(() => globalThis.replyAudible || globalThis.errors.length, null, { timeout: 45_000 });
    assert.deepEqual(await page.evaluate(() => globalThis.errors), []);
    assert.equal(await page.evaluate(() => globalThis.replyAudible), true);
    assert.equal(await page.evaluate(() => globalThis.peers.some(peer => peer.connectionState === "connected")), true);
    if (liveModel) {
      assert.match(JSON.stringify(ctx.agents.get(sessionId).session.snapshotEvents()), /Our synthetic project is Lantern/);
    } else {
      assert.match(JSON.stringify(requests.at(-1).messages), /shared voice conversation, remember my synthetic project Lantern/);
      assert.match(JSON.stringify(requests.at(-1).messages), /My synthetic project is named Lantern/);
      queuePresentation(interactivePresentation);
    }
    if (browserTask) {
      const { verifyBrowserTask } = await import('./verify_browser_task.mjs');
      await verifyBrowserTask({ page, ctx, sessionId, task: browserTask });
    } else {
    await page.evaluate(async () => { globalThis.audioTrackId = document.querySelector('audio').srcObject.getAudioTracks()[0].id; await globalThis.voice.sendText('Show me an interactive square and its area.'); });
    await page.frameLocator('[data-hub-visual-dialog] iframe').locator('body[data-ready=true]').waitFor({ timeout: 45000 });
    if (liveModel) {
      const frame = page.frameLocator('[data-hub-visual-dialog] iframe');
      const slider = frame.locator('input[type=range]').first();
      await slider.press('Home'); const before = await frame.locator('svg').first().innerHTML();
      await slider.press('End');
      const until = Date.now() + 5000;
      while (await frame.locator('svg').first().innerHTML() === before) {
        assert.ok(Date.now() < until, "Real model visual must respond to the slider");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } else {
      await page.frameLocator('[data-hub-visual-dialog] iframe').locator('input[type=range]').fill('9');
      await page.frameLocator('[data-hub-visual-dialog] iframe').getByText('Area: 81', { exact: true }).waitFor();
    }
    await ctx.agents.get(sessionId).whenIdle();
    await page.evaluate(async liveModel => { globalThis.audibleWithVisual = false; globalThis.spoken = []; if (liveModel) globalThis.expectedReply = 'area'; await globalThis.voice.sendText('Explain the square area while I am looking at it. Say the word area and keep it to one sentence; do not call tools again.'); }, liveModel);
    await page.waitForFunction(() => globalThis.audibleWithVisual || globalThis.errors.length, null, { timeout: 45000 });
    assert.deepEqual(await page.evaluate(() => globalThis.errors), []);
    assert.equal(await page.evaluate(() => globalThis.audibleWithVisual), true);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await page.evaluate(() => document.querySelector('audio').srcObject.getAudioTracks()[0].id === globalThis.audioTrackId), true);
    assert.equal(await page.evaluate(() => globalThis.peers.some(peer => peer.connectionState === 'connected')), true);
    console.log('PASS: native model invokes visual tool during actual Pipecat call; interactive Vega canvas updates while real decoded local TTS plays; closing it preserves the same audio track and RTC connection');
    }
    // Feed actual synthesized PCM into the browser RTP sender. No transcript
    // injection: stock VAD and Whisper must produce the next native human turn.
    const beforeSpeech = requests.length;
    await page.evaluate(async liveModel => {
      globalThis.spoken = []; globalThis.replyAudible = false;
      if (liveModel) globalThis.expectedReply = 'purple';
      const context = new AudioContext(); await context.resume();
      const destination = context.createMediaStreamDestination();
      const clip = context.createBufferSource();
      clip.buffer = await context.decodeAudioData(await (await fetch("/speech.wav")).arrayBuffer());
      clip.connect(destination);
      const peer = globalThis.peers.find(peer => peer.connectionState === "connected");
      const sender = peer.getSenders().find(sender => sender.track?.kind === "audio");
      await sender.replaceTrack(destination.stream.getAudioTracks()[0]);
      globalThis.stopSyntheticInput = async () => { for (const track of destination.stream.getTracks()) track.stop(); await context.close(); };
      clip.start();
    }, liveModel);
    try {
      await page.waitForFunction(() => globalThis.replyAudible || globalThis.errors.length, null, { timeout: 60_000 });
    } catch (error) {
      const diagnostics = await page.evaluate(async () => ({ states: globalThis.states, transcribed: globalThis.transcribed, spoken: globalThis.spoken, errors: globalThis.errors,
        stats: await Promise.all(globalThis.peers.map(async peer => [...(await peer.getStats()).values()].filter(row => row.type === "outbound-rtp" && row.kind === "audio").map(row => ({ bytesSent: row.bytesSent, packetsSent: row.packetsSent })))) }));
      console.error("Synthetic speech diagnostics", JSON.stringify(diagnostics));
      console.error("Native synthetic model request count", requests.length - beforeSpeech);
      throw error;
    }
    assert.deepEqual(await page.evaluate(() => globalThis.errors), []);
    assert.ok(requests.length > beforeSpeech);
    assert.match(JSON.stringify(liveModel ? ctx.agents.get(sessionId).session.snapshotEvents() : requests.at(-1).messages), /favorite colou?r is purple/i);
    assert.equal(await page.evaluate(() => globalThis.replyAudible), true);
    console.log("PASS: actual spoken PCM -> WebRTC -> Silero/Whisper -> native DSH human turn -> local Kokoro -> audible browser reply");
    await page.evaluate(async () => { await globalThis.stopSyntheticInput(); await globalThis.releaseProbe(); await globalThis.voice.stop(); });
    assert.deepEqual(pageErrors, []);
    assert.equal(await page.evaluate(() => globalThis.states.at(-1)), "idle");
    console.log("PASS: browser typed input traverses real RTVI/Python/native DSH history and returns native reply as real local TTS audio in the SAME conversation");
    console.log(JSON.stringify({ recoverableSpeechNotices: await page.evaluate(() => globalThis.notices.length) }));
  } catch (error) {
    console.error("Native speech turn statuses", JSON.stringify(bridgeDiagnostics));
    if (page && !page.isClosed()) console.error("Synthetic voice protocol errors", JSON.stringify(await page.evaluate(() => globalThis.protocolErrors)));
    throw error;
  } finally {
    await browser?.close();
    browserClient?.dispose();
    await web.dispose(); await bridge.dispose();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
