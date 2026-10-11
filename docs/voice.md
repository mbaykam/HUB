# Voice conversations

[Documentation](README.md) · [Setup](setup.md) · [Telegram](telegram.md)

HUB uses a local speech pipeline around the configured Conversation character.
Speech recognition produces text for a normal native conversation. Public reply
text reaches TTS incrementally; tool arguments and hidden reasoning are not
spoken. A stronger HUB character can handle delegated tasks and return their
results to the active call.

## Install the optional Python runtime

Use a separate Python 3.12 environment outside the repository. For Windows:

```powershell
py -3.12 -m venv "$env:USERPROFILE\.dsh\runtimes\pipecat"
& "$env:USERPROFILE\.dsh\runtimes\pipecat\Scripts\python.exe" -m pip install -r scripts/voice/requirements-windows-py312.lock
```

The lock provides the baseline Pipecat/WebRTC speech dependencies. Additional
engines/models have their own availability checks; the speech model manager
handles supported model downloads after the engine's package is installed.
For the current optional Supertonic/Sherpa engines, install the separately pinned
`scripts/voice/requirements-local-engines-py312.txt` in the same environment.
Model weights and
licenses are separate from HUB's source license.

Add the voice entry to the existing private profile patch, replacing the
placeholders with your Python path and an already configured provider/model:

```yaml
- insert:
    - id: hub-voice
      name: '@lencx/minke-harness-overlay/voice'
      config:
        python: 'C:/absolute/path/to/pipecat/Scripts/python.exe'
        provider: '<provider-id>'
        model: '<model-id>'
```

Restart the host after ending any call. Configure the Conversation character's
route and delegation target in Characters. Choose engines only after their
runtime and model download report ready.

## English and Turkish

Supertonic 3 supports using the same selected voice style for English and
Turkish. Other engines may have language-specific voices. Nemotron streaming,
Whisper and Turkish verification components are available in the local speech
stack; availability and settings are shown in the speech editor.

Voice previews read prepared local recordings rather than starting a new
inference on each click. A fresh installation needs the models and samples
prepared first. Engine/model selection remains in character settings, keeping
the active voice interface focused on the conversation.

## What streams

Draft recognized words appear while you talk. Confirmed utterances enter the
native model after the speech boundary. Public model text can reach TTS before
the entire answer ends. Current local TTS synthesizes sentence-sized pieces and
plays their PCM chunks; this is not fully token-by-token audio generation.

The playback guard pauses recognition during assistant audio and its echo tail.
Use **Interrupt** to stop a reply and speak again. This is a practical guard,
not full acoustic echo cancellation or unrestricted voice barge-in. Mute is
preserved across interruption. Missing input and runtime errors remain visible.

## Delegation and live views

Ask Conversation to research something; it hands the task to HUB's configured
model/tool policy. Work appears in the native conversation/work list and the
completed reply can be spoken automatically when the caller is quiet. Open chat
opens the current native conversation; Home does not end the call.

The same PWA view can observe an incoming Telegram call and show its transcript
without opening another microphone session. Telegram call provisioning is
separate from pairing the text bot; see [Telegram](telegram.md).

## Verification

```powershell
& '<voice-python>' -m pytest scripts/voice/test_native_llm.py scripts/voice/test_playback_guard.py -q
node --experimental-transform-types scripts/voice/verify_native.mjs
```

These use synthetic data or local test fixtures. Actual device recognition,
network latency and long-running sessions require separate acceptance testing.
Cached-model checks require `HUB_VOICE_TEST_LOCAL_MODELS=1`; their exact criteria
are retained. A very quiet Turkish Piper→Whisper auto-language sample and a
Piper→tiny.en English word-recognition sample currently fail their exact
criteria on the development host. These legacy routes are not
a guarantee of the selected streaming profile's accuracy; the failed criterion
is retained, and your intended engine/voice/device needs its own acceptance.

To run the cached-model acceptance cases explicitly in PowerShell:

```powershell
$env:HUB_VOICE_TEST_LOCAL_MODELS = '1'
& '<voice-python>' -m pytest scripts/voice/test_speech_settings.py scripts/voice/test_voice_reception.py -q
```

These include the legacy failures above; they are not counted as successful
unit checks or silently changed to accept weaker recognition.
The [verification scripts](../scripts/voice/README.md) describe explicit provider
and model checks; those can consume the connected provider's quota.
