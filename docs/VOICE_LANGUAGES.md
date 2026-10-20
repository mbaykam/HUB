# Speech recognition and reply language

Open **Settings → Speech** to choose recognition and spoken-language settings.
These settings are shared by PWA and Telegram calls; a character chooses a voice.

**English + Türkçe only** verifies every completed utterance against those two
languages, including long utterances. Local streaming recognition still supplies
provisional words while you speak. Only the final audio transcription becomes a
user message. Uncertain decoder segments can be dropped rather than submitted
as invented words. Short Turkish greetings use the existing local verifier.

**Automatic · all model languages** keeps the selected model's automatic language
detection. **English** and **Türkçe** select a single recognition language. An
English-only Whisper model cannot use Turkish or the two-language selection.

With automatic spoken output, the recognized language accompanies each final
utterance into the native conversation. The voice assistant follows that turn's language unless
you explicitly request another. This hint is visible in the conversation's full
model context and does not rewrite your transcript or your saved preferences.
An explicitly selected spoken language still takes precedence.

A language restriction reduces unsupported-language guesses. It cannot guarantee
correct words, eliminate speaker echo or fix unclear audio. Local synthetic audio
and browser simulations exercise the pipeline; phone microphones, accents,
speaker echo and real conversation latency still need device testing.
