const MOBILE_SIDEBAR_FRAME_ATTRIBUTE =
  "data-minke-mobile-sidebar-frame";
const MOBILE_SIDEBAR_ATTRIBUTE =
  "data-minke-mobile-sidebar";
const MOBILE_SIDEBAR_CONTENT_ATTRIBUTE =
  "data-minke-mobile-sidebar-content";
const MOBILE_DETAILS_COLUMN_ATTRIBUTE =
  "data-minke-mobile-details-column";
const MOBILE_SIDEBAR_SCRIM_ATTRIBUTE =
  "data-minke-mobile-sidebar-scrim";
const MOBILE_SIDEBAR_EDGE_ATTRIBUTE =
  "data-minke-mobile-sidebar-edge";
const MOBILE_SIDEBAR_OPEN_ATTRIBUTE =
  "data-minke-mobile-sidebar-open";
const MOBILE_SIDEBAR_DRAGGING_ATTRIBUTE =
  "data-minke-mobile-sidebar-dragging";
const MOBILE_NAV_LOGO_ROW_ATTRIBUTE =
  "data-hub-mobile-nav-logo-row";
const MOBILE_NAV_NEW_SESSION_SOURCE_ATTRIBUTE =
  "data-hub-mobile-nav-new-session-source";
const MOBILE_NAV_BROWSER_ATTRIBUTE =
  "data-hub-mobile-nav-browser";
const MOBILE_NAV_SECTION_LABEL_ATTRIBUTE =
  "data-hub-mobile-nav-section-label";
const MOBILE_NAV_VIEW_OPTIONS_ATTRIBUTE =
  "data-hub-mobile-nav-view-options";
const MOBILE_NAV_TREE_ATTRIBUTE =
  "data-hub-mobile-nav-tree";
const MOBILE_NAV_RECENTS_SECTION_ATTRIBUTE =
  "data-hub-mobile-nav-recents-section";
const MOBILE_NAV_RECENTS_HEADER_ATTRIBUTE =
  "data-hub-mobile-nav-recents-header";
const MOBILE_NAV_RECENTS_HEADER_WRAPPER_ATTRIBUTE =
  "data-hub-mobile-nav-recents-header-wrapper";
const MOBILE_NAV_WORKSPACE_SECTION_ATTRIBUTE =
  "data-hub-mobile-nav-workspace-section";
const MOBILE_NAV_ADD_WORKSPACE_SOURCE_ATTRIBUTE =
  "data-hub-mobile-nav-add-workspace-source";
const MOBILE_NAV_FOOTER_ATTRIBUTE =
  "data-hub-mobile-nav-footer";
const MOBILE_NAV_FOOTER_NEW_WORKSPACE_ATTRIBUTE =
  "data-hub-mobile-nav-footer-new-workspace";
const MOBILE_NAV_FOOTER_NEW_SESSION_ATTRIBUTE =
  "data-hub-mobile-nav-footer-new-session";
const MOBILE_NAV_MAIN_WORKSPACE_CHIP_ATTRIBUTE =
  "data-hub-mobile-main-workspace-chip";
const MOBILE_NAV_PINNED_ATTRIBUTE =
  "data-hub-mobile-nav-pinned";
const MOBILE_NAV_PINNED_EXPANDED_ATTRIBUTE =
  "data-hub-mobile-nav-pinned-expanded";
const MOBILE_NAV_PINNED_TOGGLE_ATTRIBUTE =
  "data-hub-mobile-nav-pinned-toggle";
const MOBILE_NAV_PIN_CURRENT_ATTRIBUTE =
  "data-hub-mobile-nav-pin-current";
const MOBILE_NAV_PINNED_LIST_ATTRIBUTE =
  "data-hub-mobile-nav-pinned-list";
const MOBILE_NAV_PINNED_SESSION_ATTRIBUTE =
  "data-hub-mobile-nav-pinned-session";
const MOBILE_NAV_UNPIN_SESSION_ATTRIBUTE =
  "data-hub-mobile-nav-unpin-session";
const MOBILE_NAV_CURRENT_BOOKMARK_ATTRIBUTE =
  "data-hub-mobile-nav-current-bookmark";
const MOBILE_RIGHT_DRAWER_OPEN_ATTRIBUTE =
  "data-minke-mobile-right-drawer-open";
const RIGHT_DRAWER_OPENING_EVENT =
  "minke:mobile-right-drawer-opening";
const LEFT_DRAWER_OPENING_EVENT =
  "minke:mobile-left-drawer-opening";

const MOBILE_WEB_ROOT_SELECTOR = "[data-minke-mobile-web]";
const SIDEBAR_COLLAPSED_ATTRIBUTE = "data-sidebar-collapsed";
const SIDEBAR_SLOT_SELECTOR = ':scope > [data-slot="sidebar"]';
const SHELL_OVERLAY_SELECTOR = "[data-shell-overlay]";
const GESTURE_IGNORE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[role="slider"]',
].join(",");
const SESSION_SELECTION_SELECTOR = '[role="treeitem"][aria-selected]';
const SESSION_NESTED_ACTION_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="menuitem"]',
].join(",");
export const MOBILE_SIDEBAR_BREAKPOINT_PX = 1024;
export const MOBILE_SIDEBAR_EDGE_PX = 24;
export const MOBILE_SIDEBAR_DIRECTION_LOCK_PX = 9;
export const MOBILE_SIDEBAR_OPEN_THRESHOLD = 0.32;
export const MOBILE_SIDEBAR_FLING_VELOCITY = 0.42;

const SETTLE_DURATION_MS = 280;
const CLICK_SUPPRESSION_MS = 450;
const CONTENT_SHIFT_PX = 18;
const CONTENT_SCALE_DELTA = 0.015;
const SCRIM_OPACITY = 0.32;
const SHADOW_OPACITY = 0.32;
const PINNED_SESSIONS_STORAGE_KEY =
  "hub.mobile.pinned-sessions.v1";
const PINNED_EXPANDED_STORAGE_KEY =
  "hub.mobile.pinned-expanded.v1";
const PINNED_VISIBLE_ROW_LIMIT = 4;

interface SidebarLayoutPort {
  toggleSidebar(): void;
}

interface SidebarSessionSelectionPort {
  getSnapshot(): {
    readonly current: string | undefined;
    readonly byId?: Readonly<
      Record<
        string,
        {
          readonly cwd?: string;
          readonly title?: string;
        } | undefined
      >
    >;
  };
  subscribe(listener: () => void): () => void;
}

interface SidebarSessionsPort {
  readonly list: SidebarSessionSelectionPort;
  open(sessionId: string): void;
}

interface SidebarGesture {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly target: Element;
  readonly startedOpen: boolean;
  readonly startX: number;
  readonly startY: number;
  lastAt: number;
  lastX: number;
  logicalOpen: boolean;
  progress: number;
  velocity: number;
  dragging: boolean;
}

type MobileSidebarView = Window & {
  readonly Element: typeof Element;
  readonly HTMLButtonElement: typeof HTMLButtonElement;
  readonly HTMLElement: typeof HTMLElement;
  readonly MutationObserver: typeof MutationObserver;
};

export function clampMobileSidebarProgress(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function resolveMobileSidebarOpen(input: {
  readonly progress: number;
  readonly velocity: number;
  readonly startedOpen: boolean;
}): boolean {
  if (input.velocity >= MOBILE_SIDEBAR_FLING_VELOCITY) return true;
  if (input.velocity <= -MOBILE_SIDEBAR_FLING_VELOCITY) return false;
  return input.startedOpen
    ? input.progress > 1 - MOBILE_SIDEBAR_OPEN_THRESHOLD
    : input.progress >= MOBILE_SIDEBAR_OPEN_THRESHOLD;
}

export function mobileSidebarVisuals(
  progressValue: number,
  drawerWidth: number,
): Readonly<{
  contentScale: number;
  contentShift: number;
  contentBrightness: number;
  contentRadius: number;
  offset: number;
  progress: number;
  scrimOpacity: number;
  shadowOpacity: number;
}> {
  const progress = clampMobileSidebarProgress(progressValue);
  const travel = Math.max(0, drawerWidth);
  return Object.freeze({
    contentBrightness: 1 - 0.08 * progress,
    contentRadius: 18 * progress,
    contentScale: 1 - CONTENT_SCALE_DELTA * progress,
    contentShift: CONTENT_SHIFT_PX * progress,
    offset: progress === 1 ? 0 : -travel * (1 - progress),
    progress,
    scrimOpacity: SCRIM_OPACITY * progress,
    shadowOpacity: SHADOW_OPACITY * progress,
  });
}

function asElement(
  value: EventTarget | null,
  view: MobileSidebarView,
): Element | undefined {
  return value instanceof view.Element ? value : undefined;
}

/** Project an animated, touch-driven drawer over Harness's narrow sidebar. */
export class MobileSidebarDrawerRuntime {
  readonly #root: Document;
  readonly #view: MobileSidebarView;
  readonly #layout: SidebarLayoutPort;
  readonly #sessionSelection: SidebarSessionSelectionPort;
  readonly #observer: MutationObserver;
  #frame: HTMLElement | undefined;
  #sidebar: HTMLElement | undefined;
  #content: HTMLElement | undefined;
  #details: HTMLElement | undefined;
  #edge: HTMLDivElement | undefined;
  #scrim: HTMLDivElement | undefined;
  #gesture: SidebarGesture | undefined;
  #reconcileFrame: number | undefined;
  #selectionCloseFrame: number | undefined;
  #settleTimer: number | undefined;
  #suppressClickUntil = 0;
  #suppressClickTarget: Element | undefined;
  #replayingSessionTap = false;
  #currentSession: string | undefined;
  #unsubscribeSessionSelection: (() => void) | undefined;
  #mainWorkspaceSection: HTMLElement | undefined;
  #mainWorkspaceLabel: string | undefined;
  #mainWorkspaceResolved = false;
  #mainWorkspaceHomeInitialized = false;
  #newSessionSource: HTMLButtonElement | undefined;
  #navigationFooter: HTMLDivElement | undefined;
  #newWorkspaceButton: HTMLButtonElement | undefined;
  #newSessionButton: HTMLButtonElement | undefined;
  #pinnedPanel: HTMLElement | undefined;
  #pinnedSessionIds: string[] = [];
  #pinnedExpanded = false;
  #pinnedRenderKey: string | undefined;
  #openSession: ((sessionId: string) => void) | undefined;
  #disposed = false;

  constructor(
    layout: SidebarLayoutPort,
    sessionSelection: SidebarSessionSelectionPort,
    root: Document = document,
    openSession?: (sessionId: string) => void,
  ) {
    this.#root = root;
    const view = root.defaultView as MobileSidebarView | null;
    if (view === null) {
      throw new Error("Mobile sidebar drawer requires a browser window");
    }
    this.#view = view;
    this.#layout = layout;
    this.#sessionSelection = sessionSelection;
    this.#openSession = openSession;
    this.#currentSession = sessionSelection.getSnapshot().current;
    this.#pinnedSessionIds = this.#readPinnedSessionIds();
    this.#pinnedExpanded = this.#readPinnedExpanded();
    this.#observer = new view.MutationObserver(
      () => this.#scheduleReconcile(),
    );
  }

  start(): void {
    this.#unsubscribeSessionSelection =
      this.#sessionSelection.subscribe(this.#onSessionSelection);
    this.#observer.observe(this.#root.documentElement, {
      attributes: true,
      attributeFilter: [SIDEBAR_COLLAPSED_ATTRIBUTE],
      childList: true,
      subtree: true,
    });
    this.#root.addEventListener(
      "pointerdown",
      this.#onPointerDown,
      { capture: true },
    );
    this.#root.addEventListener(
      "pointermove",
      this.#onPointerMove,
      { capture: true, passive: false },
    );
    this.#root.addEventListener(
      "pointerup",
      this.#onPointerUp,
      { capture: true },
    );
    this.#root.addEventListener(
      "pointercancel",
      this.#onPointerCancel,
      { capture: true },
    );
    this.#root.addEventListener("click", this.#onClick, true);
    this.#root.addEventListener("keydown", this.#onKeyDown, true);
    this.#root.addEventListener(
      RIGHT_DRAWER_OPENING_EVENT,
      this.#onRightDrawerOpening,
    );
    this.#view.addEventListener("resize", this.#scheduleReconcile, {
      passive: true,
    });
    this.#scheduleReconcile();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#observer.disconnect();
    this.#unsubscribeSessionSelection?.();
    this.#unsubscribeSessionSelection = undefined;
    this.#root.removeEventListener(
      "pointerdown",
      this.#onPointerDown,
      true,
    );
    this.#root.removeEventListener(
      "pointermove",
      this.#onPointerMove,
      true,
    );
    this.#root.removeEventListener(
      "pointerup",
      this.#onPointerUp,
      true,
    );
    this.#root.removeEventListener(
      "pointercancel",
      this.#onPointerCancel,
      true,
    );
    this.#root.removeEventListener("click", this.#onClick, true);
    this.#root.removeEventListener("keydown", this.#onKeyDown, true);
    this.#root.removeEventListener(
      RIGHT_DRAWER_OPENING_EVENT,
      this.#onRightDrawerOpening,
    );
    this.#view.removeEventListener("resize", this.#scheduleReconcile);
    if (this.#reconcileFrame !== undefined) {
      this.#view.cancelAnimationFrame(this.#reconcileFrame);
    }
    if (this.#selectionCloseFrame !== undefined) {
      this.#view.cancelAnimationFrame(this.#selectionCloseFrame);
    }
    if (this.#settleTimer !== undefined) {
      this.#view.clearTimeout(this.#settleTimer);
    }
    this.#clearFrame();
  }

  readonly #scheduleReconcile = (): void => {
    if (this.#disposed || this.#reconcileFrame !== undefined) return;
    this.#reconcileFrame = this.#view.requestAnimationFrame(
      this.#reconcile,
    );
  };

  readonly #reconcile = (): void => {
    this.#reconcileFrame = undefined;
    if (this.#disposed) return;
    const overlay = this.#root.querySelector(SHELL_OVERLAY_SELECTOR);
    const frame = overlay?.parentElement;
    if (!(frame instanceof this.#view.HTMLElement)) return;
    if (!this.#enabled()) {
      if (frame === this.#frame) this.#clearFrame();
      return;
    }

    const sidebar = [...frame.children].find((candidate) =>
      candidate.querySelector(SIDEBAR_SLOT_SELECTOR) !== null
    );
    const content = sidebar?.nextElementSibling;
    const details = content?.nextElementSibling;
    if (
      !(sidebar instanceof this.#view.HTMLElement) ||
      !(content instanceof this.#view.HTMLElement) ||
      !(details instanceof this.#view.HTMLElement)
    ) {
      return;
    }

    if (frame !== this.#frame) {
      this.#clearFrame();
      this.#frame = frame;
      this.#sidebar = sidebar;
      this.#content = content;
      this.#details = details;
      frame.setAttribute(MOBILE_SIDEBAR_FRAME_ATTRIBUTE, "");
      sidebar.setAttribute(MOBILE_SIDEBAR_ATTRIBUTE, "");
      content.setAttribute(MOBILE_SIDEBAR_CONTENT_ATTRIBUTE, "");
      details.setAttribute(MOBILE_DETAILS_COLUMN_ATTRIBUTE, "");
      const edge = this.#root.createElement("div");
      edge.setAttribute(MOBILE_SIDEBAR_EDGE_ATTRIBUTE, "");
      edge.setAttribute("aria-hidden", "true");
      frame.append(edge);
      this.#edge = edge;
      const scrim = this.#root.createElement("div");
      scrim.setAttribute(MOBILE_SIDEBAR_SCRIM_ATTRIBUTE, "");
      scrim.setAttribute("aria-hidden", "true");
      scrim.addEventListener("click", this.#onScrimClick);
      frame.append(scrim);
      this.#scrim = scrim;
      this.#mountPinnedPanel(frame);
      this.#mountNavigationFooter(frame);
    }

    this.#decorateNavigation(sidebar);
    this.#renderPinnedPanel();
    this.#decorateCurrentSessionBookmark();

    if (
      !frame.hasAttribute(MOBILE_SIDEBAR_DRAGGING_ATTRIBUTE) &&
      !frame.hasAttribute("data-minke-mobile-sidebar-settling")
    ) {
      this.#syncOpenState(
        !frame.hasAttribute(SIDEBAR_COLLAPSED_ATTRIBUTE),
      );
    }
  };

  #clearFrame(): void {
    const frame = this.#frame;
    const content = this.#content;
    if (frame !== undefined) {
      frame.removeAttribute(MOBILE_SIDEBAR_FRAME_ATTRIBUTE);
      frame.removeAttribute(MOBILE_SIDEBAR_OPEN_ATTRIBUTE);
      frame.removeAttribute(MOBILE_SIDEBAR_DRAGGING_ATTRIBUTE);
      frame.removeAttribute("data-minke-mobile-sidebar-settling");
      this.#clearVisuals(frame);
      frame.style.removeProperty("--hub-mobile-pinned-height");
    }
    this.#sidebar?.removeAttribute(MOBILE_SIDEBAR_ATTRIBUTE);
    this.#details?.removeAttribute(MOBILE_DETAILS_COLUMN_ATTRIBUTE);
    if (content !== undefined) {
      content.removeAttribute(MOBILE_SIDEBAR_CONTENT_ATTRIBUTE);
      if (content.hasAttribute("data-minke-mobile-sidebar-inert")) {
        content.removeAttribute("data-minke-mobile-sidebar-inert");
        content.removeAttribute("inert");
      }
    }
    this.#scrim?.removeEventListener("click", this.#onScrimClick);
    this.#pinnedPanel?.removeEventListener(
      "click",
      this.#onPinnedPanelClick,
    );
    for (const button of this.#root.querySelectorAll(
      `[${MOBILE_NAV_CURRENT_BOOKMARK_ATTRIBUTE}]`,
    )) {
      if (button instanceof this.#view.HTMLButtonElement) {
        button.removeEventListener(
          "click",
          this.#onCurrentBookmarkClick,
        );
      }
      button.remove();
    }
    this.#newSessionButton?.removeEventListener(
      "click",
      this.#onNewSessionClick,
    );
    this.#newWorkspaceButton?.removeEventListener(
      "click",
      this.#onNewWorkspaceClick,
    );
    this.#edge?.remove();
    this.#scrim?.remove();
    this.#pinnedPanel?.remove();
    this.#navigationFooter?.remove();
    this.#clearNavigationDecoration();
    this.#frame = undefined;
    this.#sidebar = undefined;
    this.#content = undefined;
    this.#details = undefined;
    this.#edge = undefined;
    this.#scrim = undefined;
    this.#mainWorkspaceSection = undefined;
    this.#mainWorkspaceLabel = undefined;
    this.#mainWorkspaceResolved = false;
    this.#mainWorkspaceHomeInitialized = false;
    this.#newSessionSource = undefined;
    this.#navigationFooter = undefined;
    this.#newWorkspaceButton = undefined;
    this.#newSessionButton = undefined;
    this.#pinnedPanel = undefined;
    this.#pinnedRenderKey = undefined;
    this.#gesture = undefined;
    this.#suppressClickTarget = undefined;
    this.#suppressClickUntil = 0;
  }

  /**
   * Present the mobile sidebar as an unnamed Recents area followed by named
   * project folders. This is deliberately a DOM projection: Harness keeps
   * the original Workspace/session ownership, so organizing the sidebar does
   * not create an AI context boundary.
   */
  #decorateNavigation(sidebar: HTMLElement): void {
    const sidebarSlot = sidebar.querySelector(SIDEBAR_SLOT_SELECTOR);
    const sidebarRoot = sidebarSlot?.firstElementChild;
    if (!(sidebarRoot instanceof this.#view.HTMLElement)) return;

    const logoRow = sidebarRoot.firstElementChild;
    if (logoRow instanceof this.#view.HTMLElement) {
      this.#markOnly(MOBILE_NAV_LOGO_ROW_ATTRIBUTE, logoRow);
    }

    const newSessionSource = sidebarRoot.querySelector(
      ":scope > button",
    );
    if (newSessionSource instanceof this.#view.HTMLButtonElement) {
      this.#markOnly(
        MOBILE_NAV_NEW_SESSION_SOURCE_ATTRIBUTE,
        newSessionSource,
      );
      this.#newSessionSource = newSessionSource;
    }

    const workspaceSlot = sidebarRoot.querySelector(
      '[data-slot="sidebar.workspaces"]',
    );
    const browser = workspaceSlot?.firstElementChild;
    if (!(browser instanceof this.#view.HTMLElement)) return;
    browser.setAttribute(MOBILE_NAV_BROWSER_ATTRIBUTE, "");

    const sectionHeader = browser.firstElementChild;
    if (sectionHeader instanceof this.#view.HTMLElement) {
      const sectionLabel = sectionHeader.firstElementChild;
      if (sectionLabel instanceof this.#view.HTMLElement) {
        this.#markOnly(
          MOBILE_NAV_SECTION_LABEL_ATTRIBUTE,
          sectionLabel,
        );
      }

      const actionButtons = [
        ...sectionHeader.querySelectorAll("button"),
      ];
      // Search is the first header button. When both trailing actions exist,
      // the penultimate one is the grouping/filter menu and the last is Add.
      if (actionButtons.length >= 3) {
        this.#markOnly(
          MOBILE_NAV_VIEW_OPTIONS_ATTRIBUTE,
          actionButtons.at(-2),
        );
      } else {
        this.#markOnly(MOBILE_NAV_VIEW_OPTIONS_ATTRIBUTE);
      }
      const addWorkspaceSource = actionButtons.at(-1);
      if (addWorkspaceSource instanceof this.#view.HTMLButtonElement) {
        this.#markOnly(
          MOBILE_NAV_ADD_WORKSPACE_SOURCE_ATTRIBUTE,
          addWorkspaceSource,
        );
      }
    }

    this.#updateNavigationFooter();

    const tree = browser.querySelector('[role="tree"]');
    if (!(tree instanceof this.#view.HTMLElement)) return;
    tree.setAttribute(MOBILE_NAV_TREE_ATTRIBUTE, "");

    const groupSections = [...tree.children].filter(
      (candidate): candidate is HTMLElement =>
        candidate instanceof this.#view.HTMLElement &&
        this.#groupHeader(candidate) !== undefined,
    );
    if (groupSections.length === 0) {
      return;
    }

    const ungroupedSections = groupSections.filter((section) => {
      const header = this.#groupHeader(section);
      return header !== undefined && header.parentElement === section;
    });
    const namedSections = groupSections.filter(
      (section) => !ungroupedSections.includes(section),
    );

    if (
      this.#mainWorkspaceSection !== undefined &&
      !namedSections.includes(this.#mainWorkspaceSection)
    ) {
      this.#mainWorkspaceSection = undefined;
      this.#mainWorkspaceLabel = undefined;
      this.#mainWorkspaceResolved = false;
    }
    if (!this.#mainWorkspaceResolved && namedSections.length > 0) {
      this.#mainWorkspaceSection =
        namedSections.find((section) => {
          const label = this.#groupLabel(section)?.toLocaleLowerCase();
          return label === "minke" || label === "hub";
        }) ?? namedSections[0];
      this.#mainWorkspaceLabel = this.#groupLabel(
        this.#mainWorkspaceSection,
      );
      this.#mainWorkspaceResolved = true;
    } else if (
      !this.#mainWorkspaceResolved &&
      ungroupedSections.length > 0
    ) {
      // A profile that begins with loose chats has no hidden default
      // Workspace. Resolve that shape now so its first future project remains
      // a named folder instead of being silently promoted to the default.
      this.#mainWorkspaceResolved = true;
    }

    const recentsSections = new Set<HTMLElement>(ungroupedSections);
    if (this.#mainWorkspaceSection !== undefined) {
      recentsSections.add(this.#mainWorkspaceSection);
    }
    for (const section of groupSections) {
      const isRecents = recentsSections.has(section);
      section.toggleAttribute(
        MOBILE_NAV_RECENTS_SECTION_ATTRIBUTE,
        isRecents,
      );
      section.toggleAttribute(
        MOBILE_NAV_WORKSPACE_SECTION_ATTRIBUTE,
        !isRecents,
      );
      const header = this.#groupHeader(section);
      if (header === undefined) continue;
      const hasVisibleSessions = section.querySelector(
        '[role="treeitem"][aria-selected]',
      ) !== null;
      header.toggleAttribute(
        MOBILE_NAV_RECENTS_HEADER_ATTRIBUTE,
        isRecents && hasVisibleSessions,
      );
      const wrapper = header.parentElement;
      if (wrapper !== null && wrapper !== section) {
        wrapper.toggleAttribute(
          MOBILE_NAV_RECENTS_HEADER_WRAPPER_ATTRIBUTE,
          isRecents && hasVisibleSessions,
        );
      }
    }
    this.#initializeMainWorkspaceHome();
    this.#decorateMainWorkspaceChip();
  }

  #groupLabel(section: HTMLElement): string | undefined {
    const header = this.#groupHeader(section);
    if (header === undefined) return undefined;
    for (const candidate of header.querySelectorAll("span")) {
      const label = candidate.textContent?.trim();
      if (label !== undefined && label !== "") return label;
    }
    const label = header.textContent?.trim();
    return label === undefined || label === "" ? undefined : label;
  }

  #markOnly(attribute: string, target?: Element): void {
    for (const candidate of this.#root.querySelectorAll(`[${attribute}]`)) {
      if (candidate !== target) candidate.removeAttribute(attribute);
    }
    target?.setAttribute(attribute, "");
  }

  #groupHeader(section: HTMLElement): HTMLElement | undefined {
    const header = section.querySelector(
      ':scope > [role="treeitem"][aria-expanded], ' +
        ':scope > span > [role="treeitem"][aria-expanded]',
    );
    return header instanceof this.#view.HTMLElement
      ? header
      : undefined;
  }

  #clearNavigationDecoration(): void {
    for (const attribute of [
      MOBILE_NAV_LOGO_ROW_ATTRIBUTE,
      MOBILE_NAV_NEW_SESSION_SOURCE_ATTRIBUTE,
      MOBILE_NAV_BROWSER_ATTRIBUTE,
      MOBILE_NAV_SECTION_LABEL_ATTRIBUTE,
      MOBILE_NAV_VIEW_OPTIONS_ATTRIBUTE,
      MOBILE_NAV_TREE_ATTRIBUTE,
      MOBILE_NAV_RECENTS_SECTION_ATTRIBUTE,
      MOBILE_NAV_RECENTS_HEADER_ATTRIBUTE,
      MOBILE_NAV_RECENTS_HEADER_WRAPPER_ATTRIBUTE,
      MOBILE_NAV_WORKSPACE_SECTION_ATTRIBUTE,
      MOBILE_NAV_ADD_WORKSPACE_SOURCE_ATTRIBUTE,
      MOBILE_NAV_MAIN_WORKSPACE_CHIP_ATTRIBUTE,
    ]) {
      for (const element of this.#root.querySelectorAll(`[${attribute}]`)) {
        element.removeAttribute(attribute);
      }
    }
  }

  #mountNavigationFooter(frame: HTMLElement): void {
    const footer = this.#root.createElement("div");
    footer.setAttribute(MOBILE_NAV_FOOTER_ATTRIBUTE, "");

    const newWorkspace = this.#root.createElement("button");
    newWorkspace.type = "button";
    newWorkspace.setAttribute(MOBILE_NAV_FOOTER_NEW_WORKSPACE_ATTRIBUTE, "");
    const workspaceIcon = this.#root.createElement("span");
    workspaceIcon.setAttribute("aria-hidden", "true");
    workspaceIcon.textContent = "+";
    const workspaceLabel = this.#root.createElement("span");
    newWorkspace.append(workspaceIcon, workspaceLabel);
    newWorkspace.addEventListener("click", this.#onNewWorkspaceClick);

    const newSession = this.#root.createElement("button");
    newSession.type = "button";
    newSession.setAttribute(MOBILE_NAV_FOOTER_NEW_SESSION_ATTRIBUTE, "");
    const sessionIcon = this.#root.createElement("span");
    sessionIcon.setAttribute("aria-hidden", "true");
    sessionIcon.textContent = "+";
    const sessionLabel = this.#root.createElement("span");
    newSession.append(sessionIcon, sessionLabel);
    newSession.addEventListener("click", this.#onNewSessionClick);

    footer.append(newWorkspace, newSession);
    frame.append(footer);
    this.#navigationFooter = footer;
    this.#newWorkspaceButton = newWorkspace;
    this.#newSessionButton = newSession;
    this.#updateNavigationFooter();
  }

  #updateNavigationFooter(): void {
    const newWorkspaceLabel = this.#navigationLabel(
      "New workspace",
      "新建工作区",
    );
    if (this.#newWorkspaceButton !== undefined) {
      this.#newWorkspaceButton.lastElementChild!.textContent =
        newWorkspaceLabel;
      this.#newWorkspaceButton.setAttribute(
        "aria-label",
        newWorkspaceLabel,
      );
      const source = this.#root.querySelector(
        `[${MOBILE_NAV_ADD_WORKSPACE_SOURCE_ATTRIBUTE}]`,
      );
      this.#newWorkspaceButton.disabled =
        !(source instanceof this.#view.HTMLButtonElement) || source.disabled;
    }

    const newSessionLabel = this.#navigationLabel(
      "New Session",
      "新建会话",
    );
    if (this.#newSessionButton !== undefined) {
      this.#newSessionButton.lastElementChild!.textContent =
        newSessionLabel;
      this.#newSessionButton.setAttribute(
        "aria-label",
        newSessionLabel,
      );
      this.#newSessionButton.disabled =
        this.#newSessionSource === undefined ||
        this.#newSessionSource.disabled;
    }
  }

  #navigationLabel(english: string, chinese: string): string {
    return this.#root.documentElement.lang
      .toLocaleLowerCase()
      .startsWith("zh")
      ? chinese
      : english;
  }

  #readPinnedSessionIds(): string[] {
    try {
      const stored = this.#view.localStorage.getItem(
        PINNED_SESSIONS_STORAGE_KEY,
      );
      if (stored === null) return [];
      const parsed: unknown = JSON.parse(stored);
      if (!Array.isArray(parsed)) return [];
      return [...new Set(parsed.filter(
        (value): value is string =>
          typeof value === "string" && value !== "",
      ))];
    } catch {
      return [];
    }
  }

  #readPinnedExpanded(): boolean {
    try {
      return this.#view.localStorage.getItem(
        PINNED_EXPANDED_STORAGE_KEY,
      ) === "true";
    } catch {
      return false;
    }
  }

  #persistPinnedSessions(): void {
    try {
      this.#view.localStorage.setItem(
        PINNED_SESSIONS_STORAGE_KEY,
        JSON.stringify(this.#pinnedSessionIds),
      );
      this.#view.localStorage.setItem(
        PINNED_EXPANDED_STORAGE_KEY,
        String(this.#pinnedExpanded),
      );
    } catch {
      // Pinning remains available for this runtime when storage is blocked.
    }
  }

  #mountPinnedPanel(frame: HTMLElement): void {
    const panel = this.#root.createElement("section");
    panel.setAttribute(MOBILE_NAV_PINNED_ATTRIBUTE, "");

    const header = this.#root.createElement("div");
    const toggle = this.#root.createElement("button");
    toggle.type = "button";
    toggle.setAttribute(MOBILE_NAV_PINNED_TOGGLE_ATTRIBUTE, "");
    const chevron = this.#root.createElement("span");
    chevron.setAttribute("aria-hidden", "true");
    const label = this.#root.createElement("span");
    const count = this.#root.createElement("span");
    count.setAttribute("aria-hidden", "true");
    toggle.append(chevron, label, count);

    const pinCurrent = this.#root.createElement("button");
    pinCurrent.type = "button";
    pinCurrent.setAttribute(MOBILE_NAV_PIN_CURRENT_ATTRIBUTE, "");

    const list = this.#root.createElement("div");
    list.setAttribute(MOBILE_NAV_PINNED_LIST_ATTRIBUTE, "");
    header.append(toggle, pinCurrent);
    panel.append(header, list);
    panel.addEventListener("click", this.#onPinnedPanelClick);
    frame.append(panel);
    this.#pinnedPanel = panel;
    this.#renderPinnedPanel();
  }

  #renderPinnedPanel(): void {
    const panel = this.#pinnedPanel;
    if (panel === undefined) return;
    const snapshot = this.#sessionSelection.getSnapshot();
    const byId = snapshot.byId ?? {};
    const available = this.#pinnedSessionIds.flatMap((sessionId) => {
      const session = byId[sessionId];
      return session === undefined ? [] : [{ sessionId, session }];
    });
    const current = snapshot.current;
    const currentPinned =
      current !== undefined && this.#pinnedSessionIds.includes(current);
    const renderKey = JSON.stringify({
      available: available.map(({ sessionId, session }) => [
        sessionId,
        session.title,
        session.cwd,
      ]),
      current,
      currentPinned,
      expanded: this.#pinnedExpanded,
      lang: this.#root.documentElement.lang,
    });
    if (renderKey === this.#pinnedRenderKey) return;
    this.#pinnedRenderKey = renderKey;

    panel.toggleAttribute(
      MOBILE_NAV_PINNED_EXPANDED_ATTRIBUTE,
      this.#pinnedExpanded,
    );
    const toggle = panel.querySelector(
      `[${MOBILE_NAV_PINNED_TOGGLE_ATTRIBUTE}]`,
    );
    if (toggle instanceof this.#view.HTMLButtonElement) {
      toggle.setAttribute(
        "aria-expanded",
        String(this.#pinnedExpanded),
      );
      toggle.setAttribute(
        "aria-label",
        this.#navigationLabel(
          this.#pinnedExpanded
            ? "Collapse pinned sessions"
            : "Expand pinned sessions",
          this.#pinnedExpanded
            ? "收起已固定会话"
            : "展开已固定会话",
        ),
      );
      const [chevron, label, count] = toggle.children;
      if (chevron !== undefined) {
        chevron.textContent = this.#pinnedExpanded ? "⌄" : "›";
      }
      if (label !== undefined) {
        label.textContent = this.#navigationLabel("Pinned", "已固定");
      }
      if (count !== undefined) {
        count.textContent = String(available.length);
      }
    }

    const pinCurrent = panel.querySelector(
      `[${MOBILE_NAV_PIN_CURRENT_ATTRIBUTE}]`,
    );
    if (pinCurrent instanceof this.#view.HTMLButtonElement) {
      const canPin = current !== undefined && byId[current] !== undefined;
      pinCurrent.disabled = !canPin;
      pinCurrent.textContent = currentPinned ? "★" : "☆";
      pinCurrent.setAttribute("aria-pressed", String(currentPinned));
      pinCurrent.setAttribute(
        "aria-label",
        this.#navigationLabel(
          currentPinned
            ? "Unpin current session"
            : "Pin current session",
          currentPinned ? "取消固定当前会话" : "固定当前会话",
        ),
      );
    }

    const list = panel.querySelector(
      `[${MOBILE_NAV_PINNED_LIST_ATTRIBUTE}]`,
    );
    if (!(list instanceof this.#view.HTMLElement)) return;
    const children: HTMLElement[] = [];
    if (available.length === 0) {
      const empty = this.#root.createElement("p");
      empty.textContent = this.#navigationLabel(
        "No pinned sessions",
        "暂无已固定会话",
      );
      children.push(empty);
    } else {
      for (const { sessionId, session } of available) {
        const row = this.#root.createElement("div");
        const open = this.#root.createElement("button");
        open.type = "button";
        open.setAttribute(MOBILE_NAV_PINNED_SESSION_ATTRIBUTE, sessionId);
        open.textContent = this.#sessionTitle(session);
        const unpin = this.#root.createElement("button");
        unpin.type = "button";
        unpin.setAttribute(MOBILE_NAV_UNPIN_SESSION_ATTRIBUTE, sessionId);
        unpin.textContent = "★";
        unpin.setAttribute(
          "aria-label",
          this.#navigationLabel(
            `Unpin ${open.textContent}`,
            `取消固定 ${open.textContent}`,
          ),
        );
        row.append(open, unpin);
        children.push(row);
      }
    }
    list.replaceChildren(...children);

    const visibleRows = this.#pinnedExpanded
      ? Math.min(
          Math.max(available.length, 1),
          PINNED_VISIBLE_ROW_LIMIT,
        )
      : 0;
    const panelHeight = this.#pinnedExpanded
      ? 48 + visibleRows * 36
      : 44;
    this.#frame?.style.setProperty(
      "--hub-mobile-pinned-height",
      `${String(panelHeight)}px`,
    );
  }

  #sessionTitle(session: {
    readonly cwd?: string;
    readonly title?: string;
  }): string {
    const title = session.title?.trim();
    if (title !== undefined && title !== "") return title;
    return this.#navigationLabel("New Session", "新建会话");
  }

  #togglePinnedSession(sessionId: string): void {
    const index = this.#pinnedSessionIds.indexOf(sessionId);
    if (index === -1) {
      this.#pinnedSessionIds = [
        sessionId,
        ...this.#pinnedSessionIds,
      ];
      this.#pinnedExpanded = true;
    } else {
      this.#pinnedSessionIds = this.#pinnedSessionIds.filter(
        (candidate) => candidate !== sessionId,
      );
    }
    this.#persistPinnedSessions();
    this.#pinnedRenderKey = undefined;
    this.#renderPinnedPanel();
    this.#decorateCurrentSessionBookmark();
  }

  #decorateCurrentSessionBookmark(): void {
    const selected = this.#root.querySelector(
      `${SESSION_SELECTION_SELECTOR}[aria-selected="true"]`,
    );
    const selectedRow =
      selected instanceof this.#view.HTMLElement &&
      !(selected instanceof this.#view.HTMLButtonElement)
        ? selected
        : undefined;
    for (const candidate of this.#root.querySelectorAll(
      `[${MOBILE_NAV_CURRENT_BOOKMARK_ATTRIBUTE}]`,
    )) {
      if (candidate.parentElement === selectedRow) continue;
      if (candidate instanceof this.#view.HTMLButtonElement) {
        candidate.removeEventListener(
          "click",
          this.#onCurrentBookmarkClick,
        );
      }
      candidate.remove();
    }
    const current = this.#currentSession;
    if (selectedRow === undefined || current === undefined) return;
    let button = selectedRow.querySelector(
      `[${MOBILE_NAV_CURRENT_BOOKMARK_ATTRIBUTE}]`,
    );
    if (!(button instanceof this.#view.HTMLButtonElement)) {
      const created = this.#root.createElement("button");
      created.type = "button";
      created.setAttribute(MOBILE_NAV_CURRENT_BOOKMARK_ATTRIBUTE, "");
      created.addEventListener("click", this.#onCurrentBookmarkClick);
      selectedRow.append(created);
      button = created;
    }
    if (!(button instanceof this.#view.HTMLButtonElement)) return;
    const pinned = this.#pinnedSessionIds.includes(current);
    button.textContent = pinned ? "★" : "☆";
    button.setAttribute("aria-pressed", String(pinned));
    button.setAttribute(
      "aria-label",
      this.#navigationLabel(
        pinned ? "Unpin this session" : "Pin this session",
        pinned ? "取消固定此会话" : "固定此会话",
      ),
    );
  }

  #decorateMainWorkspaceChip(): void {
    for (const chip of this.#root.querySelectorAll(
      `[${MOBILE_NAV_MAIN_WORKSPACE_CHIP_ATTRIBUTE}]`,
    )) {
      chip.removeAttribute(MOBILE_NAV_MAIN_WORKSPACE_CHIP_ATTRIBUTE);
    }
    const mainLabel = this.#mainWorkspaceLabel?.toLocaleLowerCase();
    if (mainLabel === undefined) return;
    for (const candidate of this.#root.querySelectorAll(
      'button[aria-haspopup="menu"]',
    )) {
      const label = candidate.textContent?.trim().toLocaleLowerCase();
      if (label === mainLabel) {
        candidate.setAttribute(
          MOBILE_NAV_MAIN_WORKSPACE_CHIP_ATTRIBUTE,
          "",
        );
      }
    }
  }

  #initializeMainWorkspaceHome(): void {
    if (
      this.#mainWorkspaceHomeInitialized ||
      this.#mainWorkspaceSection === undefined
    ) {
      return;
    }
    this.#mainWorkspaceHomeInitialized = true;
    if (this.#currentSession === undefined) {
      this.#startMainWorkspaceSession();
    }
  }

  #startMainWorkspaceSession(): boolean {
    const header = this.#mainWorkspaceSection === undefined
      ? undefined
      : this.#groupHeader(this.#mainWorkspaceSection);
    const mainWorkspaceNewSession = header === undefined
      ? undefined
      : [...header.querySelectorAll("button")].at(-1);
    if (
      !(mainWorkspaceNewSession instanceof this.#view.HTMLButtonElement) ||
      mainWorkspaceNewSession.disabled
    ) {
      return false;
    }
    mainWorkspaceNewSession.click();
    return true;
  }

  #enabled(): boolean {
    return (
      this.#root.documentElement.matches(MOBILE_WEB_ROOT_SELECTOR) &&
      this.#view.innerWidth < MOBILE_SIDEBAR_BREAKPOINT_PX
    );
  }

  #drawerWidth(): number {
    return Math.max(
      1,
      this.#sidebar?.getBoundingClientRect().width ?? 280,
    );
  }

  #syncOpenState(open: boolean): void {
    const frame = this.#frame;
    const content = this.#content;
    if (frame === undefined || content === undefined) return;
    frame.toggleAttribute(MOBILE_SIDEBAR_OPEN_ATTRIBUTE, open);
    this.#navigationFooter?.toggleAttribute("inert", !open);
    this.#navigationFooter?.setAttribute(
      "aria-hidden",
      open ? "false" : "true",
    );
    if (open) {
      if (!content.hasAttribute("inert")) {
        content.setAttribute("inert", "");
        content.setAttribute("data-minke-mobile-sidebar-inert", "");
      }
    } else if (content.hasAttribute("data-minke-mobile-sidebar-inert")) {
      content.removeAttribute("data-minke-mobile-sidebar-inert");
      content.removeAttribute("inert");
    }
  }

  #applyVisuals(progress: number): void {
    const frame = this.#frame;
    if (frame === undefined) return;
    const values = mobileSidebarVisuals(
      progress,
      this.#drawerWidth(),
    );
    frame.style.setProperty(
      "--minke-mobile-sidebar-offset",
      `${String(values.offset)}px`,
    );
    frame.style.setProperty(
      "--minke-mobile-sidebar-progress",
      String(values.progress),
    );
    frame.style.setProperty(
      "--minke-mobile-sidebar-content-shift",
      `${String(values.contentShift)}px`,
    );
    frame.style.setProperty(
      "--minke-mobile-sidebar-content-scale",
      String(values.contentScale),
    );
    frame.style.setProperty(
      "--minke-mobile-sidebar-content-radius",
      `${String(values.contentRadius)}px`,
    );
    frame.style.setProperty(
      "--minke-mobile-sidebar-content-brightness",
      String(values.contentBrightness),
    );
    frame.style.setProperty(
      "--minke-mobile-sidebar-scrim-opacity",
      String(values.scrimOpacity),
    );
    frame.style.setProperty(
      "--minke-mobile-sidebar-shadow-opacity",
      String(values.shadowOpacity),
    );
  }

  #clearVisuals(frame: HTMLElement): void {
    for (const property of [
      "--minke-mobile-sidebar-offset",
      "--minke-mobile-sidebar-progress",
      "--minke-mobile-sidebar-content-shift",
      "--minke-mobile-sidebar-content-scale",
      "--minke-mobile-sidebar-content-radius",
      "--minke-mobile-sidebar-content-brightness",
      "--minke-mobile-sidebar-scrim-opacity",
      "--minke-mobile-sidebar-shadow-opacity",
    ]) {
      frame.style.removeProperty(property);
    }
  }

  readonly #onPointerDown = (event: PointerEvent): void => {
    const frame = this.#frame;
    const target = asElement(event.target, this.#view);
    if (
      frame === undefined ||
      target === undefined ||
      this.#gesture !== undefined ||
      !this.#enabled() ||
      frame.hasAttribute("data-minke-mobile-sidebar-settling") ||
      frame.hasAttribute(MOBILE_RIGHT_DRAWER_OPEN_ATTRIBUTE) ||
      !event.isPrimary ||
      event.button !== 0 ||
      target.closest(GESTURE_IGNORE_SELECTOR) !== null
    ) {
      return;
    }

    const open = frame.hasAttribute(MOBILE_SIDEBAR_OPEN_ATTRIBUTE);
    if (
      (!open && event.clientX > MOBILE_SIDEBAR_EDGE_PX) ||
      (open && event.clientX > this.#drawerWidth())
    ) {
      return;
    }

    this.#gesture = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      target,
      startedOpen: open,
      startX: event.clientX,
      startY: event.clientY,
      lastAt: event.timeStamp,
      lastX: event.clientX,
      logicalOpen: open,
      progress: open ? 1 : 0,
      velocity: 0,
      dragging: false,
    };
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    const gesture = this.#gesture;
    const frame = this.#frame;
    if (
      gesture === undefined ||
      frame === undefined ||
      gesture.pointerId !== event.pointerId
    ) {
      return;
    }

    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.dragging) {
      if (
        Math.max(Math.abs(dx), Math.abs(dy)) <
          MOBILE_SIDEBAR_DIRECTION_LOCK_PX
      ) {
        return;
      }
      if (
        Math.abs(dy) >= Math.abs(dx) ||
        (!gesture.startedOpen && dx <= 0) ||
        (gesture.startedOpen && dx >= 0)
      ) {
        this.#gesture = undefined;
        return;
      }

      gesture.dragging = true;
      this.#root.dispatchEvent(new Event(LEFT_DRAWER_OPENING_EVENT));
      frame.setAttribute(MOBILE_SIDEBAR_DRAGGING_ATTRIBUTE, "");
      if (!gesture.startedOpen) {
        this.#syncOpenState(true);
        this.#layout.toggleSidebar();
        gesture.logicalOpen = true;
      }
      const captureTarget = gesture.target as Element & {
        setPointerCapture?(pointerId: number): void;
      };
      try {
        captureTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // A re-render can detach the original rail control while expanding.
      }
    }

    const elapsed = Math.max(1, event.timeStamp - gesture.lastAt);
    const instantaneousVelocity =
      (event.clientX - gesture.lastX) / elapsed;
    gesture.velocity =
      gesture.velocity * 0.55 + instantaneousVelocity * 0.45;
    gesture.lastAt = event.timeStamp;
    gesture.lastX = event.clientX;
    const travel = Math.max(
      1,
      this.#drawerWidth(),
    );
    gesture.progress = clampMobileSidebarProgress(
      (gesture.startedOpen ? 1 : 0) + dx / travel,
    );
    this.#applyVisuals(gesture.progress);
    event.preventDefault();
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    const gesture = this.#gesture;
    if (
      gesture === undefined ||
      gesture.pointerId !== event.pointerId
    ) {
      return;
    }
    this.#gesture = undefined;
    if (!gesture.dragging) {
      this.#activateTouchedSession(gesture, event);
      return;
    }
    this.#suppressClickUntil =
      this.#view.performance.now() + CLICK_SUPPRESSION_MS;
    this.#suppressClickTarget = gesture.target;
    this.#settle(
      resolveMobileSidebarOpen({
        progress: gesture.progress,
        velocity: gesture.velocity,
        startedOpen: gesture.startedOpen,
      }),
      gesture.logicalOpen,
    );
  };

  /**
   * Mobile Safari can consume the first tap when a row's hover state reveals
   * its action button. Activate a touched session directly from pointerup and
   * suppress the delayed native click, making one physical tap deterministic.
   */
  #activateTouchedSession(
    gesture: SidebarGesture,
    event: PointerEvent,
  ): void {
    if (gesture.pointerType !== "touch") return;
    const row = gesture.target.closest(SESSION_SELECTION_SELECTOR);
    if (!(row instanceof this.#view.HTMLElement)) return;
    const nestedAction = gesture.target.closest(
      SESSION_NESTED_ACTION_SELECTOR,
    );
    if (nestedAction !== null && nestedAction !== row) return;

    event.preventDefault();
    this.#suppressClickUntil =
      this.#view.performance.now() + CLICK_SUPPRESSION_MS;
    this.#suppressClickTarget = row;
    this.#replayingSessionTap = true;
    try {
      row.click();
    } finally {
      this.#replayingSessionTap = false;
    }
  }

  readonly #onPointerCancel = (event: PointerEvent): void => {
    const gesture = this.#gesture;
    if (
      gesture === undefined ||
      gesture.pointerId !== event.pointerId
    ) {
      return;
    }
    this.#gesture = undefined;
    if (gesture.dragging) {
      this.#settle(gesture.startedOpen, gesture.logicalOpen);
    }
  };

  #settle(open: boolean, logicalOpen: boolean): void {
    const frame = this.#frame;
    if (frame === undefined) return;
    if (this.#settleTimer !== undefined) {
      this.#view.clearTimeout(this.#settleTimer);
    }
    frame.removeAttribute(MOBILE_SIDEBAR_DRAGGING_ATTRIBUTE);
    frame.setAttribute("data-minke-mobile-sidebar-settling", "");
    this.#syncOpenState(open);
    this.#applyVisuals(open ? 1 : 0);
    const reducedMotion = this.#view.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    this.#settleTimer = this.#view.setTimeout(() => {
      this.#settleTimer = undefined;
      if (logicalOpen !== open) this.#layout.toggleSidebar();
      frame.removeAttribute("data-minke-mobile-sidebar-settling");
      this.#clearVisuals(frame);
      this.#scheduleReconcile();
    }, reducedMotion ? 1 : SETTLE_DURATION_MS);
  }

  readonly #onScrimClick = (): void => {
    const frame = this.#frame;
    if (
      frame === undefined ||
      !frame.hasAttribute(MOBILE_SIDEBAR_OPEN_ATTRIBUTE)
    ) {
      return;
    }
    if (this.#selectionCloseFrame !== undefined) {
      this.#view.cancelAnimationFrame(this.#selectionCloseFrame);
    }
    // Session selection notifies synchronously from inside the row's React
    // handler. Give React one paint boundary to bind the new conversation,
    // then animate the drawer while keeping its wide tree mounted until the
    // transition completes.
    this.#selectionCloseFrame = this.#view.requestAnimationFrame(() => {
      this.#selectionCloseFrame = undefined;
      if (this.#frame?.hasAttribute(MOBILE_SIDEBAR_OPEN_ATTRIBUTE)) {
        this.#settle(false, true);
      }
    });
  };

  readonly #onNewSessionClick = (): void => {
    if (!this.#startMainWorkspaceSession()) {
      this.#newSessionSource?.click();
    }
  };

  readonly #onNewWorkspaceClick = (): void => {
    // React may replace the Workspace header while its tree reconciles. Resolve
    // the live control at tap time so this proxy never forwards to a stale node.
    const source = this.#root.querySelector(
      `[${MOBILE_NAV_ADD_WORKSPACE_SOURCE_ATTRIBUTE}]`,
    );
    if (
      source instanceof this.#view.HTMLButtonElement &&
      !source.disabled
    ) {
      source.click();
    }
  };

  readonly #onPinnedPanelClick = (event: MouseEvent): void => {
    const target = asElement(event.target, this.#view);
    if (target === undefined) return;

    const toggle = target.closest(
      `[${MOBILE_NAV_PINNED_TOGGLE_ATTRIBUTE}]`,
    );
    if (toggle !== null) {
      event.preventDefault();
      event.stopPropagation();
      this.#pinnedExpanded = !this.#pinnedExpanded;
      this.#persistPinnedSessions();
      this.#pinnedRenderKey = undefined;
      this.#renderPinnedPanel();
      return;
    }

    const pinCurrent = target.closest(
      `[${MOBILE_NAV_PIN_CURRENT_ATTRIBUTE}]`,
    );
    if (pinCurrent !== null) {
      event.preventDefault();
      event.stopPropagation();
      if (this.#currentSession !== undefined) {
        this.#togglePinnedSession(this.#currentSession);
      }
      return;
    }

    const unpin = target.closest(
      `[${MOBILE_NAV_UNPIN_SESSION_ATTRIBUTE}]`,
    );
    const unpinId = unpin?.getAttribute(
      MOBILE_NAV_UNPIN_SESSION_ATTRIBUTE,
    );
    if (unpinId !== null && unpinId !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      this.#togglePinnedSession(unpinId);
      return;
    }

    const session = target.closest(
      `[${MOBILE_NAV_PINNED_SESSION_ATTRIBUTE}]`,
    );
    const sessionId = session?.getAttribute(
      MOBILE_NAV_PINNED_SESSION_ATTRIBUTE,
    );
    if (sessionId === null || sessionId === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    this.#openSession?.(sessionId);
    this.#view.requestAnimationFrame(() => {
      if (this.#frame?.hasAttribute(MOBILE_SIDEBAR_OPEN_ATTRIBUTE)) {
        this.#settle(false, true);
      }
    });
  };

  readonly #onCurrentBookmarkClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    if (this.#currentSession !== undefined) {
      this.#togglePinnedSession(this.#currentSession);
    }
  };

  readonly #onClick = (event: MouseEvent): void => {
    if (this.#replayingSessionTap) return;
    const target = asElement(event.target, this.#view);
    const suppressed = this.#suppressClickTarget;
    if (
      this.#view.performance.now() <= this.#suppressClickUntil &&
      target !== undefined &&
      suppressed !== undefined &&
      (
        target === suppressed ||
        target.contains(suppressed) ||
        suppressed.contains(target)
      )
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.#suppressClickUntil = 0;
      this.#suppressClickTarget = undefined;
      return;
    }
    if (this.#view.performance.now() > this.#suppressClickUntil) {
      this.#suppressClickTarget = undefined;
    }
  };

  /** Close only after Harness confirms that a different session is current. */
  readonly #onSessionSelection = (): void => {
    const current = this.#sessionSelection.getSnapshot().current;
    this.#renderPinnedPanel();
    if (current === this.#currentSession) {
      this.#decorateCurrentSessionBookmark();
      return;
    }
    this.#currentSession = current;
    this.#decorateCurrentSessionBookmark();
    if (
      current === undefined ||
      !this.#frame?.hasAttribute(MOBILE_SIDEBAR_OPEN_ATTRIBUTE)
    ) {
      return;
    }
    this.#settle(false, true);
  };

  readonly #onRightDrawerOpening = (): void => {
    if (this.#frame?.hasAttribute(MOBILE_SIDEBAR_OPEN_ATTRIBUTE)) {
      this.#settle(false, true);
    }
  };

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (
      event.key !== "Escape" ||
      !this.#frame?.hasAttribute(MOBILE_SIDEBAR_OPEN_ATTRIBUTE)
    ) {
      return;
    }
    event.preventDefault();
    this.#settle(false, true);
  };
}

export function installMobileSidebarDrawer(
  layout: SidebarLayoutPort,
  sessions: SidebarSessionsPort,
  root: Document = document,
): () => void {
  const runtime = new MobileSidebarDrawerRuntime(
    layout,
    sessions.list,
    root,
    sessions.open.bind(sessions),
  );
  runtime.start();
  return () => runtime.dispose();
}
