# Personal planning and source memory

Home shows Knowledge statistics and a 3D preview, followed by your agenda and
to-dos. Starting a written chat hides both cards. Starting voice hides Knowledge
and keeps the planner, task progress and transcript. The full Knowledge workspace
retains its 2D default. The preview stops rendering and fetching while hidden.

## Agenda and to-dos

Use the quick entry to add a to-do. Soon and Later separate planning horizons;
open a title to edit its details, date or horizon. Check an item to complete it.
Removed and completed records are recoverable under Completed & removed.

The calendar starts with the selected week. Press its date/month heading to open
the month grid; the same control explicitly collapses it. Select a day and use
the agenda's plus button to add an all-day or timed event. Time options show the
IANA timezone. Timed events store UTC instants and display in their saved zone;
nonexistent times during a clock change are rejected. Repeated hours use the
earlier occurrence; agent tools can supply an explicit offset when needed.

Agenda & to-dos in the left sidebar opens the same planner during a chat.
Personal commitments remain separate from the assistant's per-conversation work
steps and from Goals/Automations. A calendar entry does not execute work or send
a notification. Use Tasks to configure those behaviors.

Agents use `hub_planner` for requested personal changes and `hub_work_plan` for
their own visible steps. Read existing records before editing; keep their IDs
and versions. Native `todo_write` lists also project into conversation work steps.
Each worker is bound to its durable parent conversation. A completed agent turn
does not automatically certify that unfinished steps succeeded. Tool permissions
and existing goal/automation policies remain binding.
Cleared native checklists disappear from the work-step area. Long native step
titles have a concise preview; Open task retains the full original checklist.

## What Knowledge keeps

Original chat messages and original uploaded bytes are preserved. Knowledge AI
can extract useful verbatim human facts and attributed document quotations into
separate brain notes, under its existing mode, category and spending settings.
Short greetings can stay archive-only. Derived notes keep the source conversation,
recorded time, selection reason and exact evidence. Open their source trail or
connections to inspect that evidence and the retained attachment.

| Input | Retention and interpretation |
| --- | --- |
| Typed and voice chats | Original messages retained; useful human quotations may become sourced notes. Voice text remains subject to recognition accuracy. |
| Text, Markdown, CSV, JSON, logs and supported text/code formats | Original retained; bounded UTF-8 previews are available. File claims are document data, not personal declarations. |
| PDF | Original retained; local text extraction covers up to 30 pages and a bounded text preview. Scanned pages require separate visual/OCR analysis. |
| DOCX and XLSX | Original retained; bounded document text and sheet-cell previews. Macros and formulas are never executed. |
| Images | Original and chat association retained. A vision-capable character must inspect actual image content; the curator does not invent descriptions from bytes. |
| Supported audio/video | Original retained; explicit `hub_media_inspect` can inspect a bounded clip/transcript and sampled frames. This is not automatic understanding of the whole recording. |
| Other, corrupt or unavailable formats | Original retained when upload succeeds; no claim of interpretation or fabricated extracted facts. |

Uploads are limited to 25 MB each. Previews and curation context are bounded;
the retained original is the authority when information lies outside a preview.
Imported history must be explicitly admitted through the archive workflow. Retired
or withdrawn evidence cannot silently reappear in recall. Existing source text,
character routes, voices and instructions are not rewritten by these operations.
