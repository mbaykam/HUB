import { defineOverlayStyle } from "../shared/style-runtime.ts";
import styles from "./mobile-settings.css";
import { installMobileWidgetBack } from "./mobile-widget-back.ts";
import { installMobileUiUpdate } from "./mobile-ui-update.ts";
const installStyles = defineOverlayStyle("hub-mobile-settings", styles);

/** Phone navigation around the existing native settings controls. No duplicate
 * settings store, copied forms, or desktop shell replacement. */
export function installMobileSettings(root: Document = document): () => void {
  const view = root.defaultView;
  if (!view) return () => {};
  const removeStyles = installStyles(root);
  let disposePanel: (() => void) | undefined;
  let refreshPanel: (() => void) | undefined;
  let mounted: HTMLElement | undefined;
  let frame: number | undefined;
  let disposed = false;
  // HUB owns character instructions, model browsing and tool permissions. The
  // inherited native pages are deployment editors, often read-only on a PWA.
  // Keep them available in the host shell, outside the personal-assistant PWA.
  const legacy=new Set<HTMLElement>();
  function tidyNavigation(){
    const pwa=root.documentElement.hasAttribute("data-minke-mobile-web");
    for(const nav of root.querySelectorAll<HTMLElement>('[data-slot="sidebar.settings"] [role="dialog"] > nav')){
      for(const b of nav.querySelectorAll<HTMLButtonElement>(":scope > div:last-child > button")){
        if(pwa&&/^(Models|Plugins|Agent presets|模型|插件|智能体预设)$/i.test(b.textContent?.trim()??"")){if(!b.hasAttribute("data-hub-legacy-setting")){b.setAttribute("data-hub-legacy-setting","");legacy.add(b);}}
        else if(legacy.has(b)){b.removeAttribute("data-hub-legacy-setting");legacy.delete(b);}
      }
      for(const config of nav.parentElement?.querySelectorAll<HTMLButtonElement>('button')??[]){if(pwa&&(/^(Open configuration file|打开配置文件)$/.test(config.textContent?.trim()??"")||config.getAttribute("aria-label")==="Open configuration file")&&!config.hasAttribute("data-hub-legacy-setting")){config.setAttribute("data-hub-legacy-setting","");legacy.add(config);}}
    }
  }
  function mount(dialog: HTMLElement) {
    const nav = dialog.querySelector<HTMLElement>(":scope > nav");
    const content = nav?.nextElementSibling as HTMLElement | null;
    const nativeHeader = content?.firstElementChild as HTMLElement | null;
    const options = content?.lastElementChild as HTMLElement | null;
    const nativeClose = nativeHeader?.querySelector<HTMLButtonElement>(":scope > button");
    if (!nav || !content || !options || !nativeClose) return;
    const marked = new Map<HTMLElement, Set<string>>();
    function mark(node: HTMLElement, key: string, value = "") {
      if (!node.hasAttribute(key)) {
        const keys = marked.get(node) ?? new Set<string>(); keys.add(key); marked.set(node, keys);
      }
      if (node.getAttribute(key) !== value) node.setAttribute(key, value);
    }
    mark(dialog, "data-hub-mobile-settings"); mark(nav, "data-hub-settings-nav");
    mark(content, "data-hub-settings-content"); mark(nativeHeader!, "data-hub-settings-native-header");
    mark(options, "data-hub-settings-options"); mark(nativeClose, "data-hub-settings-native-close");
    const header = root.createElement("header"); header.setAttribute("data-hub-settings-header", "");
    const back = root.createElement("button"); back.type = "button"; back.textContent = "‹"; back.setAttribute("aria-label", "Back to settings");
    const heading = root.createElement("h2"); heading.id = "hub-mobile-settings-heading"; heading.tabIndex = -1;
    const close = root.createElement("button"); close.type = "button"; close.textContent = "×"; close.setAttribute("aria-label", "Close settings");
    header.append(back, heading, close); dialog.prepend(header);
    const oldLabel = dialog.getAttribute("aria-labelledby"); dialog.setAttribute("aria-labelledby", heading.id);
    const intro = root.createElement("section"); intro.setAttribute("data-hub-settings-intro", "");
    const general=root.createElement("button");general.type="button";general.textContent="General · appearance & language";general.addEventListener("click",()=>{nav!.querySelectorAll<HTMLButtonElement>("button").forEach(b=>{if(/^(General|常规)$/.test(b.textContent?.trim()??""))b.click();});});intro.append(general);
    const removeUpdate = installMobileUiUpdate(intro, root);
    let section = false;
    let selected: HTMLButtonElement | undefined;
    const descriptions: Record<string, string> = {
      General: "Appearance, language & conversations",
      HUB: "Characters, Knowledge AI, Telegram & workspace", Minke: "Characters, Knowledge AI, Telegram & workspace",
      Models: "Models, providers & connections",
      Plugins: "Extensions & integrations",
      "Agent presets": "Instructions & assistant behavior",
    };
    function show(detail: boolean) {
      section = detail;
      mark(dialog, "data-hub-settings-view", detail ? "section" : "index");
      heading.textContent = detail&&selected&&!/^(HUB|Minke)$/.test(selected.textContent?.trim()??"") ? selected.textContent?.trim() || "Settings" : "Settings";
      back.hidden = !detail||heading.textContent==="Settings";
      if (detail) options!.scrollTop = 0;
    }
    function refresh() {
      const controls=options!.querySelector<HTMLElement>('[data-hub-settings-controls]');if(controls&&intro.parentElement!==controls)controls.append(intro);
      for (const button of nav!.querySelectorAll<HTMLButtonElement>(":scope > div:last-child > button")) {
        mark(button, "data-hub-settings-category");
        mark(button, "data-hub-settings-description", descriptions[button.textContent?.trim() ?? ""] ?? "Manage preferences");
      }
      for (const slot of options!.querySelectorAll<HTMLElement>('[data-slot="settings.general.item"]')) {
        for (const row of slot.children) if (row instanceof view!.HTMLElement) {
          mark(row, "data-hub-settings-row");
          const themes = row.querySelectorAll('button[aria-pressed]');
          if (themes.length === 3 && themes[0]?.parentElement) mark(themes[0].parentElement, "data-hub-settings-themes");
          const arrows = row.querySelectorAll<HTMLButtonElement>('span > button[aria-label]');
          if (arrows.length === 2 && arrows[0]?.parentElement === arrows[1]?.parentElement) {
            const group = arrows[0]!.parentElement!;
            mark(group, "data-hub-settings-stepper-arrows");
            if (group.parentElement) mark(group.parentElement, "data-hub-settings-stepper");
          }
        }
      }
      if (section && selected && !selected.isConnected) { selected = undefined;toIndex(); }
    }
    const onSelect = (event: Event) => {
      const target = event.target instanceof view!.Element ? event.target.closest<HTMLButtonElement>("button[data-hub-settings-category]") : null;
      if (!target || !nav!.contains(target)) return;
      selected = target; show(true);
      // The original React click still selects and renders its native section.
      view!.requestAnimationFrame(() => { if (dialog.isConnected && section) heading.focus({ preventScroll: true }); });
    };
    const toIndex = () => {const hub=[...nav!.querySelectorAll<HTMLButtonElement>("button")].find(b=>/^(HUB|Minke)$/.test(b.textContent?.trim()??""));if(hub){selected=hub;hub.click();show(true);}close.focus({preventScroll:true});};
    const onKey = (event: KeyboardEvent) => {
      if (root.activeElement instanceof view!.Element && root.activeElement.closest('[role="dialog"]') !== dialog) return;
      if (event.key === "Escape" && section) { event.preventDefault(); event.stopImmediatePropagation(); if(back.hidden)nativeClose.click();else toIndex(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')]
        .filter(node => node.getClientRects().length > 0 && !node.closest('[inert], [hidden]'));
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && (root.activeElement === first || root.activeElement === heading)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    nav.addEventListener("click", onSelect);
    root.addEventListener("keydown", onKey, true);
    back.addEventListener("click", toIndex);
    close.addEventListener("click", () => nativeClose.click());
    refresh();toIndex();close.focus({ preventScroll: true });
    const removeSwipe = installMobileWidgetBack(dialog, header, () => { if (section&&!back.hidden) toIndex(); else nativeClose.click(); });
    mounted = dialog; refreshPanel = refresh;
    disposePanel = () => {
      removeSwipe();
      removeUpdate();
      nav.removeEventListener("click", onSelect); root.removeEventListener("keydown", onKey, true);
      header.remove(); intro.remove();
      for (const [node, keys] of marked) for (const key of keys) node.removeAttribute(key);
      if (oldLabel === null) dialog.removeAttribute("aria-labelledby"); else dialog.setAttribute("aria-labelledby", oldLabel);
      // Crossing back to the desktop breakpoint must never leave focus in the
      // removed mobile-only header, or leave native controls hidden/inert.
      if (dialog.isConnected) nativeClose.focus({ preventScroll: true });
    };
  }
  function reconcile() {
    frame = undefined;
    if (disposed) return;
    tidyNavigation();
    const mobile = root.documentElement.hasAttribute("data-minke-mobile-web");
    const dialog = mobile ? root.querySelector<HTMLElement>('[data-slot="sidebar.settings"] [role="dialog"]') : null;
    if (mounted !== dialog) { disposePanel?.(); disposePanel = undefined; refreshPanel = undefined; mounted = undefined; if (dialog) mount(dialog); }
    else refreshPanel?.();
  }
  const schedule = () => { if (!disposed && frame === undefined) frame = view.requestAnimationFrame(reconcile); };
  const observer = new view.MutationObserver(records => {
    if (records.some(record => !(record.target instanceof view.Element) || !record.target.closest('[data-hub-settings-header], [data-hub-settings-intro]'))) schedule();
  });
  observer.observe(root.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-current"] });
  observer.observe(root.documentElement, { attributes: true, attributeFilter: ["data-minke-mobile-web"] });
  view.addEventListener("resize", schedule); schedule();
  return () => { disposed = true; observer.disconnect(); view.removeEventListener("resize", schedule); if (frame !== undefined) view.cancelAnimationFrame(frame); disposePanel?.();for(const b of legacy)b.removeAttribute("data-hub-legacy-setting");removeStyles(); };
}
