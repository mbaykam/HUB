import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryGraph, projectMemoryGraph } from "@minke/harness-overlay/host/memory-graph.ts";
import { isSavedMemoryPath } from "@minke/harness-overlay/memory-graph-contract.ts";
const a = "00000000-0000-4000-8000-000000000001";
const b = "00000000-0000-4000-8000-000000000002";
const c = "00000000-0000-4000-8000-000000000003";
const entity = (id, path, title = "Same title") => ({ type: "entity", external_id: id, title, permalink: path, file_path: path + ".md", content: "PRIVATE BODY" });
test("saved-memory scope accepts native Markdown filenames, not paths outside the memory folder", () => {
  for (const path of ["memories/Personal memory.md", "memories/topics/Topic Preferences.md", "memories/Öğrenilenler.md", "memories\\topics\\Topic.md"]) assert.equal(isSavedMemoryPath(path), true);
  for (const path of ["/memories/note.md", "C:\\memories\\note.md", "memories/../control/note.md", "memories//note.md", "sessions/note.md", "memories/file.md:stream", "memories/note.txt"]) assert.equal(isSavedMemoryPath(path), false);
});
test("whole-vault search uses native full-text pagination and strips hidden notes and all excerpts", async () => {
  const calls = [];
  const api = createMemoryGraph({ async call(name, args) {
    calls.push({ name, args });
    return { current_page: args.page, has_more: true, total: 999, results: [entity(a, "notes/visible"), entity(a, "notes/visible"), entity(b, "sessions/evidence"), entity(c, "control/policy"), { ...entity(b, "notes/disguised"), file_path: "CONTROL\\hidden.md" }] };
  } });
  const result = await api.search('Hub "plan" OR test*', 2, AbortSignal.timeout(1000));
  assert.deepEqual(result, { nodes: [{ id: a, title: "Same title", permalink: "notes/visible" }], page: 2, hasMore: true });
  assert.deepEqual(calls[0], { name: "search_notes", args: { query: '"Hub" AND """plan""" AND "OR" AND "test*"', search_type: "text", entity_types: ["entity"], page: 2, page_size: 50, search_all_projects: false, output_format: "json" } });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE BODY|policy|evidence|999/);
  for (const query of ["", " ", "x".repeat(201), "bad\nquery"]) await assert.rejects(api.search(query, 1));
  for (const page of [0, 1.5, 10001]) await assert.rejects(api.search("Hub", page));
  const hiddenPage = createMemoryGraph({ async call() { return { current_page: 1, has_more: true, results: [entity(b, "sessions/evidence")] }; } });
  assert.deepEqual(await hiddenPage.search("Hub", 1), { nodes: [], page: 1, hasMore: true });
  for (const value of [{ error: "private failure" }, { results: [], current_page: 2, has_more: false }, { results: Array(51).fill(entity(a, "notes/visible")), current_page: 1, has_more: false }]) {
    await assert.rejects(createMemoryGraph({ async call() { return value; } }).search("Hub", 1), /Invalid memory search response/);
  }
});
test("graph projects only real UUID links, omits private evidence, and never ships note bodies", () => {
  const relation = { type: "relation", from_entity_external_id: a, to_entity_external_id: b, relation_type: "works_on" };
  const value = { results: [{ primary_result: entity(a, "people/me"), related_results: [entity(b, "projects/hub"), relation, relation,
    entity(c, "sessions/evidence"), { ...relation, to_entity_external_id: c }, { ...relation, to_entity_external_id: null, to_name: "Unknown" }] }], has_more: true };
  const graph = projectMemoryGraph(value, 1);
  assert.equal(graph.nodes.length, 2);
  assert.deepEqual(graph.edges, [{ source: a, target: b, label: "works_on" }]);
  assert.equal(graph.partial, true); assert.equal(graph.hasMore, true);
  assert.equal(graph.omittedRelations, 2);
  assert.doesNotMatch(JSON.stringify(graph), /PRIVATE BODY|evidence|Unknown/);
  const disguised = entity(c, "people/public"); disguised.file_path = "CONTROL\\memory-policy.md";
  assert.equal(projectMemoryGraph({ results: [{ primary_result: disguised, related_results: [] }] }, 1).nodes.length, 0);
  const many = Array.from({ length: 202 }, (_, i) => entity(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, `notes/${i}`));
  const bounded = projectMemoryGraph({ results: [{ primary_result: many[0], related_results: many.slice(1, 101) }, { primary_result: many[101], related_results: many.slice(102) }] }, 1);
  assert.equal(bounded.nodes.length, 150); assert.equal(bounded.partial, true);
});
test("graph keeps upstream pagination, disables age cutoff, and opens exact IDs without title fallback", async () => {
  const calls = [];
  const api = createMemoryGraph({ async call(name, args) {
    calls.push({ name, args });
    return name === "build_context" ? { results: [], has_more: true } : { ...entity(a, "notes/test"), content: "Safe Markdown" };
  } });
  assert.equal((await api.page(2, AbortSignal.timeout(1000))).hasMore, true);
  assert.equal(calls[0].args.timeframe, null); assert.equal(calls[0].args.page, 2);
  assert.equal((await api.note(a, AbortSignal.timeout(1000))).content, "Safe Markdown");
  assert.equal(calls[1].args.identifier, a); assert.equal(calls[1].args.include_frontmatter, false);
  for (const page of [0, -1, 1.5, 10001]) await assert.rejects(api.page(page));
  for (const id of ["../control/memory-policy", "memory://other-project/note", "Same title"]) await assert.rejects(api.note(id));
  const hidden = createMemoryGraph({ async call() { return { ...entity(a, "sessions/old-chat"), content: "raw evidence" }; } });
  await assert.rejects(hidden.note(a));
});

test("only explicitly typed saved-memory notes offer forgetting controls", async () => {
  for (const [path, type, allowed] of [["memories/topic", "hub-memory", true], ["memories/topic", "hub_memory", true], ["notes/topic", "hub-memory", false], ["memories/topic", "note", false]]) {
    const api = createMemoryGraph({ async call() { return { ...entity(a, path), frontmatter: { type } }; } });
    assert.equal((await api.note(a)).canForget, allowed);
  }
});
