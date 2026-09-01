# Settle viewer connect before socket close

## Failed behavior

The WebSocket can close while `HostedBrowserViewerService.connect()` is still
awaiting. Route cleanup marks itself closed before the pending attempt produces
either a connection or an outcome-unknown retry. When the attempt later settles,
the connection or retry is installed after cleanup and every later `close()`
returns early. A synchronous `socket.send()` failure can bypass cleanup in the
same way.

The invalid-state and direct fail-close branches can also construct
`BROWSER_ACTION_OUTCOME_UNKNOWN` with a callback that always returns `false`, so
the advertised socket-close retry cannot perform any work. The first-party web
viewer then discards the unknown-outcome code and renders an ordinary
disconnect.

## Affected flow

The versioned WebSocket route owns the lifetime of the pending connect attempt,
the established connection, and any exact cleanup retry. The viewer service owns
the retry operation. The first-party viewer owns presentation of the typed
unknown-outcome result.

## Repair requirements

- Register the pending connect attempt before awaiting it. A socket close records
  close intent and settles cleanup after that attempt produces a connection,
  outcome-unknown retry, known failure, or cancellation.
- Never install a connection, frame interval, authority timer, or retry after
  close settlement. If connect succeeds after close intent, disconnect that exact
  connection before route cleanup completes.
- Make close idempotent without using an early return that can skip resources
  published by an in-flight attempt. Concurrent close/error events must share one
  settlement and release each exact resource at most once.
- Treat every socket send as best effort and place cleanup in a `finally` path;
  a synchronous send failure must not bypass disconnect or retry.
- Every `HostedBrowserViewerOutcomeUnknownError` must carry a real exact retry:
  retry exact disconnect plus durable fail-close for a possibly created
  connection, or retry durable fail-close alone when no worker connect was
  dispatched. Remove callbacks that can only return `false`.
- Preserve `BROWSER_ACTION_OUTCOME_UNKNOWN` in the first-party viewer long enough
  to show an explicit cleanup-unknown state and recovery instruction. Do not
  silently present it as an ordinary disconnect.
- Add deterministic close-before-connect-success,
  close-before-connect-unknown, send-throws, invalid-state unknown,
  dispatch/frame fail-close unknown, concurrent-close, one-cleanup, and client
  presentation regressions.

## Done when

- Socket close cannot race ahead of pending connect settlement and retain viewer
  authority, a frame timer, or a cleanup retry.
- Every unknown-outcome branch performs a real exact retry on route settlement or
  remains explicitly unknown to the user.
- Send failure and duplicate close/error events cannot bypass or duplicate
  cleanup effects.
- The web viewer distinguishes cleanup-unknown from an ordinary disconnected
  viewer without exposing tickets, input, frames, or credentials.
- Focused route, viewer service, client contract, worker, and Local Core tests
  pass.

## Depends on

[Preserve unconfirmed viewer fail-close](06a1-preserve-unconfirmed-viewer-fail-close.md).
