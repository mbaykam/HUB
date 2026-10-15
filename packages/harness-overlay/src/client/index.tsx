import { installAbout } from "./about/install.tsx";
import { installAmbientTheme } from "./ambient-theme/install.ts";
import { installBrandlessShell } from "./brand/install.tsx";
import { installBrowserSettings } from "./browser-settings/index.ts";
import type {
  HarnessClientContext,
} from "./core/context.ts";
import { installDataHome } from "./data-home/install.tsx";
import { installDesktopClient } from "./desktop/install.ts";
import { installLocalModel } from "./local-model/install.ts";
import {
  installMinkeSettings,
  MinkeSettingsRuntime,
} from "./minke-settings/index.ts";
import { installOnboarding } from "./onboarding/install.tsx";
import { installPwa } from "./pwa/install.tsx";
import { installRemote } from "./remote/install.tsx";
import { installRemoteHub } from "./remote-hub/install.tsx";
import { installShortcuts } from "./shortcuts/install.tsx";
import { installTabs } from "./tabs/install.tsx";
import { installHubDeepLink } from "./host/hub-deep-link.ts";
import { installCharactersClient } from "./host/mobile-characters.ts";
import {installDesktopRightPanel} from "./host/desktop-right-panel.ts";

/** Cordis services required by this out-of-tree browser plugin. */
export const inject = [
  "connection",
  "remote",
  "remote.pluginInventory",
  "slots",
  "locale",
  "theme",
  "uiWorkspace",
  "sessions",
  "layout",
];

/** Compose HUB features through Harness's public services and slots. */
export function apply(ctx: HarnessClientContext): void {
  const minkeSettings = new MinkeSettingsRuntime();
  installAmbientTheme(ctx);
  installDesktopClient(ctx);
  installAbout(ctx);
  installDataHome(ctx, minkeSettings);
  installBrowserSettings(ctx, minkeSettings);
  installBrandlessShell(ctx);
  installPwa(ctx);
  installLocalModel(ctx);
  const remote = installRemote(ctx);
  installRemoteHub(ctx, remote);
  const tabsRuntimes = installTabs(ctx, minkeSettings);
  ctx.effect(() => installHubDeepLink(ctx), "hub: authenticated Telegram conversation links");
  ctx.effect(() => installCharactersClient(ctx), "hub: character management");
  ctx.effect(()=>installDesktopRightPanel(),"hub: desktop secondary right panel");
  installShortcuts(ctx, tabsRuntimes, minkeSettings);
  installMinkeSettings(ctx, minkeSettings);
  installOnboarding(ctx);
}
