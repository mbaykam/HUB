import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectInstalledUINotices } from "../scripts/installed-ui-notices.mjs";

test("collects only actual dependency notices, including fonts and nested packages, deterministically", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-notices-"));
  try {
    for (const pkg of ["alpha", "@fonts/type", ".pnpm/beta@1/node_modules/beta"]) {
      await mkdir(join(root, "node_modules", pkg), { recursive: true });
      await writeFile(join(root, "node_modules", pkg, pkg.includes("fonts") ? "OFL.txt" : "LICENSE-MIT"), "synthetic notice < &");
      await writeFile(join(root, "node_modules", pkg, "README.md"), "not a notice");
    }
    const first = await collectInstalledUINotices(root), second = await collectInstalledUINotices(root);
    assert.deepEqual(first, second);
    assert.equal(first.length, 3);
    assert.ok(first.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
    assert.ok(first.some(item => item.file.endsWith("OFL.txt")));
    assert.ok(first.every(item => !item.text.includes("not a notice")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects package symlinks outside staging before reading notices", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-notices-fence-"));
  try {
    await mkdir(join(root, "stage/node_modules"), { recursive: true });
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside/LICENSE"), "must not read");
    await symlink(join(root, "outside"), join(root, "stage/node_modules/escape"), "junction");
    await assert.rejects(collectInstalledUINotices(join(root, "stage")), /escapes staging/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
