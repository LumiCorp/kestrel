# Use cooperative service shutdown instead of numeric PID signaling

## Failed behavior

Current-protocol replacement proves health, sidecar, socket, and PID agreement, then later sends `SIGTERM` to the numeric PID. The proven service can exit and the operating system can reuse that PID before the signal call, allowing an unrelated process to be terminated.

## Affected flow

This blocks [Make incompatible developer-shell replacement exclusive](03-make-incompatible-service-replacement-exclusive.md) and [Refuse unproven legacy service termination](05-refuse-unproven-legacy-service-termination.md).

The trigger is service exit and PID reuse after identity validation but before `process.kill(pid, "SIGTERM")`. Another liveness check cannot bind a reusable PID to the process that answered health.

## Repair requirements

- Request shutdown through the currently connected developer-shell endpoint using the private current protocol and expected binding identity.
- Have the service initiate its own idempotent shutdown only after validating the request at the service boundary.
- Never signal an arbitrary numeric PID during incompatible-service replacement.
- After the cooperative request, wait for the proven endpoint/process to terminate and preserve inode-guarded socket cleanup and bounded failure behavior.
- Legacy health without the authenticated current protocol must continue to fail safely.

## Done when

- A service that disappears before the shutdown request cannot cause any numeric PID to be signaled.
- A matching current service accepts one authenticated shutdown request, terminates, and permits safe replacement.
- Missing or mismatched shutdown identity is rejected before shutdown begins.
- Focused tests cover endpoint disappearance/PID reuse and successful cooperative replacement.

## Depends on

None.
