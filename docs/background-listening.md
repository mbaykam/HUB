# Background listening and sourced memory

Start a voice conversation normally. Press **Background** to keep the call open
without replying to surrounding conversations. Say your configured wake phrase (initially **Vera**) at the start of a
sentence, or press **Resume**, to continue. Saying the name alone gets a short
local acknowledgement. A name followed by a request submits that request once.
After three minutes without conversation, HUB switches to Background automatically.
It waits for speech recognition and ongoing replies to finish before doing so.

Settings → Speech → **Background listening** controls the idle interval, up to
three wake phrases and recent background context. These settings are shared by
PWA and Telegram calls; character voices and model choices stay unchanged.

All surrounding speech can enter the recent context; HUB does not try to identify
the speaker. Before waking, the excerpt stays only in RAM on the host PC. The
default is the last minute, with at most 24 segments and 1,024 characters. You can
disable it or choose 30 seconds, one minute or two minutes. Old excerpts expire;
ending the call or manually changing mode discards them. On wake, the excerpt is
sent once as labeled, untrusted background context. It is not a new user message,
task instruction or personal-memory evidence. No raw audio recording is created.

Background recognition uses the already running local STT. Ambient speech makes
no LLM requests; a name-only acknowledgement also needs no LLM request. The call,
speech models and conversation stay connected. Wake latency still depends on the
selected local recognizer finishing the utterance. Background mode queues spoken
task announcements until you return; the task and its saved result remain intact.

This is a mode within an open call. A phone's operating system still controls
microphone/network access when a PWA is hidden or the screen is locked. HUB does
not promise all-day capture across phone sleep, disconnection or power loss.

## Keeping useful information

Settings → Knowledge AI → **Sohbetlerden kalıcı bilgi notları çıkar** enables
selected, durable user statements to become separate notes in the brain. It uses
the existing post-conversation organization request and budget, without a second
extraction model call. The selected Knowledge model, categories, idle delay,
automatic/manual/review mode and cost controls remain in charge.

The model selects at most four useful quotations per pass. The host saves the
exact quotation, preserves its language and links it to its source conversation.
Original chats remain in the separate archive. Existing notes are never rewritten
by this extraction. Existing titles and quotations prevent literal duplicates;
the curator also compares retrieved candidates for repeated information. This is
not a guarantee of semantic deduplication or error-free speech recognition.

Assistant guesses, delegated prompts, prior injected memory, background excerpts
and credentials cannot become user-fact notes. Intentions remain intentions.
New notes use the existing domain-organization queue; they may briefly await a
domain while that queue runs under its budget. Profile changes still need review.

In review mode, inspect the proposed title and original quote before approving.
Knowledge AI → Kullanım reports the number of saved notes and offers **Çıkarılan
notları geri al** separately from relationship undo. Failed note writes can reuse
the saved validated response without another extraction model call. Withdrawing
an imported original also removes its derived notes from search while preserving
their files. Original bytes and human edits remain protected.

For an older saved chat, select it in Knowledge → Data and request organization.
Long originals require choosing an excerpt. New policy does not automatically
reprocess every archived conversation or spend through the existing backlog.

## Verification boundaries

Automated checks use synthetic words/audio, isolated sources and real PWA
components. They verify local gating, bounded context, authenticated call control,
native-source separation, preservation, review, retry and undo. Actual phone
microphone, speaker echo, waking from another room and locked-screen operation
require device acceptance; synthetic audio does not establish those results.
