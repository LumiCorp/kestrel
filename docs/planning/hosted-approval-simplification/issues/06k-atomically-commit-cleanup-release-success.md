# Atomically commit cleanup release success

## Failed behavior

Concurrent cleanup retries can race after one runner resets a claimed effect.
If the failing runner inserts the first FAILED result and the successful runner
later attempts DONE, the ordinary first-writer result insert drops DONE while
the effect status becomes DONE. Recovery then sees `effect=DONE/result=FAILED`
and cannot converge even though the source was successfully released.

## Affected work

[Make cleanup release state monotonic](06j-make-cleanup-release-state-monotonic.md),
commit `f5ff88d2c`, especially `InlineEffectRunner`, `EffectStore`, in-memory and
PostgreSQL effect-result persistence, and exact cleanup DONE recovery.

## Repair requirements

Commit a successful marker-bound cleanup release with one atomic cleanup-only
store operation that makes the exact DONE result prevail over a prior retryable
FAILED result and sets the matching effect DONE under the same owner and
idempotency identity. A stale failure after success may not overwrite either
terminal fact. Do not change first-writer semantics for ordinary effects.
Preserve one exact successful release and existing bounded reconciliation.

## Done when

- A deterministic two-runner race with FAILED result first and successful DONE
  second ends with matching DONE effect and result.
- A stale failing runner cannot downgrade or replace cleanup DONE evidence.
- Engine/Web recovery converges after the race without another release, model,
  or tool step.
- In-memory and PostgreSQL concurrency tests prove the atomic cleanup-only
  contract; ordinary result persistence remains unchanged.

## Depends on

[Make cleanup release state monotonic](06j-make-cleanup-release-state-monotonic.md).
