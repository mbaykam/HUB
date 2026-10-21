# Readable written replies

Written answers use the native Markdown renderer, with a restrained heading scale,
consistent paragraph and list spacing, descriptive underlined links and a readable
line width. Tables scroll within their own area on small screens. Code retains its
indentation and scrolls horizontally instead of breaking identifiers into pieces.
Original messages, file links, mathematical notation and copy actions are retained.

Adjust reading size in **Settings → General → Font size**. The response layout
respects that preference and the browser's zoom. These styles apply to public
assistant replies; user messages, internal reasoning and tool output keep their
own presentation.

The shared **AI instructions → Assistant behavior (SOUL.md)** file can define how
characters organize future written answers. Useful rules are: lead with the
answer, group longer explanations under meaningful headings, keep paragraphs
focused, use steps for procedures, use tables for comparisons and label sources
clearly. Short answers should remain short. Formatting instructions do not change
character models or tool permissions. Spoken replies should remain natural speech.

This display update does not ask another model to rewrite existing conversations.

Design references: [Microsoft's scannable-content guidance](https://learn.microsoft.com/en-us/style-guide/scannable-content/),
[W3C visual presentation](https://www.w3.org/WAI/WCAG22/Understanding/visual-presentation.html)
and [W3C reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html).
