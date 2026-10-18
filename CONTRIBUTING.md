# Contributing to HUB

HUB is a Windows-first personal assistant, built on Minke and a pinned DeepSeek Harness runtime.
Start with [setup](docs/setup.md), configure an isolated development profile and
keep personal chats, vaults, models and credentials outside the checkout.

## Check a change

```sh
pnpm install --frozen-lockfile
pnpm harness:stage
pnpm typecheck
pnpm test:desktop
```

The test runner covers core, Harness, UI, host and native-service groups. Tests
normally use fixtures; real provider, microphone and phone tests are explicit
opt-ins. State which environment and acceptance path you actually verified.
File-symlink tests may skip on a Windows account without that OS privilege;
the source-check workflow runs on Linux to cover those filesystem cases.
The knowledge-assets suite also exercises real local PDF extraction. Install
`scripts/tests/requirements-media.txt` in the default Python runtime under
`~/.dsh/runtimes/pipecat`; the source-check workflow creates this isolated
environment explicitly. No speech models or provider accounts are needed.

Prefer behavior, rendered output and parsed artifacts over matching implementation
text. Preserve the source-assertion ratchet; lower its baseline when deleting
brittle assertions. Add new test files to the desktop test catalog.

## Where changes belong

- `desktop/`: Electron shell, process ownership and transport boundaries.
- `packages/harness-overlay/`: HUB's Host/client extensions, characters,
  knowledge and optional local speech pipeline.
- `packages/im-*`: independent message transports; `model-runtime` and
  `remote-access`: provider/service and connection integrations.
- `config/harness-runtime.json` and `patches/deepseek-harness/`: the runtime
  pin and small reviewed compatibility patches. Keep the vendored source clean.
- `docs/`: user-facing setup and operation. Follow `docs/AGENTS.md`; local
  `docs/research/` material is ignored and must not be force-added.

HUB's UI direction is dark Glassmorphism and gradient mesh; see
[UI_DESIGN_GUIDE.md](UI_DESIGN_GUIDE.md). Keep native session, permission and
audio ownership intact across visual changes. UI-only delivery follows
[HUB_UI_UPDATES.md](HUB_UI_UPDATES.md).

Use `node scripts/forge/set-version.mjs <version>` to align first-party package
versions. Network identifiers derive from those manifests rather than hardcoded
release strings. Package/release workflows are separate from the source-check
workflow; do not advertise unverified platform downloads.

## Submit a change

Starting with v1.0.0, releases focus on complete, polished features. Finish the
user workflow, including useful feedback and failure recovery, before calling a
feature done. Verify affected PWA and Telegram paths, preserve existing data and
settings, and ship matching tested runtime/PWA builds. Keep unfinished work out
of published feature claims. Follow the [release standard](RELEASING.md).

Describe the concrete problem, resulting behavior and relevant validation.
Include sanitized screenshots with synthetic data for visual changes. Preserve
upstream attribution and notices. Report security-sensitive details privately
as described in [SECURITY.md](SECURITY.md).
