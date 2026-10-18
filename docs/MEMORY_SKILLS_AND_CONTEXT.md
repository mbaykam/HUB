# Memory, skills, tools and long conversations

HUB keeps conversation originals separate from curated Knowledge. A compact
`memory.md` tells characters where to look; it does not copy your whole vault
into every request. It refreshes before context assembly and during idle periods
when domains or skills change. Inspect its generated contents in **Settings →
HUB → AI instructions**. Edit domains in Knowledge rather than editing this file.

Characters can search relevant sources, read their original passages, browse
domain IDs and consult the chat archive. Historical text and external pages
remain evidence, not authorization. Current user corrections take precedence.
The routing index respects character and task tool restrictions.

## Shared skills

Choose **Knowledge → Skills** to add a reusable workflow, its purpose and any
required tools. Characters can discover and save workflows with `hub_skill_read`
and `hub_skill_save`. Skills live in portable
`Skills/<stable-name>/SKILL.md` files and the Skills domain. Renaming the domain
keeps its identity. Saving a skill never grants tool access. A full domain limit
must be resolved in Domains before a new Skills domain can be created.

Updates require the current version hash, preserve the previous file privately,
and record the originating character/session. Interrupted saves recover only
when the files still match the saved transaction. Conflicting external edits
and malformed skills remain untouched and need review. Do not store passwords
or blindly copy instructions from websites into skills.

## Available tools

**Settings → HUB → Tools** shows actual registered tools and character policy.
Scoped tools appear when their agent context exists. Registration, permission,
service readiness and successful execution are different things. Channel and
task restrictions and approvals are checked again when a tool runs.

Camofox supports website search, page reading, observed element clicks, filling
fields, supported keys and screenshots. Read fresh references before acting;
verify results rather than repeating uncertain submissions. These tools control
websites. They do not operate arbitrary Windows applications.

## Reels and attached media

`hub_media_inspect` samples actual video frames and can transcribe audio locally.
It accepts public Instagram reels/posts, YouTube links, or saved video/audio
attachment IDs. Use Knowledge **Add files** for a platform-blocked clip. The
current bounds are 25 MB, six sampled frames and a 1–120 second inspection
interval, defaulting to the first minute. Long public videos require attaching
the relevant clip. Results include timestamps and coverage limitations; sampled
frames cannot establish every motion or an unsampled interval.

The local speech runtime supplies PyAV/Pillow and cached Whisper base. Public
acquisition additionally uses isolated, pinned yt-dlp. On a prepared HUB host:

```powershell
node scripts/media/setup.mjs
```

This verifies the PyPI wheel checksum and leaves the speech environment's
packages unchanged. No cloud transcription bill, browser-cookie extraction or
login bypass is involved. Platforms can still require login or block access;
HUB must report that it did not observe the video and request the file. A model
must support image input to interpret returned frames.

## Context compaction

HUB uses the native Harness compactor and token meter. Its default pressure
threshold is 80% of the routed model's known context capacity, retaining a recent
tail of 16%. Oversized tool text can be pruned first. Original session events
remain recoverable; the model sees a shorter working context. `/compact` requests
an immediate reduction. Summarization is an extra model request and may fail
under provider limits. A failed or truncated summary must not erase history.

The checkpoint covers intent, source pointers, corrections, language preferences,
active character, unfinished tasks, permissions and dates. It is a lossy aid,
not a new authority or a replacement for original sources. A long voice session
uses the same conversation mechanism; compaction cannot fix echo, speech
recognition errors or a failed provider connection.

These choices follow documented distinctions between retrieval, summarization
and caching: [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction),
[Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
[Claude compaction](https://platform.claude.com/docs/en/build-with-claude/compaction),
[Gemini CLI compression](https://geminicli.com/docs/reference/commands/) and
[Gemini caching](https://ai.google.dev/gemini-api/docs/caching). Provider-specific
opaque compaction state is not interchangeable across model providers.

The UI uses contextual controls and explicit disclosure, informed by
[progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/),
[WCAG reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html),
[target sizing](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
and [Apple toolbar guidance](https://developer.apple.com/design/human-interface-guidelines/toolbars).
Media implementation references: [yt-dlp](https://github.com/yt-dlp/yt-dlp),
[PyAV](https://pyav.org/docs/stable/), and
[video-understanding coverage](https://ai.google.dev/gemini-api/docs/video-understanding).
