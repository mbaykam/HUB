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
                              <span>Minke</span><button>Actions</button><button>Add</button>
                            </div></span>
                            <div role="treeitem" aria-selected="false">Existing chat</div>
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
          <section id="content"></section>
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

  assert.equal(
    view.document.querySelector("#section-label").textContent,
    "Recents",
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
    ).textContent,
    "Workspaces",
  );

  runtime.dispose();
  assert.equal(
    view.document.querySelector("#section-label").textContent,
    "Workspaces",
  );
  assert.equal(
    view.document.querySelector(
      "[data-hub-mobile-nav-workspaces-label]",
    ),
    null,
  );
  view.close();
});

test("mobile sidebar is a translucent, accessible motion layer", () => {
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
  assert.match(styles, /data-hub-mobile-nav-recents-section/u);
  assert.match(styles, /data-hub-mobile-nav-workspaces-label/u);
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
    /installMobileSidebarDrawerStyles\(\)[\s\S]*installMobileSidebarDrawer\(ctx\.layout, ctx\.sessions\.list\)/u,
  );
});
