# Changelog

## 0.4.41

- Fix desktop/PWA startup by reusing the base profile's native Goal service instead of registering it twice.
- Disable the base automatic goal driver so background goal rounds follow HUB's saved limits and admission policy.

## 0.4.40

- Add Goals to the mobile/desktop right panel: six-tab editing, character routes, approaches, named helpers, independent verification, resources, limits and evidence-backed completion.
- Support immediate, timed, calendar, watch and event starts, with continuing outcomes or separate recurring results; automations can wake an active linked goal.
- Resume native goal sessions across rounds and owner changes, preserve checkpoints and plan/history, require exact-operation approval, and inspect uncertain restart writes.
- Share background admission and quota between Goals, Automations and Knowledge AI; keep goal working context out of automatic personal Knowledge capture.
- Add checked output downloads and approved original-archive import previews without rewriting original conversations.

## 0.4.39

- Declare the Knowledge plugin's character-service dependency so the full desktop/PWA host boots correctly with the new shared quota and profile reflection features.
- Cover Knowledge startup through the actual Cordis plugin loader without paid model calls.

## 0.4.38

- Preserve original conversations, including failed/partial chats, as a single protected record independent of model credits; retain imported branch/media metadata.
- Replace automatic note rewriting with sourced relationships, separate reflection and reviewed profile additions; project real Obsidian properties without modifying conversation bodies.
- Add durable HUB-wide automations in the PWA right panel, with time/calendar/watch/event triggers, limits, permissions, run history and pause/recovery controls.
- Share provider quota waiting across background queues and distinguish native failure from successful completion.


## 0.4.26 — source publication baseline

This source snapshot consolidates the locally developed HUB capabilities and
publication housekeeping. It does not imply that every platform has a released
installer or a completed physical-device acceptance test.

- Character routes, model catalogs and native delegation; task completion
  delivery to voice and bounded per-step output for configured workers.
- Telegram paired text with edited replies and an optional incoming-only
  user-account call bridge.
- Local speech engines, English/Turkish profiles, prepared voice samples,
  live transcript and playback/echo-tail protection.
- AI-managed Markdown/Obsidian-compatible knowledge, related-note links,
  explicit archive import, media/source records and topic-cloud views.
- Dark glass/gradient-mesh PWA, a simpler live voice card and native
  conversation/Home navigation.
- Synchronized package versions and network identifiers; portable QA paths,
  explicit shared IPC contracts and a complete source test catalog.
- Windows-aware filesystem fixtures, less brittle source-text test debt,
  ignored private/cache artifacts and removal of unused upstream screenshots.
- New README, contributor/security guidance, setup/feature documentation,
  source links and retained upstream license notices.

Earlier upstream and HUB development remains available in Git history.
