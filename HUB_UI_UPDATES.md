# Lightweight PWA updates

UI-only updates no longer need to replace the Windows application. A one-time
host installation adds the loader; later updates are compressed `.hub-ui`
packages, activated locally and picked up when the PWA is refreshed.

## What can change

- HUB's PWA overlay, styles, mobile settings, drawers, home and conversation UI.
- The lazy-loaded knowledge graph and browser voice client.

Host APIs, memory services, model plugins, Python speech services, desktop code,
the underlying Harness UI, and the sandboxed presentation renderer still need
a normal host update. The compatibility fingerprint intentionally rejects UI
packages built for a different host/runtime contract.

## Build and activate

Use Node 24 from the project root. Build and test before packaging:

```powershell
node scripts/harness/build-product-packages.mjs
node --test tests/ui-update.test.mjs
node scripts/harness/ui-update.mjs pack --label "Mobile UI 01" --out C:/Builds/mobile-ui-01.hub-ui
```

The pack command prints the compressed package's SHA-256, its release ID, size,
and host compatibility. It accepts a fixed list of browser artifacts and graph
license notices, not an arbitrary directory. It refuses to overwrite an output.

Obtain `ui-host.json` from the **installed target host's** overlay `lib` folder.
Do not substitute the candidate build's metadata to force a compatibility match.
Confirm the same compatibility through authenticated `GET /api/hub/ui/status`
on the actual running PWA before activation.

If installed-file inspection is unavailable or stale, use
`--host-compatibility VERIFIED_LIVE_COMPATIBILITY` instead of `--host-manifest`.
Take this value from that authenticated live status response, not from the
candidate package. This avoids depending on an installer path to apply later
UI updates. Only the host with that exact identity will read the activated store.

```powershell
node scripts/harness/ui-update.mjs activate --host-manifest C:/Path/To/Installed/Overlay/lib/ui-host.json --package C:/Builds/mobile-ui-01.hub-ui --sha256 SHA_PRINTED_BY_PACK
```

Activation writes only to the current user's `.dsh/hub-ui-updates/<compatibility>`
directory. It does not stop HUB, replace its installed files, change a shortcut,
or touch chats, memory, credentials, or plugin configuration. Existing tabs stay
on their loaded release, including their later graph and voice imports.

On the phone, open **Settings → Check UI update → Reload to apply** after ending
any call and saving drafts. No forced refresh or background update is performed.
You can also close and reopen/refresh the PWA. Check the served status afterward;
an on-disk package alone does not prove which host or browser is running it.

## Rollback and recovery

```powershell
node scripts/harness/ui-update.mjs status --host-manifest C:/Path/To/Installed/Overlay/lib/ui-host.json
node scripts/harness/ui-update.mjs rollback --host-manifest C:/Path/To/Installed/Overlay/lib/ui-host.json
node scripts/harness/ui-update.mjs builtin --host-manifest C:/Path/To/Installed/Overlay/lib/ui-host.json
```

`rollback` selects the previous release (which can be the built-in UI).
`builtin` explicitly recovers the installed UI even if the activation pointer is
corrupt. Refresh afterward. Retained releases are not automatically deleted,
because an older open tab may still need their assets. A crashed activation can
leave an `activation.lock` directory: inspect the process and store before
manually clearing this lock; the updater deliberately does not steal locks.

The host falls back to its built-in UI when an override cannot be validated.
A failed download or syntax error before the override factory registers also
leaves the built-in factory selected. Runtime bugs after registration require
explicit rollback; there is no claim that a checksum proves a healthy UI.

## Trust and testing

Only activate locally built, reviewed packages. SHA-256 and Subresource Integrity
detect mismatches/corruption; **they are not publisher signatures**. There is no
remote upload/install endpoint, arbitrary download URL, public update feed, or
automatic GitHub release publishing. Asset/status routes retain Harness browser
authentication, deny cross-site requests and accept GET only. Package activation
is a same-user local administration operation; downloaded JavaScript has the
same trust level as installing application code.

For isolated tests, use the CLI's `--store DIRECTORY` and set the test host's
`HUB_UI_UPDATE_ROOT` to the same directory. Normal usage needs neither override.
The release pointer changes by same-directory atomic rename after complete
validation. Rollback retains the previous version; it does not label it healthy
until functional checks have passed.

Tests cover rejected host versions, allowlist/path attacks, checksums, incomplete
packages, concurrent activation, corrupt-pointer recovery, desktop factory
fallback, authenticated HTTP serving and pinned lazy assets. The packaged smoke
test uses a disposable Harness profile. Set `HUB_UI_QA_PLAYWRIGHT` to the local
Playwright module path to also exercise real PWA activation, refresh, rollback
and recovery in Chromium and WebKit. This does not replace physical iPhone QA.
