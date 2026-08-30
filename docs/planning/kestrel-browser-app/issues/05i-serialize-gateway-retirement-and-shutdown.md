# Serialize Gateway retirement and shutdown

## Failed behavior

An incomplete exact proxy retirement is held outside the active Session map. Installation can therefore recreate the same Session and generation with a new authenticating credential, while exact cleanup continues selecting only the retired instance. Gateway shutdown also marks the registry closed only after awaiting teardown, allowing a concurrent install to escape the shutdown snapshot.

## Affected flow

`HostedBrowserEgressRegistry` owns Session installation, exact retirement, and whole-registry shutdown. These state transitions must be serialized by the existing active/retiring maps and closed flag without adding a durable store or new authority protocol.

## Repair requirements

- Reject installation of an exact Session and generation while that identity is retiring.
- Ensure exact cleanup can never select an old retired instance while leaving an authenticating same-key replacement active.
- Mark the registry closed before any asynchronous `closeAll()` teardown work begins.
- Reject every install once shutdown starts and include every already-admitted active or retiring proxy in total teardown.
- Preserve distinct replacement generations and existing idempotent exact cleanup behavior.

## Done when

- Injected partial teardown followed by same-key install is rejected and no new credential authenticates.
- Exact cleanup remains repeatable until retirement completes.
- A deterministic install-versus-`closeAll()` race admits no Session after shutdown begins and retains no authenticating credential.
- A distinct new generation remains installable only when it cannot be confused with the retired exact identity.
- Focused install, exact-close, retirement, credential, and shutdown tests pass.

## Depends on

None.
