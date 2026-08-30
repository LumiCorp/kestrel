# Close Desktop viewer journal crash windows

## Failed behavior

Local Core can create or reuse a viewer connection before Desktop persists its exact identity. A process exit in that interval leaves no restart journal, so a reused sender/bootstrap principal can inherit the surviving connection. Separately, journal unlink can succeed before directory sync fails; the coordinator then retains in-memory authority but every retry sees the journal missing and cannot converge.

## Affected flow

The Desktop viewer coordinator and Local Core viewer connection admission jointly own fail-closed restart behavior. The existing single-record journal remains the only durable Desktop state; the repair must not add a general transaction or recovery protocol.

## Repair requirements

- Never reuse or return an existing Local Core viewer connection when Desktop presents no exact retained identity after restart.
- Treat an unrepresented conflicting or same-principal connection as stale process authority: terminalize it fail-closed and return no replacement connection.
- Preserve exact expected-identity reconnect for normally journaled current authority.
- Make journal clear convergent when unlink succeeds but the following directory sync fails; current-process recovery must not remain permanently blocked, and a stale record that reappears after restart must only trigger idempotent exact loss.
- Never transfer human control or implicitly return it to the agent.

## Done when

- A crash-window regression creates a surviving Local Core connection with no journal, reuses the sender/bootstrap principal, and proves no connection is inherited.
- The stale Session terminalizes before any later replacement can connect.
- Injected post-unlink sync failure permits safe current-process convergence, while restart with a stale record retries exact loss.
- Normal journaled reconnect, pending loss, corrupt-state, and identity-drift tests remain green.

## Depends on

None.
