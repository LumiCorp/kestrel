# Sandbox capability #414 repair queue

This temporary repo-local queue is authoritative for the independent review repairs blocking GitHub issue #414. Remove this directory after every repair is Done and #414 passes final review.

## In progress

None.

## Implemented

- [01 — Make committed results crash-safe and effect-replayable](01-crash-safe-result-replay.md)
- [02 — Share one atomic ceiling across parent and child invocations](02-shared-parent-child-ceiling.md)
- [03 — Revalidate current policy and approval authority](03-current-policy-and-approval.md)
- [04 — Reconcile interrupted requested and child issuance](04-requested-issuance-recovery.md)
- [05 — Dispose sensitive material before container teardown](05-sensitive-disposal-order.md)
- [06 — Preserve cancellation outcome during provider invocation](06-provider-cancellation-outcome.md)
- [07 — Preserve successful results when a selected capability is unused](07-unused-capability-result.md)
- [08 — Close the post-handler exact-result crash window](08-post-handler-result-crash-window.md)
- [09 — Snapshot exact results before asynchronous persistence](09-immutable-result-snapshot.md)
- [10 — Let cancellation dominate pre-cleanup result persistence](10-cancellation-dominates-result.md)

## Done

None.
