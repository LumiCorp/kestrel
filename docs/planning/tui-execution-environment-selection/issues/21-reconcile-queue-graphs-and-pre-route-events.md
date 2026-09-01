# Reconcile queue graphs and pre-route events

## Failed behavior

Issue 20 made settlement durable and serial, but review found three remaining contradictions in the queue state machine. Removing an absent or rejected predecessor can strand its successor; existing issue-19 records may form a fork rather than a chain; queued checkpoint recovery recursively reacquires its own settlement gate; and exact start or terminal events received before the routed response are discarded because pending queue records are not recognized as ownership evidence.

## Affected flow

This repairs [Make submission settlement durable and serial](20-make-submission-settlement-durable-and-serial.md) as implemented by commit `ad0a0b758`.

The owning surface is the persisted queue graph normalizer and the single per-session settlement transaction. Repairs must use exact persisted message/run/thread evidence and runtime routes; do not infer order from timestamps or names.

## Repair requirements

- When an absent, rejected, or rolled-back Q1 is removed while Q2 names Q1 as predecessor, durably rewire Q2 to Q1's exact predecessor before removal. Apply the same repair during live rejection, indeterminate reconciliation, response loss, and restart.
- Normalize backward-compatible issue-19 forked records such as Q1->R0 and Q2->R0 into one deterministic exact queue chain using persisted collection order only where that order is already the durable journal order. Reject cycles, duplicate/conflicting identities, and ambiguous graphs rather than guessing. Live and restart promotion must then accept Q1 followed by Q2.
- Make checkpoint recovery transaction-aware. A queued checkpoint failure must settle/transfer ownership and retry without reacquiring a settlement gate held by its caller. Preserve captured session/profile/workspace/environment and exact queue evidence; never widen or silently bypass serialization.
- Recognize an exact pending queue submission as ownership evidence for `run.started`, `run.completed`, `run.failed`, and `run.cancelled` received before the routed response. Settle the pending record exactly once into current, waiting, or terminal durable state.
- A later delayed routed response for the already-started or terminal run must be idempotent and cannot regress it to queued, resurrect pending evidence, duplicate history/output, or overwrite a newer lifecycle.
- Preserve indeterminate restart barriers, reverse response ordering, multiple terminal tombstones, captured-session output gating, and exact environment identity.

## Done when

- R0 active with Q1 rejected/absent and Q2 accepted rewires Q2 to R0 and promotes Q2 live and after restart.
- Persisted issue-19 forked Q1/Q2 records normalize compatibly and permit sequential Q1 then Q2 promotion and a subsequent Q3 queue without a multiple-tail failure.
- A queued compact/summarize-forward checkpoint response retries to completion without hanging and retains captured ownership.
- Exact queued start then terminal events received before a delayed queued route response persist terminal truth once; the delayed route response is a no-op for lifecycle authority.
- Cycle, duplicate, and conflicting queue graphs fail closed with focused proofs.
- Existing controller, app-command, session-store, queue, restart, checkpoint, response-loss, environment, and lifecycle focused files remain green.

## Depends on

None.
