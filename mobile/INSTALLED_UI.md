# Installed UI build

This development path packages HUB's actual Harness renderer and fixed browser plugin roster. It does not start a host, load a home directory, execute YAML expressions, access a live HUB, copy user configuration or restore screen/conversation/draft snapshots. Native activation remains a separate WebKit acceptance gate.

After the normal product build and `harness:stage` have produced matching static assets in `runtime/host`, run:

```sh
node mobile/scripts/export-installed-ui.mjs
node --test mobile/test/installed-ui-export.test.mjs tests/ui-installed-assets.test.mjs
HUB_RUN_INSTALLED_UI_RENDER_TEST=1 node --test mobile/test/installed-ui-export.test.mjs
```

The final command is a synthetic jsdom check of the real staged renderer: network fetches fail, real Home navigation must mount, and static resource requests fail the test. It does not emulate iPhone layout, WebKit cookies, WebSocket authentication, voice or device startup latency. The separate [origin probe](probes/InstalledUIOrigin/README.md) tests the public loading API.

`installed-ui-profile.json` is the explicit build roster selected from shipped base/web/HUB browser packages; HMR is omitted. No runtime plugin discovery or host activation occurs. `static-client-export.patch` exports `buildStaticClientGraph(inputs, staticModules)` from `@deepseek-ai/dsh-client-modules`: each input contains a package manifest and built client bundle Buffer. It reuses declaration validation, graph ordering and combo composition; returns `{graph,injections,assets}` with deterministic content revisions; and never executes factories during export.

The exporter applies that maintained patch to an isolated temporary module copy when the staged package predates it. Only Cordis definitions are imported; no Context or host fiber is constructed. The copy is removed. Staged runtime, running host and real home are unchanged. All bundle inputs must resolve inside staging; esbuild shell/font/CSS inputs must remain inside frontend output.

Output is `mobile/build/installed-ui/document.html` and `manifest.json`. Manifest schema 1 contains profile `hub-installed-web-v1`, host UI compatibility (64 hex), graph revision, ordered package IDs and `{file,sha256,bytes}` document metadata. Known lazy resources also carry `embedded:true`: their base64 bytes are inside the document, not separate files. The document hash authenticates those bytes. Graph/voice modules decode into same-origin blob URLs only on request. Ordinary PWA asset URLs remain unchanged when the installed hook is absent.

HTML contains the module queue, all factory registrations, boot graph, rebundled Vite shell and inline CSS/fonts. No service-worker bootstrap or HMR client is included. Native must use plain unprivileged WKWebView and `loadHTMLString` with the already verified HTTPS root as `baseURL`; never attach a native JS bridge. Authenticated HTTP/WSS still need the host. Offline mounting enables navigation without inventing account data or sending work.

The inert `hub-installed-ui-licenses` template includes the graph bundle's generated notices and actual top-level LICENSE/COPYING/NOTICE/OFL files found across staged npm package directories, including contained pnpm layouts. Collection is sorted and deterministic, records original file SHA-256, rejects files outside staging, and reads no README or user configuration. It includes all available staged dependency notices rather than claiming each package occurs in the browser payload. Full and reused staging retain `NOTICE.frontend-dependencies.txt`: actual contained pinned vendor dependency notices, original KaTeX font copyright/license/reserved-name records, and the SHA-256-pinned official SIL OFL1.1 text. Every staged font must byte-match a pinned original. Runtime validation requires this notice file; fingerprinting includes its collector and pinned license source.

Native must verify hash, size bound, schema/profile and compatibility metadata. Confirm live host compatibility asynchronously before mutations; mismatch needs compatible host/app update or remote-UI recovery. WebKit origin, `webView.url`, persistent cookies, authenticated HTTP/WSS, login redirects, sign-out, navigation and server switching require controlled HTTPS-fixture and iPhone acceptance before default activation.
