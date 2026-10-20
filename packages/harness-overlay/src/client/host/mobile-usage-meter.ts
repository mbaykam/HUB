import {
  MINKE_USAGE_ROUTE,
  parseMinkeUsageSnapshot,
  type CodexUsage,
  type MinkeUsageSnapshot,
  type OpenRouterUsage,
  type SonioxUsage,
  type UnlidUsage,
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
  if (value > 0 && value < 0.000001) return "<$0.000001";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 10 ? 2 : 3,
    maximumFractionDigits: value >= 10 ? 2 : value < 0.01 ? 6 : 4,
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

function providerState(root: Document, content: HTMLElement, usage: UnlidUsage | SonioxUsage, setup: string): boolean {
  const dot = content.closest("[data-minke-usage-card]")?.querySelector<HTMLElement>("[data-minke-usage-provider-dot]");
  if (dot) dot.dataset.state = usage.state;
  if (usage.state === "ready") return true;
  content.replaceChildren(statusMessage(root, usage.state === "error" ? usage.message : setup, usage.state === "error" ? "warning" : "muted"));
  return false;
}

function renderUnlid(root: Document, content: HTMLDivElement, usage: UnlidUsage): void {
  if (!providerState(root,content,usage,"Unlid is not connected. Add its API key on your HUB host." ) || usage.state !== "ready") return;
  const nodes: HTMLElement[] = [];
  if (usage.account && usage.account.totalCredits > 0) nodes.push(progress(root,"Available credit",usage.available/usage.account.totalCredits*100,`${formatUsd(usage.available)} available`));
  nodes.push(stats(root,[
    {label:"Available",value:formatUsd(usage.available)}, {label:"Reserved",value:formatUsd(usage.held)},
    {label:"Account balance",value:formatUsd(usage.balance)}, {label:"This month",value:formatUsd(usage.usageMonthly)},
    ...(usage.account ? [{label:"Lifetime spend",value:formatUsd(usage.account.totalUsage)}, {label:"Total credits",value:formatUsd(usage.account.totalCredits)}] : []),
  ]), statusMessage(root,"Provider-reported account totals, including usage outside HUB. Reservations are released when requests settle."));
  if (usage.warning) nodes.push(statusMessage(root,usage.warning,"warning"));
  content.replaceChildren(...nodes);
}

function formatAudio(milliseconds: number): string {
  const seconds = milliseconds/1000;
  if (seconds < 60) return `${new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(seconds)} sec`;
  return `${new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(seconds/60)} min`;
}

function renderSoniox(root: Document, content: HTMLDivElement, usage: SonioxUsage): void {
  const expanded = content.querySelector<HTMLDetailsElement>("[data-hub-usage-models]")?.open ?? false;
  if (!providerState(root,content,usage,"Connect Soniox in Settings → Speech to see usage.") || usage.state !== "ready") return;
  const nodes: HTMLElement[] = [stats(root,[
    {label:"Today",value:formatUsd(usage.today.costUsd)}, {label:"Last 7 days",value:formatUsd(usage.last7Days.costUsd)},
    {label:"This month",value:formatUsd(usage.month.costUsd)}, {label:"Monthly requests",value:usage.month.requests.toLocaleString()},
    {label:"Monthly audio input",value:formatAudio(usage.month.inputAudioMs)},
    ...(usage.month.outputAudioMs>0 ? [{label:"Monthly audio output",value:formatAudio(usage.month.outputAudioMs)}] : []),
  ])];
  if (usage.models.length) {
    const models = element(root,"details","data-hub-usage-models"), summary = element(root,"summary");summary.textContent="By model · this month";
    models.open = expanded;
    models.append(summary,stats(root,usage.models.map(m=>({label:m.id,value:`${formatUsd(m.month.costUsd)} · ${m.month.requests.toLocaleString()} requests · ${formatAudio(m.month.inputAudioMs)} input`}))));
    nodes.push(models);
  } else nodes.push(statusMessage(root,"No completed Soniox usage is reported for this month."));
  nodes.push(statusMessage(root,"Project totals use UTC dates and include other apps using this project. Active sessions appear after they finish. For your remaining credit balance, open Soniox billing."));
  const consoleLink = element(root,"a");consoleLink.href="https://console.soniox.com/";consoleLink.target="_blank";consoleLink.rel="noopener noreferrer";consoleLink.textContent="Open Soniox billing";nodes.push(consoleLink);
  content.replaceChildren(...nodes);
}

export class MobileUsageMeterRuntime {
  readonly #root: Document;
  readonly #view: UsageMeterView;
  readonly #container: HTMLElement;
  readonly #section: HTMLElement;
  readonly #toggleButton: HTMLButtonElement;
  readonly #content: HTMLDivElement;
  readonly #codexContent: HTMLDivElement;
  readonly #openRouterContent: HTMLDivElement;
  readonly #unlidContent: HTMLDivElement;
  readonly #sonioxContent: HTMLDivElement;
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
    const toggle = element(root, "button", "data-minke-usage-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", "minke-mobile-usage-content");
    const title = element(root, "span", "data-minke-usage-toggle-label");
    title.textContent = "Usage";
    const chevron = element(root, "span", "data-minke-usage-chevron");
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "⌄";
    toggle.append(title, chevron);
    toggle.addEventListener("click", this.#onToggle);

    const content = element(root, "div", "data-minke-usage-content");
    content.id = "minke-mobile-usage-content";
    content.hidden = true;
    const tools = element(root, "div", "data-minke-usage-tools");
    const summary = element(root, "p");
    summary.textContent = "Limits and spend across your connected providers";
    const refresh = element(root, "button", "data-minke-usage-refresh");
    refresh.type = "button";
    refresh.setAttribute("aria-label", "Refresh usage");
    refresh.title = "Refresh usage";
    refresh.textContent = "↻";
    refresh.addEventListener("click", this.#onRefresh);
    tools.append(summary, refresh);

    const providers = element(root, "div", "data-minke-usage-providers");
    const codex = providerCard(root, "Codex", "Subscription limits");
    const openRouter = providerCard(
      root,
      "OpenRouter",
      "Shared API-key spend",
    );
    const unlid = providerCard(root,"Unlid","Account credits and spend");
    const soniox = providerCard(root,"Soniox","Speech usage · project totals · UTC");
    providers.append(codex.card, openRouter.card, unlid.card, soniox.card);
    const updated = element(root, "p", "data-minke-usage-updated");
    updated.setAttribute("role", "status");
    updated.setAttribute("aria-live", "polite");
    content.append(tools, providers, updated);
    section.append(toggle, content);
    container.replaceChildren(section);

    this.#section = section;
    this.#toggleButton = toggle;
    this.#content = content;
    this.#codexContent = codex.content;
    this.#openRouterContent = openRouter.content;
    this.#unlidContent = unlid.content;
    this.#sonioxContent = soniox.content;
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
    this.#toggleButton.removeEventListener("click", this.#onToggle);
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
    this.#unlidContent.replaceChildren(loading());
    this.#sonioxContent.replaceChildren(loading());
    this.#updated.textContent = "";
  }

  #render(snapshot: MinkeUsageSnapshot): void {
    renderCodex(this.#root, this.#codexContent, snapshot.codex);
    renderOpenRouter(
      this.#root,
      this.#openRouterContent,
      snapshot.openRouter,
    );
    renderUnlid(this.#root,this.#unlidContent,snapshot.unlid);
    renderSoniox(this.#root,this.#sonioxContent,snapshot.soniox);
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
    this.#unlidContent.replaceChildren(failure());
    this.#sonioxContent.replaceChildren(failure());
    this.#updated.textContent = "Pull down the panel or tap refresh to retry.";
  }

  readonly #onRefresh = (): void => {
    void this.refresh();
  };

  #setExpanded(expanded: boolean): void {
    this.#section.toggleAttribute("data-expanded", expanded);
    this.#toggleButton.setAttribute("aria-expanded", String(expanded));
    this.#content.hidden = !expanded;
    if (expanded && Date.now() - this.#lastUpdatedAt >= STALE_AFTER_MS) {
      void this.refresh();
    }
  }

  readonly #onToggle = (): void => {
    this.#setExpanded(
      this.#toggleButton.getAttribute("aria-expanded") !== "true",
    );
  };

  readonly #onDrawerOpening = (): void => {
    this.#setExpanded(false);
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
