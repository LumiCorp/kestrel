# Bind prestarted runs to trusted tenant authority

## Wrong behavior

Conversation-turn activation inserts a prestarted run without the store-owned tenant. Effects inherit a null tenant, so ordinary `code.execute` cancellation cannot use atomic arbitration.

## Repair owner

`PostgresSessionStore.claimConversationTurnExecution` owns creation of the prestarted run. It must persist the trusted store tenant and preserve it through effect commit.

## Completion

- Prestarted run creation writes the trusted tenant and never reads actor/event payload authority.
- Existing non-null mismatches fail closed.
- PGlite/PostgreSQL coverage proves activation, prestarted validation, effect commit, wrong-tenant rejection, and correct-tenant cancellation.
