import {
  MINKE_USAGE_ROUTE,
  parseMinkeUsageSnapshot,
  type CodexUsage,
  type MinkeUsageSnapshot,
  type OpenRouterUsage,
} from "../../usage-contract.ts";

const REFRESH_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 30_000;
const RIGHT_DRAWER_OPENING_EVENT =
  "minke:mobile-right-drawer-opening";

type UsageMeterView = Window & {
  readonly HTMLElement: typeof HTMLElement;
};

function element<K extends keyof HTMLElementTagNameMap>(
  root: Document,
  tag: K,
  attribute?: string,
): HTMLElementTagNameMap[K] {
  const node = root.createElement(tag);
  if (attribute !== undefined) node.setAttribute(attribute, "");
  return node;
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  }).format(value);
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 10 ? 2 : 3,
    maximumFractionDigits: value >= 10 ? 2 : 4,
  }).format(value);
}

function windowLabel(seconds: number): string {
  if (seconds === 5 * 60 * 60) return "5-hour limit";
  if (seconds === 7 * 24 * 60 * 60) return "Weekly limit";
  const hours = seconds / (60 * 60);
  if (Number.isInteger(hours) && hours < 48) {
    return `${String(hours)}-hour limit`;
  }
  const days = seconds / (24 * 60 * 60);
  if (Number.isInteger(days)) return `${String(days)}-day limit`;
  return "Usage window";
}

function statusMessage(
  root: Document,
  message: string,
  kind: "muted" | "warning" = "muted",
): HTMLParagraphElement {
  const node = element(root, "p", "data-minke-usage-message");
  node.dataset.kind = kind;
  node.textContent = message;
  return node;
}

function progress(
  root: Document,
  label: string,
  remainingPercent: number,
  detail?: string,
): HTMLDivElement {
  const clamped = Math.min(100, Math.max(0, remainingPercent));
  const group = element(root, "div", "data-minke-usage-progress");
  const heading = element(root, "div", "data-minke-usage-progress-label");
  const name = element(root, "span");
  name.textContent = label;
  const remaining = element(root, "span");
  remaining.textContent = `${formatPercent(clamped)}% left`;
  heading.append(name, remaining);

  const track = element(root, "div", "data-minke-usage-progress-track");
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-label", label);
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", String(clamped));
  track.setAttribute(
    "aria-valuetext",
    `${formatPercent(clamped)}% remaining`,
  );
  const fill = element(root, "span", "data-minke-usage-progress-fill");
  fill.style.setProperty("--minke-usage-remaining", `${String(clamped)}%`);
  if (clamped <= 15) fill.dataset.level = "critical";
  else if (clamped <= 35) fill.dataset.level = "low";
  track.append(fill);
  group.append(heading, track);
  if (detail !== undefined) {
    const description = element(root, "p");
    description.textContent = detail;
    group.append(description);
  }
  return group;
}

function providerCard(
  root: Document,
  title: string,
  subtitle: string,
): Readonly<{
  card: HTMLElement;
  content: HTMLDivElement;
}> {
  const card = element(root, "article", "data-minke-usage-card");
  const header = element(root, "header");
  const identity = element(root, "div");
  const heading = element(root, "h3");
  heading.textContent = title;
  const description = element(root, "p");
  description.textContent = subtitle;
  identity.append(heading, description);
  const dot = element(root, "span", "data-minke-usage-provider-dot");
  dot.setAttribute("aria-hidden", "true");
  header.append(identity, dot);
  const content = element(root, "div", "data-minke-usage-card-content");
  card.append(header, content);
  return { card, content };
}

function stats(
  root: Document,
  entries: readonly Readonly<{ label: string; value: string }>[] ,
): HTMLDListElement {
  const list = element(root, "dl", "data-minke-usage-stats");
  for (const entry of entries) {
    const item = element(root, "div");
    const term = element(root, "dt");
    term.textContent = entry.label;
    const value = element(root, "dd");
    value.textContent = entry.value;
    item.append(term, value);
    list.append(item);
  }
  return list;
}

function renderCodex(
  root: Document,
  content: HTMLElement,
  usage: CodexUsage,
): void {
  const card = content.closest<HTMLElement>("[data-minke-usage-card]");
  const dot = card?.querySelector<HTMLElement>(
    "[data-minke-usage-provider-dot]",
  );
  if (dot !== null && dot !== undefined) dot.dataset.state = usage.state;
  if (usage.state === "signed-out") {
    content.replaceChildren(
      statusMessage(root, "Sign in through Codex Connect Plus to see limits."),
    );
    return;
  }
  if (usage.state === "error") {
    content.replaceChildren(
      statusMessage(root, usage.message, "warning"),
    );
    return;
  }
  const nodes: HTMLElement[] = [];
  for (const limit of usage.rateLimits) {
    if (usage.rateLimits.length > 1) {
      const label = element(root, "h4");
      label.textContent = limit.name ?? limit.id;
      nodes.push(label);
    }
    for (const window of limit.windows) {
      nodes.push(
        progress(
          root,
          windowLabel(window.windowSeconds),
          window.remainingPercent,
        ),
      );
    }
  }
  if (usage.individualLimit !== undefined) {
    const limit = Number(usage.individualLimit.limit);
    const remaining = Number(usage.individualLimit.remaining);
    nodes.push(
      progress(
        root,
        "Monthly spend",
        usage.individualLimit.remainingPercent,
        `${formatUsd(remaining)} left of ${formatUsd(limit)}`,
      ),
    );
  }
  if (usage.credits !== undefined) {
    nodes.push(
      stats(root, [
        {
          label: "Credits",
          value: usage.credits.unlimited
            ? "Unlimited"
            : usage.credits.balance === undefined
              ? "Available"
              : usage.credits.balance,
        },
      ]),
    );
  }
  if (nodes.length === 0) {
    nodes.push(statusMessage(root, "Codex did not report usage limits."));
  }
  if (usage.warning !== undefined) {
    nodes.push(statusMessage(root, usage.warning, "warning"));
  }
  content.replaceChildren(...nodes);
}

function renderOpenRouter(
  root: Document,
  content: HTMLElement,
  usage: OpenRouterUsage,
): void {
  const card = content.closest<HTMLElement>("[data-minke-usage-card]");
  const dot = card?.querySelector<HTMLElement>(
    "[data-minke-usage-provider-dot]",
  );
  if (dot !== null && dot !== undefined) dot.dataset.state = usage.state;
  if (usage.state === "not-configured") {
    content.replaceChildren(
      statusMessage(root, "No OpenRouter API key is configured."),
    );
    return;
  }
  if (usage.state === "error") {
    content.replaceChildren(
      statusMessage(root, usage.message, "warning"),
    );
    return;
  }
  const nodes: HTMLElement[] = [];
  if (usage.limit !== undefined) {
    const remainingPercent = usage.limit.amount === 0
      ? 0
      : (usage.limit.remaining / usage.limit.amount) * 100;
    const reset = usage.limit.reset === undefined
      ? ""
      : ` · resets ${usage.limit.reset}`;
    nodes.push(
      progress(
        root,
        "Key spending limit",
        remainingPercent,
        `${formatUsd(usage.limit.remaining)} left of ${formatUsd(usage.limit.amount)}${reset}`,
      ),
    );
  } else {
    nodes.push(statusMessage(root, "No spending cap on this key."));
  }
  nodes.push(
    stats(root, [
      { label: "Today", value: formatUsd(usage.usageDaily) },
      { label: "This week", value: formatUsd(usage.usageWeekly) },
      { label: "This month", value: formatUsd(usage.usageMonthly) },
      { label: "Key total", value: formatUsd(usage.usage) },
    ]),
  );
  if (usage.account !== undefined) {
    const available = Math.max(
      0,
      usage.account.totalCredits - usage.account.totalUsage,
    );
    const remainingPercent = usage.account.totalCredits === 0
      ? 0
      : (available / usage.account.totalCredits) * 100;
    nodes.push(
      progress(
        root,
        "Account credits",
        remainingPercent,
        `${formatUsd(available)} available`,
      ),
    );
  }
  content.replaceChildren(...nodes);
}

export class MobileUsageMeterRuntime {
  readonly #root: Document;
  readonly #view: UsageMeterView;
  readonly #container: HTMLElement;
  readonly #codexContent: HTMLDivElement;
  readonly #openRouterContent: HTMLDivElement;
  readonly #refreshButton: HTMLButtonElement;
  readonly #updated: HTMLParagraphElement;
  #controller: AbortController | undefined;
  #refreshTimer: number | undefined;
  #lastUpdatedAt = 0;
  #disposed = false;

  constructor(container: HTMLElement, root: Document = document) {
    this.#container = container;
    this.#root = root;
    const view = root.defaultView as UsageMeterView | null;
    if (view === null) throw new Error("Mobile usage meter requires a window");
    this.#view = view;

    const section = element(root, "section", "data-minke-usage-meter");
    section.setAttribute("aria-labelledby", "minke-mobile-usage-title");
    const heading = element(root, "div", "data-minke-usage-heading");
    const identity = element(root, "div");
    const title = element(root, "h2");
    title.id = "minke-mobile-usage-title";
    title.textContent = "Usage";
    const summary = element(root, "p");
    summary.textContent = "Limits and spend across your connected providers";
    identity.append(title, summary);
    const refresh = element(root, "button", "data-minke-usage-refresh");
    refresh.type = "button";
    refresh.setAttribute("aria-label", "Refresh usage");
    refresh.title = "Refresh usage";
    refresh.textContent = "↻";
    refresh.addEventListener("click", this.#onRefresh);
    heading.append(identity, refresh);

    const providers = element(root, "div", "data-minke-usage-providers");
    const codex = providerCard(root, "Codex", "Subscription limits");
    const openRouter = providerCard(
      root,
      "OpenRouter",
      "Shared API-key spend",
    );
    providers.append(codex.card, openRouter.card);
    const updated = element(root, "p", "data-minke-usage-updated");
    updated.setAttribute("role", "status");
    updated.setAttribute("aria-live", "polite");
    section.append(heading, providers, updated);
    container.replaceChildren(section);

    this.#codexContent = codex.content;
    this.#openRouterContent = openRouter.content;
    this.#refreshButton = refresh;
    this.#updated = updated;
  }

  start(): void {
    this.#renderLoading();
    this.#root.addEventListener(
      RIGHT_DRAWER_OPENING_EVENT,
      this.#onDrawerOpening,
    );
    void this.refresh();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#root.removeEventListener(
      RIGHT_DRAWER_OPENING_EVENT,
      this.#onDrawerOpening,
    );
    this.#refreshButton.removeEventListener("click", this.#onRefresh);
    this.#controller?.abort();
    if (this.#refreshTimer !== undefined) {
      this.#view.clearTimeout(this.#refreshTimer);
    }
    this.#container.replaceChildren();
  }

  async refresh(): Promise<void> {
    if (this.#disposed || this.#controller !== undefined) return;
    const controller = new AbortController();
    this.#controller = controller;
    this.#refreshButton.disabled = true;
    this.#refreshButton.setAttribute("aria-busy", "true");
    try {
      const response = await this.#view.fetch(MINKE_USAGE_ROUTE, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Usage request failed (${String(response.status)})`);
      }
      const snapshot = parseMinkeUsageSnapshot(await response.json());
      if (!this.#disposed) this.#render(snapshot);
    } catch (error) {
      if (!controller.signal.aborted && !this.#disposed) {
        this.#renderFailure(
          error instanceof Error ? error.message : "Usage is unavailable",
        );
      }
    } finally {
      if (this.#controller === controller) this.#controller = undefined;
      if (!this.#disposed) {
        this.#refreshButton.disabled = false;
        this.#refreshButton.removeAttribute("aria-busy");
        this.#scheduleRefresh();
      }
    }
  }

  #scheduleRefresh(): void {
    if (this.#refreshTimer !== undefined) {
      this.#view.clearTimeout(this.#refreshTimer);
    }
    this.#refreshTimer = this.#view.setTimeout(() => {
      this.#refreshTimer = undefined;
      void this.refresh();
    }, REFRESH_INTERVAL_MS);
  }

  #renderLoading(): void {
    const loading = () => statusMessage(this.#root, "Loading usage…");
    this.#codexContent.replaceChildren(loading());
    this.#openRouterContent.replaceChildren(loading());
    this.#updated.textContent = "";
  }

  #render(snapshot: MinkeUsageSnapshot): void {
    renderCodex(this.#root, this.#codexContent, snapshot.codex);
    renderOpenRouter(
      this.#root,
      this.#openRouterContent,
      snapshot.openRouter,
    );
    this.#lastUpdatedAt = Date.parse(snapshot.updatedAt);
    this.#updated.textContent = `Updated ${new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(this.#lastUpdatedAt)}`;
  }

  #renderFailure(message: string): void {
    const failure = () => statusMessage(this.#root, message, "warning");
    this.#codexContent.replaceChildren(failure());
    this.#openRouterContent.replaceChildren(failure());
    this.#updated.textContent = "Pull down the panel or tap refresh to retry.";
  }

  readonly #onRefresh = (): void => {
    void this.refresh();
  };

  readonly #onDrawerOpening = (): void => {
    if (Date.now() - this.#lastUpdatedAt >= STALE_AFTER_MS) {
      void this.refresh();
    }
  };
}

export function installMobileUsageMeter(
  container: HTMLElement,
  root: Document = document,
): () => void {
  const runtime = new MobileUsageMeterRuntime(container, root);
  runtime.start();
  return () => runtime.dispose();
}
