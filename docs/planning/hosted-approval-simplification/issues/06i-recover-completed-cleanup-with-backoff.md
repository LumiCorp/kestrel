# Recover completed cleanup with bounded reconciliation

## Failed behavior

A cleanup release can be durably DONE while Web terminalization still fails.
Web then clears the runtime execution binding and requeues, but the replacement
runner only inspects pending effects. With no pending effect and an undefined
next step, it fails forever despite the exact release already succeeding.
Persistent pre-release failures also create new retry-limit-zero jobs
immediately, bypassing pg-boss retry delay and backoff.

## Affected work

[Converge prepared cleanup across retry and lifecycle](06g-converge-cleanup-across-retry-and-lifecycle.md),
commit `73fe1de7e`, especially cleanup terminal state, effect result recovery,
`ExecutionEngine.resumePendingEffects`, Web reconciliation, and turn-job
dispatch timing.

## Repair requirements

Persist enough exact cleanup identity to recognize that the cleanup release
effect is durably DONE after a runner or Web crash, and terminalize recovery
without scheduler/model/tool work or a second release. Preserve the runtime
execution binding when its terminal result can be reattached; if a replacement
execution is necessary, prove DONE through the exact idempotency identity before
terminalizing. Schedule persistent cleanup reconciliation with an explicit
bounded durable delay/backoff rather than immediate fresh jobs. Keep cleanup
nonterminal during outage and leave ordinary job/effect retry unchanged.

## Done when

- Crash after release DONE but before runner/Web terminal commit converges on
  one released source, one failed interaction, and one failed/cancelled turn.
- Recovery from exact DONE evidence never enters RegionScheduler, model, tool,
  or release again.
- Multiple persistent failures produce bounded delayed reconciliation jobs;
  eventual success still converges.
- Full runner/Web/PostgreSQL tests cover DONE-before-terminal and repeated-
  failure/backoff paths.

## Depends on

[Converge prepared cleanup across retry and lifecycle](06g-converge-cleanup-across-retry-and-lifecycle.md).
