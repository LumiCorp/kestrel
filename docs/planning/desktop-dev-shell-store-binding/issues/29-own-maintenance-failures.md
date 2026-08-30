# Own developer-shell maintenance failures

## Failed behavior

The 30-second idle and retention sweep discards its promise. A store or settlement rejection inside that sweep becomes an unhandled rejection, allowing Node to terminate the developer-shell daemon and recreate the unavailable-service and stale-authority chain.

## Repair requirements

- Run at most one maintenance sweep at a time through an owned promise.
- Capture maintenance rejection without allowing an unhandled rejection.
- Keep active process ownership intact when maintenance persistence fails.
- Report the captured failure through service health until a later sweep succeeds.

## Done when

- An expired retained process with a failing maintenance write produces no unhandled rejection and remains owned.
- `/health` returns a structured `DEV_SHELL_SERVICE_UNAVAILABLE` failure with `maintenance_failed` evidence while the failure is active.
- A later successful sweep clears the degraded health state.

## Depends on

None.
