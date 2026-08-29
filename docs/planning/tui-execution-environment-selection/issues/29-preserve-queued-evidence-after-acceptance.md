# Preserve queued evidence after acceptance

## Failed behavior

Issue 28 serializes many session mutations, but exact queued evidence is still treated as pending-only in direct and response-loss paths. A pre-route start removes that record and bypasses terminal validation. Active history/cursor updates still mutate outside the transaction, background/describe projections may be computed before turn ownership, delegated pending starts are not wired through the event router, and delayed task updates can regress terminal lifecycle.

## Affected flow

This repairs [Serialize session mutations and terminal correlation](28-serialize-session-mutations-and-terminal-correlation.md) as implemented by commit `3162bc81f`.

The owning repair is one exact queued-lifecycle evidence resolver covering pending submissions, reservations, accepted queued predecessor identity, and tombstones, plus mutation callbacks that compute from current state only after acquiring the ordered turn.

## Repair requirements

- Resolve queued ownership from exact session/thread/run/message across pending submissions, reservations, accepted queued identity with predecessor authority, and terminal tombstones. Pending removal after start cannot disable terminal validation or recovery.
- Direct completed/failed/cancelled responses and applied-response-lost recovery always require the shared exact terminal-turn validator when the run is known to be queued, including after pre-route accepted start. Exact replay remains idempotent and emits output once.
- Wire delegated `run.started` routing to exact pending pre-route submissions as well as reservations and accepted evidence. Require exact source message; delayed routed response cannot regress the accepted start.
- Compute background start/terminal, describe projection, task update, active/inactive history metadata, and terminal recovery cursor mutations inside the per-session/global mutation turn from the latest committed session. Do not capture an expected object or patch outside the turn.
- Route active-session history metadata and terminal recovery cursor persistence through the same transaction so they cannot replace a queue commit with stale lifecycle state.
- Make task/delegation updates monotonic from exact source revision/time and run identity. An older RUNNING/RECOVERING update cannot regress a newer WAITING/COMPLETED/FAILED/CANCELLED lifecycle or clear `lastRunStatus`; exact newer updates continue normally.
- Preserve exact environment, accepted predecessor, queue graph, wait state, history event-id dedup, and restart behavior.

## Done when

- Pre-route exact queued start followed by direct terminal or response loss still requires exact terminal authority, settles durably, and emits once; every mismatch/duplicate/RUNNING-only variant stays fail-closed.
- Delegated pending pre-route `run.started` reaches the actual event router, commits, and survives delayed/lost route response; missing/wrong source message is rejected.
- Reverse-order task/history mutation first, then exact queued start or describe terminal queued behind its save, applies the runtime evidence from the latest committed child rather than dropping it.
- Active history metadata and terminal cursor interleavings with queue success, before-write failure, and applied-then-thrown preserve final disk/UI authority.
- A delayed older task RUNNING/RECOVERING update after exact terminal child state is ignored; restart remains terminal and consistent.
- Existing App, controller, SessionStore, graph, delegated/background, persistence-failure, response-loss, checkpoint, history, restart, terminal-output, environment, and lifecycle focused files remain green.

## Depends on

None.
