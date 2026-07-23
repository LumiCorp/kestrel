# Discord Bot

Discord remains a deployment-managed messaging adapter and is not part of the
first Apps release. It no longer has a separate admin setup surface.

The Kestrel One runtime uses:

- `/api/webhooks/discord` as the interactions endpoint
- `/api/discord/gateway` to activate the message gateway listener
- one Discord guild binding per organization
- the shared adapter runtime with Redis-backed state when `REDIS_URL` is present

Discord replies use organization document retrieval and the same durable chat persistence model as web chat.

## Required configuration

1. Set `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_PUBLIC_KEY`.
2. Copy the interactions endpoint URL into the Discord application settings.
3. Add the bot to the intended guild through Discord.
4. Activate the gateway listener through the deployment process.

## Behavior

- A mention outside a thread creates or claims a Discord thread for the conversation.
- A mention inside a thread uses that thread as the canonical conversation.
- Follow-up non-bot messages inside a bound thread continue the same Kestrel One chat.
- Unbound guilds and non-thread non-mentions are ignored.
