# HUB interface direction

Maintained interface direction: Glassmorphism and gradient mesh are
the product's visual language. Maintain one dark appearance. Do not continue
developing a light palette; legacy native light resources may remain upstream.

- Dark blue-black canvas, soft blue/violet/teal mesh, translucent tinted panels,
  fine borders and restrained shadows. Keep text legible over gradients.
- Use shared ambient theme tokens; preserve native theme/state ownership.
  HUB selects dark through the public theme service and shades the native
  Appearance row with its single maintained appearance.
- Compact, calm hierarchy. Avoid duplicate state messages, metadata labels,
  unnecessary meters and controls competing with the primary action.
- Voice: selected assistant in the header, one state below the reactive orb,
  live words and transcript. Language/engine/voice selection belongs in character
  settings; it is not a label in the live conversation screen.
- Keep Mute, Interrupt, open conversation, End voice, error visibility and
  screen reader announcements. Presentation changes must not own audio state,
  restart calls, move a call to another character, or create a new transcript.
- Respect reduced motion, reduced transparency and high contrast preferences.
  Use CSS/native assets for gradients and simple visuals.
- Check mobile widths and keyboard navigation in the served PWA. UI-only
  changes use the compatible update path described in HUB_UI_UPDATES.md.
