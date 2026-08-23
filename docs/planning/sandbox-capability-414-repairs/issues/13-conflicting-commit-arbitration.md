# Preserve the winning commit on aborted conflict

## Failed behavior

An aborted competing attempt can encounter a conflicting existing DONE result. The service treats the generic conflict like cancellation with no commit and rewrites the shared lease to cancelled, while the winning DONE result remains replayable.

## Repair requirements

Exact-result arbitration must distinguish cancellation with no committed result from conflict with an already committed winner. The conflicting attempt must fail, but it must preserve the winning completed lease outcome and replay record.

## Done when

- A conflicting aborted attempt cannot transition the winning lease to cancelled.
- The conflicting live output is rejected.
- The winning DONE result and completed lease remain authoritative.
- In-memory and Postgres concurrency tests cover a winner paused between result commit and cleanup.

## Depends on

11 and 12.
