import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ProjectsStore, folderName, projectPrompt, installProjects, NOTE_FILE} from "../packages/harness-overlay/src/host/projects.ts";

const fresh = async () => {
  const dir = await mkdtemp(join(tmpdir(), "hub-projects-"));
  const store = new ProjectsStore(join(dir, "state", "projects.json"), join(dir, "HUB Projects"));
  await store.load();
  return {dir, store};
};

test("creating a project makes its folder and an empty note, with no folder picking", async () => {
  const {dir, store} = await fresh();
  const snap = await store.change({action: "create", name: "  Thesis:  draft?  "});
  const project = snap.projects[0];
  assert.equal(project.name, "Thesis: draft?");
  assert.equal(project.folder, join(dir, "HUB Projects", "Thesis draft"));
  assert.ok((await stat(project.folder)).isDirectory());
  assert.equal(await readFile(join(project.folder, NOTE_FILE), "utf8"), "# Thesis: draft?\n\n");
  const twin = (await store.change({action: "create", name: "Thesis draft"})).projects[0];
  assert.equal(twin.folder, join(dir, "HUB Projects", "Thesis draft (2)"));
});

test("a chat belongs to one project; moving it takes it out of the other", async () => {
  const {store} = await fresh();
  const a = (await store.change({action: "create", name: "A"})).projects[0];
  const b = (await store.change({action: "create", name: "B"})).projects[0];
  await store.change({action: "add", id: a.id, sessionId: "session-1"});
  let snap = await store.change({action: "add", id: b.id, sessionId: "session-1"});
  assert.deepEqual(snap.projects.find(p => p.id === a.id).sessionIds, []);
  assert.deepEqual(snap.projects.find(p => p.id === b.id).sessionIds, ["session-1"]);
  assert.equal(store.projectFor("session-1").id, b.id);
  snap = await store.change({action: "detach", sessionId: "session-1"});
  assert.equal(store.projectFor("session-1"), undefined);
});

test("removing a project keeps its folder and note; state survives a reload", async () => {
  const {dir, store} = await fresh();
  const p = (await store.change({action: "create", name: "Garden", instructions: "Answer in Turkish."})).projects[0];
  await store.change({action: "note", id: p.id, content: "# Garden\n\nTomatoes on the balcony."});
  const again = new ProjectsStore(join(dir, "state", "projects.json"), join(dir, "HUB Projects"));
  await again.load();
  assert.equal(again.snapshot().projects[0].instructions, "Answer in Turkish.");
  assert.equal(again.readNoteNow(again.snapshot().projects[0]), "# Garden\n\nTomatoes on the balcony.");
  await store.change({action: "remove", id: p.id});
  assert.equal(store.snapshot().projects.length, 0);
  assert.ok((await stat(join(p.folder, NOTE_FILE))).isFile());
  await assert.rejects(store.change({action: "rename", id: p.id, name: "x"}), /no longer exists/);
});

test("names are validated and folder names are safe on Windows", async () => {
  const {store} = await fresh();
  await assert.rejects(store.change({action: "create", name: "   "}), /Give the project a name/);
  assert.equal(folderName("con"), "Project con");
  assert.equal(folderName("a/b\\c|d."), "a b c d");
});

test("the prompt carries name, folder, instructions and the note", () => {
  const text = projectPrompt({id: "x", name: "Thesis", folder: "C:\\P\\Thesis", instructions: "Be formal.", sessionIds: [], createdAt: 0, updatedAt: 0}, "Deadline: 1 March");
  for (const part of ["\"Thesis\"", "C:\\P\\Thesis", "Be formal.", "Deadline: 1 March", "hub_project_note"]) assert.ok(text.includes(part), part);
});

test("chats in a project get the project prompt and can update the note through the tool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hub-projects-install-"));
  let section, tool;
  const ctx = {
    systemPrompt: {section(s) { section = s; return () => {}; }},
    tools: {register(t) { tool = t; return () => {}; }},
    webServer: {register() { return () => {}; }},
    connection: {requestRejection() { return undefined; }},
  };
  const characters = {store: {root: join(dir, "hub-characters")}};
  const dispose = installProjects(ctx, characters, join(dir, "HUB Projects"));
  const store = characters.projects;
  await store.load();
  const p = (await store.change({action: "create", name: "Trip", instructions: "Budget is 500 EUR."})).projects[0];
  await store.change({action: "add", id: p.id, sessionId: "session-trip"});
  assert.equal(section.text({scope: {id: "session-other", session: {header: {id: "session-other"}}}}), "");
  assert.match(section.text({scope: {id: "session-trip", session: {header: {id: "session-trip"}}}}), /Budget is 500 EUR/);
  assert.match(section.text({scope: {id: "sub-1", session: {header: {id: "sub-1", parentSession: "session-trip"}}}}), /"Trip"/);
  const exec = {agent: {session: {header: {id: "session-trip"}}}};
  await tool.execute({action: "append", content: "Flights booked for 3 May"}, exec);
  assert.match(store.readNoteNow(p), /Flights booked for 3 May/);
  await assert.rejects(tool.execute({action: "read"}, {agent: {session: {header: {id: "session-other"}}}}), /not part of a project/);
  await dispose();
});
