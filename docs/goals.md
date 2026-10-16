# HUB Goals

[Documentation](README.md) · [Automations](automations.md)

Open the **right panel → Goals** in the mobile PWA, or **Panel → Goals** in
the desktop / wide PWA. Goals work independently of the chat you are using.
Saving a draft does not start a model.

## Start with an outcome

Choose **New goal**, then enter a name, the desired outcome, one acceptance
criterion per line, an owner character, optional input files and an active-work
allowance. Save the draft and press **Start** when ready. A character without
a configured model can own a draft but cannot start it.

Examples:

- Research a topic: specify the questions, sources to check and desired report.
  Require checked sources and a saved deliverable as acceptance criteria.
- Fix a project issue: select the repository under Resources, grant the required
  write folders, and name the reproduction and regression checks. Additional
  command tools need approval of the actual command and target before execution.
- Inspect an existing ChatGPT/Gemini export: select its original JSON/HTML/ZIP as
  an input, enable requested Knowledge outputs and ask for a private archive
  preview. Keeping the complete archive private does not add it to memory. To
  organize it, approve a specific selection of 1–50 conversations with the
  unchanged preview identity and file checksum. Only that selection is admitted;
  the current Knowledge AI settings and budget govern queued work. See
  [archive and pilot controls](knowledge.md#credits-imports-and-media). The
  existing 80 MB upload ceiling still applies.

## The six tabs

| Tab | Controls and information |
| --- | --- |
| Overview | Outcome, done criteria, owner, active time, current checkpoint, actual milestone/criterion counts and final approval. |
| Plan | Generated milestones, manual edits, dependencies and status. Earlier plans remain in Activity. Unsupported model claims do not mark milestones done. |
| Character & approach | Inherited model/provider/reasoning, Quick/Balanced/Thorough/Custom, goal instructions, named read-only helpers and optional independent verifier. |
| Resources & access | Selected files/folders, write folders, public browsing, Knowledge reading, additional tools and requested Knowledge outputs. |
| Limits & schedule | Round/step/output caps, time allowance, estimated API budgets/prices, deadline, working hours, explicit model fallback routes, recovery and notifications. |
| Activity & results | Approvals, observed tool evidence, checked output downloads, cycle results, native work sessions, errors, routes and setting/plan history. |

Tabs preserve unsaved input. Save conflicts keep your edits visible; refresh
the changed goal before applying them again. Editing one goal does not overwrite
another goal's progress. New permissions apply immediately; owner changes use the
next safe checkpoint and retain the native session context.

A native work session's PWA header shows the character and model recorded for
that session's latest round, labelled **Working** or **Last run**. Changing a
character's model later does not rewrite the model shown for an earlier round.

## Timed and recurring starts

Start immediately, once at a chosen time, at intervals of at least five minutes,
or on selected weekdays in an IANA timezone. Public HTTPS watches and filtered
HUB events can also start a cycle. Watches establish a baseline and call a model
only when their condition transitions, unless first-check execution is enabled.

- **Continue** works toward one saved outcome and stops when it is evidenced.
- **Fresh** creates a separate result cycle at each recurrence. Each cycle has
  its own native session; earlier results stay available. Time/round/API limits
  cover the whole goal, including previous cycles.

Missed starts can catch up once or be skipped. A linked automation can wake an
already active goal; it cannot start a draft or override a human pause. Its
receipt means the trigger queued work, not that the outcome is complete.

## Execution, completion and recovery

Every round has a saved receipt before execution. The owner works within its
bounded allowance and records a checkpoint. Subsequent rounds use native session
resume, including persisted context and compaction projections. Opening a work
session to read its history does not dispose that reader or reset the goal.

Successful tool results and files read back with SHA-256 are evidence references.
Completion requires references for each current acceptance criterion. These
receipts prove what executed or was saved; they do not mathematically prove the
meaning of an arbitrary outcome. Use an independent verifier or final human
acceptance for subjective or important work. Unknown failures, credit exhaustion,
unfinished criteria and repeated lack of progress are not completion.

One background lease is shared by Goals, Automations and Knowledge AI. Foreground
conversation gets priority. Helpers share their owner's step allowance and do
bounded read-only work. API limits use your supplied prices and estimated
reservations, not an exact provider invoice. Codex subscription / configured
local routes have separate accounting: dollar reservations are zero, but time
and round caps still apply. Remaining subscription usage is unavailable here.

Provider quota failure keeps checkpoints and results. Only explicitly selected
fallback routes can replace the unavailable route; the owner persona remains the
same and both characters' tool permissions apply. Otherwise restore capacity and
use **Credits restored — resume**.

The host must remain running. Restart recovery can resume approved read-only
work, or always wait for you. Human pauses remain paused. Interrupted project
writes and uncertain approved operations require inspection before continuing;
an approval is for exact arguments and is consumed once. Stop and Archive retain
the records. Goal drafts and working context are separate from original Knowledge
conversations; a generated note/import enters Knowledge only through explicit
output permission and an approved operation.

## Natural-language control

HUB can use `hub_goals_manage` from text, the paired Telegram conversation or
voice in response to your current request. For example: “Make this a goal owned
by HUB, work for up to an hour, and show me the final report” or “Pause that
research goal until I increase its allowance.” No fixed phrase is required.
Telegram notifications are opt-in to the originating paired conversation and
update one activity card at starts, milestones, completion or needed input.

Before approving an additional tool operation, inspect its concrete draft,
arguments, destination and intended effect in Activity. Scoped file tools check
the selected paths and protect original Knowledge/HUB settings. Approved general
commands retain their native permissions; selecting folders does not create an
operating-system sandbox for those commands.
