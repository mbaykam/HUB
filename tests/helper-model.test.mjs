import test from "node:test";
import assert from "node:assert/strict";
import {helperCharacter} from "@minke/harness-overlay/characters.ts";

const character = (id, name) => ({id, name, avatar: "hub", description: "", instructions: "", route: {provider: "p", model: id}, tools: {mode: "inherit"}, speech: null, delegateTo: null});
const main = character("11111111-1111-4111-8111-111111111111", "HUB");
const voice = character("22222222-2222-4222-8222-222222222222", "Vera");
const free = character("33333333-3333-4333-8333-333333333333", "B4D");
const state = {revision: 1, mainId: main.id, voiceId: voice.id, unrestrictedId: free.id, bindings: {}, characters: [main, voice, free]};

test("helpers run on the chat's model by default and on the voice model when fast", () => {
  assert.equal(helperCharacter(state, {}, main).id, main.id);
  assert.equal(helperCharacter(state, {model: "chat"}, main).id, main.id);
  assert.equal(helperCharacter(state, {model: "fast"}, main).id, voice.id);
});

test("an unlocked chat's helpers use the unrestricted model; a locked chat cannot ask for it", () => {
  assert.equal(helperCharacter(state, {}, free).id, free.id);
  assert.equal(helperCharacter(state, {model: "unrestricted"}, free).id, free.id);
  assert.throws(() => helperCharacter(state, {model: "unrestricted"}, main), /unlocked/);
});

test("older calls naming a character still work", () => {
  assert.equal(helperCharacter(state, {character: "vera"}, main).id, voice.id);
});
