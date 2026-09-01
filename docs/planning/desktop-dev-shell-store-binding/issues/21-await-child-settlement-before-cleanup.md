# Await child settlement before service cleanup completes

## Failed behavior

Supervisor close waits for each child process to exit but returns before the asynchronous exit handler persists terminal evidence, finishes the source-write guard, and releases managed-worktree leases. The service can therefore close its store and remove its endpoint while required child cleanup is still running.

## Repair requirements

- Await each stopped child's existing settlement promise before supervisor close returns.
- Use the exit handler as the single owner of transcript settlement, terminal persistence, source-write guard enforcement, and lease release.
- Preserve endpoint removal as proof that supervisor and store cleanup are complete.

## Done when

- A deliberately blocked terminal store write keeps supervisor close pending.
- Releasing that write allows close to finish with a persisted terminal record.
- No duplicate guard or lease cleanup path remains in supervisor close.

## Depends on

None.
