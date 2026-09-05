# HUB

HUB is a focused desktop AI workspace with a fast, mobile-first PWA. It is an
independent customization of [Minke](https://github.com/lencx/Minke), powered
by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## What changed

- Fixed the Cloudflare Access flow so an authenticated PWA can establish its
  private DSH browser session without exposing the DSH capability in a public
  URL, browser history, or Cloudflare logs.
- Added a subtle animated ambient background with stronger cyan, blue, violet,
  pink, and amber colors.
- Removed the whale, empty-state title, and sidebar branding for a cleaner UI.
- Removed tooltip bubbles that could remain stuck on the mobile screen after a
  touch.
- Improved mobile viewport behavior when the onscreen keyboard is open.
- Reduced mobile startup work so the installed PWA reaches the workspace
  faster.
- Added swipeable liquid-glass navigation panels, a dedicated mobile home
  launch, deterministic one-tap session switching, and compact provider usage
  meters for Codex and OpenRouter.
- Added shared session bookmarks saved on the Host, with automatic migration
  of existing browser bookmarks and synchronization across devices.
- Rebranded the desktop app and PWA as HUB with a minimal geometric identity.
- Made Harness staging work on Windows without requiring permission to create
  ordinary symbolic links.

## Run locally

Requires Node.js 24+, pnpm 11, and Git submodules.

```bash
git clone --recurse-submodules https://github.com/mbaykam/HUB.git
cd HUB
pnpm install
pnpm run harness:stage
pnpm start
```

Create a package for the current platform with:

```bash
pnpm run package
```

## Downloads

- [macOS (Apple silicon)](https://github.com/mbaykam/HUB/releases/latest/download/HUB-macos-arm64.dmg)
- [macOS (Intel)](https://github.com/mbaykam/HUB/releases/latest/download/HUB-macos-x64.dmg)
- [Windows](https://github.com/mbaykam/HUB/releases/latest/download/HUB-windows-x64.exe)
- [Linux (Debian/Ubuntu)](https://github.com/mbaykam/HUB/releases/latest/download/HUB-linux-x64.deb)
- [Linux (RPM)](https://github.com/mbaykam/HUB/releases/latest/download/HUB-linux-x64.rpm)
- [Linux (AppImage)](https://github.com/mbaykam/HUB/releases/latest/download/HUB-linux-x64.AppImage)

## Privacy

This repository contains source code only. It does not include local Minke or
DSH profiles, credentials, session logs, remote-access configuration, installed
plugins, generated packages, or machine-specific paths.

## Credits and license

HUB is based on [Minke](https://github.com/lencx/Minke) by lencx and includes
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Licensed
under Apache-2.0.
