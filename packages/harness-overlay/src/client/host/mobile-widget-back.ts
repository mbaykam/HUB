import { defineOverlayStyle } from "../shared/style-runtime.ts";
import styles from "./mobile-widget-back.css";
const installStyles = defineOverlayStyle("hub-mobile-widget-back", styles);

/** Edge/header-only navigation: scrolling, form controls and graph gestures
 * elsewhere stay owned by the widget. Reuses its existing Back/Close action. */
export function installMobileWidgetBack(surface: HTMLElement, header: HTMLElement, back: () => void): () => void {
  const root = surface.ownerDocument, view = root.defaultView!;
  const removeStyles = installStyles(root);
  const edge = root.createElement("div"); edge.setAttribute("data-hub-widget-back-edge", ""); edge.setAttribute("aria-hidden", "true");
  header.setAttribute("data-hub-widget-back-header", ""); surface.append(edge);
  let gesture: {id:number;x:number;y:number;lastX:number;at:number;dx:number;velocity:number;dragging:boolean} | undefined;
  let timer: number | undefined, suppressedUntil = 0, disposed = false;
  let edgeFrame:number|undefined;
  const enabled = () => root.documentElement.hasAttribute("data-minke-mobile-web") && view.innerWidth < 1024;
  function positionEdge() {
    edge.hidden = !enabled();
    // Native graph dialog scrolls itself; Settings scrolls an inner section.
    // Keep the narrow navigation strip at the visible left edge in both cases.
    const top=`${surface.scrollTop}px`,height=`${surface.clientHeight}px`;
    if(edge.style.top!==top)edge.style.top=top;if(edge.style.height!==height)edge.style.height=height;
  }
  function clear() {
    surface.removeAttribute("data-hub-widget-back-active"); surface.removeAttribute("data-hub-widget-back-settling");
    surface.style.removeProperty("--hub-widget-back-x");
    if (timer !== undefined) view.clearTimeout(timer); timer = undefined;
    positionEdge();
  }
  function settle(commit: boolean) {
    gesture = undefined;
    const reduce = view.matchMedia("(prefers-reduced-motion: reduce)").matches;
    surface.setAttribute("data-hub-widget-back-settling", "");
    surface.style.setProperty("--hub-widget-back-x", commit ? `${surface.clientWidth}px` : "0px");
    timer = view.setTimeout(() => { clear(); if (commit && !disposed && surface.isConnected && enabled()) back(); }, reduce ? 0 : 180);
  }
  function down(event: PointerEvent) {
    if (gesture && event.pointerId !== gesture.id) { settle(false); return; }
    if (!enabled() || disposed || timer !== undefined || !event.isPrimary || event.button !== 0) return;
    const target = event.target instanceof view.Element ? event.target : null;
    if (!target || (target !== edge && !header.contains(target))) return;
    if (target.closest('button,a,input,textarea,select,[contenteditable="true"],[role="slider"]')) return;
    if (target.closest('[role="dialog"],dialog') !== surface) return;
    gesture = {id:event.pointerId,x:event.clientX,y:event.clientY,lastX:event.clientX,at:event.timeStamp,dx:0,velocity:0,dragging:false};
  }
  function move(event: PointerEvent) {
    const g = gesture; if (!g || g.id !== event.pointerId) return;
    const dx = event.clientX-g.x, dy = event.clientY-g.y;
    if (!g.dragging) {
      if (Math.max(Math.abs(dx),Math.abs(dy)) < 12) return;
      if (dx <= 0 || Math.abs(dx) < Math.abs(dy)*1.3) { gesture = undefined; return; }
      g.dragging = true; surface.setAttribute("data-hub-widget-back-active", "");
      try { surface.setPointerCapture(event.pointerId); } catch { /* detached/cancelled pointer */ }
    }
    g.velocity = .4*g.velocity + .6*(event.clientX-g.lastX)/Math.max(1,event.timeStamp-g.at);
    g.lastX = event.clientX; g.at = event.timeStamp; g.dx = Math.max(0,Math.min(surface.clientWidth,dx));
    surface.style.setProperty("--hub-widget-back-x",`${g.dx}px`);
    event.preventDefault(); event.stopPropagation();
  }
  function up(event: PointerEvent) {
    const g = gesture; if (!g || g.id !== event.pointerId) return;
    if (!g.dragging) { gesture = undefined; return; }
    suppressedUntil = view.performance.now()+450;
    const fast = event.timeStamp-g.at < 100 && g.velocity > .5 && g.dx > 32;
    settle(g.dx >= Math.min(96,surface.clientWidth*.26) || fast);
    event.preventDefault(); event.stopPropagation();
  }
  function cancel(event: PointerEvent) { if (gesture?.id === event.pointerId) { if (gesture.dragging) settle(false); else gesture=undefined; } }
  function click(event: MouseEvent) { if (event.isTrusted && event.detail > 0 && view.performance.now()<suppressedUntil) { event.preventDefault(); event.stopImmediatePropagation(); } }
  function resize() { gesture=undefined; clear(); }
  surface.addEventListener("pointerdown",down,true);
  root.addEventListener("pointermove",move,{capture:true,passive:false}); root.addEventListener("pointerup",up,true); root.addEventListener("pointercancel",cancel,true);
  surface.addEventListener("click",click,true); surface.addEventListener("scroll",positionEdge,{passive:true}); view.addEventListener("resize",resize);
  // WebKit reports a resize loop if a resize callback writes a navigation
  // child's geometry into that same surface. Position it on the next frame.
  const observer = new view.ResizeObserver(()=>{if(edgeFrame===undefined)edgeFrame=view.requestAnimationFrame(()=>{edgeFrame=undefined;if(!disposed)positionEdge();});}); observer.observe(surface); positionEdge();
  return () => { disposed=true; gesture=undefined; clear();if(edgeFrame!==undefined)view.cancelAnimationFrame(edgeFrame);observer.disconnect(); edge.remove(); header.removeAttribute("data-hub-widget-back-header");
    surface.removeEventListener("pointerdown",down,true); root.removeEventListener("pointermove",move,true); root.removeEventListener("pointerup",up,true); root.removeEventListener("pointercancel",cancel,true);
    surface.removeEventListener("click",click,true); surface.removeEventListener("scroll",positionEdge); view.removeEventListener("resize",resize); removeStyles();
  };
}
