import test from "node:test";
import assert from "node:assert/strict";
import { pwaUiAsset } from "../packages/harness-overlay/src/client/host/mobile-ui-update.ts";

const filename = "memory-graph-browser.js";
function root(callback, release) {
  return { defaultView: { location: { origin: "https://hub.example" }, __HUB_INSTALLED_UI_ASSET__: callback, __HUB_UI_RELEASE__: release } };
}

test("installed asset hook uses only same-origin blob modules", () => {
  assert.equal(pwaUiAsset(root(name => `blob:https://hub.example/${name}`), filename, "/fallback"), `blob:https://hub.example/${filename}`);
  for (const url of ["https://hub.example/module.js", "blob:https://other.example/id", "blob:null/id", "data:text/javascript,export{}", "file:///private/module.js"]) {
    assert.equal(pwaUiAsset(root(() => url), filename, "/fallback"), "/fallback");
  }
  assert.equal(pwaUiAsset(root(() => "blob:https://hub.example/id"), "host.js", "/fallback"), "/fallback");
});

test("ordinary PWA and release-pinned lazy assets retain their URLs", () => {
  assert.equal(pwaUiAsset(root(undefined), filename, "/fallback"), "/fallback");
  const id = "a".repeat(64);
  assert.equal(pwaUiAsset(root(undefined, { id }), filename, "/fallback"), `/api/hub/ui/asset?release=${id}&file=${filename}`);
});
