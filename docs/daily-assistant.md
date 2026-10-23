# Daily use through the PWA

Home keeps Knowledge and your day above one bottom message/voice bar. Knowledge
opens in 2D: use **− / Fit / +**, or select a note to read its original sources.
The small totals include the separate chat archive; the Home graph shows brain
notes and their real connections. Original conversations remain in Knowledge's
**Chat archive**, outside the life domains.

In **Your day**, type a to-do and press **+** or Enter. Pressing **+** with an empty
field opens the item editor. Select a title to change details, a due date or the
Soon/Later horizon. Complete an item with its checkbox; **Completed & removed**
can reopen or restore it. The date opens the calendar. **Open planner** shows the
larger week view, which is also available from the left panel while in a chat.

Personal to-dos and calendar events are commitments, not execution schedules.
Use **Tasks** in the right panel for a goal or a scheduled/conditional routine.
The assistant's observable work steps stay separate from your personal list.
Closing the PWA does not stop host work; the HUB computer must remain on.

**Settings → Tools** shows the selected character's current tool policy. Retired
memory tools have their own filter and cannot be enabled by an old allow-list.
Registration alone does not bypass channel permissions or execution approvals.
A character without a direct planning tool can delegate appropriate work to an
allowed character; changing a display name does not change that character's ID.

**Settings → AI instructions → Benim hakkımda** edits the shared `USER.md` profile.
Keep confirmed general preferences there; use Knowledge for sourced, detailed
information. Shared profile edits apply when the next request is assembled,
including conversational workers. They do not rewrite a request already in
flight. The Knowledge curator uses its own scoped instructions. The character's
request inspector shows observed dispatched input when one is available; it does
not create a request merely to fill the inspector.

Saved self-contained HTML files in Knowledge have **Open app** and **Download**
actions. **Open app** stays inside the PWA in a full-screen viewer, with **Close**
and optional **Game controls** for arrow keys and restart. Opening an app reads
the saved file; it does not call a model or change the original. **Download**
keeps the original bytes. Existing shared preview links also render local scripts
inside an isolated frame. App code cannot read HUB cookies or use its tool/API
connection; external scripts, network services and browser storage are restricted.

## Gradually connecting personal services

Email and WhatsApp account connections are a later step; this Home update does
not connect them. Start with one useful read-only email workflow, such as finding
an appointment and proposing an agenda entry with its source. Then evaluate
source accuracy, duplicate handling and revocation before enabling further work.

An email connector should use delegated OAuth with the narrowest useful scope,
protected local credentials, explicit source/account boundaries and a visible
activity log. Reading, writing drafts and sending must be separate capabilities.
Messages and attachments are untrusted data, not instructions authorizing actions.
Choose what is admitted to Knowledge rather than importing every mailbox item.

Gmail distinguishes metadata access from full read-only access; both have OAuth
requirements. Outlook offers delegated `Mail.ReadBasic` and `Mail.Read` with
different content coverage. [Google scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes),
[Microsoft permission reference](https://learn.microsoft.com/graph/permissions-reference#mailread).

WhatsApp needs its own account-type and integration decision. Meta's official
Cloud API is part of the Business Platform; it should not be presented as automatic
access to all existing personal chats. Review the supported account and data flow
before choosing it. [Meta's official Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api).
