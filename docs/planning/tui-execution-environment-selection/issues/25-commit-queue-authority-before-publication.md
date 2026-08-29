# Commit queue authority before publication

## Failed behavior

Issue 24 persists accepted predecessor identity, but queued start/terminal promotion can still return success and emit output after a swallowed session-save failure. Live terminal reconciliation may accept a stale RUNNING view without terminal message/sequence correlation, while delivery deduplication can suppress a later exact replay. Incremental three-run ordering can stall, and legacy partial-route reconciliation can still flatten a valid deep chain.

## Affected flow

This repairs [Persist accepted queue order authority](24-persist-accepted-queue-order-authority.md) as implemented by commit `443e8a529`.

The owning repair surface is the queued lifecycle synchronization boundary: exact authority must be reconciled, durably committed, and only then published to controller caches, UI, history, or output.

## Repair requirements

- Make queued start and queued terminal graph/accepted-predecessor writes require a successful durable session save before returning accepted ownership. On save failure, do not publish observed authority or terminal output; preserve/reconstruct a fail-closed durable or in-memory recovery state without claiming commitment.
- A direct terminal may be promoted from an authoritative view only when that view contains an exact correlated terminal turn for session, thread, run, source message, terminal status, and unique sequence. A stale RUNNING/active-run-only view cannot authorize terminal promotion.
- Delivery deduplication cannot suppress authority reconciliation. A duplicate exact terminal received after a prior fail-closed tombstone or authority lookup failure must use newly available exact view evidence to finish durable reconciliation; output remains exactly once.
- Reconstruct a complete exact candidate chain in unique authoritative turn-sequence order, including candidates already linked by an earlier pass. Incremental Q1->Q2 followed by exact Q3 evidence must produce Q1->Q2->Q3, not retain a terminal fork.
- For legacy sessions without accepted predecessor authority, partial active/queued route evidence cannot select and flatten a deeper descendant. Preserve an already-valid Q1->Q2->Q3 edge; require complete ordering evidence to repair an actual sibling fork.
- Keep event cache, projected UI, transcript/history, accepted predecessor, graph records, and disk state monotonic across retry and restart.

## Done when

- Injected required-save failure during queued start and queued terminal prevents accepted publication/output; restart reads no falsely committed predecessor authority, and later exact reconciliation succeeds.
- A stale Q2 RUNNING view cannot authorize Q2 terminal promotion; an exact terminal view on replay can, even after the event was previously observed/tombstoned.
- Incremental exact reconciliation advances Q1->Q2->Q3 when full sequence becomes available.
- Legacy accepted Q1 with valid Q2->Q1->Q3 chain remains unchanged by duplicate start and partial-route restart views.
- Completed/failed/cancelled output is emitted once and only after durable terminal authority commits.
- Existing graph, controller, app-command, session-store, persistence-failure, restart, terminal-output, checkpoint, environment, and lifecycle focused files remain green.

## Depends on

None.
