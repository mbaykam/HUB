# Original conversations, memory and reflection

[Documentation](README.md) · [Setup](setup.md) · [Automations](automations.md)

Knowledge keeps original conversations and human-requested notes in an Obsidian-compatible vault. Curator reads these records and organizes their relationships; it cannot rewrite or translate conversation bodies or automatically replace them with topic summaries.

## Storage and activation

Choose a vault outside the source checkout and back it up independently. Merge this optional entry into the private web profile's existing cordis.patch.yml:

```yaml
- insert:
    - id: hub-memory
      name: '@lencx/minke-harness-overlay/memory'
      config:
        secondBrain: true
        vault: 'C:/absolute/path/to/your/vault'
        captureSince: 1791676800000
```

Set captureSince once to your activation time in Unix milliseconds; it limits old evidence admitted to automatic curation. The first startup archives existing eligible real conversations without model calls. Evaluation sessions, injected instructions and private reasoning are excluded. Existing legacy notes are preserved.

One conversation has one stable archive identity and one graph entry. Public messages, dates, speaker roles, interruptions and failures survive without model credits. Private JSON preserves originals; Conversations/ contains readable Markdown projections. Native history remains authoritative for the full runtime/tool transcript. Captured original files live under Attachments/; URLs remain in their original messages. Normal continuations do not duplicate a full day-long chat for every message. Source edits have separate history; a human edit to a projected body stops automatic replacement.

## What Curator may do

Open **Settings → HUB → Assistants → Knowledge AI**. Select an explicit model, sources, timing, automatic/review/manual behavior, relation limits, reflection preferences and estimated budgets. Annotation language never translates the original conversation. Turkish and English can coexist.

Curator has no tools. Its structured result can contain tags, relationships to existing records, short sourced observations and profile suggestions. The host checks identities, quoted evidence and scope. No blank targets, invented notes or filler link paragraphs are admitted.

Relationships and reflection live in private metadata. Valid relationships also project into the conversation's hub_related YAML property as real Obsidian wikilinks; the original body stays unchanged. Undo removes the organization revision without replacing the original conversation.

## Domains and the brain view

Open **Knowledge → Domains** to organize your records. Start with a few broad life
domains, then put specific projects or subjects in subdomains. The default limit
is seven active main domains; **Domain limit** lets you choose between one and
twenty. Subdomains do not consume main-domain slots. Deactivating a topic keeps
its sources searchable. A conversation can belong to several domains.

Knowledge AI can propose organization from source evidence. Renaming, merging,
moving or deactivating domains requires review. You can also manage memberships
yourself and undo the latest compatible change; a newer independent edit is
preserved. **Organize records** queues only the records you select. For a long
conversation, preview and choose an excerpt first. This uses your existing model,
mode and budget, and never rewrites the original.

**Suggested groups** finds clusters locally from existing relationships and
available cached similarities. Inspect their original sources before using a
label for a domain. These suggestions do not assign records or create topic notes
automatically. The search prefilter and group identity reconciliation adapt parts
of [Graphify](https://github.com/Graphify-Labs/graphify); HUB keeps its own
multilingual retrieval, source evidence and domain controls.

The 3D view separates domains and subdomains spatially. Focus a domain, zoom or
open a source; labels change with distance to reduce overlap. The compact view
shows a counted sample. Detailed rendering also has a display budget, separate
from storage: **Connections** on a source lets you page through its relationships
and inspect their quoted evidence. Many links within a domain are allowed;
cross-domain bridges are shown separately. Similarity is a navigation hint, and
an AI relationship remains an interpretation even when its sources are quoted.

In **Graph options**, switch to **2D** for a flat view of the same stable domain
clouds. Its zoom and **Fit graph** controls operate on the flat view; labels appear
when there is enough room. Dragged record positions are kept on this device.
**Reset 2D layout** restores the default positions for the displayed records if an
older saved arrangement is unusable. It does not change notes or relationships.

**Reflection** is a brief useful observation, not a hidden reasoning transcript. The separate Reflection tab shows its source and date. AI interpretations are distinguished from verified user facts during memory retrieval.

**USER.md** suggestions require genuine user evidence and explicit review. Character suggestions are restricted to the source character. Approval appends a dated, sourced addition while preserving existing operator instructions. Durable receipts prevent duplicate additions; newer human edits block undo. Curator cannot automatically rewrite shared SOUL.md, AGENTS.md, credentials, tool permissions or model routes. See [AI instructions](instructions.md).

HUB and other permitted characters can create a new written note through hub_knowledge_write_note in response to a current human request. This is separate from automatic archiving and curation.

## Using knowledge as memory

Before a new user request, permitted agents retrieve a bounded selection of relevant saved records. Retrieval combines the current message, recent topic, personal preferences and real linked neighbors. Local multilingual embeddings index chunks within a record; chunks do not create extra graph entries. Keyword matching remains available during indexing or failures. Late matching passages in long chats can be recalled.

The full vault is never inserted into a prompt. Relevant original excerpts and separately labeled reflections are historical, untrusted data; current user corrections take precedence. Allowed characters can additionally use hub_knowledge_search and hub_knowledge_read. Retrieval has a deadline so it cannot hold a voice response indefinitely. Usage shows recent recalled titles and selection reasons; this diagnostic list resets on restart.

The usage trace includes the bytes and estimated tokens actually added to context.
This is an explicit UTF-8 estimate, not a provider tokenizer or bill. Sources
omitted by current file-size limits are reported; an empty partial search is not
proof that a fact was never saved. Original files remain intact. Initial local
indexing can take longer than a warm lookup and yields between batches so other
host work can continue.

## Credits, imports and media

Original capture does not require credits. A quota failure preserves the Curator source queue and blocks the provider across HUB background queues. Connection checking and explicit recovery resume work; failed work is not reported as a successful note write. Daily/monthly guards are estimates, not a provider bill or Codex subscription percentages.

Open **Knowledge → Data → Conversation archives**, or the import tab in Knowledge
AI settings. Add your own ChatGPT/Gemini JSON, HTML or ZIP export. Exact uploaded
bytes and their checksum are kept privately. Previewing or keeping an archive
private makes no model calls and excludes its conversations from assistant
memory, search and graph.

You can start fresh, keep a whole export private, or select a pilot. A useful
starting point is 20–50 conversations. Preview original messages, review the
selected count and planning estimate, then admit at most fifty conversations per
operation. Admit further selections later if the results are useful. Only admitted
records are queued under your existing Knowledge AI budget and mode; queued work
is not reported as finished. Restarting HUB keeps archives and admission receipts.

Each source conversation retains one identity, roles, dates and available branch
metadata. Processing chunks are not newly authored topic notes. Missing Gemini
replies are not invented. Exact duplicates leave existing originals alone;
different content with the same identity requires version review. Attachments
bind to their own message references; missing or ambiguous matches stay in the
original upload with a warning.

**Review batch withdrawal** removes that batch's admitted sources and derived
influence from HUB memory without deleting original uploads or shared media.
Applied profile changes must be explicitly undone first. Later human domain edits
are preserved and may need manual review. An interrupted admission remains hidden
until you review and resume it; a later human edit is never overwritten to repair
an import. The current upload limit remains 80 MB; larger streaming/resumable
archives are a separate extension. Keep your original export.

Images and files can be preserved without being fully understood by AI. Selected document formats support local text extraction; general image OCR or audio/video interpretation is not promised. Optional dependencies are listed in scripts/tests/requirements-media.txt. Voice conversations retain public transcripts, not raw call recordings.

The older Basic Memory MCP bridge remains available for legacy configurations; it is not the second-brain path above.

## Back up the complete dataset

Open **Knowledge → Data → Backups** and create a verified backup. Keep the saved
folder, its `snapshot.json` and `vault/` together. This includes original notes,
conversations, attachments, private import batches, domains, relationship evidence,
undo records and pending work. Copying only visible Markdown preserves readable
notes but does not preserve all HUB organization and provenance.

Verify a saved copy before moving it. **Restore as a separate copy** creates a new
directory and leaves the current dataset active. Saved background work is paused
for review in the restored copy. Review settings before explicitly resuming it.
Model/index caches and account credentials are excluded; local indexes can be
rebuilt. Moving between providers does not change original source identities.
