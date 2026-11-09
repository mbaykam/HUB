# HUB iPhone development foundation

This is an isolated iOS development project. Its first connection screen opens
your existing HTTPS HUB in a persistent, unprivileged WebKit view. Sign in through
your existing access provider; no server or model-provider key is copied to the
iPhone. It is not yet a finished daily-use client: native background voice, Siri,
notifications and system sharing are still being implemented. Windows HUB and
its PWA continue to use their existing release.

## Connect a development build

Enter the root HTTPS address of your HUB, without a login token or extra path.
Complete the existing sign-in screen. The app checks the authenticated HUB voice
status endpoint and shows **Connected** only after receiving its expected response.
An Access login page or an HTTP200 HTML response does not count as a connection.
Your sign-in cookies stay in this app's persistent WebKit store. Reopening the app
uses the saved server address and existing web state; expired sessions still need
sign-in. Server passwords and cookies are never stored in app preferences.

The top-right connection menu offers **Connection**, **Reload**, and **Sign out on
this iPhone**. Signing out clears the app's web sign-in cookies and closes its web
view, without deleting anything on the HUB server. External links open in a
separate browser sheet. Offline/TLS/login failures leave an explicit recovery
message and a way back to Connection. Foreground microphone/camera access uses
system prompts only after you choose those existing PWA features.

This connection slice needs simulator/device acceptance before release. It does
not make a web voice call survive screen locking; that requires the native audio
and transport work below. It also does not turn agent HTML into a native plugin.

## Prepare from Windows or macOS

Use Node 24+ and pnpm 11.7.0. From the repository root:

```sh
pnpm --dir mobile install --frozen-lockfile --ignore-scripts
pnpm --dir mobile ios:prepare
pnpm --dir mobile check
```

The iOS workspace has its own lockfile and dependencies. Preparing copies only
the bundled development page and renders the shared HUB SVG brand into an opaque
1024-pixel icon. It syncs the committed Xcode project through Swift Package
Manager. No model caches, account settings, conversations, provider keys or HUB
vault files are copied. Keep `ios/App/App.xcodeproj` and its shared App scheme in
Git; generated web assets, dependencies and local Xcode state are ignored.

## Build without owning a Mac

In this repository's GitHub Actions, select **iOS simulator preparation**, then
**Run workflow**. The macOS build is manual and does not run for each HUB change. It
uses a hosted macOS runner, reads no Apple secrets, does not sign an iPhone build
and does not upload to TestFlight or the App Store. Review your repository's
Actions plan and usage before running it on a private repository.

Lightweight preparation/configuration checks run on Linux when the iOS sources
or shared icon change. The macOS compilation job runs only on manual dispatch.

The downloadable `HUB-ios-simulator-<commit>` artifact contains a ZIP preserving
the simulator app bundle. It is for an iOS Simulator on a Mac, not installation
on a physical iPhone. Download it within its seven-day artifact retention window.

On a Mac with current Xcode and an iOS Simulator SDK, run:

```sh
pnpm --dir mobile ios:build:simulator
```

To edit the project in Xcode, open `mobile/ios/App/App.xcodeproj`. Builds use the
shared `App` scheme. Native development version 0.1.0 is separate from the current
Windows host version. The pinned Capacitor 8 toolchain requires Xcode 26 or later;
see the [official environment setup](https://capacitorjs.com/docs/getting-started/environment-setup).

## Before the first iPhone / TestFlight build

The account owner completes these steps in Apple Developer / App Store Connect:

1. Enroll in the Apple Developer Program and select the intended team.
2. Confirm the bundle identifier. `com.mbaykam.hub` is provisional; its availability
   and registration have not been checked. Register the final explicit App ID.
   If it changes, update `capacitor.config.json` and both Xcode target build
   configurations together; `pnpm check` detects a mismatch.
3. Create the App Store Connect app record and configure signing/provisioning for
   that identifier. Use a Mac/Xcode or a chosen hosted signing workflow.
4. If automated upload is wanted, authorize a suitably scoped App Store Connect
   API key and a protected signing workflow. Store private keys/certificates in
   approved encrypted secret storage, never Git or a chat. There is no upload
   workflow or Apple credential installed by this preparation.
5. Finish the native integration below, review its permissions/privacy reporting,
   then build a signed archive, upload it and install it through TestFlight.

Apple's [TestFlight guide](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
describes beta distribution and its 90-day build lifetime. An unsigned simulator
build is not evidence of iPhone, background audio or distribution acceptance.

## Native work to start next

1. Implement authenticated connection and session restoration to the existing HUB
   host. Preserve its authentication and add explicit client/server compatibility
   handling. Reuse the PWA screens through a deliberate trusted-client integration.
2. Implement native audio capture/playback, echo control, Bluetooth routing,
   interruptions, screen locking and reconnecting. Continue using the selected
   providers; moving to native does not itself change speech recognition accuracy.
3. Add native push registration/delivery and task/chat deep links. Then camera,
   photo/file selection and the iOS Share extension, with permissions requested
   only when their implemented feature is used.
4. Test physical-device lifecycle, weak/offline connections, microphone/camera
   denial, phone calls, closing/reopening, task continuity, data preservation,
   privacy and power use before calling this a daily-use iPhone client.

The remote HUB view is a plain `WKWebView`, with no Capacitor bridge or script
message handlers. The unused bundled bridge configuration remains restricted to
bundled trusted content: no `server.url`,
cleartext remote connection or broad navigation allowlist. Do not turn the
remote PWA or agent-created HTML into a privileged native bridge page. Generated
visuals need a separate sandbox; device access must remain explicit and scoped.
The development page's CSP denies network connections until the authenticated
connection is implemented and its allowed origins are deliberately configured.

Use the [Capacitor iOS](https://capacitorjs.com/docs/ios) and
[Swift Package Manager](https://capacitorjs.com/docs/ios/spm) guidance when
extending the project. Keep the PWA as a working fallback during development.
