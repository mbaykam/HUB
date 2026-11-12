import { transform } from "esbuild";

// Extract before minifying: desktop loader markers and its bundled fallback are
// a separate contract. Keep the exact PWA prefix required by the release store.
export async function createPwaFactory(clientBundle) {
  const start = clientBundle.indexOf("((require) =>");
  const end = clientBundle.lastIndexOf("return module.exports; }) });");
  if (start < 0 || end < start) throw new Error("Invalid UI factory boundary");
  const factory = clientBundle.slice(start, end) + "return module.exports; });";
  const { code } = await transform("var __hub_factory__ = " + factory, {
    loader: "js", target: ["safari17", "chrome120"], minify: true,
    keepNames: true, legalComments: "inline",
  });
  return "window.__HUB_UI_FACTORY__ = (()=>{" + code + "return __hub_factory__;})();\n";
}
