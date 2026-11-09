# Interactive canvas

Ask any conversation character to explain something visually, or let it suggest
one when a diagram, comparison, chart or hands-on example would help. Examples:

- “Show how compound growth changes when I move the monthly contribution.”
- “Explain this workflow with a diagram.”
- “Build a small interactive unit converter here.”
- “Let me adjust the values and see how the result changes.”

The canvas appears inside your conversation. You can keep typing or speaking,
**Expand** it, return to chat, or **Hide** it and reopen it with **Canvas**.
Expanding preserves the current interactive frame. **Options** contains reset,
pausing incoming versions and showing the latest version. A revised explanation
replaces the previous version when live updates are enabled.

The controls belong to the visual itself. HUB does not add game controls to
calculators, lessons or diagrams. Existing saved HTML files can still be opened
from the conversation's Apps list or Knowledge's Open app action.

Characters share a generated `canvas.md` guide covering when and how to use
`hub_present`, with examples, phone accessibility, updates and limits. You can
inspect it under **Settings → AI Instructions → Advanced**. It follows character
roles and tool permissions, independently of names and personality instructions.

The three formats are passive HTML/SVG, interpreted Vega charts and scripted
HTML apps. Scripted apps can use local inputs, buttons, canvas, inline CSS and
JavaScript. They must include their own controls and embed their resources/data.
They cannot use the network, saved accounts, persistent storage, microphone,
camera, HUB files or agent tools. Local controls do not call a model or spend
provider tokens. Real tasks still use the agent's usual tools and permissions.

The latest successful visual is recoverable from its saved conversation's tool
receipts after a restart. Form values and animation state are temporary: reload,
reset or replacement starts them over. A model publishing a visual does not mean
you have opened or seen it. Original HTML attachments remain unchanged.
