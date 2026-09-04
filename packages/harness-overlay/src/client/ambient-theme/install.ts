import type {
  HarnessClientContext,
  HarnessThemeTokenOverrides,
} from "../core/context.ts";
import {
  installAmbientThemeStyles,
} from "./styles.ts";

const AMBIENT_THEME_TOKENS: HarnessThemeTokenOverrides = Object.freeze({
  "--dsw-alias-bg-base": {
    light: "rgb(241 245 250 / 50%)",
    dark: "rgb(8 10 16 / 38%)",
  },
  "--dsw-alias-bg-layer-1": {
    light: "rgb(255 255 255 / 62%)",
    dark: "rgb(19 21 30 / 64%)",
  },
  "--dsw-alias-bg-layer-2": {
    light: "rgb(255 255 255 / 78%)",
    dark: "rgb(28 28 37 / 78%)",
  },
  "--dsw-alias-bg-overlay": {
    light: "rgb(255 255 255 / 92%)",
    dark: "rgb(18 19 27 / 92%)",
  },
  "--dsw-alias-border-l1": {
    light: "rgb(255 255 255 / 68%)",
    dark: "rgb(255 255 255 / 9%)",
  },
  "--dsw-alias-border-l2": {
    light: "rgb(65 78 108 / 17%)",
    dark: "rgb(255 255 255 / 13%)",
  },
  "--dsw-specific-sidebar-fill": {
    light: "rgb(242 247 252 / 64%)",
    dark: "rgb(12 16 24 / 58%)",
  },
});

/** Install Minke's animated screenshot-inspired ambient glass canvas. */
export function installAmbientTheme(
  ctx: HarnessClientContext,
): void {
  ctx.effect(
    () => installAmbientThemeStyles(),
    "minke-overlay: ambient theme styles",
  );
  ctx.effect(
    () =>
      ctx.theme.overrideTokens(
        "@lencx/minke-harness-overlay/ambient-theme",
        AMBIENT_THEME_TOKENS,
      ),
    "minke-overlay: ambient theme tokens",
  );
}
