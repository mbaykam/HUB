# HUB iPhone development foundation

This is an isolated iOS development project. Native Home opens first. Sign in to
your existing HTTPS HUB through its access provider in an unprivileged WebKit
view. Server and model-provider keys stay on HUB. Native voice is in development
and requires device acceptance; Siri/Live Activities are also development-only,
and notifications and system sharing require the matching host configuration and
physical-device acceptance described below. Windows HUB and
its PWA continue to use their existing release.

## Native Home

The iPhone opens a fresh SwiftUI Home and editable chat field before checking
the network. A single connection status handles setup, sign-in and reconnect.
After authentication, Knowledge, the planner and recent chats load in parallel.
The current draft stays in memory while the app is open. Reopening starts fresh.

Send creates a conversation and submits the text through HUB's existing
authenticated chat API. An uncertain response keeps the draft and links to the
conversation so you can check delivery. Open a recent or workspace conversation
from the left panel. Settings, Knowledge and Tasks open from the right panel.
The app records time to native Home and time
to live Home data separately in the local HomeLaunch log category.

## Installed interface

The matching development build includes the actual renderer, styles/fonts and
lazy graph/voice assets from a fixed product profile. The installed web renderer
remains available to the connection recovery code. The ordinary workspace
opens in SwiftUI. It starts without a previous screen, chat or draft snapshot.
Data still comes from HUB; opening the interface alone does not run an assistant.
Network requests and stream creation wait for the authenticated compatibility
check. Expired sign-in opens the existing HTTPS authentication flow. Canvas and
HTML apps render in an isolated document view.
The view has no Capacitor bridge or native script message handler.

The public `HubWebView.inputAccessoryView` override removes WebKit's form toolbar;
the regular keyboard and existing web editor remain. A separate keyboard probe
compares default and product WebKit views on a disposable simulator, including
real keyboard presentation and English/Turkish input. Device acceptance still
needs the intended iPhone and keyboard settings.

See [installed UI build/verification](INSTALLED_UI.md) and
[real keyboard checks](probes/KeyboardAccessory/README.md) for the evidence scope.

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

Native Home uses a compact connection row when there is a status to show.
**Settings → iPhone settings** offers **Voice**, **Files**, **Notifications**,
**Connection**, **Refresh HUB**, and **Sign out on this iPhone**. Offline/first-connect
recovery retains explicit Connect/Retry actions and controls for an active call.
Signing out clears native saved access and web sign-in cookies, and closes its web
view, without deleting anything on the HUB server. External links open in a
separate browser sheet. Offline/TLS/login failures leave an explicit recovery
message and a way back to Connection. Foreground microphone/camera access uses
system prompts only after you choose those existing PWA features.

The native connection source now checks the page when the app returns to the
foreground. A blank/unresponsive page has an eight-second recovery deadline;
an opening page has twenty-five seconds, with native Retry, Connection and
active Voice controls available. Main-page HTTP errors and failed WebKit loads
also expose recovery. Healthy pages are inspected without reloading drafts;
backgrounding cancels the deadline, and stale navigation callbacks cannot
replace a newer page. Cold launch/reopen, expired login and process-loss
recovery still require acceptance on the intended iPhone.

This connection slice needs simulator/device acceptance before release. It does
not make a web voice call survive screen locking. Use the separate native Voice
entry below for that development path. Agent HTML has no native plugin access.

## Native voice development path

The compact mobile composer shows **Chat…**, **More actions**, **Speak** and
**Send**. More actions contains attachments, characters, research, commands and
chat settings. An active native call keeps **Open voice** reachable from HUB.
Ended native calls offer **Resume conversation**, instead of disabled controls.
Final user transcripts containing an explicit short end-call request (for
example “Vera, sesi kapat” or “End the call”) close only this phone's owned call;
assistant speech, negatives and quoted examples are excluded. This control does
not depend on the language model having a hangup tool. Device speech acceptance
is still required. UIKit input-assistant groups are cleared using public APIs;
the actual iPhone keyboard accessory appearance must be checked on device.

After the connection is verified, choose **Speak** in HUB's existing composer, or
**Settings → iPhone → Voice**. It
requests the microphone, admits one call through the existing HUB control plane,
and uses native WebRTC audio with the existing SmallWebRTC/RTVI server. The same
configured voice character, speech providers and saved conversation system stay
on the server. No extra hosted voice provider or phone-side model key is needed.

Inside the iPhone wrapper, Home's **Speak** directly opens native Voice and
starts audio after the explicit tap, without another start-confirmation popup.
A fixed same-origin root link
may request that UI only from the main HUB page; it carries no session, call ID,
credentials or commands. Only a user-activated main-page link can request the
native start flow; the iPhone's microphone permission still applies. Agent frames,
redirects, extra parameters and unverified connections cannot request it.
This is tightly scoped user navigation, not a privileged JavaScript bridge.

The wrapper identifies itself through a nonprivileged `HUBiOS` user-agent hint;
ordinary Safari/PWA keeps its browser voice flow. Native WebKit microphone
requests are denied, including on older PWA builds, with guidance to use **Voice**
through HUB's Speak entry. Native Voice owns microphone permission/audio instead. Normal
main-page camera-only requests retain the standard permission prompt; agent
frames still cannot use capture. This avoids accidentally choosing web audio
that cannot provide native lock-screen continuity. Actual phone acceptance is
still required; the hint and navigation are not authentication or authorization.

The voice sheet has **Background listening / Resume conversation**, **Mute**,
**Interrupt**, **End conversation**, and an overflow
menu with **Reconnect audio**. **Hide** returns to HUB while keeping the call
owned by the app. It also remains owned when the app backgrounds; the audio
session uses voice-chat mode and the declared audio background capability.
**Voice options → Open conversation** opens that owned conversation in HUB's
normal chat view, so you can read its history and existing visual/file results
while native audio continues. Pending startup cannot accidentally open an older
chat; navigation checks the same original HUB and authenticated conversation list.
Ending during admission waits for the owned receipt to finish and closes it;
failed cleanup keeps an explicit retry instead of pretending the call ended.
Reconnect uses the owned call, without resubmitting a user task or creating a
second conversation. Existing web/Telegram calls block a second native call.

Background listening uses the server's existing local wake-word path and configured
wake phrase; it does not add a hosted model or keep Soniox recognition running in
that mode. Owned health checks update the native display after automatic idle or
wake changes, without fetching ambient transcripts. A mode change is confirmed by
the server before the control claims success. Siri **Talk to HUB** on an already
active conversation resumes its foreground listening instead of admitting another
call. The microphone still reaches the existing Windows voice host for local wake
detection; this is not an on-iPhone/offline wake engine. These transitions and
latency still require physical iPhone acceptance.

After an interrupted app process, **Speak** rejoins a still-owned active call.
When that old call has ended it starts a new conversation; only the ended voice
screen's explicit **Resume conversation** keeps the old conversation.
A device-only Keychain receipt identifies the
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
For an older call's draft, **Copy to current conversation** explicitly prepares a
new draft with fresh receipt IDs, on the same HUB. It keeps the older draft and
its original ownership intact. Review and **Send** remain separate actions;
capacity limits still apply and no file is silently moved or deleted.
Uploads are foreground operations; interruption can require an explicit retry.
If preparation stopped before a conversation receipt was saved, an **Interrupted
preparation** section exposes that local copy. It cannot be uploaded to an
invented conversation. Explicitly removing the unfinished copy frees its slot;
HUB does not silently delete these copies or alter the original selected file.

This is a development slice. Files-provider behavior, permissions, screen locking,
slow connections and physical audio continuity during file selection still need
iPhone acceptance. A native camera/photos sheet is separate remaining work;
the system-share/text destination below and screen sharing have their own
development paths. Existing PWA file
and camera controls keep their current behavior without a native JS bridge.

### Files without a voice conversation

The connection menu's **Files** opens the local system-share inbox without
starting a microphone or assistant. Choose a saved file, search your existing
conversations by title, and confirm **Prepare message**. This uploads the original
to that exact HUB conversation and opens its normal composer with a separate
**Add to message** confirmation. Your existing text stays intact; only pressing
the ordinary **Send** starts assistant work. Images use the composer's normal
image path, with its existing format and size checks.
The review shows the verified filename and size first. Reading this metadata
does not download the original, attach it or start an assistant; those steps
still require your separate choices.

The inbox accepts up to eight nonempty files of 10 MB each, including explicitly
selected originals from Files. This inbox is separate from the 25 MB voice/PWA
upload limit. A prepared copy remains origin/conversation-bound in the private
outbox so response loss can retry the same upload receipt. Reopening never
silently resends a chat message. After sending in HUB, explicitly remove its
local prepared copy to free a slot; no JavaScript bridge acknowledges/deletes
native files. Swipe an unassigned inbox copy to review removal. Removing a local
copy does not delete the original in another app or on HUB.

**Prepared copies** also exposes old voice-call copies and copies from another
HUB, so they cannot silently occupy all eight outbox slots. Same-HUB copies may
be explicitly copied into a chosen text conversation with fresh receipts; their
older ownership stays intact. Another HUB's copies allow only local review/removal,
never upload through the current connection. **Interrupted preparation** exposes
payloads with missing or unreadable receipts. They cannot be sent or silently
discarded; explicit removal frees capacity without touching selected originals.
A malformed receipt does not hide other healthy copies. No voice startup is
required to recover local capacity.

The conversation catalog and upload-receipt handoff require the matching host
and PWA source update; older hosts fail with a recovery message. These changes
check the exact uploaded receipt before opening a handoff, including on retries.
They
are development source, not an update to the installed Windows/PWA release yet.
Signed App Group provisioning, Share/Files providers, image handling and actual
phone UI/audio continuity still require device acceptance.

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

The separate manual **iOS simulator first launch** check can reuse that existing
artifact without rebuilding. Supply its successful manual build run ID and exact
40-character commit. It accepts only this repository's trusted `main` iOS build,
checks artifact identity/expiry, clones a shutdown runner-provided iPhone seed
into an isolated simulator, boots it, installs
and launches HUB, checks that the process remains alive, and saves the initial
screen and a provenance JSON. The provenance identifies the cloned baseline;
this is not a claim of a factory-fresh OS. The original runner seed stays intact.
It removes only its newly created CI simulator.
No sign-in, microphone, server or Apple account is configured. Inspect the saved
screen: successful launch is distinct from signed-device or voice acceptance.

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
   Also register `com.mbaykam.hub.voice-widget`, `com.mbaykam.hub.share`, and
   App Group `group.com.mbaykam.hub`. If the
   app ID changes, update `capacitor.config.json` and both configurations of the
   app, widget and Share targets and their App Group entitlements together;
   `pnpm check` detects a mismatch.
3. Create the App Store Connect app record and configure signing/provisioning for
   that identifier. Use a Mac/Xcode or a chosen hosted signing workflow.
4. If automated upload is wanted, authorize a suitably scoped App Store Connect
   API key and a protected signing workflow. Store private keys/certificates in
   approved encrypted secret storage, never Git or a chat. A disabled, manual-only
   signing/archive/upload handoff is prepared in [SIGNING.md](SIGNING.md). It has
   not signed or uploaded with real credentials; no Apple credential is installed.
5. Finish the native integration below, review its permissions/privacy reporting,
   then build a signed archive, upload it and install it through TestFlight.

Apple's [TestFlight guide](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
describes beta distribution and its 90-day build lifetime. An unsigned simulator
build is not evidence of iPhone, background audio or distribution acceptance.

## Acceptance still required

1. Validate authenticated connection/session restoration and client compatibility,
   including expired access and interrupted admission. Keep existing auth gates.
2. Accept native audio, same-conversation recovery, echo control, Bluetooth,
   interruptions and screen locking on an actual iPhone. Continue using selected
   providers; native alone does not improve the speech model's recognition.
3. Accept the implemented Siri/App Intents, native push/task links and file/Share
   paths on a signed iPhone build. Accept both reviewed snapshots and explicit
   Live delivery/asked-for analysis; compiler evidence is not remote-viewing
   acceptance. Request permissions only when the
   actual feature is used.
4. Test physical-device lifecycle, weak/offline connections, microphone/camera
   denial, phone calls, closing/reopening, task continuity, data preservation,
   privacy and power use before calling this a daily-use iPhone client.

Use [ACCEPTANCE.md](ACCEPTANCE.md) to distinguish implemented source paths,
compiler/simulator evidence, remaining product behavior and physical/account gates.

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

The host's owned-call `/api/hub/voice/screen` transport is a development slice:
explicit start/stop receipts, bounded binary JPEG uploads and short-lived RAM
frames. Its status endpoint never returns image bytes. It does not start model
requests or save frames to the vault. Native capture now has separate **Review
frame / Live** choices. Live needs its own confirmation and Apple's picker;
only then does a stable consent receipt start frame delivery to the owned call.
The encoder produces at most one JPEG every two seconds. Slow transfers drop
frames; nothing queues or writes an outbox. Three transfer failures stop live
delivery, and Stop, closing, locking or losing the voice call cancels it. A lost
start response retries the same receipt; late completions cannot restart it.
An idle host consent expires after15seconds so process loss cannot block the
next explicit share indefinitely. Retained image bytes expire after5seconds.
The scoped `hub_view_screen` tool reads a single fresh frame when the user asks.
It requires the current call, the caller's existing tool permissions and an
image-capable current request model. A direct delegated worker is bound to the
original call and user request; unrelated, nested or older-call workers cannot
read the new stream. Each request/worker has at most three reads, spaced at least
three seconds apart. Text-only characters should delegate the question to an
already configured vision-capable character, without changing provider settings.
The user-selected live stream stays in RAM, but a frame deliberately requested
for analysis is retained as a normal conversation attachment and sent through the
configured vision model. The native confirmation explains this. These selected
frames do not use Knowledge's automatic original-upload archiving path. No image
is saved just because another frame arrived. Tool guidance is attached to the
active voice agent and eligible worker; user personality files are preserved.
This remains development code requiring actual capture-device acceptance. See
[acceptance gates](ACCEPTANCE.md).

Older hosts can still serve normal PWA/voice while lacking these newer native
routes. Live refuses missing routes or an HTML login/PWA fallback and offers
sign-in/update guidance; it never counts that response as accepted sharing.
Before iPhone rollout, deliver the matching host and PWA through the supported
update with a backup, no active user work, version/file checks and final health.
Do not copy only loose backend files into an older installed release.

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
makes no model requests. **Review frame** is a snapshot workflow; **Live** sends
ephemeral recent frames without automatic continuous vision. Verify the captured contents before sending, especially after returning
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

Packaging verification found that the current simulator SDK excludes the
`canImport(ScreenCaptureKit)` capture/review branch, even though the rest of the
app builds. The workflow now probes both device and simulator SDKs with a direct
import. The workflow described above is development source and is not available
in that simulator artifact; do not infer capture support from a green base-app
build. The preview workflow additionally compiles the capture-capable iPhone SDK branch
without signing. That path now creates an optimized **Release archive**, checks
its app/extension identities and rejects embedded profiles/private signing files
before packaging the app. The artifact includes `unsigned-device-proof.json`;
it does not export or upload an IPA. Its separate
`HUB-ios-device-unsigned-<commit>` artifact is compiler/archive evidence,
not an installable iPhone app. Device capture still needs signing and
physical acceptance.
