import test from "node:test";
import assert from "node:assert/strict";
import { parseVoiceIceServers } from "@minke/harness-overlay/voice-ice-contract.ts";

test("ICE normalizes standard service responses and clones only bounded client credentials", () => {
  const input = [{ urls: "stun:relay.example:3478" }, { urls: ["turn:relay.example:3478?transport=udp", "turns:relay.example:443?transport=tcp"], username: "fixture", credential: "synthetic-only" }];
  const result = parseVoiceIceServers(input);
  assert.deepEqual(result[0], { urls: [input[0].urls] });
  assert.deepEqual(result[1], input[1]);
  result[1].urls.push("turn:other.example");
  assert.equal(input[1].urls.length, 2);
  assert.deepEqual(parseVoiceIceServers([]), []);
});

test("ICE rejects non-ICE URLs, administrative fields and malformed credentials without echoing input", () => {
  const secret = "synthetic-secret-never-in-errors";
  const relay = { urls: "turn:relay.example:3478", username: "fixture", credential: secret };
  for (const value of [null, {}, Array(7).fill(relay), [null], [{ ...relay, apiKey: secret }],
    ...["https://relay.example", "turn:user@relay.example", "turn:relay.example:0", "turn:relay.example:65536", "turn:relay.example/path", "turns:relay.example?transport=udp", "stun:relay.example?transport=tcp"].map(urls => [{ ...relay, urls }]),
    [{ ...relay, username: "" }], [{ ...relay, credential: "\n" }], [{ ...relay, urls: [] }], [{ ...relay, urls: Array(9).fill(relay.urls) }], [{ urls: "stun:relay.example", credential: secret }]]) {
    assert.throws(() => parseVoiceIceServers(value), error => !error.message.includes(secret) && /Invalid voice/.test(error.message));
  }
});
