# Legacy Basic Memory reflection checks

The current AI-managed second-brain setup is documented in
[Knowledge](../../docs/knowledge.md). The code and checks below exercise the
older, optional MCP-backed reflection path; they remain for existing profiles.

Opt-in integration using Basic Memory 0.23.2 as the Markdown store and DSH's
existing agents, scoped tools and session persistence. No independent indexer
or task scheduler is added.

## Behavior

- Completed human turns become non-overwriting conversation evidence. Tool
  output, raw reasoning, attachments, plugin-only and child turns are excluded.
  A persisted activation timestamp prevents unsolicited historical import.
- A restricted native DSH worker follows the gather/evaluate/merge reflection
  workflow using an explicitly selected existing model. It has zero tools;
  host code checks and applies returned Markdown through Basic Memory.
- The canonical personal summary is `memories/Personal memory.md`. New chats
  read its current content directly, without waiting for lexical indexing.
  Complete recall is capped at 6,400 UTF-8 bytes; automatic edits exceeding
  5,000 JSON-escaped bytes are rejected instead of becoming unrecallable.
- Human edits made during reflection are preserved. Interrupted or uncertain
  attempts are parked, not blindly replayed over newer edits. Native DSH
  session-resume recovers missed eligible captures without a separate queue.
- The authenticated right-drawer Memory section renders notes as text and
  confirms each Forget operation. Cross-site writes are rejected.
- Forget removes a unique selected passage after persisting a retirement cutoff.
  Conservatively, ALL evidence at/before the request is excluded from future
  reflection. Original chats/evidence and already-injected active-chat context
  remain intact. Direct file editing is not the explicit Forget operation.

Automatic reflection currently maintains a bounded personal summary. It does not
manufacture a network of topical notes or enable embedding-based retrieval.
The PWA graph below displays real notes and existing links. Failures must not block chat.

## Private configuration

Use isolated Python 3.12, not system Python. Keep all vaults, databases, config,
credentials and conversations outside the repository. Mount the official DSH
MCP client as `hub_memory`, running the venv's `basic-memory mcp` with an explicit
`BASIC_MEMORY_CONFIG_DIR`. Disable telemetry and embeddings for this CPU setup.

Insert `@lencx/minke-harness-overlay/memory` into the private profile patch, with
explicit `project`, `provider`, `model`, and persisted `captureSince` fields.
Use isolated failure policy for these optional plugins. Never reset the cutoff
on each boot. Build the overlay before installing its new memory export.

Capture and recall use the originating live agent's scoped tools, never a
fallback to broader authority for a disposed or denied source. This version
requires the normal native-tool presentation path; do not bypass PTC-only policy.
Host curation is restricted to read/write/edit in the selected private project.
The graph adds read-only `build_context` and exact-UUID `read_note` operations in
that same project; it does not change the capture cutoff or curation policy.

## Verification

Use the already-built vendored DSH and Node 24+.

```powershell
& '<venv>/Scripts/python.exe' -m pip install -r scripts/memory/requirements-windows-py312.lock
& '<venv>/Scripts/python.exe' scripts/memory/verify_basic_memory.py
node --import ./scripts/register-path-aliases.mts --test tests/memory-*.test.mjs tests/mobile-memory.test.mjs
node scripts/memory/verify_packaged.mjs '<HUB app directory>' '<basic-memory executable>'
```

Default tests create only a disposable synthetic vault and make no provider
calls. They cover actual MCP/storage/restart, native capture, reflection,
correction, forgetting, scoped denial, production installer integration and
native JSONL resume recovery. `--bridge-only` skips the storage suite.

Optional `--model-check <DSH home> <installed host root>` explicitly uses the
existing OpenRouter route with synthetic evidence only. It checks casual facts,
corrections, hypothetical and assistant-invented claims, and Forget. Credentials
remain inside the native provider and are not printed.

The packaged verifier boots the actual Electron-as-Node Loader in an isolated
home, authenticates its real route and tests cross-site rejection. It does not
edit live configuration. A separate live synthetic check also verified automatic
cross-chat recall and Forget preserving original chats on the development host.

To verify a newly staged host before installation, pass `--runtime-root` with its
absolute path. Add `--voice-python` to load the optional voice plugin and check
its authenticated status, history and lazy SDK routes without starting a model
or microphone. `--playwright` loads the actual staged PWA in isolated Chrome:
Home hubs, lazy audio code, the right-edge gesture, Knowledge and Settings, plus
desktop-width exclusion. `--screenshot` saves the Home view to a private absolute
path. These checks use the disposable vault, not your personal notes or account.

```powershell
node scripts/memory/verify_packaged.mjs '<HUB app directory>' '<basic-memory executable>' --runtime-root '<staged host>' --voice-python '<Pipecat Python>' --playwright '<Playwright package>' --screenshot '<private Home screenshot.png>'
```

This verifies packaged startup and UI wiring, not the target iPhone, live-provider
speech or relay connectivity; run the separate audio and mobile-network checks.

47 targeted memory/navigation/bookmark/drawer checks and both typechecks passed
during activation. These are not an iPhone microphone or completed graph claim.

## PWA Knowledge tile

The right-panel Knowledge tile previews actual Basic Memory notes and links.
Opening it lazily loads Cytoscape 3.34.2 for touch navigation, zoom, node selection,
page-local search and a plain Markdown reader. See [Cytoscape](https://js.cytoscape.org/)
and [Basic Memory's tools](https://docs.basicmemory.com/reference/mcp-tools-reference).
It uses `build_context` without the default seven-day cutoff, keeps native
pagination, and labels partial neighborhoods. No title-based inferred edges,
second index, vault write or desktop interface change. Raw `sessions/` evidence
and internal `control/` policy are excluded; normal notes remain editable in the vault.

Real native/MCP/Chrome check (build first; isolated synthetic vault, no provider calls):

```powershell
node scripts/harness/build-product-packages.mjs
& '<venv>/Scripts/python.exe' scripts/memory/verify_basic_memory.py --bridge-only --graph-browser '<playwright package directory>' '<private screenshot.png>' '<installed chrome.exe>'
```

The explicit Chrome executable avoids resolving it inside the isolated test home.
Chrome still uses a fresh test-only profile. Checks include actual indexed UUID
relations, the compiled plugin HTTP route, lazy engine load, one tap while the
preview is still loading, canvas node taps, original note reads, search, zoom,
Close and cleanup. This is not deployed iPhone or large-vault acceptance.
