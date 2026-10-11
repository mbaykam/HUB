#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "minke-agent-browser-conversation-"),
);
const environment = {
  ...process.env,
  MINKE_AGENT_BROWSER_E2E_ROOT: temporaryRoot,
};
delete environment.ELECTRON_RUN_AS_NODE;
const protectedPaths = [
  "packages/remote-access/src/runtime.ts",
  "runtime/host/node_modules/@deepseek-ai/dsh/lib/bin.js",
  "runtime/host/node_modules/@lencx/minke-harness-overlay/lib/client.js",
].map(path => join(projectRoot, path));
const fingerprint = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const before = await Promise.all(protectedPaths.map(fingerprint));

try {
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(
      require("electron"),
      [join(projectRoot, "tests", "agent-browser-conversation-runtime.cjs")],
      {
        cwd: projectRoot,
        env: environment,
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (signal !== null) {
        reject(new Error(`Agent Browser conversation E2E exited on ${signal}`));
        return;
      }
      resolveExit(exitCode ?? 1);
    });
  });
  process.exitCode = code;
} finally {
  assert.equal(dirname(temporaryRoot), resolve(tmpdir()));
  assert.ok(temporaryRoot.startsWith(join(tmpdir(), "minke-agent-browser-conversation-")));
  // This runs in standalone Node, never Electron's junction-following sync
  // remover. Chromium may briefly retain file handles after process exit.
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  assert.deepEqual(await Promise.all(protectedPaths.map(fingerprint)), before,
    "Isolated test/profile cleanup must preserve linked source and runtime packages");
}
