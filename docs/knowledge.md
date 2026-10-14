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

**Reflection** is a brief useful observation, not a hidden reasoning transcript. The separate Reflection tab shows its source and date. AI interpretations are distinguished from verified user facts during memory retrieval.

**USER.md** suggestions require genuine user evidence and explicit review. Character suggestions are restricted to the source character. Approval appends a dated, sourced addition while preserving existing operator instructions. Durable receipts prevent duplicate additions; newer human edits block undo. Curator cannot automatically rewrite shared SOUL.md, AGENTS.md, credentials, tool permissions or model routes. See [AI instructions](instructions.md).

HUB and other permitted characters can create a new written note through hub_knowledge_write_note in response to a current human request. This is separate from automatic archiving and curation.

## Using knowledge as memory

Before a new user request, permitted agents retrieve a bounded selection of relevant saved records. Retrieval combines the current message, recent topic, personal preferences and real linked neighbors. Local multilingual embeddings index chunks within a record; chunks do not create extra graph entries. Keyword matching remains available during indexing or failures. Late matching passages in long chats can be recalled.

The full vault is never inserted into a prompt. Relevant original excerpts and separately labeled reflections are historical, untrusted data; current user corrections take precedence. Allowed characters can additionally use hub_knowledge_search and hub_knowledge_read. Retrieval has a deadline so it cannot hold a voice response indefinitely. Usage shows recent recalled titles and selection reasons; this diagnostic list resets on restart.

## Credits, imports and media

Original capture does not require credits. A quota failure preserves the Curator source queue and blocks the provider across HUB background queues. Connection checking and explicit recovery resume work; failed work is not reported as a successful note write. Daily/monthly guards are estimates, not a provider bill or Codex subscription percentages.

Import your own ChatGPT/Gemini JSON, HTML or ZIP exports through the preview screen. Each source conversation retains one identity, original messages and available branch/media metadata. Processing chunks are operational units, not newly authored topic notes. Missing Gemini replies are not invented. Duplicate imports do not repeat admitted processing. The current upload limit remains 80 MB; larger archive handling is a separate planned extension.

Images and files can be preserved without being fully understood by AI. Selected document formats support local text extraction; general image OCR or audio/video interpretation is not promised. Optional dependencies are listed in scripts/tests/requirements-media.txt. Voice conversations retain public transcripts, not raw call recordings.

The older Basic Memory MCP bridge remains available for legacy configurations; it is not the second-brain path above.
