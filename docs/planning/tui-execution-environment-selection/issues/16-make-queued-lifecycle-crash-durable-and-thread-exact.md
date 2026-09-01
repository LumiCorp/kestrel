# Make queued lifecycle ownership crash-durable and thread-exact

## Failed behavior

Issue 15 persists confirmed queued reservations, but acceptance is still not exact or durable across every ordering. A foreground queued terminal with the right run and wrong thread can consume a reservation. A queued terminal received while another session is active is not written back to its owning foreground session. Two concurrent queue submissions still overwrite one singular pre-confirmation slot. Restart recovery also expects a queued route to expose a run ID before promotion even though Local Core's durable queued route does not.

## Affected flow

This repairs [Separate queued reservations and backfill thread ownership](15-separate-queued-reservations-and-backfill-thread-ownership.md) as implemented by commit `bcab6e5e4`.

The owning repair surface is exact per-submission reservation persistence, queued-route reconciliation by durable request/message/thread evidence, and terminal application to the owning persisted session regardless of current UI focus.

## Repair requirements

- Reject completed, failed, and cancelled foreground queued terminals unless the event run and thread match one persisted queued reservation. Never fall through from a failed queued lookup to unknown-run acceptance.
- Claim, consume, and apply queued terminal ownership with the same exact run/thread reservation. Do not select a reservation by run ID alone after validating different evidence.
- Apply an exact terminal-before-start to its owning foreground session even when another session is active. Persist the terminal state and reservation removal so restart cannot accept a delayed `run.started` for that run.
- Preserve the active session's visible state when a terminal is durably applied to a different foreground session.
- Make each in-flight queue submission independently crash-recoverable before Local Core acceptance can outlive the TUI response handler. Confirmation or failure for one submission must not clear another submission's evidence.
- Recover an actual durable pre-promotion queued route after restart from its exact request/message/thread evidence even when the route has no run ID. Do not infer ownership from ordering, labels, focus, or timestamps.
- Preserve queued reservations across an intervening reply and across response loss after restart.
- Keep background and foreground ownership rules separate where their persisted lifecycle differs, while requiring exact run/thread evidence for both.

## Done when

- Completed, failed, and cancelled queued foreground terminals with a wrong thread are rejected without consuming or mutating the reservation.
- An exact queued terminal received while its foreground session is inactive is persisted once; after restart, a delayed start cannot regress it to running.
- Two concurrent queue submissions cannot erase each other's pre-confirmation recovery evidence, including a crash after Local Core accepts one but before its response is persisted.
- Restart converts the real run-less queued-route description into durable queued ownership using exact request/message/thread evidence, and a later exact promotion remains accepted after an intervening reply.
- Existing single-queue, multi-queue, response-loss, reply, background, backfill, and lifecycle monotonicity proofs remain green.
- Focused full-file tests pass without running the repository-wide validation gate.

## Depends on

None.
