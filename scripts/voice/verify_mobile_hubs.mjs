// Browser interaction/geometry checks for the PWA view layer. The voice SDK is
// a deterministic seam here; verify_native --browser proves its real audio path.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { once } from "node:events";

const { outputFiles, metafile } = await build({ loader: { '.css': 'text' }, stdin: { contents: 'export {installMobileHubs} from "./packages/harness-overlay/src/client/host/mobile-hubs.ts"', resolveDir: process.cwd(), loader: "ts" }, write: false, bundle: true, format: "esm", platform: "browser", metafile: true });
assert.ok(!Object.keys(metafile.inputs).some(path => path.includes("node_modules/@pipecat")), "PWA view layer must not include the voice SDK");
let sdkDownloads = 0;
let diagnosticStage;
const server = createServer((req, res) => {
  if (req.url === "/ui.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(outputFiles[0].text); return; }
  if (req.url === "/api/hub/voice/status") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"enabled":true}'); return; }
  if (req.url === "/api/hub/voice/diagnostics") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({active:!!diagnosticStage,audio:diagnosticStage?{stage:diagnosticStage,inputPaused:['speaking','echo-tail'].includes(diagnosticStage),inputPauseReason:diagnosticStage==='speaking'?'playback':diagnosticStage==='echo-tail'?'echo-tail':null,receivingAudio:true,inputLevel:.01,recentSound:false,partialText:""}:null}));return;
  }
  if (req.url === '/fixture/interrupt') {
    diagnosticStage='echo-tail';setTimeout(()=>diagnosticStage='listening',1400);
    res.end('{}');return;
  }
  if (req.url === "/api/hub/voice/client.js") {
    sdkDownloads++; res.writeHead(200, { "content-type": "text/javascript" });
    res.end(`export function createVoiceClient(options) { globalThis.options=options; return {
      async start(id) { globalThis.startedWith=id; options.onSession(id || 'voice-coordinator'); options.onState('listening'); },
      async stop(){ options.onState('idle'); }, mute(value){globalThis.muted=value;}, async play(){},
      async interrupt(){globalThis.interrupts=(globalThis.interrupts||0)+1;await fetch('/fixture/interrupt');options.onState('listening');},
      async sendText(text){ globalThis.sent.push(text); }
    }; }`); return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HUB PWA view verification</title>
    <style>html,body{margin:0;background:#080a10;color:#eee;font:16px system-ui}body{min-height:100vh;background:radial-gradient(at 20% 10%,#25284590,transparent 70%),radial-gradient(at 95% 90%,#17363880,transparent 55%)}
    [data-phase]{display:flex;flex-direction:column;height:100dvh}[data-conversation-scroll]{display:flex;flex-direction:column;flex:1;min-height:0;overflow:auto;justify-content:center}[data-composer-seat]{padding:20px;flex:none;box-sizing:border-box}
    [data-slot="conversation.composer.bar"]{display:contents}[data-composer-card]{box-sizing:border-box;min-height:155px;width:100%}textarea{font:inherit;background:transparent;border:0;color:inherit;box-sizing:border-box;width:100%;resize:none}
    </style><main data-slot="conversation"><div data-phase="hero"><div data-conversation-scroll><div data-composer-seat><div><div><div data-slot="conversation.hero.agentPreset"><button>Standard mode</button></div></div><div data-slot="conversation.composer.bar"><div data-composer-card><textarea aria-label="Native text input" placeholder="Write something…"></textarea></div></div></div></div></div></div></main>`);
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const { chromium, webkit } = createRequire(import.meta.url)(process.argv[2]);
let browser;
try {
  browser = process.argv.includes('--webkit') ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => {
    document.documentElement.setAttribute("data-minke-mobile-web", "");
    const { installMobileHubs } = await import("/ui.js");
    globalThis.current = undefined; globalThis.sent = []; globalThis.byId = {}; globalThis.opened = [];
    globalThis.dispose = installMobileHubs({ sessions: {
      list: { getSnapshot: () => ({ current: globalThis.current, byId: globalThis.byId, phase: 'ready' }), subscribe(fn) { globalThis.changed = fn; return () => {}; } },
      async refresh() { globalThis.byId['voice-coordinator'] ??= { title: 'Conversation' }; },
      open(id) { if (!globalThis.byId[id]) throw new Error('Session membership is not refreshed'); globalThis.opened.push(id); globalThis.current = id; document.querySelector('[data-phase]').setAttribute('data-phase', 'active'); globalThis.changed(); },
      clear() { globalThis.current = undefined; document.querySelector("[data-phase]").setAttribute("data-phase", "hero"); globalThis.changed(); },
    }, uiWorkspace: { startSession() {} } });
  });
  await page.waitForSelector("[data-voice-start]:not(:disabled)");
  assert.equal(await page.locator('[data-hub-activity]').isVisible(), false, 'No empty work panel on idle Home');
  assert.equal(await page.locator('[data-hub-live-transcript]').isVisible(), false, 'No empty transcript');
  await page.getByRole('button', { name: 'Chat options', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Standard mode', exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Chat options', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Standard mode', exact: true }).isVisible(), false);
  if (process.argv[3] && !process.argv[3].startsWith('--')) await page.screenshot({ path: process.argv[3].replace('.png', '-idle.png'), fullPage: true });
  assert.equal(sdkDownloads, 0);
  const mutations = await page.evaluate(async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    let count = 0; const observer = new MutationObserver(records => { count += records.length; }); observer.observe(document.body, { childList: true, subtree: true });
    await new Promise(resolve => setTimeout(resolve, 200)); observer.disconnect(); return count;
  });
  assert.equal(mutations, 0, "Stable UI must not enter a MutationObserver render loop");
  await page.getByRole('textbox', { name: 'Native text input' }).fill('Saved text draft');
  await page.locator('[data-voice-start]').click();
  await page.getByRole('button', { name: 'End voice', exact: true }).waitFor();
  await page.waitForFunction(() => Boolean(globalThis.options));
  assert.equal(sdkDownloads, 1);
  assert.equal(await page.evaluate(() => globalThis.startedWith), undefined);
  await page.evaluate(() => {
    options.onTranscript('user', 'Show me', false);
    options.onTranscript('user', 'Show me how this works.', true);
    options.onTranscript('assistant', 'Let’s break it', true);
    options.onTranscript('assistant', 'down.', true);
  });
  assert.equal(await page.locator('[data-transcript-speaker="user"]').count(), 1, 'Final human text replaces its partial');
  assert.equal(await page.locator('[data-transcript-speaker="assistant"] p').textContent(), 'Let’s break it down.');
  assert.equal(await page.locator('[data-transcript-speaker][data-interim]').count(), 0);
  await page.evaluate(() => options.onTranscript('user', '<img src=x onerror="window.untrustedRan=true">', true));
  assert.equal(await page.locator('[data-transcript-lines] img').count(), 0, 'Transcripts are text, not executable markup');
  assert.equal(await page.evaluate(() => window.untrustedRan), undefined);
  for (const width of [320, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 480 });
    for (const state of ['connecting', 'listening', 'thinking', 'speaking', 'ending']) {
      await page.evaluate(state => globalThis.options.onState(state), state);
      assert.equal(await page.locator('[data-hub-voice-hub]').getAttribute('data-voice-state'), state);
      assert.equal(await page.locator('textarea').count(), 1, 'Voice preserves the mounted native composer');
      assert.equal(await page.getByRole('textbox').count(), 0, 'Voice hides the text box');
      const contained = await page.evaluate(() => {
        const hub = document.querySelector('[data-hub-voice-hub]'), box = hub.getBoundingClientRect();
        return [...hub.querySelectorAll('[data-voice-controls], [data-voice-controls] button')].filter(element => !element.hidden).every(element => {
          const r = element.getBoundingClientRect();
          return r.top >= box.top && r.bottom <= box.bottom && r.left >= box.left && r.right <= box.right && (element.tagName !== 'BUTTON' || r.height >= 44);
        });
      });
      assert.ok(contained, `${width}px/${state}: all controls stay inside the voice surface, including short keyboard viewport`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      for (const selector of ['[data-voice-controls] button:last-child']) {
        const control=page.locator(selector); await control.scrollIntoViewIfNeeded();
        const r=await control.boundingBox(); assert.ok(r.y>=-1&&r.y+r.height<=481, `${width}px/${state}: End and Send remain reachable with a growing transcript`);
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => globalThis.options.onState('listening'));
  for (const stage of ['thinking','speaking','listening']) {
    diagnosticStage = stage;
    await page.waitForFunction(wanted => document.querySelector('[data-hub-voice-hub]').getAttribute('data-voice-state') === wanted, stage);
  }
  diagnosticStage='speaking';
  await page.getByText('Speaking',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Interrupt',exact:true}).click();
  await page.getByText('Resuming listening…',{exact:true}).waitFor();
  await page.getByText('Listening to you',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>globalThis.interrupts),1);
  diagnosticStage='speaking';
  await page.getByText('Speaking',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Mute',exact:true}).click();
  await page.getByRole('button',{name:'Interrupt',exact:true}).click();
  await page.getByRole('button',{name:'Unmute',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>globalThis.muted),true,'Playback protection never unmutes the user’s manual mute');
  await page.getByRole('button',{name:'Unmute',exact:true}).click();
  await page.getByText('Listening to you',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>globalThis.interrupts),2);
  diagnosticStage = undefined;
  assert.equal(await page.locator('textarea').inputValue(), 'Saved text draft');
  assert.equal(await page.locator('[data-voice-shared-form]').count(), 0);
  assert.equal(await page.locator('textarea').isVisible(), false);
  await page.evaluate(() => { globalThis.byId.task={title:'Other chat',origin:'subagent'}; globalThis.current='task'; document.querySelector('[data-phase]').setAttribute('data-phase','active'); globalThis.changed(); });
  await page.getByRole('button',{name:'‹ Home',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'End voice',exact:true}).isVisible(),true);
  await page.getByRole('button', { name: 'Open live conversation', exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.current), 'voice-coordinator');
  await page.getByRole('button', { name: 'Open live conversation', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole("button", { name: "‹ Home", exact: true }).waitFor();
  assert.equal(await page.locator("[data-hub-voice-hub]").count(), 1);
  await page.getByRole("button", { name: "‹ Home", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "End voice" }).isVisible(), true);
  await page.getByRole("button", { name: "End voice" }).click();
  await page.locator('[data-voice-start]').waitFor();
  assert.equal(await page.locator('[data-transcript-speaker]').count(), 0, 'Ending clears only the temporary live view');
  assert.equal(await page.locator('textarea').inputValue(), 'Saved text draft', 'End voice restores the unsent draft');
  assert.equal(await page.getByRole("textbox", { name: "Native text input" }).isVisible(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.argv[3] && !process.argv[3].startsWith('--')) await page.screenshot({ path: process.argv[3], fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => !document.querySelector("[data-hub-voice-hub]"));
  assert.equal(await page.getByRole("textbox", { name: "Native text input" }).isVisible(), true);
  await page.evaluate(() => globalThis.dispose());
  assert.deepEqual(errors, []);
  console.log(`PASS: real ${process.argv.includes('--webkit') ? 'WebKit' : 'Chrome'} PWA hubs, contained controls at320–768px/short viewport, playback/tail labels, explicit interruption with manual mute preserved, live transcript, lazy SDK, one HUB composer, refreshed call navigation and Home return and desktop exclusion`);
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
