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

## Native voice files in development

In the native Voice sheet, open **Voice options → Share a file**. Choose an
original through Apple's Files picker, then tap the pending file to review it
and explicitly **Send to conversation**. The call keeps its existing microphone
and audio session while this separate screen is open. No file is uploaded merely
because it was selected. HUB retains the original only after sending; readable
content still depends on the file type and selected assistant/model.

A private outbox holds at most eight files of 25 MB each. Drafts are excluded
from backups, use iOS file protection, and preserve their original HTTPS server,
conversation, call and immutable upload/share receipt IDs. Lost responses retry
the same receipts rather than submitting duplicate instructions. A file from a
different or ended call is shown as such and cannot silently move into a new
conversation. Removing a local draft never modifies the selected source file.
Uploads are foreground operations; interruption can require an explicit retry.
If preparation stopped before a conversation receipt was saved, an **Interrupted
preparation** section exposes that local copy. It cannot be uploaded to an
invented conversation. Explicitly removing the unfinished copy frees its slot;
HUB does not silently delete these copies or alter the original selected file.

This is a development slice. Files-provider behavior, permissions, screen locking,
slow connections and physical audio continuity during file selection still need
iPhone acceptance. A native camera/photos sheet,
general text-conversation destination picker and screen sharing are separate
remaining work; this picker does not claim to implement them. Existing PWA file
and camera controls keep their current behavior without a native JS bridge.

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
The native connection menu now offers **Notifications**, with Enable/retry,
Turn off, and a link to iPhone Settings. It checks host support/configuration
before requesting system permission. A missing host endpoint asks for a host
update; sign-in, Apple registration and server delivery are separate states.
Registration is opt-in and tokens are refreshed through Apple's callbacks.
The device identifier and monotonic registration generation are origin-scoped
in the private Keychain; the device token is not saved in app preferences.

Turning off or signing out unregisters Apple notifications locally immediately
and attempts to revoke the host registration. Local sign-out is not blocked by
an offline server; the screen explicitly reports when server revocation could
not be confirmed. Re-enable/revoke generations prevent delayed requests undoing
the newer choice. A tapped alert checks its exact original HUB origin and signs
in at the root before opening a conversation from the authenticated catalog.
It never switches servers, starts a microphone or executes a task.

Debug/Release declare development/production push entitlements; actual signing
must use matching Apple provisioning. Apple push has not been configured or
tested on your real host/device. Simulator compilation and fake transport tests
are not signed-device delivery acceptance; notifications remain development-only.

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

## Privacy declaration in development

The first-party app bundles `PrivacyInfo.xcprivacy` for its own required-reason
API use: app-private server preferences (`CA92.1`), and file metadata inside its
container or for a file explicitly selected by the user (`C617.1`, `3B52.1`).
See Apple's [required-reason API reference](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitypereasons).
This is not a completed App Store privacy label or a claim that no information
is collected. Conversations, audio, files and device notification tokens can be
sent to your HUB and the configured speech/model providers when their features
are used. Audit provider behavior, embedded SDK manifests and the final signed
archive, then complete accurate collection/tracking declarations before submission.

## System Share files in development

The bundled **Save to HUB** Share extension accepts one selected file/photo at a
time, up to 10 MB, into an eight-item local inbox. It makes no network requests
and has no access to the app's private sign-in Keychain. It does not launch HUB
through private APIs. Open HUB yourself, start native Voice, then choose **Voice
options → Share a file → Saved from other apps**. Confirm the current HUB and
conversation, then review the pending file and choose Send. Links/text shares and
choosing an ordinary text-chat destination remain separate work.

App and extension declare `group.com.mbaykam.hub`; the account owner must register
that App Group and `com.mbaykam.hub.share`, and provision both targets with the
matching group. The inbox uses locked, atomic single-file commits with integrity
checks and device file protection, without credentials or an assumed destination.
Interrupted transfer into the voice outbox reuses the same receipt; it cannot
silently target another conversation. No automatic upload or model call occurs.
Physical Share-sheet/provider/signing and cross-app acceptance are still pending;
compilation and isolated two-instance fixture tests do not prove those outcomes.

## Screen capture integration in development

On an iOS27 development build compiled with the newer SDK, native **Voice options
→ Share screen** opens capture and review. Choose content in Apple's system
picker, visit what you want to show, then return to freeze a recent frame. Review
that exact image and explicitly Send it to the owned voice conversation. Freezing
stops capture; closing the screen or losing the voice owner also stops sharing.
A failed upload keeps a retryable receipt under Share a file. Nothing is sent by
starting capture, and capture adds no microphone or app-audio input.

The memory-only frame gate enforces consent generations, exact HUB/conversation/
call ownership, pause/stop invalidation, five-second capture-time expiry, JPEG
validation and bounded dimensions/bytes. Frozen review is a separately explicit
user-selected image, not a claim that an old frame is still live. Capture alone
makes no model requests. This is a snapshot workflow, not automatic continuous
vision. Verify the captured contents before sending, especially after returning
from another app; foreground-freeze timing requires physical device acceptance.

Apple recommends ScreenCaptureKit on iOS27 and deprecates ReplayKit broadcasting
there. The manual simulator workflow offers the standard **xcode-27** runner for
this development path; stable remains the default. Both toolchains compiled the
current core; the capture adapter/review UI requires the newer SDK. Older OS/SDK
builds do not expose the action. No release toolchain or installed app is silently
upgraded. The app declares elapsed-event timing reason35F9.1 to reject queued old
samples; raw system clock/boot information is not sent to HUB.

See [Apple's iOS capture sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-on-ios).
The picker, captured content, freeze timing, background audio, interruptions and
privacy behavior still need physical iPhone acceptance before release. Simulator
compilation does not prove those outcomes, and no signed iPhone build is implied.
