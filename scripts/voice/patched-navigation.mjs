// Isolated staged-artifact fixture used by browser and runtime-patch checks.
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { applyHarnessRuntimePatches, resolveHarnessRuntimePatches, verifyHarnessRuntimePatchesApplied } from '../harness/runtime-patches.mjs';

export async function patchedNavigation(root) {
  root = resolve(root);
  const temp = await mkdtemp(join(tmpdir(), 'hub-navigation-check-'));
  try {
    const target = resolve(temp, 'node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, (await readFile(resolve(root, 'vendor/deepseek-harness/packages/client/ui-workspace/lib/client.js'), 'utf8')).replaceAll('\r\n', '\n'));
    const patches = await resolveHarnessRuntimePatches(root, ['patches/deepseek-harness/client-navigation-visibility.patch']);
    await applyHarnessRuntimePatches(temp, patches);
    await verifyHarnessRuntimePatchesApplied(temp, patches);
    return await readFile(target, 'utf8');
  } finally { await rm(temp, { recursive: true, force: true }); }
}
