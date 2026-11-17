import assert from "node:assert/strict";
import test from "node:test";
import {changeKnowledgeDomains, undoKnowledgeDomains} from "../packages/harness-overlay/src/host/knowledge-domains.ts";
import {parseStewardPlan, stewardDue, stewardPrompt, stewardSnapshot} from "../packages/harness-overlay/src/host/knowledge-steward.ts";
import {emptyKnowledgeDomains} from "../packages/harness-overlay/src/knowledge-domain-contract.ts";

function shelves() {
  let state = emptyKnowledgeDomains();
  state = changeKnowledgeDomains(state, [
    {type: "create", ref: "new-pc", title: "Computer Setup"},
    {type: "create", ref: "new-pc2", title: "PC configuration"},
    {type: "create", ref: "new-code", title: "Coding Projects"},
    {type: "create", ref: "new-empty", title: "Misc"},
    {type: "assign", nodeId: "n1", domainId: "new-pc"},
    {type: "assign", nodeId: "n2", domainId: "new-pc2"},
    {type: "assign", nodeId: "n3", domainId: "new-code"},
  ], {expectedRevision: 0, actor: "user", knownNodeIds: ["n1", "n2", "n3"], revisionId: "r1", now: Date.now() - 30 * 86400000});
  const id = title => state.domains.find(d => d.title === title).id;
  return {state, id};
}

test("the review is due only after new notes and a quiet day", () => {
  assert.equal(stewardDue(undefined, 5, 3), true);
  assert.equal(stewardDue(undefined, 1, 3), false);
  assert.equal(stewardDue(Date.now() - 3600000, 10, 3), false);
  assert.equal(stewardDue(Date.now() - 25 * 3600000, 10, 3), true);
  assert.equal(stewardDue(undefined, 10, 1), false);
});

test("the prompt lists domains with note samples and never instructions", () => {
  const {state} = shelves();
  const snapshot = stewardSnapshot(state, [{id: "n1", title: "Screen lock"}, {id: "n2", title: "Display driver"}, {id: "n3", title: "HUB app"}, {id: "n4", title: "Loose note"}]);
  assert.equal(snapshot.unassignedCount, 1);
  assert.deepEqual(snapshot.domains.find(d => d.title === "Computer Setup").sampleNotes, ["Screen lock"]);
  assert.match(stewardPrompt(snapshot, "tr"), /note.*Turkish/s);
});

test("a review merges duplicates, renames and retires empty domains, and can be undone", () => {
  const {state, id} = shelves();
  const plan = parseStewardPlan(JSON.stringify({note: "PC configuration ile Computer Setup aynı konu; birleştirdim. Boş Misc rafını kaldırdım.", operations: [
    {type: "merge", id: id("PC configuration"), targetId: id("Computer Setup")},
    {type: "rename", id: id("Coding Projects"), title: "Software Projects", aliases: ["Yazılım Projeleri"]},
    {type: "status", id: id("Misc"), status: "inactive"},
  ]}), state);
  const after = changeKnowledgeDomains(state, plan.operations, {expectedRevision: state.revision, actor: "curator", steward: true, knownNodeIds: ["n1", "n2", "n3"], revisionId: "review-1"});
  assert.equal(after.domains.find(d => d.title === "PC configuration").status, "merged");
  assert.deepEqual(after.memberships.filter(m => m.domainId === id("Computer Setup")).map(m => m.nodeId).sort(), ["n1", "n2"]);
  assert.equal(after.domains.find(d => d.id === id("Coding Projects")).title, "Software Projects");
  assert.equal(after.domains.find(d => d.id === id("Misc")).status, "inactive");
  assert.equal(after.history.at(-1).actor, "curator");
  const undone = undoKnowledgeDomains(after, "review-1");
  assert.equal(undone.domains.find(d => d.id === id("PC configuration")).status, "active");
  assert.equal(undone.domains.find(d => d.id === id("Coding Projects")).title, "Coding Projects");
});

test("a review cannot invent domains, retire full ones, or create and assign", () => {
  const {state, id} = shelves();
  assert.throws(() => parseStewardPlan('{"note":"x","operations":[{"type":"rename","id":"nope","title":"A"}]}', state), /does not exist/);
  assert.throws(() => parseStewardPlan(JSON.stringify({note: "x", operations: [{type: "status", id: id("Computer Setup"), status: "inactive"}]}), state), /merge it instead/);
  assert.throws(() => parseStewardPlan(JSON.stringify({note: "x", operations: [{type: "create", ref: "new-a", title: "A"}]}), state), /only rename/);
  assert.throws(() => parseStewardPlan('{"operations":[]}', state), /structured answer/);
  assert.throws(() => changeKnowledgeDomains(state, [{type: "create", ref: "new-x", title: "X"}], {expectedRevision: state.revision, actor: "curator", steward: true, knownNodeIds: [], revisionId: "r"}), /only rename/);
  // Ordinary curator passes still cannot rename without review.
  assert.throws(() => changeKnowledgeDomains(state, [{type: "rename", id: id("Misc"), title: "Other"}], {expectedRevision: state.revision, actor: "curator", knownNodeIds: [], revisionId: "r"}), /human review|source evidence/);
  assert.deepEqual(parseStewardPlan('{"note":"Raflar düzenli.","operations":[]}', state).operations, []);
});
