# iPhone acceptance before release

The native client remains in development. Compilation, protocol fixtures and a
simulator launch are different kinds of evidence; none proves physical voice,
Lock Screen or Apple delivery behavior. Do not publish an iPhone-ready download
until the relevant workflows below are accepted.

| Workflow | Source behavior to preserve | Acceptance still required |
| --- | --- | --- |
| Connection | Existing HTTPS HUB/Access sign-in; HTML login never counts as connected; no privileged bridge on remote pages | Sign in on the intended iPhone, reopen, expire access, reconnect and sign out; server data/settings stay intact |
| Saved access | Origin-scoped, device-only Keychain; cookie expiry and first unlock after reboot apply | Actual Keychain protection, first-unlock failure/recovery and expired sign-in |
| Native voice | One owned WebRTC call; stable admission receipt and same-session recovery | Two-way audio, physical echo/interruption, long calls, weak/offline network, Bluetooth/route changes and phone-call interruption |
| Background | Native audio session; configured local wake path runs on the HUB host, not an on-phone offline engine | Lock/unlock, background/foreground, wake accuracy, resume latency and power; record actual durations rather than claiming all-day reliability |
| Voice entry | Home Speak requests a native confirmation; native UIKit owns the microphone; Safari keeps web voice | Real WK main-frame navigation, Cancel, microphone denial and no duplicate call; agent frames/parameters cannot start native audio |
| Siri | iOS18+ recording intents and visible Live Activity; verified saved access and prior mic permission | Locked invocation, existing/background-call wake, dismissal/end, interruption and recovery; eight-hour Live Activity bound stays explicit |
| Notifications | Opt-in, host-only Apple credentials, generic content, versioned revoke/register and known-session links | Signed sandbox/production provisioning, actual delivery, denied permission, token refresh, offline revoke and authenticated tap navigation |
| Files / Share | Explicit selection/destination; original retention; retry receipts; normal composer Send starts work | Real Files/Photos providers, image formats including HEIC, interrupted transfer, wrong conversation/server and voice continuity; unsupported formats remain honest |
| Local recovery | Bounded inbox/outbox, visible old/damaged/orphan copies, explicit local removal/copy only | Recover after process loss and full capacity without starting a microphone or losing selected originals |
| Screen content | iOS27 system picker, memory-only bounded recent frame, frozen review and explicit Send | Actual selected content, timing after returning from another app, permission/stop/lock behavior and audio continuity |

The current screen-content implementation shares reviewed snapshots. It does
not provide continuous remote screen viewing or automatic continuous vision.
Do not treat those as equivalent, or infer capture availability from a simulator
SDK that omits ScreenCaptureKit. The account owner's actual iOS version must be
checked before deciding whether an older-OS capture path is required.

## Evidence to retain

- The source commit, targeted behavior/security tests and real macOS build result.
- For capture, the actual iPhone SDK branch and weak framework linkage, separately
  from the simulator build. An unsigned device archive cannot be installed as-is.
- For first launch, the original trusted simulator build/run identity, fresh
  simulator proof and inspected screenshot. This proves startup UI only.
- For physical tests, the device/iOS/build, steps, actual result, recovery and
  limitations. Do not label emulation, mocked audio or fixtures as physical tests.
- Before rollout, the matching host/PWA update, rollback backup, installed/served
  file/version comparison, final health and preserved data/settings. Never restart
  an active user task/call. An older host must fail with actionable recovery.

## Account and distribution gates

The current IDs (`com.mbaykam.hub`, `.voice-widget`, `.share` and
`group.com.mbaykam.hub`) are development choices, not proof of registration.
The account owner must select the team and final IDs, provision all three targets
and the App Group, configure Apple notification delivery when wanted, and install
a signed build. Keep certificates/keys in approved secret storage; never ask for
passwords or private keys in a chat or commit them to Git.

Review purpose strings, first-/third-party privacy manifests, actual configurable
host/provider data flows and App Store privacy disclosures before submission.
An empty data-collection manifest or a successful build does not prove that the
app collects no information. Simulator smoke checks configure no user account,
server, microphone, notification token or model provider.
