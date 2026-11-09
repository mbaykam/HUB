# Prepare the iPhone app

HUB currently runs through the PWA and Telegram. The separate iOS development
client is in development. Its initial connection screen uses your existing HTTPS
sign-in and preserves the app's web session. Native background voice, Siri,
notifications and phone-data integrations are not yet implemented or released.

You can prepare its project on Windows and use the manual macOS GitHub Actions
workflow to compile an unsigned simulator build. A signed iPhone/TestFlight build
additionally needs your Apple Developer account, final app identifier and signing
setup. None of those credentials are needed for the simulator workflow.

See the [iPhone setup guide](../mobile/README.md) for commands, the cloud build,
account-owner steps and the remaining native integration work. This preparation
does not change your installed HUB, PWA, conversations, vault or character settings.
