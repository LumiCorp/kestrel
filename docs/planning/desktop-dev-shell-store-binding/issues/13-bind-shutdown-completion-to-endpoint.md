# Bind shutdown completion to the proven endpoint

## Failed behavior

After authenticated cooperative shutdown is accepted, replacement waits only for the numeric status PID to stop. If the daemon exits and that PID is reused, the proven endpoint is already gone but replacement waits 30 seconds and fails.

## Repair requirements

- Determine shutdown completion from disappearance or replacement of the proven socket identity.
- Keep PID as diagnostic evidence only; never signal it.
- Preserve bounded waiting and inode-guarded cleanup.

## Done when

- A reused live PID cannot prevent replacement after the proven endpoint disappears.
- Slow current-service shutdown still waits before replacement.

## Depends on

None.
