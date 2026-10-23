# Voice conversations

[Documentation](README.md) · [Setup](setup.md) · [Telegram](telegram.md)

HUB connects speech recognition and local voice synthesis around the configured voice character. Set shared
engines and languages in **Settings → HUB → Speech**; choose each character’s
voice in **Characters → Voice**. See [Settings](settings.md) for migration and model options.
Speech recognition produces text for a normal native conversation. Public reply
text reaches TTS incrementally; tool arguments and hidden reasoning are not
spoken. A stronger HUB character can handle delegated tasks and return their
results to the active call.

## Soniox streaming recognition

Open **Settings → HUB → Speech → Soniox connection** and enter your Soniox API
key in the password field. It is stored by the host credential service, never
returned to the browser or included in character instructions. Saving a key
does not validate it with Soniox or start paid usage. Get a key and manage your
balance in the [Soniox Console](https://console.soniox.com/).

In **Speech models & engines**, select **Soniox · multilingual cloud + local
wake**, choose the recognition languages and save the speech settings. If the
local wake listener is missing, install it under **Install speech models** first.
The listener uses the pinned multilingual Whisper base model with local Silero
speech detection. Model licenses are separate from HUB. Existing local speech
choices remain available; adding a key does not replace them automatically.

During an active call, microphone audio streams to Soniox v5. Interim words
appear live; its completed semantic utterance goes to the conversation model.
HUB gives a confirmed endpoint a short 350 ms settling window and holds it while
local voice activity still indicates speech. A continuing segment joins the same
utterance before submission. Interim words stay provisional; local voice activity
cannot finalize uncertain text. This protects sentence endings at the cost of a
small additional delay. Recognition and speakerphone quality still require a
physical test on the caller's device.
The selected local TTS engine speaks the answer. Soniox uses its own account
balance, independently of the conversation model provider. The current connector
uses Soniox's global service endpoint; keys scoped to other regions require a
matching regional connector.

**Background** closes the paid Soniox connection. A local listener checks short
speech prefixes for the configured wake phrase; unrelated text is discarded and
no ambient transcript or model request is created. This replaces the optional
recent-background-context behavior while Soniox is selected. A bounded three
seconds of audio stays in RAM to retain a command spoken with the wake phrase.
Say the phrase at the beginning of a sentence, or press **Resume**. Background
and hangup close the cloud stream. **Mute** only disables the PWA microphone;
use **Background** to stop the paid stream while keeping the call. A connection or balance failure returns to
local waiting with a retry message rather than reconnecting on every audio frame.

An open foreground stream can incur Soniox usage even in silence. Check the
provider's [current billing details](https://soniox.com/pricing). Browser
microphone restrictions still apply when the phone locks or the PWA is hidden.
Local synthetic checks and protocol fixtures do not replace a real phone test
of wake reliability, recognition quality, echo and latency.

New voice conversations receive topic titles from their first substantive user
utterances, skipping greetings and microphone checks. This needs no additional
model call and preserves the conversation's language. Titles you set yourself
take precedence. Existing saved conversations are not renamed in bulk.

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
prepared first. Engine/model selection remains in global Speech settings, keeping
the active voice interface focused on the conversation.

## What streams

With the optional voice runtime enabled, HUB prepares the selected local speech
models after startup. PWA calls retain prepared model weights between calls;
each call still gets fresh recognition, transcript buffers, controls and native
authorization. The optional Telegram listener also prepares its selected speech
models before reporting ready. Preparation never opens the microphone or sends
a model request. Changing the speech configuration may require fresh preparation
for the next call.

A prepared call can still wait for ICE network negotiation. Check the configured
STUN/TURN endpoints separately from speech-model preparation. A working relay
can avoid a slow STUN attempt; verify relayed audio before changing those
settings, since a successful local call alone does not verify remote access.

Draft recognized words appear while you talk. Confirmed utterances enter the
native model after the speech boundary. Public model text can reach TTS before
the entire answer ends. Current local TTS synthesizes sentence-sized pieces and
plays their PCM chunks. Long sentences can start with a shorter phrase at a word
boundary, preserving numbers and URLs. This is not fully token-by-token audio
generation. Interrupting drops the old response's PCM before the next synthesis.

The playback guard pauses recognition from the first spoken reply text through
the end of playback and its echo tail, including gaps while the next sentence
is synthesized. It resumes automatically after the reply finishes.
Use **Interrupt** to stop a reply and speak again. This is a practical guard,
not full acoustic echo cancellation or unrestricted voice barge-in. Mute is
preserved across interruption. Missing input and runtime errors remain visible.

## Delegation and live views

In a text, Telegram or live voice conversation, ask naturally for the character you want
to speak with. For example, **I'd like to chat with Vera for a bit** or
**Biraz Vera’yla sohbet etmek istiyorum** switches the active speaker to Vera.
No command or fixed phrase is required. Your following messages use her model
in the same conversation. Ask for HUB to take over again to return. New chats
still start with HUB. The PWA header shows the active character and model.

A voice handoff keeps the call, speech engine and conversation connected. The
next reply uses the chosen character's model and personality; its saved action
permissions apply. The voice controls show the current speaker. Existing workers
keep the character and permissions they had when started. Changing who speaks
does not interrupt those workers or change the default character for new chats.

A request for another character to perform work remains a background task.
For example, **Ask Vera to research this** delegates the research while keeping
the current speaker available. An unconfigured character cannot take over.
If a request could mean either speaking to a character or delegating work, the
assistant asks a brief clarification before changing the conversation.

Ask Conversation to research something; it hands the task to HUB's configured
model/tool policy. Work appears in the native conversation/work list and the
completed reply can be spoken automatically when the caller is quiet. Open chat
opens the current native conversation; Home does not end the call.

The same PWA view can observe an incoming Telegram call and show its transcript
without opening another microphone session. Telegram call provisioning is
separate from pairing the text bot; see [Telegram](telegram.md).

## Verification

```powershell
& '<voice-python>' -m pytest scripts/voice/test_native_llm.py scripts/voice/test_playback_guard.py scripts/voice/test_prepared_runtime.py scripts/voice/test_speech_segments.py scripts/voice/test_speech_interruption.py -q
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
