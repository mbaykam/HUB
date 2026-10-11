# Knowledge AI and the second brain

[Documentation](README.md) · [Setup](setup.md)

The current second-brain system stores normal Markdown notes in an
Obsidian-compatible vault. Knowledge AI decides whether a completed conversation
contains useful information, gathers related notes and proposes updates with
relevant inline links. The host validates writes and preserves newer human edits.

## Enable the optional Host entry

Choose a vault outside the source checkout and back it up independently. Merge
this entry into the private `web` profile's existing `cordis.patch.yml`:

```yaml
- insert:
    - id: hub-memory
      name: '@lencx/minke-harness-overlay/memory'
      config:
        secondBrain: true
        vault: 'C:/absolute/path/to/your/vault'
        captureSince: 1791676800000
```

Set `captureSince` once to the activation time in Unix milliseconds, for example
the result of `node -p "Date.now()"`; keep that value on later restarts. It limits
automatic capture of old conversations. The number above is an example, not a
required date. Restart the host after configuring the entry.

The current second-brain path manages the vault directly. The older Basic Memory
MCP reflection bridge remains available for legacy configurations and has
different setup requirements; it is not the default recipe above.

## Choose how curation works

Open Knowledge AI settings and select an available curator provider/model.
Use a low-cost model capable of producing the structured note updates. Set
eligible chat sources, idle timing, automatic/review/manual behavior, note detail,
language and budgets. Automatic language can follow the conversation instead of
forcing all notes into a single language.

Budgets are estimated guards, not a replacement for the provider's actual bill.
A paused/failed job should be inspected before retrying. Capture failures do not
need to block normal chat.

Connections should occur in meaningful prose. The validator rejects invented
targets, empty notes and filler link lists. Source records and technical bookkeeping
are maintained outside the ordinary reading text. You can also open/edit the
Markdown vault directly in Obsidian.

## Graph and media

The PWA provides note search, backlinks, a reader and linked topic clouds. Links
represent real note references; similarity information can organize nearby
topics. Optional local multilingual embeddings improve retrieval/layout; without
them, the keyword path remains available.

Original images/files can be saved under the vault's attachments with controlled
previews. URLs remain source references; optional extraction/download can fail
on unavailable or restricted content. Keeping an original file does not mean
every media format has been understood or transcribed by AI.
Local PDF extraction needs `pypdf` in the default Python runtime under
`~/.dsh/runtimes/pipecat`; the separately pinned dependency list is
`scripts/tests/requirements-media.txt`. Without it, original files can still be
retained while text extraction is unavailable.

## Import older conversations

Use the import screen with your own ChatGPT/Gemini export archives. Preview the
sources first, then admit the import. This is an explicit backfill operation and
may consume the curator provider's quota. It does not log in to those services,
scrape their apps or automatically fetch account exports.

Uncertain interrupted work is not silently replayed over newer notes. Review
conflicts and newer human edits before retrying or undoing. Forgetting curated
information does not delete the original conversation history.
