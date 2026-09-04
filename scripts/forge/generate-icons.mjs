#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptRoot, "../..");
const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const renderer = join(scriptRoot, "render-icons.cjs");

const result = spawnSync(
  electronExecutable,
  [renderer, projectRoot],
  {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: true,
  },
);

if (result.error !== undefined) throw result.error;
if (result.status !== 0) {
  throw new Error(
    `icon renderer failed with ${String(result.status ?? result.signal)}`,
  );
}
