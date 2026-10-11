# Security and private data

HUB is a self-hosted personal workspace. Its trusted Host, provider plugins and
granted tools can access local resources. The PWA/voice interfaces are clients
of that Host; they do not provide a separate tenant sandbox for unrelated users.

- Keep runtime homes, credentials, Telegram sessions, account descriptors,
  conversations, vaults and downloaded models outside the Git checkout.
- Use authenticated remote access and HTTPS for remote browser microphones.
  Do not publish an authentication capability or bot token in a URL/screenshot.
- Approve Telegram pairing deliberately. Incoming user-account calls require
  a bounded caller allowlist; bot pairing and call authorization are separate.
- Install trusted plugins and reviewed browser runtimes. Plugin installation
  can execute code and retains access on future launches.
- Hosted providers receive configured prompts/tool results. Telegram handles
  Telegram traffic; browsers access the requested sites. Local STT/TTS/storage
  does not remove these external data flows.
- Back up vaults separately. Forgetting a curated note is different from
  deleting source conversations, exports or their backups.

For a suspected vulnerability, use
[GitHub's private vulnerability reporting](https://github.com/mbaykam/HUB/security/advisories/new)
when available. If it is unavailable, open an issue requesting private contact
without posting exploit details, credentials or personal data. Ordinary bugs
belong in [Issues](https://github.com/mbaykam/HUB/issues).

There is no formal response-time SLA or independently audited security guarantee.
