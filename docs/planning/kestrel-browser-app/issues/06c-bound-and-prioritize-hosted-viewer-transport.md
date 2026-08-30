# Bound and prioritize hosted viewer transport

## Failed behavior

The WebSocket route appends every 750 ms frame poll and every client message to
one unbounded promise tail. A slow capture or slow receiver queues more captures
and up to tens of MiB of socket output while password, MFA, renewal, return, and
close messages wait behind stale work. Any signed-in organization member can
also hold an upgraded connection open indefinitely without authenticating.

The web client casts untrusted JSON to the server-message type without runtime
validation. Malformed data can leave an open socket with stale authority state.

## Affected flow

The versioned Vercel WebSocket route owns admission, scheduling, backpressure,
and connection shutdown. The shared hosted viewer protocol owns validation on
both sides. Frame capture is observation and must not serialize ahead of control
or input authority.

## Repair requirements

- Require a valid `authenticate` message within 10 seconds of upgrade. Close
  silent, malformed, and wrong-Thread peers without starting worker work.
- Allow at most one frame capture and one unsent frame at a time. When capture or
  delivery is still pending, skip intermediate frame ticks and retain only the
  newest completed frame.
- Stop frame capture while WebSocket buffered output is nonzero; resume only
  after delivery progress. Never accumulate serialized frame buffers.
- Process `close_session`, `return_control`, and `renew_lease` ahead of pending
  frames. Preserve keyboard and pointer down/up order. Coalesce pending pointer
  moves to the latest move and bound non-coalescible input to 64 messages; close
  an abusive peer instead of growing memory.
- Treat an agent operation currently owning the Browser engine as transient
  frame unavailability. Wait or skip that frame; do not classify ordinary agent
  work as worker loss or terminate the Browser Session.
- Recheck close intent after every awaited frame capture. A close waiting for
  queued work must never be awaited from that same queued frame task; late frame
  completion after close intent is discarded before send, and close settlement
  must always reach exact disconnect.
- Parse and validate every server message in the shared protocol before the web
  client uses it. Invalid JSON, unknown keys/types, invalid frame/state identity,
  or oversized data closes the socket and clears viewer state and frames.
- Add deterministic slow-capture, blocked-receiver, pointer-flood,
  renewal-priority, return-priority, concurrent-agent-operation, silent-peer,
  malformed-server-message, and bounded-memory tests.

## Done when

- Slow frames or receivers cannot grow frame, input, promise, or WebSocket output
  queues without bound.
- Authentication input and lease/control messages remain usable during slow
  capture and pointer motion.
- Ordinary agent operations do not close the Browser Session merely because a
  viewer requests a frame.
- Unauthenticated and malformed peers are closed within the explicit bound and
  retain no viewer state.
- Focused Vercel route, protocol, web-client, worker scheduling, and Browser
  Session tests pass.

## Depends on

[Revoke hosted viewer authority exactly](06b-revoke-hosted-viewer-authority-exactly.md).

## Implementation evidence

- The versioned WebSocket route now closes silent or malformed pre-authentication
  peers on the shared 10-second deadline without starting viewer worker work.
- Frame observation is single-flight with at most one pending frame. Capture is
  paused while socket output is buffered, state responses coalesce to one latest
  pending state, and close intent discards late captures without joining the
  frame task into exact disconnect settlement.
- Control messages run ahead of queued input. Pending pointer moves coalesce,
  keyboard and pointer down/up order is retained, and both input and control
  queues close the peer at the explicit 64-message bound.
- The worker and Router preserve typed
  `BROWSER_VIEWER_FRAME_UNAVAILABLE` while an accepted agent operation or
  revision adoption owns the Browser engine. Web skips that observation without
  invoking the 06b authority-loss path; ordinary worker loss still fail-closes.
- The shared server-message parser rejects unknown keys/types, invalid state or
  frame identity, non-canonical timestamps, invalid frame data, and oversized
  payloads. The client requires state before frames and clears identity, state,
  and frame presentation on malformed input.
- The exact protocol, Vercel route, Web lifecycle/client, Router, worker, and
  Browser Session command passes 102 tests. Root, Web, and Environment Router
  TypeScript checks, scoped Web lint, and `git diff --check` pass. The broad Web
  lint remains baseline-red on 149 unrelated existing diagnostics; no 06c file
  is among the scoped lint failures.

### Independent-review repair evidence

- A syntactically valid authenticate message no longer clears the 10-second
  deadline. The socket closes immediately if authority proof is still pending,
  while the independent settlement retains the pending attempt and disconnects
  an exact connection that proves itself late.
- Authority revalidation is single-flight. Repeated interval ticks cannot start
  another authorization read until the current read settles.
- Hosted worker engine ownership is symmetric: accepted agent operations make
  frames transiently unavailable, and an in-flight frame reserves the engine
  against new operation acceptance or authority revision until capture settles.
- The client pins Project together with Session, generation, and connection.
  Shared parsing now rejects structurally invalid Base64, invalid padding, and
  nonzero unused pad bits without decoding or allocating a second frame buffer.
- The final exact protocol, Vercel route, Web lifecycle/client, Router, worker,
  and Browser Session command passes 106 tests. Root and Environment Router
  TypeScript, scoped Web/shared-protocol lint, and `git diff --check` pass. Web
  typecheck reaches only the pre-existing runtime-profile and hosted personal
  OAuth test errors already recorded by the Browser viewer work.
