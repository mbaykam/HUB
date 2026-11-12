import assert from "node:assert/strict";
import {mkdtemp, mkdir, rm, writeFile, link} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:http";
import {createHash} from "node:crypto";
import test from "node:test";
import {JSDOM} from "../vendor/deepseek-harness/node_modules/jsdom/lib/api.js";
import {installDailyUseWeb} from "../packages/harness-overlay/src/host/daily-use-web.ts";
import {createScreenshotPreviews} from "../packages/harness-overlay/src/client/host/screenshot-previews.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const tick = () => new Promise(resolve => setImmediate(resolve));

test("workspace screenshot persists in the settled chat turn and renders through the authenticated artifact route", async t => {
  const root = await mkdtemp(join(tmpdir(), "hub-screenshot-delivery-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  await writeFile(join(cwd, "screen.png"), png);
  await writeFile(join(cwd, "oversize.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
  await writeFile(join(cwd, "spoof.png"), Buffer.alloc(50));
  await writeFile(join(root, "outside.png"), png);
  await link(join(root, "outside.png"), join(cwd, "linked.png"));
  const events = [{type: "turn/start"}, {type: "user/message", data: {source: {kind: "user"}}}];
  const routes = new Map();
  const stored = new Map();
  let tool;
  const ctx = {
    tools: {register(value) { tool = value; return () => {}; }},
    webServer: {register(value) { routes.set(value.path, value.handler); return () => routes.delete(value.path); }},
    connection: {requestRejection(req) { return req.headers.authorization === "fixture" ? undefined : 401; }},
    sessionQuery: {async observeSession(session) { return {events: session === "session-a" ? events : [], [Symbol.dispose]() {}}; }},
    attachments: {
      async saveImage({data, mediaType, name}) {
        const ref = {attachmentId: "sha256:" + createHash("sha256").update(data).digest("hex"), mediaType, name, bytes: data.length, width: 1, height: 1};
        stored.set(ref.attachmentId, {ref, data});
        return ref;
      },
      async readImage(ref) { return stored.get(ref.attachmentId); },
    },
  };
  const dispose = installDailyUseWeb(ctx); t.after(dispose);
  const agent = {session: {header: {cwd}, snapshotEvents: () => events}};
  const execute = (path, caller = agent) => tool.execute({path}, {agent: caller, signal: new AbortController().signal});
  for (const path of ["../outside.png", join(root, "outside.png"), "linked.png", "oversize.png", "spoof.png"]) await assert.rejects(execute(path));
  await assert.rejects(execute("screen.png", {session: {header: {cwd}, snapshotEvents: () => []}}), /current request/);
  assert.equal(stored.size, 0);
  const output = await execute("screen.png");
  assert.equal(output.name, "screen.png");
  assert.equal(stored.size, 1);
  assert.doesNotMatch(JSON.stringify(tool.output.render({}, output)), /iVBOR|workspace/);
  const server = createServer((req,res) => routes.get("/api/hub/artifacts")(req,res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/hub/artifacts`;
  const headers = {authorization: "fixture", "x-hub-daily-use": "1", "x-hub-session": "session-a"};
  const get = extra => fetch(url, {headers: {...headers, ...extra}});
  assert.deepEqual((await (await get()).json()).screenshots, [], "storage alone does not publish a screenshot");
  events.push({type: "tool/call", data: {name: tool.name, callId: "call-1"}}, {
    type: "tool/result", data: {turn: 2, meta: tool.output.presentationMeta({}, output), message: {content: [{type: "tool-result", toolCallId: "call-1", isError: false}]}},
  });
  const {screenshots} = await (await get()).json();
  assert.equal(screenshots.length, 1); assert.equal(screenshots[0].name, "screen.png"); assert.equal(screenshots[0].turn, 2);
  const screenshot = {"x-hub-screenshot": screenshots[0].id};
  assert.equal((await get({...screenshot, authorization: ""})).status, 401);
  assert.equal((await get({...screenshot, "sec-fetch-site": "cross-site"})).status, 403);
  assert.equal((await get({...screenshot, "x-hub-session": "session-b"})).status, 404);
  assert.equal((await get({...screenshot, "x-hub-daily-use": ""})).status, 403);
  const response = await get(screenshot);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);

  const dom = new JSDOM('<main data-slot="conversation.view"><div data-chat-flow-kind="assistant" data-chat-turn="2">Screenshot ready.</div></main>');
  t.after(() => dom.window.close());
  const revoked = [];
  dom.window.URL.createObjectURL = blob => { assert.equal(blob.size, png.length); return "blob:fixture"; };
  dom.window.URL.revokeObjectURL = url => revoked.push(url);
  const client = createScreenshotPreviews(dom.window.document, async id => (await get({"x-hub-screenshot": id})).blob());
  client.update(screenshots);
  const deadline = Date.now() + 2000;
  while (!dom.window.document.querySelector("figure img") && Date.now() < deadline) await tick();
  const image = dom.window.document.querySelector('[data-chat-turn="2"] figure img');
  assert.equal(image?.src, "blob:fixture"); assert.equal(image.alt, "screen.png");
  client.update([]);
  assert.equal(dom.window.document.querySelector("figure"), null); assert.deepEqual(revoked, ["blob:fixture"]);
});
