# Telegram

[Documentation](README.md) · [Voice](voice.md)

## Text bot

Create your own bot with Telegram's BotFather, then add its credentials through
HUB's Telegram/Connections interface. Open the bot from your Telegram account
and send `/start`. Approve the matching pairing in HUB; an unpaired sender is
not admitted as the assistant's user.

The paired text conversation uses the configured main HUB character. Replies
and delegated-work updates edit the current Telegram message rather than posting
raw tool events as separate messages. Character, model and detailed knowledge
settings remain in the PWA.

Keep the bot token in HUB's private credential store. Source code, screenshots
and bug reports should not contain it.

## Incoming voice calls — advanced, experimental

Bot API accounts do not accept ordinary Telegram calls. The implemented call
bridge uses a separate, authorized **Telegram user account** with Telethon and
PyTgCalls/NTgCalls. It accepts incoming calls only from its configured allowlist.

Provision the user account/session outside the repository. The listener expects
a private account descriptor containing `apiId`, `apiHash`, `accountId`,
`session: account.session` and an `allowedCallers` list of numeric caller IDs.
An authorized `account.session` must exist beside that descriptor. Account login
and API credentials are separate from the bot token; the current source does
not provide a general-purpose one-click account provisioning wizard.

Set `telegramCallAccount` in the voice Host entry to the descriptor's absolute
path, install the call-runtime dependencies and restart HUB after ending any
call. An allowlisted incoming call starts the Conversation voice session. The
PWA can simultaneously observe its live transcript and provide Interrupt/End
controls without taking over the microphone.

Text-bot activity and user-account calls are separate transports. A PWA work
card does not imply an equivalent bot-message card has been delivered for a
phone call. Verify your physical phone, account and network configuration
separately; synthetic PCM/UI tests do not guarantee cellular call quality.
