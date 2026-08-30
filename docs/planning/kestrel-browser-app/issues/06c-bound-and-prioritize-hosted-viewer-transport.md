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
