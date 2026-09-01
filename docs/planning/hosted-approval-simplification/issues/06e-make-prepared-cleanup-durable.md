# Make prepared approval cleanup durable

## Failed behavior

The generalized cleanup continuation is represented only in the first claim's
in-memory response. A worker crash loses that identity, author access loss can
prevent the maintenance claim, the normal decline transition can resume model
work after release, and a transient release failure is cached permanently.
Cleanup completion and turn completion are also separate transactions, so a
crash between them can record an ordinary successful turn.

## Affected work

[Generalize prepared approval cleanup](06c-generalize-prepared-approval-cleanup.md),
commit `709499485`, especially `apps/web/lib/turns/store.ts`,
`apps/web/lib/turns/process-runtime.ts`, the Web-to-runner interaction response,
the Acter approval transition, and `src/effects/EffectRunner.ts`.

## Repair requirements

Make the canonical cleanup marker a durable, runner-visible, cleanup-only
contract. Reconstruct it for running-turn reattachment and recovery. The runner
must release the exact prepared call and terminate without another model or tool
step. A transient cleanup release failure must be explicitly retryable under the
same idempotency identity; do not broaden retry behavior for ordinary effects.
Finalize cleanup interaction failure and turn failure atomically and
idempotently, or requeue the same cleanup when release has not completed. Permit
a maintenance claim without current author membership only after validating the
canonical cleanup marker and exact organization/thread/turn/interaction binding.

## Done when

- Cleanup reaches the runner after first claim, running reattachment, and crash
  recovery, and cannot enter deliberation or execute a tool.
- A transient release failure retries and eventually releases the exact retained
  source once without replaying approval authority.
- Crash-before-release and crash-between-release/finalization converge on one
  truthful failed interaction and turn.
- Author membership loss cannot strand canonical cleanup, while ordinary claims
  retain their existing access checks.
- Focused PostgreSQL, Acter, effect-runner, registry, and Web bridge tests prove
  the contract.

## Depends on

[Generalize prepared approval cleanup](06c-generalize-prepared-approval-cleanup.md).
