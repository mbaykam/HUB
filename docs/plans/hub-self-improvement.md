# HUB improves itself — plan

Status: plan for review (2026-11-18). Nothing here is built yet.

## Goal

HUB gets better as you use it, by itself, as one system. When you say "improve
yourself", or when it notices it went wrong, it finds the cause, proposes a
change, and — after you approve — applies it: a note, a skill, a character
instruction, a model choice, or a change to its own code, which it then tests,
builds, installs and verifies on its own. It never loosens its own safety rules
and never installs anything you have not approved.

## The loop

```
notice ──► log ──► propose ──► you approve ──► apply ──► verify ──► keep / roll back
```

### 1. Notice

Two sources, no special keywords:

- **Your feedback, in any words.** After each of your messages, the existing
  Knowledge reflection pass (which already reads finished chats) also asks:
  *did the user express dissatisfaction, a correction, or a wish about how HUB
  behaves?* Facts about you stay Knowledge notes as today; feedback about HUB
  itself becomes an improvement item.
- **Its own failures**, detected from the event log without a model:
  tool errors, refused tool calls, repeated identical calls (today's
  "dummy search" loop), turns you stopped, background tasks that failed,
  plugins that did not start (today's Windows-MCP), app crashes reported by
  the phone.

### 2. Log

`~/.dsh/hub-improve/log.jsonl`, one item per observation:

| field | example |
|---|---|
| id, at | uuid, time |
| source | `user-feedback` / `tool-error` / `loop` / `stopped-turn` / `plugin-failure` |
| session, seq range | link to the exact moment in the chat |
| character, model | who was speaking, on which model |
| summary | "Repeated minke_web_search 'dummy' 8× instead of mcp__windows__App" |
| evidence | short excerpt (no secrets; reuses Knowledge's secret masking) |
| status | `open` / `proposed` / `resolved` / `wontfix` |

Items are grouped by cause, so ten loops on the same model become one problem.

### 3. Propose

An **improvement worker** (a background HUB character, "Mechanic", using the
model you choose for it — a strong one) runs when you say "improve yourself",
and otherwise once a day if there are open items. For each group it writes one
proposal with:

- what goes wrong today, with links to the evidence;
- the smallest change that would fix it;
- how it will check the fix (see Verify);
- the risk and how to undo it.

Proposal kinds, smallest first:

| Kind | Example | Applied by |
|---|---|---|
| Knowledge note | "Mete prefers short voice answers" | automatic (as today) |
| Skill | add "ask before closing windows" to a desktop skill | after approval |
| Character instructions | change Vera's tone or rules | after approval |
| Model / routing | "use Sonnet for desktop tasks, not GLM Flash" | after approval |
| Tool guidance | clarify when to use hub_capture_desktop | after approval (code) |
| Code change | fix a bug in HUB or the iPhone app | after approval (code) |

### 4. Approve

Each proposal reaches you as a notification with **Approve / Deny / Open**
(the existing approval buttons), and on a new **Improvements** page in
Settings (iPhone and PWA) with the diff, the evidence and the test results.
You can set standing rules such as "auto-approve Knowledge and style changes"
per kind; code changes always ask.

### 5. Apply

Non-code kinds write through the stores that already exist (Knowledge,
skills, character settings, routing) and are versioned there, so each can be
undone.

**Code changes** run entirely inside HUB:

1. HUB keeps its own source checkout (`C:\Minke\minke-0.4-fix` for the host,
   the iOS workspace for the app) and creates a branch `hub/improve/<id>`.
2. The Mechanic edits files with HUB's own file and terminal tools.
3. It runs the relevant tests, then the full host suite. Failing tests: it
   fixes or abandons the change and records why.
4. It builds the installer (`pnpm make`) and verifies the package
   (payload hashes, packaged smoke test) — today's release steps, scripted.
5. You approve the install (notification shows the diff summary and test
   results).
6. It backs up, installs, restarts, and runs the health check
   (conversations, Knowledge, characters, voice, tunnel, Windows tools).
7. **Update watcher.** Because HUB cannot watch itself while it restarts, a
   small watcher inside HUB's own package runs only during an update: it
   waits for the new version to pass the health check and, if it does not
   within a few minutes, reinstalls the previous version and restarts it.
   It is not an always-on keep-alive.
8. For iPhone changes, HUB pushes the branch, waits for CI, reads the test
   results and screenshots, and starts the TestFlight upload. The signing
   approval on GitHub stays yours (GitHub and Apple require it).

### 6. Verify

- **Before applying:** replay the logged situation in a sandboxed session
  (same messages, same tools, the new instructions or code) and confirm the
  failure no longer happens.
- **Standard checks:** a small fixed set of self-tests (the routine from the
  self-test prompt, automated where possible) so a fix does not break
  something else.
- **After applying:** watch real use for a week; if the same problem recurs
  or a new one appears around the change, flag it and offer an undo.

### 7. Keep or roll back

Every applied change has a version and an undo. "Undo yesterday's change to
Vera" works in chat. Code changes roll back by reinstalling the previous
version (the installer and backup are kept).

## What it can never change by itself

- Its safety rules: asking before payments, deletions, sending as you,
  ignoring instructions found in web pages and files.
- The approval requirement for anything beyond Knowledge notes.
- Credentials and the Cloudflare tunnel configuration.
- The update watcher and rollback.

These are checked by a fixed list of protected paths; a code change touching
them is refused before it reaches you.

## What you say

- "Improve yourself" — run the loop now and show proposals.
- "That was wrong because …" — logged as feedback, no special words needed.
- "Why did you change?" — change history with evidence.
- "Undo that" — rolls back the last applied change.

## Build order

1. **Log and detection** — failure detectors over the event log; feedback
   extraction in the reflection pass; Improvements page (read-only).
2. **Proposals for non-code kinds** — Mechanic character, approval through
   notifications, apply + undo for skills, instructions, routing.
3. **Replay verification** — sandboxed replay of a logged situation.
4. **Self-coding** — branch, edit, test, build, verify package, approval,
   install, update watcher, rollback; iPhone path through CI.
5. **Standing rules and after-checks** — auto-approve per kind, one-week
   watch with recurrence flags.

Each step is useful on its own; step 4 depends on 1–3.

## Related: characters working with characters

How it works today (from the code):

- Any top-level conversation's character can call `hub_delegate` to hand a
  background task to another configured character. The task runs as a native
  sub-agent with that character's own model and instructions, and its result
  comes back as a notification in the conversation. Several can run at once.
- The voice character uses `hub_task` for the same thing, so the call stays
  responsive.
- A delegated sub-agent cannot delegate further: character tools are only
  mounted on top-level conversations. Sub-agents do get the phone-context tool.

What to add (planned, not built):

1. **Nested delegation** with a depth limit (2) and a loop guard (a character
   cannot delegate back to an ancestor in its own chain), so the main
   assistant can split work into specialists who can each call one helper.
2. **Team view**: the conversation shows who is working on what (character,
   model, status), using the existing activity feed.
3. **Budget**: each delegation carries a cost/turn cap inherited from its
   parent, so a fan-out cannot run away.
4. **The Mechanic** from this plan is one such character, so self-improvement
   work shows up in the same team view.

## Risks

- **Model quality.** Self-changes are only as good as the Mechanic's model;
  tests, replay and your approval are the filters. Use a strong model.
- **Cost.** The Mechanic runs on your providers; daily runs only when there
  are open items, with a budget cap per run.
- **Bad install.** Covered by backup + update watcher + rollback.
- **Drift.** Many small instruction changes can make a character worse
  overall; the after-check compares week-over-week failure rates.
