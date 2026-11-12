import type { HarnessClientContext } from "../core/context.ts";
export const MOBILE_HOME_NAVIGATION_EVENT = "hub:mobile-home-navigation";

/** Native navigation, independent from hidden/inert sidebar buttons. Clearing
 * selection does not cancel an agent or an active voice connection. */
export function returnToMobileHome(ctx: Pick<HarnessClientContext, "sessions" | "uiWorkspace">,
  root: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  // Home is a navigation boundary, not another layer under an open/dragged
  // drawer. Reset those transient owners before selecting the blank Home seat.
  if (root?.defaultView) root.dispatchEvent(new root.defaultView.Event(MOBILE_HOME_NAVIGATION_EVENT));
  ctx.sessions.clear();
  ctx.uiWorkspace.startSession();
}
