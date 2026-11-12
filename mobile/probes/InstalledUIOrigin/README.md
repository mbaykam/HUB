# Installed UI origin probe

This isolated Swift package tests `WKWebView.loadHTMLString(_:baseURL:)` using only public WebKit APIs. Run on a Mac with a logged-in graphical session:

```sh
HUB_RUN_WEBKIT_PROBE=1 swift test --package-path mobile/probes/InstalledUIOrigin
```

The document is synthetic, the HTTPS hostname uses reserved `.invalid`, CSP blocks network, and cookies are synthetic in a nonpersistent store. Tests check the document origin, secure context, relative API/WebSocket URL construction and JavaScript cookie visibility, including HttpOnly exclusion. No production code or project settings load this probe. A macOS pass is evidence for that WebKit build only; it does not establish iPhone behavior, authenticated fetch, WebSocket handshakes, persistent-store restoration or login recovery. This source has not been compiled on the Windows development host.

Before enabling an installed UI, run equivalent tests on every supported iOS baseline using an isolated controlled HTTPS fixture and the app's persistent WebKit store. The fixture must verify Secure/HttpOnly/SameSite cookie receipt for same-origin fetch and WSS, return distinguishable JSON instead of an HTML login page, test expired sessions and redirects, and inspect request Origin/Referer/Sec-Fetch-Site. Repeat after process termination, sign-out and a change of host. Never use real account cookies for these probes. Keep the existing remote document as the default until those tests pass.

## Export prerequisite

There is currently no hermetic installed UI exporter. `scripts/harness/boot-manifest.mjs` parses a served page, while `ClientModuleRegistry` composes its graph from the running host's plugin tree. `pwa-client.js` is one plugin factory, not the complete renderer. Copying it into `mobile/src` cannot mount the existing panels.

A clean build must first expose the following metadata, generated from a fixed product profile in a temporary empty home with no user settings, credentials, environment providers or host activity:

- The exact `WebBootGraph` from `ClientModuleRegistry.graph()`, including all entries, inject/external dependencies, batch membership and content revisions.
- The module-loader bootstrap queue and required static index injection rows, with an explicit allowlist; no live theme/account/config injection or rendered live host HTML.
- A complete URL-to-build-file map and SHA-256 for all graph batches, Vite shell JS/CSS and recursively referenced chunks/fonts/icons, plus overlay lazy assets and licenses.
- A host API compatibility identifier and the fixed product profile identity. Include no machine paths or private runtime configuration.

The exporter should fail on unknown injection kinds, missing assets, remote static URLs, symlinks escaping the build directory or incompatible graphs. It must take only these build artifacts, not a live host address. Register all client factories before starting `AppWebEntry`; the existing module system skips its HTTP transport for already registered factories. Inline the shell and styles or rewrite every static dependency to an audited bundled transport. Disable service-worker registration and host-driven module hot replacement for this installed document. Keep ordinary authenticated API/WSS traffic on the verified HTTPS origin, with no native bridge or auth bypass.

Acceptance requires cold offline launch to mount the real existing renderer and panels without any static network requests. Data-dependent content must show the renderer's actual empty/loading/error state; no conversation, screen or draft snapshots may be restored. Host compatibility checking must be asynchronous and must not make an offline shell appear authenticated or enable incompatible mutations. PWA behavior remains separate and unchanged.

## Exact build API missing

Code inspection found a second obstacle beyond a clean profile: `ClientModuleRegistry.processOne()` deliberately ignores loader entries without an active `fiber`. Instantiating the registry with disabled host plugins therefore produces an incomplete graph; activating them executes their host startup effects. The existing smoke launcher inherits the caller's environment and project working directory. It is not an export-only profile and must not be reused as a hermetic exporter without additional isolation.

The bounded prerequisite is a pure build API alongside the registry, accepting an explicit ordered list of resolved product client manifests and built bundle paths. It must reuse `parseDshClient`, `clientExportOf`, `orderByModuleGraph`, batch partitioning and `buildBatch`, without constructing host fibers or reading a home directory. It must return the graph, `bootInjections(graph)` and batch bytes directly, avoiding an HTTP server. These composition functions are currently private except `orderByModuleGraph` and `bootInjections`; duplicating them into a mobile script would create a competing graph implementation.

The product build must supply that API's explicit package list from the selected clean profile after include/patch composition, without importing plugin implementations or evaluating arbitrary user config. Existing initial row revisions include `randomBytes(8)` through `allocateInitialRevision()`, so a deterministic build export must use content revisions instead of persisting a live registry's random graph. Repeat exports should be byte-identical, and fixture tests should reject unresolved externals, missing bootstrap, duplicate packages, missing bundles and files escaping the staging root. This requires a focused Harness build seam before `mobile/scripts/export-installed-ui.mjs` can honestly be a complete exporter. No host process was launched during this investigation.
