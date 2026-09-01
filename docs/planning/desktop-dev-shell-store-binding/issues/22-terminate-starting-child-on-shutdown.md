# Terminate a starting child when shutdown interrupts initial persistence

## Failed behavior

A child is spawned and registered before its initial RUNNING record finishes persisting. If shutdown begins while that store write is pending, the caller has not yet received the running-process handle and cannot execute the normal abort-aware termination path, so the child can continue running throughout shutdown.

## Repair requirements

- Attach shutdown termination immediately after child registration and listener setup.
- Escalate from SIGTERM to SIGKILL through the supervisor's existing cleanup timing.
- Preserve serialized initial and terminal record persistence and settled failure evidence.
- Treat an actually blocked store as safe refusal without allowing its child to remain live.

## Done when

- A shutdown abort during a deliberately blocked initial RUNNING write terminates the exact spawned child.
- Releasing the store write produces settled interrupted-command evidence.
- Normal start and shutdown tests remain green.

## Depends on

None.
