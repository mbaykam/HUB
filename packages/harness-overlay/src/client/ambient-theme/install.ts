import type {
  HarnessClientContext,
  HarnessThemeTokenOverrides,
} from "../core/context.ts";
import { createElement } from "react";
import {
  installAmbientThemeStyles,
} from "./styles.ts";

const AMBIENT_THEME_TOKENS: HarnessThemeTokenOverrides = Object.freeze({
  "--dsw-alias-bg-base": {
    light: "rgb(8 10 16 / 38%)",
    dark: "rgb(8 10 16 / 38%)",
  },
  "--dsw-alias-bg-layer-1": {
    light: "rgb(19 21 30 / 64%)",
    dark: "rgb(19 21 30 / 64%)",
  },
  "--dsw-alias-bg-layer-2": {
    light: "rgb(28 28 37 / 78%)",
    dark: "rgb(28 28 37 / 78%)",
  },
  "--dsw-alias-bg-overlay": {
    light: "rgb(18 19 27 / 92%)",
    dark: "rgb(18 19 27 / 92%)",
  },
  "--dsw-alias-border-l1": {
    light: "rgb(255 255 255 / 9%)",
    dark: "rgb(255 255 255 / 9%)",
  },
  "--dsw-alias-border-l2": {
    light: "rgb(255 255 255 / 13%)",
    dark: "rgb(255 255 255 / 13%)",
  },
  "--dsw-specific-sidebar-fill": {
    light: "rgb(12 16 24 / 58%)",
    dark: "rgb(12 16 24 / 58%)",
  },
});

function GlassAppearance() {
  return createElement("div", { "data-hub-glass-appearance": "" },
    createElement("strong", null, "Appearance"),
    createElement("span", null, "Dark glass"),
    createElement("p", null, "Soft gradients and translucent surfaces."));
}

/** HUB maintains one dark glass palette, independent of the device's theme. */
export function installAmbientTheme(
  ctx: HarnessClientContext,
): void {
  ctx.effect(() => {
    let active = true, pending = false;
    const chooseDark = () => {
      if (!active || pending || ctx.theme.getTheme().preference === "dark") return;
      pending = true;
      // Wait for native theme listeners to finish applying the old snapshot.
      queueMicrotask(() => {
        pending = false;
        if (active && ctx.theme.getTheme().preference !== "dark") ctx.theme.setTheme("dark");
      });
    };
    ctx.on("theme/change", chooseDark);
    chooseDark();
    return () => { active = false; };
  }, "hub: dark glass appearance");
  ctx.slots.inject("settings.general.item", () => ctx.slots.register({
    name: "settings.general.item", id: "appearance", priority: -10, order: 10,
  }, GlassAppearance));
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
