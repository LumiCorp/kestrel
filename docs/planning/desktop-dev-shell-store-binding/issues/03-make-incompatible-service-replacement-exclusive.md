# Make incompatible developer-shell replacement exclusive

## Failed behavior

A developer-shell service with stale protocol or store-binding identity is not guaranteed to stop before its replacement starts.

If the bootstrap-status sidecar is missing or corrupt, the client has no PID and removes the shared socket without signaling the live daemon. If the PID is present, the client waits only one second and proceeds even though normal supervisor shutdown can take more than one second per active process plus source-write and lease cleanup. The old daemon can then finish shutdown after the replacement binds and unconditionally unlink the replacement's shared socket. Commands can lose their endpoint, and the stale daemon can remain alive under the old store authority.

## Affected flow

This blocks [Bind the developer shell to Local Core storage authority](01-bind-developer-shell-storage-authority.md), implemented by `fa4d681ce..93362285a`.

The trigger is a healthy response whose protocol, driver, or binding revision is incompatible. `LocalDevShellService.ensureService` calls `stopIncompatibleService`. That method depends on the status sidecar for a PID, waits at most one second after `SIGTERM`, then removes the socket and allows `spawnService` to start a replacement. `DevShellSupervisor.close` may spend 1.5 seconds per active process before its remaining cleanup. The old service's shutdown handler later removes the shared socket without proving it still owns that path.

The repair must cover incompatible-service shutdown, proof of termination or safe refusal, socket ownership during cleanup, replacement launch ordering, and focused lifecycle tests.

## Repair requirements

- Do not unlink the shared socket or start a replacement until termination of the incompatible service is established.
- If status identity is missing, corrupt, stale, or otherwise insufficient to establish safe shutdown, fail safely with bounded actionable evidence rather than orphaning a daemon or racing a replacement.
- Allow normal active-process shutdown and cleanup to complete within a bounded lifecycle that reflects the supervisor's actual shutdown contract.
- Prevent an old daemon's delayed cleanup from unlinking a socket now owned by a replacement.
- Preserve the existing controlled replacement behavior for legacy health and mismatched store revisions without adding automatic command or migration retries.

## Done when

- A stale service with an active process is fully stopped before the replacement binds and the replacement remains reachable after old cleanup completes.
- Missing or corrupt status identity cannot cause the client to unlink a live service socket or launch a concurrent replacement.
- A matching service remains reusable without restart.
- Focused regression checks cover the slow-shutdown and missing-status paths, including socket ownership after replacement.
- The original issue 01 outcome and constraints still hold.

## Depends on

None.
