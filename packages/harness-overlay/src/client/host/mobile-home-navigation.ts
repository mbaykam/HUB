import type { HarnessClientContext } from "../core/context.ts";

/** Native navigation, independent from hidden/inert sidebar buttons. Clearing
 * selection does not cancel an agent or an active voice connection. */
export function returnToMobileHome(ctx: Pick<HarnessClientContext, "sessions" | "uiWorkspace">): void {
  ctx.sessions.clear();
  ctx.uiWorkspace.startSession();
}
