# Join maintenance settlement before cleanup

## Failed behavior

Service close clears the maintenance interval but does not await an already-running sweep, so snapshotted maintenance work can resume against the store after service cleanup. Interactive idle expiry also waits for process exit without awaiting terminal settlement, which lets maintenance health return to healthy while dead process ownership still carries a rejected settlement and durable RUNNING evidence.

## Repair requirements

- Await the owned in-flight maintenance sweep before close snapshots active processes.
- Make interactive idle expiry await the process settlement after termination.
- Keep maintenance health degraded across later sweeps while a retained settlement rejection remains unresolved.
- Preserve safe close behavior when maintenance itself fails.

## Done when

- Close cannot complete while a maintenance persistence write is blocked.
- A terminal-write rejection during idle expiry remains owned, leaves health degraded, and retains the failed process.
- Repeating maintenance cannot clear that degradation merely because the child is already dead.

## Depends on

None.
