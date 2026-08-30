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
- On Thread/Project/Environment access loss, actor change, App disablement,
  generation change, or worker loss, perform exact cleanup where possible and
  fail-close the Browser Session even when current viewer authorization no
  longer resolves.
- Continue authority revalidation while a socket is connected even when frame
  capture is paused by backpressure.
- Add deterministic return, expiry, dropped-Web-function, authorization-loss,
  reconnect, stale-cleanup, and unknown-cleanup regressions.

## Done when

- Return, close, expiry, disconnect, authorization loss, and worker loss leave no
  retained connection, lease, frame timer, or observable frame.
- Only explicit return changes `human_control` to `ready`; disconnect and expiry
  do not silently resume the agent.
- Cleanup for one connection cannot revoke a replacement connection or Session
  generation.
- Cleanup uncertainty converges to a closed Browser Session.
- Focused Web lifecycle, Router, worker, Local Core, and PostgreSQL CAS tests pass.

## Depends on

[Establish exact hosted viewer connections](06a-establish-exact-hosted-viewer-connections.md).
