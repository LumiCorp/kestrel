# Make submission settlement durable and serial

## Failed behavior

Issue 19 unified most captured-session response handling, but independent review found that the ownership contract is still incomplete across restart, multi-queue promotion, concurrent response settlement, checkpoint retry, and deletion races. An indeterminate queue barrier is remembered only in memory; multiple queues can retain the same stale predecessor; response handlers can derive writes from concurrent stale snapshots; a rejected delayed start can poison observed authority; and several awaited paths can still report success or update the wrong visible lifecycle.

## Affected flow

This repairs [Unify submission and response ownership](19-unify-submission-response-ownership.md) as implemented by commit `fa71af70b`.

The owning repair surface is the durable per-session submission journal and its single serialized settlement path. Captured-session history, checkpoint retry, response publication, and observed runtime authority must all consume the result of that settlement rather than independently mutating active-session state.

## Repair requirements

- Persist whether a pending queue journal record is indeterminate after an applied-but-response-lost required save and a failed compensating save. A process restart must reconstruct the fail-closed barrier and reconcile the exact message/run/thread route before another queue can dispatch. Do not rely on an in-memory-only marker, time, or ordering inference.
- Represent the actual queue chain. When Q1 and Q2 are submitted behind accepted R0, exact promotion of Q1 followed by exact promotion of Q2 must be accepted live and after restart. Do not let both queues retain an immutable R0 predecessor if runtime order proves Q1 is Q2's immediate predecessor; preserve protection against an older queue replacing a genuinely newer accepted run.
- Serialize every same-session queue response settlement with queue journaling. Routed, direct terminal, response-loss, event, and recovery handlers must read and write pending submissions, reservations, tombstones, and accepted identity within one current per-session transaction so concurrent Q1/Q2 responses cannot resurrect or drop evidence.
- Publish `observedActiveRunBySession` only after durable foreground synchronization accepts the exact lifecycle. A rejected delayed `run.started` cannot become in-memory current authority or make its later terminal own the newer lifecycle.
- Capture checkpoint recovery ownership before the `operator.control` await. Recovery history, restored wait, recursive retry, profile, workspace, and environment must remain addressed to the captured session even if focus moves; if the owner is deleted, fail without dispatching under another session.
- Revalidate owner existence immediately before each response/recovery mutation and treat a failed session-addressed mutation as a failed ownership result. Close the deletion-after-check race around awaited view installation, diagnostics, history, and persistence; never return success for an unowned response.
- Apply terminal UI/history output only when the exact response owns the current lifecycle. In particular, `run.completed` carrying normalized `output.status === "FAILED"` for an older queued run may tombstone that run but cannot stop, fail, or overlay a newer accepted run.
- Preserve exact session/run/message/thread/environment identity, deterministic persistence, multiple tombstones, delegated and inactive reconciliation, and backward-compatible reading of existing session records.

## Done when

- An indeterminate queue barrier survives controller/process reconstruction and blocks Q2 until exact route reconciliation durably settles Q1.
- R0 -> Q1 -> Q2 sequential promotion succeeds live and after persisted restart while a stale queue cannot replace newer accepted evidence.
- Concurrent or reverse-order Q1/Q2 routed and terminal responses leave each exact record settled once without resurrection or loss.
- A predecessor-rejected delayed start followed by its terminal cannot stop or overwrite the newer accepted run.
- Focus switching during checkpoint-control recovery leaves all recovery history, wait state, retry dispatch, workspace, profile, and environment on A; B remains unchanged.
- Deleting A during an awaited response-processing step prevents subsequent mutation and prevents a true/successful ownership return.
- An older `run.completed` with FAILED normalized output cannot change newer R2's running/status/error presentation.
- Existing queue, response-loss, restart, session-store, app-command, controller, environment, and lifecycle focused test files remain green.

## Depends on

None.
