import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'hub-voice-browser-parent-'));
let child;
try {
  const electron = createRequire(import.meta.url)('electron');
  child = spawn(electron, [join(root, 'tests/voice-browser-runtime.cjs'), ...process.argv.slice(2)], {
    cwd: root, env: { ...process.env, HUB_VOICE_BROWSER_FIXTURE_ROOT: temp }, windowsHide: true, stdio: 'inherit',
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, 'Owned Electron voice/browser integration failed');
} finally {
  assert.equal(dirname(resolve(temp)), resolve(tmpdir())); assert.ok(basename(temp).startsWith('hub-voice-browser-parent-'));
  await rm(temp, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log('Owned Electron fixture profile cleaned after process exit');
}
