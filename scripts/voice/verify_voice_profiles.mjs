// Real rendered PWA editor with deterministic network/catalog seams. Native
// persistence and permission dispatch are covered in voice-profiles.test.mjs.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
const { outputFiles } = await build({ loader: { ".css": "text" }, stdin: { contents: 'export {createMobileVoiceProfiles} from "./packages/harness-overlay/src/client/host/mobile-voice-profiles.ts"', resolveDir: process.cwd(), loader: "ts" }, bundle: true, format: "esm", platform: "browser", write: false });
const initial = { id: randomUUID(), name: "HUB", instructions: "Brief and helpful.", route: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "low" }, speech: { stt: { engine: "whisper", model: "base.en" }, tts: { engine: "kokoro", model: "82m", voice: "af_heart" } }, tools: { mode: "inherit" } };
let state = { revision: 0, selectedId: initial.id, profiles: [initial] }, rejectSave = false;
let download = null, downloadPolls = 0;
const downloads = [];
const commands = [], active = { id: initial.id, name: "HUB", revision: 0 };
const catalog = { providers: [{ id: "openai-codex", name: "Codex subscription" }, { id: "synthetic", name: "Other installed connection" }],
  tools: [{ name: "read", description: "Read files" }, { name: "shell", description: "Execute commands" }, { name: "hub_present", description: "Show an explanation" }],
  speech: { stt: [{ engine: "whisper", model: "base.en", available: true, reason: null }, { engine: "whisper", model: "tiny.en", available: false, downloadable: true, reason: "Not installed" }],
    tts: [{ engine: "kokoro", model: "82m", available: true, voices: ["af_heart", "bf_emma"], reason: null },
      { engine: "piper", model: "en_US-ljspeech-high", available: false, downloadable: true, voices: ["en_US-ljspeech-high"], reason: "Not installed" }] } };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (url.pathname === "/ui.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(outputFiles[0].text); return; }
  if (url.pathname.endsWith("/speech-models")) {
    if (req.method === "POST") {
      assert.equal(req.headers["x-hub-speech-models"], "1");
      const chunks = []; for await (const part of req) chunks.push(part);
      const selection = JSON.parse(Buffer.concat(chunks).toString()); downloads.push(selection);
      download = { ...selection, id: randomUUID(), phase: "downloading" }; downloadPolls = 0;
    } else if (download?.phase === "downloading" && ++downloadPolls >= 1) {
      download.phase = "complete";
      const entry = [...catalog.speech.stt, ...catalog.speech.tts].find(item => item.engine === download.engine && item.model === download.model);
      entry.available = true; entry.reason = null;
    }
    json({ download }); return;
  }
  if (url.pathname.endsWith("/catalog")) {
    if (!url.searchParams.has("provider")) { json(catalog); return; }
    const provider = url.searchParams.get("provider");
    json({ models: [{ provider, id: provider === "openai-codex" ? "gpt-5.6-luna" : "fixture-model", name: provider === "openai-codex" ? "Luna" : "Fixture model", efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }] }] }); return;
  }
  if (url.pathname.endsWith("/profiles")) {
    if (req.method === "POST") {
      const chunks = []; for await (const part of req) chunks.push(part);
      assert.equal(req.headers["x-hub-voice-profiles"], "1");
      const command = JSON.parse(Buffer.concat(chunks).toString()); commands.push(command);
      if (rejectSave || command.revision !== state.revision) { json({ error: "revision-conflict" }, 409); return; }
      if (command.type === "create") state.profiles.push({ ...command.profile, id: randomUUID() });
      if (command.type === "edit") state.profiles = state.profiles.map(p => p.id === command.id ? { ...command.profile, id: p.id } : p);
      if (command.type === "select") state.selectedId = command.id;
      if (command.type === "duplicate") state.profiles.push({ ...state.profiles.find(p => p.id === command.id), id: randomUUID(), name: command.name });
      if (command.type === "delete") { state.profiles = state.profiles.filter(p => p.id !== command.id); if (state.selectedId === command.id) state.selectedId = state.profiles[0].id; }
      state.revision++;
    }
    json({ ...state, active, appliesAt: "next-call" }); return;
  }
  res.writeHead(200, { "content-type": "text/html" }); res.end('<!doctype html><html data-minke-mobile-web><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#080d18;font:16px system-ui;color:white}body>button{margin:20px;padding:14px}</style><body></body></html>');
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const { chromium, webkit } = createRequire(import.meta.url)(process.argv[2]); let browser;
try {
  browser = process.argv.includes("--webkit") ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); const errors = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("dialog", dialog => dialog.accept());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => { const module = await import("/ui.js"); window.editor = module.createMobileVoiceProfiles(document); document.body.append(editor.button); });
  await page.getByRole("button", { name: "HUB · Active" }).click();
  await page.getByRole("button", { name: "New personality", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Jess");
  await page.getByLabel("Personality instructions").fill("Warm and concise. <script>not executable</script>");
  await page.getByLabel("Language model", { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('select[required]:last-of-type')?.disabled && [...document.querySelectorAll('option')].some(o => o.textContent === 'Luna'));
  await page.getByText("Local speech", { exact: true }).click();
  assert.equal(await page.getByLabel("Speech to text").locator('option[value="tiny.en"]').evaluate(option => option.disabled), true);
  await page.getByLabel("Voice", { exact: true }).selectOption("bf_emma");
  await page.getByText("Manage model downloads", { exact: true }).click();
  const speechScreenshot = process.argv.find(arg => arg.startsWith("--speech-screenshot="))?.slice(20);
  if (speechScreenshot) { await page.getByText("Local speech", { exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: speechScreenshot }); }
  await page.getByRole("button", { name: "Download Whisper tiny.en", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('option[value="tiny.en"]').disabled);
  assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "Jess", "Download refresh preserves unsaved name");
  assert.equal(await page.getByLabel("Voice", { exact: true }).inputValue(), "bf_emma", "Download cannot substitute a selected voice");
  assert.equal(await page.getByLabel("Speech to text").inputValue(), "base.en", "Download does not select itself");
  assert.equal(commands.length, 0, "Download does not save edits");
  await page.getByRole("button", { name: "Download Piper LJ Speech", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('option[value="piper:en_US-ljspeech-high"]').disabled);
  await page.getByText("Manage model downloads", { exact: true }).click();
  await page.getByText("Tools & permissions", { exact: true }).click();
  await page.getByLabel("Use existing session permissions").uncheck();
  await page.getByLabel("Allow read", { exact: true }).check();
  for (const width of [320, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 480 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && editor.dialog.scrollWidth <= editor.dialog.clientWidth + 1), `${width}: no horizontal overflow`);
    const save = page.getByRole("button", { name: "Save personality", exact: true }); await save.scrollIntoViewIfNeeded();
    const box = await save.boundingBox(); assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 480, `${width}: Save stays fully inside the short viewport`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const screenshot = process.argv.find(arg => arg.startsWith("--screenshot="))?.slice(13);
  if (screenshot) { await page.evaluate(() => { editor.dialog.scrollTop = 0; }); await page.screenshot({ path: screenshot }); }
  await page.getByRole("button", { name: "Save personality", exact: true }).click();
  await page.getByRole("button", { name: "Use Jess", exact: true }).waitFor();
  const saved = state.profiles.find(p => p.name === "Jess"); assert.equal(saved.speech.tts.voice, "bf_emma"); assert.deepEqual(saved.tools, { mode: "allow", names: ["read"] });
  assert.equal(saved.route.provider, "openai-codex"); assert.equal(saved.route.reasoningEffort, "low");
  await page.getByRole("button", { name: "Use Jess", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-profile-row][data-selected] strong')?.textContent === 'Jess');
  assert.equal(await page.locator('[data-voice-personality]').textContent(), "HUB · Active", "Saved selection must not relabel the current call");
  await page.getByRole("button", { name: "Edit Jess", exact: true }).click();
  await page.getByText("Local speech", { exact: true }).click();
  await page.getByLabel("Speech to text").selectOption("tiny.en");
  await page.getByLabel("Text to speech").selectOption("piper:en_US-ljspeech-high");
  await page.getByLabel("Voice", { exact: true }).selectOption("en_US-ljspeech-high");
  await page.getByRole("button", { name: "Save personality", exact: true }).click();
  await page.getByRole("button", { name: "Edit Jess", exact: true }).click();
  await page.getByText("Local speech", { exact: true }).click();
  assert.equal(await page.getByLabel("Text to speech").inputValue(), "piper:en_US-ljspeech-high");
  assert.equal(await page.getByLabel("Voice", { exact: true }).inputValue(), "en_US-ljspeech-high");
  assert.equal(state.profiles.find(p => p.id === saved.id).speech.tts.engine, "piper");
  await page.getByLabel("Name", { exact: true }).fill("Unsaved Jess");
  await page.getByLabel("Connection", { exact: true }).selectOption("synthetic");
  await page.getByLabel("Language model", { exact: true }).selectOption("fixture-model");
  assert.equal(await page.getByLabel("Reasoning", { exact: true }).inputValue(), "", "Provider changes must not silently choose a reasoning override");
  rejectSave = true;
  await page.getByRole("button", { name: "Save personality", exact: true }).click();
  await page.getByText(/Settings changed elsewhere/).waitFor();
  assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "Unsaved Jess", "Conflict preserves user edits");
  assert.equal(state.profiles.find(p => p.id === saved.id).name, "Jess");
  rejectSave = false;
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Edit Jess", exact: true }).click();
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await page.getByRole("button", { name: "Edit Jess copy", exact: true }).click();
  await page.getByRole("button", { name: "Delete personality", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-profile-form]'));
  assert.equal(state.profiles.length, 2);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await page.evaluate(() => { editor.setActive(undefined); });
  assert.equal(await page.locator('[data-voice-personality]').textContent(), "Jess · Voice");
  await page.evaluate(() => editor.dispose()); assert.equal(await page.locator('[data-hub-voice-profiles]').count(), 0);
  assert.equal(downloads.length, 2);
  assert.deepEqual(errors, []); console.log(JSON.stringify({ status: "passed", engine: process.argv.includes("--webkit") ? "WebKit" : "Chrome", widths: [320,390,430,768], commands: commands.length, activeCallPreserved: true, conflictRetainsEdits: true, downloadsRetainEdits: true, piperChoiceSaved: true }));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
