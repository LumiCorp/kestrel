# Recover failed authority transfer

## Failed behavior

Authority transfer claims the current owner before writing and promoting child evidence. If any later operation fails, the detached child remains blocked on IPC and the live parent retains a claimed state that `release()` refuses. Every retry then times out until the app exits.

## Repair requirements

- Terminate the exact spawned child on every authority-transfer or handshake failure.
- Let the exact live claimant release its own incomplete transfer without touching replacement authority.
- Preserve crash recovery at both transfer fault phases.

## Done when

- Injected failures after claim and after preparing child evidence are releasable and a new caller can acquire.
- A handoff failure cannot leave its child alive and blocked.

## Depends on

None.
