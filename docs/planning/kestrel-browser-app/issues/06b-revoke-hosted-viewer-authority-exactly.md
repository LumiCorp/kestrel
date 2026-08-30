# Revoke hosted viewer authority exactly

## Failed behavior

“Return to agent” moves PostgreSQL back to `ready` but leaves the WebSocket,
worker connection, lease, and frame stream alive until ticket expiry. Ticket
expiry then attempts disconnect with the expired viewer ticket, which the Router
and worker reject. Authorization loss during socket close skips both worker
cleanup and Browser Session fail-close when current access can no longer be
resolved.

## Affected flow

The hosted worker owns the live connection and lease, the WebSocket route owns
the frame stream, and the Web lifecycle service owns the durable Browser Session
transition. Revocation is cleanup of already-issued exact authority; it must not
depend on an expired user ticket granting a new action.

## Repair requirements

- Give the Kestrel control plane one separately authenticated, body-bound cleanup
  instruction that can only disconnect the exact actor, Session, generation,
  and connection selected before dispatch. It must not authorize frame, input,
  takeover, return, or close actions.
- Make the worker enforce the signed viewer-ticket expiry for its exact
  connection even if the Web function disappears. Expiry removes the connection
  and lease but leaves a `human_control` Session in `human_control`.
- On explicit return, revoke the exact connection and lease, stop frames, clear
  the client frame, close the WebSocket, and only then expose the durable `ready`
  state. The returned viewer must not observe subsequent agent activity.
- On disconnect or lease expiry, remove connection/lease/frame authority while
  preserving `human_control`. A newly authorized ticket can reconnect without
  inheriting a stale lease.
- Do not swallow an established connection's failed or response-lost worker
  disconnect. Preserve its exact cleanup operation as unknown until worker-side
  expiry, exact cleanup, or durable Session fail-close proves convergence; emit
  `disconnected` evidence only after that proof.
- On Thread/Project/Environment access loss, actor change, App disablement,
  generation change, or worker loss, perform exact cleanup where possible and
  fail-close the Browser Session even when current viewer authorization no
  longer resolves.
- Continue authority revalidation while a socket is connected even when frame
  capture is paused by backpressure.
- If socket close precedes an outcome-unknown connect and its immediate exact
  retry remains unknown, retain a server-authoritative cleanup-pending state.
  Status and ticket minting must block a replacement connection until cleanup,
  worker-side expiry, or terminal Session state clears it.
- Project cleanup-pending through the existing viewer status endpoint. The web
  client must keep reconnect blocked across polling, component remount, and page
  reload, then clear the warning automatically only after server authority says
  cleanup converged or the Session became terminal.
- Add deterministic return, expiry, dropped-Web-function, authorization-loss,
  reconnect, stale-cleanup, and unknown-cleanup regressions.

## Done when

- Return, close, expiry, disconnect, authorization loss, and worker loss leave no
  retained connection, lease, frame timer, or observable frame.
- Failed established disconnect and close-before-connect-unknown remain visible
  and retryable; they never degrade into ordinary disconnected availability.
- Only explicit return changes `human_control` to `ready`; disconnect and expiry
  do not silently resume the agent.
- Cleanup for one connection cannot revoke a replacement connection or Session
  generation.
- Cleanup uncertainty converges to a closed Browser Session.
- Focused Web lifecycle, Router, worker, Local Core, and PostgreSQL CAS tests pass.

## Depends on

[Establish exact hosted viewer connections](06a-establish-exact-hosted-viewer-connections.md).

## Implementation evidence

- Focused Web lifecycle, socket, status, and UI contracts pass: 30 tests.
- Focused Environment Router and hosted worker contracts pass: 26 tests.
- Focused Local Core Browser service contracts pass: 84 tests.
- Root and Environment Router typechecks pass. The Web typecheck reaches only
  pre-existing unrelated runtime-profile and hosted OAuth test errors.
- Scoped Web lint and `git diff --check` pass.
- The PostgreSQL lifecycle test was not run because
  `KESTREL_ENVIRONMENT_DB_TEST_URL` is not configured in this worktree.
- `pnpm validate:process` completed shared/root and Workspace Runtime builds,
  packed-consumer preparation, and its first TUI PTY journey. It then emitted no
  output for 50 seconds during the remaining PTY journeys and was interrupted;
  this broad gate is inconclusive rather than passing.
