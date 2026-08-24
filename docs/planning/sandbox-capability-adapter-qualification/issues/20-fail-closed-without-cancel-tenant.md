# Fail closed when cancellation tenant authority is unavailable

## Wrong behavior

When an exact-result store exists but trusted tenant configuration is absent, `RunnerHost` skips atomic cancellation arbitration and directly aborts the run. This reopens the DONE-versus-cancel race.

## Repair owner

`RunnerHost.runCancel` owns the cancellation decision. A started exact-effect candidate must never be aborted without its configured atomic claim authority.

## Completion

- Missing trusted tenant/store authority rejects cancellation without aborting.
- No exact DONE/cancel contradiction is possible.
- Focused runner protocol coverage proves the fail-closed result.
