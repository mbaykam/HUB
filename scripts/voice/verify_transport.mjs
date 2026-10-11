import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { access } from "node:fs/promises";
import { createVoiceBridgeServer } from "../../packages/harness-overlay/src/host/voice-bridge-server.ts";
import { VoiceConversationError } from "../../packages/harness-overlay/src/host/voice-conversation.ts";

const python = process.argv[2];
assert.ok(python && isAbsolute(python), "Provide the installed Pipecat venv's absolute Python executable path");
await access(python);
let last = 0, calls = 0, closed = 0;
const bridge = await createVoiceBridgeServer(async () => ({
  sessionId: "synthetic-wire-test",
  async speak(utterance, text, sink) {
    if (utterance <= last) throw new VoiceConversationError("already-admitted");
    last = utterance; calls++;
    assert.equal(text, "Synthetic hello");
    sink({ type: "text", utterance, text: "Synthetic reply." });
    sink({ type: "end", utterance, status: "completed" });
  },
  async interrupt(utterance) { assert.equal(utterance, 1); },
  async close() { closed++; },
}));
try {
  const { callId } = await bridge.open();
  // Capability is ephemeral process environment, never argv, stdout or a file.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|PATH|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA)$/i.test(key)));
  env.PYTHONUTF8 = "1";
  env.HUB_VOICE_TEST_CAPABILITY = JSON.stringify({ url: bridge.url, token: bridge.token, callId });
  const child = spawn(python, [fileURLToPath(new URL("./check_bridge_transport.py", import.meta.url))], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 30_000);
  const [code] = await once(child, "exit"); clearTimeout(timer);
  assert.equal(code, 0, "Python wire verification failed (private diagnostics suppressed)");
  assert.match(stdout, /^PASS:/m);
  assert.equal(calls, 1);
  assert.equal(closed, 1);
  assert.ok(!stdout.includes(bridge.token) && !stderr.includes(bridge.token));
  console.log(stdout.trim());
} finally { await bridge.dispose(); }
