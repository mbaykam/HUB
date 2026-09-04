# Minke Mobile PWA Fork

A customized version of Minke focused on making its remote mobile interface
cleaner, more reliable, and easier to use as an installed PWA.

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
- Made Harness staging work on Windows without requiring permission to create
  ordinary symbolic links.

## Run locally

Requires Node.js 24+, pnpm 11, and Git submodules.

```bash
git clone --recurse-submodules https://github.com/mbaykam/Minke.git
cd Minke
pnpm install
pnpm run harness:stage
pnpm start
```

Create a package for the current platform with:

```bash
pnpm run package
```

## Privacy

This repository contains source code only. It does not include local Minke or
DSH profiles, credentials, session logs, remote-access configuration, installed
plugins, generated packages, or machine-specific paths.

## Credits

Based on [Minke](https://github.com/lencx/Minke) by lencx and
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
Licensed under Apache-2.0.
