# Serialize and reconcile queued ownership

## Failed behavior

Issue 16 records independent pending queue submissions, but the record is not yet an acknowledged durable barrier. Session-save failures are swallowed before dispatch, concurrent snapshots can rename out of order, and a response handler reads and mutates whichever session is currently active rather than the session that submitted the queue. Restart reconciliation also handles only a route that remains queued, not one already promoted or terminal, and an inactive session's terminal leaks into the visible session's run log.

## Affected flow

This repairs [Make queued lifecycle ownership crash-durable and thread-exact](16-make-queued-lifecycle-crash-durable-and-thread-exact.md) as implemented by commit `61fdea355`.

The owning repair surface is acknowledged ordered session persistence, session-addressed queue response mutation, and exact active/terminal describe reconciliation for pending submissions and queued reservations.

## Repair requirements

- Make pre-dispatch pending-queue persistence an acknowledged durability barrier. If the session record cannot be saved, do not submit the message to Local Core.
- Serialize session-file writes in invocation order so an older snapshot cannot rename after a newer snapshot. Preserve atomic temp-file replacement and propagate failures to callers that require an acceptance barrier.
- Keep concurrent queue submissions independently durable across out-of-order responses and write completion.
- Apply a queue response and response-loss recovery to the captured submitting session, even if the operator switches to another session while the request is in flight. Never read or append the source reservation through the current active session.
- On restart, reconcile an exact pending queue submission that durable describe reports as queued, started, waiting, completed, or failed. Install queued, accepted, or terminal ownership according to the exact run/message/thread evidence and remove only the matching pending record.
- On restart, reconcile an existing queued reservation from an exact durable active or terminal run so a process exit before the asynchronous terminal write cannot permit a delayed start regression.
- Preserve terminal monotonicity if `run.started` arrives after exact terminal describe evidence.
- Do not append an inactive session's terminal diagnostics to the visible active session's run-log pane. Preserve all other visible and durable active-session state.
- Do not infer ownership from ordering, focus, labels, or timestamps.

## Done when

- An injected session-save failure prevents the queue command from reaching Local Core and leaves a truthful failure surface.
- Delayed and reordered concurrent session saves cannot erase the newer pending queue record.
- A valid queue response for session A after focus switches to B updates only A, including response-loss recovery.
- Restart recovers a pending submission already promoted to active, waiting, or terminal and accepts only its exact later events.
- Restart recovers an exact terminal for a confirmed queued reservation even if the process exited before the terminal callback finished saving; a delayed start cannot regress it.
- Inactive completed, failed, and cancelled terminals leave the active session's run logs and visible state unchanged.
- Existing queue, reply, restart, wrong-thread, background, and lifecycle proofs remain green under focused full-file tests.

## Depends on

None.
