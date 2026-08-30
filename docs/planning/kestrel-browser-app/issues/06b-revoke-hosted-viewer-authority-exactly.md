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

### Independent-review repair evidence

- Focused Web lifecycle, cleanup-safe composition, Redis abstraction, socket,
  status, and UI contracts passed 47 tests in the first repair.
- Ticket and lease rejection races exact-clean without failing a
  `human_control` Session. Successful return, input, and renewal responses remain
  authoritative when their response crosses the same boundary.
- Cleanup-pending records have no time-based disappearance, promote
  `authority_loss` atomically, and use exact compare-and-delete so stale cleanup
  cannot clear a promoted or replacement record.
- Proven worker cleanup remains proven when Redis marker deletion fails. The
  stale marker continues to block replacement authority until a later exact
  reconciliation clears it.
- Thread-access and non-ready Environment reconciliation uses a non-disclosing,
  exact cleanup-only path. The non-ready path durably fail-closes through the
  existing PostgreSQL `markTerminal` CAS without invoking ready-only Fly
  composition.
- Transient authorization-read failures remain service uncertainty; explicit
  access, policy, App, and Environment readiness loss exact-clean and fail-close.
- Focused Environment Router and hosted worker contracts still pass: 26 tests.
- Focused Local Core Browser service contracts still pass: 84 tests.
- Root and Environment Router typechecks and scoped Web lint pass. The Web
  typecheck still reaches only the pre-existing unrelated runtime-profile and
  hosted OAuth test errors.
- The PostgreSQL lifecycle test remains unrun because
  `KESTREL_ENVIRONMENT_DB_TEST_URL` is not configured. Per the repair-turn
  instruction, `pnpm validate:process` was not rerun.

### Second independent-review repair evidence

- The exact focused Web lifecycle, disconnected-status, socket, Redis, and UI
  command passes 56 tests.
- Worker and Local Core now return one typed pre-effect authority-expired error
  only after ticket or lease identity verification. Response loss after
  takeover or return remains unknown and fail-closes; a successful response
  remains authoritative.
- Cleanup capabilities bind `disconnect` or `authority_loss` through Web,
  Router, and worker. Ordinary disconnect preserves human control.
  `authority_loss` durably terminalizes the exact actor, Session, and generation
  in Local Core even after an earlier disconnect or replacement connection.
- Disconnected status and mint evaluate current access before weak-marker
  cleanup. Explicit access, App, or Environment denial promotes cleanup to
  `authority_loss`; no-marker denial still invokes the worker and cleanup-safe
  PostgreSQL owner without disclosing viewer state.
- The exact Router, ticket, and worker command passes 28 tests. The exact Local
  Core Browser service command passes 85 tests, including restart persistence,
  lease expiry, disconnect/replacement, and stale-generation protection. Two
  packaged Local Core composition regressions also pass.
- Root and Environment Router typechecks pass. Scoped Web lint passes. Web
  typecheck reaches only the pre-existing runtime-profile and hosted OAuth test
  errors listed above. PostgreSQL remains unrun because
  `KESTREL_ENVIRONMENT_DB_TEST_URL` is not configured.
- Per the repair-turn instruction, `pnpm validate:process` was not rerun.

### Final independent-review repair evidence

- The exact focused Web lifecycle, retained-marker, authorized-replacement,
  socket, Redis, status, and UI command passes 62 tests.
- Web creates the exact `connect_unknown` record before worker dispatch and
  retains it for the live connection. Marker failure prevents worker authority;
  marker-clear failure blocks replacement until a later exact reconciliation.
  Availability polling is aborted while the socket is connecting or open.
- A current replacement actor reaches only the non-disclosing fail-close path,
  and only after current Thread access proves the same organization, Project,
  and Thread. Actors without that proof remain rejected.
- Router authorization validates the complete signed viewer identity without
  using expiry as an identity failure. A real Web-shaped Router-to-worker test
  proves exact ticket and worker-lease expiry remain the typed pre-effect
  `BROWSER_VIEWER_AUTHORITY_EXPIRED` result rather than generic unavailability.
- The exact Router, ticket, and worker command passes 32 tests. Worker cleanup
  retires exact connection identities even before worker service construction;
  disconnect, expiry, return, close, and authority loss retire before success.
  Retirement persists through signed expiry, rejects delayed replay, protects a
  replacement identity, and fails closed at the explicit 4,096-entry bound.
- The exact Local Core Browser service command passes 85 tests, including exact
  principal enforcement for Session-wide authority loss. Two packaged Local
  Core composition regressions also pass.
- Root and Environment Router typechecks pass, scoped Web lint and
  `git diff --check` pass. Web typecheck reaches only the pre-existing
  runtime-profile and hosted OAuth test errors listed above. PostgreSQL remains
  unrun because `KESTREL_ENVIRONMENT_DB_TEST_URL` is not configured.
- Per the repair-turn instruction, `pnpm validate:process` was not rerun.
