import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MOBILE_SIDEBAR_FLING_VELOCITY,
  MOBILE_SIDEBAR_OPEN_THRESHOLD,
  clampMobileSidebarProgress,
  mobileSidebarVisuals,
  resolveMobileSidebarOpen,
} from "@minke/harness-overlay/client/host/mobile-sidebar-drawer.ts";

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

test("mobile sidebar is a translucent, accessible motion layer", () => {
  assert.match(styles, /backdrop-filter:\s*blur\(24px\)/u);
  assert.match(styles, /background:\s*rgb\(10 14 24 \/ 68%\)/u);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/u);
  assert.match(styles, /prefers-reduced-transparency:\s*reduce/u);
  assert.match(styles, /touch-action:\s*pan-y/u);
  assert.match(styles, /data-minke-mobile-sidebar-scrim/u);
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
    /SESSION_SELECTION_SELECTOR[\s\S]*target\.closest\(SESSION_SELECTION_SELECTOR\)[\s\S]*#settle\(false, true\)/u,
  );
  assert.match(
    installer,
    /installMobileSidebarDrawerStyles\(\)[\s\S]*installMobileSidebarDrawer\(ctx\.layout\)/u,
  );
});
