# Let the store arbitrate aborted idempotent completion

## Failed behavior

`CodeExecutionService` skips exact-result persistence when cancellation is already observed. That bypasses the store's atomic idempotent check, so an aborted competing attempt can mark the lease cancelled even when an identical DONE result has already committed.

## Repair requirements

Every completed output must reach the atomic exact-result store with its abort signal. The store alone decides whether an identical prior commit wins or a new aborted write loses. Settlement and delivery must derive from that decision.

## Done when

- Aborted completion with no prior DONE produces cancellation and no result.
- Aborted completion with an identical committed DONE preserves completed outcome and success.
- Conflicting DONE remains rejected.
- Service-level deterministic concurrency/idempotency coverage proves both branches.

## Depends on

10 and 11.
