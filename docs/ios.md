# Prepare the iPhone app

HUB currently runs through the PWA and Telegram. The separate iOS development
client is in development. Its initial connection screen uses your existing HTTPS
sign-in and preserves the app's web session. A separate native voice path is in
development and needs physical-iPhone acceptance. Siri, opt-in notifications,
file sharing and consented screen capture have development implementations;
their account configuration and physical-device acceptance remain required.

You can prepare its project on Windows and use the manual macOS GitHub Actions
workflow to compile an unsigned simulator build. The protected manual signing
workflow has also produced a real Apple-signed archive and App Store export.
TestFlight delivery additionally needs your App Store Connect app record and
upload access. None of those credentials are needed for the simulator workflow.

See the [iPhone setup guide](../mobile/README.md) for commands, the cloud build,
account-owner steps and the remaining native integration work. This preparation
does not change your installed HUB, PWA, conversations, vault or character settings.
