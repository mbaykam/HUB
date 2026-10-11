import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { apply } from "@minke/harness-overlay/memory.ts";

test("memory HTTP API authenticates, rejects cross-site writes and forgets without exposing raw evidence", async () => {
  const notes = new Map(); const disposers = []; let route;
  const ctx = {
    on() { return () => {}; },
    effect(callback) { disposers.push(callback()); },
    agents: { create() { throw new Error("No model should run in this HTTP test"); }, get() {} },
    connection: { requestRejection(request) { return request.headers.authorization === "Bearer synthetic-test" ? undefined : 401; } },
    webServer: { register(value) { route = value; return () => {}; } },
    tools: { async execute(request) {
      const args = request.arguments; const name = request.name.split("__").at(-1); let result;
      if (name === "write_note") {
        const id = args.directory + "/" + args.title.toLowerCase().replaceAll(" ", "-");
        result = notes.has(id) ? { action: "conflict", error: "NOTE_ALREADY_EXISTS" } : { action: "created" };
        if (!notes.has(id)) notes.set(id, args.content);
      } else if (name === "read_note") result = { content: notes.get(args.identifier), ...(args.identifier === "00000000-0000-4000-8000-000000000001" ? { file_path: "memories/topic.md", frontmatter: { type: "hub-memory" } } : {}) };
      else if (name === "build_context") {
        assert.equal(args.project, "test"); assert.equal(args.timeframe, null);
        result = { results: [], has_more: false };
      }
      else if (name === "search_notes") {
        assert.equal(args.project, "test"); assert.equal(args.search_all_projects, false);
        assert.deepEqual(args.entity_types, ["entity"]);
        result = { results: [], current_page: args.page, has_more: false };
      }
      else {
        const current = notes.get(args.identifier);
        assert.equal(current.split(args.find_text).length, 2);
        notes.set(args.identifier, current.replace(args.find_text, args.content));
        result = { operation: "find_replace", fileCreated: false, file_path: args.identifier + ".md" };
      }
      return { isError: false, content: [{ type: "text", text: JSON.stringify(result) }] };
    } },
  };
  apply(ctx, { project: "test", provider: "test", model: "test", captureSince: 1 });
  const server = createServer((request, response) => { void route.handler(request, response); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/hub/memory`;
  const headers = { authorization: "Bearer synthetic-test", "content-type": "application/json" };
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers, "sec-fetch-site": "cross-site" }, body: '{}' })).status, 403);
    const snapshot = await (await fetch(url, { headers })).json();
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.status, "ready");
    const graphUrl = url + "?view=graph";
    assert.equal((await fetch(graphUrl)).status, 401);
    assert.equal((await fetch(graphUrl, { headers })).status, 403);
    const graphHeaders = { ...headers, "x-hub-memory": "1" };
    assert.equal((await fetch(graphUrl, { headers: { ...graphHeaders, "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await fetch(graphUrl, { method: "POST", headers: graphHeaders, body: '{}' })).status, 405);
    assert.equal((await fetch(graphUrl + "&page=0", { headers: graphHeaders })).status, 400);
    assert.equal((await fetch(url + "?view=note&id=../control/memory-policy", { headers: graphHeaders })).status, 400);
    const graph = await fetch(graphUrl, { headers: graphHeaders });
    assert.equal(graph.status, 200); assert.equal(graph.headers.get("cache-control"), "no-store");
    assert.deepEqual((await graph.json()).nodes, []);
    const searchUrl = url + "?view=search&q=notes";
    assert.equal((await fetch(searchUrl)).status, 401);
    assert.equal((await fetch(searchUrl, { headers })).status, 403);
    assert.equal((await fetch(searchUrl, { headers: { ...graphHeaders, "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await fetch(searchUrl, { method: "POST", headers: graphHeaders, body: '{}' })).status, 405);
    for (const query of ["", "x".repeat(201), "%0A"]) assert.equal((await fetch(url + "?view=search&q=" + query, { headers: graphHeaders })).status, 400);
    const searched = await fetch(searchUrl, { headers: graphHeaders });
    assert.equal(searched.headers.get("cache-control"), "no-store");
    assert.deepEqual(await searched.json(), { nodes: [], page: 1, hasMore: false });
    notes.set("memories/personal-memory", "# Personal memory\n\nLikes tea.\nLikes short answers.");
    notes.set("sessions/private-original", "Likes tea.");
    const forgotten = await fetch(url, { method: "POST", headers, body: JSON.stringify({ action: "forget", passage: "Likes tea." }) });
    assert.equal(forgotten.status, 200);
    const body = await forgotten.json();
    assert.doesNotMatch(body.content, /Likes tea/);
    assert.match(body.content, /short answers/);
    assert.equal(notes.get("sessions/private-original"), "Likes tea.");
    assert.equal(forgotten.headers.get("cache-control"), "no-store");
    assert.ok(JSON.parse(notes.get("control/memory-policy")).forgetBefore > 0);
    const noteId = "00000000-0000-4000-8000-000000000001";
    notes.set(noteId, "Topic detail.\nKeep another fact.");
    const topic = await fetch(url, { method: "POST", headers, body: JSON.stringify({ action: "forget", noteId, passage: "Topic detail." }) });
    assert.equal(topic.status, 200); assert.equal(notes.get(noteId), "Keep another fact.");
    for (const bad of ["memories/topic", "../control/policy", null, 1]) assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ action: "forget", noteId: bad, passage: "fact" }) })).status, 400);
    assert.equal((await fetch(url, { method: "DELETE", headers })).status, 405);
    for (const body of ['{', 'null', '{}']) {
      assert.equal((await fetch(url, { method: "POST", headers, body })).status, 400);
    }
    assert.equal((await fetch(url, { method: "POST", headers, body: 'x'.repeat(32_001) })).status, 413);
    assert.equal((await fetch(url, { method: "POST", headers: { authorization: headers.authorization }, body: '{}' })).status, 415);
  } finally {
    await Promise.all(disposers.map(dispose => dispose()));
    server.close(); await once(server, "close");
  }
});
