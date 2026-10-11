// Boot the actual packaged Loader with an isolated home/vault. No user chats,
// credentials or provider calls. All readiness capabilities stay in process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { embeddedNodeChildEnvironment } from '../../config/embedded-node-runtime.mts';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  'runtime-root': { type: 'string' }, 'voice-python': { type: 'string' },
  playwright: { type: 'string' }, screenshot: { type: 'string' },
} });
const [appRoot, memoryExecutable] = positionals;
assert.ok(appRoot && memoryExecutable, 'Usage: verify_packaged.mjs <HUB app directory> <basic-memory executable>');
assert.ok(!values.playwright || values['voice-python'], 'The packaged Home UI check requires --voice-python to enable its voice route');
const root = await mkdtemp(join(tmpdir(), 'hub-memory-boot-'));
const runtime = values['runtime-root'] ? resolve(values['runtime-root']) : join(resolve(appRoot), 'resources', 'host');
const executable = join(resolve(appRoot), 'HUB.exe');
const configDir = join(root, 'memory');
const profile = join(root, 'dsh', 'profiles', 'web');
const q = JSON.stringify;
let child;
let output = '';
try {
  await Promise.all([mkdir(configDir), mkdir(profile, { recursive: true }), mkdir(join(root, 'vault'))]);
  await writeFile(join(configDir, 'config.json'), q({ projects: { 'hub-memory-pilot': { path: join(root, 'vault'), mode: 'local' } }, default_project: 'hub-memory-pilot', semantic_search_enabled: false, logfire_enabled: false, logfire_send_to_logfire: false }));
  await writeFile(join(profile, 'cordis.yml'), '[]');
  await writeFile(join(profile, 'package.json'), q({ name: 'hub-memory-boot-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
  await writeFile(join(profile, 'cordis.patch.yml'), `- insert:
    - id: hub-memory-storage
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: hub_memory
        transport: stdio
        command: ${q(resolve(memoryExecutable))}
        args: [mcp]
        cwd: ${q(configDir)}
        env:
          BASIC_MEMORY_CONFIG_DIR: ${q(configDir)}
          BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED: 'false'
          BASIC_MEMORY_LOGFIRE_ENABLED: 'false'
          HF_HUB_OFFLINE: '1'
          HF_HUB_DISABLE_TELEMETRY: '1'
          DO_NOT_TRACK: '1'
          PYTHONUTF8: '1'
          LITELLM_LOCAL_MODEL_COST_MAP: 'True'
          FASTMCP_CHECK_FOR_UPDATES: 'off'
        failOnStartupError: true
    - id: hub-memory
      name: '@lencx/minke-harness-overlay/memory'
      config:
        project: hub-memory-pilot
        provider: unused
        model: unused
        captureSince: ${Date.now()}
        topicNotes: true
${values['voice-python'] ? `    - id: hub-voice
      name: '@lencx/minke-harness-overlay/voice'
      config:
        python: ${q(resolve(values['voice-python']))}
        provider: unused
        model: unused
` : ''}
`);
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
  const env = embeddedNodeChildEnvironment({ electronExecutable: executable, pnpmEntry: join(runtime, 'node_modules/pnpm/bin/pnpm.cjs'), runtimeBin: join(runtime, 'bin') }, {
    ...inherited, USERPROFILE: root, APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local'), DSH_HOME: join(root, 'dsh'),
  });
  child = spawn(executable, ['--expose-internals', join(runtime, 'index.mjs'), 'web', '--patch', join(runtime, 'node_modules/@lencx/minke-harness-overlay/cordis.patch.yml'), '--no-open', '--host', '127.0.0.1', '--port', '0'], { env, cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let readyUrl;
  const consume = chunk => {
    const text = chunk.toString();
    const match = text.match(/dsh web: (http:\/\/[^\s)]+)/);
    if (match) readyUrl = new URL(match[1]);
    output = (output + text.replace(/([?&]token=)[^\s)]+/g, '$1[redacted]')).slice(-10_000);
  };
  child.stdout.on('data', consume); child.stderr.on('data', consume);
  const deadline = Date.now() + 90_000;
  while (!readyUrl && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(readyUrl, `Packaged boot failed: ${output}`);
  const exchange = await fetch(readyUrl, { redirect: 'manual' });
  assert.equal(exchange.status, 303);
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  const endpoint = new URL('/api/hub/memory', readyUrl);
  assert.equal((await fetch(endpoint)).status, 401);
  let snapshot;
  while (Date.now() < deadline) {
    const response = await fetch(endpoint, { headers: { cookie } });
    if (response.ok) { snapshot = await response.json(); if (snapshot.status === 'ready') break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(snapshot?.enabled, true, output);
  assert.equal(snapshot?.status, 'ready', output);
  assert.match(snapshot.content, /No lasting facts/);
  const denied = await fetch(endpoint, { method: 'POST', headers: { cookie, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 403);
  console.log('PASS: packaged HUB Loader boots memory/MCP, authenticates the real route, rejects cross-site writes, and initializes a private synthetic vault');
  if (values['voice-python']) {
    for (const path of ['/api/hub/voice/status', '/api/hub/voice/history', '/api/hub/voice/client.js']) {
      const url = new URL(path, readyUrl);
      assert.equal((await fetch(url)).status, 401, path);
      assert.equal((await fetch(url, { headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status, 403, path);
      const response = await fetch(url, { headers: { cookie } });
      assert.equal(response.status, 200, path);
      if (path.endsWith('/history')) assert.deepEqual(await response.json(), { conversations: [] });
      if (path.endsWith('/status')) assert.equal((await response.json()).enabled, true);
    }
    console.log('PASS: actual packaged voice plugin loads native storage and authenticated status/history/lazy SDK routes; no model or microphone started');
  }
  if (values.playwright) {
    const { verifyPackagedUi } = await import('../voice/verify_packaged_ui.mjs');
    await verifyPackagedUi({ origin: readyUrl.origin, cookie, playwright: values.playwright, screenshot: values.screenshot });
  }
} finally {
  if (child && child.exitCode === null) {
    // The exact subprocess tree belongs to this disposable test only.
    const stop = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await once(stop, 'exit');
  }
  const rel = relative(resolve(tmpdir()), resolve(root));
  assert.ok(rel.startsWith('hub-memory-boot-') && !rel.includes('..'));
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}
