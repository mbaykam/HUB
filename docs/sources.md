# Sources and acknowledgments

These are primary project resources. Links checked on 11 October 2026.

## Product foundation

| Project | Relationship to HUB | Source |
| --- | --- | --- |
| Minke, by lencx | Original desktop shell/product foundation; HUB is an independently maintained fork. | [Repository](https://github.com/lencx/Minke) |
| DeepSeek Harness | Native agent/session/tool runtime and plugin composition. HUB pins a specific commit, rather than assuming the current upstream API. | [Repository](https://github.com/deepseek-ai/deepseek-harness) · [HUB runtime pin](../config/harness-runtime.json) |
| Pi | Provider/agent ecosystem reached through the underlying Harness. The older `badlogic/pi-mono` address redirects to the current repository. | [Repository](https://github.com/earendil-works/pi) |

## README presentation references

The page's text and visuals are original. These READMEs informed its structure:

- [OpenClaw README](https://github.com/openclaw/openclaw/blob/main/README.md): a
  clear product promise, a quick start, channel overview and focused documentation.
- [OpenCode README](https://github.com/anomalyco/opencode/blob/dev/README.md):
  restrained branding, an interface preview and concrete installation choices.
- [Pi README](https://github.com/earendil-works/pi/blob/main/README.md): a concise
  explanation of extensibility with developer commands and component links.

They are references for presentation, not claims that HUB embeds OpenClaw or
OpenCode, and not claims of affiliation or endorsement.

## Optional components

- [Pipecat](https://github.com/pipecat-ai/pipecat): local speech pipeline and WebRTC integration.
- [Camofox Browser](https://github.com/redf0x1/camofox-browser): the Windows portable browser runtime used by the optional bridge; derived from [jo-inc/camofox-browser](https://github.com/jo-inc/camofox-browser).
- [Cytoscape.js](https://js.cytoscape.org/): graph infrastructure.
- [Supertonic 3 model](https://huggingface.co/Supertone/supertonic-3): multilingual voice styles.
- [Sherpa ONNX](https://github.com/k2-fsa/sherpa-onnx): local streaming recognition infrastructure.
- [Whisper](https://github.com/openai/whisper): speech recognition family supported by the local stack.
- [Obsidian](https://obsidian.md/): an optional editor for the normal Markdown vault; its app is not embedded or redistributed.
- [Telegram Bot API](https://core.telegram.org/bots/api): text-bot transport, separate from user-account calling.

The source license does not relicense downloaded model weights or optional apps.
Consult each component's license/model card. Existing MIT/third-party notices
remain in [license resources](../resources/licenses/) and the
[Weixin transport notices](../packages/im-weixin/THIRD_PARTY_NOTICES.md).
