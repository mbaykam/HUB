# Installed UI origin probe

This isolated Swift package tests public WKWebView loadHTMLString APIs. Run in a graphical macOS session:

The required Home/composer rendering gate uses a real UIKit scene through
`ios-renderer-probe.yml`. SwiftPM's CLI process can leave its macOS window
occluded and its page hidden, suspending animation frames. The optional Mac
layout investigation requires `HUB_RUN_MAC_RENDERER_PROBE=1`; it retains strict
layout assertions and must not replace the iPhone app-host gate. The origin and
synthetic HTTPS/WSS checks below remain enabled independently.

```sh
HUB_RUN_WEBKIT_PROBE=1 swift test --package-path mobile/probes/InstalledUIOrigin
```

The test skips unless enabled. After actual didFinish it checks origin, href, webView.url, base URI, secure context, API/WSS URL construction and cookie visibility, including HttpOnly exclusion. Synthetic cookies use nonpersistent storage, a reserved .invalid hostname and network-blocking CSP. No production project settings load the probe.

A macOS pass is evidence for that WebKit build only. It does not establish iPhone behavior, authenticated fetch, WebSocket handshakes, persistent restoration or login recovery. This source has not been compiled on the Windows development host.

Before default activation, test supported iOS baselines with an isolated controlled HTTPS fixture and persistent WebKit store. Verify Secure/HttpOnly/SameSite receipt for fetch and WSS, distinguish JSON from login HTML, test expiry/redirects and inspect Origin/Referer/Sec-Fetch-Site. Repeat after process termination, sign-out and host changes. Never use real account cookies. Keep remote UI default until those tests pass. See the [implemented pure static exporter](../../INSTALLED_UI.md) for separate build and synthetic renderer evidence.
## Native navigation guard evidence

The origin test also clicks a synthetic anchor and cancels it in the public navigation delegate before any request. The delegate logs and asserts the inputs used by `HubConnectionViewController`. These are expected values, **not newly observed Mac/iPhone results**:

| Public API | Expected value |
| --- | --- |
| `webView.url`, JavaScript `location.href`, `document.baseURI` | `https://installed-ui-probe.invalid/` |
| JavaScript `location.origin` | `https://installed-ui-probe.invalid` |
| `navigationAction.sourceFrame.request.url` | `https://installed-ui-probe.invalid/` |
| `navigationAction.request.url` | `https://installed-ui-probe.invalid/navigation-guard-probe` |
| Source and target `isMainFrame` | `true` |
| `navigationType == .linkActivated` | `true` |
| Source `securityOrigin` protocol, host, port | `https`, `installed-ui-probe.invalid`, `0` (implicit default port) |

A usable base URI does not establish the native frame request URL. A mismatch must fail the probe and be reviewed against the guard. Do not normalize away `about:blank`, a missing URL, or a different origin to make the test pass. The cancelled navigation must leave the web view at its original URL.

## Isolated authenticated HTTPS/WSS transport

Run separately on the same graphical Mac, with `python3` and `openssl` on `PATH`:

```sh
HUB_RUN_WEBKIT_PROBE=1 HUB_RUN_WEBKIT_TRANSPORT_PROBE=1 swift test --package-path mobile/probes/InstalledUIOrigin
```

`Fixtures/transport.py` binds only `127.0.0.1` on an ephemeral port and generates a one-day certificate with an IP subject alternative name in a temporary directory. `TransportTests.swift` accepts only that exact certificate's DER bytes at that exact loopback port, inside its own navigation delegate. It never installs a root, changes the trust store, relaxes production TLS, or contacts HUB/Cloudflare. The subprocess and temporary certificate/key directory are removed on normal test completion. Interrupted tests may leave a `hub-origin-probe-*` temporary directory containing only synthetic fixture keys and startup metadata.

The actual WebKit document uses `loadHTMLString` with this HTTPS base, nonpersistent storage and CSP restricted to that single HTTPS/WSS origin. It must receive a synthetic `Secure; HttpOnly; SameSite=Strict` cookie from HTTPS, include it in same-origin fetch and WSS, exclude it from `document.cookie`, then reject authenticated operations after expiry. Assertions check JSON content type/status, fetch Referer and Sec-Fetch-Site, WSS Origin and received cookies. Synthetic header observations are printed for review; GET fetch may omit Origin. Each request has a bounded timeout. A self-signed WSS failure fails the test; it is not permission to install the certificate or disable WebKit TLS checks.

Windows protocol smoke, without OpenSSL, TLS, WebKit or browser cookie semantics:

```sh
python mobile/probes/InstalledUIOrigin/Fixtures/test_transport.py
```

Its two tests verify the loopback fixture's JSON/cookie/expiry contract and WebSocket handshake/frame encoding. They passed on Windows. **The added Swift navigation and transport probes remain uncompiled and unexecuted here.** A macOS pass would cover that WebKit build only; physical iPhone behavior, persistent restoration, sign-out, host changes and login/redirect recovery still require separate acceptance.

## Actual exported renderer in macOS WebKit

CI can supply the complete static document generated by `export-installed-ui.mjs`:

```sh
HUB_RUN_WEBKIT_PROBE=1 \
HUB_INSTALLED_UI_DOCUMENT_PATH=/absolute/path/to/document.html \
HUB_INSTALLED_UI_EVIDENCE_DIR=/absolute/path/to/evidence \
swift test --package-path mobile/probes/InstalledUIOrigin
```

`RendererTests.swift` loads those exact exported HTML bytes with only a test CSP inserted before the first script. It uses a 390×844 `WKWebView`, an iPhone-like user agent ending in `HUBiOS/0.2`, a reserved `.invalid` HTTPS base, and a fresh nonpersistent store. CSP denies all connections and external resources; the navigation delegate also cancels subsequent navigations. Inline/blob scripts and inline/data/blob styles/assets can execute from the actual export. The test supplies no replacement UI, session, native bridge, account state, request responses or product DOM.

After `didFinish`, it waits up to 30 seconds for the real `[data-hub-home-nav]` seam. It records viewport, origin/href, actual available composer/control rectangles and visibility, root child count, script errors and bounded empty/offline body text. If a compact composer and all three controls exist in this offline state, assertions require a thin card and menu → voice → Send ordering. Missing controls are reported as unavailable, not passed composer acceptance. Renderer mounting itself is required.

When an evidence directory is supplied, JSON metrics are written to `renderer-offline-webkit-390x844.json`, including mount failures. The test attempts a public `WKWebView.takeSnapshot` without creating a window. A nonuniform snapshot is saved as `renderer-offline-webkit-390x844.png`; an unavailable or blank snapshot is reported and omitted. Any saved PNG still requires visual review. The test does not claim iPhone execution, authentication, persistent storage, audio quality, or full composer acceptance from an offline empty renderer. This new Swift source has not been compiled or run on the Windows development host.
