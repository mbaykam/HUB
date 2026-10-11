'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const { join } = require('node:path');
const {
  app,
  BrowserWindow,
  ipcMain,
  session,
} = require('electron');
const { buildSync } = require('esbuild');

const projectRoot = join(__dirname, '..');

function loadAgentBrowserSource() {
  const source = `
    export {
      AgentBrowserRuntime,
    } from "./desktop/main/agent-browser/index.ts";
    export {
      createAgentBrowserRequest,
      parseAgentBrowserProjection,
    } from "./packages/harness-overlay/src/agent-browser-contract.ts";
    export {
      AGENT_BROWSER_ANNOTATION_EVENT_CHANNEL,
      parseAgentBrowserAnnotationEvent,
    } from "./packages/harness-overlay/src/agent-browser-annotation-contract.ts";
    export {
      defaultChromeUserAgent,
    } from "./packages/harness-overlay/src/browser-settings-contract.ts";
  `;
  const bundled = buildSync({
    alias: {
      '@minke/harness-overlay': join(
        projectRoot,
        'packages',
        'harness-overlay',
        'src',
      ),
    },
    bundle: true,
    external: ['electron'],
    format: 'cjs',
    platform: 'node',
    stdin: {
      contents: source,
      loader: 'ts',
      resolveDir: projectRoot,
    },
    target: 'node22',
    write: false,
  }).outputFiles[0].text;
  const filename = join(
    projectRoot,
    '.agent-browser-runtime-smoke.cjs',
  );
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(projectRoot);
  compiled._compile(bundled, filename);
  return compiled.exports;
}

function interceptAnnotationEvents(
  webContents,
  eventChannel,
  parseEvent,
) {
  const events = [];
  const waiters = new Set();
  const ownSendDescriptor = Object.getOwnPropertyDescriptor(
    webContents,
    'send',
  );
  const originalSend = webContents.send;
  let failure;

  Object.defineProperty(webContents, 'send', {
    configurable: true,
    writable: true,
    value(channel, ...args) {
      if (channel === eventChannel) {
        try {
          const event = parseEvent(args[0]);
          events.push(event);
          for (const waiter of [...waiters]) {
            if (!waiter.predicate(event)) continue;
            waiters.delete(waiter);
            clearTimeout(waiter.timeout);
            waiter.resolve(event);
          }
        } catch (error) {
          failure = error;
          for (const waiter of [...waiters]) {
            waiters.delete(waiter);
            clearTimeout(waiter.timeout);
            waiter.reject(error);
          }
        }
      }
      return Reflect.apply(originalSend, this, [channel, ...args]);
    },
  });

  return {
    waitFor(predicate, timeoutMs = 5_000) {
      if (failure !== undefined) return Promise.reject(failure);
      const existing = events.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timeout: undefined,
        };
        waiter.timeout = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error('Timed out waiting for annotation event'));
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
    restore() {
      for (const waiter of [...waiters]) {
        waiters.delete(waiter);
        clearTimeout(waiter.timeout);
        waiter.reject(
          new Error('Annotation event interception was restored'),
        );
      }
      if (ownSendDescriptor === undefined) {
        delete webContents.send;
      } else {
        Object.defineProperty(
          webContents,
          'send',
          ownSendDescriptor,
        );
      }
    },
  };
}

async function dispatchCdpClick(webContents, point) {
  await webContents.debugger.sendCommand(
    'Input.dispatchMouseEvent',
    {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    },
  );
  await webContents.debugger.sendCommand(
    'Input.dispatchMouseEvent',
    {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    },
  );
  await webContents.debugger.sendCommand(
    'Input.dispatchMouseEvent',
    {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    },
  );
}

async function startFixtureServer() {
  const userAgents = [];
  const server = http.createServer((request, response) => {
    userAgents.push(request.headers['user-agent'] ?? '');
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(`<!doctype html>
      <html>
        <head>
          <title>Agent Browser Runtime</title>
          <style>html { scroll-behavior: smooth; } body { background: white; color: #161616; }</style>
        </head>
        <body>
          <script>
            window.__minkeButtonClicks = 0;
            window.__minkeBelowFoldClicks = 0;
            window.__minkePoisonedLocatorCalls = 0;
            const nativeDocumentQuerySelectorAll =
              Document.prototype.querySelectorAll;
            Document.prototype.querySelectorAll = function(selector) {
              if (selector === "table tr") {
                window.__minkePoisonedLocatorCalls += 1;
                return nativeDocumentQuerySelectorAll.call(
                  this,
                  "button"
                );
              }
              return nativeDocumentQuerySelectorAll.call(this, selector);
            };
          </script>
          <p id="state">Ready</p>
          <button
            type="button"
            aria-label="Continue"
            onclick="
              window.__minkeButtonClicks += 1;
              document.body.style.backgroundColor = '#2ea060';
              document.getElementById('scroll-zone').style.background = 'linear-gradient(#2ea060 0 700px, #3267d8 700px)';
              document.getElementById('state').textContent =
                'Done ' + String(window.__minkeButtonClicks);
            "
          >Continue</button>
          <table>
            <tr>
              <td>5.</td>
              <td>
                <a href="https://video.example/story">
                  Example story [video]
                </a>
              </td>
            </tr>
            <tr>
              <td></td>
              <td>
                265 points by author |
                <a href="/item?id=5">31 comments</a>
              </td>
            </tr>
          </table>
          <div id="scroll-zone" style="height: 1800px" aria-hidden="true"></div>
          <button
            type="button"
            aria-label="Below fold"
            onclick="window.__minkeBelowFoldClicks += 1"
          >Below fold</button>
        </body>
      </html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  return {
    server,
    userAgents,
    url: `http://127.0.0.1:${String(address.port)}/`,
  };
}

async function verifyPwaViewer(runtime, owner, browserId, call, snapshot, desktopWindow) {
  const before = runtime.projections();
  const initial = await runtime.captureOwnedBrowser(owner, browserId);
  assert.deepEqual([...Buffer.from(initial.data, 'base64').subarray(0, 3)], [255, 216, 255]);
  assert.deepEqual(runtime.projections(), before);
  assert.equal((await call('snapshot', { sessionId: browserId })).snapshotId, snapshot.snapshotId);
  await assert.rejects(runtime.captureOwnedBrowser('unrelated-owner', browserId));
  const script = buildSync({
    bundle: true, platform: 'browser', format: 'iife', write: false, loader: { '.css': 'text' },
    stdin: { resolveDir: projectRoot, loader: 'ts', contents: `
      import { createMobileBrowserView } from './packages/harness-overlay/src/client/host/mobile-browser-view.ts';
      window.viewer = createMobileBrowserView(document);
      document.body.append(window.viewer.panel);
      // Voice coordinators are intentionally absent from Recents. Host-owned
      // browser visibility must not depend on the sidebar's filtered roster.
      window.viewer.update(true, new Map(), ${JSON.stringify(owner)});
      window.audioOwner = document.querySelector('audio');
    ` },
  }).outputFiles[0].text;
  let requests = 0;
  const { fork } = require('node:child_process');
  const child = fork(join(__dirname, 'browser-view-host.cjs'), [], { execPath: 'node', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stderr.on('data', data => process.stderr.write(data));
  const channel = runtime.bindChild(child);
  child.on('message', message => { if (message?.type === 'viewer-request-count') requests = message.count; });
  let port;
  try {
    port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Viewer host did not start')), 15000);
      child.once('error', reject);
      child.on('message', message => {
        if (message?.type === 'viewer-ready') { clearTimeout(timer); resolve(message.port); }
        if (message?.type === 'viewer-failed') { clearTimeout(timer); reject(new Error(message.error)); }
      });
      child.send({ type: 'init-viewer-fixture', owner, browserId, script });
    });
  } catch (error) { channel.dispose(); child.kill(); throw error; }
  const viewerWindow = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  const js = code => viewerWindow.webContents.executeJavaScript(code);
  const waitFor = async expression => {
    const until = Date.now() + 12000;
    while (!await js(expression)) { if (Date.now() > until) throw new Error('PWA viewer timed out: ' + expression); await new Promise(resolve => setTimeout(resolve, 100)); }
  };
  try {
    await viewerWindow.loadURL(`http://127.0.0.1:${port}`);
    await waitFor('document.querySelector("[data-hub-browser-view] img").naturalWidth > 0');
    const first = await js('document.querySelector("[data-hub-browser-view] img").src');
    await js('document.querySelector("[data-hub-browser-view]>button").click()');
    await waitFor('document.querySelector("dialog").open && document.querySelector("dialog img").naturalWidth > 0');
    const button = snapshot.nodes.find(node => node.name === 'Continue');
    assert.ok(button);
    await call('click', { sessionId: browserId, target: { ref: button.ref } });
    await call('wait', { sessionId: browserId, text: 'Done', timeoutMs: 5000 });
    await waitFor(`document.querySelector('dialog img').src !== ${JSON.stringify(first)} && document.querySelector('dialog img').naturalWidth > 0`);
    await waitFor(`(() => { const img = document.querySelector('dialog img'); const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0); const rgb = ctx.getImageData(Math.floor(img.naturalWidth / 2), Math.floor(img.naturalHeight * .7), 1, 1).data; return rgb[0] < 70 && rgb[1] > 130 && rgb[2] > 70 && rgb[2] < 120; })()`);
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
    await js('document.querySelector("dialog [aria-pressed]").click()');
    assert.equal(await js('document.querySelector("dialog figure").scrollWidth > document.querySelector("dialog figure").clientWidth'), true);
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true, 'zoom should pan inside the viewer, not overflow the PWA');
    await js('document.querySelector("dialog [aria-pressed]").click()');
    const screenshotIndex = process.argv.indexOf('--pwa-screenshot');
    if (screenshotIndex >= 0) {
      const path = process.argv[screenshotIndex + 1];
      assert.ok(require('node:path').isAbsolute(path), 'screenshot output must be an explicit absolute path');
      // A hidden Chromium window can hand back its previous painted surface
      // immediately after img.decode/canvas succeeds. Request another compositor
      // frame before saving the visual QA artifact; do not treat encoded-byte
      // inequality as evidence that the new page state was displayed.
      await viewerWindow.webContents.capturePage(undefined, { stayHidden: true });
      await new Promise(resolve => setTimeout(resolve, 200));
      const rendered = await viewerWindow.webContents.capturePage(undefined, { stayHidden: true });
      await require('node:fs/promises').writeFile(path, rendered.toPNG());
    }
    await js('[...document.querySelectorAll("dialog button")].find(button => button.textContent === "Close").click()');
    assert.equal(await js('document.querySelector("dialog").open'), false);
    assert.equal(await js('window.audioOwner === document.querySelector("audio")'), true);
    assert.equal(desktopWindow.isVisible(), false);
    assert.equal(runtime.projections()[0].owner, 'agent');
    await js('document.querySelector("[data-hub-browser-view]>button").click()');
    const scroll = await call('scroll', { sessionId: browserId, direction: 'down', amount: 900 });
    assert.ok(scroll.afterY > scroll.beforeY);
    await waitFor(`(() => { const img = document.querySelector('dialog img'); const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0); const rgb = ctx.getImageData(Math.floor(img.naturalWidth / 2), Math.floor(img.naturalHeight * .7), 1, 1).data; return rgb[0] < 80 && rgb[1] > 70 && rgb[1] < 130 && rgb[2] > 180; })()`);
    await call('navigate', { sessionId: browserId, url: `${before[0].url}?viewer-navigation=1` });
    await waitFor(`document.querySelector('[data-browser-address]').textContent.endsWith('?viewer-navigation=1')`);
    await waitFor(`(() => { const img = document.querySelector('dialog img'); if (!img.naturalWidth) return false; const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0); const rgb = ctx.getImageData(Math.floor(img.naturalWidth / 2), Math.floor(img.naturalHeight * .7), 1, 1).data; return rgb[0] > 240 && rgb[1] > 240 && rgb[2] > 240; })()`);
    child.send({ type: 'viewer-fixture-paused', paused: true });
    await waitFor(`document.querySelector('dialog [role="status"]').textContent.includes('unavailable')`);
    assert.equal(await js('document.querySelector("dialog img").getAttribute("src")'), null, 'failed refresh must not present stale pixels as live');
    child.send({ type: 'viewer-fixture-paused', paused: false });
    await waitFor(`document.querySelector('dialog [role="status"]').textContent.includes('Live view') && document.querySelector('dialog img').naturalWidth > 0`);
    await js('[...document.querySelectorAll("dialog button")].find(button => button.textContent === "Close").click()');
    await js('window.viewer.update(false, new Map())');
    await new Promise(resolve => setTimeout(resolve, 150));
    const stoppedAt = requests;
    await new Promise(resolve => setTimeout(resolve, 1400));
    assert.equal(requests, stoppedAt, 'hidden Home must stop polling');
    const denied = await fetch(`http://127.0.0.1:${port}/api/hub/browser-view`, { method: 'POST' });
    assert.equal(denied.status, 401);
    const foreign = await fetch(`http://127.0.0.1:${port}/api/hub/browser-view`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-browser-view': '1' }, body: JSON.stringify({ type: 'frame', ownerSessionId: 'foreign-task', sessionId: browserId }) });
    assert.equal(foreign.status, 503, 'real IPC must reject an owner outside this child ledger');
    console.log('PWA real native page -> compositor -> child IPC -> HTTP -> decoded UI: exact pixels after native action/scroll/navigation, expand/zoom/close, foreign ownership rejection, preserved audio element, no overflow, hidden polling PASS');
  } finally {
    if (!viewerWindow.isDestroyed()) viewerWindow.destroy();
    channel.dispose(); if (child.connected) child.disconnect();
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else { const timer = setTimeout(() => { child.kill(); resolve(); }, 4000); child.once('exit', () => { clearTimeout(timer); resolve(); }); } });
  }
}

async function run() {
  await app.whenReady();
  const {
    AGENT_BROWSER_ANNOTATION_EVENT_CHANNEL,
    AgentBrowserRuntime,
    createAgentBrowserRequest,
    defaultChromeUserAgent,
    parseAgentBrowserAnnotationEvent,
    parseAgentBrowserProjection,
  } = loadAgentBrowserSource();
  const fixture = await startFixtureServer();
  const runtime = new AgentBrowserRuntime({
    sessionFromPartition(partition, options) {
      return session.fromPartition(partition, options);
    },
    guestAttachTimeoutMs: 5_000,
    cdpCommandTimeoutMs: 5_000,
  });
  const window = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: true,
    },
  });
  const expectedUserAgent = defaultChromeUserAgent(
    window.webContents.getUserAgent(),
  );
  runtime.setUserAgent(expectedUserAgent);
  const annotationEvents = interceptAnnotationEvents(
    window.webContents,
    AGENT_BROWSER_ANNOTATION_EVENT_CHANNEL,
    parseAgentBrowserAnnotationEvent,
  );
  const projectionBinding = runtime.bindWindowProjection(
    ipcMain,
    window.webContents,
    () => true,
  );
  window.webContents.on(
    'will-attach-webview',
    (event, webPreferences, params) => {
      const decision = runtime.secureWebview(
        webPreferences,
        params,
      );
      if (decision !== 'secured') event.preventDefault();
    },
  );
  let agentGuest;
  window.webContents.on(
    'did-attach-webview',
    (_event, guest) => {
      if (!runtime.attachGuest(window.webContents, guest)) {
        guest.close({ waitForBeforeUnload: false });
        return;
      }
      agentGuest = guest;
    },
  );

  let requestId = 0;
  const ownerSessionId = 'runtime-smoke-conversation';
  const call = (
    operation,
    payload,
    signal = new AbortController().signal,
  ) => runtime.handleProcessRequest(
    createAgentBrowserRequest(
      ++requestId,
      ownerSessionId,
      operation,
      payload,
    ),
    signal,
  );

  try {
    await window.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(`<!doctype html>
          <html>
            <head>
              <style>
                html, body { margin: 0; width: 100%; height: 100%; }
                webview { display: flex; width: 100%; height: 100%; }
              </style>
            </head>
            <body></body>
          </html>`),
    );

    const openedPromise = call('open', { url: fixture.url });
    const pending = runtime.projections().at(-1);
    assert.notEqual(pending, undefined);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.partition.startsWith('persist:'), false);
    assert.doesNotMatch(expectedUserAgent, /\bElectron\//u);
    assert.doesNotMatch(expectedUserAgent, /\bMinke\//u);
    await window.webContents.executeJavaScript(`
      (() => {
        const view = document.createElement("webview");
        view.setAttribute("src", "about:blank");
        view.setAttribute(
          "partition",
          ${JSON.stringify(pending.partition)}
        );
        view.setAttribute(
          "webpreferences",
          "contextIsolation=yes,nodeIntegration=no,sandbox=yes,webSecurity=yes"
        );
        document.body.append(view);
      })()
    `);

    const opened = await openedPromise;
    assert.equal(opened.owner, 'agent');
    assert.equal(opened.url, fixture.url);
    assert.notEqual(agentGuest, undefined);
    assert.equal(agentGuest.isDestroyed(), false);
    await call('wait', {
      sessionId: opened.sessionId,
      text: 'Ready',
      timeoutMs: 5_000,
    });
    assert.ok(fixture.userAgents.length > 0);
    assert.equal(fixture.userAgents[0], expectedUserAgent);
    assert.doesNotMatch(fixture.userAgents[0], /\bElectron\//u);
    const snapshot = await call('snapshot', {
      sessionId: opened.sessionId,
    });
    const repeatedSnapshot = await call('snapshot', {
      sessionId: opened.sessionId,
    });
    assert.deepEqual(runtime.listOwnedBrowsers(new Set(['unrelated-task'])), []);
    if (process.argv.includes('--pwa-view')) {
      await verifyPwaViewer(runtime, ownerSessionId, opened.sessionId, call, snapshot, window);
      process.stdout.write('PWA browser real Chromium viewer verification passed\n');
      return;
    }
    await call('screenshot', { sessionId: opened.sessionId });
    assert.equal(window.isVisible(), false, 'Agent screenshot must keep the host window hidden');
    console.log('Native compositor agent screenshot PASS (hidden host window)');
    const ownedViews = runtime.listOwnedBrowsers(new Set([ownerSessionId]));
    assert.equal(ownedViews.length, 1);
    assert.equal(ownedViews[0].sessionId, opened.sessionId);
    assert.equal(ownedViews[0].ownerSessionId, ownerSessionId);
    await assert.rejects(runtime.captureOwnedBrowser('unrelated-task', opened.sessionId));
    const viewBefore = runtime.projections();
    const firstView = await runtime.captureOwnedBrowser(ownerSessionId, opened.sessionId);
    assert.equal(firstView.mimeType, 'image/jpeg');
    assert.deepEqual([...Buffer.from(firstView.data, 'base64').subarray(0, 3)], [255, 216, 255]);
    assert.ok(firstView.width > 0 && firstView.width <= 1024);
    assert.deepEqual(runtime.projections(), viewBefore, 'watching must not change browser control/ref projections');
    assert.equal(window.isVisible(), false, 'PWA capture must not show the hidden desktop window');
    const snapshotAfterView = await call('snapshot', { sessionId: opened.sessionId });
    assert.equal(snapshotAfterView.snapshotId, snapshot.snapshotId, 'viewer must not invalidate agent refs');
    console.log('Read-only PWA frame and unchanged agent state PASS');
    assert.equal(repeatedSnapshot.snapshotId, snapshot.snapshotId);
    assert.equal(repeatedSnapshot.generation, snapshot.generation);
    assert.deepEqual(repeatedSnapshot.nodes, snapshot.nodes);
    const button = snapshot.nodes.find(
      (node) => node.name === 'Continue',
    );
    assert.notEqual(button, undefined);
    const storyMatches = snapshot.nodes.filter(
      (node) => node.name === 'Example story [video]',
    );
    assert.equal(storyMatches.length, 1);
    const storyLink = storyMatches[0];
    const commentsLink = snapshot.nodes.find(
      (node) =>
        node.role.toLowerCase() === 'link' &&
        node.name === '31 comments',
    );
    assert.notEqual(storyLink, undefined);
    assert.notEqual(commentsLink, undefined);
    assert.equal(storyLink.role.toLowerCase(), 'link');
    assert.equal(storyLink.actionable, true);
    assert.equal(
      storyLink.url,
      'https://video.example/story',
    );
    assert.match(commentsLink.url, /\/item\?id=5$/u);
    assert.ok(commentsLink.depth > 0);
    const generatedLocate = await call('locate', {
      sessionId: opened.sessionId,
      code:
        'page.locator("table tr").nth(0).next("tr").getByRole("link", {name:/comments/i})',
    });
    assert.equal(generatedLocate.snapshotId, snapshot.snapshotId);
    assert.deepEqual(generatedLocate.node, {
      ...commentsLink,
      match: true,
    });
    assert.equal(
      await agentGuest.executeJavaScript(
        'window.__minkePoisonedLocatorCalls',
      ),
      0,
      'generated locators must execute with isolated-world DOM intrinsics',
    );
    const scrolled = await call('scroll', {
      sessionId: opened.sessionId,
      direction: 'down',
      amount: 300,
    });
    assert.equal(scrolled.scope, 'page');
    assert.equal(scrolled.moved, true);
    assert.equal(scrolled.beforeY, 0);
    assert.ok(scrolled.afterY > scrolled.beforeY);
    assert.ok(scrolled.afterY <= scrolled.maxY);
    assert.equal(scrolled.snapshotRequired, true);
    await assert.rejects(
      call('click', {
        sessionId: opened.sessionId,
        target: { ref: button.ref },
      }),
      (error) => error.code === 'snapshot_required',
    );
    const afterScrollSnapshot = await call('snapshot', {
      sessionId: opened.sessionId,
    });
    const afterScrollButton = afterScrollSnapshot.nodes.find(
      (node) => node.name === 'Continue',
    );
    assert.notEqual(afterScrollButton, undefined);
    await call('click', {
      sessionId: opened.sessionId,
      target: { ref: afterScrollButton.ref },
    });
    const clickProjection = parseAgentBrowserProjection(
      runtime.projections()[0],
    );
    assert.equal(clickProjection.cursor?.phase, 'clicking');
    assert.ok(clickProjection.cursor.sequence > 0);
    assert.ok(clickProjection.cursor.durationMs > 0);
    assert.ok(clickProjection.cursor.point.x >= 0);
    assert.ok(clickProjection.cursor.point.y >= 0);
    assert.ok(
      clickProjection.cursor.point.x <=
        clickProjection.cursor.viewport.width,
    );
    assert.ok(
      clickProjection.cursor.point.y <=
        clickProjection.cursor.viewport.height,
    );
    await call('wait', {
      sessionId: opened.sessionId,
      text: 'Done',
      timeoutMs: 5_000,
    });
    const screenshot = await call('screenshot', {
      sessionId: opened.sessionId,
    });
    const changedView = await runtime.captureOwnedBrowser(ownerSessionId, opened.sessionId);
    assert.notEqual(changedView.data, firstView.data, 'preview must show actual page changes after native actions');
    console.log('PWA browser compositor capture: ownership, unchanged control/refs, hidden window and changing real pixels PASS');
    assert.equal(screenshot.mimeType, 'image/png');
    assert.deepEqual(
      [...Buffer.from(screenshot.data, 'base64').subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    const beforeBelowFold = await call('snapshot', {
      sessionId: opened.sessionId,
    });
    const belowFoldButton = beforeBelowFold.nodes.find(
      (node) => node.name === 'Below fold',
    );
    assert.notEqual(belowFoldButton, undefined);
    await call('click', {
      sessionId: opened.sessionId,
      target: { ref: belowFoldButton.ref },
    });
    assert.equal(
      await agentGuest.executeJavaScript(
        'window.__minkeBelowFoldClicks',
      ),
      1,
    );
    const returnedToTop = await call('scroll', {
      sessionId: opened.sessionId,
      direction: 'top',
    });
    assert.equal(returnedToTop.moved, true);
    assert.equal(returnedToTop.afterY, 0);

    const human = await runtime.setControl(
      opened.sessionId,
      'human',
    );
    assert.equal(human.owner, 'human');
    assert.equal(human.status, 'paused');
    assert.equal(human.cursor, undefined);
    await assert.rejects(
      call('snapshot', { sessionId: opened.sessionId }),
      (error) => error.code === 'session_paused',
    );

    const annotation = await runtime.startAnnotation(
      opened.sessionId,
    );
    assert.equal(annotation.sessionId, opened.sessionId);
    assert.equal(annotation.generation, human.generation);
    assert.match(
      annotation.annotationSessionId,
      /^annotation-[a-zA-Z0-9]+$/u,
    );
    assert.equal(annotation.page.url, fixture.url);

    const buttonPoint = await agentGuest.executeJavaScript(`
      (() => {
        const button = document.querySelector("button");
        if (!(button instanceof HTMLButtonElement)) {
          throw new Error("fixture button is unavailable");
        }
        const rect = button.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      })()
    `);
    const selectedPromise = annotationEvents.waitFor(
      (event) =>
        event.type === 'selected' &&
        event.sessionId === opened.sessionId &&
        event.annotationSessionId ===
          annotation.annotationSessionId,
    );
    await dispatchCdpClick(agentGuest, buttonPoint);
    const selected = await selectedPromise;
    assert.equal(selected.generation, annotation.generation);
    assert.equal(selected.target.tag, 'button');
    assert.equal(selected.target.role, 'button');
    assert.equal(selected.target.text, 'Continue');
    assert.equal(selected.target.ariaLabel, 'Continue');
    assert.match(selected.target.selector, /button/u);
    assert.match(selected.target.path, /button/u);
    assert.ok(selected.target.rect.width > 0);
    assert.ok(selected.target.rect.height > 0);
    assert.ok(selected.target.viewport.width > 0);
    assert.ok(selected.target.viewport.height > 0);
    assert.equal(
      await agentGuest.executeJavaScript(
        'window.__minkeButtonClicks',
      ),
      1,
    );

    const committed = await runtime.commitAnnotation({
      sessionId: opened.sessionId,
      annotationSessionId: annotation.annotationSessionId,
      targetIds: [selected.target.targetId],
    });
    assert.equal(committed.sessionId, opened.sessionId);
    assert.equal(
      committed.annotationSessionId,
      annotation.annotationSessionId,
    );
    assert.equal(committed.generation, annotation.generation);
    assert.equal(committed.mimeType, 'image/png');
    assert.deepEqual(
      committed.targets.map((target) => target.targetId),
      [selected.target.targetId],
    );
    assert.equal(committed.targets[0].tag, 'button');
    assert.deepEqual(
      [...Buffer.from(committed.data, 'base64').subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );

    const endedPromise = annotationEvents.waitFor(
      (event) =>
        event.type === 'ended' &&
        event.sessionId === opened.sessionId &&
        event.annotationSessionId ===
          annotation.annotationSessionId &&
        event.reason === 'cancelled',
    );
    await runtime.stopAnnotation(
      opened.sessionId,
      annotation.annotationSessionId,
      'cancelled',
    );
    await endedPromise;
    await dispatchCdpClick(agentGuest, buttonPoint);

    const agent = await runtime.setControl(
      opened.sessionId,
      'agent',
    );
    assert.equal(agent.owner, 'agent');
    assert.equal(agent.status, 'ready');
    await assert.rejects(
      call('click', {
        sessionId: opened.sessionId,
        target: { ref: button.ref },
      }),
      (error) => error.code === 'snapshot_required',
    );
    const resumedSnapshot = await call('snapshot', {
      sessionId: opened.sessionId,
    });
    assert.notEqual(resumedSnapshot.snapshotId, snapshot.snapshotId);
    await call('wait', {
      sessionId: opened.sessionId,
      text: 'Done 2',
      timeoutMs: 5_000,
    });
    assert.deepEqual(
      await call('close', { sessionId: opened.sessionId }),
      { sessionId: opened.sessionId, closed: true },
    );
    assert.equal(runtime.projections().length, 0);
    process.stdout.write(
      'Agent Browser Electron runtime smoke passed\n',
    );
  } finally {
    annotationEvents.restore();
    projectionBinding.dispose();
    runtime.dispose();
    if (!window.isDestroyed()) window.destroy();
    await new Promise((resolve) => fixture.server.close(resolve));
  }
}

run()
  .catch((error) => {
    process.stderr.write(
      `${String(error?.stack ?? error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    app.exit(process.exitCode ?? 0);
  });
