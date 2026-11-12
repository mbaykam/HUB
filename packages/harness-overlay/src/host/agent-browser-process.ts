import {
  createAgentBrowserCancelRequest,
  createAgentBrowserClaimControlRequest,
  createAgentBrowserReleaseOwnerRequest,
  createAgentBrowserRequest,
  isAgentBrowserProcessMessage,
  parseAgentBrowserControlChangedEvent,
  parseAgentBrowserProcessResponse,
  type AgentBrowserControlChangedEvent,
  type AgentBrowserClaimControlResult,
  type AgentBrowserOperation,
  type AgentBrowserOperationResult,
  type AgentBrowserProcessRequest,
} from "../agent-browser-contract.ts";
import { HarnessError } from "@deepseek-ai/dsh-llm";

/**
 * The subset of Node's child-process IPC surface used by the Harness-side
 * Agent Browser client. Keeping this structural also makes the transport
 * deterministic to test without starting Electron.
 */
export interface AgentBrowserProcessPort {
  readonly connected?: boolean;
  send?(
    message: AgentBrowserProcessRequest,
    callback?: (error: Error | null) => void,
  ): boolean;
  on(
    event: "message",
    listener: (message: unknown) => void,
  ): unknown;
  on(event: "disconnect", listener: () => void): unknown;
  off(
    event: "message",
    listener: (message: unknown) => void,
  ): unknown;
  off(event: "disconnect", listener: () => void): unknown;
}

interface AgentBrowserParentLifetimeContext {
  effect(
    callback: () => void | (() => void),
    label: string,
  ): unknown;
}

/**
 * Tie the desktop Harness lifecycle to its Electron parent.
 *
 * The Harness process is detached on POSIX so Electron can terminate its
 * complete process group. Without this guard, an ungraceful parent exit would
 * leave the Web server alive as an orphan.
 */
export function installAgentBrowserParentLifetime(
  ctx: AgentBrowserParentLifetimeContext,
  exit: (code: number) => void,
  port: AgentBrowserProcessPort =
    process as unknown as AgentBrowserProcessPort,
): void {
  if (
    typeof port.send !== "function" ||
    port.connected === false
  ) {
    throw new Error(
      "Agent Browser desktop mode requires a connected parent IPC channel",
    );
  }

  ctx.effect(
    () => {
      let active = true;
      let exitRequested = false;
      const onDisconnect = (): void => {
        if (!active || exitRequested) return;
        exitRequested = true;
        exit(1);
      };
      port.on("disconnect", onDisconnect);
      // Close the race between the initial validation and listener install.
      if (port.connected === false) onDisconnect();
      return () => {
        active = false;
        port.off("disconnect", onDisconnect);
      };
    },
    "agent-browser-tools: parent process lifetime",
  );
}

interface PendingRequest {
  readonly operation: AgentBrowserOperation | "claim-control";
  readonly ownerSessionId: string;
  deadline?: ReturnType<typeof setTimeout>;
  cancellationDeadline?: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly resolve: (value: AgentBrowserOperationResult) => void;
  readonly reject: (error: unknown) => void;
  cancelSent: boolean;
}

const activeRequestIds = new Set<number>();
let nextRequestId = 1;

function allocateRequestId(): number {
  const firstCandidate = nextRequestId;
  do {
    const candidate = nextRequestId;
    nextRequestId =
      candidate === Number.MAX_SAFE_INTEGER ? 1 : candidate + 1;
    if (!activeRequestIds.has(candidate)) {
      activeRequestIds.add(candidate);
      return candidate;
    }
  } while (nextRequestId !== firstCandidate);
  throw new Error("Agent Browser request id space is exhausted");
}

function releaseRequestId(requestId: number): void {
  activeRequestIds.delete(requestId);
}

function requestIdFrom(value: unknown): number | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return undefined;
  }
  const requestId = Reflect.get(value, "requestId");
  return Number.isSafeInteger(requestId) &&
      Number(requestId) > 0
    ? Number(requestId)
    : undefined;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const error = new Error(
    reason instanceof Error
      ? reason.message
      : reason === undefined
      ? "Agent Browser request aborted"
      : String(reason),
    reason instanceof Error ? { cause: reason } : undefined,
  );
  error.name = "AbortError";
  return error;
}

/** Structured Harness tool code for a mutation whose outcome is unknown. */
export const AGENT_BROWSER_UNKNOWN_OUTCOME_CODE =
  "AGENT_BROWSER_OUTCOME_UNKNOWN";

function knownRecoveryAdvice(code: string): string | undefined {
  switch (code) {
    case "session_paused":
      return "Human takeover is a terminal control boundary: stop this turn. A later user turn can reclaim the focused tab automatically when it next needs a browser tool.";
    case "control_superseded":
      return "A newer human control intent won. Stop this browser turn; only a later user turn may attempt another automatic claim.";
    case "stale_ref":
    case "snapshot_required":
      return "Do not retry the same ref. Take one fresh browser_snapshot and select a new target from it.";
    case "ambiguous_target":
      return "Do not repeat the call unchanged. Add scope or a more exact semantic constraint; use ordinal only when the user's ordinal clearly applies to that exact action-control match set.";
    case "element_not_found":
      return "Do not repeat the same target unchanged. Observe the current page and revise its scope or semantic constraints.";
    case "element_not_actionable":
    case "element_covered":
    case "element_not_interactable":
      return "Do not retry the same target unchanged. Observe the current page, choose the specific actionable control, and handle any covering element first.";
    case "capability_mismatch":
      return "Do not retry the same action on this ref. Use one of the actions exposed for the current ref, or observe the specific control that supports the requested action.";
    case "index_truncated":
      return "Do not guess the requested position or retry browser_find ordinal on this truncated index. Resolve one unique item without ordinal, or use browser_locate for a live structural position.";
    case "navigation_unavailable":
      return "Do not repeat the unavailable history action. Use the projected history state or choose another navigation action.";
    case "unsupported_key":
      return "Do not repeat the unsupported key. Choose one of the keys documented by browser_press.";
    default:
      return undefined;
  }
}

/**
 * A structured failure returned by Electron's Agent Browser broker.
 *
 * `outcome: "unknown"` is deliberately retained in both data and prose:
 * callers must inspect the tab before retrying a state-changing operation.
 */
export class AgentBrowserProcessError extends HarnessError {
  readonly remoteCode: string;
  readonly outcome: "known" | "unknown";

  constructor(
    code: string,
    message: string,
    outcome: "known" | "unknown",
  ) {
    const recovery = outcome !== "known"
      ? undefined
      : knownRecoveryAdvice(code);
    const guidedMessage = recovery === undefined
      ? message
      : `${message}. ${recovery}`;
    super(
      outcome === "unknown"
        ? `${guidedMessage} (operation outcome is unknown; inspect the browser tab before retrying)`
        : guidedMessage,
      outcome === "unknown"
        ? AGENT_BROWSER_UNKNOWN_OUTCOME_CODE
        : code,
    );
    this.remoteCode = code;
    this.outcome = outcome;
  }
}

function unavailableError(message: string): AgentBrowserProcessError {
  return new AgentBrowserProcessError(
    "agent_browser_unavailable",
    message,
    "known",
  );
}

/**
 * Correlates model-facing tool calls with Electron-main Agent Browser work.
 *
 * Normal cancellation waits for remote quiescence. A missing terminal receipt
 * has a bounded grace period: release and quarantine that owner, report an
 * unknown outcome, and never admit another operation for that owner in this
 * process. An unavailable parent must not keep a stopped turn alive forever.
 */
export class AgentBrowserProcessClient {
  readonly #port: AgentBrowserProcessPort;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #quarantinedOwners = new Set<string>();
  readonly #requestTimeoutMs: number;
  readonly #cancelGraceMs: number;
  readonly #controlListeners =
    new Set<(event: AgentBrowserControlChangedEvent) => void>();
  #disposed = false;
  #listening = false;

  readonly #onMessage = (message: unknown): void => {
    if (!isAgentBrowserProcessMessage(message)) return;
    if (
      typeof message === "object" &&
      message !== null &&
      Reflect.get(message, "type") === "control-changed"
    ) {
      let event: AgentBrowserControlChangedEvent;
      try {
        event = parseAgentBrowserControlChangedEvent(message);
      } catch {
        return;
      }
      for (const listener of this.#controlListeners) {
        try {
          listener(event);
        } catch {
          // A lifecycle observer cannot corrupt request correlation.
        }
      }
      return;
    }
    const requestId = requestIdFrom(message);
    if (requestId === undefined) return;
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;

    try {
      const response = parseAgentBrowserProcessResponse(
        pending.operation,
        message,
      );
      if (response.type === "error") {
        this.#reject(
          requestId,
          new AgentBrowserProcessError(
            response.code,
            response.message,
            response.outcome,
          ),
        );
        return;
      }
      if (pending.signal.aborted) {
        this.#reject(requestId, abortError(pending.signal));
        return;
      }
      this.#resolve(requestId, response.result);
    } catch (error) {
      this.#reject(requestId, error);
    }
  };

  readonly #onDisconnect = (): void => {
    this.#stopListening();
    this.#rejectAll(
      new AgentBrowserProcessError(
        "agent_browser_ipc_disconnected",
        "Agent Browser IPC disconnected while an operation was pending",
        "unknown",
      ),
    );
  };

  constructor(
    port: AgentBrowserProcessPort =
      process as unknown as AgentBrowserProcessPort,
    options: { requestTimeoutMs?: number; cancelGraceMs?: number } = {},
  ) {
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.#cancelGraceMs = options.cancelGraceMs ?? 5_000;
    for (const value of [this.#requestTimeoutMs, this.#cancelGraceMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("Invalid Agent Browser deadline");
    }
    this.#port = port;
    if (
      typeof port.send === "function" &&
      port.connected !== false
    ) {
      port.on("message", this.#onMessage);
      port.on("disconnect", this.#onDisconnect);
      this.#listening = true;
    }
  }

  request(
    ownerSessionId: string,
    operation: AgentBrowserOperation,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<AgentBrowserOperationResult> {
    return this.#dispatch(
      ownerSessionId,
      operation,
      signal,
      (requestId) =>
        createAgentBrowserRequest(
          requestId,
          ownerSessionId,
          operation,
          payload,
        ),
      "Agent Browser IPC failed while sending an operation",
    );
  }

  claimControl(
    ownerSessionId: string,
    sessionId: string,
    expectedControlRevision: number,
    signal: AbortSignal,
  ): Promise<AgentBrowserClaimControlResult> {
    return this.#dispatch(
      ownerSessionId,
      "claim-control",
      signal,
      (requestId) =>
        createAgentBrowserClaimControlRequest(
          requestId,
          ownerSessionId,
          sessionId,
          expectedControlRevision,
        ),
      "Agent Browser IPC failed while claiming control",
    ).then((result) => result as AgentBrowserClaimControlResult);
  }

  #dispatch(
    ownerSessionId: string,
    operation: AgentBrowserOperation | "claim-control",
    signal: AbortSignal,
    createRequest: (
      requestId: number,
    ) => AgentBrowserProcessRequest,
    failureMessage: string,
  ): Promise<AgentBrowserOperationResult> {
    if (this.#quarantinedOwners.has(ownerSessionId)) {
      return Promise.reject(new AgentBrowserProcessError(
        "agent_browser_owner_quarantined",
        "Browser cleanup was not acknowledged. This conversation cannot run browser actions until HUB reconnects its browser process; do not retry or switch tools to repeat the action.",
        "unknown",
      ));
    }
    if (this.#disposed) {
      return Promise.reject(
        unavailableError("Agent Browser process client is disposed"),
      );
    }
    if (
      typeof this.#port.send !== "function" ||
      this.#port.connected === false ||
      !this.#listening
    ) {
      return Promise.reject(
        unavailableError(
          "Agent Browser requires an Electron child-process IPC channel",
        ),
      );
    }
    if (signal.aborted) {
      return Promise.reject(abortError(signal));
    }

    let requestId: number;
    try {
      requestId = allocateRequestId();
    } catch (error) {
      return Promise.reject(error);
    }
    let request: AgentBrowserProcessRequest;
    try {
      request = createRequest(requestId);
    } catch (error) {
      releaseRequestId(requestId);
      return Promise.reject(error);
    }

    return new Promise<AgentBrowserOperationResult>(
      (resolve, reject) => {
        const onAbort = (): void => {
          this.#cancel(requestId);
        };
        this.#pending.set(requestId, {
          operation,
          ownerSessionId,
          signal,
          onAbort,
          resolve,
          reject,
          cancelSent: false,
        });
        const pending = this.#pending.get(requestId)!;
        pending.deadline = setTimeout(() => this.#cancel(requestId), this.#requestTimeoutMs);
        if (this.#requestTimeoutMs >= 1_000) pending.deadline.unref();
        signal.addEventListener("abort", onAbort, { once: true });

        this.#send(
          request,
          requestId,
          failureMessage,
        );
      },
    );
  }

  onControlChanged(
    listener: (event: AgentBrowserControlChangedEvent) => void,
  ): () => void {
    if (this.#disposed) return () => {};
    this.#controlListeners.add(listener);
    return () => {
      this.#controlListeners.delete(listener);
    };
  }

  /**
   * Best-effort one-way owner cleanup used by the Agent disposal lifecycle.
   *
   * The parent retains the owner in its channel ledger if delivery fails, so
   * whole-channel disposal remains the final cleanup backstop.
   */
  releaseOwner(ownerSessionId: string): void {
    const request = createAgentBrowserReleaseOwnerRequest(
      ownerSessionId,
    );
    if (
      this.#disposed ||
      typeof this.#port.send !== "function" ||
      this.#port.connected === false ||
      !this.#listening
    ) {
      return;
    }
    try {
      this.#port.send(request, () => {
        // A lifecycle frame has no response; channel disposal is the backstop.
      });
    } catch {
      // Do not make Agent disposal fail because its parent IPC is already gone.
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const requestId of this.#pending.keys()) {
      this.#sendCancelBestEffort(requestId);
    }
    this.#stopListening();
    this.#controlListeners.clear();
    this.#rejectAll(
      unavailableError("Agent Browser process client was disposed"),
    );
  }

  #send(
    message: AgentBrowserProcessRequest,
    requestId: number,
    failureMessage: string,
  ): void {
    try {
      this.#port.send?.(message, (error) => {
        if (error === null) return;
        this.#reject(
          requestId,
          new AgentBrowserProcessError(
            "agent_browser_ipc_send_failed",
            `${failureMessage}: ${error.message}`,
            "unknown",
          ),
        );
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.#reject(
        requestId,
        new AgentBrowserProcessError(
          "agent_browser_ipc_send_failed",
          `${failureMessage}: ${message}`,
          "unknown",
        ),
      );
    }
  }

  #cancel(requestId: number): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined || pending.cancelSent) return;
    pending.cancelSent = true;
    pending.cancellationDeadline = setTimeout(() => {
      if (!this.#pending.has(requestId)) return;
      this.#quarantinedOwners.add(pending.ownerSessionId);
      this.releaseOwner(pending.ownerSessionId);
      for (const [id, owned] of this.#pending) {
        if (owned.ownerSessionId !== pending.ownerSessionId) continue;
        this.#sendCancelBestEffort(id);
        this.#reject(id, owned.signal.aborted ? abortError(owned.signal) : new AgentBrowserProcessError(
          "agent_browser_terminal_timeout",
          "The browser did not acknowledge cancellation. Cleanup was requested and this conversation's browser actions are blocked. The operation outcome is unknown; do not retry.",
          "unknown",
        ));
      }
    }, this.#cancelGraceMs);
    if (this.#cancelGraceMs >= 1_000) pending.cancellationDeadline.unref();
    const cancel = createAgentBrowserCancelRequest(requestId);
    this.#send(
      cancel,
      requestId,
      "Agent Browser IPC failed while cancelling an operation",
    );
  }

  #sendCancelBestEffort(requestId: number): void {
    const pending = this.#pending.get(requestId);
    if (
      pending === undefined ||
      pending.cancelSent ||
      typeof this.#port.send !== "function" ||
      this.#port.connected === false
    ) {
      return;
    }
    pending.cancelSent = true;
    try {
      this.#port.send(
        createAgentBrowserCancelRequest(requestId),
        () => {
          // Disposal cannot await a parent-process acknowledgement.
        },
      );
    } catch {
      // The operation is rejected below as part of local disposal.
    }
  }

  #resolve(
    requestId: number,
    value: AgentBrowserOperationResult,
  ): void {
    const pending = this.#take(requestId);
    pending?.resolve(value);
  }

  #reject(requestId: number, error: unknown): void {
    const pending = this.#take(requestId);
    pending?.reject(error);
  }

  #take(requestId: number): PendingRequest | undefined {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return undefined;
    this.#pending.delete(requestId);
    clearTimeout(pending.deadline);
    clearTimeout(pending.cancellationDeadline);
    pending.signal.removeEventListener(
      "abort",
      pending.onAbort,
    );
    releaseRequestId(requestId);
    return pending;
  }

  #rejectAll(error: unknown): void {
    for (const requestId of [...this.#pending.keys()]) {
      this.#reject(requestId, error);
    }
  }

  #stopListening(): void {
    if (!this.#listening) return;
    this.#listening = false;
    this.#port.off("message", this.#onMessage);
    this.#port.off("disconnect", this.#onDisconnect);
  }
}
