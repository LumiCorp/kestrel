# Unify submission and response ownership

## Failed behavior

Issue 18 scopes preparation and queue journaling to the submitting session, but response ownership is still implemented separately across routed, direct terminal, event, fresh-turn, and reply branches. As a result, an older queue can overwrite or stop a newer accepted run, a promoted queue can be rejected because its predecessor remains accepted, deleted sessions can still dispatch after the barrier, result-less failures can cross sessions, and non-queue/reply focus switches still mutate the visible session. An ambiguous failed rollback can also release later queue work without settling the rejected journal record.

## Affected flow

This repairs [Make queue transactions session-scoped and multi-run](18-make-queue-transactions-session-scoped-and-multi-run.md) as implemented by commit `663802ed7`.

The owning repair surface is one exact captured-submission response rule shared across every TUI dispatch path, plus fail-closed queue journal settlement.

## Repair requirements

- Treat an older persisted accepted run as replaceable by an exact promoted queued run only when durable active/waiting evidence proves the queue is now current. Preserve a different accepted run when it represents newer current evidence.
- For an exact older queued terminal received after another run becomes accepted, consume and tombstone the older queue without changing the newer accepted run, its lifecycle status, or visible running state. Apply this to routed, direct completed/failed/cancelled/waiting, response-loss, and event paths.
- Revalidate that the captured submitting session still exists immediately before dispatch and again before every response/recovery mutation. If it was deleted, do not dispatch; if deletion occurs after dispatch, do not report success or mutate another session, and preserve diagnostics for the unowned runtime.
- Validate top-level session and run identity even when a `run.failed` response has no result payload. A result-less failure for another session cannot consume or tombstone the captured submission.
- Apply all fresh-turn and reply/operator-control responses, failures, checkpoint recovery, wait clearing, and response-loss recovery to the captured submitting session. A focus switch must not redirect any of them to the active session.
- Gate scripted completion markers and every visible output on the owning session still being active.
- If a required queue barrier may have committed but its response is lost and the compensating rollback cannot be durably saved, keep the transaction fail-closed. Do not dispatch the rejected submission or release later queue submissions as though settlement succeeded. Reconcile the indeterminate journal against exact durable route absence or presence before the session can queue again.
- A route that is exactly absent after an indeterminate pre-dispatch journal may be removed as orphaned recovery evidence; a present exact route must retain normal queued/active/terminal recovery. No inference from time or ordering.
- Preserve multiple terminal tombstones, inactive/delegated startup reconciliation, current-only legacy backfill, exact environment authority, and deterministic persistence.

## Done when

- A normal predecessor R0 does not block exact promoted queue R1 recovery, while an exact older queue terminal cannot replace or stop newer current R2.
- Delayed routed and direct completed/failed/cancelled/waiting responses preserve a different newer accepted run and consume only the older pending/queued evidence.
- Deletion before dispatch prevents Local Core submission; deletion after dispatch cannot mutate another session or return a false successful ownership result.
- Result-less failure with the wrong top-level session is rejected without consuming exact A evidence.
- Focus switches during fresh-turn and reply dispatch/recovery leave every lifecycle and history mutation on A and leave B unchanged.
- Applied-but-response-lost barrier plus failed rollback blocks later queue dispatch until exact reconciliation settles the journal.
- Scripted inactive completion events do not add transcript/history markers to the active session.
- Existing journal, tombstone, multi-terminal, queue, reply, environment, delegated, restart, and lifecycle proofs remain green under focused full-file tests.

## Depends on

None.
