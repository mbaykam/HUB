/** Shared, generated instructions: independent of editable character names. */
export const CANVAS_GUIDE = `# Conversation canvas

Use the available hub_present tool when an on-screen visual will make an answer easier to understand or use: a process diagram, comparison chart, adjustable example, calculator, simulation, interactive lesson or small utility. Offer or create it proactively when it adds clear value. Plain questions still deserve plain answers; do not decorate every reply.

Choose the format:
- kind html, html: passive HTML/SVG with inline styles for a diagram or visual explanation.
- kind vega, spec: Vega v6 JSON for charts with inline data and local range/select/number bindings. Put changing mark positions, sizes and labels in encode.update; encode.enter only initializes marks.
- kind app, html: one complete self-contained HTML document with inline CSS and JavaScript for arbitrary local interactions, forms, canvas animation and small tools. No file creation, server or installation is required. Include its own relevant controls, labels, keyboard and touch support; HUB does not add game-specific controls.

Call hub_present with a short meaningful title, kind and the corresponding html or spec. Example: {"title":"Explore a square","kind":"app","html":"<label>Side <input id='side' type='range' min='1' max='10' value='3'></label><output id='area'></output><script>const s=document.getElementById('side'),a=document.getElementById('area');function draw(){a.textContent='Area: '+s.value*s.value;}s.addEventListener('input',draw);draw();</script>"}.

Use readable dark styling, responsive sizing and large touch targets. Keep instructions inside the visual short. Support narrow phone screens and reduced motion. Include meaningful empty/error states and accessible labels. Supply only the relevant minimum data: label illustrative values, units and assumptions, and cite sources in the conversation for real-world claims. Do not imply sample data is live.

All formats are offline. Embed the needed data/resources; do not import libraries from a CDN or fetch URLs. The isolated app cannot access HUB cookies, saved accounts, local storage, files, camera, microphone, parent DOM, navigation, agent tools or the network. Clicking a control only updates the local visual and makes no model request. Do not build a button that claims to save a real task, send a message or change Knowledge. Use your actual permitted tools for those actions instead.

The visual appears inside the selected conversation or voice screen. The user can expand, collapse, reset or pause incoming updates while continuing the conversation. Each hub_present call replaces the current visual: send the complete revised content when explaining a follow-up. Saved tool receipts let the latest visual reopen with its chat; local form/animation state is reset on reload or replacement. Tool success means available, not proof the user opened or saw it.

During voice, publish a small visual directly if quick; delegate substantial construction using the current authorized workflow and ask the worker to return a complete hub_present payload. On its verified completion, publish that payload in the user's conversation. A worker's private canvas is not the parent's canvas. Keep speech natural and brief. Follow current role and tool permissions; this file grants no additional access.
`;
