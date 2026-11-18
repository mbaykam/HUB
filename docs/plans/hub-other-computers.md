# HUB controls your other computers — plan

Status: researched 2026-11-18, not built. Only computers you own and set up
yourself; HUB never takes over a machine that hasn't opted in.

## What already works

HUB controls this PC (brokoli) through **Windows-MCP** — a plugin in HUB's
profile (`~/.dsh/profiles/web/cordis.patch.yml`, `uvx windows-mcp serve`) that
gives it screenshots, clicks, typing, windows, apps, clipboard and
PowerShell as `mcp__windows__*` tools.

## The idea

Run the same Windows-MCP on each other computer as a small network server,
and let HUB connect to each one as its own MCP server. Every computer then
shows up to HUB as a set of tools with its own name:

| Computer | Tools HUB sees |
|---|---|
| this PC | `mcp__windows__*` (today) |
| laptop | `mcp__laptop__Screenshot`, `mcp__laptop__Click`, … |
| office PC | `mcp__office__*` |

So "put the slides on the office PC's screen and open them full screen" is
one request: HUB looks at the office PC, opens the file, presses F5.

Windows-MCP already supports this (checked tonight with `windows-mcp serve
--help`): `--transport streamable-http`, `--host`, `--port`, `--auth-key`
(a bearer token required on every request), `--ip-allowlist`, and
`--tools` / `--exclude-tools` to limit what a machine allows.

## Setup per computer (one time, ~10 minutes)

1. Install **uv** (Python launcher) and **Tailscale**, signed into the same
   tailnet as brokoli.
2. Create a long random key for that computer (HUB stores it as a
   credential, e.g. `WINDOWS_MCP_KEY_LAPTOP`, never in chat).
3. Start at login (a scheduled task the owner creates on that computer):
   ```
   uvx windows-mcp serve --transport streamable-http --host <tailscale-ip-of-this-computer> --port 8765 --auth-key <key> --ip-allowlist <brokoli-tailscale-ip>
   ```
   Optionally `--exclude-tools PowerShell,Registry` on machines where HUB
   should only see and click.
4. On brokoli, add one entry to HUB's profile patch:
   ```yaml
   - id: hub-computer-laptop
     name: "@deepseek-ai/dsh-mcp-client"
     failurePolicy: isolate
     config:
       serverName: laptop
       transport: http
       url: http://<laptop-tailscale-ip>:8765/mcp
       headers: { Authorization: "Bearer ${WINDOWS_MCP_KEY_LAPTOP}" }
       failOnStartupError: false
   ```
   (exact field names to confirm against `@deepseek-ai/dsh-mcp-client`.)
5. Restart HUB; ask "what computers can you control?" — it lists them.

## What HUB would add (to build)

- **Computers page** in Settings: add a computer (shows the one command to
  run on it, generates the key), see which are online, turn one off.
- **Computer awareness**: a short tool `hub_computers` listing which are
  online, their screen sizes, and what each is allowed to do.
- **Screen takeover moments** ("Iron Man"): show a result on another screen —
  open a page, a document or a HUB app full screen on a chosen computer, or on
  all of them at once.
- **Same safety rules** as this PC: ask before closing unsaved work, sending,
  deleting or paying; never type passwords; stop if the screen is locked.

## Blockers found tonight

- Tailscale on brokoli is installed but Knowledge notes say it is stuck
  (NoState) and must not be restarted during a NoMachine session. Remote
  computers need a working Tailscale (or the same LAN with a firewall rule).
- Macs need a different MCP server (Windows-MCP is Windows-only); the same
  plan applies with a macOS automation server.
- Phones cannot be controlled by another device; HUB's phone access stays the
  share-screen and camera flows.
