# Make cleanup release state monotonic

## Failed behavior

Cleanup retry discovery excludes a real FAILED release effect, so a transient
handler failure never retries. A failure after persisting the DONE result but
before marking the effect DONE can then downgrade the effect to FAILED, leaving
contradictory terminal evidence that recovery rejects forever. Separately, if
Web observes runner start but fails to persist the execution binding, the next
worker can use generic terminal failure and mark cleanup complete without proof
that release occurred.

## Affected work

[Recover completed cleanup with bounded reconciliation](06i-recover-completed-cleanup-with-backoff.md),
commit `a935b0464`, especially effect discovery/status writes,
`InlineEffectRunner` failure handling, exact DONE recovery, and the interrupted
cleanup branch in `apps/web/lib/turns/process-runtime.ts`.

## Repair requirements

Discover and reset only the exact marker-bound FAILED cleanup release before
DONE recovery. Make effect/result terminal state monotonic: an exact persisted
DONE result must repair or preserve DONE effect status and may never be
downgraded to FAILED. Re-read and validate exact result evidence when a status
write fails. A running cleanup without a durable reattachable execution binding
must reconcile to the replacement path and may not use generic terminalization.
Leave ordinary failed effects and ordinary interrupted turns unchanged.

## Done when

- A real release handler failure followed by success retries once and converges.
- Failure between DONE-result persistence and DONE-effect status persistence
  converges with one release and consistent DONE evidence.
- Execution-binding persistence failure followed by runner release failure
  keeps cleanup nonterminal and reaches replacement reconciliation.
- Full effect-runner, runner/Web, and PostgreSQL fault tests prove all three
  paths and ordinary terminal behavior remains unchanged.

## Depends on

[Recover completed cleanup with bounded reconciliation](06i-recover-completed-cleanup-with-backoff.md).
