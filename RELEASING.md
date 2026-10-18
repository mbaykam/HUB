# Releasing HUB

From v1.0.0 onward, publish complete, polished features. Each release should leave
the personal assistant easier to trust and use in daily life.

## Definition of done

- Finish a concrete user workflow through the PWA and, where relevant, Telegram.
  An API endpoint or a partially connected screen alone is not a finished feature.
- Give the user clear progress, success, empty and error states. Include recovery
  for cancellation, lost connections and provider limits when the feature uses them.
- Check phone layouts, readable controls, discoverable close/back actions and
  keyboard/focus behavior for affected screens. Keep implementation detail out of
  ordinary flows unless it helps the user make a decision.
- Preserve conversations, original sources, settings and task state. Verify
  interrupted work and retry behavior where data can change.
- Run appropriate behavior tests and source checks. Use the actual interface for
  changed user flows. Label fixture/device simulations honestly; a voice change
  needs physical audio acceptance before claiming its quality or latency is verified.
- Update setup/operating guidance and sanitized screenshots. Keep unfinished
  features in development; release notes must describe behavior actually delivered.

## Version and artifacts

Use patch versions for fixes, minor versions for completed new capabilities and
major versions for incompatible changes. Align first-party manifests with:

```sh
node scripts/forge/set-version.mjs 1.0.0
```

The published installer profile is currently **Windows x64**. Manual packaging
can still exercise other targets, but a successful build alone is not evidence
of platform acceptance. Do not publish additional platform downloads until their
intended user workflows are verified and the release profile is expanded deliberately.

## Publication

1. Write reviewed notes in `docs/releases/v<VERSION>.md` and update the changelog.
2. Pass source checks, appropriate regressions and the supported-platform package
   smoke test on the release commit. Inspect artifacts for private data and include
   SHA-256 checksums.
3. Verify the normal upgrade with a fresh rollback backup and no active user
   task/call. Compare installed files, served PWA assets, health and preserved data.
4. Push the reviewed commit and matching `v<VERSION>` tag to the HUB repository.
   Never replace an existing published tag or artifact to fix a release.
5. Use a draft while uploading. The publisher checks the exact profile and GitHub's
   asset digests before making the release public. Keep immutable releases enabled;
   fix a published defect in the next version.
6. Confirm the public release, downloads, checksums and versioned instructions.
   Keep the user's installed runtime and PWA aligned with the published version.

Tagged builds publish `HUB-windows-x64.exe` and `SHA256SUMS`. The release workflow
retains typechecks, tests and packaged-runtime smoke checks; failures stop publication.
