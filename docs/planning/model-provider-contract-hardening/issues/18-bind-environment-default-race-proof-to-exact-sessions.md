# Bind Environment default race proof to exact sessions

## Failed behavior

Issue 17 waits for any PostgreSQL lock in the test database. Although the lane runs sequentially, that observation is broader than the default-selection request and credential-rotation transaction under test, so an unrelated session could satisfy it.

## Affected work

[Make Environment default concurrency proof deterministic](17-make-environment-default-concurrency-proof-deterministic.md) was implemented in `ed0cfdde4`. The production boundary remains correct; this issue binds the behavioral observer to the exact competing sessions.

## Repair requirements

- Capture the rotation transaction's backend PID before it holds the gateway row.
- Release the rotation only when PostgreSQL reports a session blocked by that exact backend PID. The Environment PostgreSQL lane runs tests serially, so no other request can contend on this fixture row.
- Retain the bounded timeout, cleanup, and stale/no-default assertions.

## Done when

- The race test can only pass after the exact selection request is blocked by the exact credential-rotation transaction.
- Existing Issue 17 behavior remains green and its review finding is closed.

## Depends on

- [Make Environment default concurrency proof deterministic](17-make-environment-default-concurrency-proof-deterministic.md) (implemented; review pending)
