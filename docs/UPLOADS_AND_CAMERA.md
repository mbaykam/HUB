# Photos, files and the voice camera

In the PWA Home or chat composer, tap the paperclip and choose **Photos** or
**Files**. Add a question, review the image previews or file chips, then send.
Remove an unwanted attachment before sending. If sending fails, the draft and
its attachments stay available to retry.

You can attach up to eight items per message, with a 25 MB maximum per file.
The host's configured image limits also apply. Photos support JPEG, PNG, WebP
and GIF; convert HEIC photos to JPEG first. Images require a model with vision
support. Text, Markdown, CSV, JSON and log files provide bounded text previews.
PDF, DOCX and XLSX extraction uses the local document runtime when available.
Other file types retain their original bytes but have no automatic text preview;
an assistant must not claim to have read them.

Originals are saved in the vault's Attachments folder and associated with the
conversation archive. Uploading does not create a new brain note. Downloads
require HUB authentication and use opaque attachment receipts rather than local
file paths. Extracted document text is marked as untrusted source data.

## Show HUB something while talking

1. Start a voice conversation with Mira, or open the PWA while your Telegram
   voice call is active.
2. Tap **Camera** and allow camera access. The rear camera opens first; use
   **Switch camera** if needed.
3. Optionally describe what HUB should do, such as reading a label or explaining
   a diagram. Tap the round shutter to share one photo.
4. Keep talking to Mira. The share request queues in the same voice conversation,
   and native delegation gives HUB the actual image plus recent public context.
   Follow the background task and its result in the existing conversation/tasks.

The preview uses video only and owns no microphone tracks. Closing it releases
the camera, while the voice client keeps its separate audio connection. Each
shutter press sends one image; there is no continuous video feed. Captured photos
are JPEGs scaled to a maximum 1,600-pixel edge.

Camera permission requires a secure browser context, normally the HTTPS PWA.
If permission is declined, allow it in the browser's site settings and reopen
Camera. If upload or sharing fails, use **Retry sending** for that same photo;
the receipt prevents another task from being admitted for the same request.
Ending the call invalidates its camera ownership. Photos are never automatically
sent into a later call. HUB's admitted model must advertise image support; the
camera explains when a vision model is needed instead of pretending to analyze.

Automated acceptance covers real binary upload storage, native model-request
image delivery and browser camera/microphone simulations. Physical phone camera,
speaker echo and simultaneous Telegram/PWA behavior require device acceptance.
