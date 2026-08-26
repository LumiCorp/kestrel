# Close replay and snapshot-creation races

## Failed behavior

Run cleanup deletes terminal prepared-call keys, so a completed static prepared
call can execute again when supplied its original run context. Snapshot
creation also lacks a closed-state boundary and can create ownership after, or
concurrently with, registry shutdown that no later close attempt collects.

## Affected work

[Complete prepared execution ownership and shutdown safety](01c1-complete-prepared-resource-ownership.md),
commit `d693036b6`, especially `tools/runtime/UnifiedToolRegistry.ts` and
`tests/unit/tool-invocation-integrity.test.ts`.

## Repair requirements

Run cleanup must bound replay state without reauthorizing any completed
prepared call, including when the old run context is supplied. Snapshot
creation must reject after close starts and must not publish ownership across a
close race. Cleanup and close must remain idempotent and bounded.

## Done when

- Execute, release the run, and execute again with the original run context
  fails before the second effect.
- Snapshot creation after completed close fails without retaining state.
- A controlled create-versus-close race leaves no uncollected ownership.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
