# Complete prepared execution ownership and shutdown safety

## Failed behavior

Run cleanup removes terminal markers and permits an executed static prepared
call to rehydrate and execute again. Hosted authorization preparation retains a
new pinned MCP source twice but releases it once. Registry shutdown does not
wait for active prepared executions, clears retry ownership before cleanup
succeeds, and cannot retry a failed close.

## Affected work

[Release prepared execution resources when approval will not execute](01c-release-abandoned-prepared-executions.md),
commit `57dcf643c`, especially `tools/runtime/UnifiedToolRegistry.ts` and
`tests/unit/tool-invocation-integrity.test.ts`.

## Repair requirements

Prepared sources must have one explicit owner per retained reference. Same-
process run cleanup must not itself authorize stale replay; static restart
rehydration must require current trusted execution authority. Shutdown must
wait for active prepared executions before closing providers, attempt every
cleanup, preserve failed cleanup ownership for retry, and remain idempotent.
Terminal replay protection must remain exact without unbounded per-call state.

## Done when

- Stale execution after run cleanup fails while a fresh authorized restart can
  rehydrate once.
- Hosted authorization prepare/execute/release returns MCP reference counts to
  baseline.
- Close races with an active effect safely and a failed close can be retried.
- Focused lifecycle tests cover each ownership and race path.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
