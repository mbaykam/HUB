import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(
  new URL(
    "../packages/harness-overlay/src/client/ambient-theme/styles.css",
    import.meta.url,
  ),
  "utf8",
);
const installer = readFileSync(
  new URL(
    "../packages/harness-overlay/src/client/ambient-theme/install.ts",
    import.meta.url,
  ),
  "utf8",
);
const clientEntry = readFileSync(
  new URL(
    "../packages/harness-overlay/src/client/index.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("ambient theme carries Minke's animated browser-tab palette", () => {
  for (const color of [
    "--minke-ambient-cyan",
    "--minke-ambient-blue",
    "--minke-ambient-violet",
    "--minke-ambient-pink",
    "--minke-ambient-amber",
  ]) {
    assert.match(styles, new RegExp(color, "u"));
  }
  assert.match(styles, /@keyframes minke-ambient-flow/u);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/u);
  assert.match(styles, /prefers-reduced-transparency:\s*reduce/u);
  assert.match(styles, /prefers-contrast:\s*more/u);
});

test("ambient theme layers semantic Harness surfaces and mounts from apply", () => {
  assert.match(installer, /ctx\.theme\.overrideTokens\(/u);
  assert.match(installer, /--dsw-alias-bg-base/u);
  assert.match(installer, /--dsw-specific-sidebar-fill/u);
  assert.match(clientEntry, /installAmbientTheme\(ctx\)/u);
});
