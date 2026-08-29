# Make durable describe strictly read-only and deterministic

## Failed behavior

Issue 04 moved `session.describe` to durable store authority, but four edges still violate its contract. Inbox projection can create or resolve operator-attention records. Conflicting thread and active-bundle environment identities are silently collapsed to the thread value. Ordinary-turn recovery accepts a description for a different session. Equal-timestamp assembly records can select different bundles after a Postgres restart.

These gaps allow a read request to mutate durable state, allow contradictory durable environment evidence to resume as if exact, and make session recovery dependent on response or database ordering that is not part of the contract.

## Affected flow

This repairs [Make session describe durable and environment-authoritative](04-make-session-describe-durable-and-environment-authoritative.md) as implemented by commit `f35f32022`.

`DurableSessionDescriber` uses `OperatorControlPlane.listOperatorInbox`, whose attention synchronization writes records even when focus persistence is disabled. `toOperatorAssemblySummary` prefers `ThreadRecord.environmentPresetId` without validating bundle metadata. `TuiRunController.resolveActiveSessionEnvironment` validates response type and environment but not `payload.sessionId`. Durable assembly selection compares only `createdAt`, while Postgres does not define an order for equal timestamps.

The owning repair surfaces are read-only operator projection options, exact environment consistency validation, response correlation in ordinary turns, and one explicit total ordering contract for durable assembly records.

## Repair requirements

- Ensure every `session.describe` projection path performs zero durable writes, including operator-attention creation, updates, and resolution for pending checkpoints, blockers, stalled runs, and obsolete attention records.
- When thread and active assembly/bundle carry environment identity, require exact agreement. Missing legacy identity may use the other exact source, but disagreement must fail closed with a stable consistency error.
- Require ordinary-turn `session.describe` responses to identify the exact requested session before consuming or persisting any identity.
- Define and apply one stable total order for thread assembly records, including equal `createdAt` values, consistently in in-memory and Postgres-backed reads and durable description.
- Preserve complete operator projection parity without invoking mutating reconciliation helpers.
- Preserve runtime assembly immutability, deterministic replay, exact Safe/Developer identity, and existing non-describe operator-attention behavior.
- Do not infer environment or assembly authority from labels, paths, cached runtime order, or partial overlap.

## Done when

- Describing sessions with pending checkpoints, child blockers, stalled attention, and obsolete attention records leaves all durable records unchanged.
- Thread/bundle environment disagreement returns a stable fail-closed consistency error and cannot activate or resume the TUI session.
- A different-session describe response cannot resume or mutate the requested session.
- Equal-timestamp assembly records resolve identically before and after restart under the explicit durable ordering contract.
- Focused regression checks cover each mutation branch, identity conflict, wrong-session response, and equal-timestamp ordering.
- Complete-flow validation proves issue 04 while preserving operator projection fields.

## Depends on

None.
