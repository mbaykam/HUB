# HUB settings and background work

[Documentation](README.md) · [Voice](voice.md) · [Goals](goals.md) · [Knowledge](knowledge.md)

Open **Settings → HUB → Assistants** in the PWA. This is where you manage
Characters, Speech, Models & providers, Telegram, Knowledge AI, usage and voice
history. **AI instructions** has the shared and character instruction files.
General settings retain language, conversation display and permission defaults.
The PWA hides inherited deployment-only Models, Plugins and Agent presets pages;
their underlying host configuration and stored settings remain available.

## One speech system, individual voices

**Speech** sets the recognition model, recognition language, synthesis engine,
spoken language and synthesis quality for every new PWA or Telegram call.
The initial shared configuration comes from your existing voice character;
installing this version does not change that character or its selected model.
An ongoing call keeps its admitted configuration.

In **Characters → a character → Voice**, choose and audition a voice. You cannot
change its speech engines there. If an older voice belongs to a different engine,
the shared default is used until you choose a compatible voice. Original legacy
settings are retained. Engine availability is checked before speech starts.

## Models and their options

The browser shows provider-advertised input types, context, output capacity,
prices, parameter names and disclosed defaults. Catalogue refreshes retain the
full supported-parameter list and do not change your selected model. Existing
cached data remains available when a refresh fails.

Choose a model inside a character to set its reasoning effort, output-token
limit and supported temperature. Empty values retain defaults. Reasoning levels
come from the exact installed adapter/model route, including new level names;
HUB does not add a fixed universal list. Unsupported saved levels are marked
unavailable rather than silently replaced. Character overrides also reach voice
conversations and delegated character work; task-specific limits can cap outputs.

Some provider capabilities, such as tool choice, structured responses and other
sampling controls, have no per-character override in the current adapter. They
are listed explicitly with that limitation. A provider that publishes only model
names cannot reveal a complete parameter schema. The controls do not claim to
infer undocumented capabilities or bypass adapter limitations.

OpenRouter publishes [`supported_parameters` and model properties](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).
Its [parameter guide](https://openrouter.ai/docs/api_reference/parameters) explains
provider-side controls. Codex reasoning availability [depends on the model and client](https://learn.chatgpt.com/docs/config-file/config-reference).

**Models & providers** in Settings browses the catalogue, favorites and available
connections. Adding an available model does not change a character or connect a
new account. Choose the model for a character afterward. New provider credentials
remain a host setup step; character settings never contain API keys.

## One Tasks screen

The right panel has **Knowledge** and **Tasks**. Tasks combines your existing
goals and automations in one list, with All, Goals, Routines, Needs attention and
Finished filters. Open, Pause and Resume operate on the original stored jobs;
existing schedules, permissions, checkpoints and history are preserved.

Choose **New task → Work toward a goal** for an outcome with completion criteria
and an owner character. Save a draft, then Start. The advanced tabs provide the
plan, approach, resources, limits, schedule and recorded results.

Choose **New task → Run on a schedule or condition** for one-time, interval,
calendar, public-source monitoring or HUB-event work. Select its character and
trigger. Detailed limits, tools and notifications remain under advanced controls.
Goals can also have recurring starts; a routine can wake a linked goal. A paused
goal remains paused. Work requires the HUB computer to be running; closing the
PWA does not stop it. Quota, budget and approval requirements still apply.

## Knowledge colors and workspace scope

Confirmed domains share a domain color. Locally suggested communities use their
own display group; these do not create memberships or factual links. Unassigned
records have individual tints until organized. **Colors & memory scope** explains
the legend in both graph views.

Knowledge is one shared vault across workspaces and characters. A workspace is
the working folder for files and tools; changing it does not create a new memory
vault. Character tool permissions still restrict access. Domain organization is
independent of workspace folders. Review or admit data deliberately when it
should become available to assistants using that shared memory.
