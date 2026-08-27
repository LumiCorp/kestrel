# Release a Web-rejected prepared approval

## Failed behavior

When Web receives an expired Remember decision, it terminalizes the durable
turn and returns without dispatching a continuation. The waiting runner never
executes its `release_prepared_tool_call` transition, so the retained prepared
execution source remains owned by the runtime session. The same leak occurs
when new Web terminalizes a metadata-less legacy V3 Remember decision.

## Affected work

[Version trusted hosted approval timing](06a-version-trusted-hosted-approval-timing.md)
and [Make hosted tool availability and approval one truthful decision](06-unify-hosted-tool-decision.md),
especially `apps/web/lib/turns/store.ts`, the durable resume route, Acter
approval expiry handling, and prepared-call ownership tests.

## Repair requirements

Keep the durable interaction and runner cleanup transaction truthful. A new
timing-required Remember decision received after expiry must create no
remembered record and must resume only far enough for the runner to reject the
expired authority and release the exact prepared call; it must never execute
the tool. A legacy V3 Remember submission must fail closed without
terminalizing or abandoning its still-pending prepared call, so the user can
still Decline or Approve Once through the legacy contract. Preserve duplicate
decision and lock-order behavior.

## Done when

- Expired Remember creates no remembered record and no tool execution.
- The exact retained prepared call reaches terminal release once, including
  across replay/retry.
- A direct legacy V3 Remember submission creates no record, does not execute,
  and leaves the canonical V3 approval safely resolvable by Decline or Approve
  Once.
- PostgreSQL and runtime tests cover the Web transaction, continuation, release
  effect, duplicate submission, and restart boundary.

## Depends on

[Version trusted hosted approval timing](06a-version-trusted-hosted-approval-timing.md).
