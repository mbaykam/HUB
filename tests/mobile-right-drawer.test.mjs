import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MOBILE_RIGHT_DRAWER_FLING_VELOCITY,
  MOBILE_RIGHT_DRAWER_OPEN_THRESHOLD,
  clampMobileRightDrawerProgress,
  mobileRightDrawerVisuals,
  resolveMobileRightDrawerOpen,
} from "@minke/harness-overlay/client/host/mobile-right-drawer.ts";

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
const runtime = readFileSync(
  new URL(
    "../packages/harness-overlay/src/client/host/mobile-right-drawer.ts",
    import.meta.url,
  ),
  "utf8",
);

test("mobile right drawer tracks a full-canvas right-edge gesture", () => {
  assert.equal(clampMobileRightDrawerProgress(-1), 0);
  assert.equal(clampMobileRightDrawerProgress(2), 1);
  assert.deepEqual(mobileRightDrawerVisuals(0, 390), {
    contentBrightness: 1,
    contentScale: 1,
    offset: 390,
    progress: 0,
  });
  assert.deepEqual(mobileRightDrawerVisuals(1, 390), {
    contentBrightness: 0.94,
    contentScale: 0.988,
    offset: 0,
    progress: 1,
  });
});

test("mobile right drawer settles by distance or release velocity", () => {
  assert.equal(
    resolveMobileRightDrawerOpen({
      progress: MOBILE_RIGHT_DRAWER_OPEN_THRESHOLD,
      velocity: 0,
      startedOpen: false,
    }),
    true,
  );
  assert.equal(
    resolveMobileRightDrawerOpen({
      progress: 1 - MOBILE_RIGHT_DRAWER_OPEN_THRESHOLD,
      velocity: 0,
      startedOpen: true,
    }),
    false,
  );
  assert.equal(
    resolveMobileRightDrawerOpen({
      progress: 0.1,
      velocity: MOBILE_RIGHT_DRAWER_FLING_VELOCITY,
      startedOpen: false,
    }),
    true,
  );
});

test("mobile right drawer owns Settings and accessible dismissal", () => {
  assert.match(styles, /data-minke-mobile-right-drawer[\s\S]*width:\s*100%/u);
  assert.match(styles, /rgb\(8 12 22 \/ 60%\)/u);
  assert.match(
    styles,
    /data-minke-mobile-right-drawer-open[\s\S]*--minke-mobile-right-drawer-offset:\s*0px/u,
  );
  assert.match(styles, /data-minke-mobile-settings-source[\s\S]*display:\s*none !important/u);
  assert.match(runtime, /SETTINGS_TRIGGER_SELECTOR[\s\S]*source\.click\(\)/u);
  assert.match(runtime, /data-minke-mobile-right-drawer-label/u);
  assert.match(runtime, /data-minke-mobile-settings-open/u);
  assert.match(runtime, /aria-modal[\s\S]*Close panel/u);
  assert.match(
    runtime,
    /drawer\.toggleAttribute\("inert", !open \|\| this\.#settingsOpen\)/u,
  );
  assert.match(
    runtime,
    /#onSettingsClick[\s\S]*#syncSettingsOpen\(true\)[\s\S]*source\.click\(\)/u,
  );
  assert.doesNotMatch(
    runtime,
    /#onSettingsClick[\s\S]{0,240}#settle\(false\)/u,
  );
  assert.match(runtime, /minke:mobile-left-drawer-opening/u);
  assert.match(
    styles,
    /data-minke-mobile-settings-open[\s\S]*role="presentation"[\s\S]*width:\s*100vw/u,
  );
  assert.match(
    styles,
    /role="dialog"[\s\S]*flex-direction:\s*column[\s\S]*overflow-x:\s*auto/u,
  );
  assert.match(
    installer,
    /installMobileSidebarDrawer[\s\S]*installMobileRightDrawer\(\)/u,
  );
});
