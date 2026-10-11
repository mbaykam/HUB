import type {
  RemoteRuntimeSnapshot,
} from "@lencx/minke-remote-access";
import type {
  AgentTurnResult,
} from "@minke/harness-overlay/agent-turn-contract.ts";

const PREVIEW_ROUTE_PATTERN =
  /^\/minke-preview\/[A-Za-z0-9_-]{22}\/$/u;

/** Authenticated navigation target; never includes the Host capability. */
export function hubConversationUrl(sessionId: string, remote: RemoteRuntimeSnapshot, panel?: "models"): string | undefined {
  const origin = stableRemoteOrigin(remote);
  if (!origin || !/^minke-im-(telegram|discord)-[a-f0-9]{32}$/.test(sessionId)) return undefined;
  const url = new URL("/", origin); url.searchParams.set("hubSession", sessionId);
  if (panel) url.searchParams.set("hubPanel", panel);
  return url.href;
}

export interface ExternalAgentTurnPreview {
  readonly title: string;
  readonly url: string;
}

type CompletedAgentTurn = Extract<
  AgentTurnResult,
  { readonly outcome: "completed" }
>;

export type ExternalAgentTurnResult =
  | (
      Omit<CompletedAgentTurn, "previews"> & {
        readonly previews?:
          readonly ExternalAgentTurnPreview[];
      }
    )
  | Exclude<AgentTurnResult, CompletedAgentTurn>;

export function stableRemoteOrigin(
  snapshot: RemoteRuntimeSnapshot,
): URL | undefined {
  const stable =
    snapshot.state === "active" &&
    (
      (
        snapshot.method === "tailscale" &&
        snapshot.transport === "serve"
      ) ||
      (
        snapshot.method === "cloudflare" &&
        snapshot.transport === "access"
      )
    );
  if (!stable || snapshot.url === undefined) return undefined;
  try {
    const origin = new URL(snapshot.url);
    return (
        origin.protocol === "https:" &&
        origin.username === "" &&
        origin.password === "" &&
        origin.pathname === "/" &&
        origin.search === "" &&
        origin.hash === ""
      )
      ? origin
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn private Host capability routes into user-facing links only when the
 * remote origin is stable across desktop restarts.
 */
export function externalizeAgentTurnPreviews(
  result: AgentTurnResult,
  remote: RemoteRuntimeSnapshot,
): ExternalAgentTurnResult {
  if (result.outcome !== "completed") return result;
  const { previews, ...withoutPreviews } = result;
  const origin = stableRemoteOrigin(remote);
  if (origin === undefined || previews === undefined) {
    return withoutPreviews;
  }
  const external = previews.flatMap((preview) => {
    if (!PREVIEW_ROUTE_PATTERN.test(preview.route)) return [];
    return [{
      title: preview.title,
      url: new URL(preview.route, origin).href,
    }];
  });
  return external.length === 0
    ? withoutPreviews
    : {
        ...withoutPreviews,
        previews: external,
      };
}
