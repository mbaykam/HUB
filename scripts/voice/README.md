# Voice verification and optional runtime

For current runtime/profile setup, English/Turkish engines, previews and call
behavior, read [the voice guide](../../docs/voice.md). The scripts below distinguish synthetic
native-model checks from explicitly opted-in real-provider checks. Test speech
is synthesized, not recorded from a personal microphone. Provider checks send
synthetic prompts and can consume the selected account's quota.

## Provider admission checks

Choose the provider/model you have actually configured. The example below uses
an optional Codex connection plugin; it is not HUB's required/default voice
provider. Speech recognition and synthesis stay local. The voice plugin checks
the exact selected native route before creating a transcript or speech process.
Verification should use isolated profiles and leave credentials inside the
provider's native lifecycle.

`verify_model.mjs` requires an explicit provider, model, and existing child model.
For the subscription route, also provide the installed plugin directory. It uses
the plugin's normal OAuth lifecycle, including its locked native refresh when
needed. It writes no live model configuration. `--catalog-only` checks native
model metadata without inference. Without that flag, it exercises real concise
conversation, shared context, a native interactive visual, and continuable task
handoff to the explicitly selected existing OpenRouter child model. The child
route does not determine the voice coordinator's provider.

```powershell
node --experimental-transform-types scripts/voice/verify_model.mjs `
  '<existing-dsh-home>' '<installed-host-root>' `
  --provider openai-codex --codex-plugin '<installed-codex-connect-plus-directory>' `
  --model gpt-5.6-luna --effort low --child-model '<existing-stronger-openrouter-model>' `
  --catalog-only
```

For real visual/audio checks, supply the Playwright package directory and an
optional private screenshot path as the third/fourth positional arguments. Add
`--audio-python '<pipecat-venv>/Scripts/python.exe'` to run actual browser PCM ->
Whisper -> native subscription model -> Kokoro -> decoded audible browser PCM.
`--audio-only` skips the standalone model/visual/delegation cases. The verifier
passively checks model and reasoning effort on outgoing native WebSocket frames
and SSE requests, without changing the transport or retaining credentials/input.
These local Chrome checks do not prove iPhone, cellular media connectivity,
long foreground calls, or deployment. Those remain separate acceptance gates.

## Runtime

Isolated Python 3.12, Pipecat 1.8.1, stock Whisper CPU/int8, Kokoro ONNX,
SmallWebRTC, and Ollama adapters. Install the pinned Windows lock in a separate
venv. Model files stay in the upstream user caches, outside this repository.

```powershell
& '<venv>/Scripts/python.exe' -m pip install -r scripts/voice/requirements-windows-py312.lock
& '<venv>/Scripts/python.exe' scripts/voice/benchmark_local.py
& '<venv>/Scripts/python.exe' scripts/voice/benchmark_model.py qwen3.5:0.8b
& '<venv>/Scripts/python.exe' scripts/voice/benchmark_model.py qwen3:0.6b
```

The model check needs an explicitly started local Ollama server on loopback and
the named model already pulled. It uses Pipecat's official adapter and inspects
tool calls without executing them. Nonzero exit means an acceptance gate failed.
This is a small initial gate, not a broad accuracy benchmark or safety evaluation.

## Historical initial CPU experiments

On an i7-6700T, no NVIDIA GPU, a synthetic 2.2-second English utterance was
synthesized and recognized correctly. Warm Kokoro first audio: 1.605 seconds;
Whisper base.en/int8 transcription: 0.968 seconds. First measured synthesis:
3.486 seconds to first audio. Initial model download time is separate and is
included only in the initialization figures printed by the benchmark.

The Pipecat v1.8.1 upstream suites below passed: 112 tests total.

- `test_tts_interruptible_service.py`, `test_tts_frame_ordering.py`: 52.
- `test_smallwebrtc_transport.py`, `test_smallwebrtc_request_handler.py`,
  `test_user_turn_start_strategy.py`, `test_user_turn_stop_strategy.py`: 60.

One initial interruption-suite run hit the test harness's one-second startup
timeout. The isolated rerun and subsequent full 52-test run passed. No upstream
tests or timeouts were edited to produce that result.

Initial four-case model gate, with thinking disabled and the same short prompt:

| Candidate | Handoffs selected | Warm first-content range | Result |
| --- | --- | --- | --- |
| Qwen3.5 0.8B | 1 of 2 requested | 4.009–5.993 s | Failed handoff gate |
| Qwen3 0.6B | 0 of 2 requested | 0.192–0.229 s | Failed handoff gate |

Both answered the two casual exchanges without selecting a tool. These results
do not establish that all local models are unsuitable; they mean these tested
configurations should not be silently promoted to HUB's task router.

## Native conversation bridge

The voice conversation uses the existing harness model, with speech recognition
and synthesis remaining local. `openNativeVoiceSession` creates an ordinary
Session Controller conversation with its normal preset and permissions. A scoped
prompt and model hook do not alter the saved desktop model selection. Public
text deltas and tool status are correlated to the admitted human utterance;
reasoning, tool arguments and tool output are not forwarded as speech.

```powershell
node --import ./scripts/register-path-aliases.mts --test tests/voice-conversation.test.mjs
node scripts/voice/verify_native.mjs
```

The second check uses actual DSH agents, scoped prompt/model hooks, session
events, temporary JSONL persistence and continuable children with a synthetic
model. It proves an admitted continuable child survives parent speech
interruption and voice close, and delivers its native settlement. The Session
Controller command seam is substituted in this check; the live HTTP/PWA path
is not yet covered. Nine focused bridge tests also cover duplicate admission,
asynchronous interruption, unrelated turns, failed admission and sink failure.
No live user task, paid model or microphone is touched by these checks.

## Speech sidecar and private transport

`packages/harness-overlay/voice` contains the Pipecat native-session adapter,
stock Whisper/Kokoro/Silero pipeline and one-call SmallWebRTC ASGI server. The
host bridge binds an ephemeral loopback port, requires its own random capability,
rejects browser-origin/foreign-Host requests, permits only one admitted call and
expires abandoned leases. The sidecar cannot create sessions or select models.
HTTP commands are bounded and are never automatically replayed after uncertainty.

```powershell
node --import ./scripts/register-path-aliases.mts --test tests/voice-bridge-server.test.mjs
node scripts/voice/verify_transport.mjs '<absolute-pipecat-venv>/Scripts/python.exe'
& '<venv>/Scripts/python.exe' -m pytest scripts/voice/test_native_llm.py scripts/voice/test_sidecar.py -q
# Explicit integration check using previously cached speech models, no microphone:
$env:HUB_VOICE_TEST_LOCAL_MODELS='1'
& '<venv>/Scripts/python.exe' -m pytest scripts/voice/test_sidecar.py -q
```

Seven Node HTTP security/lifecycle tests and fifteen Python adapter/security tests
pass. Six sidecar tests pass with the local-model gate enabled, including a real
aiortc SDP answer and non-silent synthesized greeting audio received over local
WebRTC from the assembled stock CPU pipeline. The greeting does not call an LLM
or invent a human message. Without the explicit gate, that one model test skips.
The Python/Node wire test verifies real capability auth, streamed NDJSON and
duplicate rejection. These checks are not a real-iPhone or internet NAT test.

## Next gates

The optional `@lencx/minke-harness-overlay/voice` entry now connects the private
sidecar to HUB's authenticated signaling routes and native subprocess manager.
It is not enabled in the live profile. Private configuration requires an absolute
Pipecat Python executable and the existing native provider/model route; no API
key belongs in this configuration. The packaged speech payload is restricted to
the three production `.py` sources, excluding caches, venvs and recordings.

```powershell
node --import ./scripts/register-path-aliases.mts --test tests/voice-sidecar.test.mjs tests/voice-web.test.mjs
# Build the optional voice entry before this compiled-entry integration check.
node --experimental-transform-types scripts/voice/verify_supervisor.mjs '<absolute-pipecat-venv>/Scripts/python.exe' --web
```

Eight supervisor and eight public-control tests cover environment isolation,
bounded readiness/responses, startup failure, process exit, cleanup uncertainty,
authentication, call ownership and replay-safe admission. The real executable
check caught and fixed a missing running event loop at startup. It now passes
through the actual DSH subprocess manager. The compiled plugin integration also
uses actual DSH signed-cookie/Origin authentication, with a synthetic Session
Controller seam and no paid model or microphone.

Public routes are `/api/hub/voice/{open,offer,status,close}`. Open accepts a fresh
UUID `requestId` and `requestedAt` timestamp; GET status provides server time for
clock alignment. Recover uncertain admission using the same values, never a
new UUID. Old/ended admission cannot recreate a chat. Signaling and close require
the returned `callId` plus normal browser authentication; subprocess capabilities
never reach the browser. There is one live call, a bounded admission-receipt
cache, and no automatic retry of failed native work.

The pinned browser packages are `@pipecat-ai/client-js@1.13.1` and
`@pipecat-ai/small-webrtc-transport@1.10.7`. For signaling, pass
`webrtcRequestParams.headers: new Headers({"x-hub-voice-call": callId})`:
the official SDK forwards headers for both offer and trickle-ICE PATCH, whereas
custom request data is nested on the former and absent on the latter. The proxy
accepts this header only on signaling routes and rejects conflicting body IDs.
The SDK is a separate on-demand browser asset, not an import in the main startup
bundle, to preserve the PWA's existing startup performance.

The official browser transport and voice UI exist in source. Verify the configured delegation tool
uses continuable background mode; ordinary foreground child calls have different
cancellation semantics. These modules are not yet mounted in the live app.
Test actual iPhone foreground audio, interruption, echo, reconnection, Wi-Fi and
cellular. Signaling over an HTTPS tunnel is not proof of WebRTC media connectivity;
TURN or a media provider may require a separate deployment decision. Do not claim
unlimited iOS background/locked-screen microphone operation.

## Optional ICE relay configuration

The voice host config accepts `iceServers`, a standard array of STUN/TURN entries
with `urls` and TURN client `username`/`credential`. Leave it empty for direct
connections only. No relay provider is provisioned or enabled by default.
Keep service administrative/API keys out of this array: only relay client
credentials belong here. Store deployment-specific values in private host config,
never repository files. Authenticated call admission returns the validated array
to the official browser transport, and the host supplies the same array to stock
Pipecat over its authenticated loopback control channel before peer creation.
Neither process arguments nor the public status endpoint contain these values.
Malformed configuration fails closed; browsers cannot override host ICE settings.

This implements configuration plumbing, not a credential-minting/renewal service.
If a provider issues expiring credentials, renewal for network changes during
long calls still needs implementation and verification. A successful configuration
test does not prove a reachable relay: test an actual relay-only connection and
then iPhone Wi-Fi/cellular audio before claiming remote voice works.

## Local speech choices and explicit downloads

The mobile personality editor supports local Faster Whisper tiny/base/small/
medium English models, Kokoro 82M English voices, and optional Piper LJ Speech.
Existing profiles keep Whisper base.en + Kokoro af_heart. Saving or switching a
personality applies to the next call; downloading does not change a profile or
interrupt current audio. LLM selections still use native configured providers.

`GET /api/hub/voice/speech-models` reports one host-owned download. Authenticated
same-origin `POST` with `x-hub-speech-models: 1` accepts only fixed engine/model
IDs. The Python worker uses pinned upstream Hugging Face revisions, anonymous
access, native resumable cache handling and bounded process lifetime. It cannot
accept URLs, paths, package commands or credentials. Downloads continue when the
editor closes, stop on host shutdown, and invalidate offline model discovery only
after verification and successful exit. No progress percentage is fabricated.
Opening voice/catalog remains offline and never implicitly downloads a model.

Piper is an optional separately installed Python dependency, **not included in
the HUB installer**. The tested Windows runtime is `piper-tts==1.8.0` with
`pathvalidate==3.3.1`, alongside the existing Pipecat 1.8.1 environment. Piper is
GPL-3.0-or-later; consult its license before redistributing a runtime containing
it. The selected `en_US-ljspeech-high` model card identifies its dataset as public
domain. This does not change HUB's existing license or remove third-party duties.
The editor explains missing runtimes instead of offering remote package install.

Real offline CPU round trips cover both Kokoro→Whisper base.en and Piper→Whisper
tiny.en. The native supervisor supports `--piper --download-models` to check the
actual authenticated downloader, catalog refresh, saved profile admission and
local Piper audio over WebRTC (fake/muted microphone, not a physical-phone test).

## Speech implementation sources

- [Pinned Pipecat source](https://github.com/pipecat-ai/pipecat/tree/v1.8.1)
- [Stock Kokoro adapter](https://github.com/pipecat-ai/pipecat/blob/v1.8.1/src/pipecat/services/kokoro/tts.py)
- [Stock Whisper adapter](https://github.com/pipecat-ai/pipecat/blob/v1.8.1/src/pipecat/services/whisper/stt.py)
- [Stock Piper adapter](https://github.com/pipecat-ai/pipecat/blob/v1.8.1/src/pipecat/services/piper/tts.py)
- [Optional Piper runtime and license](https://github.com/OHF-Voice/piper1-gpl)
- [LJ Speech voice model card](https://huggingface.co/rhasspy/piper-voices/blob/1162a9173d0ce503555aed757976b7a9912eae4c/en/en_US/ljspeech/high/MODEL_CARD)
- [Ollama adapter](https://docs.pipecat.ai/api-reference/server/services/llm/ollama)
- [Official SmallWebRTC browser transport](https://docs.pipecat.ai/api-reference/client/js/transports/small-webrtc)
- [Ollama compatibility and thinking control](https://docs.ollama.com/api/openai-compatibility)

No microphone is enabled, network media service published, or existing HUB model
selection changed by these scripts. A separate local model download is required.
