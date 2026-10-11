import type { ComponentType } from "react";

export type HarnessThemePreference = "light" | "dark" | "system";
export type HarnessColorScheme = "light" | "dark";

/** Native job summaries delivered by the existing session control stream. */
export interface HarnessSessionJob {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly status: "running" | "stopping" | "completed" | "killed" | "failed";
  readonly detail?: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
}

/** Open locale identifier accepted from alpha.2 language-pack plugins. */
export type HarnessLocale = string;

/** Match alpha.2's BCP 47-style LocaleId wire contract. */
export const HARNESS_LOCALE_ID_PATTERN =
  /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

/** Validate locale snapshots before they cross the desktop bridge. */
export function isHarnessLocale(
  value: unknown,
): value is HarnessLocale {
  return (
    typeof value === "string" &&
    HARNESS_LOCALE_ID_PATTERN.test(value)
  );
}

export interface HarnessLocaleSnapshot {
  active: HarnessLocale;
  revision: number;
}

export interface HarnessThemeSnapshot {
  preference: HarnessThemePreference;
  active: {
    colorScheme: HarnessColorScheme;
  };
}

export interface HarnessThemeTokenModes {
  readonly light: string;
  readonly dark: string;
}

export type HarnessThemeTokenOverrides = Readonly<
  Record<string, HarnessThemeTokenModes>
>;

export interface LocaleService {
  register<Key extends string>(
    namespace: string,
    dictionaries: {
      zh: Record<Key, string>;
      en: Record<Key, string>;
    },
  ): () => void;
  bind<Key extends string>(
    namespace: string,
  ): (
    key: Key,
    params?: Record<string, unknown>,
  ) => string;
  getSnapshot(): HarnessLocaleSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface SlotRegistration {
  name: string;
  id?: string;
  key?: string;
  order?: number;
  priority?: number;
  label?: () => string;
  locale?: string;
  inject?: () => unknown;
}

export interface SlotService {
  inject(name: string, callback: () => unknown): () => void;
  register<Props>(
    options: SlotRegistration,
    component: ComponentType<Props>,
  ): () => void;
}

export type HarnessRpcResult =
  | {
    readonly ok: true;
    readonly value: unknown;
  }
  | {
    readonly ok: false;
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly details: unknown;
    };
  };

export interface HarnessRemoteError extends Error {
  readonly code: string;
  readonly details: unknown;
}

export type HarnessRemoteResult =
  | {
    readonly ok: true;
    readonly value: unknown;
  }
  | {
    readonly ok: false;
    readonly error: HarnessRemoteError;
  };

export type HarnessPromptContentPart =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "image";
      readonly mediaType: "image/png";
      readonly data: string;
      readonly name?: string;
    };

export interface HarnessClientScopedContext {
  effect(
    callback: () => void | (() => void),
    label: string,
  ): unknown;
  get(service: string): unknown;
}

/**
 * Public Harness services consumed by the client feature installers.
 *
 * Keeping this structural boundary independent from product features prevents
 * the composition root from accumulating feature-specific overloads.
 */
export interface HarnessClientContext {
  /**
   * Resolve optional services through Cordis' tracked dependency scope.
   * Feature code must not read an optional service directly from the root
   * context because doing so bypasses service lifetime tracking.
   */
  inject?(
    dependencies: readonly string[],
    callback: (scope: HarnessClientScopedContext) => void,
  ): unknown;
  connection: {
    readonly state?: {
      getSnapshot(): "connected" | "disconnected" | "connecting" | undefined;
      subscribe(listener: () => void): () => void;
    };
    rpc: {
      call(
        channel: string,
        endpoint: string,
        payload: unknown,
        signal?: AbortSignal,
      ): Promise<HarnessRpcResult>;
    };
  };
  remote: {
    pluginInventory: {
      list(): Promise<HarnessRemoteResult>;
    };
  };
  effect(
    callback: () => void | (() => void),
    label: string,
  ): unknown;
  locale: LocaleService;
  layout: {
    openDetails(): void;
    closeDetails(): void;
    toggleSidebar(): void;
  };
  slots: SlotService;
  theme: {
    getTheme(): HarnessThemeSnapshot;
    setTheme(preference: HarnessThemePreference): void;
    overrideTokens(
      source: string,
      tokens: HarnessThemeTokenOverrides,
    ): () => void;
  };
  on(
    event: "theme/change",
    listener: (snapshot: HarnessThemeSnapshot) => void,
  ): void;
  on(
    event: "locale/change",
    listener: (snapshot: HarnessLocaleSnapshot) => void,
  ): void;
  uiWorkspace: {
    startSession(workspaceId?: unknown): void;
  };
  sessions: {
    list: {
      getSnapshot(): {
        current: string | undefined;
        byId: Readonly<
          Record<
            string,
            {
              readonly cwd?: string;
              readonly title?: string;
              readonly displayTitle?: string;
              readonly running?: boolean;
              readonly completed?: boolean;
              readonly blank?: boolean;
              readonly updatedAt?: number;
              readonly origin?: string;
              readonly parentId?: string;
            } | undefined
          >
        >;
        readonly phase?: "pending" | "ready";
        readonly jobsBySession?: Readonly<Record<string, readonly HarnessSessionJob[]>>;
        readonly subagentsByParent?: Readonly<Record<string, { readonly entries: readonly { readonly kind: string; readonly id: string; readonly label?: string; readonly activity?: string }[] }>>;
      };
      subscribe(listener: () => void): () => void;
    };
    /** Clear the current selection into Harness's no-session Home view. */
    clear(): void;
    binding(sessionId: string): {
      readonly session: {
        getSnapshot?(): { readonly queue?: readonly unknown[]; readonly lastAgentError?: string | null };
        subscribe?(listener: () => void): () => void;
        prompt(
          content: HarnessPromptContentPart[],
          mode: "queue" | "steer",
          signal?: AbortSignal,
        ): Promise<HarnessRemoteResult>;
      };
      readonly eventSource?: {
        getSnapshot(): { readonly entries: readonly { readonly type: string; readonly event: { readonly type: string; readonly data?: unknown } }[] };
        subscribe(listener: () => void): () => void;
      };
    } | undefined;
    /**
     * Resolve a use-and-discard session scope. Optional for compatibility
     * with older Harness builds that can still accept direct prompts.
     */
    scope?(sessionId: string): unknown;
    open(sessionId: string): void;
    /** Refresh native membership before opening a call admitted outside UI RPC. */
    refresh?(): Promise<void>;
  };
}
