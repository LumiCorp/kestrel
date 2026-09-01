# Clean up children after initial process persistence failure

## Failed behavior

The supervisor spawns and registers a child before persisting its initial RUNNING record. If that first write rejects, the caller receives no process ID while the unrecorded child remains live in the supervisor.

## Repair requirements

- Mark the exact starting child failed when its initial record cannot be persisted.
- Terminate it with the supervisor's normal SIGTERM/SIGKILL sequence.
- Await the existing exit-handler settlement before rethrowing the original persistence error.
- Preserve terminal failure evidence when the store accepts the follow-up write.

## Done when

- A fail-first RUNNING store rejects the start request with its original error.
- The spawned child exits, is absent from active supervisor state, and cannot become inaccessible live work.
- The store contains settled FAILED evidence explaining the initial-record failure.

## Depends on

None.
