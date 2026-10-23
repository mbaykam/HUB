# Research

Open **+ → Research…** in the PWA composer. Set a question, depth, researcher,
source scope and freshness, then start. The current speaker stays in place.
Research uses the selected character's existing model; it does not sign up for
a provider, change character settings or automatically save findings as memories.

**Auto** follows the speaking character's configured delegation target. For the
voice assistant, its default is the main assistant. Choose a researcher directly
to override that choice for this task. Configure lighter characters to delegate
to a capable researcher; the host does not infer intelligence from a model name.

| Depth | Active-work ceiling | Source reads | Rounds |
| --- | ---: | ---: | ---: |
| Quick | 5 minutes | 8 | 3 |
| Standard | 15 minutes | 24 | 8 |
| Deep | 35 minutes | 48 | 16 |

These are ceilings, not waiting times. Each round has an additional model-step
and output limit. Discovery, failed attempts and retries share a durable attempt
allowance. Existing Goals time, provider-quota and estimated-budget gates apply.
Budget estimates are not a provider-enforced dollar cap. Check your provider's
own spending settings when you need a financial limit.

Use **+ → Research tasks** to reopen progress or results, pause/resume/stop,
inspect source passages, open the native work log or save the Markdown report.
Research also appears in Goals. It survives closing the PWA and resumes from
durable work after a host restart, subject to saved limits and permissions. The
host must be online; research yields to active conversation work. Provider
exhaustion leaves the checkpoint intact and exposes an explicit retry control.

When the initiating conversation is still loaded, completion queues a brief
summary in that chat. An active voice call can speak the summary through its
existing result channel. This notice cannot run tools or authorize more work.
If the conversation is closed or unloaded, reopen **Research tasks** to read
the retained report; completion does not reopen a conversation automatically.

The sheet accepts a text question. Files already in the composer remain there;
send them through ordinary chat or remove them before using the sheet. Web is
the default; **Web + Knowledge** explicitly allows local Knowledge reads. Do
not put private source text in public search queries. Private access remains
the intersection of the initiating character, researcher and saved task scope.

## Evidence and tools

Characters can call `hub_research` to start, list, read, pause, resume or stop
work. Mutations require a current human request; completion notices and source
text do not authorize new tasks. The foreground call returns promptly. There is
one background worker through the existing Goals scheduler, rather than an
unbounded swarm of models. Model and tool permissions are retained.

The scoped worker uses `hub_research_sources` for search/read/recovery and
`hub_research_report` for synthesis, then checkpoints through the Goal service.
Search uses the existing public RSS fallback, with Camofox available for browser
search; reading uses owned Camofox tabs or an admitted fetch adapter. Tabs close
after reads. Failed browser reads can fall back to the permitted fetch adapter;
workers can request that reader explicitly when a browser page is blocked.
Failed HTTP responses are not retained as source evidence. Search snippets
remain discovery observations and cannot serve as
cited read evidence.

Source observations retain IDs, timestamps, text hashes, tool receipts, bounded
passages and partial-coverage flags under the private goal workspace. Reports
retain claims, source IDs, exact short quotations, conflicts and limitations.
Completion requires a report whose citation IDs and exact passages match
retained reads. Those deterministic checks do **not** establish that a passage
semantically supports a claim or that the claim is true. The researcher must
assess support, compare sources and disclose uncertainty; readers can inspect
the retained passages. A run with no read-backed claim cannot claim completion.

Editing a research task in Goals retains its captured source scope, limits and
evidence checks. It cannot silently turn the job into an ordinary unrestricted
goal. Start a new research task to choose a different depth or source scope.

Read-only research does not expose messaging, purchases, publishing, arbitrary
filesystem tools or Knowledge writes. Page content is untrusted data, including
instructions it might contain. Scope and dispatch checks remain in host code.

## Design references

- [Anthropic: building a multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
  informed bounded task decomposition, source-focused delegation and checkpoint
  recovery. HUB starts with one researcher to keep provider use predictable.
- [ALCE: enabling language models to generate text with citations](https://aclanthology.org/2023.emnlp-main.398/)
  distinguishes answer correctness from citation support and coverage. HUB keeps
  these distinct rather than presenting a valid URL as a truth guarantee.
- [Google: Deep Research interaction guide](https://ai.google.dev/gemini-api/docs/deep-research)
  provides an example of background research and reconnectable progress; HUB
  implements that interaction pattern using its own existing Goal runtime.

These are design references, not dependencies or claims of benchmark parity.
