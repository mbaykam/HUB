import {
  installMobileUsageMeter,
} from "./mobile-usage-meter.ts";

const MOBILE_WEB_ROOT_SELECTOR = "[data-minke-mobile-web]";
const SHELL_OVERLAY_SELECTOR = "[data-shell-overlay]";
const MOBILE_SIDEBAR_FRAME_ATTRIBUTE =
  "data-minke-mobile-sidebar-frame";
const MOBILE_RIGHT_DRAWER_ATTRIBUTE =
  "data-minke-mobile-right-drawer";
const MOBILE_RIGHT_DRAWER_OPEN_ATTRIBUTE =
  "data-minke-mobile-right-drawer-open";
const MOBILE_RIGHT_DRAWER_DRAGGING_ATTRIBUTE =
  "data-minke-mobile-right-drawer-dragging";
const MOBILE_RIGHT_DRAWER_EDGE_ATTRIBUTE =
  "data-minke-mobile-right-drawer-edge";
const MOBILE_RIGHT_DRAWER_SETTINGS_ATTRIBUTE =
  "data-minke-mobile-right-drawer-settings";
const MOBILE_RIGHT_DRAWER_CLOSE_ATTRIBUTE =
  "data-minke-mobile-right-drawer-close";
const MOBILE_SETTINGS_OPEN_ATTRIBUTE =
  "data-minke-mobile-settings-open";
const SETTINGS_TRIGGER_SELECTOR =
  '[data-slot="sidebar.settings"] button[aria-haspopup="dialog"]';
const GESTURE_IGNORE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[role="slider"]',
].join(",");
const LEFT_DRAWER_OPENING_EVENT =
  "minke:mobile-left-drawer-opening";

export const MOBILE_RIGHT_DRAWER_BREAKPOINT_PX = 1024;
export const MOBILE_RIGHT_DRAWER_EDGE_PX = 24;
export const MOBILE_RIGHT_DRAWER_DIRECTION_LOCK_PX = 9;
export const MOBILE_RIGHT_DRAWER_OPEN_THRESHOLD = 0.32;
export const MOBILE_RIGHT_DRAWER_FLING_VELOCITY = 0.42;

const SETTLE_DURATION_MS = 300;
const CLICK_SUPPRESSION_MS = 450;

interface RightDrawerGesture {
  readonly pointerId: number;
  readonly target: Element;
  readonly startedOpen: boolean;
  readonly startX: number;
  readonly startY: number;
  lastAt: number;
  lastX: number;
  progress: number;
  velocity: number;
  dragging: boolean;
}

type MobileRightDrawerView = Window & {
  readonly HTMLElement: typeof HTMLElement;
  readonly MutationObserver: typeof MutationObserver;
};

function asElement(value: EventTarget | null): Element | undefined {
  return value instanceof Element ? value : undefined;
}

export function clampMobileRightDrawerProgress(
  value: number,
): number {
  return Math.min(1, Math.max(0, value));
}

export function resolveMobileRightDrawerOpen(input: {
  readonly progress: number;
  readonly velocity: number;
  readonly startedOpen: boolean;
}): boolean {
  if (input.velocity >= MOBILE_RIGHT_DRAWER_FLING_VELOCITY) {
    return true;
  }
  if (input.velocity <= -MOBILE_RIGHT_DRAWER_FLING_VELOCITY) {
    return false;
  }
  return input.startedOpen
    ? input.progress > 1 - MOBILE_RIGHT_DRAWER_OPEN_THRESHOLD
    : input.progress >= MOBILE_RIGHT_DRAWER_OPEN_THRESHOLD;
}

export function mobileRightDrawerVisuals(
  progressValue: number,
  drawerWidth: number,
): Readonly<{
  contentBrightness: number;
  contentScale: number;
  offset: number;
  progress: number;
}> {
  const progress = clampMobileRightDrawerProgress(progressValue);
  const travel = Math.max(0, drawerWidth);
  return Object.freeze({
    contentBrightness: 1 - 0.06 * progress,
    contentScale: 1 - 0.012 * progress,
    offset: progress === 1 ? 0 : travel * (1 - progress),
    progress,
  });
}

/** Full-canvas mobile drawer reserved for secondary product features. */
export class MobileRightDrawerRuntime {
  readonly #root: Document;
  readonly #view: MobileRightDrawerView;
  readonly #observer: MutationObserver;
  #frame: HTMLElement | undefined;
  #drawer: HTMLDivElement | undefined;
  #edge: HTMLDivElement | undefined;
  #settingsButton: HTMLButtonElement | undefined;
  #closeButton: HTMLButtonElement | undefined;
  #settingsSourceRow: HTMLElement | undefined;
  #settingsSignature = "";
  #settingsOpen = false;
  #disposeUsageMeter: (() => void) | undefined;
  #gesture: RightDrawerGesture | undefined;
  #reconcileFrame: number | undefined;
  #settleTimer: number | undefined;
  #suppressClickUntil = 0;
  #suppressClickTarget: Element | undefined;
  #disposed = false;

  constructor(root: Document = document) {
    this.#root = root;
    const view = root.defaultView as MobileRightDrawerView | null;
    if (view === null) {
      throw new Error("Mobile right drawer requires a browser window");
    }
    this.#view = view;
    this.#observer = new view.MutationObserver(
      () => this.#scheduleReconcile(),
    );
  }

  start(): void {
    this.#observer.observe(this.#root.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
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
      LEFT_DRAWER_OPENING_EVENT,
      this.#onLeftDrawerOpening,
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
      LEFT_DRAWER_OPENING_EVENT,
      this.#onLeftDrawerOpening,
    );
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
    if (!frame.hasAttribute(MOBILE_SIDEBAR_FRAME_ATTRIBUTE)) {
      return;
    }

    if (frame !== this.#frame) {
      this.#clearFrame();
      this.#frame = frame;
      this.#createDrawer(frame);
    }
    this.#syncSettingsContent();
  };

  #createDrawer(frame: HTMLElement): void {
    const edge = this.#root.createElement("div");
    edge.setAttribute(MOBILE_RIGHT_DRAWER_EDGE_ATTRIBUTE, "");
    edge.setAttribute("aria-hidden", "true");
    frame.append(edge);
    this.#edge = edge;

    const drawer = this.#root.createElement("div");
    drawer.setAttribute(MOBILE_RIGHT_DRAWER_ATTRIBUTE, "");
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");
    drawer.setAttribute("aria-label", "Utilities");
    drawer.setAttribute("aria-hidden", "true");
    drawer.setAttribute("inert", "");

    const header = this.#root.createElement("div");
    header.setAttribute("data-minke-mobile-right-drawer-header", "");
    const settings = this.#root.createElement("button");
    settings.type = "button";
    settings.setAttribute(MOBILE_RIGHT_DRAWER_SETTINGS_ATTRIBUTE, "");
    settings.setAttribute("aria-label", "Open Settings");
    settings.addEventListener("click", this.#onSettingsClick);
    header.append(settings);
    this.#settingsButton = settings;

    const close = this.#root.createElement("button");
    close.type = "button";
    close.setAttribute(MOBILE_RIGHT_DRAWER_CLOSE_ATTRIBUTE, "");
    close.setAttribute("aria-label", "Close panel");
    close.textContent = "×";
    close.addEventListener("click", this.#onCloseClick);
    header.append(close);
    this.#closeButton = close;

    const body = this.#root.createElement("div");
    body.setAttribute("data-minke-mobile-right-drawer-body", "");
    drawer.append(header, body);
    frame.append(drawer);
    this.#drawer = drawer;
    this.#disposeUsageMeter = installMobileUsageMeter(body, this.#root);
  }

  #clearFrame(): void {
    this.#setBackgroundInert(false);
    this.#frame?.removeAttribute(MOBILE_RIGHT_DRAWER_OPEN_ATTRIBUTE);
    this.#frame?.removeAttribute(
      MOBILE_RIGHT_DRAWER_DRAGGING_ATTRIBUTE,
    );
    this.#frame?.removeAttribute(
      "data-minke-mobile-right-drawer-settling",
    );
    this.#frame?.removeAttribute(MOBILE_SETTINGS_OPEN_ATTRIBUTE);
    this.#clearVisuals();
    this.#settingsButton?.removeEventListener(
      "click",
      this.#onSettingsClick,
    );
    this.#closeButton?.removeEventListener(
      "click",
      this.#onCloseClick,
    );
    this.#settingsSourceRow?.removeAttribute(
      "data-minke-mobile-settings-source",
    );
    this.#disposeUsageMeter?.();
    this.#edge?.remove();
    this.#drawer?.remove();
    this.#frame = undefined;
    this.#drawer = undefined;
    this.#edge = undefined;
    this.#settingsButton = undefined;
    this.#closeButton = undefined;
    this.#settingsSourceRow = undefined;
    this.#settingsSignature = "";
    this.#settingsOpen = false;
    this.#disposeUsageMeter = undefined;
    this.#gesture = undefined;
    this.#suppressClickUntil = 0;
    this.#suppressClickTarget = undefined;
  }

  #enabled(): boolean {
    return (
      this.#root.documentElement.matches(MOBILE_WEB_ROOT_SELECTOR) &&
      this.#view.innerWidth < MOBILE_RIGHT_DRAWER_BREAKPOINT_PX
    );
  }

  #drawerWidth(): number {
    return Math.max(
      1,
      this.#drawer?.getBoundingClientRect().width ??
        this.#view.innerWidth,
    );
  }

  #syncSettingsContent(): void {
    const source = this.#root.querySelector<HTMLButtonElement>(
      SETTINGS_TRIGGER_SELECTOR,
    );
    const target = this.#settingsButton;
    if (source === null || target === undefined) return;
    this.#syncSettingsOpen(
      source.getAttribute("aria-expanded") === "true",
    );
    const sourceRow = source.parentElement;
    if (
      sourceRow instanceof this.#view.HTMLElement &&
      sourceRow !== this.#settingsSourceRow
    ) {
      this.#settingsSourceRow?.removeAttribute(
        "data-minke-mobile-settings-source",
      );
      sourceRow.setAttribute("data-minke-mobile-settings-source", "");
      this.#settingsSourceRow = sourceRow;
    }
    const signature = source.innerHTML;
    if (signature === this.#settingsSignature) return;
    this.#settingsSignature = signature;
    target.replaceChildren(
      ...[...source.childNodes].map((node) => node.cloneNode(true)),
    );
    const visibleLabel = source.textContent?.trim() || "Settings";
    if ((target.textContent ?? "").trim() === "") {
      const label = this.#root.createElement("span");
      label.setAttribute("data-minke-mobile-right-drawer-label", "");
      label.textContent = visibleLabel;
      target.append(label);
    }
    const sourceLabel = source.getAttribute("aria-label");
    target.setAttribute(
      "aria-label",
      sourceLabel ?? `Open ${visibleLabel}`,
    );
  }

  #syncOpenState(open: boolean): void {
    const frame = this.#frame;
    const drawer = this.#drawer;
    if (frame === undefined || drawer === undefined) return;
    frame.toggleAttribute(MOBILE_RIGHT_DRAWER_OPEN_ATTRIBUTE, open);
    drawer.setAttribute(
      "aria-hidden",
      String(!open || this.#settingsOpen),
    );
    drawer.toggleAttribute("inert", !open || this.#settingsOpen);
    this.#setBackgroundInert(open && !this.#settingsOpen);
  }

  #syncSettingsOpen(open: boolean): void {
    const frame = this.#frame;
    const drawer = this.#drawer;
    if (frame === undefined || drawer === undefined) return;
    const changed = open !== this.#settingsOpen;
    this.#settingsOpen = open;
    frame.toggleAttribute(MOBILE_SETTINGS_OPEN_ATTRIBUTE, open);
    const rightOpen = frame.hasAttribute(
      MOBILE_RIGHT_DRAWER_OPEN_ATTRIBUTE,
    );
    drawer.setAttribute("aria-hidden", String(!rightOpen || open));
    drawer.toggleAttribute("inert", !rightOpen || open);
    this.#setBackgroundInert(rightOpen && !open);
    if (changed && !open && rightOpen) {
      this.#view.requestAnimationFrame(() => {
        this.#settingsButton?.focus({ preventScroll: true });
      });
    }
  }

  #setBackgroundInert(inert: boolean): void {
    const frame = this.#frame;
    const drawer = this.#drawer;
    if (frame === undefined) return;
    for (const child of [...frame.children]) {
      if (!(child instanceof this.#view.HTMLElement) || child === drawer) {
        continue;
      }
      if (inert) {
        if (!child.hasAttribute("inert")) {
          child.setAttribute("inert", "");
          child.setAttribute("data-minke-mobile-right-drawer-inert", "");
        }
      } else if (
        child.hasAttribute("data-minke-mobile-right-drawer-inert")
      ) {
        child.removeAttribute("data-minke-mobile-right-drawer-inert");
        child.removeAttribute("inert");
      }
    }
  }

  #applyVisuals(progress: number): void {
    const frame = this.#frame;
    if (frame === undefined) return;
    const values = mobileRightDrawerVisuals(
      progress,
      this.#drawerWidth(),
    );
    frame.style.setProperty(
      "--minke-mobile-right-drawer-offset",
      `${String(values.offset)}px`,
    );
    frame.style.setProperty(
      "--minke-mobile-right-drawer-progress",
      String(values.progress),
    );
    frame.style.setProperty(
      "--minke-mobile-right-content-scale",
      String(values.contentScale),
    );
    frame.style.setProperty(
      "--minke-mobile-right-content-brightness",
      String(values.contentBrightness),
    );
  }

  #clearVisuals(): void {
    const frame = this.#frame;
    if (frame === undefined) return;
    for (const property of [
      "--minke-mobile-right-drawer-offset",
      "--minke-mobile-right-drawer-progress",
      "--minke-mobile-right-content-scale",
      "--minke-mobile-right-content-brightness",
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
    const open = frame.hasAttribute(MOBILE_RIGHT_DRAWER_OPEN_ATTRIBUTE);
    if (
      (!open &&
        event.clientX <
          this.#view.innerWidth - MOBILE_RIGHT_DRAWER_EDGE_PX) ||
      (open && !this.#drawer?.contains(target))
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
          MOBILE_RIGHT_DRAWER_DIRECTION_LOCK_PX
      ) {
        return;
      }
      if (
        Math.abs(dy) >= Math.abs(dx) ||
        (!gesture.startedOpen && dx >= 0) ||
        (gesture.startedOpen && dx <= 0)
      ) {
        this.#gesture = undefined;
        return;
      }
      gesture.dragging = true;
      frame.setAttribute(MOBILE_RIGHT_DRAWER_DRAGGING_ATTRIBUTE, "");
      if (!gesture.startedOpen) {
        this.#root.dispatchEvent(
          new Event("minke:mobile-right-drawer-opening"),
        );
        this.#syncOpenState(true);
      }
      const captureTarget = gesture.target as Element & {
        setPointerCapture?(pointerId: number): void;
      };
      try {
        captureTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // A re-render can detach an edge target during capture.
      }
    }

    const elapsed = Math.max(1, event.timeStamp - gesture.lastAt);
    const instantaneousVelocity =
      -(event.clientX - gesture.lastX) / elapsed;
    gesture.velocity =
      gesture.velocity * 0.55 + instantaneousVelocity * 0.45;
    gesture.lastAt = event.timeStamp;
    gesture.lastX = event.clientX;
    gesture.progress = clampMobileRightDrawerProgress(
      (gesture.startedOpen ? 1 : 0) - dx / this.#drawerWidth(),
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
      resolveMobileRightDrawerOpen({
        progress: gesture.progress,
        velocity: gesture.velocity,
        startedOpen: gesture.startedOpen,
      }),
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
    if (gesture.dragging) this.#settle(gesture.startedOpen);
  };

  #settle(open: boolean): void {
    const frame = this.#frame;
    if (frame === undefined) return;
    if (this.#settleTimer !== undefined) {
      this.#view.clearTimeout(this.#settleTimer);
    }
    frame.removeAttribute(MOBILE_RIGHT_DRAWER_DRAGGING_ATTRIBUTE);
    frame.setAttribute("data-minke-mobile-right-drawer-settling", "");
    this.#syncOpenState(open);
    this.#applyVisuals(open ? 1 : 0);
    const reducedMotion = this.#view.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    this.#settleTimer = this.#view.setTimeout(() => {
      this.#settleTimer = undefined;
      frame.removeAttribute("data-minke-mobile-right-drawer-settling");
      this.#clearVisuals();
      if (open) this.#settingsButton?.focus({ preventScroll: true });
      this.#scheduleReconcile();
    }, reducedMotion ? 1 : SETTLE_DURATION_MS);
  }

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

  readonly #onSettingsClick = (): void => {
    const source = this.#root.querySelector<HTMLButtonElement>(
      SETTINGS_TRIGGER_SELECTOR,
    );
    if (source === null) return;
    // Keep the right drawer logically open beneath Settings. The Settings
    // state observer temporarily releases the background and hides this
    // drawer, then restores it when the dialog alone closes.
    this.#syncSettingsOpen(true);
    source.click();
  };

  readonly #onCloseClick = (): void => {
    this.#settle(false);
  };

  readonly #onLeftDrawerOpening = (): void => {
    if (this.#frame?.hasAttribute(MOBILE_RIGHT_DRAWER_OPEN_ATTRIBUTE)) {
      this.#settle(false);
    }
  };

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (!this.#frame?.hasAttribute(MOBILE_RIGHT_DRAWER_OPEN_ATTRIBUTE)) {
      return;
    }
    if (this.#settingsOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.#settle(false);
      return;
    }
    if (event.key !== "Tab") return;
    const drawer = this.#drawer;
    if (drawer === undefined) return;
    const focusable = [
      ...drawer.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ),
    ];
    const first = focusable.at(0);
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && this.#root.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && this.#root.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
}

export function installMobileRightDrawer(
  root: Document = document,
): () => void {
  const runtime = new MobileRightDrawerRuntime(root);
  runtime.start();
  return () => runtime.dispose();
}
