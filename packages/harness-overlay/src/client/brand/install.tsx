import type { ComponentType, ReactElement } from "react";
import type {
  HarnessClientContext,
} from "../core/context.ts";
import {
  installBrandCleanupStyles,
} from "./styles.ts";

const MINKE_BRAND_PRIORITY = -100;

function HeroBrandSuppressionMarker(): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-minke-brand-suppression="hero"
    />
  );
}

function SidebarBrandMarkSuppressionMarker(): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-minke-brand-suppression="sidebar-mark"
    />
  );
}

function SidebarBrandNameSuppressionMarker(): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-minke-brand-suppression="sidebar-name"
    />
  );
}

/** Remove product branding from the desktop and PWA shell. */
export function installBrandlessShell(ctx: HarnessClientContext): void {
  ctx.effect(
    () => installBrandCleanupStyles(),
    "minke-overlay: brandless shell styles",
  );

  ctx.slots.inject("conversation.hero.brand.mark", () =>
    ctx.slots.register(
      {
        name: "conversation.hero.brand.mark",
        priority: MINKE_BRAND_PRIORITY,
      },
      HeroBrandSuppressionMarker as ComponentType<never>,
    )
  );
  ctx.slots.inject("sidebar.brand.mark", () =>
    ctx.slots.register(
      {
        name: "sidebar.brand.mark",
        priority: MINKE_BRAND_PRIORITY,
      },
      SidebarBrandMarkSuppressionMarker as ComponentType<never>,
    )
  );
  ctx.slots.inject("sidebar.brand.name", () =>
    ctx.slots.register(
      {
        name: "sidebar.brand.name",
        priority: MINKE_BRAND_PRIORITY,
      },
      SidebarBrandNameSuppressionMarker as ComponentType<never>,
    ),
  );
}
