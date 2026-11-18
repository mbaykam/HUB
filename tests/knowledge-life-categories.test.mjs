import test from "node:test";
import assert from "node:assert/strict";
import {withLifeCategories} from "../packages/harness-overlay/src/host/knowledge-curator.ts";
import {organizationPrompt} from "../packages/harness-overlay/src/host/knowledge-organization.ts";
import {defaultKnowledgeSettings} from "../packages/harness-overlay/src/knowledge-contract.ts";

test("people and life details are memory categories; unchanged settings gain them, narrowed ones are kept", () => {
  assert.deepEqual(withLifeCategories({categories: ["preferences", "decisions", "projects", "learning"]}).categories,
    ["preferences", "decisions", "projects", "learning", "people", "life"]);
  assert.deepEqual(withLifeCategories({categories: ["projects"]}).categories, ["projects"]);
  assert.deepEqual(withLifeCategories({categories: ["preferences", "decisions", "projects", "learning", "people", "life"]}).categories.length, 6);
  assert.ok(defaultKnowledgeSettings.categories.includes("people") && defaultKnowledgeSettings.categories.includes("life"));
  const prompt = organizationPrompt({conversationId: "c", content: "x"}, [], {...defaultKnowledgeSettings, language: "en"});
  assert.match(prompt, /preferences\|decisions\|projects\|learning\|people\|life/);
  assert.match(prompt, /a friend mentioned in passing is worth a people memory/);
});
