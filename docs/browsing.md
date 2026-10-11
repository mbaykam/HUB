# Browsing and visual results

[Documentation](README.md) · [Setup](setup.md)

HUB retains native web tools and a bounded, credential-free RSS search fallback.
An optional Camofox bridge adds agent browsing/snapshots. Character tool policies
determine which tools a worker can use; the voice foreground delegates demanding
research to HUB rather than gaining unrestricted browsing permissions.

The current Camofox launcher integration is Windows-specific. The verified
runtime is [Camofox Browser 2.4.8](https://github.com/redf0x1/camofox-browser/releases/tag/v2.4.8),
using its Windows x64 portable distribution. Install it separately, keep it on
loopback, and place its runtime descriptor
under `~/.dsh/hub-camofox/runtime.json` (or the corresponding `DSH_HOME`). It needs
an absolute `launcher` path pointing to the installed `camofox.cmd`. The bridge
starts that launcher with `server start` and verifies the local engine health.
Provider/browser account credentials are not stored in this descriptor.

See the installed Camofox project's own installation instructions and use a
reviewed/pinned runtime. If it is unavailable, inspect its health/configuration
rather than assuming a completed task used browser capabilities.

Textual browser snapshots and the native Agent Browser preview are distinct
capabilities. The PWA can show supported native browser views and visual artifacts;
it does not automatically turn every Camofox snapshot into a live browser image.
Source URLs and quote times belong in the saved conversation when researching
time-sensitive information.
