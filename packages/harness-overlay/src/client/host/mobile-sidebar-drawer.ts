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

interface SidebarLayoutPort {
  toggleSidebar(): void;
}

interface SidebarSessionSelectionPort {
  getSnapshot(): {
    readonly current: string | undefined;
  };
  subscribe(listener: () => void): () => void;
}

interface SidebarGesture {
  readonly pointerId: number;
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

function asElement(value: EventTarget | null): Element | undefined {
  return value instanceof Element ? value : undefined;
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
  #settleTimer: number | undefined;
  #suppressClickUntil = 0;
  #suppressClickTarget: Element | undefined;
  #currentSession: string | undefined;
  #unsubscribeSessionSelection: (() => void) | undefined;
  #disposed = false;

  constructor(
    layout: SidebarLayoutPort,
    sessionSelection: SidebarSessionSelectionPort,
    root: Document = document,
  ) {
    this.#root = root;
    const view = root.defaultView as MobileSidebarView | null;
    if (view === null) {
      throw new Error("Mobile sidebar drawer requires a browser window");
    }
    this.#view = view;
    this.#layout = layout;
    this.#sessionSelection = sessionSelection;
    this.#currentSession = sessionSelection.getSnapshot().current;
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
    this.#view.removeEventListener("resize", this.#scheduleReconcile);
    if (this.#reconcileFrame !== undefined) {
      this.#view.cancelAnimationFrame(this.#reconcileFrame);
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
    }

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
    this.#edge?.remove();
    this.#scrim?.remove();
    this.#frame = undefined;
    this.#sidebar = undefined;
    this.#content = undefined;
    this.#details = undefined;
    this.#edge = undefined;
    this.#scrim = undefined;
    this.#gesture = undefined;
    this.#suppressClickTarget = undefined;
    this.#suppressClickUntil = 0;
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
    const target = asElement(event.target);
    if (
      frame === undefined ||
      target === undefined ||
      this.#gesture !== undefined ||
      !this.#enabled() ||
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
    if (!gesture.dragging) return;
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
    if (logicalOpen !== open) this.#layout.toggleSidebar();
    this.#applyVisuals(open ? 1 : 0);
    const reducedMotion = this.#view.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    this.#settleTimer = this.#view.setTimeout(() => {
      this.#settleTimer = undefined;
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
    this.#settle(false, true);
  };

  readonly #onClick = (event: MouseEvent): void => {
    const target = asElement(event.target);
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
    if (current === this.#currentSession) return;
    this.#currentSession = current;
    if (
      current === undefined ||
      !this.#frame?.hasAttribute(MOBILE_SIDEBAR_OPEN_ATTRIBUTE)
    ) {
      return;
    }
    this.#settle(false, true);
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
  sessionSelection: SidebarSessionSelectionPort,
  root: Document = document,
): () => void {
  const runtime = new MobileSidebarDrawerRuntime(
    layout,
    sessionSelection,
    root,
  );
  runtime.start();
  return () => runtime.dispose();
}
