import test from "node:test";
import assert from "node:assert/strict";
import {selectHelperRoute, billingBasis, helperDispatchBlockReason} from "../packages/harness-overlay/src/host/helper-routing.ts";

const character = (id, provider, tools = {mode: "inherit"}) => ({id, name: id, avatar: "hub", description: "", instructions: "", route: {provider, model: `${id}-model`}, tools, speech: null, delegateTo: null});
const main = character("smart", "claude-code"), voice = character("fast", "openrouter"), codex = character("code", "openai-codex"), free = character("unrestricted", "openrouter");
const state = {revision: 1, mainId: main.id, voiceId: voice.id, unrestrictedId: free.id, bindings: {}, characters: [main, voice, codex, free]};
const route = (args, current = main, s = state) => selectHelperRoute(s, args, current);

test("auto is subscription-first and capability-scoped, not always Smart", () => {
  assert.equal(route({}).character.id, main.id);
  assert.equal(route({taskKind: "code"}).character.id, codex.id);
  assert.equal(route({taskKind: "research"}, voice).character.id, main.id);
  assert.equal(route({taskKind: "code"}, free).character.id, codex.id);
  assert.equal(route({taskKind: "brief"}).routing.billingBasis, "subscription");
});
test("explicit configured selections and effective Chat route are honored", () => {
  assert.equal(route({model: "chat"}, voice).character.id, voice.id);
  assert.equal(route({model: "fast"}).character.id, voice.id);
  assert.equal(route({character: "code"}).character.id, codex.id);
  const active = {...main, route: {provider: "openai-codex", model: "active-turn-model"}};
  assert.equal(route({model: "chat"}, active).routing.model, "active-turn-model");
  assert.equal(route({taskKind: "code"}, active).routing.model, "active-turn-model");
  assert.throws(() => route({model: "unrestricted"}), /unlocked/);
  assert.throws(() => route({character: "unrestricted"}), /Unlock/);
  assert.equal(route({model: "unrestricted"}, free).character.id, free.id);
});
test("no automatic paid route, unknown billing, unrestricted or permission expansion", () => {
  const restricted = {...main, tools: {mode: "allow", names: ["read"]}};
  assert.equal(route({}, restricted).character.id, restricted.id);
  assert.throws(() => route({model: "fast"}, restricted), /expand/);
  const subset = {...codex, tools: {mode: "allow", names: ["read"]}};
  assert.equal(route({taskKind: "code"}, restricted, {...state, characters: [voice, subset, free]}).character.id, codex.id);
  assert.throws(() => route({}, voice, {...state, characters: [voice, free]}), /No subscription helper/);
  assert.throws(() => route({model: "made-up"}), /Choose auto/);
  assert.equal(billingBasis({provider: "openrouter", model: "claude-subscription"}), "api");
  assert.equal(billingBasis({provider: "custom-claude", model: "gpt-5"}), "unknown");
  assert.equal(helperDispatchBlockReason({billingBasis: "subscription"}), undefined);
  assert.match(helperDispatchBlockReason({billingBasis: "api"}), /No helper started/);
  assert.match(helperDispatchBlockReason({billingBasis: "unknown"}), /approval alone is not a budget/);
});
