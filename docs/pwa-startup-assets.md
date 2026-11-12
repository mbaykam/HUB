# PWA startup assets

`build-product-packages.mjs` keeps the Electron Harness loader and its fallback
factory unchanged. It extracts the PWA factory using the existing wrapper
boundaries, then `pwa-factory.mjs` minifies that standalone factory with esbuild
for Safari 17 / Chrome 120. Export properties, the injected `require` interface,
function names, legal comments, and the release store's exact
`window.__HUB_UI_FACTORY__ = ` prefix remain intact. Source maps are excluded.
Graph and voice entry points retain their existing independent builds.

Verified `/api/hub/ui/asset?release=<sha256>&file=<allowed-file>` responses use
`Cache-Control: private, max-age=31536000, immutable`. The private cache varies on
Cookie and Authorization; shared caches must not store it. ETags identify each
file's verified content. Conditional requests still pass authorization and
cross-site checks before a 304, and errors and status responses stay
`private, no-store`. Asset query keys must be exact and unambiguous. New releases
have new URLs; old tabs and rollback keep their original release-pinned URLs.
A private fresh asset can be reused without contacting the host; this policy is
only for static executable code/licenses, never API data or index HTML.

## Size evidence and remaining work

A local transform of the current generated Electron bundle (2026-11-12) gave:

| Standalone PWA factory | Raw bytes | gzip bytes |
| --- | ---: | ---: |
| Before | 14,048,261 | 2,913,283 |
| After | 11,743,394 | 2,661,178 |

Raw bytes fall 16.4%; gzip falls 8.7%. gzip numbers are reproducible size
comparisons using Node's default `gzipSync`, not evidence that HTTP compression
is enabled. The raw decrease reduces first-download and parser input. Cache reuse
avoids repeat static downloads; these checks do not measure physical phone
startup time or first interactive latency.

Source-section attribution in the unminified bundle identifies about 4.47 MB of
Shiki language grammars and 3.70 MB of vscode-icons data. Those literals do not
shrink substantially through minification. Another ~0.97 MB is Cytoscape.
Home now loads the full graph workspace only after Explore knowledge or a
preview note is tapped, using the existing release-pinned graph asset. Duplicate
taps, download failure/retry and late completion after leaving Home are handled.
The updated build must be measured separately from the baseline above.

## Native launch integration

A local UIKit launch view should appear before network navigation and must not
wait for the UI asset download. Bundled UI assets should be built from the same
factory, host compatibility manifest, and lazy graph/voice release as the host;
do not combine an updated main factory with different lazy modules. The current
HTTP override still loads a blocking classic factory before Harness's deferred
module graph and falls back to the bundled factory if it cannot load. A native
shell must preserve that initialization order and the authenticated host origin.

This work adds no local conversation, draft, or previous-screen snapshot and no
restoration workflow. User data and settings remain owned by the host APIs.


## Concurrent installed-UI startup imports

`mobile/scripts/installed-ui-shell.mjs` removes the global prefetch rendezvous
from the installed document's actual staged Vite frontend shell. Acorn locates
exactly one async `runPluginBoot` method, its second parameter and the single
await of that parameter; only that AwaitExpression becomes `void 0`. Guards
require the own-import creation and final activation/audit calls to remain.
Structural drift fails the export instead of silently applying a broad edit.
The transformed bytes are inline in the installed document and covered by its
manifest hash. Existing Vite asset files/URLs and the ordinary HTTP PWA remain
unchanged.

Plugin imports can now start while speculative prefetch continues. Each import
still awaits its transport and declared dependencies. All entries must finish
activation and pass the original audit before the application mounts. Import
failures and missing required services remain visible boot failures.

The regression reads the actual staged frontend entry and rebundles it using
the installed shell options. Executing those boot methods with independently
held transport/initialization gates proves that the baseline starts zero imports
while prefetch is held, whereas the transformed shell starts both imports and
independent initialization. Activation still waits for every required entry.
These controlled startup proxies do not measure physical phone latency. On a
graph with one batch or a dominant required service the gain may be small.

The frontend inlines its development-time web boot package. A previous proposed
runtime patch against that absent package was removed; installing an unused
package would not change the actual shell. This installed-only transform does
not require a host boot-package patch or alter the pinned vendor source. It adds
no data, screen or draft snapshots.
