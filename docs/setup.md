# Set up HUB

[Documentation](README.md) · [Voice](voice.md) · [Knowledge](knowledge.md)

## Build the desktop host

Use Node.js 24+, Git and pnpm 11.7.0. Windows is the current development baseline.
The optional native macOS package is not required on Windows.

```sh
npm install --global pnpm@11.7.0
git clone --recurse-submodules https://github.com/mbaykam/HUB.git
cd HUB
pnpm install --frozen-lockfile
pnpm run harness:stage
pnpm start
```

For an existing checkout, run `git submodule update --init --recursive` before
staging. The runtime configuration pins the Harness commit; keep that pin rather
than moving the submodule to the latest upstream branch.

Create a platform package with `pnpm run package`, or distributables with
`pnpm make`. The current public snapshot is source-first; download links are
added only when actual platform artifacts are published and verified.

## Configure models and characters

Open Settings → Models and connect a provider using its native credential flow.
OpenRouter catalogs can refresh independently of the selected model. Catalog
presence and account access are separate: select a model your account can use.

Open Characters in the companion menu and configure:

- **HUB:** the main text/Telegram character, with a model suited to tools and
  longer tasks.
- **Conversation:** a responsive voice model, its speech settings and a
  delegation target pointing to HUB.
- **Other characters:** optional specialists with their own model, instructions
  and tool policy. A character with no model route cannot run.

Selecting a character's settings opens its editor; it does not silently transfer
an active call. Text defaults to HUB and voice to Conversation. A specialist
request currently starts delegated work, rather than a direct voice takeover.

LM Studio and Ollama have optional discovery and desktop lifecycle settings.
Subscription-backed provider plugins must be installed/configured separately;
this repository does not distribute an authenticated account or promise access
through any particular subscription plan.

## Use the mobile PWA

Keep HUB running on the host. In the Connections/remote-access settings, configure
an authenticated HTTPS route to its web interface, then open that URL on your
phone and add it to the home screen. HTTPS is required for a remote browser's
microphone. Localhost is only useful on the host itself.

The phone's PWA is a client of that host, not a second backend. Use the same
authenticated route to review tasks, conversations, knowledge and call
transcripts. A compatible PWA UI update is applied after a deliberate refresh;
finish a call and preserve drafts before reloading.

## Optional capabilities

The built-in product bundle enables characters and model catalogs. Voice and
Knowledge AI require separately configured Host entries. Their implementations
ship with the overlay, but are not enabled merely by building the application.

Add entries to the existing private `web` profile's `cordis.patch.yml`; preserve
its provider/plugin configuration. This is advanced Harness profile setup, not
a one-click onboarding wizard. [Harness](https://github.com/deepseek-ai/deepseek-harness)
owns profile composition; HUB's exported entries are described below.

| Entry | Configuration | Setup |
| --- | --- | --- |
| `@lencx/minke-harness-overlay/voice` | Absolute Python path, explicit provider/model route; optional call account and ICE servers | [Voice](voice.md) |
| `@lencx/minke-harness-overlay/memory` | `secondBrain: true`, vault path, stable activation time; optional local embedding Python | [Knowledge](knowledge.md) |
| Telegram bot | Bot credentials in Connections/Telegram and an approved pairing | [Telegram](telegram.md) |
| Camofox | Separately installed Windows launcher and local runtime descriptor | [Browsing](browsing.md) |

End active calls before restarting the host for profile changes. Speech models,
Python environments, Telegram sessions and vaults belong outside the checkout.

## Check the setup

Send a short text message first. Then verify character routing, and only after
that configure optional voice or Knowledge AI. If the voice button is disabled,
check that the voice Host entry loaded and its Python/model route is valid.

For development checks:

```sh
pnpm typecheck
pnpm test:desktop
pnpm harness:smoke
```

The normal test suite uses fixtures and local temporary data. Actual provider,
microphone, Telegram and mobile-network checks are separate opt-ins described
in the feature guides and verification scripts.
