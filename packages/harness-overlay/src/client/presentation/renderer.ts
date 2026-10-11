import DOMPurify from "dompurify";
import { parse, View, loader as createLoader, type Spec } from "vega";
import { expressionInterpreter } from "vega-interpreter";
import { parsePresentation } from "../../presentation-contract.ts";
import { defineOverlayStyle } from "../shared/style-runtime.ts";
import styles from "./renderer.css";

// Separate lazy artifact. This entry is never imported by the main PWA bundle.
// It lives only in an opaque sandbox with no parent/tool/network bridge.
defineOverlayStyle("hub-explanation-renderer", styles)(document);
const surface = document.getElementById("visual")!;
let chart: View | undefined;
let preferredWidth = 480;
const fittedWidth = () => Math.min(preferredWidth, Math.max(200, surface.clientWidth - 32));
async function render() {
  const content = parsePresentation(JSON.parse(document.getElementById("visual-data")!.textContent!));
  if (content.kind === "html") {
    surface.replaceChildren(DOMPurify.sanitize(content.html, {
      RETURN_DOM_FRAGMENT: true,
      FORBID_TAGS: ["script", "style", "link", "meta", "base", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "audio", "video", "foreignObject", "animate", "set"],
      FORBID_ATTR: ["href", "xlink:href", "srcset", "action", "formaction", "target", "ping", "autofocus"],
      ALLOW_DATA_ATTR: false,
    }));
  } else {
    const loader = createLoader();
    loader.load = async () => { throw new Error("External data is disabled"); };
    loader.sanitize = async () => { throw new Error("External resources are disabled"); };
    preferredWidth = Number(content.spec.width ?? 480);
    const spec = { ...content.spec, padding: 12, width: fittedWidth() } as Spec;
    chart = new View(parse(spec, undefined, { ast: true }), { expr: expressionInterpreter, renderer: "svg", container: surface, hover: true, loader });
    await chart.runAsync();
  }
  document.body.dataset.ready = "true";
}
// No links, form submission or context escape, including generated SVG links.
document.addEventListener("click", event => { if ((event.target as Element)?.closest?.("a")) event.preventDefault(); }, true);
document.addEventListener("submit", event => event.preventDefault(), true);
window.addEventListener("pagehide", () => chart?.finalize(), { once: true });
window.addEventListener("resize", () => { if (chart) void chart.width(fittedWidth()).runAsync().catch(() => {}); });
void render().catch(() => { chart?.finalize(); surface.textContent = "This visual could not be rendered. Ask the assistant to simplify it."; document.body.dataset.error = "true"; });
