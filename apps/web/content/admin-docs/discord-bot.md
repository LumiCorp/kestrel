# Discord Bot

Discord support is configured from `/admin/tools`.

The Kestrel One runtime uses:

- `/api/webhooks/discord` as the interactions endpoint
- `/api/discord/gateway` to activate the message gateway listener
- one Discord guild binding per organization
- the shared adapter runtime with Redis-backed state when `REDIS_URL` is present

Discord replies reuse the same active knowledge snapshot and chat persistence model as web chat.

## Required configuration

1. Set `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_PUBLIC_KEY`.
2. Open `/admin/tools`.
3. Save the organization’s Discord `guildId` and optional `guildName`.
4. Copy the interactions endpoint URL into the Discord application settings.
5. Use the install URL from the tools page to add the bot to the guild.
6. Activate the gateway listener from the same page.

## Behavior

- A mention outside a thread creates or claims a Discord thread for the conversation.
- A mention inside a thread uses that thread as the canonical conversation.
- Follow-up non-bot messages inside a bound thread continue the same Kestrel One chat.
- Unbound guilds and non-thread non-mentions are ignored.
