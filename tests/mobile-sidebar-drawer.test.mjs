import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  JSDOM,
} from "../vendor/deepseek-harness/node_modules/jsdom/lib/api.js";
import {
  MOBILE_SIDEBAR_FLING_VELOCITY,
  MOBILE_SIDEBAR_OPEN_THRESHOLD,
  MobileSidebarDrawerRuntime,
  clampMobileSidebarProgress,
  mobileSidebarVisuals,
  resolveMobileSidebarOpen,
} from "@minke/harness-overlay/client/host/mobile-sidebar-drawer.ts";

function nextFrame(view) {
  return new Promise((resolve) => view.requestAnimationFrame(resolve));
}

function pointerEvent(view, type, init) {
  const event = new view.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: init.clientX,
    clientY: init.clientY,
  });
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: init.pointerId },
    pointerType: { value: init.pointerType },
  });
  return event;
}

const styles = readFileSync(
  new URL(
    "../packages/harness-overlay/src/client/host/mobile-sidebar-drawer.css",
    import.meta.url,
  ),
  "utf8",
);
const installer = readFileSync(
  new URL(
    "../packages/harness-overlay/src/client/tabs/install.tsx",
    import.meta.url,
  ),
  "utf8",
);
const overlayPatch = readFileSync(
  new URL(
    "../packages/harness-overlay/cordis.patch.yml",
    import.meta.url,
  ),
  "utf8",
);

test("mobile sidebar visuals fully retract and track the finger", () => {
  assert.equal(clampMobileSidebarProgress(-1), 0);
  assert.equal(clampMobileSidebarProgress(2), 1);

  assert.deepEqual(mobileSidebarVisuals(0, 280), {
    contentBrightness: 1,
    contentRadius: 0,
    contentScale: 1,
    contentShift: 0,
    offset: -280,
    progress: 0,
    scrimOpacity: 0,
    shadowOpacity: 0,
  });
  assert.deepEqual(mobileSidebarVisuals(1, 280), {
    contentBrightness: 0.92,
    contentRadius: 18,
    contentScale: 0.985,
    contentShift: 18,
    offset: 0,
    progress: 1,
    scrimOpacity: 0.32,
    shadowOpacity: 0.32,
  });
});

test("mobile sidebar settles by distance or release velocity", () => {
  assert.equal(
    resolveMobileSidebarOpen({
      progress: MOBILE_SIDEBAR_OPEN_THRESHOLD,
      velocity: 0,
      startedOpen: false,
    }),
    true,
  );
  assert.equal(
    resolveMobileSidebarOpen({
      progress: 1 - MOBILE_SIDEBAR_OPEN_THRESHOLD,
      velocity: 0,
      startedOpen: true,
    }),
    false,
  );
  assert.equal(
    resolveMobileSidebarOpen({
      progress: 0.1,
      velocity: MOBILE_SIDEBAR_FLING_VELOCITY,
      startedOpen: false,
    }),
    true,
  );
  assert.equal(
    resolveMobileSidebarOpen({
      progress: 0.9,
      velocity: -MOBILE_SIDEBAR_FLING_VELOCITY,
      startedOpen: true,
    }),
    false,
  );
});

test("one touch activates a session once and then closes the drawer", async () => {
  const dom = new JSDOM(`<!doctype html>
    <html data-minke-mobile-web>
      <body>
        <main id="frame">
          <aside id="sidebar">
            <div data-slot="sidebar">
              <div role="treeitem" aria-selected="false" id="session">
                <span id="session-title">Previous session</span>
                <button id="session-actions" type="button">Actions</button>
              </div>
            </div>
          </aside>
          <section id="content"></section>
          <section id="details"></section>
          <div data-shell-overlay></div>
        </main>
      </body>
    </html>`, {
    pretendToBeVisual: true,
    url: "https://minke.test/",
  });
  const view = dom.window;
  Object.defineProperty(view, "innerWidth", {
    configurable: true,
    value: 390,
  });
  view.matchMedia = () => ({ matches: true });
  const sidebar = view.document.querySelector("#sidebar");
  sidebar.getBoundingClientRect = () => ({ width: 320 });

  let current = "current-session";
  let opens = 0;
  let toggles = 0;
  const listeners = new Set();
  const frame = view.document.querySelector("#frame");
  const runtime = new MobileSidebarDrawerRuntime(
    {
      toggleSidebar: () => {
        toggles += 1;
        frame.toggleAttribute("data-sidebar-collapsed");
      },
    },
    {
      getSnapshot: () => ({ current }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    view.document,
  );
  const row = view.document.querySelector("#session");
  const title = view.document.querySelector("#session-title");
  row.addEventListener("click", () => {
    opens += 1;
    current = "previous-session";
    row.setAttribute("aria-selected", "true");
    for (const listener of listeners) listener();
  });

  runtime.start();
  await nextFrame(view);
  title.dispatchEvent(pointerEvent(view, "pointerdown", {
    clientX: 100,
    clientY: 120,
    pointerId: 7,
    pointerType: "touch",
  }));
  title.dispatchEvent(pointerEvent(view, "pointerup", {
    clientX: 100,
    clientY: 120,
    pointerId: 7,
    pointerType: "touch",
  }));
  // Simulate WebKit's delayed native click. The explicit activation must be
  // the only row click produced by this one physical touch.
  title.dispatchEvent(new view.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  }));
  await new Promise((resolve) => view.setTimeout(resolve, 10));

  assert.equal(current, "previous-session");
  assert.equal(opens, 1);
  assert.equal(toggles, 1);
  assert.equal(
    frame.hasAttribute("data-minke-mobile-sidebar-open"),
    false,
  );

  runtime.dispose();
  view.close();
});

test("mobile navigation separates unnamed recents from project folders", async () => {
  const dom = new JSDOM(`<!doctype html>
    <html data-minke-mobile-web lang="en">
      <body>
        <main id="frame">
          <aside id="sidebar">
            <div data-slot="sidebar">
              <div id="sidebar-root">
                <div id="logo-row"><button id="sidebar-toggle">Toggle</button></div>
                <button id="new-session">New Session</button>
                <div id="region">
                  <div data-slot="sidebar.workspaces">
                    <div id="browser">
                      <div id="section-header">
                        <span id="section-label">Workspaces</span>
                        <div><button id="search">Search</button></div>
                        <div>
                          <button id="view-options">View options</button>
                          <button id="add-workspace">Add workspace</button>
                        </div>
                      </div>
                      <div id="list-area">
                        <div><div role="tree" id="tree">
                          <div id="main-workspace">
                            <span><div role="treeitem" aria-expanded="true">
                              <span>Minke</span><button>Actions</button><button id="main-new-session">Add</button>
                            </div></span>
                            <div id="existing-chat" role="treeitem" aria-selected="true">Existing chat</div>
                          </div>
                          <div id="project-workspace">
                            <span><div role="treeitem" aria-expanded="true">
                              <span>Website redesign</span><button>Actions</button><button>Add</button>
                            </div></span>
                            <div role="treeitem" aria-selected="false">Project chat</div>
                          </div>
                          <div id="loose-chats">
                            <div role="treeitem" aria-expanded="true">
                              <span>Ungrouped</span><button>Add</button>
                            </div>
                            <div role="treeitem" aria-selected="false">Loose chat</div>
                          </div>
                        </div></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </aside>
          <section id="content">
            <button id="main-workspace-chip" aria-haspopup="menu">
              <span>Minke</span>
            </button>
          </section>
          <section id="details"></section>
          <div data-shell-overlay></div>
        </main>
      </body>
    </html>`, {
    pretendToBeVisual: true,
    url: "https://hub.test/",
  });
  const view = dom.window;
  Object.defineProperty(view, "innerWidth", {
    configurable: true,
    value: 390,
  });
  view.matchMedia = () => ({ matches: true });
  let globalSessionStarts = 0;
  let mainSessionStarts = 0;
  let workspaceStarts = 0;
  const openedSessions = [];
  view.document.querySelector("#new-session").addEventListener(
    "click",
    () => { globalSessionStarts += 1; },
  );
  view.document.querySelector("#main-new-session").addEventListener(
    "click",
    () => { mainSessionStarts += 1; },
  );
  view.document.querySelector("#add-workspace").addEventListener(
    "click",
    () => { workspaceStarts += 1; },
  );
  const runtime = new MobileSidebarDrawerRuntime(
    { toggleSidebar: () => {} },
    {
      getSnapshot: () => ({
        current: "existing-session",
        byId: {
          "existing-session": {
            title: "Existing chat",
            cwd: "C:\\Minke",
          },
        },
      }),
      subscribe: () => () => {},
    },
    view.document,
    (sessionId) => { openedSessions.push(sessionId); },
  );

  runtime.start();
  await nextFrame(view);

  assert.equal(
    view.document.querySelector("#section-label").textContent,
    "Workspaces",
  );
  assert.equal(
    view.document.querySelector("#section-label").hasAttribute(
      "data-hub-mobile-nav-section-label",
    ),
    true,
  );
  assert.equal(
    view.document.querySelector("#logo-row").hasAttribute(
      "data-hub-mobile-nav-logo-row",
    ),
    true,
  );
  assert.equal(
    view.document.querySelector("#view-options").hasAttribute(
      "data-hub-mobile-nav-view-options",
    ),
    true,
  );
  assert.equal(
    view.document.querySelector("#add-workspace").hasAttribute(
      "data-hub-mobile-nav-view-options",
    ),
    false,
  );
  assert.equal(
    view.document.querySelector("#new-session").hasAttribute(
      "data-hub-mobile-nav-new-session-source",
    ),
    true,
  );
  assert.equal(
    view.document.querySelector("#add-workspace").hasAttribute(
      "data-hub-mobile-nav-add-workspace-source",
    ),
    true,
  );
  assert.equal(
    view.document.querySelector("#main-workspace").hasAttribute(
      "data-hub-mobile-nav-recents-section",
    ),
    true,
  );
  assert.equal(
    view.document.querySelector("#loose-chats").hasAttribute(
      "data-hub-mobile-nav-recents-section",
    ),
    true,
  );
  assert.equal(
    view.document.querySelector("#project-workspace").hasAttribute(
      "data-hub-mobile-nav-workspace-section",
    ),
    true,
  );
  assert.equal(
    view.document.querySelector(
      "[data-hub-mobile-nav-workspaces-label]",
    ),
    null,
  );
  assert.equal(
    view.document.querySelector("#main-workspace-chip").hasAttribute(
      "data-hub-mobile-main-workspace-chip",
    ),
    true,
  );

  const newSession = view.document.querySelector(
    "[data-hub-mobile-nav-footer-new-session]",
  );
  const newWorkspace = view.document.querySelector(
    "[data-hub-mobile-nav-footer-new-workspace]",
  );
  assert.equal(newWorkspace.textContent, "+New workspace");
  assert.equal(newSession.textContent, "+New Session");
  newWorkspace.click();
  newSession.click();
  assert.equal(workspaceStarts, 1);
  assert.equal(mainSessionStarts, 1);
  assert.equal(globalSessionStarts, 0);

  const pinnedPanel = view.document.querySelector(
    "[data-hub-mobile-nav-pinned]",
  );
  const pinnedToggle = view.document.querySelector(
    "[data-hub-mobile-nav-pinned-toggle]",
  );
  const pinCurrent = view.document.querySelector(
    "[data-hub-mobile-nav-pin-current]",
  );
  assert.equal(pinnedToggle.textContent, "›Pinned0");
  assert.equal(pinCurrent.getAttribute("aria-pressed"), "false");
  assert.equal(
    view.document.querySelector(
      "[data-hub-mobile-nav-current-bookmark]",
    ).textContent,
    "☆",
  );
  pinCurrent.click();
  assert.equal(
    pinnedPanel.hasAttribute("data-hub-mobile-nav-pinned-expanded"),
    true,
  );
  assert.deepEqual(
    JSON.parse(
      view.localStorage.getItem("hub.bookmarks.cache.v2"),
    ).pending,
    [{ sessionId: "existing-session", pinned: true }],
  );
  const pinnedSession = view.document.querySelector(
    "[data-hub-mobile-nav-pinned-session]",
  );
  assert.equal(pinnedSession.textContent, "Existing chat");
  assert.equal(
    view.document.querySelector(
      "[data-hub-mobile-nav-current-bookmark]",
    ).textContent,
    "★",
  );
  pinnedToggle.click();
  assert.equal(pinnedToggle.getAttribute("aria-expanded"), "false");
  pinnedToggle.click();
  view.document.querySelector(
    "[data-hub-mobile-nav-pinned-session]",
  ).click();
  await nextFrame(view);
  assert.deepEqual(openedSessions, ["existing-session"]);
  view.document.querySelector(
    "[data-hub-mobile-nav-unpin-session]",
  ).click();
  assert.deepEqual(
    JSON.parse(
      view.localStorage.getItem("hub.bookmarks.cache.v2"),
    ).pending,
    [{ sessionId: "existing-session", pinned: false }],
  );

  runtime.dispose();
  assert.equal(
    view.document.querySelector("#section-label").hasAttribute(
      "data-hub-mobile-nav-section-label",
    ),
    false,
  );
  assert.equal(
    view.document.querySelector("[data-hub-mobile-nav-footer]"),
    null,
  );
  assert.equal(
    view.document.querySelector("[data-hub-mobile-nav-pinned]"),
    null,
  );
  view.close();
});

test("mobile home defaults to the hidden main workspace once", async () => {
  const dom = new JSDOM(`<!doctype html>
    <html data-minke-mobile-web lang="en">
      <body>
        <main id="frame" data-sidebar-collapsed>
          <aside id="sidebar">
            <div data-slot="sidebar"><div>
              <div><button>Toggle</button></div>
              <button id="global-new">New Session</button>
              <div><div data-slot="sidebar.workspaces"><div>
                <div>
                  <span>Workspaces</span>
                  <div><button>Search</button></div>
                  <div><button>View</button><button>Add workspace</button></div>
                </div>
                <div><div role="tree">
                  <div>
                    <span><div role="treeitem" aria-expanded="true">
                      <span>Minke</span><button>Actions</button><button id="main-new">Add</button>
                    </div></span>
                    <div role="treeitem" aria-selected="false">Blank chat</div>
                  </div>
                </div></div>
              </div></div></div>
            </div></div>
          </aside>
          <section id="content">
            <button id="main-chip" aria-haspopup="menu"><span>Minke</span></button>
          </section>
          <section id="details"></section>
          <div data-shell-overlay></div>
        </main>
      </body>
    </html>`, {
    pretendToBeVisual: true,
    url: "https://hub.test/",
  });
  const view = dom.window;
  Object.defineProperty(view, "innerWidth", {
    configurable: true,
    value: 390,
  });
  let globalStarts = 0;
  let mainStarts = 0;
  view.document.querySelector("#global-new").addEventListener(
    "click",
    () => { globalStarts += 1; },
  );
  view.document.querySelector("#main-new").addEventListener(
    "click",
    () => { mainStarts += 1; },
  );
  const runtime = new MobileSidebarDrawerRuntime(
    { toggleSidebar: () => {} },
    {
      getSnapshot: () => ({ current: undefined }),
      subscribe: () => () => {},
    },
    view.document,
  );

  runtime.start();
  await nextFrame(view);
  await nextFrame(view);

  assert.equal(mainStarts, 1);
  assert.equal(globalStarts, 0);
  assert.equal(
    view.document.querySelector("#main-chip").hasAttribute(
      "data-hub-mobile-main-workspace-chip",
    ),
    true,
  );

  runtime.dispose();
  view.close();
});

test("mobile sidebar is a translucent, accessible motion layer", () => {
  assert.match(
    overlayPatch,
    /- id: directory-picker\s+disabled: true/u,
  );
  assert.match(
    overlayPatch,
    /- id: hub-directory-picker-browse\s+name: '@deepseek-ai\/dsh-host-directory-picker-browse'/u,
  );
  assert.match(
    overlayPatch,
    /- id: hub-directory-picker-browse-ui\s+name: '@deepseek-ai\/dsh-client-ui-directory-picker-browse'/u,
  );
  assert.match(styles, /backdrop-filter:\s*blur\(34px\) saturate\(165%\)/u);
  assert.match(styles, /rgb\(8 12 22 \/ 48%\)/u);
  assert.match(styles, /minke-mobile-glass-drift/u);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/u);
  assert.match(styles, /prefers-reduced-transparency:\s*reduce/u);
  assert.match(styles, /touch-action:\s*pan-y/u);
  assert.match(styles, /data-minke-mobile-sidebar-scrim/u);
  assert.match(styles, /data-minke-tabs-layout-actions/u);
  assert.match(styles, /data-hub-mobile-nav-logo-row/u);
  assert.match(styles, /data-hub-mobile-nav-view-options/u);
  assert.match(styles, /data-hub-mobile-nav-new-session-source/u);
  assert.match(styles, /data-hub-mobile-nav-add-workspace-source/u);
  assert.match(styles, /data-hub-mobile-nav-footer-new-workspace/u);
  assert.match(styles, /data-hub-mobile-nav-footer-new-session/u);
  assert.match(styles, /data-hub-mobile-nav-pinned/u);
  assert.match(styles, /data-hub-mobile-nav-pin-current/u);
  assert.match(styles, /data-hub-mobile-nav-pinned-session/u);
  assert.match(styles, /data-hub-mobile-nav-current-bookmark/u);
  assert.match(styles, /data-hub-mobile-main-workspace-chip/u);
  assert.match(styles, /data-hub-mobile-nav-recents-section/u);
  assert.match(
    styles,
    /data-hub-mobile-nav-section-label\]::after\s*\{[\s\S]*content:\s*"Recents"/u,
  );
  assert.match(
    styles,
    /data-hub-mobile-nav-tree\]::after\s*\{[\s\S]*content:\s*"Workspaces"/u,
  );
  assert.match(
    styles,
    /data-minke-mobile-sidebar\][\s\S]*box-sizing:\s*border-box/u,
  );
  assert.match(
    styles,
    /data-minke-mobile-sidebar-edge[\s\S]*width:\s*24px;[\s\S]*touch-action:\s*pan-y/u,
  );
  assert.match(
    styles,
    /data-minke-mobile-details-column[\s\S]*grid-column:\s*3;[\s\S]*width:\s*0 !important;/u,
  );
  const runtime = readFileSync(
    new URL(
      "../packages/harness-overlay/src/client/host/mobile-sidebar-drawer.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    runtime,
    /#onSessionSelection[\s\S]*current === this\.#currentSession[\s\S]*#settle\(false, true\)/u,
  );
  assert.match(
    runtime,
    /#selectionCloseFrame = this\.#view\.requestAnimationFrame[\s\S]*#settle\(false, true\)/u,
  );
  assert.match(
    runtime,
    /this\.#settleTimer = this\.#view\.setTimeout[\s\S]*logicalOpen !== open[\s\S]*toggleSidebar/u,
  );
  assert.match(runtime, /SESSION_SELECTION_SELECTOR/u);
  assert.match(
    runtime,
    /#activateTouchedSession[\s\S]*row\.click\(\)/u,
  );
  assert.match(
    installer,
    /installMobileSidebarDrawerStyles\(\)[\s\S]*installMobileSidebarDrawer\(ctx\.layout, ctx\.sessions\)/u,
  );
});
