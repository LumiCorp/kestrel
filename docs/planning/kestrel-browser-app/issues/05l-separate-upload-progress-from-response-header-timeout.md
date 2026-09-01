# Separate upload progress from the response-header timeout

## Failed behavior

The ordinary HTTP response-header deadline starts before the request body finishes streaming. An upstream that correctly waits for a progressing upload body is terminated as a stalled response before it can send headers.

## Affected flow

`apps/environment-router/src/browser-egress.ts` owns bounded ordinary HTTP request and response progress. Issue 07 relies on Issue 05 providing a conforming streamed host for attachments up to the shared 100 MiB limit.

## Repair requirements

- Bound genuinely stalled request-body progress without imposing the response-header deadline while bytes are still progressing.
- Start the response-header wait when the request body completes, or otherwise prove equivalent distinct request-progress and response-header phases.
- Preserve connect, response-header, response-body-idle, Session hard-expiry, revision, client-loss, and Gateway-close cleanup.
- Add a deterministic slowly progressing request-body regression and a genuinely stalled request-body regression.
- Add no retry, compression, buffering fallback, or second dispatch.

## Done when

- A request body that continues making progress beyond the response-header duration reaches the upstream and receives its response.
- A request body that stops making progress is bounded and releases its reservation and sockets.
- Existing stalled-header and stalled-response-body tests remain green.
- Focused HTTP timeout, cleanup, and typecheck suites pass.

## Depends on

None.
