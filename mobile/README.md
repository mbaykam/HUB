# HUB iPhone development foundation

This is an isolated iOS development project. Its first connection screen opens
your existing HTTPS HUB in a persistent, unprivileged WebKit view. Sign in through
your existing access provider; no server or model-provider key is copied to the
iPhone. It is not yet a finished daily-use client: native voice is in development
and requires device acceptance; Siri/Live Activities are also development-only,
and notifications and system sharing are still being implemented. Windows HUB and
its PWA continue to use their existing release.

## Connect a development build

Enter the root HTTPS address of your HUB, without a login token or extra path.
Complete the existing sign-in screen. The app checks the authenticated HUB voice
status endpoint and shows **Connected** only after receiving its expected response.
An Access login page or an HTTP200 HTML response does not count as a connection.
Your sign-in cookies stay app-private. WebKit keeps the web session; after HUB
verifies the connection, its origin-scoped authentication cookies are also saved
in this iPhone's Keychain for native background actions. This device-only copy
does not sync, respects cookie expiry, and expires after at most24hours without
a fresh verified session. After reboot it is unavailable until the first unlock.
Reopening uses the saved server address and existing web state; expired sessions
still need sign-in. Passwords and cookies are never stored in app preferences.

The top-right connection menu offers **Connection**, **Reload**, and **Sign out on
this iPhone**. Signing out clears native saved access and web sign-in cookies, and closes its web
view, without deleting anything on the HUB server. External links open in a
separate browser sheet. Offline/TLS/login failures leave an explicit recovery
message and a way back to Connection. Foreground microphone/camera access uses
system prompts only after you choose those existing PWA features.

This connection slice needs simulator/device acceptance before release. It does
not make a web voice call survive screen locking. Use the separate native Voice
entry below for that development path. Agent HTML has no native plugin access.

## Native voice development path

After the connection is verified, choose **Voice** in the native top bar. It
requests the microphone, admits one call through the existing HUB control plane,
and uses native WebRTC audio with the existing SmallWebRTC/RTVI server. The same
configured voice character, speech providers and saved conversation system stay
on the server. No extra hosted voice provider or phone-side model key is needed.

The voice sheet has **Mute**, **Interrupt**, **End conversation**, and an overflow
menu with **Reconnect audio**. **Hide** returns to HUB while keeping the call
owned by the app. It also remains owned when the app backgrounds; the audio
session uses voice-chat mode and the declared audio background capability.
Ending during admission waits for the owned receipt to finish and closes it;
failed cleanup keeps an explicit retry instead of pretending the call ended.
Reconnect uses the owned call, without resubmitting a user task or creating a
second conversation. Existing web/Telegram calls block a second native call.

After an interrupted app process, **Voice** offers **Resume last conversation**
or **Start new conversation**. A device-only Keychain receipt identifies the
original conversation and owned call. Rejoining requires the current server call
to match both IDs; another phone/browser's call is never adopted or ended. If
the old call has ended, resume opens a new audio connection to the same saved
conversation. If startup was interrupted before a peer ID was received, the
screen offers explicit cleanup through **End** before resuming. The microphone
does not restart merely because you reopen the app. This recovery path still
needs real-device end-to-end acceptance.

Startup also saves its admission receipt before sending the request. If the app
closes before receiving the response, Voice offers **Recover startup** and reuses
that exact receipt. It never silently starts another chat to recover a lost
response. A confirmed expired/ended receipt clears the recovery prompt; a network
or sign-in failure leaves it available to retry. Microphone permission delays
use a refreshed server clock before a new admission.

Transport dependency: WebRTC134.0.0, pinned by exact SwiftPM version and the
upstream binary checksum. Its BSD notices are included in the app bundle. Native
HTTP signaling refuses redirects and limits cookies to the selected HTTPS host.
Web pages cannot invoke these native controls. The data channel uses the public
[Pipecat SmallWebRTC protocol](https://github.com/pipecat-ai/pipecat-client-ios-small-webrtc).

**Not yet accepted on a physical iPhone:** bidirectional audio, lock-screen
continuity, route changes, Bluetooth, acoustic echo/interruption, reconnect,
long conversations and battery behavior. Simulator compilation and fixture
protocol/control tests do not prove those outcomes. This is development code,
not a published voice-quality or all-day-background guarantee.

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

### Siri and the Lock Screen in development

On iOS18 or later, the app declares **Talk to HUB** and **End HUB voice** Siri/App
Shortcuts. First open HUB, connect, and start native Voice once to grant microphone
permission. Siri uses device-only verified access without opening remote web UI;
it cannot prompt for first-time microphone permission while locked. Rebooting
requires the first device unlock before saved access becomes available.

Siri recording requires Live Activities enabled. A WidgetKit extension shows
generic voice/mute status on the Lock Screen and Dynamic Island, without your
transcript, server address or conversation contents. Ending voice removes it.
The system's recording intent requires this activity to remain active. If iOS
ends or dismisses it, a Siri-started call stops and retains conversation history;
it does not silently create another activity. Apple limits one Live Activity to
eight active hours, so this path is not an unlimited all-day-session guarantee.
An explicit new voice/Siri action can resume the saved conversation.

### Notification backend development

The host now has an opt-in native device registry and durable Apple notification
queue. It emits generic task/goal/automation completion or failure alerts with
an origin-bound conversation destination, without sending result text to the
Lock Screen. Retries retain the same Apple notification ID; versioned device
registration prevents a late request from undoing a sign-out or newer choice.

Apple delivery configuration is host-only: `APNS_TEAM_ID`, `APNS_KEY_ID`,
`APNS_TOPIC`, and `APNS_PRIVATE_KEY_P8` are resolved through the native credential
store. The Apple signing key never belongs in the iPhone bundle, chat or Git.
The sender supports development/production Apple endpoints, not arbitrary URLs.
No configuration, registration or Apple request has been made on your real host.
The native permission/registration UI and signed-device delivery acceptance are
still being connected; this backend alone is not a finished notification feature.

The base app still targets iOS15; Siri recording and the widget require iOS18.
These are compiled development paths. **Actual Siri invocation while locked,
Live Activity lifetime, system interruptions and physical audio are unverified.**
No signed iPhone build or App Store availability is implied.

The account owner completes these steps in Apple Developer / App Store Connect:

1. Enroll in the Apple Developer Program and select the intended team.
2. Confirm the bundle identifier. `com.mbaykam.hub` is provisional; its availability
   and registration have not been checked. Register the final explicit App ID.
   Also register the extension identifier `com.mbaykam.hub.voice-widget`. If the
   app ID changes, update `capacitor.config.json` and both configurations of the
   app and widget targets together; `pnpm check` detects a mismatch.
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

1. Validate authenticated connection/session restoration and client compatibility,
   including expired access and interrupted admission. Keep existing auth gates.
2. Accept native audio, same-conversation recovery, echo control, Bluetooth,
   interruptions and screen locking on an actual iPhone. Continue using selected
   providers; native alone does not improve the speech model's recognition.
3. Add Siri/App Intents with correct lock/microphone policy, then native push
   delivery and task/chat links. Finish native file/Share and screen sharing,
   requesting permissions only when their actual feature is used.
4. Test physical-device lifecycle, weak/offline connections, microphone/camera
   denial, phone calls, closing/reopening, task continuity, data preservation,
   privacy and power use before calling this a daily-use iPhone client.

The remote HUB view is a plain `WKWebView`, with no Capacitor bridge or script
message handlers. The unused bundled bridge configuration remains restricted to
bundled trusted content: no `server.url`,
cleartext remote connection or broad navigation allowlist. Do not turn the
remote PWA or agent-created HTML into a privileged native bridge page. Generated
visuals need a separate sandbox; device access must remain explicit and scoped.
The dormant bundled development page remains offline. Connected HUB screens use
the separate unprivileged HTTPS web view and the normal server access gate.

Use the [Capacitor iOS](https://capacitorjs.com/docs/ios) and
[Swift Package Manager](https://capacitorjs.com/docs/ios/spm) guidance when
extending the project. Keep the PWA as a working fallback during development.
