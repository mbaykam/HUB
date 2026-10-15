# HUB automations

[Documentation](README.md) · [Knowledge](knowledge.md)

The PWA's **right panel → Automations** manages tasks independently of an open conversation. It adds no automation dashboard to Home. A permitted character can also manage tasks with hub_automation_manage in response to the user's natural-language request.

Choose a configured character and purpose, then a trigger:

- A single absolute time.
- A fixed interval of at least five minutes.
- Selected weekdays and local time in an IANA timezone, including DST handling.
- A public HTTPS source changing, containing text, or crossing a numeric JSON field threshold. The first check establishes a baseline unless requested otherwise. Simple checks do not call a model; an observed change triggers it.
- An optional field condition on host.started, task.completed, task.failed or knowledge.archived. Task events refer to specialist work, not every chat greeting.

Each job exposes its purpose, character/model, next time, status, tools, missed execution policy, daily run and estimated-cost limits, model step/output limits, notification preference and run history. Edit, pause, resume, cancel and manual test actions use concurrency checks; stale saves preserve another device's changes. Completed task sessions can be opened from history.

For longer outcomes, load the active [Goals](goals.md) in the editor and select
a linked goal. The trigger queues that goal from its checkpoint, with its own
character and allowance, without an additional automation model request. It
does not start a draft or override a human pause; its successful trigger receipt
does not mean the goal has finished.

Default tools are read-only search/knowledge tools intersected with character permissions. Additional tools require explicit permission in the saved task. Results are retained in the PWA. Opt-in Telegram notifications can be associated only with the originating authorized Telegram conversation; a PWA edit cannot invent a new destination.

Every execution gets a durable receipt before dispatch. Only an observed successful native turn with a final result counts as completed. Quota failures retain the job and block the provider across background queues. Use explicit provider recovery after restoring capacity. A quota failure after possible external actions pauses the task for review instead of replaying it. Power loss during execution leaves an interrupted receipt and requires review.

Local jobs run only while the computer and HUB are online. Choose either one catch-up execution or skipping missed executions; repeats do not replay every missed interval. Daily budget pauses retain the job. Cost guards are estimates, not guarantees of an exact provider bill. Public watches reject private-network addresses, authenticated URLs and oversized responses.

Native Harness schedule_create/list/delete remains available for reminders inside a live conversation. Its dispatch receipt is different from the HUB-wide service and is not presented as successful model execution.
