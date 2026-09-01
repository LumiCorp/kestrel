# Preserve initial persistence failure priority

## Failed behavior

After an initial RUNNING write rejects, the startup path records the owning initial-persistence failure but leaves the shutdown-abort listener and wall timer active while the child terminates. Either callback can overwrite the failure reason before terminal classification, so durable evidence reports a secondary shutdown or timeout instead of the component that first made startup wrong.

## Repair requirements

- Detach the startup shutdown listener as soon as initial persistence fails.
- Clear any pending startup shutdown escalation and wall-timeout callbacks.
- Continue the existing direct SIGTERM/SIGKILL cleanup sequence for the failed start.
- Preserve the initial-persistence reason through terminal settlement.

## Done when

- A SIGTERM-resistant child whose initial write fails and whose shutdown signal then aborts is terminated.
- Its durable terminal record remains FAILED for the initial-record persistence failure.
- The caller still receives the original initial-write failure.

## Depends on

None.
